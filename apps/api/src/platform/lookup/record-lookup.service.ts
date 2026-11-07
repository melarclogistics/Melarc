import type { AuditWriter } from '../auth/ports/audit-writer.port.js';
import type { TransactionHandle } from '../auth/ports/unit-of-work.port.js';
import {
  authorizationForKey,
  type AuthorizedRequest,
} from '../authorization/authorized-request.js';
import type { OperationRunner } from '../authorization/operation-runner.js';
import {
  RECORD_LOOKUP_KINDS,
  type LookupHit,
  type RecordLookupKind,
  type RecordLookupSource,
} from '../domain-ports/record-lookup.port.js';
import { ApiException } from '../http/api-exception.js';
import { ErrorCode } from '../http/error-codes.js';
import { lookupQueryOf, maskedPhone } from './lookup-query.js';

/**
 * One result of the answer: a pointer to a record and the facts that say where it stands, and nothing else (`RecordLookupResult` of the
 * contract). **No route and no sentence** (the Product Owner's decision D1, 6 November 2026): the Ops Portal gives a kind and an id its page
 * and words its own line.
 */
export interface RecordLookupResultView {
  readonly kind: RecordLookupKind;
  readonly id: string;
  readonly code?: string;
  readonly title: string;
  readonly state?: string;
  readonly hub?: { readonly id: string; readonly display_name: string };
  readonly service_date?: string;
  /** A pickup request's sender name as its own read shows it; no other kind has one. */
  readonly sender_name?: string;
  readonly phone_hint?: string;
}

export interface RecordLookupView {
  readonly items: readonly RecordLookupResultView[];
}

export interface RecordLookupServiceOptions {
  readonly runner: Pick<OperationRunner, 'mutate'>;
  /** The source of every kind that has one, from the domains that own the records. */
  readonly sources: readonly RecordLookupSource[];
  readonly audit: Pick<AuditWriter, 'write'>;
  /** The actor's primary hub, the baseline of a crossing: `null` for a staff member with none (every hub they read is foreign). */
  readonly primaryHubOf: (handle: TransactionHandle, principalId: string) => Promise<string | null>;
  /** The names of hubs by id, read in the transaction that read the records they belong to (a hub the registry does not hold is absent). */
  readonly hubNamesOf: (
    handle: TransactionHandle,
    hubIds: readonly string[],
  ) => Promise<ReadonlyMap<string, string>>;
  /**
   * Bounds every statement that follows it in the transaction it is given (the searches, and the commit) to at most `milliseconds` (a `SET LOCAL
   * statement_timeout`, which ends with the transaction; the summary's own, `queue-summary/statement-limit.ts`), run before the first search of it.
   * Required, so that no composition can leave a search unbounded.
   */
  readonly limitStatements: (handle: TransactionHandle, milliseconds: number) => Promise<void>;
}

/** The most of one kind in an answer, and of all kinds together. */
export const LOOKUP_PER_KIND = 8;
export const LOOKUP_IN_ALL = 20;

/**
 * The longest a statement of a lookup may run (`AC-LOOKUP-15`, the Product Owner's decision of 7 November 2026 on the audit, A5; the summary's
 * counts have the same bound, `AC-QSUM-13`). A name search of the requests is a scan that no index can serve under row-level security, and it runs
 * while the transaction holds the shared lock of the session's bundle, so a search that runs long must end as a failed read, which the Ops Portal
 * draws as a failure with a way to try again, and not hold a connection and the lock for as long as the pool allows.
 */
export const RECORD_LOOKUP_STATEMENT_TIMEOUT_MS = 3000;

interface Taken {
  readonly kind: RecordLookupKind;
  readonly hit: LookupHit;
}

/**
 * `lookupRecords` (task C2; features/operations/global-lookup.md; data-scope-registry.md section 7.3): the records the calling session could
 * open that a code, a name or a phone number typed in full finds, from one request.
 *
 * - **A kind is searched only if the session holds the key of that kind's own read, and under the grant of that key.** The sources are grouped by
 *   key; each group runs in one transaction in the context of that key's grant (`authorizationForKey`: the scope the authorization step
 *   would give an operation that requires that key, never the widest grant the session holds). A kind whose key the session does not hold is
 *   not read and is absent from the answer, which tells nothing about the records. There is no permission of the lookup's own, and none is
 *   added.
 * - **The scope is the kind's own**: row-level security does it, as it does for the kind's list and read. The operation holds no predicate of its
 *   own on hubs, vendors or ownership, so a result cannot be a row the kind's list would not give the same session.
 * - **At most 8 results of a kind and 20 in all**, the kinds in their fixed order. Each source is asked for no more than the room that is left,
 *   and a kind for which none is left is not read for.
 * - **The hub crossings of the results are written as the lists write them** (audit.md section 5.4): one `auth.hub_boundary.crossed` for each hub
 *   other than the actor's own that the returned results represent, and none for a result the twenty left out (the work counts the room it has left
 *   before it names a hub). **They are written together, in one transaction of their own, after every search has succeeded** (the audit of 7 November
 *   2026, A4; `AC-LOOKUP-11`): a key's transaction reads the records and the hubs they represent and writes nothing, so that a lookup that fails
 *   later has recorded no crossing for a result it never returned, and a ledger that cannot take the events fails the read.
 * - **A source that fails fails the read** (`500`): the answer never says "nothing found" for a kind it could not read. A search that the database
 *   ended because it outlasted its bound (below) is the failure of that statement and is not caught here: the platform answers it as a failed read.
 * - **Every statement of a lookup is bounded at 3 seconds** (`RECORD_LOOKUP_STATEMENT_TIMEOUT_MS`, `AC-LOOKUP-15`), set at the start of each key's
 *   transaction, before its first search. And the request is counted in the session's bucket of API requests (`rate_limit_authenticated_api`) by the
 *   authentication step before this runs, as every operation of the session is: the lookup has no limiter of its own.
 * - **It is a POST that changes nothing** (the Product Owner's decision of 6 November 2026), **so each key's transaction runs through
 *   `OperationRunner.mutate`**: the runner treats every request of a method that is not safe as one that changes state, and the lock-free `read`
 *   refuses it (`stateChanging`). The platform has no other convention for a POST, so the lookup keeps it and adds no concept to the authorization step: the
 *   transaction takes the shared policy lock of the session's bundle and judges the session's standing under it (more than a read's authority
 *   check). The database's default isolation applies, because the locked path requires it: a key's transaction asks one source at most for any
 *   query (`answers` is exclusive for the two kinds of `pickup.read`: a code is a request's or a run's, and a number and a name are a request's),
 *   so no second statement has a snapshot to agree with.
 * - **The locked path has a cost, and the feature owns its figures** (features/operations/global-lookup.md section 14; review of 6 November
 *   2026). The shared lock is held until the transaction commits, and the search runs inside it, so a name search holds the lock for as long as it
 *   takes. A reduction of that bundle takes the lock exclusively and waits for the holders, and the requests of the bundle that arrive meanwhile
 *   queue behind the waiting reduction and are refused with the generic operational failure if the lock is not theirs within
 *   `DATABASE_LOCK_TIMEOUT_MS`. Each key also costs two transactions (the coordinator's discovery and the locked one), and so does the step that
 *   writes the events, when there are any. A door for a POST that changes nothing and takes no policy lock would remove it; that is a change to the
 *   authorization step, which this task does not make (a later performance task: global-lookup.md section 14).
 * - **The work given to the runner is restart-safe.** The coordinator runs a work again after a rollback if it asked for a stronger lock or the
 *   plan changed (neither can come from this work today). So the work reads `room` and changes nothing of this read's memory; what it used and
 *   which hubs it found foreign are returned and taken after the transaction has committed, and a second run starts from the same state as the
 *   first. The step that writes the events reads only the hubs it is given.
 */
export class RecordLookupService {
  readonly #options: RecordLookupServiceOptions;
  readonly #groups: readonly (readonly [string, readonly RecordLookupSource[]])[];

  constructor(options: RecordLookupServiceOptions) {
    this.#options = options;
    const known = new Set<RecordLookupKind>();
    for (const source of options.sources) {
      if (known.has(source.kind)) {
        throw new Error(`Two sources are composed for the kind ${source.kind}`);
      }
      known.add(source.kind);
    }
    // In the order of the contract's enumeration, so that the answer has one order whatever the composition gave.
    const ordered = RECORD_LOOKUP_KINDS.flatMap((kind) =>
      options.sources.filter((source) => source.kind === kind),
    );
    const byKey = new Map<string, RecordLookupSource[]>();
    for (const source of ordered) {
      const group = byKey.get(source.readKey) ?? [];
      group.push(source);
      byKey.set(source.readKey, group);
    }
    this.#groups = [...byKey];
  }

  async lookup(
    authorized: AuthorizedRequest,
    correlationId: string,
    raw: unknown,
  ): Promise<RecordLookupView> {
    // The surface gate has refused any session but a staff member's before this runs; a service that answers about records does not rely on
    // that alone (the same two lines as the Ops surface: a session of another principal has no Ops lookup).
    if (authorized.session.principalType !== 'STAFF') {
      throw new ApiException(ErrorCode.PermissionDenied, 403, 'Permission denied');
    }
    const query = lookupQueryOf(raw);
    if (query === undefined) {
      throw new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
        // The text is the field `q` of the body: a POST that changes nothing, so that a number typed in full is in no URL (`AC-LOOKUP-01`).
        violations: [
          { in: 'body', pointer: '/q', rule: typeof raw === 'string' ? 'pattern' : 'required' },
        ],
      });
    }

    let room = LOOKUP_IN_ALL;
    // The hubs other than the actor's own that the results represent, collected as the keys are searched and written down once, at the end.
    const foreign = new Set<string>();
    const found: { readonly kind: RecordLookupKind; readonly result: RecordLookupResultView }[] =
      [];

    for (const [key, allSources] of this.#groups) {
      if (room <= 0) break;
      // Only the kinds that can answer this query are asked, and a key none of whose kinds can is not read for: a code, or a phone number typed
      // in full, does not open a transaction for the key of a kind with nothing to find by it.
      const sources = allSources.filter((source) => source.answers(query));
      if (sources.length === 0) continue;
      // A session whose bundle holds no grant of the key is not searched for these kinds, and the answer does not say so.
      const forKey = authorizationForKey(authorized, key);
      if (forKey === undefined) continue;
      const outcome = await this.#options.runner.mutate(forKey, correlationId, async (handle) => {
        // Bounded before the first search: a statement that runs longer than the limit ends the read, which then fails as any failed read does.
        await this.#options.limitStatements(handle, RECORD_LOOKUP_STATEMENT_TIMEOUT_MS);
        const mine: Taken[] = [];
        let left = room;
        for (const source of sources) {
          if (left <= 0) break;
          const limit = Math.min(LOOKUP_PER_KIND, left);
          const hits = (await source.search(handle, query, limit)).slice(0, limit);
          left -= hits.length;
          for (const hit of hits) mine.push({ kind: source.kind, hit });
        }
        // Which hubs these results are foreign to the actor, for the events to be written at the end; nothing is written here.
        const crossed = await this.#foreignHubsOf(handle, authorized, mine);
        // The names of the hubs are read in the transaction that read the records they belong to, and for the results kept alone.
        const names = await this.#namesOfHubs(handle, mine);
        return {
          used: room - left,
          crossed,
          results: mine.map(({ kind, hit }) => ({ kind, result: resultOf(kind, hit, names) })),
        };
      });
      // Only now, with the transaction committed, does this read remember what it took and what it found.
      room -= outcome.used;
      for (const hubId of outcome.crossed) foreign.add(hubId);
      found.push(...outcome.results);
    }

    // Every search has succeeded and the answer is whole: only now are the crossings written down, together, before the answer is given.
    await this.#writeCrossings(authorized, correlationId, foreign);

    const order = new Map(RECORD_LOOKUP_KINDS.map((kind, index) => [kind, index] as const));
    return {
      items: found
        .toSorted((a, b) => (order.get(a.kind) ?? 0) - (order.get(b.kind) ?? 0))
        .map(({ result }) => result),
    };
  }

  /** The names of the hubs of the results taken in this transaction: one read, none when no result has a hub. */
  async #namesOfHubs(
    handle: TransactionHandle,
    taken: readonly Taken[],
  ): Promise<ReadonlyMap<string, string>> {
    const hubIds = new Set<string>();
    for (const { hit } of taken) if (hit.hubId !== null) hubIds.add(hit.hubId);
    if (hubIds.size === 0) return new Map();
    return this.#options.hubNamesOf(handle, [...hubIds].toSorted());
  }

  /**
   * The hubs other than the actor's own that these results represent: the baseline is the actor's primary hub, and a staff member with none crosses
   * every hub it reads. A result with no hub crosses none. It reads the actor's hub in the transaction of the search when a result has a hub (as the
   * lists do, in the transaction that read the page), writes nothing and remembers nothing: the caller takes the hubs once the transaction has
   * committed (a work that is run again must not find that the hubs of a rolled-back run were taken).
   */
  async #foreignHubsOf(
    handle: TransactionHandle,
    authorized: AuthorizedRequest,
    taken: readonly Taken[],
  ): Promise<readonly string[]> {
    const hubs = new Set<string>();
    for (const { hit } of taken) if (hit.hubId !== null) hubs.add(hit.hubId);
    if (hubs.size === 0) return [];
    const baseline = await this.#options.primaryHubOf(handle, authorized.session.principalId);
    return [...hubs].filter((hubId) => hubId !== baseline);
  }

  /**
   * One event for each hub other than the actor's own that the returned results represent, in the order of the hubs' ids, **in one transaction of
   * its own and only after every search has succeeded** (the audit of 7 November 2026, A4): the transaction is the request's own authorization,
   * which holds the grant of no key, because an event is the actor's own act and not a read of any kind. None when there is no hub to write: a
   * lookup that reads the actor's own hub alone opens nothing. A ledger that cannot take an event fails the read, and the transaction takes the others
   * back with it.
   */
  async #writeCrossings(
    authorized: AuthorizedRequest,
    correlationId: string,
    hubs: ReadonlySet<string>,
  ): Promise<void> {
    if (hubs.size === 0) return;
    const ordered = [...hubs].toSorted();
    await this.#options.runner.mutate(authorized, correlationId, async (handle) => {
      for (const hubId of ordered) {
        await this.#options.audit.write(handle, {
          code: 'auth.hub_boundary.crossed',
          enhanced: true,
          outcome: 'SUCCEEDED',
          object: { type: 'HUB', id: hubId },
          responsibleHubId: hubId,
          relatedIds: { operation_id: 'lookupRecords' },
        });
      }
    });
  }
}

/**
 * The result a hit is: its facts, in the shape of the contract. **A hub is named or the read fails**: a result with a hub id and no name would
 * be drawn as a record with no hub, which says something else (a staff profile with none).
 */
function resultOf(
  kind: RecordLookupKind,
  hit: LookupHit,
  hubNames: ReadonlyMap<string, string>,
): RecordLookupResultView {
  const hubName = hit.hubId === null ? undefined : hubNames.get(hit.hubId);
  if (hit.hubId !== null && hubName === undefined) {
    throw new Error(`The name of the hub ${hit.hubId} of a result could not be read`);
  }
  return {
    kind,
    id: hit.id,
    ...(hit.code === undefined ? {} : { code: hit.code }),
    title: hit.title,
    ...(hit.state === undefined ? {} : { state: hit.state }),
    ...(hit.hubId === null || hubName === undefined
      ? {}
      : { hub: { id: hit.hubId, display_name: hubName } }),
    ...(hit.serviceDate === undefined ? {} : { service_date: hit.serviceDate }),
    ...(hit.senderName === undefined ? {} : { sender_name: hit.senderName }),
    ...(hit.matchedPhone === undefined ? {} : { phone_hint: maskedPhone(hit.matchedPhone) }),
  };
}
