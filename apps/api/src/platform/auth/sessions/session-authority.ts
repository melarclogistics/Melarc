import type { AuditWriter } from '../ports/audit-writer.port.js';
import type { SessionStore, StoredSession } from '../ports/session-store.port.js';
import type { TransactionHandle } from '../ports/unit-of-work.port.js';
import { readBundleFloor, readFixedPolicy } from './bundle-reader.js';
import { FixedPolicyUnavailableError } from './session-errors.js';

/**
 * The compiled fixed-policy revision of **this build** for each audience that has one (SECURITY_DESIGN.md §13.10, "Fixed Vendor and
 * Rider authority"): the number a release raises with every change to the rules it enforces for Vendors and Riders. A build that
 * declares none serves nothing of the type and issues no session of it. The tasks that build the Vendor and Rider sign-ins declare
 * theirs (S0.48, S0.59); until then no build does.
 */
export type CompiledFixedPolicy = Readonly<Partial<Record<'VENDOR' | 'RIDER', number>>>;

/** Which floor a session was found below, with the numbers the audit names. */
export type BelowFloor =
  | {
      readonly kind: 'BUNDLE';
      readonly bundleId: string;
      /** The bundle's current revision and its `reduction_floor`. The session was issued from a revision below the floor. */
      readonly revision: number;
      readonly reductionFloor: number;
    }
  | {
      readonly kind: 'FIXED';
      readonly principalType: 'VENDOR' | 'RIDER';
      readonly minimumRevision: number;
    };

export type AuthorityVerdict =
  { readonly kind: 'VALID' } | { readonly kind: 'BELOW_FLOOR'; readonly floor: BelowFloor };

/**
 * Whether a live session still rests on authority that has not been reduced (SECURITY_DESIGN.md §13.10 and §13.10a; decision C of
 * 12 October 2026; plan OB-130). It is a **read** of the policy tables, taken without a lock, under a context that may read them
 * (the `authentication` capability: a Vendor or a Rider context may not, `data-scope-registry.md`), and it is the authority check of
 * the **authentication** step, so that a session below a floor is `401 SESSION_INVALID` before CSRF is considered. For a read-only
 * request it is also the whole check (a read racing a reduction is simply ordered before it). A state-changing request repeats the
 * question under the shared policy locks, where the answer cannot change until the request ends (`OperationRunner`).
 *
 * Two different failures, kept apart:
 *
 * - **This instance cannot be sure of the policy** (Vendor and Rider only): it declares no revision for the audience, the seed wrote
 *   no policy, its revision is below the stored `minimum_revision` (a release that reduced the policy has raised the floor), or it
 *   is older than the revision the session was issued under. `FixedPolicyUnavailableError`: the platform's `503`, **no session
 *   ended**: the session is valid and the instance is the wrong one, and the next request, reaching a suitable instance, succeeds.
 *   Checked first, so that an instance that cannot evaluate current policy never ends a session by it.
 * - **The session is genuinely below a floor**: a Vendor or Rider session issued under a compiled revision below `minimum_revision`,
 *   or any session issued from a bundle revision below the bundle's `reduction_floor`. The verdict is `BELOW_FLOOR`, and the caller
 *   (a **qualified** instance, because the checks above passed) ends it with `AUTHORITY_CHANGED` and answers `401`.
 */
export async function judgeAuthority(
  handle: TransactionHandle,
  session: Pick<StoredSession, 'principalType' | 'authority'>,
  compiled: CompiledFixedPolicy,
): Promise<AuthorityVerdict> {
  const { authority } = session;
  if (session.principalType !== 'STAFF') {
    const type = session.principalType;
    const here = compiled[type];
    if (here === undefined) throw new FixedPolicyUnavailableError(type, 'NOT_COMPILED');
    const stored = await readFixedPolicy(handle, type);
    if (stored === null) throw new FixedPolicyUnavailableError(type, 'NOT_SEEDED');
    if (here < stored.minimumRevision) throw new FixedPolicyUnavailableError(type, 'BELOW_FLOOR');
    const issuedUnder = authority.policyRevision;
    // A Vendor or Rider session always records one (the table holds it); one that does not cannot be trusted.
    if (issuedUnder === null || issuedUnder < stored.minimumRevision) {
      return {
        kind: 'BELOW_FLOOR',
        floor: { kind: 'FIXED', principalType: type, minimumRevision: stored.minimumRevision },
      };
    }
    // The compiled policy of an older instance is not the policy this session was issued under, and no rule says it may serve it.
    if (here < issuedUnder) throw new FixedPolicyUnavailableError(type, 'OLDER_THAN_SESSION');
  }

  const bundle = await readBundleFloor(handle, authority.bundleId);
  if (bundle === null) {
    // The foreign key keeps a bundle in place while a session refers to it; a session whose bundle cannot be found is not trusted.
    throw new Error('A session refers to a bundle that is not there');
  }
  if (authority.bundleRevision < bundle.reductionFloor) {
    return {
      kind: 'BELOW_FLOOR',
      floor: {
        kind: 'BUNDLE',
        bundleId: authority.bundleId,
        revision: bundle.revision,
        reductionFloor: bundle.reductionFloor,
      },
    };
  }
  return { kind: 'VALID' };
}

/** The `related_ids` of an authority-revoked event: the bundle with its new revision and floor, or the type with its new minimum. */
export function relatedIdsOfFloor(floor: BelowFloor): Record<string, string | number> {
  return floor.kind === 'BUNDLE'
    ? { bundle_id: floor.bundleId, revision: floor.revision, reduction_floor: floor.reductionFloor }
    : { principal_type: floor.principalType, minimum_revision: floor.minimumRevision };
}

export interface AuthorityRevocationDependencies {
  readonly sessions: Pick<SessionStore, 'terminate'>;
  readonly audit: AuditWriter;
}

/**
 * Ends one session because its authority was reduced, and records it: `AUTHORITY_CHANGED` and one `auth.session.authority_revoked`
 * (enhanced), **in the caller's transaction**, so the ending and its record commit together or not at all. A session that is
 * already ended (a reduction or a sign-out got there first, and wrote its own record) is left as it is and gets no second event.
 * It takes a session row lock and no policy lock: ending a session is the very state change a reduction makes, so the two commute
 * (SECURITY_DESIGN.md §13.10a). Returns whether this call ended it.
 */
export async function endForAuthority(
  handle: TransactionHandle,
  dependencies: AuthorityRevocationDependencies,
  sessionId: string,
  floor: BelowFloor,
): Promise<boolean> {
  const ended = await dependencies.sessions.terminate(
    handle,
    { by: 'session', sessionId },
    'AUTHORITY_CHANGED',
  );
  if (ended.length === 0) return false;
  await dependencies.audit.write(handle, {
    code: 'auth.session.authority_revoked',
    enhanced: true,
    outcome: 'SUCCEEDED',
    object: { type: 'Session', id: sessionId },
    reason: { code: 'AUTHORITY_CHANGED', label: 'Authority changed' },
    relatedIds: relatedIdsOfFloor(floor),
    beforeAfter: { session: 'ACTIVE_TO_TERMINATED' },
  });
  return true;
}
