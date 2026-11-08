import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TransactionHandle } from '../../src/platform/auth/ports/unit-of-work.port.js';
import {
  TrustedBrowserContextError,
  TrustedBrowserRequestError,
} from '../../src/platform/auth/trusted-browsers/trusted-browser-errors.js';
import { TrustedBrowserStore } from '../../src/platform/auth/trusted-browsers/trusted-browser-store.js';
import { serverErrorIn } from '../../src/platform/database/database-failures.js';
import type { SecurityContext } from '../../src/platform/database/transaction-context.js';
import { transactionOf } from '../../src/platform/database/transaction-handle.js';
import { INERT_DEADLINES } from '../../src/platform/config/inert-config.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { ManualClock } from '../../src/test-support/manual-clock.js';
import { activateFactor, factorRow, insertFactor } from './support/credentials.js';
import { withHandle } from './support/handle.js';
import { hashOf, insertStaff, staffRow, type StaffRow } from './support/identities.js';
import { backendPidOf, waitUntilBlockedBy, waitUntilTrue } from './support/lock-wait.js';
import { staffContext, systemContext } from './support/rls-fixture.js';
import { seedReferenceData } from './support/seeded.js';
import { buildService, type BuiltService } from './support/service.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * The store of trusted browsers (`platform/auth/trusted-browsers/`, migration 0033; staff-authentication.md §5.8) against a real PostgreSQL
 * as the API's login: a trusted browser is issued for exactly seven days on the database's clock to an active privileged identity, bound to
 * its active authenticator and to the credential it holds now; at most five are valid at once; the sign-in finds one by its hash and only
 * by the definer function (the runtime cannot select the hash); and each context reaches only the rows its policy names.
 */
let database: TestDatabase;
let admin: pg.Client;
let api: BuiltService;
let store: TrustedBrowserStore;
/** A value a test has arranged and knows is there; a missing one is the test's own defect. */
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('The test arranged this value and it is not there.');
  return value;
}

const clock = new ManualClock();
const authentication = systemContext('authentication');

beforeAll(async () => {
  database = await createTestDatabase();
  await seedReferenceData(database);
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  api = buildService(database, { poolMax: 4 });
  store = new TrustedBrowserStore({ clock });
});

afterAll(async () => {
  await admin.end();
  await api.close();
  await database.drop();
});

interface Person {
  readonly row: StaffRow;
  readonly factorId: string;
}

/** A privileged identity with an `ACTIVE` authenticator: the only kind that ever holds a trusted browser. */
async function person(overrides: Partial<StaffRow> = {}): Promise<Person> {
  const row = await insertStaff(
    admin,
    staffRow({ roleBundleId: BUNDLE_IDS.seniorOps, ...overrides }),
  );
  const factor = await insertFactor(admin, factorRow(row.id));
  await activateFactor(admin, factor.id);
  return { row, factorId: factor.id };
}

const selfContext = (who: Person): SecurityContext => ({
  ...staffContext([], 'ALL'),
  principalId: who.row.id,
});

const administratorContext = (administrator: StaffRow, key: string): SecurityContext => ({
  ...staffContext([], 'ALL'),
  principalId: administrator.id,
  authorizationKey: key,
});

const inTransaction = <T>(
  action: (handle: TransactionHandle) => Promise<T>,
  context: SecurityContext = authentication,
): Promise<T> => withHandle(api.service, context, (handle) => action(handle));

const tokenOf = (label: string): Uint8Array => hashOf(`trusted:${label}:${randomUUID()}`);

const issue = (
  who: Person,
  tokenHash: Uint8Array = tokenOf('issue'),
  label = 'Chrome on Windows',
  credentialGeneration = who.row.credentialGeneration,
) =>
  inTransaction((handle) =>
    store.issue(handle, {
      staffIdentityId: who.row.id,
      tokenHash,
      factorId: who.factorId,
      credentialGeneration,
      label,
    }),
  );

interface BrowserRow {
  readonly id: string;
  readonly revoked_at: Date | null;
  readonly revocation_cause: string | null;
  readonly revoked_by: string | null;
  readonly last_used_at: Date | null;
  readonly created_at: Date;
  readonly expires_at: Date;
}

const rowOf = async (id: string): Promise<BrowserRow> =>
  required(
    (
      await admin.query<BrowserRow>(
        `select id, revoked_at, revocation_cause, revoked_by, last_used_at, created_at, expires_at from trusted_browser where id = $1`,
        [id],
      )
    ).rows[0],
  );

/** A trusted browser as it would be after `days` days, arranged past the guards (only the administrator can back-date one). */
async function agedBrowser(who: Person, tokenHash: Uint8Array, days: number): Promise<string> {
  const id = randomUUID();
  await admin.query('begin');
  try {
    await admin.query(`set local session_replication_role = replica`);
    await admin.query(
      `insert into trusted_browser (id, staff_identity_id, token_hash, factor_id, credential_generation, label, created_at, expires_at)
       values ($1, $2, $3, $4, $5, 'Chrome on Windows', now() - make_interval(days => $6::int), now() - make_interval(days => $6::int) + interval '7 days')`,
      [id, who.row.id, Buffer.from(tokenHash), who.factorId, who.row.credentialGeneration, days],
    );
    await admin.query('commit');
  } catch (error) {
    await admin.query('rollback');
    throw error;
  }
  return id;
}

describe('issue', () => {
  // Break caught: a trusted browser that lasts longer or shorter than seven days from the database's clock, or one made on the
  // application's clock (a ManualClock days behind the database's here), or one that is born used or removed.
  it('issues one for exactly seven days from the database’s clock, unused and not removed', async () => {
    const owner = await person();
    const databaseBefore = (await admin.query<{ now: Date }>('select clock_timestamp() as now'))
      .rows[0]?.now;

    const { browser, replacedIds } = await issue(owner, tokenOf('seven'), 'Firefox on Linux');

    expect(replacedIds).toEqual([]);
    expect(browser).toMatchObject({
      staffIdentityId: owner.row.id,
      factorId: owner.factorId,
      label: 'Firefox on Linux',
      lastUsedAt: null,
      revokedAt: null,
      revocationCause: null,
    });
    expect(browser.expiresAt.getTime() - browser.createdAt.getTime()).toBe(7 * 24 * 60 * 60_000);
    expect(Math.abs(browser.createdAt.getTime() - (databaseBefore?.getTime() ?? 0))).toBeLessThan(
      10_000,
    );
    expect(Math.abs(browser.createdAt.getTime() - clock.now().getTime())).toBeGreaterThan(60_000);
    expect(browser.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  // Break caught: the credential stored in the clear, or anywhere in a column the runtime can read.
  it('stores the hash it was given and nothing the runtime can read back', async () => {
    const owner = await person();
    const hash = tokenOf('hidden');

    const { browser } = await issue(owner, hash);

    const stored = await admin.query<{ token_hash: Buffer }>(
      'select token_hash from trusted_browser where id = $1',
      [browser.id],
    );
    expect(Buffer.compare(stored.rows[0]?.token_hash ?? Buffer.alloc(0), Buffer.from(hash))).toBe(
      0,
    );
    await expect(
      inTransaction((handle) =>
        transactionOf(handle).execute(sql`select token_hash from trusted_browser`),
      ),
    ).rejects.toSatisfy((error) => serverErrorIn(error)?.code === '42501');
    expect(JSON.stringify(browser)).not.toContain(Buffer.from(hash).toString('hex'));
  });

  // Break caught: a trusted browser for an identity that signs in without an authenticator, or one that is not ACTIVE.
  it('refuses an identity that is not privileged, and one that is not active', async () => {
    const opsStaff = await insertStaff(admin, staffRow());
    const factor = await insertFactor(admin, factorRow(opsStaff.id));
    await activateFactor(admin, factor.id);
    const suspended = await person();
    await admin.query('begin');
    await admin.query('set local session_replication_role = replica');
    await admin.query(`update staff_identity set status = 'SUSPENDED' where id = $1`, [
      suspended.row.id,
    ]);
    await admin.query('commit');

    const refused = (error: unknown): boolean =>
      serverErrorIn(error)?.message.includes('active privileged identity') === true;
    await expect(
      issue({ row: opsStaff, factorId: factor.id }, tokenOf('ops'), 'Chrome on Windows'),
    ).rejects.toSatisfy(refused);
    await expect(issue(suspended, tokenOf('suspended'))).rejects.toSatisfy(refused);
  });

  // Break caught: a trusted browser bound to the wrong credential, or to an authenticator that is another identity's or not active.
  it('refuses a stale credential, and an authenticator that is not the identity’s active one', async () => {
    const owner = await person();
    const other = await person();
    const pending = await insertFactor(admin, factorRow(owner.row.id));

    await expect(issue(owner, tokenOf('stale'), 'Chrome on Windows', 2)).rejects.toSatisfy(
      (error) => serverErrorIn(error)?.message.includes('credential it holds now') === true,
    );
    const bound = (error: unknown): boolean =>
      serverErrorIn(error)?.message.includes('active authenticator of its identity') === true;
    await expect(
      inTransaction((handle) =>
        store.issue(handle, {
          staffIdentityId: owner.row.id,
          tokenHash: tokenOf('foreign'),
          factorId: other.factorId,
          credentialGeneration: 1,
          label: 'Chrome on Windows',
        }),
      ),
    ).rejects.toSatisfy(bound);
    await expect(
      inTransaction((handle) =>
        store.issue(handle, {
          staffIdentityId: owner.row.id,
          tokenHash: tokenOf('pending'),
          factorId: pending.id,
          credentialGeneration: 1,
          label: 'Chrome on Windows',
        }),
      ),
    ).rejects.toSatisfy(bound);
  });

  // Break caught: a sixth valid trusted browser, the wrong one giving way, or another identity's browser removed to make room.
  it('keeps at most five valid: a sixth removes the oldest, and only that identity’s', async () => {
    const owner = await person();
    const bystander = await person();
    const kept = (await issue(bystander)).browser;
    const issued: string[] = [];
    for (let n = 0; n < 5; n += 1)
      issued.push((await issue(owner, tokenOf(`cap-${String(n)}`))).browser.id);

    const sixth = await issue(owner, tokenOf('cap-5'));

    expect(sixth.replacedIds).toEqual([issued[0]]);
    expect(await rowOf(required(issued[0]))).toMatchObject({
      revocation_cause: 'REPLACED',
      revoked_by: null,
    });
    for (const id of issued.slice(1)) expect((await rowOf(id)).revoked_at).toBeNull();
    expect((await rowOf(kept.id)).revoked_at).toBeNull();
    const valid = await admin.query(
      `select count(*)::int as n from trusted_browser where staff_identity_id = $1 and revoked_at is null`,
      [owner.row.id],
    );
    expect(valid.rows[0]).toEqual({ n: 5 });
  });

  // Break caught: an expired browser counting toward the five (it is history, not a seat), or an expired one being "removed" as replaced.
  it('does not count an expired trusted browser toward the five', async () => {
    const owner = await person();
    const expired = await agedBrowser(owner, tokenOf('old'), 8);
    for (let n = 0; n < 5; n += 1) await issue(owner, tokenOf(`seat-${String(n)}`));

    expect((await rowOf(expired)).revoked_at).toBeNull();
    const valid = await inTransaction(
      (handle) => store.list(handle, owner.row.id),
      selfContext(owner),
    );
    expect(valid).toHaveLength(5);
  });

  // Break caught: a store that works under a staff context, where row-level security would answer "no row" instead of refusing.
  it('refuses to run outside the authentication capability, and a malformed request before any write', async () => {
    const owner = await person();

    await expect(
      inTransaction(
        (handle) =>
          store.issue(handle, {
            staffIdentityId: owner.row.id,
            tokenHash: tokenOf('x'),
            factorId: owner.factorId,
            credentialGeneration: 1,
            label: 'Chrome on Windows',
          }),
        selfContext(owner),
      ),
    ).rejects.toBeInstanceOf(TrustedBrowserContextError);
    await expect(
      inTransaction((handle) =>
        store.issue(handle, {
          staffIdentityId: owner.row.id,
          tokenHash: new Uint8Array(31),
          factorId: owner.factorId,
          credentialGeneration: 1,
          label: 'Chrome on Windows',
        }),
      ),
    ).rejects.toBeInstanceOf(TrustedBrowserRequestError);
    await expect(
      inTransaction((handle) =>
        store.issue(handle, {
          staffIdentityId: owner.row.id,
          tokenHash: tokenOf('x'),
          factorId: owner.factorId,
          credentialGeneration: 1,
          label: '',
        }),
      ),
    ).rejects.toBeInstanceOf(TrustedBrowserRequestError);
  });
});

describe('use', () => {
  const use = (hash: Uint8Array, who: Person) =>
    inTransaction((handle) => store.use(handle, hash, who.row.id));

  // Break caught: using a browser moving its end (a renewal), or not recording the use.
  it('answers the browser’s id, records the use and moves nothing else', async () => {
    const owner = await person();
    const hash = tokenOf('use');
    const { browser } = await issue(owner, hash);

    expect(await use(hash, owner)).toBe(browser.id);
    const first = await rowOf(browser.id);
    expect(first.last_used_at).not.toBeNull();
    expect(first.expires_at.getTime()).toBe(browser.expiresAt.getTime());

    expect(await use(hash, owner)).toBe(browser.id);
    const second = await rowOf(browser.id);
    expect(second.last_used_at?.getTime()).toBeGreaterThanOrEqual(
      first.last_used_at?.getTime() ?? 0,
    );
    expect(second.expires_at.getTime()).toBe(browser.expiresAt.getTime());
  });

  // Break caught: a credential that is another identity's, unknown, removed or past its end being accepted, or told apart.
  it('answers nothing for an unknown credential, another identity’s, a removed one and an expired one', async () => {
    const owner = await person();
    const stranger = await person();
    const hash = tokenOf('mine');
    const { browser } = await issue(owner, hash);
    const removedHash = tokenOf('removed');
    const removed = (await issue(owner, removedHash)).browser;
    await inTransaction(
      (handle) => store.revokeOne(handle, removed.id, owner.row.id),
      selfContext(owner),
    );
    const expiredHash = tokenOf('expired');
    const expired = await agedBrowser(owner, expiredHash, 8);

    expect(await use(tokenOf('unknown'), owner)).toBeNull();
    expect(await use(hash, stranger)).toBeNull();
    expect(await use(removedHash, owner)).toBeNull();
    expect(await use(expiredHash, owner)).toBeNull();
    expect((await rowOf(removed.id)).last_used_at).toBeNull();
    expect((await rowOf(expired)).last_used_at).toBeNull();
    expect((await rowOf(browser.id)).last_used_at).toBeNull();
  });

  // Break caught: a browser that survives a new password (the generation moved), an identity that is no longer active, or an
  // authenticator that was replaced.
  it('answers nothing once the credential moved, the identity is not active or the authenticator is not the one trusted', async () => {
    const moved = await person();
    const movedHash = tokenOf('moved');
    await issue(moved, movedHash);
    await admin.query(
      `update staff_identity set credential_hash = '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$bmV3', credential_generation = 2,
              credential_established_at = clock_timestamp() where id = $1`,
      [moved.row.id],
    );

    const suspended = await person();
    const suspendedHash = tokenOf('suspended');
    await issue(suspended, suspendedHash);
    await admin.query('begin');
    await admin.query('set local session_replication_role = replica');
    await admin.query(`update staff_identity set status = 'SUSPENDED' where id = $1`, [
      suspended.row.id,
    ]);
    await admin.query('commit');

    const replaced = await person();
    const replacedHash = tokenOf('replaced');
    await issue(replaced, replacedHash);
    await admin.query('begin');
    await admin.query('set local session_replication_role = replica');
    await admin.query(
      `update mfa_factor set status = 'REVOKED', revoked_at = clock_timestamp() where id = $1`,
      [replaced.factorId],
    );
    await admin.query('commit');

    expect(await use(movedHash, moved)).toBeNull();
    expect(await use(suspendedHash, suspended)).toBeNull();
    expect(await use(replacedHash, replaced)).toBeNull();
  });

  // Break caught: the readers of the hash answering anything but the authentication capability.
  it('is refused outside the authentication capability', async () => {
    const owner = await person();
    const hash = tokenOf('ctx');
    await issue(owner, hash);

    await expect(
      inTransaction(
        (handle) =>
          transactionOf(handle).execute(
            sql`select melarc.use_trusted_browser(${Buffer.from(hash)}::bytea, ${owner.row.id}::uuid)`,
          ),
        selfContext(owner),
      ),
    ).rejects.toSatisfy((error) => serverErrorIn(error)?.code === '42501');
    await expect(
      inTransaction((handle) => store.use(handle, hash, owner.row.id), selfContext(owner)),
    ).rejects.toBeInstanceOf(TrustedBrowserContextError);
  });
});

// G02 of the audit of 26 October 2026 (migration 0039): a trusted browser is judged on the clock after the lock on its row is held. The
// sign-in has locked the identity; it has not locked this row, which a person's own removal holds without the identity lock. Each test
// holds the row in a transaction of its own, starts the use, **observes** that the use is waiting (`pg_blocking_pids`, not a sleep), lets
// the browser's end pass where the case needs it, and only then ends the holder's transaction. These are tests of a business race, not of
// the timeouts, so the service that waits has a lock bound that outlasts the test; the bounds of production are untouched.
describe('use, meeting a transaction that holds the same row (audit G02)', () => {
  let patient: BuiltService;

  beforeAll(() => {
    patient = buildService(database, {
      poolMax: 2,
      deadlines: {
        ...INERT_DEADLINES,
        lockTimeoutMs: 20_000,
        statementTimeoutMs: 25_000,
        transactionTimeoutMs: 30_000,
        idleInTransactionTimeoutMs: 30_000,
      },
    });
  });

  afterAll(async () => {
    await patient.close();
  });

  const useWhileWaiting = (hash: Uint8Array, who: Person) =>
    withHandle(patient.service, authentication, (handle) =>
      store.use(handle, hash, who.row.id),
    ).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );

  /** A transaction of its own that holds the browser's row, as a person's removal of it would, and has not ended. */
  async function holding(id: string): Promise<{ client: pg.Client; pid: number }> {
    const client = clientFor(database.urlFor('postgres'));
    await client.connect();
    await client.query('begin');
    await client.query('select id from trusted_browser where id = $1 for update', [id]);
    return { client, pid: await backendPidOf(client) };
  }

  /** Makes a browser end `interval` from now on the database's clock, past the guards (only the administrator can). */
  async function endsIn(id: string, interval: string): Promise<void> {
    await admin.query('begin');
    try {
      await admin.query('set local session_replication_role = replica');
      await admin.query(
        `update trusted_browser set expires_at = clock_timestamp() + $2::interval where id = $1`,
        [id, interval],
      );
      await admin.query('commit');
    } catch (error) {
      await admin.query('rollback');
      throw error;
    }
  }

  // Break caught: the instant taken before the wait for the row (migration 0033), so that a browser whose seven days ran out during the wait
  // still stood in for the code; this is the test that fails for that definition and passes for the new one.
  it('answers nothing for a browser whose end passes while the use waits for its row, and records no use', async () => {
    const owner = await person();
    const hash = tokenOf('ends-while-waiting');
    const { browser } = await issue(owner, hash);
    await endsIn(browser.id, '1500 milliseconds');
    const held = await holding(browser.id);
    try {
      const outcome = useWhileWaiting(hash, owner);
      await waitUntilBlockedBy(admin, held.pid, 'the use of the trusted browser');
      // It began to wait before the end, which is what makes this a race and not a browser that had already ended.
      const before = await admin.query<{ ready: boolean }>(
        `select clock_timestamp() < expires_at as ready from trusted_browser where id = $1`,
        [browser.id],
      );
      expect(before.rows[0]?.ready, 'the use began to wait before the browser’s end').toBe(true);
      await waitUntilTrue(
        admin,
        `select clock_timestamp() > expires_at as ready from trusted_browser where id = $1`,
        [browser.id],
        'the browser’s end',
      );
      await held.client.query('rollback');

      expect(await outcome).toEqual({ value: null });
    } finally {
      await held.client.end();
    }
    expect((await rowOf(browser.id)).last_used_at).toBeNull();
  });

  // Break caught: the instant taken before the wait even for a browser that is still valid (the use recorded as of a moment the use had not
  // yet reached), and a use that fails because it had to wait.
  it('uses a browser that is still valid once the other transaction ends unchanged, at an instant after the wait', async () => {
    const owner = await person();
    const hash = tokenOf('valid-after-waiting');
    const { browser } = await issue(owner, hash);
    const held = await holding(browser.id);
    let releasedAt: Date;
    try {
      const outcome = useWhileWaiting(hash, owner);
      await waitUntilBlockedBy(admin, held.pid, 'the use of the trusted browser');
      const now = await admin.query<{ now: Date }>('select clock_timestamp() as now');
      releasedAt = required(now.rows[0]).now;
      await held.client.query('rollback');

      expect(await outcome).toEqual({ value: browser.id });
    } finally {
      await held.client.end();
    }
    const used = await rowOf(browser.id);
    expect(used.last_used_at?.getTime()).toBeGreaterThanOrEqual(releasedAt.getTime());
    expect(used.expires_at.getTime()).toBe(browser.expiresAt.getTime());
  });

  // Break caught: a browser that was removed (and committed) while the use waited being used from the row as it was before the wait.
  it('answers nothing for a browser the other transaction removed and committed, and records no use', async () => {
    const owner = await person();
    const hash = tokenOf('removed-while-waiting');
    const { browser } = await issue(owner, hash);
    const held = await holding(browser.id);
    try {
      const outcome = useWhileWaiting(hash, owner);
      await waitUntilBlockedBy(admin, held.pid, 'the use of the trusted browser');
      await held.client.query(
        `update trusted_browser set revoked_at = clock_timestamp(), revocation_cause = 'SELF', revoked_by = $2 where id = $1`,
        [browser.id, owner.row.id],
      );
      await held.client.query('commit');

      expect(await outcome).toEqual({ value: null });
    } finally {
      await held.client.end();
    }
    const after = await rowOf(browser.id);
    expect(after.last_used_at).toBeNull();
    expect(after.revocation_cause).toBe('SELF');
  });

  // Break caught: the guard of a use letting a record be made at or after the browser's end, for a writer that is not the function.
  it('refuses a use recorded at or after the browser’s end, for any writer, and accepts one recorded before it', async () => {
    const owner = await person();
    const ended = await agedBrowser(owner, tokenOf('ended'), 8);

    await expect(
      admin.query(`update trusted_browser set last_used_at = now() where id = $1`, [ended]),
    ).rejects.toSatisfy(
      (error) =>
        serverErrorIn(error)?.code === '23514' &&
        (serverErrorIn(error)?.message ?? '').includes('is used before its end'),
    );
    await expect(
      admin.query(`update trusted_browser set last_used_at = expires_at where id = $1`, [ended]),
    ).rejects.toSatisfy((error) => serverErrorIn(error)?.code === '23514');
    await admin.query(
      `update trusted_browser set last_used_at = expires_at - interval '1 second' where id = $1`,
      [ended],
    );
    expect((await rowOf(ended)).last_used_at).not.toBeNull();
  });
});

describe('idFor', () => {
  // Break caught: the browser that is asking not being recognised once it is removed or has ended (the list must still mark it, and the
  // removal must still clear its cookie), or one identity learning another's browsers.
  it('recognises the credential of the identity whatever its state, and no other identity’s', async () => {
    const owner = await person();
    const stranger = await person();
    const hash = tokenOf('known');
    const { browser } = await issue(owner, hash);
    await inTransaction(
      (handle) => store.revokeOne(handle, browser.id, owner.row.id),
      selfContext(owner),
    );

    expect(await inTransaction((handle) => store.idFor(handle, hash, owner.row.id))).toBe(
      browser.id,
    );
    expect(
      await inTransaction((handle) => store.idFor(handle, hash, owner.row.id), selfContext(owner)),
    ).toBe(browser.id);
    expect(await inTransaction((handle) => store.idFor(handle, hash, stranger.row.id))).toBeNull();
    expect(
      await inTransaction((handle) => store.idFor(handle, tokenOf('none'), owner.row.id)),
    ).toBeNull();
    await expect(
      inTransaction((handle) => store.idFor(handle, hash, owner.row.id), selfContext(stranger)),
    ).rejects.toSatisfy((error) => serverErrorIn(error)?.code === '42501');
  });
});

describe('list and revokeOne (the person’s own)', () => {
  // Break caught: a list that shows another person's browsers, a removed one, an expired one, or in the wrong order.
  it('lists the person’s valid trusted browsers, newest first, and nobody else’s', async () => {
    const owner = await person();
    const stranger = await person();
    const older = (await issue(owner, tokenOf('older'), 'Safari on macOS')).browser;
    const newer = (await issue(owner, tokenOf('newer'), 'Edge on Windows')).browser;
    const removed = (await issue(owner, tokenOf('gone'))).browser;
    await inTransaction(
      (handle) => store.revokeOne(handle, removed.id, owner.row.id),
      selfContext(owner),
    );
    await agedBrowser(owner, tokenOf('ended'), 9);
    await issue(stranger, tokenOf('theirs'));

    const listed = await inTransaction(
      (handle) => store.list(handle, owner.row.id),
      selfContext(owner),
    );

    expect(listed.map((browser) => browser.id)).toEqual([newer.id, older.id]);
    expect(listed.map((browser) => browser.label)).toEqual(['Edge on Windows', 'Safari on macOS']);
    expect(JSON.stringify(listed)).not.toMatch(/token|hash/i);
    // asking for another identity's list under one's own context shows nothing
    expect(
      await inTransaction((handle) => store.list(handle, stranger.row.id), selfContext(owner)),
    ).toEqual([]);
  });

  // Break caught (the audit of 26 October 2026, decision 7): a browser trusted on a password that has since been replaced still listed as
  // usable. It cannot sign anyone in (`use` judges the generation), and the list must not say it can. The reset and the replacement of an
  // authenticator remove their browsers in their own transaction, and a password replacement must do the same when it is built; this is the
  // list's own line of defence for a database in which it did not.
  it('does not list a browser whose credential moved, or whose identity is no longer active', async () => {
    const moved = await person();
    const suspended = await person();
    const current = await person();
    await issue(moved, tokenOf('before-the-new-password'));
    await issue(suspended, tokenOf('before-the-suspension'));
    const kept = (await issue(current, tokenOf('current'))).browser;
    await admin.query(
      `update staff_identity set credential_hash = '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$bmV3', credential_generation = 2,
              credential_established_at = clock_timestamp() where id = $1`,
      [moved.row.id],
    );
    await admin.query('begin');
    await admin.query('set local session_replication_role = replica');
    await admin.query(`update staff_identity set status = 'SUSPENDED' where id = $1`, [
      suspended.row.id,
    ]);
    await admin.query('commit');

    const listOf = (who: Person) =>
      inTransaction((handle) => store.list(handle, who.row.id), selfContext(who));

    expect(await listOf(moved)).toEqual([]);
    expect(await listOf(suspended)).toEqual([]);
    expect((await listOf(current)).map((browser) => browser.id)).toEqual([kept.id]);
  });

  // Break caught: a removal that leaves the row usable, records no one, or reaches another person's browser.
  it('removes one of the person’s own once, and tells another person’s from an absent one by nothing', async () => {
    const owner = await person();
    const stranger = await person();
    const mine = (await issue(owner)).browser;
    const theirs = (await issue(stranger)).browser;

    const removeMine = () =>
      inTransaction((handle) => store.revokeOne(handle, mine.id, owner.row.id), selfContext(owner));
    expect(await removeMine()).toBe(true);
    expect(await removeMine()).toBe(false);
    expect(await rowOf(mine.id)).toMatchObject({
      revocation_cause: 'SELF',
      revoked_by: owner.row.id,
    });
    expect(
      await inTransaction(
        (handle) => store.revokeOne(handle, theirs.id, owner.row.id),
        selfContext(owner),
      ),
    ).toBe(false);
    expect(
      await inTransaction(
        (handle) => store.revokeOne(handle, randomUUID(), owner.row.id),
        selfContext(owner),
      ),
    ).toBe(false);
    expect((await rowOf(theirs.id)).revoked_at).toBeNull();
  });

  // Break caught: a person removing a browser in someone else's name (the policy checks the revoker is the acting identity).
  it('cannot record another identity as the one who removed it', async () => {
    const owner = await person();
    const stranger = await person();
    const mine = (await issue(owner)).browser;

    const removed = await inTransaction(
      (handle) => store.revokeOne(handle, mine.id, stranger.row.id),
      selfContext(owner),
    );

    expect(removed).toBe(false);
    expect((await rowOf(mine.id)).revoked_at).toBeNull();
  });
});

describe('revokeAll', () => {
  // Break caught: the system's removal naming a person, or a cause outside the closed set reaching the table.
  it('removes every trusted browser of an identity for the system’s causes, naming nobody', async () => {
    const owner = await person();
    const bystander = await person();
    const ids = [(await issue(owner)).browser.id, (await issue(owner, tokenOf('b'))).browser.id];
    const spared = (await issue(bystander)).browser.id;

    const count = await inTransaction((handle) =>
      store.revokeAll(handle, {
        staffIdentityId: owner.row.id,
        cause: 'FACTOR_REPLACED',
        revokedBy: null,
      }),
    );

    expect(count).toHaveLength(2);
    for (const id of ids) {
      expect(await rowOf(id)).toMatchObject({
        revocation_cause: 'FACTOR_REPLACED',
        revoked_by: null,
      });
    }
    expect((await rowOf(spared)).revoked_at).toBeNull();
    // the table's check holds the closed set of causes even against a caller that ignores the type
    await issue(owner, tokenOf('closed-set'));
    await expect(
      inTransaction((handle) =>
        store.revokeAll(handle, {
          staffIdentityId: owner.row.id,
          cause: 'NOT_A_CAUSE' as never,
          revokedBy: null,
        }),
      ),
    ).rejects.toSatisfy((error) => serverErrorIn(error)?.code === '23514');
  });

  // Break caught: an administrator's removal reaching an identity it did not lock, or being recorded as something else.
  it('lets an administrator remove the browsers of the one identity it locked, with the cause ADMINISTRATOR', async () => {
    const target = await person();
    const bystander = await person();
    const administrator = await insertStaff(
      admin,
      staffRow({ roleBundleId: BUNDLE_IDS.platformAdmin }),
    );
    const mine = (await issue(target)).browser.id;
    const second = (await issue(target, tokenOf('second'))).browser.id;
    const spared = (await issue(bystander)).browser.id;
    const context = administratorContext(administrator, 'staff.session.revoke');

    const removed = await inTransaction(async (handle) => {
      const locked = await transactionOf(handle).execute(
        sql`select identity_id from melarc.staff_locked_facts(${target.row.id}::uuid)`,
      );
      expect(locked.rows).toHaveLength(1);
      return store.revokeAll(handle, {
        staffIdentityId: target.row.id,
        cause: 'ADMINISTRATOR',
        revokedBy: administrator.id,
      });
    }, context);

    expect(removed).toHaveLength(2);
    for (const id of [mine, second]) {
      expect(await rowOf(id)).toMatchObject({
        revocation_cause: 'ADMINISTRATOR',
        revoked_by: administrator.id,
      });
    }
    expect((await rowOf(spared)).revoked_at).toBeNull();
  });

  it('removes nothing without the lock, for another identity than the locked one, or under another cause', async () => {
    const target = await person();
    const other = await person();
    const administrator = await insertStaff(
      admin,
      staffRow({ roleBundleId: BUNDLE_IDS.platformAdmin }),
    );
    const targetBrowser = (await issue(target)).browser.id;
    const otherBrowser = (await issue(other)).browser.id;
    const context = administratorContext(administrator, 'staff.session.revoke');
    const revoke = (who: Person, cause: 'ADMINISTRATOR' | 'SELF') => ({
      staffIdentityId: who.row.id,
      cause,
      revokedBy: administrator.id,
    });

    // no lock taken: the identity is none until one is locked
    expect(
      await inTransaction(
        (handle) => store.revokeAll(handle, revoke(target, 'ADMINISTRATOR')),
        context,
      ),
    ).toEqual([]);
    // the lock is on the target, the request names another identity
    expect(
      await inTransaction(async (handle) => {
        await transactionOf(handle).execute(
          sql`select * from melarc.staff_locked_facts(${target.row.id}::uuid)`,
        );
        return store.revokeAll(handle, revoke(other, 'ADMINISTRATOR'));
      }, context),
    ).toEqual([]);
    // the policy admits the cause of the key and no other
    await expect(
      inTransaction(async (handle) => {
        await transactionOf(handle).execute(
          sql`select * from melarc.staff_locked_facts(${target.row.id}::uuid)`,
        );
        return store.revokeAll(handle, revoke(target, 'SELF'));
      }, context),
    ).rejects.toSatisfy((error) => serverErrorIn(error)?.code === '42501');
    expect((await rowOf(targetBrowser)).revoked_at).toBeNull();
    expect((await rowOf(otherBrowser)).revoked_at).toBeNull();
  });

  // Break caught: a staff context without the key reading or removing another person's trusted browsers.
  it('shows and removes nothing of another person’s to a staff member without the key', async () => {
    const target = await person();
    const nosy = await person();
    const browser = (await issue(target)).browser.id;

    expect(
      await inTransaction((handle) => store.list(handle, target.row.id), selfContext(nosy)),
    ).toEqual([]);
    expect(
      await inTransaction(
        (handle) =>
          store.revokeAll(handle, {
            staffIdentityId: target.row.id,
            cause: 'ADMINISTRATOR',
            revokedBy: nosy.row.id,
          }),
        selfContext(nosy),
      ),
    ).toEqual([]);
    expect((await rowOf(browser)).revoked_at).toBeNull();
  });
});
