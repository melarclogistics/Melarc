import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hotp } from '../../src/platform/auth/crypto/hotp.js';
import type { MfaFactorStore } from '../../src/platform/auth/mfa/mfa-factor-store.js';
import { MFA_FACTOR_STORE } from '../../src/platform/auth/mfa/mfa-providers.js';
import { HASHER, type Hasher } from '../../src/platform/auth/ports/hasher.port.js';
import { UNIT_OF_WORK, type UnitOfWork } from '../../src/platform/auth/ports/unit-of-work.port.js';
import type { TestClient } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { insertStaff, staffRow, type StaffRow } from './support/identities.js';
import { backendPidOf, waitUntilBlockedBy, waitUntilTrue } from './support/lock-wait.js';
import { systemContext } from './support/rls-fixture.js';
import { clientFor } from './support/test-database.js';
import { API, OPS, startStaffRoutes, type StaffRoutes } from './support/staff-routes.js';

/**
 * The password step meeting a competing transaction on the trusted browser it presents (G02 of the audit of 26 October 2026; migration
 * 0039), through the real application: a person's own removal of the browser holds its row without the identity lock the sign-in takes,
 * and the sign-in has to wait for it. What the sign-in answers when it is let go is judged on the clock **after** the wait: a browser whose
 * seven days ran out during it asks for the code (`202`, the ordinary challenge, no session), one that is still valid is used, and one the
 * other transaction removed and committed is not. Every wait is observed (`pg_blocking_pids`) and ended by the test, never by a sleep.
 * They are tests of a business race and not of the timeouts, so the application's lock bound is lengthened for this file alone.
 */
const PASSWORD = 'correct horse battery staple';
const SIGN_IN = `${API}/auth/staff/sign-in`;
const MFA = `${API}/auth/staff/sign-in/mfa`;
const COOKIE = 'melarc_trusted_browser';
const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36';

let routes: StaffRoutes;
let hashed: string;

beforeAll(async () => {
  routes = await startStaffRoutes({
    env: {
      DATABASE_LOCK_TIMEOUT_MS: '20000',
      DATABASE_STATEMENT_TIMEOUT_MS: '25000',
      DATABASE_TRANSACTION_TIMEOUT_MS: '30000',
    },
  });
  const hasher = routes.kit.app.app.get<Hasher>(HASHER, { strict: false });
  hashed = await hasher.hash('STAFF_PASSWORD', PASSWORD);
});

afterAll(async () => {
  await routes.stop();
});

interface Privileged {
  readonly row: StaffRow;
  readonly seed: Uint8Array;
}

/** A privileged identity with a proven authenticator whose seed the test holds, and a password. */
async function privileged(): Promise<Privileged> {
  const row = await insertStaff(
    routes.admin,
    staffRow({ credentialHash: hashed, roleBundleId: BUNDLE_IDS.seniorOps }),
  );
  const seed = new Uint8Array(randomBytes(20));
  const factors = routes.kit.app.app.get<MfaFactorStore>(MFA_FACTOR_STORE, { strict: false });
  const unitOfWork = routes.kit.app.app.get<UnitOfWork>(UNIT_OF_WORK, { strict: false });
  await unitOfWork.run(systemContext('authentication'), async (handle) => {
    const factor = await factors.create(handle, {
      staffIdentityId: row.id,
      createdByPurpose: 'STAFF_CREDENTIAL_SETUP',
      seed,
    });
    await factors.activate(handle, factor.id, '0');
  });
  return { row, seed };
}

const signIn = (client: TestClient, who: Privileged, cookie?: string) =>
  client.post(
    SIGN_IN,
    { email: who.row.workEmail, password: PASSWORD },
    {
      origin: OPS,
      headers: {
        'user-agent': CHROME,
        ...(cookie === undefined ? {} : { cookie: `${COOKIE}=${cookie}` }),
      },
    },
  );

/** The whole remembered sign-in of a browser, and the credential it was given. */
async function remembered(who: Privileged): Promise<{ cookie: string; id: string }> {
  const browser = routes.kit.client.fork();
  const first = await signIn(browser, who);
  expect(first.status).toBe(202);
  routes.kit.clock.advance(30_000);
  const second = await browser.post(
    MFA,
    {
      challenge_id: (first.json() as { challenge_id: string }).challenge_id,
      code: hotp(who.seed, Math.floor(routes.kit.clock.now().getTime() / 30_000), 6),
      trust_browser: true,
    },
    { origin: OPS, headers: { 'user-agent': CHROME } },
  );
  expect(second.status).toBe(200);
  const cookie = browser.cookie(COOKIE);
  if (cookie === undefined) throw new Error('No trusted browser was issued.');
  const stored = await routes.admin.query<{ id: string }>(
    'select id from trusted_browser where staff_identity_id = $1',
    [who.row.id],
  );
  const id = stored.rows[0]?.id;
  if (id === undefined) throw new Error('The trusted browser is not stored.');
  return { cookie, id };
}

interface Held {
  readonly client: ReturnType<typeof clientFor>;
  readonly pid: number;
}

/** A transaction of its own that holds the browser's row, as a person's removal of it would, and has not ended. */
async function holding(id: string): Promise<Held> {
  const client = clientFor(routes.database.urlFor('postgres'));
  await client.connect();
  await client.query('begin');
  await client.query('select id from trusted_browser where id = $1 for update', [id]);
  return { client, pid: await backendPidOf(client) };
}

/** Makes the browser end `interval` from now on the database's clock, past the guards (only the administrator can). */
async function endsIn(id: string, interval: string): Promise<void> {
  await routes.admin.query('begin');
  try {
    await routes.admin.query('set local session_replication_role = replica');
    await routes.admin.query(
      'update trusted_browser set expires_at = clock_timestamp() + $2::interval where id = $1',
      [id, interval],
    );
    await routes.admin.query('commit');
  } catch (error) {
    await routes.admin.query('rollback');
    throw error;
  }
}

const sessionsOf = (who: Privileged): Promise<number> =>
  routes.kit.observe.count('session', { principal_id: who.row.id });

const settled = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );

describe('the password step, waiting for the trusted browser it presents (audit G02)', () => {
  // Break caught: the instant taken before the wait for the row (migration 0033): the browser's seven days ran out while the sign-in
  // waited, and it was still found valid and signed in without the code.
  it('asks for the code of a browser whose end passed while the sign-in waited: the ordinary challenge, no session', async () => {
    const who = await privileged();
    const { cookie, id } = await remembered(who);
    const sessionsBefore = await sessionsOf(who);
    await endsIn(id, '3 seconds');
    const held = await holding(id);
    try {
      const outcome = settled(signIn(routes.kit.client.fork(), who, cookie));
      await waitUntilBlockedBy(routes.admin, held.pid, 'the sign-in');
      const before = await routes.admin.query<{ ready: boolean }>(
        'select clock_timestamp() < expires_at as ready from trusted_browser where id = $1',
        [id],
      );
      expect(before.rows[0]?.ready, 'the sign-in began to wait before the browser’s end').toBe(
        true,
      );
      await waitUntilTrue(
        routes.admin,
        'select clock_timestamp() > expires_at as ready from trusted_browser where id = $1',
        [id],
        'the browser’s end',
      );
      await held.client.query('rollback');

      const settledOutcome = await outcome;
      if ('error' in settledOutcome) throw settledOutcome.error as Error;
      const response = settledOutcome.value;
      expect(response.status).toBe(202);
      expect(response.setCookies).toEqual([]);
      expect(Object.keys(response.json() as object).toSorted()).toEqual([
        'challenge_id',
        'expires_at',
        'trusted_browser_days',
      ]);
    } finally {
      await held.client.end();
    }
    expect(await sessionsOf(who)).toBe(sessionsBefore);
    const row = await routes.admin.query<{ last_used_at: Date | null }>(
      'select last_used_at from trusted_browser where id = $1',
      [id],
    );
    expect(row.rows[0]?.last_used_at).toBeNull();
  });

  it('signs in a browser that is still valid when the other transaction ends unchanged, and records the use after the wait', async () => {
    const who = await privileged();
    const { cookie, id } = await remembered(who);
    const sessionsBefore = await sessionsOf(who);
    const held = await holding(id);
    let releasedAt: Date;
    try {
      const outcome = settled(signIn(routes.kit.client.fork(), who, cookie));
      await waitUntilBlockedBy(routes.admin, held.pid, 'the sign-in');
      const now = await routes.admin.query<{ now: Date }>('select clock_timestamp() as now');
      releasedAt = now.rows[0]?.now ?? new Date(0);
      await held.client.query('rollback');

      const settledOutcome = await outcome;
      if ('error' in settledOutcome) throw settledOutcome.error as Error;
      expect(settledOutcome.value.status).toBe(200);
    } finally {
      await held.client.end();
    }
    expect(await sessionsOf(who)).toBe(sessionsBefore + 1);
    const row = await routes.admin.query<{ last_used_at: Date | null }>(
      'select last_used_at from trusted_browser where id = $1',
      [id],
    );
    expect(row.rows[0]?.last_used_at?.getTime()).toBeGreaterThanOrEqual(releasedAt.getTime());
  });

  // Break caught: a browser the other transaction removed and committed during the wait, used from the row as it was before it.
  it('asks for the code of a browser the other transaction removed and committed, and issues no session', async () => {
    const who = await privileged();
    const { cookie, id } = await remembered(who);
    const sessionsBefore = await sessionsOf(who);
    const held = await holding(id);
    try {
      const outcome = settled(signIn(routes.kit.client.fork(), who, cookie));
      await waitUntilBlockedBy(routes.admin, held.pid, 'the sign-in');
      await held.client.query(
        `update trusted_browser set revoked_at = clock_timestamp(), revocation_cause = 'SELF', revoked_by = $2 where id = $1`,
        [id, who.row.id],
      );
      await held.client.query('commit');

      const settledOutcome = await outcome;
      if ('error' in settledOutcome) throw settledOutcome.error as Error;
      expect(settledOutcome.value.status).toBe(202);
      expect(settledOutcome.value.setCookies).toEqual([]);
    } finally {
      await held.client.end();
    }
    expect(await sessionsOf(who)).toBe(sessionsBefore);
  });
});
