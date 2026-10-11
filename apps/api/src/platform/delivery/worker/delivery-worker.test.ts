import { describe, expect, it } from 'vitest';

import { SystemClock } from '../../auth/clock/system.clock.adapter.js';
import type { Clock } from '../../auth/ports/clock.port.js';
import { ManualClock } from '../../../test-support/manual-clock.js';
import type {
  ClaimedDelivery,
  DeliveryOutcome,
  DeliveryQueue,
  JobEnd,
  LeasedJob,
  RecordedOutcome,
} from '../../auth/ports/delivery-queue.port.js';
import type { DeliveryProvider, ProviderMessage } from '../../auth/ports/delivery-provider.port.js';
import { ExecutionBudget, currentBudget } from '../../execution/execution-budget.js';
import { createServiceLogger } from '../../logging/create-logger.js';
import { BoundedMetrics } from '../../metrics/bounded.metrics.adapter.js';
import { LeaseLostError, UnreadableClaimError } from '../delivery-errors.js';
import { CLAIM_BUDGET_MS, MAX_BACKOFF_MS, RECORD_BUDGET_MS } from '../delivery-parameters.js';
import {
  DeliveryWorker,
  laneBackoffMs,
  type DeliveryWorkerOptions,
  type PeriodicTask,
} from './delivery-worker.js';
import type { RedemptionRecordReader, RedemptionStanding } from './redemption-record-reader.js';

const TOKEN = 'SENTINEL-TOKEN-0f3a9c27b1e84d65a0c7';
const DESTINATION = 'sentinel.person@example.test';
const LINK = `https://ops.example.test/setup/credential#token=${TOKEN}`;
const DEDUPE = 'b6c1f0a2-3d4e-4f5a-8b9c-0d1e2f3a4b5c';
const REDEMPTION = { type: 'SETUP_GRANT', id: '11111111-2222-4333-8444-555555555555' };
const clock = new SystemClock();

function claimed(over: Partial<ClaimedDelivery> = {}): ClaimedDelivery {
  return {
    job: { id: 'job-0001', providerDedupeId: DEDUPE },
    leaseVersion: 1,
    attempt: 1,
    deferrals: 0,
    kind: 'SETUP_GRANT',
    channel: 'EMAIL',
    reclaimed: false,
    request: {
      kind: 'SETUP_GRANT',
      redemption: REDEMPTION,
      principal: { type: 'STAFF', id: '66666666-7777-4888-8999-aaaaaaaaaaaa' },
      channel: 'EMAIL',
      destination: DESTINATION,
      link: LINK,
      expiresAt: new Date(Date.now() + 60_000),
    },
    ...over,
  };
}

/** A queue that hands out what it is given and keeps what it is told, in order. */
class FakeQueue implements DeliveryQueue {
  readonly calls: string[] = [];
  readonly recorded: { leased: LeasedJob; outcome: RecordedOutcome }[] = [];
  readonly #waiting: (ClaimedDelivery | Error)[];
  claimFailure: Error | undefined;
  recordFailure: Error | undefined;
  /** What `recordOutcome` answers: by default the state an outcome of that kind leads to. */
  endOf: (outcome: RecordedOutcome) => JobEnd = (outcome) => defaultEnd(outcome);
  claimDelayMs = 0;
  /** How long recording an outcome takes: by outcome and job. */
  recordDelayMs: (leased: LeasedJob, outcome: RecordedOutcome) => number = () => 0;
  /** The budget each call ran under, as the queue saw it, and whether that budget had already run out when the call began. */
  readonly seen: {
    readonly call: 'claim' | 'record';
    readonly budget: ExecutionBudget | undefined;
    readonly expired: boolean | undefined;
  }[] = [];

  constructor(jobs: (ClaimedDelivery | Error)[] = []) {
    this.#waiting = [...jobs];
  }

  add(job: ClaimedDelivery): void {
    this.#waiting.push(job);
  }

  enqueue(): never {
    throw new Error('not the worker’s');
  }

  cancel(): never {
    throw new Error('not the worker’s');
  }

  async claim(): Promise<ClaimedDelivery | null> {
    this.calls.push('claim');
    const budget = currentBudget();
    this.seen.push({ call: 'claim', budget, expired: budget?.expired });
    if (this.claimDelayMs > 0)
      await new Promise((resolve) => setTimeout(resolve, this.claimDelayMs));
    if (this.claimFailure !== undefined) throw this.claimFailure;
    const next = this.#waiting.shift();
    if (next === undefined) return null;
    if (next instanceof Error) throw next;
    return next;
  }

  async recordOutcome(leased: LeasedJob, outcome: RecordedOutcome): Promise<JobEnd> {
    this.calls.push(`record:${outcome.outcome}`);
    const budget = currentBudget();
    this.seen.push({ call: 'record', budget, expired: budget?.expired });
    const wait = this.recordDelayMs(leased, outcome);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    if (this.recordFailure !== undefined) throw this.recordFailure;
    this.recorded.push({ leased, outcome });
    return this.endOf(outcome);
  }
}

function defaultEnd(outcome: RecordedOutcome): JobEnd {
  switch (outcome.outcome) {
    case 'ACCEPTED':
      return { state: 'ACCEPTED', outcomeClass: 'ACCEPTED' };
    case 'REJECTED':
      return { state: 'FAILED', outcomeClass: outcome.outcomeClass };
    case 'UNKNOWN':
      return { state: 'RETRYABLE', outcomeClass: 'UNKNOWN' };
    case 'REDEMPTION_UNCONFIRMED':
      return { state: 'RETRYABLE', outcomeClass: 'REDEMPTION_UNCONFIRMED' };
    case 'REDEMPTION_CLOSED':
      return { state: 'CANCELLED', outcomeClass: 'CANCELLED' };
    case 'PAYLOAD_UNREADABLE':
      return { state: 'FAILED', outcomeClass: 'PAYLOAD_UNREADABLE' };
    case 'PAYLOAD_DEFERRED':
      return { state: 'RETRYABLE', outcomeClass: 'PAYLOAD_DEFERRED' };
    case 'SCHEDULE_EXHAUSTED':
      return { state: 'FAILED', outcomeClass: 'SCHEDULE_EXHAUSTED' };
    case 'RELINQUISHED':
      return { state: 'RETRYABLE', outcomeClass: 'RELINQUISHED' };
  }
}

/** A provider that answers as scripted and keeps every message it was given. */
class FakeProvider implements DeliveryProvider {
  readonly sent: ProviderMessage[] = [];
  readonly statusAsked: string[] = [];
  readonly budgets: (ExecutionBudget | undefined)[] = [];
  answer: () => Promise<DeliveryOutcome> = () =>
    Promise.resolve({ outcome: 'ACCEPTED', providerMessageRef: 'ref-1' });
  statusAnswer: () => Promise<DeliveryOutcome | null> = () => Promise.resolve(null);

  trail: string[] = [];

  send(message: ProviderMessage): Promise<DeliveryOutcome> {
    this.trail.push('send');
    this.sent.push(message);
    this.budgets.push(currentBudget());
    return this.answer();
  }

  status(dedupeId: string): Promise<DeliveryOutcome | null> {
    this.trail.push('status');
    this.statusAsked.push(dedupeId);
    return this.statusAnswer();
  }
}

class FakeReader implements RedemptionRecordReader {
  readonly asked: unknown[] = [];
  answer: () => Promise<RedemptionStanding> = () => Promise.resolve('PENDING');
  trail: string[] = [];
  standing(record: unknown): Promise<RedemptionStanding> {
    this.trail.push('standing');
    this.asked.push(record);
    return this.answer();
  }
}

/**
 * A clock whose monotonic reading runs at half the speed of real time: a real timer set from it fires while the clock still has
 * time to go, as the coarse timer of a busy loop does by a millisecond or two, only here by half of what it was set for.
 */
class SlowClock implements Clock {
  readonly #start = performance.now();
  now(): Date {
    return new Date();
  }
  monotonicMilliseconds(): number {
    return this.#start + (performance.now() - this.#start) / 2;
  }
}

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
const later = <T>(ms: number, value: T): Promise<T> =>
  new Promise((resolve) =>
    setTimeout(() => {
      resolve(value);
    }, ms),
  );

interface Rig {
  readonly worker: DeliveryWorker;
  readonly queue: FakeQueue;
  readonly provider: FakeProvider;
  readonly sms: FakeProvider;
  readonly reader: FakeReader;
  readonly metrics: BoundedMetrics;
  readonly lines: Record<string, unknown>[];
  readonly text: () => string;
  /** What the provider and the reader were asked, in the order they were asked. */
  readonly trail: string[];
}

function rig(
  jobs: (ClaimedDelivery | Error)[] = [claimed()],
  over: Partial<DeliveryWorkerOptions> = {},
): Rig {
  const queue = new FakeQueue(jobs);
  const provider = new FakeProvider();
  const sms = new FakeProvider();
  const reader = new FakeReader();
  const trail: string[] = [];
  provider.trail = trail;
  reader.trail = trail;
  const metrics = new BoundedMetrics({ policy: 'throw', clock });
  const raw: string[] = [];
  const logger = createServiceLogger({
    service: 'melarc-delivery-worker',
    level: 'debug',
    appEnv: 'local',
    destination: { write: (line: string) => void raw.push(line) },
  });
  const worker = new DeliveryWorker({
    queue,
    providers: { EMAIL: provider, SMS: sms },
    providerTimeoutMs: { EMAIL: 1_000, SMS: 1_000 },
    redemption: reader,
    clock,
    logger,
    metrics,
    workerId: 'dw-test',
    concurrency: 1,
    pollIntervalMs: 100,
    leaseMs: 30_000,
    jobBudgetMs: 25_000,
    ...over,
  });
  return {
    worker,
    queue,
    provider,
    sms,
    reader,
    metrics,
    get lines() {
      return raw.map((line) => JSON.parse(line) as Record<string, unknown>);
    },
    text: () => raw.join(''),
    trail,
  };
}

const counter = (metrics: BoundedMetrics, name: string, labels: Record<string, string> = {}) =>
  metrics
    .snapshot()
    .counters.find(
      (entry) =>
        entry.name === name &&
        Object.entries(labels).every(([key, value]) => entry.labels[key] === value),
    )?.value ?? 0;

async function until(condition: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('the condition did not come true in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('the delivery worker, one job at a time (S0.18)', () => {
  // Break caught: a message sent without its stable identity (a retry would be a second message to the provider), with another
  // job's content, or recorded as anything but what the provider said.
  it('reads the record, sends the message with the job’s stable identity, and records it accepted', async () => {
    const r = rig();

    const worked = await r.worker.runOnce();

    expect(worked).toBe(true);
    expect(r.reader.asked).toEqual([REDEMPTION]);
    expect(r.provider.sent).toEqual([
      {
        dedupeId: DEDUPE,
        kind: 'SETUP_GRANT',
        channel: 'EMAIL',
        destination: DESTINATION,
        link: LINK,
      },
    ]);
    expect(r.queue.recorded.map((entry) => entry.outcome)).toEqual([
      { outcome: 'ACCEPTED', providerMessageRef: 'ref-1' },
    ]);
    expect(r.queue.calls).toEqual(['claim', 'record:ACCEPTED']);
    expect(
      counter(r.metrics, 'credential_delivery_attempts_total', {
        channel: 'EMAIL',
        result: 'ACCEPTED',
      }),
    ).toBe(1);
  });

  // Break caught: the SMS channel sent through the email provider, or the reverse.
  it('sends each message through the provider of its own channel', async () => {
    const sms = claimed({
      channel: 'SMS',
      request: { ...claimed().request, channel: 'SMS', destination: '+233201234567' },
    });
    const r = rig([sms]);

    await r.worker.runOnce();

    expect(r.provider.sent).toEqual([]);
    expect(r.sms.sent).toMatchObject([{ channel: 'SMS', destination: '+233201234567' }]);
    expect(
      counter(r.metrics, 'credential_delivery_attempts_total', {
        channel: 'SMS',
        result: 'ACCEPTED',
      }),
    ).toBe(1);
  });

  // Break caught: nothing claimed being treated as work, or a worker that does anything with nothing to do.
  it('reports that nothing was due, and does nothing else', async () => {
    const r = rig([]);

    expect(await r.worker.runOnce()).toBe(false);

    expect(r.queue.calls).toEqual(['claim']);
    expect(r.reader.asked).toEqual([]);
  });

  // Break caught: a message sent for a credential that was consumed, superseded or has expired: the record is read before the send.
  it('does not call the provider when the record has closed, and records that', async () => {
    const r = rig();
    r.reader.answer = () => Promise.resolve('CLOSED');

    await r.worker.runOnce();

    expect(r.provider.sent).toEqual([]);
    expect(r.queue.recorded.map((entry) => entry.outcome)).toEqual([
      { outcome: 'REDEMPTION_CLOSED' },
    ]);
  });

  // Break caught: a record that could not be read being taken for a pending one (it fails closed), or an error from the reader
  // surfacing as a crash of the worker.
  it.each([
    ['says it cannot confirm', () => Promise.resolve<RedemptionStanding>('UNCONFIRMED')],
    ['throws', () => Promise.reject(new Error(`cannot read ${DESTINATION} ${TOKEN}`))],
    ['never answers within the job’s time', () => never<RedemptionStanding>()],
  ])(
    'does not call the provider when the reader %s, and records that it could not confirm',
    async (_label, answer) => {
      const r = rig([claimed()], { jobBudgetMs: 200 });
      r.reader.answer = answer;

      await r.worker.runOnce();

      expect(r.provider.sent).toEqual([]);
      expect(r.queue.recorded.map((entry) => entry.outcome.outcome)).toEqual([
        'REDEMPTION_UNCONFIRMED',
      ]);
      expect(r.text()).not.toContain(TOKEN);
      expect(r.text()).not.toContain(DESTINATION);
    },
  );

  // Break caught: a reader that answers with something that is not one of its three answers being taken for a pending record: the
  // worker would send for a record it knows nothing about. Anything but a clear PENDING or CLOSED is that it cannot confirm.
  it.each([[undefined], [null], ['YES'], ['pending'], [{ standing: 'PENDING' }], [1]])(
    'does not send when the reader answers %j, which is not a standing',
    async (answer) => {
      const r = rig();
      r.reader.answer = () => Promise.resolve(answer as unknown as RedemptionStanding);

      await r.worker.runOnce();

      expect(r.provider.sent).toEqual([]);
      expect(r.queue.recorded.map((entry) => entry.outcome)).toEqual([
        { outcome: 'REDEMPTION_UNCONFIRMED' },
      ]);
    },
  );

  // Break caught: a provider that is not asked to account for a message it may have taken (a retry sending a second one), or asked
  // on the first attempt, where there is nothing to reconcile.
  it('asks the provider whether it holds the message before a retry, and records what it says without sending again', async () => {
    const r = rig([claimed({ attempt: 2 })]);
    r.provider.statusAnswer = () =>
      Promise.resolve({ outcome: 'ACCEPTED', providerMessageRef: 'held-1' });

    await r.worker.runOnce();

    expect(r.provider.statusAsked).toEqual([DEDUPE]);
    expect(r.provider.sent).toEqual([]);
    expect(r.queue.recorded.map((entry) => entry.outcome)).toEqual([
      { outcome: 'ACCEPTED', providerMessageRef: 'held-1' },
    ]);
  });

  // Break caught: the record read before the provider is asked about the message. A status query can take most of the job's time,
  // and the record is what must be current when the send is made (SECURITY_DESIGN.md §13.9a: re-read before it sends).
  it('reads the record after the provider has been asked about the message, and just before the send', async () => {
    const r = rig([claimed({ attempt: 2 })]);

    await r.worker.runOnce();

    expect(r.trail).toEqual(['status', 'standing', 'send']);
  });

  it('does not send when the record closed while the provider was being asked', async () => {
    const r = rig([claimed({ attempt: 2 })]);
    r.provider.statusAnswer = () => {
      r.reader.answer = () => Promise.resolve('CLOSED');
      return Promise.resolve(null);
    };

    await r.worker.runOnce();

    expect(r.provider.sent).toEqual([]);
    expect(r.queue.recorded.map((entry) => entry.outcome)).toEqual([
      { outcome: 'REDEMPTION_CLOSED' },
    ]);
  });

  it('does not ask the provider about a first attempt', async () => {
    const r = rig([claimed({ attempt: 1 })]);

    await r.worker.runOnce();

    expect(r.provider.statusAsked).toEqual([]);
    expect(r.provider.sent).toHaveLength(1);
  });

  // Break caught: a lease taken over from a worker that may have sent (the job was reclaimed) being sent as if new.
  it('asks about the message before sending when the lease was taken over, whatever the attempt', async () => {
    const r = rig([claimed({ attempt: 1, reclaimed: true })]);

    await r.worker.runOnce();

    expect(r.provider.statusAsked).toEqual([DEDUPE]);
    expect(counter(r.metrics, 'credential_delivery_leases_expired_total')).toBe(1);
  });

  // Break caught: a status the provider cannot give (nothing, unknown, an error) stopping the retry, which is the message the
  // recipient is waiting for.
  it.each([
    ['says nothing', () => Promise.resolve(null)],
    ['says unknown', () => Promise.resolve<DeliveryOutcome>({ outcome: 'UNKNOWN' })],
    ['fails', () => Promise.reject(new Error(`status failed ${TOKEN}`))],
  ])('sends the message when the provider’s status %s', async (_label, statusAnswer) => {
    const r = rig([claimed({ attempt: 3 })]);
    r.provider.statusAnswer = statusAnswer;

    await r.worker.runOnce();

    expect(r.provider.sent).toHaveLength(1);
    expect(r.queue.recorded.map((entry) => entry.outcome.outcome)).toEqual(['ACCEPTED']);
    expect(r.text()).not.toContain(TOKEN);
  });

  it('records a rejection the provider reported at the status query', async () => {
    const r = rig([claimed({ attempt: 2 })]);
    r.provider.statusAnswer = () =>
      Promise.resolve({ outcome: 'REJECTED', outcomeClass: 'REJECTED' });

    await r.worker.runOnce();

    expect(r.provider.sent).toEqual([]);
    expect(r.queue.recorded.map((entry) => entry.outcome)).toEqual([
      { outcome: 'REJECTED', outcomeClass: 'REJECTED' },
    ]);
  });

  // Break caught: a provider that throws counted as a success, or as a rejection that ends the message (an exception says nothing
  // about whether the message was taken), or its text reaching the log.
  it('takes a provider that throws for an unknown outcome, never for an acceptance, and logs no text of the error', async () => {
    const r = rig();
    r.provider.answer = () => Promise.reject(new Error(`boom ${DESTINATION} ${TOKEN}`));

    await r.worker.runOnce();

    expect(r.queue.recorded.map((entry) => entry.outcome)).toEqual([{ outcome: 'UNKNOWN' }]);
    expect(
      counter(r.metrics, 'credential_delivery_attempts_total', {
        channel: 'EMAIL',
        result: 'UNKNOWN',
      }),
    ).toBe(1);
    expect(r.text()).not.toContain(TOKEN);
    expect(r.text()).not.toContain(DESTINATION);
  });

  // Break caught: an answer that is not one of the three the port allows being recorded as it came.
  it.each([[undefined], [null], ['ACCEPTED'], [{ outcome: 'DONE' }], [{}]])(
    'takes an answer that is not an outcome (%j) for an unknown one',
    async (answer) => {
      const r = rig();
      r.provider.answer = () => Promise.resolve(answer as unknown as DeliveryOutcome);

      await r.worker.runOnce();

      expect(r.queue.recorded.map((entry) => entry.outcome)).toEqual([{ outcome: 'UNKNOWN' }]);
    },
  );

  // Break caught: a Retry-After lost on its way to the schedule, or one that is not a number getting through.
  it('passes the provider’s request to wait on to the schedule', async () => {
    const r = rig();
    r.provider.answer = () => Promise.resolve({ outcome: 'UNKNOWN', retryAfterMs: 90_000 });

    await r.worker.runOnce();

    expect(r.queue.recorded.map((entry) => entry.outcome)).toEqual([
      { outcome: 'UNKNOWN', retryAfterMs: 90_000 },
    ]);
  });

  // Break caught: a rejection retried blindly, its class lost, or the destination refusal not counted as its own result.
  it.each([
    ['REJECTED', 'REJECTED'],
    ['DESTINATION_NOT_ALLOWED', 'DESTINATION_NOT_ALLOWED'],
  ])(
    'records a rejection of class %s and counts the attempt as %s',
    async (outcomeClass, result) => {
      const r = rig();
      r.provider.answer = () => Promise.resolve({ outcome: 'REJECTED', outcomeClass });

      await r.worker.runOnce();

      expect(r.queue.recorded.map((entry) => entry.outcome)).toEqual([
        { outcome: 'REJECTED', outcomeClass },
      ]);
      expect(
        counter(r.metrics, 'credential_delivery_attempts_total', { channel: 'EMAIL', result }),
      ).toBe(1);
      expect(
        counter(r.metrics, 'credential_delivery_jobs_failed_total', { outcome: outcomeClass }),
      ).toBe(1);
    },
  );

  // Break caught: a terminal failure that is not counted, or one counted when the job merely waits or ended some other way.
  it.each([
    [{ state: 'FAILED', outcomeClass: 'SCHEDULE_EXHAUSTED' }, 1],
    [{ state: 'RETRYABLE', outcomeClass: 'UNKNOWN' }, 0],
    // A failure class on a job that did not end in FAILED. The table's CHECK keeps the two together, so a store never answers this;
    // the count is of jobs that failed, and it is the state that says so.
    [{ state: 'RETRYABLE', outcomeClass: 'REJECTED' }, 0],
    [{ state: 'EXPIRED', outcomeClass: 'EXPIRED' }, 0],
    [{ state: 'CANCELLED', outcomeClass: 'CANCELLED' }, 0],
    [{ state: 'ACCEPTED', outcomeClass: 'ACCEPTED' }, 0],
  ] as const)('counts the end %j as %i terminal failure(s)', async (end, failures) => {
    const r = rig();
    r.provider.answer = () => Promise.resolve({ outcome: 'UNKNOWN' });
    r.queue.endOf = () => end;

    await r.worker.runOnce();

    const total = [
      'REJECTED',
      'DESTINATION_NOT_ALLOWED',
      'SCHEDULE_EXHAUSTED',
      'PAYLOAD_UNREADABLE',
    ]
      .map((outcome) => counter(r.metrics, 'credential_delivery_jobs_failed_total', { outcome }))
      .reduce((a, b) => a + b, 0);
    expect(total).toBe(failures);
  });
});

describe('the delivery worker and the time a send may take (S0.18; OB-56, OB-57)', () => {
  // Break caught: a send that runs outside the budget of the job (no cancel, no late-effect record, nothing for the adapter to listen to).
  it('makes the send under a budget of its own, inside the job’s, and sets it for the provider to read', async () => {
    const r = rig();

    await r.worker.runOnce();

    const budget = r.provider.budgets[0];
    expect(budget).toBeInstanceOf(ExecutionBudget);
    expect(budget?.label).toBe('provider-send');
    expect(budget?.budgetMilliseconds).toBe(1_000);
  });

  // Break caught: a provider that never answers holding the lane, and the lease, until it does; and a late acceptance changing what was
  // recorded. The outcome is unknown at the timeout, and the call is abandoned.
  it('records an unknown outcome when the provider does not answer in its time, and does not wait for it', async () => {
    const r = rig([claimed()], { providerTimeoutMs: { EMAIL: 150, SMS: 150 } });
    r.provider.answer = () => never<DeliveryOutcome>();
    const started = Date.now();

    await r.worker.runOnce();

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(r.queue.recorded.map((entry) => entry.outcome)).toEqual([{ outcome: 'UNKNOWN' }]);
    expect(
      counter(r.metrics, 'credential_delivery_attempts_total', {
        channel: 'EMAIL',
        result: 'UNKNOWN',
      }),
    ).toBe(1);
  });

  // Break caught: the timeout-then-late-acceptance case: a provider that answers after the timeout being recorded as accepted by a
  // second write, or crashing the worker; it is a late effect, logged, and the next attempt's status query finds the message.
  it('records nothing more when the provider accepts after the time it was given, and says so in the log', async () => {
    const r = rig([claimed()], { providerTimeoutMs: { EMAIL: 100, SMS: 100 } });
    r.provider.answer = () => later(250, { outcome: 'ACCEPTED', providerMessageRef: 'late-1' });

    await r.worker.runOnce();
    await until(() => r.lines.some((line) => line.msg === 'delivery provider answered late'));

    expect(r.queue.recorded.map((entry) => entry.outcome)).toEqual([{ outcome: 'UNKNOWN' }]);
    expect(r.queue.calls.filter((call) => call.startsWith('record:'))).toHaveLength(1);
    expect(r.text()).not.toContain('late-1');
  });

  // Break caught: a send started when the job's time is already spent (the lease may be gone, and another worker has the job). Here
  // the time went on the provider's status query. The job waits on the schedule, not at once: a provider that is slow to answer
  // would otherwise be asked again as fast as it is slow, and the six attempts would be gone in minutes.
  it('tries again on the schedule, without sending, when the provider’s answer to the status query used up the job’s time', async () => {
    const r = rig([claimed({ attempt: 2 })], { jobBudgetMs: 120 });
    r.provider.statusAnswer = () => later(250, null);

    await r.worker.runOnce();

    expect(r.provider.sent).toEqual([]);
    expect(r.reader.asked).toEqual([]);
    expect(r.queue.recorded.map((entry) => entry.outcome)).toEqual([{ outcome: 'UNKNOWN' }]);
  });

  // Break caught: a call declared late by a timer of its own, which can fire while the budget still has time to go: the next call then
  // starts on what is left (here, a send, after the status query used the whole of the job's time).
  it('declares a call late only when the budget itself says its time is up, and so starts no send on time that is spent', async () => {
    const r = rig([claimed({ attempt: 2 })], { jobBudgetMs: 120, clock: new SlowClock() });
    r.provider.statusAnswer = () => later(400, null);

    await r.worker.runOnce();

    expect(r.provider.sent).toEqual([]);
    expect(r.queue.recorded.map((entry) => entry.outcome)).toEqual([{ outcome: 'UNKNOWN' }]);
  });

  // Break caught: an abandoned send whose budget is merely finished, so that a provider that listens to its signal is never told to stop.
  it('tells the provider to stop when its time is up: the signal of its budget is aborted', async () => {
    const r = rig([claimed()], { providerTimeoutMs: { EMAIL: 100, SMS: 100 } });
    r.provider.answer = () => never<DeliveryOutcome>();

    await r.worker.runOnce();

    const budget = r.provider.budgets[0];
    expect(budget?.signal.aborted).toBe(true);
    expect(budget?.expired).toBe(true);
  });

  // Break caught: the budget of a send that is not bounded by the job's: here the job has 300 ms and the provider is allowed a second.
  it('gives a send no more time than the job has left', async () => {
    const r = rig([claimed()], {
      jobBudgetMs: 300,
      providerTimeoutMs: { EMAIL: 1_000, SMS: 1_000 },
    });

    await r.worker.runOnce();

    expect(r.provider.budgets[0]?.budgetMilliseconds).toBeLessThanOrEqual(300);
  });

  // Break caught: the claim and the outcome run under no budget, or under the job's (which may have run out by then).
  it('claims under a budget of its own and records under another, which is not the job’s and has not run out', async () => {
    const r = rig([claimed()], {
      jobBudgetMs: 200,
      providerTimeoutMs: { EMAIL: 5_000, SMS: 5_000 },
    });
    r.provider.answer = () => never<DeliveryOutcome>();

    await r.worker.runOnce();

    const claim = r.queue.seen.find((entry) => entry.call === 'claim');
    const record = r.queue.seen.find((entry) => entry.call === 'record');
    expect(claim?.budget?.label).toBe('delivery-claim');
    expect(claim?.budget?.budgetMilliseconds).toBe(CLAIM_BUDGET_MS);
    expect(record?.budget?.label).toBe('delivery-outcome');
    expect(record?.budget?.budgetMilliseconds).toBe(RECORD_BUDGET_MS);
    expect(record?.expired).toBe(false);
  });

  // Break caught: a job's time that starts when the claim returns. The lease began inside the claim, so the time the claim took is
  // time the job no longer has.
  it('counts the time the claim took against the job’s own', async () => {
    const r = rig([claimed()], { jobBudgetMs: 400 });
    r.queue.claimDelayMs = 300;

    await r.worker.runOnce();

    expect(r.provider.budgets[0]?.budgetMilliseconds).toBeLessThanOrEqual(130);
  });

  it('gives the job back at once when the claim used all of its time', async () => {
    const r = rig([claimed()], { jobBudgetMs: 150 });
    r.queue.claimDelayMs = 250;

    await r.worker.runOnce();

    expect(r.reader.asked).toEqual([]);
    expect(r.provider.sent).toEqual([]);
    expect(r.queue.recorded.map((entry) => entry.outcome)).toEqual([{ outcome: 'RELINQUISHED' }]);
  });

  // Break caught: a record that could not be read in the job's time being waited for beyond it, or treated as pending.
  it('records that it could not confirm the record when the read outlasts the job’s time', async () => {
    const r = rig([claimed()], { jobBudgetMs: 120 });
    r.reader.answer = () => later<RedemptionStanding>(250, 'PENDING');

    await r.worker.runOnce();

    expect(r.provider.sent).toEqual([]);
    expect(r.queue.recorded.map((entry) => entry.outcome)).toEqual([
      { outcome: 'REDEMPTION_UNCONFIRMED' },
    ]);
  });

  // Break caught: the outcome recorded under the job's own budget, which has run out by then, so that it could never be written.
  it('records the outcome of a send that used up the job’s time, under a budget of its own', async () => {
    const r = rig([claimed()], {
      jobBudgetMs: 200,
      providerTimeoutMs: { EMAIL: 5_000, SMS: 5_000 },
    });
    r.provider.answer = () => never<DeliveryOutcome>();
    const started = Date.now();

    await r.worker.runOnce();

    // Not the provider's five seconds: the job's time (a fifth of that) is what the lane and the lease can spare.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(r.queue.recorded.map((entry) => entry.outcome)).toEqual([{ outcome: 'UNKNOWN' }]);
  });
});

describe('the delivery worker and what it cannot do (S0.18)', () => {
  // Break caught: a payload that will not open being retried, or sent as something, or its lease left to expire.
  it('ends a job whose payload would not open, never touches the reader or the provider, and counts the failure', async () => {
    const leased: LeasedJob = {
      job: { id: 'job-bad', providerDedupeId: DEDUPE },
      leaseVersion: 3,
      attempt: 1,
      deferrals: 0,
      kind: 'SETUP_GRANT',
      channel: 'EMAIL',
    };
    const r = rig([new UnreadableClaimError(leased)]);

    const worked = await r.worker.runOnce();

    expect(worked).toBe(true);
    expect(r.reader.asked).toEqual([]);
    expect(r.provider.sent).toEqual([]);
    expect(r.queue.recorded).toEqual([{ leased, outcome: { outcome: 'PAYLOAD_UNREADABLE' } }]);
    expect(
      counter(r.metrics, 'credential_delivery_jobs_failed_total', {
        outcome: 'PAYLOAD_UNREADABLE',
      }),
    ).toBe(1);
  });

  // Break caught: a payload that this worker cannot open only because it does not hold the key or the format version (a rotation the
  // worker has not been given yet) being destroyed. The ciphertext stays, and the job waits on the schedule for a worker that can.
  it('keeps a payload it cannot open for want of a version it does not hold, and tries again on the schedule', async () => {
    const leased: LeasedJob = {
      job: { id: 'job-skew', providerDedupeId: DEDUPE },
      leaseVersion: 2,
      attempt: 1,
      deferrals: 0,
      kind: 'SETUP_GRANT',
      channel: 'EMAIL',
    };
    const r = rig([new UnreadableClaimError(leased, 'NOT_HELD')]);

    await r.worker.runOnce();

    expect(r.provider.sent).toEqual([]);
    expect(r.reader.asked).toEqual([]);
    expect(r.queue.recorded).toEqual([{ leased, outcome: { outcome: 'PAYLOAD_DEFERRED' } }]);
    expect(
      counter(r.metrics, 'credential_delivery_jobs_failed_total', {
        outcome: 'PAYLOAD_UNREADABLE',
      }),
    ).toBe(0);
    expect(
      r.lines.find((line) => line.msg === 'delivery payload is not one this worker can open'),
    ).toMatchObject({ level: 'error', job_id: 'job-skew' });
  });

  // Break caught (G2-03): a claim that could not open the payload counted as a send (it is recorded as UNKNOWN, which is a send whose
  // answer is not known), or not counted where an operator reads it: nothing was sent, and the rate of these is how a worker that is
  // incompatible with the queue shows itself.
  it('counts a deferral by its reason, and counts neither a provider answer nor a failure for it', async () => {
    const leased: LeasedJob = {
      job: { id: 'job-skew', providerDedupeId: DEDUPE },
      leaseVersion: 2,
      attempt: 1,
      deferrals: 3,
      kind: 'SETUP_GRANT',
      channel: 'EMAIL',
    };
    const r = rig([new UnreadableClaimError(leased, 'NOT_HELD')]);

    await r.worker.runOnce();

    expect(
      counter(r.metrics, 'credential_delivery_jobs_deferred_total', { reason: 'PAYLOAD_NOT_HELD' }),
    ).toBe(1);
    expect(counter(r.metrics, 'credential_delivery_attempts_total')).toBe(0);
    expect(counter(r.metrics, 'credential_delivery_jobs_failed_total')).toBe(0);
    // the line says how many times the job has now been given back, and nothing of its content
    expect(
      r.lines.find((line) => line.msg === 'delivery payload is not one this worker can open'),
    ).toMatchObject({ deferrals: 4 });
  });

  // Break caught (G2-03): a record that could not be confirmed leaving no trace for the operator, while the claim is given back.
  it('counts a claim that could not confirm the redemption record as a deferral too', async () => {
    const r = rig();
    r.reader.answer = () => Promise.resolve<RedemptionStanding>('UNCONFIRMED');

    await r.worker.runOnce();

    expect(
      counter(r.metrics, 'credential_delivery_jobs_deferred_total', {
        reason: 'REDEMPTION_UNCONFIRMED',
      }),
    ).toBe(1);
  });

  // Break caught (G2-03): a worker that cannot open the queue's payloads claiming the next job at once, and the next, as fast as the
  // database answers: it would spin on a queue it can do nothing with. Each deferral in a row doubles the wait before the next claim.
  it('goes slower for each claim in a row that it cannot open', async () => {
    const skewed = (n: number): UnreadableClaimError =>
      new UnreadableClaimError(
        {
          job: { id: `job-skew-${String(n)}`, providerDedupeId: DEDUPE },
          leaseVersion: 1,
          attempt: 1,
          deferrals: 0,
          kind: 'SETUP_GRANT',
          channel: 'EMAIL',
        },
        'NOT_HELD',
      );
    const r = rig([1, 2, 3, 4, 5, 6, 7, 8].map(skewed), { pollIntervalMs: 100 });

    r.worker.start();
    await new Promise((resolve) => setTimeout(resolve, 350));
    await r.worker.stop(1_000);

    // claims at about 0, 200 and 600 ms: not the eight that a worker with no slowing would have made in the first moments
    expect(r.queue.recorded.length).toBeGreaterThanOrEqual(1);
    expect(r.queue.recorded.length).toBeLessThanOrEqual(3);
  });

  // Break caught (G2-03): the slowing outliving the cause: one job that was sent after a deferral leaving the worker slow for good.
  it('goes back to claiming at once after a job it could send', async () => {
    const stamps = new Map<string, number>();
    const r = rig(
      [
        new UnreadableClaimError(
          {
            job: { id: 'job-skew', providerDedupeId: DEDUPE },
            leaseVersion: 1,
            attempt: 1,
            deferrals: 0,
            kind: 'SETUP_GRANT',
            channel: 'EMAIL',
          },
          'NOT_HELD',
        ),
        claimed({ job: { id: 'job-ok-1', providerDedupeId: `${DEDUPE}-1` } }),
        claimed({ job: { id: 'job-ok-2', providerDedupeId: `${DEDUPE}-2` } }),
      ],
      { pollIntervalMs: 100 },
    );
    r.queue.recordDelayMs = (leased) => {
      stamps.set(leased.job.id, Date.now());
      return 0;
    };

    r.worker.start();
    await until(() => r.queue.recorded.length === 3, 4_000);
    await r.worker.stop(1_000);

    // the second send follows the first at once; had the slowing stayed, it would have waited the doubled wait (200 ms)
    const gap = (stamps.get('job-ok-2') ?? 0) - (stamps.get('job-ok-1') ?? 0);
    expect(gap).toBeLessThan(100);
  });

  // Break caught (G2-03): a worker with no reader to confirm a record claiming messages it can only give back: each claim would count
  // against the message and none could be sent. With consumption off it claims nothing, and still runs what runs on a schedule.
  it('claims nothing when consumption is off, and still runs its periodic tasks', async () => {
    let ran = 0;
    const r = rig([claimed()], {
      consume: false,
      pollIntervalMs: 20,
      periodic: [
        {
          name: 'probe',
          intervalMs: 20,
          budgetMs: 1_000,
          run: () => {
            ran += 1;
            return Promise.resolve();
          },
        },
      ],
    });

    r.worker.start();
    await until(() => ran >= 2);
    await r.worker.stop(1_000);

    expect(r.queue.calls).toEqual([]);
    expect(r.provider.sent).toEqual([]);
  });

  // Break caught: a fenced-out worker (its lease was taken over, or the job was cancelled) crashing, retrying its write, or reporting
  // success: it writes nothing, says so once, and goes on.
  it('treats a lost lease as the end of its work on the job, and logs it', async () => {
    const r = rig();
    r.queue.recordFailure = new LeaseLostError();

    await expect(r.worker.runOnce()).resolves.toBe(true);

    expect(r.lines.filter((line) => line.msg === 'delivery lease lost')).toHaveLength(1);
    expect(r.queue.calls.filter((call) => call.startsWith('record:'))).toHaveLength(1);
  });

  // Break caught: a failed write of the outcome (the database went away) crashing the lane, or leaking text of the error.
  it('logs a failed write of the outcome without its text, and carries on', async () => {
    const r = rig();
    r.queue.recordFailure = new Error(`insert failed for ${DESTINATION} with ${TOKEN}`);

    await expect(r.worker.runOnce()).resolves.toBe(true);

    const line = r.lines.find((entry) => entry.msg === 'delivery outcome not recorded');
    expect(line).toMatchObject({ level: 'error', job_id: 'job-0001', error_type: 'Error' });
    expect(r.text()).not.toContain(TOKEN);
    expect(r.text()).not.toContain(DESTINATION);
  });

  // Break caught: the whole log of a delivery containing the destination or the link, on the success path or any other.
  it('writes no destination, no link and no token to the log on any path', async () => {
    const paths: (() => Rig)[] = [
      () => rig(),
      () => {
        const r = rig();
        r.reader.answer = () => Promise.resolve('CLOSED');
        return r;
      },
      () => {
        const r = rig([claimed({ attempt: 2 })]);
        r.provider.answer = () => Promise.reject(new Error(`${DESTINATION} ${LINK}`));
        r.provider.statusAnswer = () => Promise.reject(new Error(`${DESTINATION} ${LINK}`));
        return r;
      },
      () => {
        const r = rig();
        r.queue.endOf = () => ({ state: 'FAILED', outcomeClass: 'SCHEDULE_EXHAUSTED' });
        r.provider.answer = () => Promise.resolve({ outcome: 'UNKNOWN' });
        return r;
      },
    ];

    for (const build of paths) {
      const r = build();
      await r.worker.runOnce();
      for (const secret of [TOKEN, DESTINATION, LINK, '/setup/credential']) {
        expect(r.text()).not.toContain(secret);
      }
      expect(r.text()).toContain('job-0001');
    }
  });

  // Break caught: a claim that fails (the database is unavailable) escaping from runOnce unhandled is the lane's to handle; it must be
  // an error the caller sees, not a swallowed one that looks like "nothing due".
  it('lets a failed claim reach the caller, so that the lane can back off', async () => {
    const r = rig();
    r.queue.claimFailure = new Error('the database is unavailable');

    await expect(r.worker.runOnce()).rejects.toThrow('unavailable');
  });
});

// G2-02. A provider's promise can settle after the call's own monotonic deadline but before the timer callback that would have
// noticed. The clock below is moved by hand, so the deadline passes without any timer firing: the result must not be taken as timely.
describe('a provider that answers after the call’s own deadline, before any timer has noticed (G2-02)', () => {
  const TIMEOUT = 10;

  /** A worker on a clock the test moves, with a provider (and a reader) whose answers the test releases when it chooses. */
  function held(over: Partial<DeliveryWorkerOptions> = {}, job: ClaimedDelivery = claimed()) {
    const clock = new ManualClock();
    const r = rig([job], {
      clock,
      providerTimeoutMs: { EMAIL: TIMEOUT, SMS: TIMEOUT },
      jobBudgetMs: 25_000,
      ...over,
    });
    let settle: (answer: Promise<DeliveryOutcome>) => void = () => undefined;
    r.provider.answer = () =>
      new Promise<DeliveryOutcome>((resolve, reject) => {
        settle = (answer) => {
          answer.then(resolve, reject);
        };
      });
    return {
      clock,
      r,
      settle: (answer: Promise<DeliveryOutcome>) => {
        settle(answer);
      },
    };
  }

  const accepted = (ref = 'late-ref'): Promise<DeliveryOutcome> =>
    Promise.resolve({ outcome: 'ACCEPTED', providerMessageRef: ref });

  const attempts = (r: Rig, result: string): number =>
    counter(r.metrics, 'credential_delivery_attempts_total', { channel: 'EMAIL', result });

  // Break caught: the race accepting an answer that arrived after the deadline because the timer had not run yet, and the budget being
  // finished so that the deadline could never be seen. Here the clock moves past 10 ms with no timer callback, then the provider answers.
  it('does not take an acceptance that arrives after the call’s deadline as a timely answer', async () => {
    const { clock, r, settle } = held();
    const working = r.worker.runOnce();
    await until(() => r.provider.sent.length === 1);

    clock.advance(TIMEOUT + 1);
    settle(accepted());
    await working;

    expect(r.queue.recorded.map((entry) => entry.outcome)).toEqual([{ outcome: 'UNKNOWN' }]);
    expect(attempts(r, 'UNKNOWN')).toBe(1);
    expect(attempts(r, 'ACCEPTED')).toBe(0);
    expect(r.text()).not.toContain('late-ref');
  });

  // Break caught: a timely answer refused, or the boundary drawn on the wrong side. The deadline is the instant the budget names: one
  // tick before it the answer is timely, and at it the call is late.
  it.each([
    [0, 'ACCEPTED'],
    [TIMEOUT - 0.001, 'ACCEPTED'],
    [TIMEOUT, 'UNKNOWN'],
    [TIMEOUT + 0.001, 'UNKNOWN'],
  ] as const)(
    'with the clock %f ms past the start, records the answer as %s',
    async (moved, expected) => {
      const { clock, r, settle } = held();
      const working = r.worker.runOnce();
      await until(() => r.provider.sent.length === 1);

      clock.advance(moved);
      settle(accepted());
      await working;

      expect(r.queue.recorded.map((entry) => entry.outcome.outcome)).toEqual([expected]);
      expect(attempts(r, expected)).toBe(1);
      expect(attempts(r, expected === 'ACCEPTED' ? 'UNKNOWN' : 'ACCEPTED')).toBe(0);
    },
  );

  // Break caught: a rejection after the deadline taken for the provider's refusal (a terminal failure), or left unhandled.
  it('records a rejection that arrives after the deadline as unknown, and a refusal that arrives in time as a refusal', async () => {
    for (const [moved, expected] of [
      [TIMEOUT + 5, 'UNKNOWN'],
      [0, 'REJECTED'],
    ] as const) {
      const { clock, r, settle } = held();
      const working = r.worker.runOnce();
      await until(() => r.provider.sent.length === 1);

      clock.advance(moved);
      settle(Promise.resolve({ outcome: 'REJECTED', outcomeClass: 'REJECTED' }));
      await working;

      expect(r.queue.recorded.map((entry) => entry.outcome.outcome)).toEqual([expected]);
    }
  });

  // Break caught: a provider that throws after the deadline counted as a failure of the call, or surfacing as an unhandled rejection.
  it('handles a failure that arrives after the deadline without an unhandled rejection, and counts it once', async () => {
    const { clock, r, settle } = held();
    const working = r.worker.runOnce();
    await until(() => r.provider.sent.length === 1);

    clock.advance(TIMEOUT + 1);
    settle(Promise.reject(new Error(`late ${DESTINATION} ${TOKEN}`)));
    await working;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(r.queue.recorded.map((entry) => entry.outcome)).toEqual([{ outcome: 'UNKNOWN' }]);
    expect(attempts(r, 'UNKNOWN')).toBe(1);
    expect(r.text()).not.toContain(TOKEN);
    expect(r.text()).not.toContain(DESTINATION);
  });

  // Break caught: a status answer that came after the status call's deadline recorded as an authoritative acceptance, so that the message
  // is never sent: it is not a timely answer, and the worker goes on to the send.
  it('does not take a status answer that arrives after its deadline as authoritative', async () => {
    const { clock, r } = held({}, claimed({ attempt: 2 }));
    let answerStatus: (answer: DeliveryOutcome | null) => void = () => undefined;
    r.provider.statusAnswer = () =>
      new Promise<DeliveryOutcome | null>((resolve) => {
        answerStatus = resolve;
      });
    r.provider.answer = () => accepted('sent-after-status');
    const working = r.worker.runOnce();
    await until(() => r.provider.statusAsked.length === 1);

    clock.advance(TIMEOUT + 1);
    answerStatus({ outcome: 'ACCEPTED', providerMessageRef: 'late-status' });
    await working;

    expect(r.provider.sent).toHaveLength(1);
    expect(r.queue.recorded.map((entry) => entry.outcome)).toEqual([
      { outcome: 'ACCEPTED', providerMessageRef: 'sent-after-status' },
    ]);
  });

  // Break caught: a read of the redemption record that came after the job's time taken for a clear answer, so that a message is sent for
  // a record nobody could confirm in time.
  it('does not take a read of the record that arrives after the job’s time as a confirmation', async () => {
    const { clock, r } = held({ jobBudgetMs: 50 });
    let answerRead: (standing: RedemptionStanding) => void = () => undefined;
    r.reader.answer = () =>
      new Promise<RedemptionStanding>((resolve) => {
        answerRead = resolve;
      });
    const working = r.worker.runOnce();
    await until(() => r.reader.asked.length === 1);

    clock.advance(60);
    answerRead('PENDING');
    await working;

    expect(r.provider.sent).toEqual([]);
    expect(r.queue.recorded.map((entry) => entry.outcome)).toEqual([
      { outcome: 'REDEMPTION_UNCONFIRMED' },
    ]);
  });

  // Break caught: a shutdown that waits for the call it gave up on, or one whose late answer is counted or recorded.
  it('lets go of an outstanding call at the stop, and counts and records nothing of its late answer', async () => {
    const { r, settle } = held({}, claimed());
    r.worker.start();
    await until(() => r.provider.sent.length === 1);

    const report = await r.worker.stop(300);
    settle(accepted('after-the-stop'));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(report).toEqual({ drained: 0, relinquished: 1, unconfirmed: 0 });
    expect(r.queue.recorded.map((entry) => entry.outcome)).toEqual([{ outcome: 'RELINQUISHED' }]);
    // The send was made and its answer is not known: one attempt, counted once as unknown. The answer that comes after the stop is
    // neither counted as accepted nor recorded.
    expect(attempts(r, 'UNKNOWN')).toBe(1);
    expect(attempts(r, 'ACCEPTED')).toBe(0);
    expect(r.text()).not.toContain('after-the-stop');
  });
});

describe('the delivery worker and the end of the schedule (S0.18)', () => {
  // The schedule is the document's: six attempts (BACKGROUND_JOBS_AND_EVENTS.md §3.2), then a terminal failure. A takeover after a crash
  // and a lease given back at a stop count as attempts too, so they must not lead to a seventh send.
  it('sends on the last attempt the schedule allows', async () => {
    const r = rig([claimed({ attempt: 6 })]);

    await r.worker.runOnce();

    expect(r.provider.sent).toHaveLength(1);
  });

  // Break caught: a seventh send after a crash or a lease given back at the sixth attempt, once for each lease that ends, until the
  // credential expires.
  it('sends nothing after the last attempt, whether the lease was taken over or given back, and ends the job', async () => {
    for (const reclaimed of [true, false]) {
      const r = rig([claimed({ attempt: 7, reclaimed })]);

      await r.worker.runOnce();

      expect(r.provider.sent).toEqual([]);
      expect(r.queue.recorded.map((entry) => entry.outcome)).toEqual([
        { outcome: 'SCHEDULE_EXHAUSTED' },
      ]);
      expect(
        counter(r.metrics, 'credential_delivery_jobs_failed_total', {
          outcome: 'SCHEDULE_EXHAUSTED',
        }),
      ).toBe(1);
    }
  });

  // Break caught: a message the provider already holds being reported as a failure because the schedule ran out: the provider is asked
  // once more, and what it accepted is recorded as accepted.
  it('asks the provider once more after the last attempt and records an acceptance it reports, without sending', async () => {
    const r = rig([claimed({ attempt: 7, reclaimed: true })]);
    r.provider.statusAnswer = () =>
      Promise.resolve({ outcome: 'ACCEPTED', providerMessageRef: 'held-7' });

    await r.worker.runOnce();

    expect(r.provider.statusAsked).toEqual([DEDUPE]);
    expect(r.provider.sent).toEqual([]);
    expect(r.queue.recorded.map((entry) => entry.outcome)).toEqual([
      { outcome: 'ACCEPTED', providerMessageRef: 'held-7' },
    ]);
  });

  // Break caught: a closed record being sent for, or counted as a failure of the schedule, because the attempts ran out first.
  it('ends a job taken over after the last attempt as closed when its record has closed', async () => {
    const r = rig([claimed({ attempt: 7, reclaimed: true })]);
    r.reader.answer = () => Promise.resolve('CLOSED');

    await r.worker.runOnce();

    expect(r.provider.sent).toEqual([]);
    expect(r.queue.recorded.map((entry) => entry.outcome)).toEqual([
      { outcome: 'REDEMPTION_CLOSED' },
    ]);
  });
});

describe('the delivery worker’s lanes and its shutdown (S0.18)', () => {
  // Break caught: more jobs in flight than the worker was told to allow (a connection each, and the provider hit harder than asked).
  it('has no more jobs in flight than its concurrency, and works through all that are due', async () => {
    const jobs = Array.from({ length: 9 }, (_, index) =>
      claimed({
        job: { id: `job-${String(index)}`, providerDedupeId: `${DEDUPE}-${String(index)}` },
      }),
    );
    const r = rig(jobs, { concurrency: 3, pollIntervalMs: 100 });
    let inFlight = 0;
    let peak = 0;
    r.provider.answer = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await later(40, undefined);
      inFlight -= 1;
      return { outcome: 'ACCEPTED', providerMessageRef: 'r' };
    };

    r.worker.start();
    await until(() => r.queue.recorded.length === 9);
    const report = await r.worker.stop(2_000);

    expect(peak).toBe(3);
    expect(report).toMatchObject({ relinquished: 0, unconfirmed: 0 });
  });

  // Break caught: an idle lane that never looks again (a link queued after the worker started is never sent) or that spins.
  it('polls again after the interval and sends a job queued later', async () => {
    const r = rig([], { pollIntervalMs: 100 });
    r.worker.start();
    await until(() => r.queue.calls.length >= 2);
    const idleCalls = r.queue.calls.length;

    r.queue.add(claimed());
    await until(() => r.queue.recorded.length === 1);
    await r.worker.stop(1_000);

    expect(idleCalls).toBeLessThan(10);
    expect(r.provider.sent).toHaveLength(1);
  });

  // Break caught: a database that is down killing the worker, or being hammered at the poll interval, or its error text in the log.
  it('logs a failing claim without its text, backs off, and recovers when the database does', async () => {
    const r = rig([], { pollIntervalMs: 100 });
    r.queue.claimFailure = new Error(`connection to ${DESTINATION} refused ${TOKEN}`);
    r.worker.start();
    await until(() => r.lines.some((line) => line.msg === 'delivery claim failed'));

    r.queue.claimFailure = undefined;
    r.queue.add(claimed());
    await until(() => r.queue.recorded.length === 1, 6_000);
    await r.worker.stop(1_000);

    const failures = r.lines.filter((line) => line.msg === 'delivery claim failed');
    expect(failures.length).toBeGreaterThanOrEqual(1);
    expect(failures[0]).toMatchObject({ error_type: 'Error' });
    expect(r.text()).not.toContain(TOKEN);
  });

  // Break caught: a stop that claims one more job, or that cuts a send in flight short instead of letting it finish.
  it('stops claiming, lets the job in flight finish, and reports that it drained', async () => {
    const r = rig([claimed(), claimed({ job: { id: 'job-2', providerDedupeId: `${DEDUPE}-2` } })], {
      pollIntervalMs: 100,
    });
    r.provider.answer = () => later(150, { outcome: 'ACCEPTED', providerMessageRef: 'r' });
    r.worker.start();
    await until(() => r.provider.sent.length === 1);

    const report = await r.worker.stop(2_000);

    expect(r.provider.sent).toHaveLength(1);
    expect(r.queue.recorded.map((entry) => entry.outcome.outcome)).toEqual(['ACCEPTED']);
    expect(r.queue.calls.filter((call) => call === 'claim')).toHaveLength(1);
    expect(report).toEqual({ drained: 1, relinquished: 0, unconfirmed: 0 });
    expect(r.worker.inFlight).toBe(0);
  });

  // Break caught: a stop that waits for a stalled provider for ever (the process would be killed with its leases held), or that
  // leaves the lease to expire when it could give it back.
  it('gives back a lease that is still held when the shutdown budget runs out, and returns within the budget', async () => {
    const r = rig([claimed()], { providerTimeoutMs: { EMAIL: 30_000, SMS: 30_000 } });
    r.provider.answer = () => never<DeliveryOutcome>();
    r.worker.start();
    await until(() => r.provider.sent.length === 1);
    const started = Date.now();

    const report = await r.worker.stop(1_200);

    expect(Date.now() - started).toBeLessThan(1_200 + 500);
    expect(report).toEqual({ drained: 0, relinquished: 1, unconfirmed: 0 });
    expect(r.queue.recorded.map((entry) => entry.outcome)).toEqual([{ outcome: 'RELINQUISHED' }]);
  });

  // Break caught: a lease that cannot be given back (the database is gone) reported as given back.
  it('reports a lease it could not give back as unconfirmed', async () => {
    const r = rig([claimed()], { providerTimeoutMs: { EMAIL: 30_000, SMS: 30_000 } });
    r.provider.answer = () => never<DeliveryOutcome>();
    r.worker.start();
    await until(() => r.provider.sent.length === 1);
    r.queue.recordFailure = new Error('the database is gone');

    const report = await r.worker.stop(1_200);

    expect(report).toEqual({ drained: 0, relinquished: 0, unconfirmed: 1 });
  });

  // Break caught: a second stop starting another shutdown, or answering differently.
  it('answers a second stop with the first’s report', async () => {
    const r = rig([]);
    r.worker.start();

    const first = r.worker.stop(1_000);
    const second = r.worker.stop(1_000);

    expect(await second).toEqual(await first);
  });

  // Break caught: a lane abandoned at the shutdown going on to send for a lease it has given back: the status query answers after the
  // stop, and the lane would send on, from a process that has already reported that it stopped.
  it('sends nothing for a lease it has given back: what answers after the stop is the end of that job', async () => {
    const r = rig([claimed({ attempt: 2 })], {
      providerTimeoutMs: { EMAIL: 30_000, SMS: 30_000 },
    });
    r.provider.statusAnswer = () => later(500, null);
    r.worker.start();
    await until(() => r.provider.statusAsked.length === 1);

    const report = await r.worker.stop(200);
    await new Promise((resolve) => setTimeout(resolve, 700));

    expect(report).toEqual({ drained: 0, relinquished: 1, unconfirmed: 0 });
    // Nothing is started after the stop, not even the read of the record that would come next.
    expect(r.reader.asked).toEqual([]);
    expect(r.provider.sent).toEqual([]);
    expect(r.queue.recorded.map((entry) => entry.outcome)).toEqual([{ outcome: 'RELINQUISHED' }]);
  });

  // Break caught: a lane that has been given up on still waiting on a call that will not answer (here for half a minute), holding its
  // place in flight and the process with it, when the worker has already said that it stopped.
  it('lets go of the call a lane was waiting on once the lane has been given up on', async () => {
    const r = rig([claimed()], { providerTimeoutMs: { EMAIL: 30_000, SMS: 30_000 } });
    r.provider.answer = () => never<DeliveryOutcome>();
    r.worker.start();
    await until(() => r.provider.sent.length === 1);

    await r.worker.stop(400);

    await until(() => r.worker.inFlight === 0, 500);
    expect(r.worker.inFlight).toBe(0);
  });

  // Break caught: a lease that was no longer the worker's (another worker had taken the job over) reported as one it could not give
  // back: there was nothing to give back, and the job is in good hands.
  it('counts a lease it no longer held as drained, not as unconfirmed', async () => {
    const r = rig([claimed()], { providerTimeoutMs: { EMAIL: 30_000, SMS: 30_000 } });
    r.provider.answer = () => never<DeliveryOutcome>();
    r.worker.start();
    await until(() => r.provider.sent.length === 1);
    r.queue.recordFailure = new LeaseLostError();

    const report = await r.worker.stop(1_200);

    expect(report).toEqual({ drained: 1, relinquished: 0, unconfirmed: 0 });
  });

  // Break caught: a claim that returns after the stop, for a payload that would not open, recording an end for the job from a process
  // that has said that it stopped (the pool may be closed; nothing is written in the worker's name after the stop).
  it('writes nothing for a claim that comes back after the stop with a payload that would not open', async () => {
    const leased: LeasedJob = {
      job: { id: 'job-late', providerDedupeId: DEDUPE },
      leaseVersion: 1,
      attempt: 1,
      deferrals: 0,
      kind: 'SETUP_GRANT',
      channel: 'EMAIL',
    };
    const r = rig([new UnreadableClaimError(leased)]);
    r.queue.claimDelayMs = 400;
    r.worker.start();
    await until(() => r.queue.calls.includes('claim'));

    await r.worker.stop(100);
    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(r.queue.recorded).toEqual([]);
  });

  // Break caught: every lease reported as unconfirmed because one could not be given back in time, or the reverse.
  it('reports the leases it gave back and the ones it could not confirm, each for what it is', async () => {
    const jobs = ['a', 'b'].map((name) =>
      claimed({ job: { id: `job-${name}`, providerDedupeId: `${DEDUPE}-${name}` } }),
    );
    const r = rig(jobs, {
      concurrency: 2,
      providerTimeoutMs: { EMAIL: 30_000, SMS: 30_000 },
    });
    r.provider.answer = () => never<DeliveryOutcome>();
    r.queue.recordDelayMs = (leased, outcome) =>
      outcome.outcome === 'RELINQUISHED' && leased.job.id === 'job-b' ? 3_000 : 0;
    r.worker.start();
    await until(() => r.provider.sent.length === 2);

    const report = await r.worker.stop(1_200);

    expect(report).toEqual({ drained: 0, relinquished: 1, unconfirmed: 1 });
  });

  // Break caught: a job abandoned at the shutdown still recording an outcome later, when the pool is closed and the process ending.
  it('records nothing for an abandoned job once it has stopped', async () => {
    const r = rig([claimed()], { providerTimeoutMs: { EMAIL: 5_000, SMS: 5_000 } });
    r.provider.answer = () =>
      later(900, { outcome: 'ACCEPTED', providerMessageRef: 'after-the-stop' });
    r.worker.start();
    await until(() => r.provider.sent.length === 1);

    const report = await r.worker.stop(1_100);
    const calls = [...r.queue.calls];
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    expect(report).toEqual({ drained: 0, relinquished: 1, unconfirmed: 0 });
    expect(r.queue.calls).toEqual(calls);
    expect(r.queue.recorded.map((entry) => entry.outcome)).toEqual([{ outcome: 'RELINQUISHED' }]);
  });

  // Break caught: a periodic task (the retention cleanup) that does not run, stops the lanes when it fails, or runs after the stop.
  it('runs periodic tasks on their interval, survives a task that fails, and stops them with the lanes', async () => {
    let runs = 0;
    let failures = 0;
    const tasks: PeriodicTask[] = [
      {
        name: 'cleanup',
        intervalMs: 100,
        budgetMs: 1_000,
        run: () => {
          runs += 1;
          return Promise.resolve();
        },
      },
      {
        name: 'failing',
        intervalMs: 100,
        budgetMs: 1_000,
        run: () => {
          failures += 1;
          return Promise.reject(new Error(`task failed ${TOKEN}`));
        },
      },
    ];
    const r = rig([], { periodic: tasks });

    r.worker.start();
    await until(() => runs >= 3 && failures >= 2);
    await r.worker.stop(1_000);
    const seen = { runs, failures };
    await new Promise((resolve) => setTimeout(resolve, 350));

    expect({ runs, failures }).toEqual(seen);
    expect(
      r.lines.some(
        (line) => line.msg === 'delivery periodic task failed' && line.task === 'failing',
      ),
    ).toBe(true);
    expect(r.text()).not.toContain(TOKEN);
  });

  // Break caught: a periodic task that runs under no budget (its transactions bounded by the server's limits alone, and nothing to
  // cancel at a stop), or that is not told when the worker stops.
  it('runs a periodic task under a budget of its own and tells it to stop when the worker does', async () => {
    const seen: { budget: ExecutionBudget | undefined; signal: AbortSignal }[] = [];
    const task: PeriodicTask = {
      name: 'cleanup',
      intervalMs: 50,
      budgetMs: 4_000,
      run: async (signal) => {
        seen.push({ budget: currentBudget(), signal });
        await later(10, undefined);
      },
    };
    const r = rig([], { periodic: [task] });

    r.worker.start();
    await until(() => seen.length >= 1);
    expect(seen[0]?.budget?.label).toBe('delivery-cleanup');
    expect(seen[0]?.budget?.budgetMilliseconds).toBe(4_000);
    expect(seen[0]?.signal.aborted).toBe(false);
    await r.worker.stop(1_000);

    expect(seen[0]?.signal.aborted).toBe(true);
  });

  // Break caught: a lane that waits on a failing database for more than the cap, or for less than the doubling the poll interval allows.
  it('doubles the wait of a lane that cannot claim, up to a cap', () => {
    expect(laneBackoffMs(1, 100)).toBe(200);
    expect(laneBackoffMs(3, 100)).toBe(800);
    expect(laneBackoffMs(8, 100)).toBe(25_600);
    // the doubling stops at eight failures, and the cap is the longest a lane ever waits
    expect(laneBackoffMs(20, 100)).toBe(25_600);
    expect(laneBackoffMs(2, 20_000)).toBe(MAX_BACKOFF_MS);
    expect(MAX_BACKOFF_MS).toBe(30_000);
  });

  // Break caught: a worker named in a way the table refuses, or a name that is the same for two processes on one host.
  it('starts only once, and says who it is', async () => {
    const r = rig([]);

    r.worker.start();
    expect(() => {
      r.worker.start();
    }).toThrow();
    await r.worker.stop(1_000);

    expect(r.lines.find((line) => line.msg === 'delivery worker started')).toMatchObject({
      worker_id: 'dw-test',
      concurrency: 1,
    });
  });
});
