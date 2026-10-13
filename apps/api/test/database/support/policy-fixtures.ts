import { randomUUID } from 'node:crypto';

import type pg from 'pg';

import type { BundleGrantInput } from '../../../src/platform/authorization/policy-change/policy-change.js';

/**
 * Bundles of a test's own, and the wait for a statement that is blocked on a lock (S0.27). A test of the bundle-change primitive
 * never changes the seeded bundles, which other tests of its file read: it makes a bundle with the grants it needs, as the
 * administrator (past row-level security, as the seed was), and changes that.
 */
export type Grant = BundleGrantInput;

export const grant = (
  permissionKey: string,
  hubScope: Grant['hubScope'] = 'own',
  ownershipScope: Grant['ownershipScope'] = 'any',
  tier: Grant['tier'] = 'A',
): Grant => ({ permissionKey, hubScope, ownershipScope, tier });

/** Keys of the seeded catalogue (permissions.md section 7) that a test bundle may hold. */
export const READ_STAFF = 'staff.read';
export const READ_VENDOR = 'vendor.read';
export const READ_DISPATCH = 'dispatch.read';

/** A bundle with the grants given, at revision 1 and floor 1, as the seed would have made it. */
export async function newBundle(
  admin: Pick<pg.Client, 'query'>,
  grants: readonly Grant[] = [],
  audience = 'STAFF',
): Promise<string> {
  const id = randomUUID();
  await admin.query(
    `insert into role_bundle (id, name, audience, privileged) values ($1, $2, $3, false)`,
    [id, `Test bundle ${id}`, audience],
  );
  for (const each of grants) {
    await admin.query(
      `insert into role_bundle_grant (bundle_id, permission_key, hub_scope, ownership_scope, tier) values ($1, $2, $3, $4, $5)`,
      [id, each.permissionKey, each.hubScope, each.ownershipScope, each.tier],
    );
  }
  return id;
}

export interface Blocked {
  readonly pid: number;
  readonly query: string;
  readonly waitEvent: string;
}

/**
 * Waits until a backend of the database is blocked on a lock while running a statement that matches `statement`, and returns it:
 * the latch of a race. Nothing is slept for a length of time; the state is polled until the server says the statement is waiting,
 * and a statement that never waits fails the test with what the server did show.
 */
export async function waitUntilBlocked(
  admin: Pick<pg.Client, 'query'>,
  databaseName: string,
  statement: RegExp,
  timeoutMs = 10_000,
): Promise<Blocked> {
  const deadline = Date.now() + timeoutMs;
  let seen: string[];
  for (;;) {
    const { rows } = await admin.query<{ pid: number; query: string; wait_event: string }>(
      `select pid, query, wait_event from pg_stat_activity
        where datname = $1 and wait_event_type = 'Lock' and pid <> pg_backend_pid()`,
      [databaseName],
    );
    seen = rows.map((row) => `${row.wait_event}: ${row.query.trim().slice(0, 80)}`);
    const found = rows.find((row) => statement.test(row.query));
    if (found !== undefined) {
      return { pid: found.pid, query: found.query, waitEvent: found.wait_event };
    }
    if (Date.now() > deadline) {
      throw new Error(
        `no statement matching ${String(statement)} was blocked on a lock; blocked: ${JSON.stringify(seen)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Waits until `check` is true, polling; the failure says what was being waited for. */
export async function eventually(
  check: () => Promise<boolean> | boolean,
  what: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
