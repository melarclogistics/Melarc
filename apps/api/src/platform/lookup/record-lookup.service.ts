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
  readonly phone_hint?: string;
}

export interface RecordLookupView {
  readonly items: readonly RecordLookupResultView[];
}

export interface RecordLookupServiceOptions {
  readonly runner: Pick<OperationRunner, 'read'>;
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
}

/** The most of one kind in an answer, and of all kinds together. */
export const LOOKUP_PER_KIND = 8;
export const LOOKUP_IN_ALL = 20;

/** The records of one key are searched in one `REPEATABLE READ` transaction: they are one picture of the data. */
const ONE_SNAPSHOT = { isolation: 'REPEATABLE READ' } as const;

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
 *   other than the actor's own that the returned results represent, in the transaction that read the first of them, and none for a result the
 *   twenty left out (the room is counted before the transaction ends).
 * - **A source that fails fails the read** (`500`): the answer never says "nothing found" for a kind it could not read.
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
        violations: [
          { in: 'query', pointer: '/q', rule: typeof raw === 'string' ? 'pattern' : 'required' },
        ],
      });
    }

    let room = LOOKUP_IN_ALL;
    const audited = new Set<string>();
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
      const taken = await this.#options.runner.read(
        forKey,
        correlationId,
        async (handle) => {
          const mine: Taken[] = [];
          for (const source of sources) {
            if (room <= 0) break;
            const limit = Math.min(LOOKUP_PER_KIND, room);
            const hits = (await source.search(handle, query, limit)).slice(0, limit);
            room -= hits.length;
            for (const hit of hits) mine.push({ kind: source.kind, hit });
          }
          await this.#writeCrossings(handle, authorized, mine, audited);
          // The names of the hubs are read in the transaction that read the records they belong to, and for the results kept alone.
          const names = await this.#namesOfHubs(handle, mine);
          return mine.map(({ kind, hit }) => ({ kind, result: resultOf(kind, hit, names) }));
        },
        ONE_SNAPSHOT,
      );
      found.push(...taken);
    }

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
   * One event for each hub other than the actor's own that these results represent and that no earlier transaction of this read wrote: the
   * baseline is the actor's primary hub, and a staff member with none crosses every hub it reads. A result with no hub crosses none.
   */
  async #writeCrossings(
    handle: TransactionHandle,
    authorized: AuthorizedRequest,
    taken: readonly Taken[],
    audited: Set<string>,
  ): Promise<void> {
    const hubs = new Set<string>();
    for (const { hit } of taken) {
      if (hit.hubId !== null && !audited.has(hit.hubId)) hubs.add(hit.hubId);
    }
    if (hubs.size === 0) return;
    const baseline = await this.#options.primaryHubOf(handle, authorized.session.principalId);
    for (const hubId of [...hubs].toSorted()) {
      if (hubId === baseline) continue;
      audited.add(hubId);
      await this.#options.audit.write(handle, {
        code: 'auth.hub_boundary.crossed',
        enhanced: true,
        outcome: 'SUCCEEDED',
        object: { type: 'HUB', id: hubId },
        responsibleHubId: hubId,
        relatedIds: { operation_id: 'lookupRecords' },
      });
    }
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
    ...(hit.matchedPhone === undefined ? {} : { phone_hint: maskedPhone(hit.matchedPhone) }),
  };
}
