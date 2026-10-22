import type { AuditJson, AuditJsonObject } from '../auth/ports/audit-writer.port.js';
import { isUuid } from '../database/transaction-context.js';

/**
 * The facts of `auth.bootstrap.resumed` (audit.md §5.4; MIGRATION_AND_SEEDING.md §3.3a; AC-SLICE-000-93; the owner's adoption of
 * 21 October 2026, A07): the enhanced summary of **one committed resume** of a stranded bootstrap Platform Admin by the
 * provisioning-only command, on either path. It is written by `SYSTEM` (a null actor: `actor_id` is null for `SYSTEM`, audit.md §3,
 * and the technical identifier of a capability never becomes an actor) in the transaction of the change, so a summary that cannot be
 * written takes the grant, the supersession and the revocation back with it. The reserved bootstrap actor is not the actor: it is a
 * named, validated fact (`related_ids.reserved_system_actor_id`). The detailed events of the resume (`auth.setup_grant.issued`,
 * `auth.setup_grant.superseded`, `auth.mfa.revoked`) are written beside it, and this event replaces none of them.
 *
 * **What the writer can establish, and what it cannot.** It checks that each required fact is there, that an identifier is a UUID in
 * its canonical form, that the closed sets are respected, and that the facts agree with one another (the path and the purpose, the
 * grants that ended and the before and after that shows them). It does **not** know that a grant or a factor exists or was in the state
 * said: that the facts are the database's own changes is the resume function's, which derives them from what it wrote, under the
 * identity's lock, and refuses a document whose summary says otherwise (`bootstrap-functions.db.test.ts`).
 *
 * ## The shape
 *
 * - `object`: the identity resumed, `{ type: 'StaffIdentity', id }`. `outcome`: `SUCCEEDED`; a refused resume writes no event.
 * - `detail`, exactly these three facts: `path` (`REENROLMENT`: a password was established and a fresh `MFA_REENROLMENT` was issued;
 *   `BUNDLE_LOST`: no password yet and the unconsumed `BOOTSTRAP_SETUP` was superseded by a new one), `purpose` (the purpose of the grant
 *   issued, which the path fixes) and `channel` (`PROVISIONING_CHANNEL`, the value the detailed event of the same run states).
 * - `related_ids`, exactly these keys, each identifier a lower-case UUID and each list distinct and in ascending order:
 *   `principal_id` (the object), `reserved_system_actor_id` (the reserved bootstrap actor), `setup_grant_id` (the grant issued),
 *   `superseded_grant_ids` (the grants that became `SUPERSEDED`), `expired_grant_ids` (the grants of the identity that had lapsed and
 *   became `EXPIRED`) and `revoked_factor_ids` (the factors that became `REVOKED`).
 *   **`BUNDLE_LOST` supersedes exactly one grant and ends and revokes nothing else; `REENROLMENT` supersedes none**, ends every lapsed
 *   grant of the identity and revokes every stale `PENDING` factor. Either list may be empty where the path allows it.
 * - `before_after`, exactly `grants` and `factors`, each `{ before, after }` of lists:
 *   - `grants.before`: the grants the resume ended (the superseded and the expired), each `{ id, purpose, state: 'PENDING' }`, by id;
 *   - `grants.after`: the same grants in the same order, each now `SUPERSEDED` or `EXPIRED` as `related_ids` says, **followed by the
 *     grant issued**, `{ id: setup_grant_id, purpose: <detail.purpose>, state: 'PENDING' }`;
 *   - `factors.before`: the revoked factors, each `{ id, status: 'PENDING' }`, by id; `factors.after`: the same, each `REVOKED`.
 *   No change of the identity's status is recorded, because none happens.
 *
 * Never in the event: a secret, a token or its hash, a seed, an address, a name or a path. The identifiers above are the whole of it.
 */

/**
 * The reserved bootstrap actor, as `src/staff/reserved-system-actor.ts` and `melarc.reserved_system_actor_id()` (migration 0019) hold
 * it. A platform module may not import the staff domain, so the value is pinned here and `audit-bootstrap-resumed.test.ts` holds the
 * two together.
 */
export const RESERVED_SYSTEM_ACTOR_FACT = '5eed0000-0000-4000-8000-0000000000a1';

export const BOOTSTRAP_RESUME_PATHS = ['REENROLMENT', 'BUNDLE_LOST'] as const;
type ResumePath = (typeof BOOTSTRAP_RESUME_PATHS)[number];

/** The purpose of the grant each path issues. */
const PURPOSE_OF_PATH: Readonly<Record<ResumePath, string>> = {
  REENROLMENT: 'MFA_REENROLMENT',
  BUNDLE_LOST: 'BOOTSTRAP_SETUP',
};

export const BOOTSTRAP_RESUME_CHANNEL = 'PROVISIONING_CHANNEL';

const DETAIL_KEYS = 'channel,path,purpose';
const RELATED_KEYS = [
  'expired_grant_ids',
  'principal_id',
  'reserved_system_actor_id',
  'revoked_factor_ids',
  'setup_grant_id',
  'superseded_grant_ids',
].join(',');
const PURPOSE = /^[A-Z][A-Z0-9_]*$/;

export interface BootstrapResumedFacts {
  readonly outcome: string;
  readonly objectType: unknown;
  readonly objectId: string | null;
  readonly actorId: string | null;
  /** The detail as the caller gave it: it is checked here, whatever it is. */
  readonly detail: unknown;
  readonly relatedIds: AuditJsonObject | null;
  readonly beforeAfter: AuditJsonObject | null;
}

const isObject = (value: unknown): value is Record<string, AuditJson> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const keysOf = (value: Record<string, unknown>): string => Object.keys(value).toSorted().join(',');

/** A UUID in the form the database writes it: lower case. */
const canonicalUuid = (value: unknown): string | undefined =>
  typeof value === 'string' && isUuid(value) && value === value.toLowerCase() ? value : undefined;

/** A list of distinct canonical UUIDs in ascending order, or `undefined`. */
function idList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = (value as unknown[]).map(canonicalUuid);
  if (ids.some((id) => id === undefined)) return undefined;
  const list = ids as string[];
  const ascending = list.every((id, at) => at === 0 || (list[at - 1] ?? '') < id);
  return ascending ? list : undefined;
}

/** `{ before, after }` and nothing else, each a list. */
function transition(value: unknown): { before: unknown[]; after: unknown[] } | undefined {
  if (!isObject(value) || keysOf(value) !== 'after,before') return undefined;
  const { before, after } = value;
  return Array.isArray(before) && Array.isArray(after)
    ? { before: before as unknown[], after: after as unknown[] }
    : undefined;
}

/** `{ id, <field>, ... }` with exactly the keys given, or `undefined`. */
function entry(value: unknown, keys: string): Record<string, AuditJson> | undefined {
  return isObject(value) && keysOf(value) === keys ? value : undefined;
}

/**
 * Refuses (by `refuse`, which throws) an `auth.bootstrap.resumed` whose facts are not the shape above. Called by the writer for this
 * event only, after the generic checks of its requirements. It reads the event and nothing else.
 */
export function validateBootstrapResumedFacts(
  facts: BootstrapResumedFacts,
  refuse: (field: string) => never,
): void {
  if (facts.outcome !== 'SUCCEEDED') refuse('outcome');
  if (facts.objectType !== 'StaffIdentity' || facts.objectId === null) refuse('object');
  // The system writes it, and has no id (the reserved actor is a fact, not the actor).
  if (facts.actorId !== null) refuse('actor');

  const detail = facts.detail;
  if (!isObject(detail) || keysOf(detail) !== DETAIL_KEYS) return refuse('detail');
  const path = detail.path;
  if (path !== 'REENROLMENT' && path !== 'BUNDLE_LOST') return refuse('detail.path');
  const purpose = PURPOSE_OF_PATH[path];
  if (detail.purpose !== purpose) refuse('detail.purpose');
  if (detail.channel !== BOOTSTRAP_RESUME_CHANNEL) refuse('detail.channel');

  const related = facts.relatedIds;
  if (related === null || keysOf(related) !== RELATED_KEYS) return refuse('relatedIds');
  if (canonicalUuid(related.principal_id) !== facts.objectId) refuse('relatedIds.principal_id');
  if (related.reserved_system_actor_id !== RESERVED_SYSTEM_ACTOR_FACT) {
    refuse('relatedIds.reserved_system_actor_id');
  }
  const issued = canonicalUuid(related.setup_grant_id);
  if (issued === undefined) return refuse('relatedIds.setup_grant_id');
  const superseded = idList(related.superseded_grant_ids);
  if (superseded === undefined) return refuse('relatedIds.superseded_grant_ids');
  const expired = idList(related.expired_grant_ids);
  if (expired === undefined) return refuse('relatedIds.expired_grant_ids');
  const revoked = idList(related.revoked_factor_ids);
  if (revoked === undefined) return refuse('relatedIds.revoked_factor_ids');

  const ended = [...superseded, ...expired];
  if (new Set(ended).size !== ended.length || ended.includes(issued)) {
    refuse('relatedIds.setup_grant_id');
  }
  if (path === 'BUNDLE_LOST') {
    // The lost secret, and nothing else: no lapsed grant is ended and no factor revoked on this path.
    if (superseded.length !== 1) refuse('relatedIds.superseded_grant_ids');
    if (expired.length > 0) refuse('relatedIds.expired_grant_ids');
    if (revoked.length > 0) refuse('relatedIds.revoked_factor_ids');
  } else if (superseded.length > 0) {
    refuse('relatedIds.superseded_grant_ids');
  }

  const diff = facts.beforeAfter;
  if (diff === null || keysOf(diff) !== 'factors,grants') return refuse('beforeAfter');
  const grants = transition(diff.grants);
  if (grants === undefined) return refuse('beforeAfter.grants');
  const factors = transition(diff.factors);
  if (factors === undefined) return refuse('beforeAfter.factors');

  // The grants that ended, by id: each was pending, and is now what `related_ids` says; then the grant issued, pending.
  const endedById = [...ended].toSorted();
  if (grants.before.length !== endedById.length || grants.after.length !== endedById.length + 1) {
    return refuse('beforeAfter.grants');
  }
  endedById.forEach((id, at) => {
    const before = entry(grants.before[at], 'id,purpose,state');
    const after = entry(grants.after[at], 'id,purpose,state');
    if (before === undefined || after === undefined) return refuse('beforeAfter.grants');
    const kind = typeof before.purpose === 'string' ? before.purpose : '';
    if (before.id !== id || after.id !== id) refuse('beforeAfter.grants');
    if (!PURPOSE.test(kind) || after.purpose !== kind) refuse('beforeAfter.grants');
    // The lost secret of the first path is the bootstrap secret, and no other purpose is superseded there.
    if (path === 'BUNDLE_LOST' && kind !== 'BOOTSTRAP_SETUP') refuse('beforeAfter.grants');
    if (before.state !== 'PENDING') refuse('beforeAfter.grants');
    if (after.state !== (superseded.includes(id) ? 'SUPERSEDED' : 'EXPIRED')) {
      refuse('beforeAfter.grants');
    }
  });
  const last = entry(grants.after[endedById.length], 'id,purpose,state');
  if (last?.id !== issued || last.purpose !== purpose || last.state !== 'PENDING') {
    refuse('beforeAfter.grants');
  }

  // The factors that were revoked, by id: each was pending and is now revoked.
  if (factors.before.length !== revoked.length || factors.after.length !== revoked.length) {
    return refuse('beforeAfter.factors');
  }
  revoked.forEach((id, at) => {
    const before = entry(factors.before[at], 'id,status');
    const after = entry(factors.after[at], 'id,status');
    if (before === undefined || after === undefined) return refuse('beforeAfter.factors');
    if (before.id !== id || after.id !== id) refuse('beforeAfter.factors');
    if (before.status !== 'PENDING' || after.status !== 'REVOKED') refuse('beforeAfter.factors');
  });
}
