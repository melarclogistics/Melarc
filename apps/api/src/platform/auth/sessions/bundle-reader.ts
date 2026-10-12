import { sql } from 'drizzle-orm';

import { transactionOf } from '../../database/transaction-handle.js';
import {
  BUNDLE_SNAPSHOT_FORMAT,
  SESSION_PRINCIPAL_TYPES,
  type BundleGrantSnapshot,
  type BundleSnapshot,
  type SessionPrincipalType,
} from '../ports/session-store.port.js';
import type { TransactionHandle } from '../ports/unit-of-work.port.js';

/** A role bundle as read for a session to be issued from it: its content and the two counters of SECURITY_DESIGN.md §13.10a. */
export interface BundleRecord {
  readonly id: string;
  readonly revision: number;
  readonly reductionFloor: number;
  readonly snapshot: BundleSnapshot;
}

/** The fixed policy of a Vendor or a Rider (SECURITY_DESIGN.md §13.10): the latest released revision and the floor. */
export interface FixedPolicyRecord {
  readonly revision: number;
  readonly minimumRevision: number;
}

interface BundleRow {
  readonly id: string;
  readonly name: string;
  readonly audience: SessionPrincipalType;
  readonly revision: number;
  readonly reduction_floor: number;
  readonly privileged: boolean;
}

interface GrantRow {
  readonly permission_key: string;
  readonly hub_scope: BundleGrantSnapshot['hubScope'];
  readonly ownership_scope: BundleGrantSnapshot['ownershipScope'];
  readonly tier: BundleGrantSnapshot['tier'];
}

/**
 * Reads a bundle **in the caller's transaction, after the policy locks are held** (SECURITY_DESIGN.md §13.10a, "Reads follow
 * acquisition, and are never cached"): the shared lock on the bundle's key keeps a reduction from committing between this read
 * and the insert of the session that copies it, so what is copied is the content of the revision it records. The runtime holds
 * `SELECT` on the policy tables and nothing more; nothing here takes a row lock, which a `SELECT` privilege could not.
 *
 * The grants are ordered by permission key under the `C` collation, so that two instances copy one bundle to the same bytes.
 * A bundle that is not there is `null`.
 */
export async function readBundle(
  transaction: TransactionHandle,
  bundleId: string,
): Promise<BundleRecord | null> {
  const tx = transactionOf(transaction);
  const found = await tx.execute(
    sql`select id, name, audience, revision, reduction_floor, privileged from role_bundle where id = ${bundleId}`,
  );
  const bundle = found.rows[0] as unknown as BundleRow | undefined;
  if (bundle === undefined) return null;
  if (!(SESSION_PRINCIPAL_TYPES as readonly string[]).includes(bundle.audience)) {
    throw new Error('A bundle has an audience the sessions do not know');
  }
  const grants = await tx.execute(
    sql`select permission_key, hub_scope, ownership_scope, tier from role_bundle_grant
         where bundle_id = ${bundleId} order by permission_key collate "C"`,
  );
  return {
    id: bundle.id,
    revision: bundle.revision,
    reductionFloor: bundle.reduction_floor,
    snapshot: {
      format: BUNDLE_SNAPSHOT_FORMAT,
      name: bundle.name,
      audience: bundle.audience,
      privileged: bundle.privileged,
      grants: (grants.rows as unknown as GrantRow[]).map((grant) => ({
        permission: grant.permission_key,
        hubScope: grant.hub_scope,
        ownershipScope: grant.ownership_scope,
        tier: grant.tier,
      })),
    },
  };
}

/** The fixed policy of a Vendor or a Rider, read under the shared fixed-policy lock; `null` where the seed has not written it. */
export async function readFixedPolicy(
  transaction: TransactionHandle,
  principalType: 'VENDOR' | 'RIDER',
): Promise<FixedPolicyRecord | null> {
  const result = await transactionOf(transaction).execute(
    sql`select revision, minimum_revision from fixed_permission_policy where principal_type = ${principalType}`,
  );
  const row = result.rows[0] as unknown as
    { revision: number; minimum_revision: number } | undefined;
  return row === undefined
    ? null
    : { revision: row.revision, minimumRevision: row.minimum_revision };
}
