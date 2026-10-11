import type { Logger } from 'pino';

import type { Clock } from '../../auth/ports/clock.port.js';
import type { DeliveryProvider, ProviderMessage } from '../../auth/ports/delivery-provider.port.js';
import type {
  ClaimedDelivery,
  DeliveryChannel,
  DeliveryQueue,
  JobEnd,
  LeasedJob,
  RecordedOutcome,
} from '../../auth/ports/delivery-queue.port.js';
import type { Metrics } from '../../auth/ports/metrics.port.js';
import { serverErrorIn } from '../../database/database-failures.js';
import { ExecutionBudget, runWithBudget } from '../../execution/execution-budget.js';
import { withinBudget } from '../../lifecycle/within-budget.js';
import { LeaseLostError, UnreadableClaimError } from '../delivery-errors.js';
import {
  CLAIM_BUDGET_MS,
  MAX_BACKOFF_MS,
  RECORD_BUDGET_MS,
  RELINQUISH_RESERVE_MS,
  WORKER_ID_PATTERN,
} from '../delivery-parameters.js';
import { MAX_ATTEMPTS } from '../delivery-schedule.js';
import { TERMINAL_FAILURE_CLASSES } from '../delivery-vocabulary.js';
import type { RedemptionRecordReader, RedemptionStanding } from './redemption-record-reader.js';

/**
 * Work the worker does on a schedule beside the lanes: the retention cleanup (S0.19). Each run is made under a budget of its own,
 * inside the worker's, and is told when the worker stops. A failure is logged and does not stop the rest.
 */
export interface PeriodicTask {
  readonly name: string;
  readonly intervalMs: number;
  /** The longest one run may take: the budget its database work runs under. */
  readonly budgetMs: number;
  run(stop: AbortSignal): Promise<unknown>;
}

export interface DeliveryWorkerOptions {
  readonly queue: DeliveryQueue;
  /** One provider for each channel: the capture adapter, or a real provider behind the allow-list of its window. */
  readonly providers: Readonly<Record<DeliveryChannel, DeliveryProvider>>;
  /** The longest one call to a provider (and to its status query) may take, per channel. */
  readonly providerTimeoutMs: Readonly<Record<DeliveryChannel, number>>;
  readonly redemption: RedemptionRecordReader;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly metrics: Metrics;
  /** The worker's name for itself, as a lease names its holder: plain and non-secret (`WORKER_ID_PATTERN`). */
  readonly workerId: string;
  /** The lanes: the most jobs in flight at once. */
  readonly concurrency: number;
  /** How long an idle lane waits before it looks for a due job again. */
  readonly pollIntervalMs: number;
  /**
   * The lease a claim asks for, and the budget of the work on one job under it (shorter, so that the outcome is written in time).
   * The job's time is counted from the start of the claim, because the lease begins inside it.
   */
  readonly leaseMs: number;
  readonly jobBudgetMs: number;
  readonly claimBudgetMs?: number;
  readonly recordBudgetMs?: number;
  readonly periodic?: readonly PeriodicTask[];
  /**
   * Whether the worker claims jobs at all. On by default. Off, the worker runs only its periodic tasks: it claims nothing, so it spends
   * nothing of any queued message. A worker that cannot yet confirm a redemption record (no reader exists) must not consume work whose
   * every claim would be wasted: the runtime turns this off until the readers are built (S0.29, S0.50).
   */
  readonly consume?: boolean;
}

/** What a shutdown did with the jobs the worker held. */
export interface StopReport {
  /** Finished by themselves (or no longer the worker's) before the budget ran out. */
  readonly drained: number;
  /** Still in flight when the budget ran out, and given back: due again at once for the next worker. */
  readonly relinquished: number;
  /** Still in flight, and the worker could not confirm that the lease was given back: it ends by itself. */
  readonly unconfirmed: number;
}

/** How a call under a budget ended: its value, its failure, no answer in time, or never started because the time was spent. */
type Called<T> =
  | { readonly kind: 'value'; readonly value: T }
  | { readonly kind: 'failed'; readonly error: unknown }
  | { readonly kind: 'late' }
  | { readonly kind: 'refused' };

interface JobContext {
  readonly job_id: string;
  readonly channel: DeliveryChannel;
  readonly kind: string;
  readonly attempt: number;
}

const contextOf = (leased: LeasedJob): JobContext => ({
  job_id: leased.job.id,
  channel: leased.channel,
  kind: leased.kind,
  attempt: leased.attempt,
});

/**
 * The deadline of the budget every job's work hangs from: none that matters (centuries), because the worker's own life is not
 * bounded by time. It is finished at the stop, and finishing it closes every budget below it, so nothing can start under them.
 */
const WORKER_LIFETIME_MS = Number.MAX_SAFE_INTEGER;

/**
 * A worker's name for itself: `dw:<host>:<pid>:<suffix>`, with the host cut to what the lease table takes and anything that is not
 * a letter, a digit or one of `._-` in it turned into a hyphen. Two processes on one host differ by pid and by the suffix.
 */
export function workerNameFor(host: string, pid: number, suffix: string): string {
  const safeHost = host.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64) || 'host';
  const safeSuffix = suffix.replace(/[^A-Za-z0-9]/g, '').slice(0, 16) || '0';
  return `dw:${safeHost}:${String(Math.trunc(Math.abs(pid)))}:${safeSuffix}`;
}

/**
 * How long a lane that cannot claim (the database is unavailable) waits before it looks again: the poll interval doubled for each
 * failure in a row, the doubling stopping at eight, and never more than `MAX_BACKOFF_MS`.
 */
export function laneBackoffMs(consecutiveFailures: number, pollIntervalMs: number): number {
  return Math.min(pollIntervalMs * 2 ** Math.min(consecutiveFailures, 8), MAX_BACKOFF_MS);
}

/**
 * What a log may say of a failure: its class and, where it has one that is plain, its code. Never its message or its stack: a
 * failure on the way to a provider or a store may carry a destination, a link or a token in its text, and no pattern can tell
 * (plan S0.18: "diagnostics are redacted: no token, destination or message body").
 */
function describeFailure(error: unknown): { error_type: string; error_code?: string } {
  const type = error instanceof Error ? error.constructor.name : typeof error;
  const direct: unknown =
    typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
  const code: unknown = serverErrorIn(error)?.code ?? direct;
  return typeof code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(code)
    ? { error_type: type, error_code: code }
    : { error_type: type };
}

/**
 * The delivery worker (S0.18; SECURITY_DESIGN.md §13.9a; BACKGROUND_JOBS_AND_EVENTS.md §3.2). It claims a due job with a lease in
 * a short transaction, **lets the connection go**, asks the provider whether it already holds the message where an earlier attempt
 * may have sent it, re-reads the redemption record it serves, calls the provider with **no transaction open**, and records what
 * happened in another short transaction: *accepted*, *rejected* or *unknown*. Ordering and guarantees:
 *
 * - **Fail closed on the record.** A record that has closed, or that could not be read, is not sent for. The job ends, or waits on
 *   the schedule. The record is read last, just before the send, because what is asked of the provider before it can take time.
 * - **Unknown is a normal case.** A provider that times out, throws, says it does not know, or answers with something that is not an
 *   outcome, has not told the worker the message was refused, and may have taken it: the outcome is `UNKNOWN`, and the job is tried
 *   again with the same link and the same stable provider identity. Before an attempt after the first, or after a lease was taken
 *   over from a worker that may have sent, the worker asks the provider whether it holds the message (`status`) and, if it does,
 *   records that and sends nothing. A second delivery is tolerated: redemption is single-use, and exactly-once delivery is not
 *   promised.
 * - **The schedule ends.** The sixth attempt is the last (BACKGROUND_JOBS_AND_EVENTS.md §3.2). A lease taken over after a crash and
 *   a lease given back at a stop each count as an attempt, so a job claimed for a seventh time is asked about once more and then
 *   ends, and nothing is sent: a crash after a send must not lead to a send for every lease that ends until the credential expires.
 * - **Time.** The work on a job runs under an `ExecutionBudget` of its own (OB-57), counted from the start of the claim because
 *   the lease begins inside it, that ends before its lease does; the send is an effect under it, with a budget of its own for the
 *   provider's timeout (OB-56), so an adapter can listen to its signal, a send is refused once the time is spent, and one that
 *   answers after its time is logged and changes nothing. A call is late when the budget says so, on the monotonic clock, and not
 *   when a timer of its own fires. The outcome is written under a fresh, short budget, because the job's may be spent by then.
 * - **Fencing.** The outcome carries the lease version the claim returned, and a worker whose lease was taken over, or whose job
 *   was cancelled meanwhile, writes nothing (`LEASE_LOST`) and says so.
 * - **Diagnostics.** A line holds a job's id, its channel, kind and attempt, an outcome class, and a failure's class and code: never
 *   a destination, a link, a token, or the text of an error.
 * - **Shutdown.** `stop(budget)` stops claiming, lets the jobs in flight finish for most of the budget, then gives back the leases
 *   of those that have not (they are due again at once), and abandons what it cannot confirm. After that **nothing is sent or
 *   written in its name**: the budget every job hangs from is finished, which refuses every call a lane abandoned would start, and
 *   the calls already in flight are no longer waited for.
 */
export class DeliveryWorker {
  readonly #queue: DeliveryQueue;
  readonly #providers: Readonly<Record<DeliveryChannel, DeliveryProvider>>;
  readonly #providerTimeoutMs: Readonly<Record<DeliveryChannel, number>>;
  readonly #redemption: RedemptionRecordReader;
  readonly #clock: Clock;
  readonly #log: Logger;
  readonly #metrics: Metrics;
  readonly #workerId: string;
  readonly #concurrency: number;
  readonly #pollIntervalMs: number;
  readonly #leaseMs: number;
  readonly #jobBudgetMs: number;
  readonly #claimBudgetMs: number;
  readonly #recordBudgetMs: number;
  readonly #periodicTasks: readonly PeriodicTask[];
  readonly #consume: boolean;
  /** How many claims in a row found a payload this worker cannot open: a worker incompatible with the queue slows its own claiming. */
  #deferralStreak = 0;

  readonly #loops: Promise<void>[] = [];
  readonly #inFlight = new Map<string, LeasedJob>();
  /** Aborted at the stop: wakes an idle lane and tells a periodic task to leave off. */
  readonly #wake = new AbortController();
  /** Aborted at the halt: the calls a lane is waiting on are no longer waited for. */
  readonly #halt = new AbortController();
  /** The budget the work on every job hangs from. Finished at the halt, which closes every budget below it. */
  readonly #workerBudget: ExecutionBudget;
  #started = false;
  #stopping = false;
  #halted = false;
  #stopped: Promise<StopReport> | undefined;

  constructor(options: DeliveryWorkerOptions) {
    if (!WORKER_ID_PATTERN.test(options.workerId)) {
      throw new TypeError('A worker name is plain text of one to 128 characters.');
    }
    if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
      throw new RangeError('A worker has one lane or more.');
    }
    if (!(options.pollIntervalMs > 0) || !(options.jobBudgetMs > 0)) {
      throw new RangeError('A worker polls and works for a positive time.');
    }
    if (!(options.jobBudgetMs < options.leaseMs)) {
      throw new RangeError('The work on a job ends before its lease does.');
    }
    this.#queue = options.queue;
    this.#providers = options.providers;
    this.#providerTimeoutMs = options.providerTimeoutMs;
    this.#redemption = options.redemption;
    this.#clock = options.clock;
    this.#log = options.logger;
    this.#metrics = options.metrics;
    this.#workerId = options.workerId;
    this.#concurrency = options.concurrency;
    this.#pollIntervalMs = options.pollIntervalMs;
    this.#leaseMs = options.leaseMs;
    this.#jobBudgetMs = options.jobBudgetMs;
    this.#claimBudgetMs = options.claimBudgetMs ?? CLAIM_BUDGET_MS;
    this.#recordBudgetMs = options.recordBudgetMs ?? RECORD_BUDGET_MS;
    this.#periodicTasks = options.periodic ?? [];
    this.#consume = options.consume ?? true;
    this.#workerBudget = new ExecutionBudget(options.clock, 'delivery-worker', WORKER_LIFETIME_MS);
  }

  /** The jobs the worker holds a lease of right now. */
  get inFlight(): number {
    return this.#inFlight.size;
  }

  /** Begins the lanes and the periodic tasks. Once. */
  start(): void {
    if (this.#started) throw new Error('A delivery worker is started once.');
    this.#started = true;
    this.#log.info(
      {
        worker_id: this.#workerId,
        concurrency: this.#concurrency,
        poll_interval_ms: this.#pollIntervalMs,
        lease_ms: this.#leaseMs,
      },
      'delivery worker started',
    );
    if (this.#consume) {
      for (let lane = 0; lane < this.#concurrency; lane += 1) this.#loops.push(this.#lane());
    }
    for (const task of this.#periodicTasks) this.#loops.push(this.#runPeriodically(task));
  }

  /**
   * Claims one due job and does everything for it, or finds none due. Resolves to whether there was a job. A claim that fails
   * (the database is unavailable) rejects, for the lane to back off; everything after a claim is handled here.
   */
  async runOnce(): Promise<boolean> {
    const claim = await this.#claim();
    if (claim === null) return false;
    if (claim === 'HANDLED') return true;
    await this.#process(claim.claimed, claim.startedAt);
    return true;
  }

  /**
   * Stops claiming and winds down inside `budgetMs`: the lanes are given most of it to finish what they hold, and a job still in
   * flight after that has its lease given back. A second call answers with the first's report.
   */
  stop(budgetMs: number): Promise<StopReport> {
    this.#stopped ??= this.#wind(budgetMs);
    return this.#stopped;
  }

  async #lane(): Promise<void> {
    let failures = 0;
    while (!this.#stopping) {
      try {
        const worked = await this.runOnce();
        failures = 0;
        if (this.#deferralStreak > 0) {
          // This worker could not open what it claimed. Another claim at once would find the next such job and do the same, so a worker
          // that is incompatible with the queue goes slower the longer it is.
          await this.#idle(laneBackoffMs(this.#deferralStreak, this.#pollIntervalMs));
        } else if (!worked) {
          await this.#idle(this.#pollIntervalMs);
        }
      } catch (error) {
        failures += 1;
        this.#log.error(
          { ...describeFailure(error), consecutive_failures: failures },
          'delivery claim failed',
        );
        await this.#idle(laneBackoffMs(failures, this.#pollIntervalMs));
      }
    }
  }

  async #runPeriodically(task: PeriodicTask): Promise<void> {
    while (!this.#stopping) {
      try {
        await this.#runTask(task);
      } catch (error) {
        this.#log.error(
          { task: task.name, ...describeFailure(error) },
          'delivery periodic task failed',
        );
      }
      await this.#idle(task.intervalMs);
    }
  }

  /** One run of a periodic task, under a budget of its own inside the worker's. */
  async #runTask(task: PeriodicTask): Promise<void> {
    const budget = this.#workerBudget.child(`delivery-${task.name}`, task.budgetMs);
    try {
      await runWithBudget(budget, () => task.run(this.#wake.signal));
    } finally {
      budget.finish();
    }
  }

  /** Waits, or until the worker is told to stop. */
  #idle(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (this.#stopping) {
        resolve();
        return;
      }
      const done = (): void => {
        clearTimeout(timer);
        this.#wake.signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.#wake.signal.addEventListener('abort', done, { once: true });
    });
  }

  /**
   * The next due job and the moment its claim began; null when none; `HANDLED` when it was one whose payload would not open, which
   * has been dealt with. The moment is taken before the claim is asked for, because the lease begins inside the claim.
   */
  async #claim(): Promise<{ claimed: ClaimedDelivery; startedAt: number } | 'HANDLED' | null> {
    const startedAt = this.#clock.monotonicMilliseconds();
    const budget = new ExecutionBudget(this.#clock, 'delivery-claim', this.#claimBudgetMs);
    try {
      const claimed = await runWithBudget(budget, () =>
        this.#queue.claim(this.#workerId, this.#leaseMs),
      );
      // Nothing due means nothing this worker could not open is waiting for it now.
      if (claimed === null) this.#deferralStreak = 0;
      return claimed === null ? null : { claimed, startedAt };
    } catch (error) {
      if (!(error instanceof UnreadableClaimError)) throw error;
      await this.#endUnreadable(error);
      return 'HANDLED';
    } finally {
      budget.finish();
    }
  }

  /**
   * A job was leased and its payload would not open. A payload that no worker could open (it did not authenticate, or is not what is
   * written) ends the job: no retry can change that. One that only this worker cannot open, for want of a key or a format version it
   * has not been given, is kept and tried again on the schedule: another worker, or this one once it has been given what it lacks,
   * can send it, and an erased payload cannot be recovered. Nothing was sent. After the stop nothing is written.
   */
  async #endUnreadable(error: UnreadableClaimError): Promise<void> {
    this.#inFlight.set(error.leased.job.id, error.leased);
    try {
      if (this.#halted) return;
      if (error.reason === 'NOT_HELD') {
        // Not a failure of the message and not a send: the job waits, the claim is given back, and another worker can send it.
        this.#deferralStreak += 1;
        this.#log.error(
          { ...contextOf(error.leased), deferrals: error.leased.deferrals + 1 },
          'delivery payload is not one this worker can open',
        );
        await this.#record(error.leased, { outcome: 'PAYLOAD_DEFERRED' });
      } else {
        await this.#record(error.leased, { outcome: 'PAYLOAD_UNREADABLE' });
      }
    } finally {
      this.#inFlight.delete(error.leased.job.id);
    }
  }

  async #process(claimed: ClaimedDelivery, startedAt: number): Promise<void> {
    this.#inFlight.set(claimed.job.id, claimed);
    this.#deferralStreak = 0;
    try {
      if (claimed.reclaimed) this.#metrics.increment('credential_delivery_leases_expired_total');
      this.#log.debug({ ...contextOf(claimed), reclaimed: claimed.reclaimed }, 'delivery claimed');
      const outcome = await this.#work(claimed, startedAt);
      // Once the worker has stopped it has given its leases back, and nothing is written in its name.
      if (!this.#halted) await this.#record(claimed, outcome);
    } finally {
      this.#inFlight.delete(claimed.job.id);
    }
  }

  /** The work on one job, under its budget: decides what happened, and never throws. */
  async #work(claimed: ClaimedDelivery, startedAt: number): Promise<RecordedOutcome> {
    if (this.#halted) return { outcome: 'RELINQUISHED' };
    // The lease began inside the claim, so the job has only what the claim left of its time.
    const left = this.#jobBudgetMs - (this.#clock.monotonicMilliseconds() - startedAt);
    if (!(left > 0)) {
      this.#log.warn(contextOf(claimed), 'delivery claim used all of the job’s time');
      return { outcome: 'RELINQUISHED' };
    }
    let budget: ExecutionBudget | undefined;
    try {
      budget = this.#workerBudget.child('delivery-job', left);
      const own = budget;
      return await runWithBudget(own, () => this.#decide(claimed, own));
    } catch (error) {
      // A defect on the way. The message may have been taken or not, so it is the schedule's to retry, not a loop to spin in.
      this.#log.error({ ...contextOf(claimed), ...describeFailure(error) }, 'delivery job failed');
      return { outcome: 'UNKNOWN' };
    } finally {
      budget?.finish();
    }
  }

  async #decide(claimed: ClaimedDelivery, budget: ExecutionBudget): Promise<RecordedOutcome> {
    const context = contextOf(claimed);
    const provider = this.#providers[claimed.channel];
    const timeoutMs = this.#providerTimeoutMs[claimed.channel];

    // A retry, or a lease taken over from a worker that may have sent: ask the provider before sending a second time.
    if (claimed.attempt > 1 || claimed.reclaimed) {
      const known = await this.#reconcile(provider, claimed, budget, timeoutMs, context);
      if (known !== undefined) return known;
      // The time went on the provider's answer to the question. Nothing was sent, and the job waits on the schedule rather than being
      // asked again at once: a provider this slow would be asked as fast as it is slow, and the attempts would be gone in minutes.
      if (!(budget.remainingMilliseconds() > 0)) return { outcome: 'UNKNOWN' };
    }

    // The record is read now, after whatever took time, and just before the send: it is what must be current when the send is made.
    const standing = await this.#standing(claimed, budget, context);
    if (standing === 'CLOSED') return { outcome: 'REDEMPTION_CLOSED' };
    if (standing === 'UNCONFIRMED') return { outcome: 'REDEMPTION_UNCONFIRMED' };

    // The schedule's last attempt was the sixth. A seventh claim (a lease that ended after a crash, or was given back at a stop) is
    // asked about above and goes no further: it ends the job, and nothing is sent.
    if (claimed.attempt > MAX_ATTEMPTS) {
      this.#log.info(context, 'delivery schedule exhausted');
      return { outcome: 'SCHEDULE_EXHAUSTED' };
    }

    const message: ProviderMessage = {
      dedupeId: claimed.job.providerDedupeId,
      kind: claimed.kind,
      channel: claimed.channel,
      destination: claimed.request.destination,
      link: claimed.request.link,
    };
    const sent = await this.#call(budget, 'provider-send', timeoutMs, context, () =>
      provider.send(message),
    );
    switch (sent.kind) {
      case 'refused':
        // The time was spent before the call could start: nothing was asked of the provider, and the job is given back.
        return { outcome: 'RELINQUISHED' };
      case 'late':
        this.#countAttempt(claimed.channel, 'UNKNOWN');
        return { outcome: 'UNKNOWN' };
      case 'failed':
        this.#log.warn(
          { ...context, ...describeFailure(sent.error) },
          'delivery provider call failed',
        );
        this.#countAttempt(claimed.channel, 'UNKNOWN');
        return { outcome: 'UNKNOWN' };
      case 'value':
        return this.#answer(claimed.channel, sent.value);
    }
  }

  /** Where the record stands, read under the job's budget; anything but a clear answer is that it cannot be confirmed. */
  async #standing(
    claimed: ClaimedDelivery,
    budget: ExecutionBudget,
    context: JobContext,
  ): Promise<RedemptionStanding> {
    const read = await this.#call(
      budget,
      'redemption-read',
      budget.remainingMilliseconds(),
      context,
      () => this.#redemption.standing(claimed.request.redemption),
    );
    if (read.kind === 'failed') {
      this.#log.warn(
        { ...context, ...describeFailure(read.error) },
        'delivery redemption could not be read',
      );
    }
    return read.kind === 'value' && (read.value === 'PENDING' || read.value === 'CLOSED')
      ? read.value
      : 'UNCONFIRMED';
  }

  /** The provider's account of a message it may already hold, as an outcome to record; undefined when it cannot say. */
  async #reconcile(
    provider: DeliveryProvider,
    claimed: ClaimedDelivery,
    budget: ExecutionBudget,
    timeoutMs: number,
    context: JobContext,
  ): Promise<RecordedOutcome | undefined> {
    const asked = await this.#call(budget, 'provider-status', timeoutMs, context, () =>
      provider.status(claimed.job.providerDedupeId),
    );
    if (asked.kind !== 'value' || asked.value === null) return undefined;
    const known: unknown = asked.value;
    if (typeof known !== 'object' || known === null) return undefined;
    const outcome: unknown = Reflect.get(known, 'outcome');
    // Only a settled answer is taken: a status that is itself unknown is no reason to hold the message back.
    return outcome === 'ACCEPTED' || outcome === 'REJECTED'
      ? this.#answer(claimed.channel, known, false)
      : undefined;
  }

  /** What the provider answered, as an outcome to record. Anything that is not one of the three is unknown. */
  #answer(channel: DeliveryChannel, value: unknown, count = true): RecordedOutcome {
    const said: unknown =
      typeof value === 'object' && value !== null ? Reflect.get(value, 'outcome') : undefined;
    const field = (name: string): unknown =>
      typeof value === 'object' && value !== null ? Reflect.get(value, name) : undefined;

    if (said === 'ACCEPTED') {
      const reference = field('providerMessageRef');
      if (count) this.#countAttempt(channel, 'ACCEPTED');
      return {
        outcome: 'ACCEPTED',
        providerMessageRef: typeof reference === 'string' ? reference : null,
      };
    }
    if (said === 'REJECTED' && typeof field('outcomeClass') === 'string') {
      const outcomeClass = field('outcomeClass') as string;
      if (count) {
        this.#countAttempt(
          channel,
          outcomeClass === 'DESTINATION_NOT_ALLOWED' ? 'DESTINATION_NOT_ALLOWED' : 'REJECTED',
        );
      }
      return { outcome: 'REJECTED', outcomeClass };
    }
    if (count) this.#countAttempt(channel, 'UNKNOWN');
    const wait = said === 'UNKNOWN' ? field('retryAfterMs') : undefined;
    return typeof wait === 'number' && Number.isFinite(wait) && wait > 0
      ? { outcome: 'UNKNOWN', retryAfterMs: wait }
      : { outcome: 'UNKNOWN' };
  }

  /**
   * One effect under the job's budget, with a budget of its own for the call. The call is **late when its budget says so**: the
   * budget reads the monotonic clock, expires when the time is up, and tells the call's signal, so an adapter that listens is told
   * to stop and the time the job has left is exactly what is left (a timer of this function's own can fire a millisecond before the
   * clock agrees, and the next call would then start on time that is spent). The wait is bounded by the call's time and by what the
   * job has left, so a provider that ignores its signal still cannot hold the lane or the lease, and by the halt, so a lane the
   * shutdown has given up on does not go on. A call abandoned for time that answers later is logged as late, and its answer is dropped.
   */
  async #call<T>(
    budget: ExecutionBudget,
    name: string,
    limitMs: number,
    context: JobContext,
    action: () => Promise<T>,
  ): Promise<Called<T>> {
    const bound = Math.min(limitMs, budget.remainingMilliseconds());
    if (!(bound > 0)) return { kind: 'refused' };
    const own = budget.child(name, bound);
    let started = false;
    const settled: Promise<Called<T>> = budget
      .effect(name, () => {
        started = true;
        return runWithBudget(own, action);
      })
      .then(
        (value): Called<T> => ({ kind: 'value', value }),
        (error: unknown): Called<T> => (started ? { kind: 'failed', error } : { kind: 'refused' }),
      );

    let giveUp: (() => void) | undefined;
    const spent = new Promise<'SPENT'>((resolve) => {
      own.onExpiry(() => {
        resolve('SPENT');
      });
      giveUp = () => {
        resolve('SPENT');
      };
      if (this.#halt.signal.aborted) resolve('SPENT');
      else this.#halt.signal.addEventListener('abort', giveUp, { once: true });
    });
    const raced = await Promise.race([settled, spent]);
    if (giveUp !== undefined) this.#halt.signal.removeEventListener('abort', giveUp);
    // The answer is timely only if the call's own deadline had not passed when it was seen. A promise can settle after the deadline and
    // before the timer that would have noticed has run, so the budget's monotonic clock is read here, **before** the budget is
    // finished: finishing a budget stops it expiring, and would hide a deadline that has already passed. (The job's budget is not a
    // substitute: the call's is the shorter.) Reading `expired` also expires the budget and aborts its signal, if it was due.
    const timely = raced !== 'SPENT' && !own.expired;
    own.finish();
    if (timely) return raced;

    const abandonedAt = this.#clock.monotonicMilliseconds();
    void settled.then((late) => {
      if (late.kind === 'refused') return;
      this.#log.warn(
        {
          ...context,
          call: name,
          result: late.kind,
          late_by_ms: Math.round(this.#clock.monotonicMilliseconds() - abandonedAt),
        },
        'delivery provider answered late',
      );
    });
    return { kind: 'late' };
  }

  #countAttempt(
    channel: DeliveryChannel,
    result: 'ACCEPTED' | 'UNKNOWN' | 'REJECTED' | 'DESTINATION_NOT_ALLOWED',
  ): void {
    this.#metrics.increment('credential_delivery_attempts_total', { channel, result });
  }

  #countEnd(end: JobEnd): void {
    if (
      end.state === 'FAILED' &&
      (TERMINAL_FAILURE_CLASSES as readonly string[]).includes(end.outcomeClass)
    ) {
      this.#metrics.increment('credential_delivery_jobs_failed_total', {
        outcome: end.outcomeClass,
      });
    }
    // A claim that ended before any provider was asked: the job waits, and the reason is the operator's signal.
    if (end.state === 'RETRYABLE' && end.outcomeClass === 'PAYLOAD_DEFERRED') {
      this.#metrics.increment('credential_delivery_jobs_deferred_total', {
        reason: 'PAYLOAD_NOT_HELD',
      });
    } else if (end.state === 'RETRYABLE' && end.outcomeClass === 'REDEMPTION_UNCONFIRMED') {
      this.#metrics.increment('credential_delivery_jobs_deferred_total', {
        reason: 'REDEMPTION_UNCONFIRMED',
      });
    }
  }

  /** Writes the outcome under a budget of its own. A lost lease and a failed write are logged, and neither stops the worker. */
  async #record(leased: LeasedJob, outcome: RecordedOutcome): Promise<void> {
    const budget = new ExecutionBudget(this.#clock, 'delivery-outcome', this.#recordBudgetMs);
    try {
      const end = await runWithBudget(budget, () => this.#queue.recordOutcome(leased, outcome));
      this.#countEnd(end);
      this.#log.info(
        { ...contextOf(leased), state: end.state, outcome_class: end.outcomeClass },
        'delivery outcome recorded',
      );
    } catch (error) {
      if (error instanceof LeaseLostError) {
        this.#log.warn(contextOf(leased), 'delivery lease lost');
        return;
      }
      this.#log.error(
        { ...contextOf(leased), ...describeFailure(error) },
        'delivery outcome not recorded',
      );
    } finally {
      budget.finish();
    }
  }

  /** Gives one lease back. `LOST` means it was not the worker's any more, which leaves nothing to give back. */
  async #relinquish(leased: LeasedJob): Promise<'GIVEN' | 'LOST' | 'FAILED'> {
    const budget = new ExecutionBudget(this.#clock, 'delivery-relinquish', this.#recordBudgetMs);
    try {
      await runWithBudget(budget, () =>
        this.#queue.recordOutcome(leased, { outcome: 'RELINQUISHED' }),
      );
      return 'GIVEN';
    } catch (error) {
      if (error instanceof LeaseLostError) return 'LOST';
      this.#log.error(
        { ...contextOf(leased), ...describeFailure(error) },
        'delivery lease could not be given back',
      );
      return 'FAILED';
    } finally {
      budget.finish();
    }
  }

  async #wind(budgetMs: number): Promise<StopReport> {
    this.#stopping = true;
    this.#wake.abort();
    const atStop = this.#inFlight.size;
    this.#log.info({ in_flight: atStop, budget_ms: budgetMs }, 'delivery worker stopping');

    // Most of the budget is for the lanes to finish what they hold; the rest is for giving back what they could not.
    const reserve = Math.min(RELINQUISH_RESERVE_MS, budgetMs / 2);
    const finished = await withinBudget(Promise.all(this.#loops), Math.max(0, budgetMs - reserve));

    const pending = finished.expired ? [...this.#inFlight.values()] : [];
    // From here nothing is sent and nothing is written in the worker's name, whether or not the loops ended: the budget every job
    // hangs from is finished, which refuses what a lane that was given up on would start, and the calls it is waiting on are let go.
    this.#halted = true;
    this.#workerBudget.finish();
    this.#halt.abort();

    let drained = Math.max(0, atStop - pending.length);
    let relinquished = 0;
    let unconfirmed = 0;
    if (pending.length > 0) {
      const results: ('GIVEN' | 'LOST' | 'FAILED')[] = [];
      await withinBudget(
        Promise.all(
          pending.map(async (leased) => {
            results.push(await this.#relinquish(leased));
          }),
        ),
        reserve,
      );
      for (const result of results) {
        if (result === 'GIVEN') relinquished += 1;
        else if (result === 'LOST') drained += 1;
        else unconfirmed += 1;
      }
      // What had not answered when the time ran out is not confirmed, whatever the others did.
      unconfirmed += pending.length - results.length;
    }
    const report: StopReport = { drained, relinquished, unconfirmed };
    this.#log.info({ ...report }, 'delivery worker stopped');
    return report;
  }
}
