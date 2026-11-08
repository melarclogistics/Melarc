// Runs alone: it reads the server's count of deadlocks and the advisory locks of pg_locks, and its timing is what it judges.
import { performance } from 'node:perf_hooks';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresStaffIdentityDirectory } from '../../../src/staff/postgres.staff-identity-directory.adapter.js';
import { PostgresVendorAccountDirectory } from '../../../src/vendor/postgres.vendor-account-directory.adapter.js';
import { PostgresRiderIdentityDirectory } from '../../../src/staff/postgres.rider-identity-directory.adapter.js';
import { RoutedIdentityDirectory } from '../../../src/platform/auth/directory/routed.identity-directory.adapter.js';
import type {
  IdentityDirectory,
  PrincipalRef,
} from '../../../src/platform/auth/ports/identity-directory.port.js';
import type { TransactionHandle } from '../../../src/platform/auth/ports/unit-of-work.port.js';
import {
  FixedPolicyUnavailableError,
  SessionIssueRefusedError,
} from '../../../src/platform/auth/sessions/session-errors.js';
import {
  changeFixedPolicy,
  changeRoleBundle,
  PolicyChangeError,
} from '../../../src/platform/authorization/policy-change/policy-change.js';
import { DatabaseDeadlineError } from '../../../src/platform/database/database-failures.js';
import { postgresConnectionSettings } from '../../../src/platform/database/postgres-url.js';
import { PolicyCoordinationError } from '../../../src/platform/database/policy-lock/coordinate.js';
import { MIGRATION_ROLE } from '../../../src/tools/database/safety.js';
import { presenting } from '../support/http-sessions.js';
import { insertStaff, staffRow } from '../support/identities.js';
import { assemble, type Machinery } from '../support/personas.js';
import {
  grant,
  newBundle,
  READ_STAFF,
  READ_VENDOR,
  type Grant,
} from '../support/policy-fixtures.js';
import { insertRider, insertRiderDevice, riderRow } from '../support/riders.js';
import {
  API,
  OPS,
  startStaffRoutes,
  type Actor,
  type StaffRoutes,
} from '../support/staff-routes.js';
import { clientFor } from '../support/test-database.js';
import { insertDevice, insertVendor, vendorRow } from '../support/vendors.js';

/**
 * The concurrency and privilege acceptance run of SECURITY_DESIGN.md section 13.10a on the final schema (S0.64; the race and lock-protocol
 * clauses of AC-SLICE-000-05, and `GBT-B12`, a reduction racing a sign-in, here under volume), with the operations that take the policy locks today, as the actual runtime login: obligation 8
 * (randomised interleavings of issue for the three audiences, bundle and fixed-policy changes, revocation, sign-out and reads complete
 * without a deadlock), obligation 10 (a stream of sign-ins does not keep a reduction from its lock within its deadline), obligation 11
 * under load (an identity reassigned over and over while it signs in: bounded restarts, nothing written before revalidation), and the
 * lock-leak check of Family A after all of it. The other state-changing staff operations (create, approve, device and MFA acts) are not
 * in the mix: a revocation is the one request of that kind it runs.
 *
 * **A run that cannot fail proves nothing**, so each part says what it saw: the last test of the traffic asks that every kind of
 * operation had its effect at least once across the seeds (sessions ended by a bundle floor and by a fixed floor among them), and the
 * instruments at the end prove that the floor checks see a session left below a floor.
 *
 * **The verdict on a deadlock is the server's.** PostgreSQL counts every deadlock it breaks in `pg_stat_database.deadlocks`, and the
 * victim's error is `40P01`; the run reads the count before and after, and looks for the code in every failure it is given. A refusal the
 * protocol allows (a lock that waited past its deadline: the generic failure; a restart that ran out of attempts; a session that a
 * reduction or a revocation ended first) is an outcome, counted and reported; anything else fails the run.
 *
 * **Reproducible.** Each randomised run names its seed; `MELARC_CONCURRENCY_SEED` runs one seed again, as it ran.
 */

const DEADLOCK = '40P01';
const STAFF_PER_BUNDLE = 4;
const ROUNDS = 10;
/** The seed asked for, which must be a whole number: a typo would otherwise be a seed of its own (`NaN` is the generator's zero). */
function seedAsked(text: string): number {
  const seed = Number(text);
  if (!Number.isSafeInteger(seed)) {
    throw new Error('MELARC_CONCURRENCY_SEED is a whole number, the seed a failed run printed');
  }
  return seed;
}
const SEEDS =
  process.env.MELARC_CONCURRENCY_SEED === undefined
    ? [20261028, 7, 1337]
    : [seedAsked(process.env.MELARC_CONCURRENCY_SEED)];

/** A small, fast, seeded generator (mulberry32): the same seed, the same run. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FULL: readonly Grant[] = [grant(READ_STAFF), grant(READ_VENDOR)];
const REDUCED: readonly Grant[] = [grant(READ_STAFF)];

/**
 * The revision of the compiled fixed policy that the build serving each audience carries: what a release deploys once the database has
 * been told (SECURITY_DESIGN.md section 13.10). It starts at the revision the database holds, and a change of the fixed policy raises it
 * when the change has committed. A number above every floor the run reaches would make the fixed-floor checks unable to fail: no session
 * would ever be below a floor, and a reduction that forgot to end one could not be seen. Here an issue under the old build, after a
 * reduction has raised the floor, is refused (`BELOW_FLOOR`), and a session of the old revision that is still live after one is a
 * failure of the protocol, which `invariants` finds.
 */
const released = { VENDOR: 1, RIDER: 1 };

/** The sessions the changes of the run ended, by the floor that ended them: the proof that the floors had something to judge. */
const ended = { bundle: 0, fixed: 0 };

let routes: StaffRoutes;
let machinery: Machinery;
let migrations: pg.Pool;
let officer: Actor;
let bundles: string[] = [];
const staff: { id: string; bundle: string }[] = [];
const vendors: { accountId: string; deviceId: string }[] = [];
const riders: { id: string; deviceId: string }[] = [];

beforeAll(async () => {
  routes = await startStaffRoutes();
  const revisions = await routes.rows<{ principal_type: 'VENDOR' | 'RIDER'; revision: number }>(
    `select principal_type, revision::int as revision from fixed_permission_policy`,
  );
  for (const row of revisions) released[row.principal_type] = row.revision;
  machinery = assemble(routes.built, {
    identities: new RoutedIdentityDirectory({
      STAFF: new PostgresStaffIdentityDirectory(),
      VENDOR: new PostgresVendorAccountDirectory(),
      RIDER: new PostgresRiderIdentityDirectory(),
    }),
    // Read at each issue, so that a release is seen by the next one.
    compiledPolicy: {
      get VENDOR() {
        return released.VENDOR;
      },
      get RIDER() {
        return released.RIDER;
      },
    },
  });
  migrations = new pg.Pool({
    ...postgresConnectionSettings(routes.database.urlFor(MIGRATION_ROLE)),
    max: 4,
  });
  officer = await routes.platformAdmin();
  bundles = [await newBundle(routes.admin, FULL), await newBundle(routes.admin, FULL)];
  for (const bundle of bundles) {
    for (let index = 0; index < STAFF_PER_BUNDLE; index += 1) {
      const row = await insertStaff(routes.admin, staffRow({ roleBundleId: bundle }));
      staff.push({ id: row.id, bundle });
    }
  }
  for (let index = 0; index < 3; index += 1) {
    const vendor = await insertVendor(
      routes.admin,
      vendorRow({ secretHash: '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaA' }),
    );
    const device = await insertDevice(routes.admin, vendor.accountId);
    vendors.push({ accountId: vendor.accountId, deviceId: device.id });
    const rider = await insertRider(
      routes.admin,
      riderRow({ pinHash: '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaA' }),
    );
    const riderDevice = await insertRiderDevice(routes.admin, rider.id);
    riders.push({ id: rider.id, deviceId: riderDevice.id });
  }
});

afterAll(async () => {
  // A beforeAll that failed part-way leaves some of these unset: close whatever exists, and the server last.
  const pool = migrations as pg.Pool | undefined;
  const started = routes as StaffRoutes | undefined;
  try {
    await pool?.end();
  } finally {
    await started?.stop();
  }
});

/** The server's count of the deadlocks it broke in this database. Cumulative statistics are flushed late, so the reader waits for them. */
async function deadlocks(): Promise<number> {
  const client = clientFor(routes.database.urlFor('postgres'));
  await client.connect();
  try {
    const { rows } = await client.query<{ deadlocks: string }>(
      `select deadlocks from pg_stat_database where datname = current_database()`,
    );
    return Number(rows[0]?.deadlocks ?? 0);
  } finally {
    await client.end();
  }
}

/** Whether any error in a failure's chain is the server's deadlock. */
function isDeadlock(error: unknown): boolean {
  for (
    let current: unknown = error, depth = 0;
    current !== undefined && current !== null && depth < 8;
    depth += 1
  ) {
    const code =
      (current as { code?: unknown; sqlState?: unknown }).code ??
      (current as { sqlState?: unknown }).sqlState;
    if (code === DEADLOCK) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** A failure the protocol allows: the generic failure of a deadline, a restart that ran out, a session already ended, a fixed policy not served. */
function isAllowedFailure(error: unknown): boolean {
  if (isDeadlock(error)) return false;
  if (error instanceof PolicyChangeError)
    return error.failure === 'LOCK_TIMEOUT' || error.failure === 'DEADLINE';
  return (
    error instanceof DatabaseDeadlineError ||
    error instanceof PolicyCoordinationError ||
    error instanceof SessionIssueRefusedError ||
    error instanceof FixedPolicyUnavailableError
  );
}

/** What a request may be answered with in this traffic: a success, or a refusal its contract names, or the operational failure. */
const ALLOWED_STATUSES = new Set([200, 204, 401, 403, 404, 409, 503]);

interface Held {
  readonly id: string;
  readonly token: string;
  readonly csrf: string | null;
  readonly type: 'STAFF' | 'VENDOR' | 'RIDER';
}

interface Tally {
  readonly outcomes: Map<string, number>;
  readonly unexpected: string[];
}

const count = (tally: Tally, key: string): void => {
  tally.outcomes.set(key, (tally.outcomes.get(key) ?? 0) + 1);
};

async function settle(tally: Tally, label: string, work: () => Promise<string>): Promise<void> {
  try {
    count(tally, `${label}:${await work()}`);
  } catch (error) {
    if (isAllowedFailure(error)) count(tally, `${label}:${(error as Error).name}`);
    else
      tally.unexpected.push(
        `${label}: ${isDeadlock(error) ? 'DEADLOCK' : (error as Error).name} ${(error as Error).message}`,
      );
  }
}

/** The live sessions the run holds, to sign out, revoke and read with. */
const live: Held[] = [];

function operations(random: () => number, tally: Tally): (() => Promise<void>)[] {
  const pick = <T>(items: readonly T[]): T | undefined =>
    items[Math.floor(random() * items.length)];
  const issueOf =
    (principal: { type: 'STAFF' | 'VENDOR' | 'RIDER'; id: string }, device?: string) =>
    async () => {
      const issued = await machinery.issuer.issue({
        principal,
        correlationId: `concurrency-${principal.id.slice(0, 8)}`,
        verifiedCredentialGeneration: 1,
        ...(device === undefined ? {} : { registeredDeviceId: device }),
        ...(principal.type === 'RIDER' ? { clientRootSignal: 'NOT_DETECTED' as const } : {}),
      });
      live.push({
        id: issued.session.id,
        token: issued.token,
        csrf: issued.csrfToken,
        type: principal.type,
      });
      return 'issued';
    };
  const kinds: (() => (() => Promise<void>) | undefined)[] = [
    () => {
      const member = pick(staff);
      return member === undefined
        ? undefined
        : () => settle(tally, 'issue-staff', issueOf({ type: 'STAFF', id: member.id }));
    },
    () => {
      const vendor = pick(vendors);
      return vendor === undefined
        ? undefined
        : () =>
            settle(
              tally,
              'issue-vendor',
              issueOf({ type: 'VENDOR', id: vendor.accountId }, vendor.deviceId),
            );
    },
    () => {
      const rider = pick(riders);
      return rider === undefined
        ? undefined
        : () =>
            settle(tally, 'issue-rider', issueOf({ type: 'RIDER', id: rider.id }, rider.deviceId));
    },
    () => {
      const bundle = pick(bundles);
      const reduce = random() < 0.5;
      return bundle === undefined
        ? undefined
        : () =>
            settle(tally, reduce ? 'reduce-bundle' : 'widen-bundle', async () => {
              const client = await migrations.connect();
              try {
                const result = await changeRoleBundle(client, {
                  bundleId: bundle,
                  grants: reduce ? REDUCED : FULL,
                  correlationId: 'concurrency-run',
                });
                ended.bundle += result.endedSessionIds.length;
                return result.kind;
              } finally {
                client.release();
              }
            });
    },
    () => {
      const audience = random() < 0.5 ? ('VENDOR' as const) : ('RIDER' as const);
      const reduction = random() < 0.5;
      // How long the builds still carrying the old revision go on issuing after the database has been told: a rolling release. Drawn
      // here, with the rest of the round, so that a seed still fixes the draws.
      const rollingMs = Math.floor(random() * 10);
      return () =>
        settle(tally, `fixed-${audience.toLowerCase()}`, async () => {
          const client = await migrations.connect();
          try {
            const result = await changeFixedPolicy(client, {
              principalType: audience,
              reduction,
              correlationId: 'concurrency-run',
            });
            // The database has been told; the build that carries the new revision is deployed a moment later. An issue that began before
            // the change either holds the shared lock it waited for, or is refused by the floor it raised; one that begins in the moment
            // runs on the old revision and is refused if the floor rose past it.
            await new Promise((resolve) => setTimeout(resolve, rollingMs));
            released[audience] = Math.max(released[audience], result.revision);
            ended.fixed += result.endedSessionIds.length;
            return result.kind;
          } finally {
            client.release();
          }
        });
    },
    () => {
      const held = pick(live.filter((session) => session.type === 'STAFF'));
      return held === undefined
        ? undefined
        : () =>
            settle(tally, 'sign-out', async () => {
              const response = await presenting(
                routes.kit,
                held.token,
                held.csrf ?? undefined,
              ).delete(`${API}/auth/session`, {
                origin: OPS,
              });
              if (!ALLOWED_STATUSES.has(response.status))
                throw new Error(`answered ${String(response.status)}`);
              return String(response.status);
            });
    },
    () => {
      const held = pick(live);
      return held === undefined
        ? undefined
        : () =>
            settle(tally, 'revoke', async () => {
              const response = await officer.client.post(
                `${API}/auth/sessions/${held.id}/revoke`,
                { reason_code: 'SESSION_SECURITY_CONCERN' },
                { origin: OPS },
              );
              if (!ALLOWED_STATUSES.has(response.status))
                throw new Error(`answered ${String(response.status)}`);
              return String(response.status);
            });
    },
    () => {
      const held = pick(live.filter((session) => session.type === 'STAFF'));
      return held === undefined
        ? undefined
        : () =>
            settle(tally, 'read', async () => {
              const response = await presenting(routes.kit, held.token, held.csrf ?? undefined).get(
                `${API}/auth/session`,
              );
              if (!ALLOWED_STATUSES.has(response.status))
                throw new Error(`answered ${String(response.status)}`);
              return String(response.status);
            });
    },
  ];
  const chosen: (() => Promise<void>)[] = [];
  const size = 8 + Math.floor(random() * 6);
  while (chosen.length < size) {
    const made = pick(kinds)?.();
    if (made !== undefined) chosen.push(made);
  }
  return chosen;
}

/** The checks every run ends with: no session left live below a floor, no advisory lock left held, every request accounted for. */
async function invariants(): Promise<void> {
  const below = await routes.rows<{ count: number }>(
    `select count(*)::int as count from session s join role_bundle b on b.id = s.bundle_id
      where s.terminated_at is null and s.bundle_revision < b.reduction_floor`,
  );
  expect(below[0]?.count, 'a live session below its bundle floor').toBe(0);
  const fixed = await routes.rows<{ count: number }>(
    `select count(*)::int as count from session s join fixed_permission_policy f on f.principal_type = s.principal_type
      where s.terminated_at is null and s.policy_revision < f.minimum_revision`,
  );
  expect(fixed[0]?.count, 'a live Vendor or Rider session below the fixed floor').toBe(0);
  const locks = await routes.rows<{ count: number }>(
    `select count(*)::int as count from pg_locks where locktype = 'advisory' and database = (select oid from pg_database where datname = current_database())`,
  );
  expect(locks[0]?.count, 'an advisory lock left held (Family A)').toBe(0);
}

/** The outcomes of every seed together, for the test that asks what the traffic did. */
const aggregate = new Map<string, number>();

describe('randomised interleavings complete without a deadlock (SECURITY_DESIGN.md section 13.10a, obligation 8)', () => {
  it.each(SEEDS)('seed %i', async (seed) => {
    const random = generator(seed);
    const tally: Tally = { outcomes: new Map(), unexpected: [] };
    const before = await deadlocks();
    for (let round = 0; round < ROUNDS; round += 1) {
      const work = operations(random, tally);
      // Each starts after a jitter the seed decides, so the interleavings differ by round and repeat by seed.
      await Promise.all(
        work.map(
          (operation) =>
            new Promise<void>((resolve) => {
              setTimeout(
                () => {
                  void operation().then(resolve);
                },
                Math.floor(random() * 15),
              );
            }),
        ),
      );
    }
    expect(tally.unexpected, `seed ${String(seed)}`).toEqual([]);
    // Not a vacuous pass: the traffic issued sessions of each audience and reduced bundles, under this seed.
    const happened = [...tally.outcomes.keys()];
    for (const wanted of ['issue-staff:issued', 'reduce-bundle:REDUCTION']) {
      expect(happened, `seed ${String(seed)}`).toContain(wanted);
    }
    expect(
      happened.some((key) => key === 'issue-vendor:issued' || key === 'issue-rider:issued'),
    ).toBe(true);
    await invariants();
    // The statistics of the backends are flushed within ten seconds of their going idle; the count is read until it is stable.
    let after = await deadlocks();
    const deadline = performance.now() + 12_000;
    while (performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      after = await deadlocks();
    }
    expect(after - before, `deadlocks the server broke under seed ${String(seed)}`).toBe(0);
    for (const [key, times] of tally.outcomes)
      aggregate.set(key, (aggregate.get(key) ?? 0) + times);
    console.info(
      `seed ${String(seed)}: ${JSON.stringify(Object.fromEntries([...tally.outcomes].toSorted()))}`,
    );
  });

  // Break caught: a traffic that stopped doing something and still passed (no sign-out that reached a live session, no revocation that
  // revoked, no fixed-policy reduction that ended a session), so that "no deadlock" meant "nothing ran that could deadlock".
  it('had each effect it is judged on, across the seeds: every audience issued, both changes made, a floor ended sessions, a session was signed out and revoked', () => {
    const keys = [...aggregate.keys()];
    for (const wanted of [
      'issue-staff:issued',
      'issue-vendor:issued',
      'issue-rider:issued',
      'reduce-bundle:REDUCTION',
      'widen-bundle:ADDITION',
      'fixed-vendor:REDUCTION',
      'fixed-rider:REDUCTION',
      'read:200',
    ]) {
      expect(keys, 'what the traffic did, across the seeds').toContain(wanted);
    }
    // A sign-out and a revocation that reached a live session: a success, and not only the refusal of an ended one.
    expect(
      keys.some((key) => key.startsWith('sign-out:2')),
      'a sign-out that reached a live session',
    ).toBe(true);
    expect(
      keys.some((key) => key.startsWith('revoke:2')),
      'a revocation that revoked',
    ).toBe(true);
    expect(ended.bundle, 'sessions a bundle reduction ended').toBeGreaterThan(0);
    expect(ended.fixed, 'sessions a fixed-policy reduction ended').toBeGreaterThan(0);
  });
});

describe('a fixed-policy reduction racing the sign-ins of its audience, over and over (obligation 2 on the fixed floor, under load)', () => {
  // Break caught: a sign-in under a build older than the floor (a rolling release: the database has been told, the old build still serves),
  // which must be refused and is not; and a session left live below a floor a reduction raised, found after every round. Not caught here: a
  // sign-in that does not take the shared lock of the fixed policy at all. Run with that line removed, neither this test nor the seeds
  // above found a session below the floor in every run (the seeds found one in one run of two); that break is caught, every time, by
  // session-issue.db.test.ts, which asks for the lock one case at a time. This is the same protocol under volume, for the floor and
  // for the order of the locks.
  it.each(['VENDOR', 'RIDER'] as const)(
    '%s: a build below the raised floor issues nothing, and no live session is left below it after any round',
    async (audience) => {
      const random = generator((SEEDS[0] ?? 1) + audience.length);
      const members =
        audience === 'VENDOR'
          ? vendors.map((vendor) => ({ id: vendor.accountId, device: vendor.deviceId }))
          : riders.map((rider) => ({ id: rider.id, device: rider.deviceId }));
      const failures: string[] = [];
      let issued = 0;
      let refused = 0;
      let refusedByTheFloor = 0;
      let endedHere = 0;
      const signIn = (member: { id: string; device: string }, issuer = machinery.issuer) =>
        issuer.issue({
          principal: { type: audience, id: member.id },
          correlationId: 'fixed-race',
          verifiedCredentialGeneration: 1,
          registeredDeviceId: member.device,
          ...(audience === 'RIDER' ? { clientRootSignal: 'NOT_DETECTED' as const } : {}),
        });
      const later = (work: () => Promise<void>): Promise<void> =>
        new Promise<void>((resolve) => {
          setTimeout(
            () => {
              void work().then(resolve);
            },
            Math.floor(random() * 6),
          );
        });
      for (let round = 0; round < 25; round += 1) {
        await Promise.all([
          ...members.flatMap((member) =>
            [0, 1].map(() =>
              later(async () => {
                try {
                  await signIn(member);
                  issued += 1;
                } catch (error) {
                  if (isAllowedFailure(error)) refused += 1;
                  else failures.push(`${(error as Error).name}: ${(error as Error).message}`);
                }
              }),
            ),
          ),
          later(async () => {
            // A build that goes on carrying the revision the floor is about to pass: an instance of the rolling release that is not
            // replaced yet. It is its own issuer, so that the new build below can be deployed the moment the change commits.
            const behind = released[audience];
            const oldBuild = assemble(routes.built, {
              identities: machinery.identities,
              compiledPolicy: audience === 'VENDOR' ? { VENDOR: behind } : { RIDER: behind },
            }).issuer;
            const client = await migrations.connect();
            try {
              const result = await changeFixedPolicy(client, {
                principalType: audience,
                reduction: true,
                correlationId: 'fixed-race',
              });
              released[audience] = Math.max(released[audience], result.revision);
              endedHere += result.endedSessionIds.length;
              ended.fixed += result.endedSessionIds.length;
              // The floor has risen: the old build is asked to sign each member in, and every one of them is refused by it.
              const attempts = await Promise.allSettled(
                members.map((member) => signIn(member, oldBuild)),
              );
              for (const attempt of attempts) {
                if (attempt.status === 'fulfilled') {
                  failures.push('a sign-in under the old revision succeeded after the floor rose');
                } else if (
                  attempt.reason instanceof FixedPolicyUnavailableError &&
                  attempt.reason.reason === 'BELOW_FLOOR'
                ) {
                  refusedByTheFloor += 1;
                } else {
                  failures.push(
                    `the old build was refused for another reason: ${(attempt.reason as Error).name}`,
                  );
                }
              }
            } catch (error) {
              if (isAllowedFailure(error)) refused += 1;
              else failures.push(`${(error as Error).name}: ${(error as Error).message}`);
            } finally {
              client.release();
            }
          }),
        ]);
        await invariants();
      }
      expect(failures).toEqual([]);
      expect(issued, 'sign-ins succeeded between the reductions').toBeGreaterThan(0);
      expect(endedHere, 'reductions ended sessions that sign-ins had made').toBeGreaterThan(0);
      expect(
        refusedByTheFloor,
        'the old build was refused by the floor after every reduction',
      ).toBe(25 * members.length);
      console.info(
        `${audience} fixed-policy race: ${String(issued)} issued, ${String(refused)} refused, ${String(refusedByTheFloor)} refused by the floor, ${String(endedHere)} sessions ended by the reductions`,
      );
    },
  );
});

describe('a stream of sign-ins does not starve a reduction (obligation 10, on this server)', () => {
  // Break caught: a lock protocol under which shared requests that keep arriving keep an exclusive one waiting past its deadline;
  // PostgreSQL queues a new shared request behind an exclusive one already waiting, and this is that behaviour, proved here.
  it('takes each reduction’s lock within its deadline while four sign-ins run without pause, and the sign-ins go on', async () => {
    const bundle = bundles[0] ?? '';
    const members = staff.filter((member) => member.bundle === bundle);
    const stream = { running: true };
    let issued = 0;
    const failures: string[] = [];
    const streams = Array.from({ length: 4 }, async (_, lane) => {
      while (stream.running) {
        const member = members[(issued + lane) % members.length];
        if (member === undefined) break;
        try {
          await machinery.issuer.issue({
            principal: { type: 'STAFF', id: member.id },
            correlationId: 'starvation-stream',
            verifiedCredentialGeneration: 1,
          });
          issued += 1;
        } catch (error) {
          if (!isAllowedFailure(error))
            failures.push(`${(error as Error).name}: ${(error as Error).message}`);
        }
      }
    });
    const waits: number[] = [];
    const lockTimeoutMs = 2_000;
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      for (const grants of [REDUCED, FULL, REDUCED, FULL, REDUCED]) {
        const before = issued;
        const client = await migrations.connect();
        const started = performance.now();
        try {
          await changeRoleBundle(
            client,
            { bundleId: bundle, grants, correlationId: 'starvation' },
            { lockTimeoutMs },
          );
        } finally {
          client.release();
        }
        waits.push(Math.round(performance.now() - started));
        // The sign-ins go on around the change: given a few seconds on a loaded machine, not a fixed hundred milliseconds.
        const patience = performance.now() + 5_000;
        while (issued <= before && performance.now() < patience) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(issued, 'the sign-ins went on around the change').toBeGreaterThan(before);
      }
    } finally {
      stream.running = false;
      await Promise.all(streams);
    }
    expect(failures).toEqual([]);
    expect(Math.max(...waits)).toBeLessThan(lockTimeoutMs);
    await invariants();
    const version = await routes.rows<{ version: string }>(`select version()`);
    console.info(
      `starvation: ${String(issued)} sign-ins; change waits ${JSON.stringify(waits)} ms; ${version[0]?.version ?? ''}`,
    );
  });
});

/** An identity directory that counts the reads of discovery: a sign-in that restarts on a reassignment reads again. */
function counting(inner: IdentityDirectory, reads: { count: number }): IdentityDirectory {
  return new Proxy(inner, {
    get(target, property) {
      if (property === 'readIdentity') {
        return (transaction: TransactionHandle, ref: PrincipalRef) => {
          reads.count += 1;
          return target.readIdentity(transaction, ref);
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

/**
 * A probe on the table of sessions: when a session row is inserted, the bundle the identity holds at that instant is written beside the
 * bundle the session was made from. Under the protocol the two are one (the identity is locked and its bundle's lock is held until the
 * commit), however often the identity is reassigned; a row where they differ is a session made from a bundle the identity did not hold.
 * Both bundles are the identity's own over the run, so a check made afterwards, against either of them, could not tell.
 */
const PROBE_SQL = `
  create table binding_probe (session_id uuid primary key, bundle_id uuid not null, held_bundle_id uuid);
  create function binding_probe_record() returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
  begin
    insert into binding_probe (session_id, bundle_id, held_bundle_id)
    select new.id, new.bundle_id, s.role_bundle_id from staff_identity s where s.id = new.principal_id;
    return new;
  end $$;
  create trigger zz_binding_probe before insert on session for each row execute function binding_probe_record();`;
const PROBE_DROP_SQL = `
  drop trigger if exists zz_binding_probe on session;
  drop function if exists binding_probe_record();
  drop table if exists binding_probe;`;

describe('an identity reassigned over and over while it signs in (obligation 11, under load)', () => {
  // Break caught: a restart with no bound, or one that wrote part of the act (a session, its audit event) before the revalidation passed;
  // a revalidation that never happens (no sign-in restarts, however often the identity moves); a session made from a bundle the identity
  // no longer held when the row was written.
  it('issues each session from the bundle the identity holds under the locks, or gives up within its bound, and writes nothing else', async () => {
    const [first, second] = bundles;
    if (first === undefined || second === undefined) throw new Error('two bundles are arranged');
    const row = await insertStaff(routes.admin, staffRow({ roleBundleId: first }));
    const reads = { count: 0 };
    const counted = assemble(routes.built, {
      identities: counting(new PostgresStaffIdentityDirectory(), reads),
    });
    await routes.admin.query(PROBE_SQL);
    const stream = { running: true };
    const flips = { count: 0 };
    let issued = 0;
    let gaveUp = 0;
    const failures: string[] = [];
    let flipper: Promise<void> | undefined;
    try {
      flipper = (async () => {
        while (stream.running) {
          await routes.admin.query(
            `update staff_identity set role_bundle_id = case when role_bundle_id = $2 then $3::uuid else $2::uuid end where id = $1`,
            [row.id, first, second],
          );
          flips.count += 1;
          await new Promise((resolve) => setTimeout(resolve, 3));
        }
      })();
      const deadlineAt = performance.now() + 4_000;
      await Promise.all(
        Array.from({ length: 4 }, async () => {
          while (performance.now() < deadlineAt) {
            try {
              await counted.issuer.issue({
                principal: { type: 'STAFF', id: row.id },
                correlationId: 'reassigned-under-load',
                verifiedCredentialGeneration: 1,
              });
              issued += 1;
            } catch (error) {
              if (
                error instanceof PolicyCoordinationError ||
                error instanceof DatabaseDeadlineError
              )
                gaveUp += 1;
              else failures.push(`${(error as Error).name}: ${(error as Error).message}`);
            }
          }
        }),
      );
    } finally {
      stream.running = false;
      await flipper;
    }
    try {
      expect(failures).toEqual([]);
      expect(issued, 'some sign-ins succeeded under the reassignments').toBeGreaterThan(0);
      expect(flips.count, 'the identity was reassigned over and over').toBeGreaterThan(20);
      // Every sign-in reads the identity once for each attempt it makes; more reads than sign-ins is a restart on a reassignment.
      expect(
        reads.count,
        'sign-ins restarted when the identity moved (reads of discovery beyond one for each sign-in)',
      ).toBeGreaterThan(issued + gaveUp + failures.length);

      // The probe: each session was made from the bundle the identity held when its row was written, and both bundles were used.
      const probed = (
        await routes.admin.query<{
          session_id: string;
          bundle_id: string;
          held_bundle_id: string | null;
        }>(`select session_id, bundle_id, held_bundle_id from binding_probe`)
      ).rows;
      expect(probed, 'a probe row for each session').toHaveLength(issued);
      expect(
        probed.filter((probe) => probe.bundle_id !== probe.held_bundle_id),
        'sessions made from a bundle the identity did not hold when the row was written',
      ).toEqual([]);
      expect(
        new Set(probed.map((probe) => probe.bundle_id)),
        'sessions were made from each of the two bundles',
      ).toEqual(new Set([first, second]));

      // Every session is from that bundle's content (its revision is not ahead of the bundle's), and the ledger holds exactly one issue
      // event for each: a restart wrote nothing.
      const sessions = await routes.rows<{ bundle_id: string; consistent: boolean }>(
        `select s.bundle_id, (s.bundle_snapshot->>'audience' = 'STAFF' and s.bundle_revision <= b.revision) as consistent
           from session s join role_bundle b on b.id = s.bundle_id where s.principal_id = $1`,
        [row.id],
      );
      expect(sessions).toHaveLength(issued);
      expect(sessions.every((session) => session.consistent)).toBe(true);
      const events = await routes.rows<{ count: number }>(
        `select count(*)::int as count from audit_event where event_code = 'auth.session.issued' and actor_id = $1`,
        [row.id],
      );
      expect(events[0]?.count).toBe(issued);
      await invariants();
      console.info(
        `reassigned under load: ${String(issued)} issued, ${String(gaveUp)} gave up within the bound, ${String(flips.count)} reassignments, ${String(reads.count - issued - gaveUp)} restarts`,
      );
    } finally {
      await routes.admin.query(PROBE_DROP_SQL);
    }
  });
});

describe('the instruments of this run see what they look for', () => {
  // Break caught: a floor check that cannot see a session left below a floor (a join that matches nothing, a comparison the wrong way
  // round), so that every reduction of the run above "ended what it should" because the check could not fail. The floors are raised
  // here the way a broken reduction would leave them: the revision and the floor, with no session ended.
  it('sees a live session below its bundle floor, and a live Vendor session below the fixed floor', async () => {
    const bundle = bundles[0] ?? '';
    const member = staff.find((candidate) => candidate.bundle === bundle);
    const vendor = vendors[0];
    if (member === undefined || vendor === undefined)
      throw new Error('a member and a vendor exist');
    await invariants();

    await machinery.issuer.issue({
      principal: { type: 'STAFF', id: member.id },
      correlationId: 'instrument-floor',
      verifiedCredentialGeneration: 1,
    });
    await routes.admin.query(
      `update role_bundle set revision = revision + 1, reduction_floor = revision + 1 where id = $1`,
      [bundle],
    );
    await expect(invariants()).rejects.toThrow(/a live session below its bundle floor/);
    // The raised floor is above every session the bundle has live (the run left hundreds), so all of them are ended, as a reduction would.
    const leftBelow = await routes.admin.query(
      `update session set terminated_at = now(), termination_reason = 'SIGNED_OUT' where bundle_id = $1 and terminated_at is null`,
      [bundle],
    );
    expect(leftBelow.rowCount).toBeGreaterThan(0);
    await invariants();

    await machinery.issuer.issue({
      principal: { type: 'VENDOR', id: vendor.accountId },
      correlationId: 'instrument-floor',
      verifiedCredentialGeneration: 1,
      registeredDeviceId: vendor.deviceId,
    });
    const raised = await routes.admin.query<{ minimum_revision: number }>(
      `update fixed_permission_policy set revision = revision + 1, minimum_revision = revision + 1
        where principal_type = 'VENDOR' returning minimum_revision::int as minimum_revision`,
    );
    await expect(invariants()).rejects.toThrow(
      /a live Vendor or Rider session below the fixed floor/,
    );
    const vendorsBelow = await routes.admin.query(
      `update session set terminated_at = now(), termination_reason = 'SIGNED_OUT' where principal_type = 'VENDOR' and terminated_at is null`,
    );
    expect(vendorsBelow.rowCount).toBeGreaterThan(0);
    await invariants();
    // The build that carries the raised revision is the one that serves from here on (nothing after this test issues a Vendor session).
    released.VENDOR = Math.max(released.VENDOR, raised.rows[0]?.minimum_revision ?? 0);
  });

  // Break caught: a deadlock verdict read from a counter that never moves, or a lock-leak check that cannot see a lock. Last in the file,
  // so that the deadlock it makes on purpose is not counted against a run above.
  it('counts a deadlock the server breaks, recognises its error, and sees an advisory lock that is held', async () => {
    const first = clientFor(routes.database.urlFor('postgres'));
    const second = clientFor(routes.database.urlFor('postgres'));
    await first.connect();
    await second.connect();
    try {
      await first.query(`create table instrument_rows (id int primary key, n int)`);
      await first.query(`insert into instrument_rows values (1, 0), (2, 0)`);
      const before = await deadlocks();
      await first.query('begin');
      await second.query('begin');
      await first.query(`update instrument_rows set n = 1 where id = 1`);
      await second.query(`update instrument_rows set n = 1 where id = 2`);
      const crossing = await Promise.allSettled([
        first.query(`update instrument_rows set n = 2 where id = 2`),
        second.query(`update instrument_rows set n = 2 where id = 1`),
      ]);
      await first.query('rollback');
      await second.query('rollback');
      const broken = crossing.filter(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      expect(broken).toHaveLength(1);
      expect(isDeadlock(broken[0]?.reason)).toBe(true);
      let after = before;
      const deadline = performance.now() + 15_000;
      while (after === before && performance.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        after = await deadlocks();
      }
      expect(after - before).toBe(1);

      await first.query(`select pg_advisory_lock(424242)`);
      await expect(invariants()).rejects.toThrow(/advisory lock left held/);
      await first.query(`select pg_advisory_unlock(424242)`);
      await invariants();
    } finally {
      await first.end();
      await second.end();
    }
  });
});
