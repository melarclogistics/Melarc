import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { TransactionHandle } from '../../src/platform/auth/ports/unit-of-work.port.js';
import { RECORD_LOOKUP_BUDGET_MS } from '../../src/platform/lookup/record-lookup.service.js';
import { insertPickupRequest, pickupRequestRow } from './support/pickups.js';
import { insertRider, riderRow } from './support/riders.js';
import { API, HUB_A, HUB_B, OPS, type Actor } from './support/staff-routes.js';
import { startVendorRoutes, type VendorRoutes } from './support/vendor-routes.js';
import { insertVendor, vendorRow } from './support/vendors.js';

/**
 * How a lookup that cannot finish ends (`AC-LOOKUP-11`, `-15`, `-17`, the audit of 7 November 2026, A4 and A5, and run 4, Stage 1, A4.1 and A4.2), against the real application
 * and a real PostgreSQL, without a single assertion about time (run 5, Stage 1.2): a pull request runs this file. A search that is held on a lock is ended by a cancel from
 * another connection, which the server reports as it reports its statement timeout (SQLSTATE 57014), so the read takes the same path through the platform; the budget is spent
 * by the application's clock, which the integration kit holds and the test moves. The read ends as the platform's failed read, returns nothing of what the earlier keys found,
 * and writes no hub-crossing event for it; the next lookup is whole; and a client that leaves has its statement cancelled and the session's slot given back, for the reason
 * that the client left and not as a budget that ran out. That the bound is three seconds and not the four of the lock wait, that the whole lookup has one budget of that
 * length, and how soon a client's leaving is acted on, are `alone/record-lookup-timeout.db.test.ts`.
 *
 * The two hubs each hold a vendor, a request and a rider whose names share a word, so that a Platform Admin without a hub of its own meets both hubs in the first keys it
 * is searched for (pickup.read, vendor.read) before the key that is held (dispatch.read, the riders; or pickup.read, the requests).
 *
 * **The bound a statement has on the server is explicit here** (run 6, Stage 1.5). The application asks the server for at most three seconds of **real** time for each statement of
 * a lookup (`limitStatements`, `AC-LOOKUP-15`) while its budget runs on the kit's manual clock, so a scenario that took three real seconds to set up (a loaded machine) was ended by the
 * server's own timer and not by the cause it names: the abandon test then read a statement timeout where it expects "abandoned by the client", and the test of the budget passed
 * without the budget doing anything. Every scenario but one therefore gives the server a bound far beyond what it takes (`CEILING_MS`, through a wrapper of `limitStatements`
 * that passes everything else through), so that the one thing that can end its statement is the cause it names; the one that does not (the last) asks the application for its
 * bound as it ships and reads from the server what the transaction holds (`current_setting`), which proves that the bound is applied without waiting three seconds for it.
 */
const LOOKUP = `${API}/ops/lookup`;

/** What the wrapper of `limitStatements` below does, and keeps. */
const bound = vi.hoisted(() => ({
  /** When set, the bound the server is given instead of the application's: the scenarios raise it so that the server's own timer is never what ends their statement. */
  ceiling: undefined as number | undefined,
  /** For each call the application made: the bound it asked for, and what the transaction held the moment after (`current_setting('statement_timeout')`). */
  asked: [] as { milliseconds: number; effective: string }[],
}));

vi.mock('../../src/platform/queue-summary/statement-limit.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../src/platform/queue-summary/statement-limit.js')>();
  const { sql } = await import('drizzle-orm');
  const { transactionOf } = await import('../../src/platform/database/transaction-handle.js');
  return {
    ...original,
    limitStatements: async (handle: TransactionHandle, milliseconds: number): Promise<void> => {
      await original.limitStatements(handle, bound.ceiling ?? milliseconds);
      const held = await transactionOf(handle).execute(
        sql`select current_setting('statement_timeout') as setting`,
      );
      const [row] = held.rows as unknown as { setting: string }[];
      bound.asked.push({ milliseconds, effective: row?.setting ?? '' });
    },
  };
});

/** The bound the scenarios give the server instead of three seconds: a minute, far beyond any of them. */
const CEILING_MS = 60_000;

/** The statement that sets the bound (`limitStatements`), as the trace shows it: values taken out, in lower case. */
const isTheBound = (statement: string): boolean =>
  statement.includes('set_config( ?, least(') && statement.includes('from pg_settings');

/** A search of a lookup, as the trace shows it: every search is a name matched with `ilike` (the requests, the vendors, the riders, the staff). */
const isASearch = (statement: string): boolean => statement.includes(' ilike ');

let routes: VendorRoutes;

beforeAll(async () => {
  // The configured bounds nest as the configuration requires (lock wait inside statement time inside transaction time): the pool's are far beyond what a scenario takes
  // (the lock wait 60 s, the statement 120 s, the transaction 300 s), so that the only bound a statement has on the server is the one the application sets for the lookup,
  // which the scenarios raise to `CEILING_MS` (below the pool's, which it can only lower) and the last scenario leaves as it ships. Nothing here waits for any of them:
  // the test ends every wait itself.
  bound.ceiling = CEILING_MS;
  routes = await startVendorRoutes({
    env: {
      DATABASE_LOCK_TIMEOUT_MS: '60000',
      DATABASE_STATEMENT_TIMEOUT_MS: '120000',
      DATABASE_TRANSACTION_TIMEOUT_MS: '300000',
    },
  });
  for (const [hub, suffix] of [
    [HUB_A, 'Alpha'],
    [HUB_B, 'Beta'],
  ] as const) {
    const vendor = await insertVendor(
      routes.admin,
      vendorRow({ hubId: hub, legalName: `Zuko Fabrics ${suffix} Ltd` }),
    );
    await insertPickupRequest(
      routes.admin,
      pickupRequestRow(vendor.organizationId, hub, { senderName: `Zuko Quarmby ${suffix}` }),
    );
    await insertRider(routes.admin, riderRow({ hubId: hub, fullName: `Zuko Boateng ${suffix}` }));
  }
}, 240_000);

afterAll(async () => {
  await routes.stop();
});

const ask = (actor: Actor, q: string, signal?: AbortSignal) =>
  actor.client.post(LOOKUP, { q }, { origin: OPS, ...(signal === undefined ? {} : { signal }) });

const crossingsOf = (actor: Actor) =>
  routes.rows<{ responsible_hub_id: string }>(
    `select responsible_hub_id from audit_event
      where event_code = 'auth.hub_boundary.crossed' and actor_id = $1 order by responsible_hub_id`,
    [actor.identity.id],
  );

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });

/** How many statements of the test database are waiting on a lock now (the administrator's own statements are not counted). */
async function lockWaits(): Promise<number> {
  const [waiting] = await routes.rows<{ waiting: number }>(
    `select count(*)::int as waiting from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`,
  );
  return waiting?.waiting ?? 0;
}

/** Waits until some statement of the test database is waiting on a lock: the lookup that the test holds has reached the table it holds. */
async function waitForALockWait(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await lockWaits()) > 0) return;
    await sleep(50);
  }
  throw new Error('no statement waited on the lock the test holds');
}

/** Waits until no statement of the test database waits on a lock. The generous count of attempts only makes a failure a failure and not a hang; no duration is read. */
async function waitForNoLockWait(): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if ((await lockWaits()) === 0) return;
    await sleep(25);
  }
  throw new Error('a statement was still waiting on a lock long after the client left');
}

/** The lines the application has logged so far, from the one at `from` on (a test looks at what its own scenario wrote, not at what the tests before it did). */
const logSince = (from: number) => routes.kit.app.logs.records().slice(from);

/** Waits until the application has logged, since `from`, the record `wanted` picks out, and gives it. The generous count of attempts only makes a failure a failure and not a hang; no duration is read. */
async function waitForLog(
  from: number,
  wanted: (record: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const found = logSince(from).find(wanted);
    if (found !== undefined) return found;
    await sleep(25);
  }
  throw new Error('the application did not log the line the test waits for');
}

/** Ends every statement that waits on a lock, from the administrator's connection: the server answers the waiting session with the error of a cancelled statement. */
async function cancelWhatWaits(): Promise<void> {
  await routes.admin.query(
    `select pg_cancel_backend(pid) from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`,
  );
}

/** Asks while another connection holds `table` in access exclusive mode, and ends the wait as `end` says; gives the answer. */
async function askWhileHeld(
  table: string,
  actor: Actor,
  q: string,
  end: (held: () => Promise<void>) => Promise<void>,
) {
  await routes.admin.query('begin');
  try {
    await routes.admin.query(`lock table ${table} in access exclusive mode`);
    const pending = ask(actor, q);
    await waitForALockWait();
    await end(async () => {
      await routes.admin.query('rollback');
      await routes.admin.query('begin');
    });
    return await pending;
  } finally {
    await routes.admin.query('rollback');
  }
}

describe('a search that cannot finish', () => {
  // Break caught: a failed search told as something other than the platform's failed read (a 500 with a code, or a body that tells why), a lookup that answers 200 with a
  // short answer, and a lookup that leaves the next one broken.
  it('ends the name scan of the requests as the failed read of the platform, and the next lookup is whole', async () => {
    const admin = await routes.platformAdmin();
    const first = await ask(admin, 'zuko');
    expect(first.status).toBe(200);

    // The scan of the requests, held on a lock by another connection: the search waits for it and is cancelled while it waits.
    const answer = await askWhileHeld('pickup_request', admin, 'zuko', cancelWhatWaits);

    expect(answer.status).toBe(503);
    expect((answer.json() as { code?: string }).code).toBeUndefined();
    // The platform's own words and a request id, and nothing of the statement, the table or the SQLSTATE (the request id is random, so it is left out of
    // what is searched: its characters can spell anything).
    const body = answer.json() as Record<string, unknown>;
    expect(Object.keys(body).toSorted()).toEqual(['message', 'request_id']);
    expect(String(body.message)).not.toMatch(/statement|timeout|pickup_request|57014/i);

    const again = await ask(admin, 'zuko');
    expect(again.status).toBe(200);
    expect(again.json()).toEqual(first.json());
  }, 60_000);

  // Break caught (A4): the events of a hub written in the transaction of the key that found it, which committed before the later search failed, so that a lookup that
  // answered nothing has recorded two crossings for results it never returned. Here the first two keys (the requests and the vendors) find both hubs and the third (the
  // riders) is held on a lock: the read fails, and the ledger holds nothing for the actor. The same lookup, once the rider table is free, answers and writes one event for
  // each hub.
  it('writes no hub-crossing event for a lookup that fails after earlier searches found both hubs, and writes them once it succeeds', async () => {
    const admin = await routes.platformAdmin();

    const answer = await askWhileHeld('rider_identity', admin, 'zuko', cancelWhatWaits);

    expect(answer.status).toBe(503);
    expect((answer.json() as { code?: string }).code).toBeUndefined();
    expect(answer.text).not.toContain('items');
    expect(await crossingsOf(admin)).toEqual([]);

    const whole = await ask(admin, 'zuko');
    expect(whole.status).toBe(200);
    expect((await crossingsOf(admin)).map((row) => row.responsible_hub_id)).toEqual([HUB_A, HUB_B]);
  }, 60_000);
});

describe('the lookup has one budget of three seconds, on the application’s clock (AC-LOOKUP-17)', () => {
  // Break caught: a lookup with no budget under the application's clock, which would go on after the time it was given, or one whose failure is not the platform's failed
  // read, writes an event for results it never returned, or leaves the next lookup broken. The clock is the kit's manual one: the test says that the three seconds have
  // passed while the first key waits on its lock, and frees the lock; the read ends, because nothing of it may start once the budget is gone. That the budget is one for
  // all the keys, and not three seconds for each, is the unit test of the service ("one budget for the whole lookup") and, by the clock of a wall, the timing file.
  it('fails the whole read, and writes nothing, when the clock says that its budget is spent, and the next lookup is whole', async () => {
    const admin = await routes.platformAdmin();

    const answer = await askWhileHeld('pickup_request', admin, 'zuko', async (free) => {
      routes.kit.clock.advance(RECORD_LOOKUP_BUDGET_MS);
      await free();
    });

    expect(answer.status).toBe(503);
    expect((answer.json() as { code?: string }).code).toBeUndefined();
    expect(answer.text).not.toContain('items');
    expect(await crossingsOf(admin)).toEqual([]);

    const again = await ask(admin, 'zuko');
    expect(again.status).toBe(200);
    expect(await crossingsOf(admin)).toHaveLength(2);
  }, 60_000);
});

describe('a client that leaves while its lookup runs (run 4, Stage 1, A4.1 and A4.2; run 5, Stage 1.2)', () => {
  // Break caught (A4.2): finishing the request's budget cancels no statement, so the search of a lookup whose client had left went on waiting for its lock until its own
  // three-second bound, and the session kept its slot for that long (every other lookup of the session was a 429, and each 429 puts the portal's automatic reads on hold).
  // The lock is still held when the assertions are made: what ends the wait is the cancel of the statement, not the lock being freed. The cause is asserted, not a
  // duration: the statement was cancelled because the lookup was abandoned, said so in the log under the lookup's own label, and was not told as a budget that ran out.
  it('cancels the statement the lookup is waiting with because it was abandoned, and gives the session its slot back', async () => {
    const admin = await routes.platformAdmin();
    // The budget the tests before this one spent is a budget that ran out, and says so: only the lines of this scenario are looked at.
    const seen = routes.kit.app.logs.records().length;
    await routes.admin.query('begin');
    let first: Promise<unknown> | undefined;
    try {
      await routes.admin.query('lock table pickup_request in access exclusive mode');
      const leaving = new AbortController();
      first = ask(admin, 'zuko', leaving.signal).then(
        (answer) => answer,
        (error: unknown) => error,
      );
      await waitForALockWait();
      const whileItRuns = await ask(admin, 'zuko');
      expect(whileItRuns.status, 'the slot is held while the first lookup runs').toBe(429);

      leaving.abort();
      await waitForNoLockWait();

      // With the table still locked: the statement is no longer waiting, because the lookup's own budget was cancelled for the reason that the client left. The line is
      // written once the database layer has cancelled the statement and rolled back, a moment after the wait is gone.
      const cancelled = await waitForLog(seen, (record) =>
        String(record.msg).startsWith('database transaction cancelled'),
      );
      expect(
        cancelled,
        'the cancel of the lookup’s statement is logged under the lookup’s label',
      ).toMatchObject({
        level: 'info',
        label: 'lookupRecords',
        reason: 'abandoned by the client',
        phase: 'working',
        cancel: 'signalled',
        msg: 'database transaction cancelled: abandoned by the client',
      });
      const asBudgetRanOut = logSince(seen).filter(
        (record) =>
          record.label === 'lookupRecords' && String(record.msg).includes('budget ran out'),
      );
      expect(asBudgetRanOut, 'an abandoned lookup is not a budget that ran out').toEqual([]);
      expect(await crossingsOf(admin), 'nothing was written for the lookup that was left').toEqual(
        [],
      );
    } finally {
      await routes.admin.query('rollback');
    }

    await first;
    // The session's slot is free: the next lookup is whole, and not a 429.
    const again = await ask(admin, 'zuko');
    expect(again.status).toBe(200);
  }, 60_000);
});

describe('every statement of a lookup has the bound of three seconds on the server (AC-LOOKUP-15; run 6, Stage 1.5)', () => {
  // Break caught: the bound removed (or not applied, or another figure), which no scenario above can see: each of them ends its wait itself, by a cancel, by the clock or by the
  // client leaving, so a lookup with no bound on its statements passed them all. Here nothing is held and nothing is raised: the application is asked, as it ships, for the bound of
  // each key's transaction, and the transaction is asked what it holds. The server's own answer is the evidence, so nothing waits three seconds for a timeout to fire. A platform
  // admin is searched by name under three keys (the requests, the vendors, the riders: one transaction each).
  it('asks the server for three seconds before the first search of each key, and the transaction holds three seconds', async () => {
    const admin = await routes.platformAdmin();
    bound.ceiling = undefined;
    bound.asked.length = 0;
    let statements: readonly string[] = [];
    try {
      const traced = await routes.kit.trace(() => ask(admin, 'zuko'));

      expect(traced.result.status).toBe(200);
      statements = traced.statements;
    } finally {
      bound.ceiling = CEILING_MS;
    }

    // One call for each key's transaction (the requests, the vendors, the riders and the runs): at least the three of a platform admin's name search, never none. The figure is
    // the acceptance criterion's, written here as the number it names and not as the constant the application reads.
    expect(bound.asked.length).toBeGreaterThanOrEqual(3);
    for (const each of bound.asked) expect(each).toEqual({ milliseconds: 3000, effective: '3s' });

    // The order (run 7, Stage 3.6): the test is named for it and used to check none. The statements the application's login sent are cut into the transactions they ran in, and in each
    // one that searched, the bound was set before the first search of its key: a bound set after the search, or after the first of several, would have the first statement run unbounded.
    const transactions: string[][] = [];
    for (const statement of statements) {
      if (statement.startsWith('begin')) transactions.push([]);
      transactions.at(-1)?.push(statement);
    }
    const searching = transactions.filter((transaction) => transaction.some(isASearch));
    expect(searching.length, 'one transaction for each key searched').toBeGreaterThanOrEqual(3);
    for (const transaction of searching) {
      const boundAt = transaction.findIndex(isTheBound);
      const searchAt = transaction.findIndex(isASearch);
      expect(
        boundAt,
        `the bound is set in the transaction that searches: ${transaction.join(' | ')}`,
      ).toBeGreaterThanOrEqual(0);
      expect(boundAt, `before its first search: ${transaction.join(' | ')}`).toBeLessThan(searchAt);
    }
    // One setting of the bound for each transaction that searched, and the application's mock saw each of them.
    expect(bound.asked).toHaveLength(searching.length);
  }, 60_000);
});
