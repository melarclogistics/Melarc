import { GRANT_TIERS, HUB_SCOPES, OWNERSHIP_SCOPES } from '../../database/schema/reference-data.js';

/**
 * The TypeScript door to the bundle-change primitive (S0.27; SECURITY_DESIGN.md section 13.10a; migration 0017). The primitive is two
 * database functions, `melarc.change_role_bundle` and `melarc.change_fixed_policy`, and they are the **only** way a bundle, its
 * grants or a fixed policy changes after the seed: the runtime logins hold `SELECT` on these tables and no more, and the functions
 * carry the lock, the diff, the writes, the ending of the sessions below a raised floor and their audit events as **one transaction**.
 *
 * This file does not decide anything the functions decide. It checks the shape of what it sends, sends it as parameters (nothing
 * of a caller's is part of a statement), sets the transaction's own deadlines, and gives the database's refusals names.
 *
 * - **Who calls it.** A connection of the **migration login**, the only identity that may execute the functions (registry section 5).
 *   No process of the application connects as it, and the API, the worker and the provisioning login are refused by the database
 *   (`EXECUTE`), whatever this file does. The edit operation of SLICE-009 reaches the functions in a way that slice decides.
 * - **One change, one transaction.** Each call opens its own at `READ COMMITTED` (the functions refuse another level, so that every read
 *   follows the lock), sets `lock_timeout` and `statement_timeout` for it, and commits or rolls back. A migration that changes several
 *   objects calls the functions in SQL, in one transaction, after `melarc.lock_policy_keys` (canonical order); this is for a caller that
 *   changes one.
 * - **A timeout leaves nothing.** If the exclusive lock cannot be taken in time, the transaction rolls back before it has read or
 *   written anything (`PolicyChangeError`, `LOCK_TIMEOUT`); a change never proceeds without its lock and never half applies.
 */

export type PolicyChangeKind = 'NONE' | 'NAME_ONLY' | 'ADDITION' | 'REDUCTION';

export interface PolicyChangeConnection {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}

export interface PolicyChangeOptions {
  /** How long the change waits for its exclusive lock before it gives up and leaves everything as it was. Default 10 s. */
  readonly lockTimeoutMs?: number;
  /** The bound on the whole statement, the wait included. Default 30 s. */
  readonly statementTimeoutMs?: number;
}

export interface BundleGrantInput {
  readonly permissionKey: string;
  readonly hubScope: (typeof HUB_SCOPES)[number];
  readonly ownershipScope: (typeof OWNERSHIP_SCOPES)[number];
  /** Null where the catalogue gives the holder no tier: *not applicable*, never a ranked tier (OB-75). */
  readonly tier: (typeof GRANT_TIERS)[number] | null;
}

export interface BundleChange {
  readonly bundleId: string;
  /** A new name. A change of the name alone raises nothing. */
  readonly name?: string;
  /** The **complete** new set of the bundle's grants; leave it out to change the name alone. */
  readonly grants?: readonly BundleGrantInput[];
  /** Names the release step or the operation; it is the correlation id of the audit events the change writes (1 to 128 characters). */
  readonly correlationId: string;
}

export interface FixedPolicyChange {
  readonly principalType: 'VENDOR' | 'RIDER';
  /** Whether the compiled rules of the audience were reduced (a removal or a narrowing): the floor rises with the revision and ends sessions. */
  readonly reduction: boolean;
  readonly correlationId: string;
}

export interface PolicyChangeResult {
  readonly kind: PolicyChangeKind;
  readonly revision: number;
  /** A bundle's `reduction_floor`, or a fixed policy's `minimum_revision`, after the change. */
  readonly floor: number;
  /** The live sessions the change ended with `AUTHORITY_CHANGED`, each with its `auth.session.authority_revoked`. */
  readonly endedSessionIds: readonly string[];
}

export type PolicyChangeFailure =
  'LOCK_TIMEOUT' | 'DEADLINE' | 'INVALID' | 'NOT_FOUND' | 'LOCK_PROTOCOL' | 'WRONG_ISOLATION';

/** The database refused the change, or it could not be made in time. Nothing was applied. The message never repeats a value. */
export class PolicyChangeError extends Error {
  constructor(
    readonly failure: PolicyChangeFailure,
    readonly sqlState: string | undefined,
  ) {
    super(
      {
        LOCK_TIMEOUT: 'The exclusive policy lock could not be taken in time: nothing was changed',
        DEADLINE: 'The change did not finish in time: nothing was changed',
        INVALID: 'The change was refused as malformed: nothing was changed',
        NOT_FOUND: 'There is nothing of that name to change: nothing was changed',
        LOCK_PROTOCOL: 'The policy locks were asked for against the protocol: nothing was changed',
        WRONG_ISOLATION: 'A policy change runs at read committed isolation only',
      }[failure],
    );
    this.name = 'PolicyChangeError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;

function timeout(value: number | undefined, fallback: number, what: string): number {
  const chosen = value ?? fallback;
  if (!Number.isInteger(chosen) || chosen < 1 || chosen > MAX_TIMEOUT_MS) {
    throw new RangeError(
      `${what} is a whole number of milliseconds between 1 and ${String(MAX_TIMEOUT_MS)}`,
    );
  }
  return chosen;
}

/**
 * The grammar the functions enforce (migration 0017). It is a check of shape and no screen for a secret or for data about a person:
 * the caller passes an identifier it generated, or the fixed label of a release step, and never text that a user supplied.
 */
const CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,127}$/;

function correlation(value: string): string {
  if (typeof value !== 'string' || !CORRELATION_ID.test(value)) {
    throw new RangeError(
      'A policy change carries a correlation id of 1 to 128 letters, digits and . _ : / # - that names a release step or an operation',
    );
  }
  return value;
}

/** The refusals the database raises, by SQLSTATE: the functions of migration 0017 and the server's own deadlines. */
function failureOf(error: unknown): PolicyChangeError | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  const detail = (error as { detail?: unknown } | null)?.detail;
  switch (code) {
    case '55P03':
      return new PolicyChangeError('LOCK_TIMEOUT', code);
    case '57014':
      return new PolicyChangeError('DEADLINE', code);
    case '22023':
      return new PolicyChangeError('INVALID', code);
    case 'P0002':
      return new PolicyChangeError('NOT_FOUND', code);
    case '25000':
      return new PolicyChangeError('WRONG_ISOLATION', code);
    case '55000':
      return detail === 'lock_order' || detail === 'lock_upgrade'
        ? new PolicyChangeError('LOCK_PROTOCOL', code)
        : undefined;
    default:
      return undefined;
  }
}

async function inOneTransaction(
  connection: PolicyChangeConnection,
  options: PolicyChangeOptions,
  statement: string,
  values: unknown[],
): Promise<Record<string, unknown>> {
  const lockTimeout = timeout(options.lockTimeoutMs, DEFAULT_LOCK_TIMEOUT_MS, 'The lock timeout');
  const statementTimeout = timeout(
    options.statementTimeoutMs,
    DEFAULT_STATEMENT_TIMEOUT_MS,
    'The statement timeout',
  );
  await connection.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  try {
    // Transaction-local, so that nothing of it outlives the transaction on a pooled or a reused connection.
    await connection.query(
      `select set_config('lock_timeout', $1::text, true), set_config('statement_timeout', $2::text, true)`,
      [`${String(lockTimeout)}ms`, `${String(statementTimeout)}ms`],
    );
    const { rows } = await connection.query(statement, values);
    await connection.query('COMMIT');
    const result = rows[0]?.result;
    if (typeof result !== 'object' || result === null) {
      throw new Error('The policy change function returned no result');
    }
    return result as Record<string, unknown>;
  } catch (error) {
    await connection.query('ROLLBACK').catch(() => undefined);
    throw failureOf(error) ?? error;
  }
}

function resultOf(raw: Record<string, unknown>, floorKey: string): PolicyChangeResult {
  const ended = raw.ended;
  return Object.freeze({
    kind: raw.kind as PolicyChangeKind,
    revision: Number(raw.revision),
    floor: Number(raw[floorKey]),
    endedSessionIds: Object.freeze(Array.isArray(ended) ? ended.map(String) : []),
  });
}

/**
 * Changes a bundle: its name, its grants, or both. A removal or a narrowing of a grant (and any change that cannot be shown to be a
 * widening) is a **reduction**: the revision and the floor rise together and every live session recorded below the floor is ended,
 * in the same transaction. An addition or a widening raises the revision and ends nothing. A change of the name alone raises nothing.
 * An identical change is `NONE` and writes nothing.
 */
export async function changeRoleBundle(
  connection: PolicyChangeConnection,
  change: BundleChange,
  options: PolicyChangeOptions = {},
): Promise<PolicyChangeResult> {
  if (typeof change.bundleId !== 'string' || !UUID.test(change.bundleId)) {
    throw new RangeError('A bundle change names a bundle by its id (a UUID)');
  }
  const grants =
    change.grants === undefined
      ? null
      : JSON.stringify(
          change.grants.map((grant) => ({
            permission_key: grant.permissionKey,
            hub_scope: grant.hubScope,
            ownership_scope: grant.ownershipScope,
            tier: grant.tier,
          })),
        );
  const raw = await inOneTransaction(
    connection,
    options,
    'select melarc.change_role_bundle($1::uuid, $2::text, $3::jsonb, $4::text) as result',
    [change.bundleId.toLowerCase(), change.name ?? null, grants, correlation(change.correlationId)],
  );
  return resultOf(raw, 'reduction_floor');
}

/**
 * Raises the revision of the compiled fixed policy of the Vendor or the Rider, and, when the release reduced the rules, the minimum
 * revision with it, ending every live session of the audience recorded under a lower one (SECURITY_DESIGN.md section 13.10).
 */
export async function changeFixedPolicy(
  connection: PolicyChangeConnection,
  change: FixedPolicyChange,
  options: PolicyChangeOptions = {},
): Promise<PolicyChangeResult> {
  // The type already says so; a caller that is not checked by it (a script, a test) is told plainly.
  const audience: string = change.principalType;
  if (audience !== 'VENDOR' && audience !== 'RIDER') {
    throw new RangeError('Only a Vendor and a Rider have a fixed permission policy');
  }
  if (typeof change.reduction !== 'boolean') {
    throw new RangeError(
      'A fixed-policy change states whether it reduces the policy: true or false',
    );
  }
  const raw = await inOneTransaction(
    connection,
    options,
    'select melarc.change_fixed_policy($1::text, $2::boolean, $3::text) as result',
    [change.principalType, change.reduction, correlation(change.correlationId)],
  );
  return resultOf(raw, 'minimum_revision');
}
