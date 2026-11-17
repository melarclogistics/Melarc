import { isDefiniteRefusal, OperationFailure } from '../api/api-response';
import type { ApiClient } from '../api/api-client';
import { createBoundedQueue, type BoundedQueue } from '../api/bounded-queue';
import { failureOf, newIdempotencyKey } from '../api/idempotency';
import type { ReadHold } from '../query/read-hold';
import { completeEvidence, declareEvidence, type IntakeEvidencePurpose } from './evidence-commands';
import { refusalOfFile, type EvidenceLimitsView, type LimitRefusal } from './evidence-limits';
import { sha256Hex } from './file-checksum';
import { ObjectStoreError, putBytes } from './object-store-upload';

/**
 * One file of evidence, from the file the person chose to a record the platform has stored: its checksum is computed, the record is declared, the bytes are sent to the address the platform issued, and
 * the upload is completed (`completeEvidenceUpload`), which the server answers only for bytes it finds as declared. **The address of the upload is a local of one call**: it lives from the answer of the
 * declaration to the end of the `PUT`, and nothing else holds it (a retry declares again, and the platform says the same record and a new address). `steps` tells a screen where the file is, in words
 * it chooses; it is told nothing of the address.
 *
 * **Retry is safe, and does not make a second record.** The declaration takes an `Idempotency-Key`, and the file keeps its key, and **the moment it was made** (`captured_at`, worked out once and sent
 * unchanged, so that the same key never meets a different body), until the file is stored or the platform has answered it for good. **Only an authoritative answer ends an attempt whose outcome is not known**
 * (the rule of every command, `platform/api/idempotency.ts`): an attempt that got no answer leaves the file *unresolved*, and a later refusal (a limit of rate, a refused permission, a request the
 * browser did not send) does not say that the earlier declaration did not commit, so it does not release the key; the first attempt of a file that is refused is finished, and any later one is new.
 *
 * **What the retry is told is acted on, and never looped on** (the review of Run B and the UX audit of Stage 6, and the review of 17 November 2026): a record that is **already stored** (the answer to its
 * completion was lost) is the file's success; a record whose **upload address has run out**, by the **server's** clock and not the device's (the `Date` of the answer that carries the moment: a device clock
 * that is minutes out made every address look run out, or none), or that the platform says expired, or that **the store refused as run out** (a `403` of the `PUT`), is asked for again **once**, as a new record
 * under a new key, and told if the fresh one has run out too; and **a file that the platform's limits would refuse is refused before it is read whole** (the checksum reads every byte), when the limits are
 * known. **Every step has its time** (`UPLOAD_BUDGETS`): a step that gets no answer is told as the timeout of that step, never retried by itself.
 *
 * **A file is on its way once.** A second call for a file that is already on its way is the same journey and answers with it, so that a double press makes no second declaration. **At most
 * `UPLOAD_CONCURRENCY` files are on their way at once** (the rest wait for their turn, in the order they were chosen): each of them reads its whole file into memory and makes two calls of a session
 * that has a limit a minute, and a hundred photos chosen from a gallery at once spent it in seconds. A `429` holds the files that have not begun for the wait the API asked for (as the page's automatic
 * reads are held, `surfaces/ops-portal.md` section 8) and **retries nothing by itself**: the file that was refused says so, in the one words for it, and is sent again by the person.
 */
export type UploadStep = 'waiting' | 'hashing' | 'declaring' | 'sending' | 'confirming';

export type EvidenceUploader = (
  file: File,
  steps?: (step: UploadStep) => void,
  signal?: AbortSignal,
) => Promise<string>;

/** The time a step may take, in milliseconds: provisional values (the platform sets none), held in one place. The bytes have a budget of their own that grows with the file. */
export const UPLOAD_BUDGETS = {
  /** The declaration: a short call to the platform. */
  declareMs: 20_000,
  /** The completion: the platform reads the object back and scans it, so it is allowed as long as the declaration. */
  confirmMs: 20_000,
  /** The least the bytes are given, however small the file. */
  sendMinMs: 30_000,
  /** The slowest link the budget still counts on: a file is given `size / sendBytesPerSecond` seconds, at least `sendMinMs`. */
  sendBytesPerSecond: 64 * 1024,
  /** The most the bytes are ever given, however large the file claims to be. */
  sendMaxMs: 300_000,
} as const;

/**
 * How many files are on their way at once. Provisional, like the budgets: three is what a tablet's memory (each file is read whole to be checksummed, up to the platform's size limit) and the session's limit
 * of calls a minute (each file is two calls) can carry. It is a limit on **how many at a time**, never on how many files a record may have.
 */
export const UPLOAD_CONCURRENCY = 3;

/** An address with less than this left is as good as run out: the bytes would reach the store after it had stopped taking them. */
const ADDRESS_MARGIN_MS = 10_000;

/** What the uploader needs beyond its owner and purpose. */
export interface UploaderOptions {
  /** The platform's limits (`getEvidenceLimits`), where they were read: a file they refuse is refused before it is read whole. Left out when the read failed, and then nothing is judged here. */
  readonly limits?: EvidenceLimitsView | undefined;
  /** The queue that paces the files. Left out, the portal's one queue of uploads (`UPLOAD_CONCURRENCY`) is used; a test gives its own. */
  readonly queue?: BoundedQueue | undefined;
  /**
   * The page's hold (`platform/query/read-hold.ts`, which the session boundary starts on every `429` of the session): the files that have not begun wait for it to end, and a `429` this uploader sees is
   * told to it. Left out, nothing is held (a tool, a test).
   */
  readonly hold?: UploadHold | undefined;
}

/** What the uploader needs of the page's hold: whether it is on, a way to start or lengthen it, and a wait that ends with it. */
export type UploadHold = Pick<ReadHold, 'held' | 'hold' | 'untilFree'>;

const uploadQueue = createBoundedQueue(UPLOAD_CONCURRENCY);

/** A file the platform's limits refuse, told before anything is read or sent: its type is not one the platform takes, or it is larger than the largest file. */
export class EvidenceRefusedError extends Error {
  override name = 'EvidenceRefusedError';
  readonly kind: LimitRefusal['kind'];
  /** The file's size, for a file that is too large. */
  readonly size: number | undefined;
  /** The largest size, for a file that is too large. */
  readonly limit: number | undefined;
  /** The file's type, for one the platform does not take. */
  readonly type: string | undefined;

  constructor(refusal: LimitRefusal) {
    super('The file is not one the platform takes.');
    this.kind = refusal.kind;
    this.size = refusal.kind === 'too_large' ? refusal.size : undefined;
    this.limit = refusal.kind === 'too_large' ? refusal.limit : undefined;
    this.type = refusal.kind === 'type_not_allowed' ? refusal.type : undefined;
  }
}

/** A step that got no answer in its time (`UPLOAD_BUDGETS`). The outcome is not known (the platform may have done it), so the file keeps its key and the retry is the person's. */
export class UploadTimeoutError extends Error {
  override name = 'UploadTimeoutError';
  readonly step: UploadStep;
  constructor(step: UploadStep) {
    super('A step of the upload did not finish in its time.');
    this.step = step;
  }
}

/** The platform made an upload address for the file twice and both had run out as they were read: the person is told, and the next attempt is theirs. */
export class UploadAddressExpiredError extends Error {
  override name = 'UploadAddressExpiredError';
  constructor() {
    super('The upload address of the file had run out.');
  }
}

/**
 * The moment a file was made, which the platform records as the capture time and refuses in the future (beyond a tolerance for a phone's clock): the file's own, and never later than now. **It is worked
 * out once for a file**, when its first attempt begins, and kept with the key: a file that has no moment of its own (a `lastModified` of nothing, or of a time that has not come) would otherwise be declared
 * with a different `captured_at` at each attempt, and the same key with another body is `IDEMPOTENCY_KEY_CONFLICT`.
 */
function capturedAt(file: File): string {
  const made =
    Number.isFinite(file.lastModified) && file.lastModified > 0 ? file.lastModified : Date.now();
  return new Date(Math.min(made, Date.now())).toISOString();
}

/** What a file keeps between its attempts: the key of its declaration, the moment it was made, and whether a declaration under the key was sent and never answered. */
interface Attempt {
  key: string;
  readonly capturedAt: string;
  unresolved: boolean;
}

/** The time the bytes of a file of this size are given. */
function sendBudgetMs(bytes: number): number {
  const wanted = Math.ceil((bytes / UPLOAD_BUDGETS.sendBytesPerSecond) * 1000);
  return Math.min(UPLOAD_BUDGETS.sendMaxMs, Math.max(UPLOAD_BUDGETS.sendMinMs, wanted));
}

/**
 * One step, in its time. The step is given a signal that is aborted when the person abandons the file (the caller's `parent`) or when the step's time runs out, and a step that ran out is the one
 * `UploadTimeoutError` whatever the abandoned request said (a request that is aborted fails in a way of its own). The timer is cleared however the step ends.
 */
async function within<Result>(
  step: UploadStep,
  budgetMs: number,
  parent: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<Result>,
): Promise<Result> {
  const own = new AbortController();
  const timer = setTimeout(() => {
    own.abort();
  }, budgetMs);
  const abandon = (): void => {
    own.abort();
  };
  if (parent?.aborted === true) own.abort();
  else parent?.addEventListener('abort', abandon, { once: true });
  try {
    return await run(own.signal);
  } catch (error) {
    // The step's own signal was aborted and the person did not abandon the file: its time ran out.
    if (own.signal.aborted && parent?.aborted !== true) throw new UploadTimeoutError(step);
    throw error;
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', abandon);
  }
}

/** The store's own word that the address ran out: the signed address of the `PUT` is refused with a `403` once its time has passed, whatever the device's clock said. */
function storeSaysAddressRanOut(error: unknown): boolean {
  return error instanceof ObjectStoreError && error.kind === 'refused' && error.status === 403;
}

/** Makes the uploader of one owner (an intake) and one purpose, which a screen calls once for each file the person adds. */
export function createEvidenceUploader(
  client: ApiClient,
  target: { readonly ownerId: string; readonly purpose: IntakeEvidencePurpose },
  options: UploaderOptions = {},
): EvidenceUploader {
  const queue = options.queue ?? uploadQueue;
  const hold = options.hold;
  const attempts = new WeakMap<File, Attempt>();
  const journeys = new WeakMap<File, Promise<string>>();

  /** The files that have not begun wait out a hold, in words ("waiting"), and the person can leave one out while it waits. */
  async function waitOutHold(
    steps: ((step: UploadStep) => void) | undefined,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    if (!hold?.held) return;
    steps?.('waiting');
    await hold.untilFree('evidence-upload', signal);
  }

  /** The declaration of a file under its key, with the bookkeeping of whether an earlier one is still in doubt. */
  async function declare(
    file: File,
    attempt: Attempt,
    checksum: string,
    signal: AbortSignal | undefined,
  ) {
    const wasUnresolved = attempt.unresolved;
    // Sent, and not yet answered: its outcome is not known until an answer comes.
    attempt.unresolved = true;
    try {
      const declared = await within('declaring', UPLOAD_BUDGETS.declareMs, signal, (step) =>
        declareEvidence(
          client,
          {
            ownerId: target.ownerId,
            purpose: target.purpose,
            capturedAt: attempt.capturedAt,
            contentType: file.type,
            byteSize: file.size,
            checksumSha256: checksum,
          },
          attempt.key,
          step,
        ),
      );
      attempt.unresolved = false;
      return declared;
    } catch (error) {
      // An answer that refused this attempt (or said to wait, or a request that never left) says nothing of an earlier one: the doubt stays as it was. Only no answer leaves this one in doubt.
      if (failureOf(error) !== 'unknown') attempt.unresolved = wasUnresolved;
      throw error;
    }
  }

  async function work(
    file: File,
    steps: ((step: UploadStep) => void) | undefined,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    await waitOutHold(steps, signal);
    signal?.throwIfAborted();
    steps?.('hashing');
    const checksum = await sha256Hex(file);
    signal?.throwIfAborted();
    const attempt = attempts.get(file) ?? {
      key: newIdempotencyKey(),
      capturedAt: capturedAt(file),
      unresolved: false,
    };
    attempts.set(file, attempt);
    // A fresh record is asked for once when the address of the one the platform answers with has run out; the second is judged as it comes.
    let renewals = 0;
    const renew = (): void => {
      renewals += 1;
      attempt.key = newIdempotencyKey();
      attempt.unresolved = false;
    };
    try {
      for (;;) {
        steps?.('declaring');
        const declared = await declare(file, attempt, checksum, signal);
        // The completion was done and its answer was lost: the retry is told the record as it is now, and that is the file's success.
        if (declared.state === 'STORED') {
          attempts.delete(file);
          return declared.evidenceId;
        }
        // The address is judged against the server's own clock where its answer gave one: the device's can be minutes out in either direction.
        const now = declared.state === 'PENDING_UPLOAD' ? (declared.serverTime ?? Date.now()) : 0;
        if (
          declared.state === 'EXPIRED' ||
          Date.parse(declared.ticket.upload.expires_at) - now <= ADDRESS_MARGIN_MS
        ) {
          if (renewals >= 1) throw new UploadAddressExpiredError();
          renew();
          continue;
        }
        steps?.('sending');
        try {
          await within('sending', sendBudgetMs(file.size), signal, (step) =>
            putBytes(declared.ticket.upload, file, step),
          );
        } catch (error) {
          // The store says the address ran out (what the clocks could not tell): a new record, once. A second refusal is the store's and is told as it is.
          if (renewals < 1 && storeSaysAddressRanOut(error)) {
            renew();
            continue;
          }
          throw error;
        }
        steps?.('confirming');
        const stored = await within('confirming', UPLOAD_BUDGETS.confirmMs, signal, (step) =>
          completeEvidence(client, declared.ticket.evidenceId, declared.version, step),
        );
        attempts.delete(file);
        return stored;
      }
    } catch (error) {
      // A request refused for being too fast holds the files that have not begun, for the wait it asked; nothing is retried by itself.
      if (error instanceof OperationFailure && error.status === 429) {
        hold?.hold(error.retryAfterSeconds);
      }
      // The platform's own answer about this request ends it, when no earlier attempt of the file is still in doubt: a later refusal never says that an earlier declaration did not commit.
      if (isDefiniteRefusal(error) && !attempt.unresolved) attempts.delete(file);
      throw error;
    }
  }

  function journey(
    file: File,
    steps: ((step: UploadStep) => void) | undefined,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    // What the platform would refuse is told before the file is read whole, and before anything is sent: a tablet is not made to hold a file in memory to be told it is too large.
    const limits = options.limits;
    const refusal = limits === undefined ? undefined : refusalOfFile(file, limits);
    if (refusal !== undefined) return Promise.reject(new EvidenceRefusedError(refusal));

    const place = { begun: false };
    const running = queue.run(() => {
      place.begun = true;
      return work(file, steps, signal);
    }, signal);
    // A free place begins the file at once; a file that is still here was not given one, and says it is waiting for its turn.
    if (!place.begun) steps?.('waiting');
    return running;
  }

  return (file, steps, signal) => {
    const flying = journeys.get(file);
    if (flying !== undefined) return flying;
    const started = journey(file, steps, signal).finally(() => {
      journeys.delete(file);
    });
    journeys.set(file, started);
    return started;
  };
}
