import { PgDialect } from 'drizzle-orm/pg-core';
import { sql, type SQL } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { API_RUNTIME_ROLE } from '../../src/platform/config/load-config.js';
import {
  pickupRequestCriteria,
  type PickupRequestCriteria,
} from '../../src/pickup/pickup-request-criteria.js';
import { insertManifest, insertStop, manifestRow, stopRow } from './support/manifests.js';
import {
  exceptionRow,
  insertOnePackageException,
  insertPickupRequest,
  pickupRequestRow,
} from './support/pickups.js';
import { seedReferenceData } from './support/seeded.js';
import { HUB_A, HUB_B } from './support/staff-routes.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';
import { insertVendor, vendorRow } from './support/vendors.js';

/**
 * The conditions of the list of pickup requests (`pickupRequestCriteria`, task C1) against the definition they were written from. The
 * criteria were rewritten for the planner (a filter that is not asked for adds no condition; the filter on an exception's state starts from
 * the exceptions in that state), and measured at 400,000 requests the old form of the exception filter took 246 seconds for one call and the
 * new one two milliseconds. **A rewrite that is faster is worth nothing if it returns another set**, so the old form is kept here as the
 * specification and the two are compared, for every combination of the four filters and in every scope, over requests arranged to meet every
 * way an exception can be shown: none, requested, approved and carried, approved and not carried, refused, refused and asked for again,
 * several refused, an approval another request carries, and one the caller cannot see.
 */
const ORACLE = (criteria: PickupRequestCriteria): SQL => {
  const { state, exceptionState, serviceDate, manifested } = criteria;
  const pool = manifested === false && state === 'CONFIRMED';
  return sql`(${state}::text is null or state = ${state}::text)
    and (${exceptionState}::text is null or (
          select e.state from one_package_exception e
           where e.id = pickup_request.one_package_exception_id or e.pickup_request_id = pickup_request.id
           order by (e.id = pickup_request.one_package_exception_id) desc, e.requested_at desc, e.id desc
           limit 1) = ${exceptionState}::text)
    and (${serviceDate}::date is null or scheduled_service_date = ${serviceDate}::date)
    and (${manifested}::boolean is null or exists (
          select 1 from pickup_stop s
           where s.pickup_request_id = pickup_request.id and s.released_at is null) = ${manifested}::boolean)
    and (not ${pool}::boolean or cutoff_exception_state is distinct from 'PENDING_OPS_REVIEW')`;
};

const dialect = new PgDialect();
const literal = (value: unknown): string =>
  value === null || value === undefined
    ? 'null'
    : typeof value === 'boolean' || typeof value === 'number'
      ? String(value)
      : `'${(value as string).replaceAll("'", "''")}'`;
/** The statement with its parameters written in, so that it can be run by a plain client under a context of the test's own. */
const inline = (statement: SQL): string => {
  const query = dialect.sqlToQuery(statement);
  return query.sql.replace(/\$(\d+)/g, (_match, index: string) =>
    literal(query.params[Number(index) - 1]),
  );
};

let database: TestDatabase;
let admin: pg.Client;
let runtime: pg.Client;
let arranged = 0;

/** A small deterministic generator, so that a failure is the same failure on the next run. */
function generator(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

beforeAll(async () => {
  database = await createTestDatabase();
  await seedReferenceData(database);
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  await admin.query(`insert into hub (id, name) values ($1, 'Kumasi')`, [HUB_B]);
  const vendor = await insertVendor(admin, vendorRow({ hubId: HUB_A }));
  runtime = clientFor(database.urlFor(API_RUNTIME_ROLE));
  await runtime.connect();

  const next = generator(20261105);
  const pick = <T>(choices: readonly T[]): T => choices[Math.floor(next() * choices.length)] as T;
  const made: { id: string; hub: string }[] = [];
  // A request that carries the approval of another is a clone: it can only be arranged with the triggers out of the way, as the data is.
  await admin.query(`set session_replication_role = replica`);
  for (let at = 0; at < 160; at += 1) {
    const hub = pick([HUB_A, HUB_B]);
    const state = pick(['PENDING', 'PENDING', 'CONFIRMED', 'CONFIRMED', 'CANCELLED'] as const);
    const row = await insertPickupRequest(
      admin,
      pickupRequestRow(vendor.organizationId, hub, {
        state,
        // Only a pending request may be of one package (a confirmed one needs two, or an approved exception).
        packages: state === 'PENDING' ? 1 : 3,
        serviceDate: pick(['2026-11-03', '2026-11-04']),
        ...(state === 'CONFIRMED' && next() < 0.25 ? { cutoffState: 'PENDING_OPS_REVIEW' } : {}),
      }),
    );
    made.push({ id: row.id, hub });
    arranged += 1;

    // The exceptions this request was raised, in the order they were raised (the creation moment is the order).
    const history = pick([
      [],
      [],
      ['REQUESTED'],
      ['APPROVED'],
      ['REJECTED'],
      ['REJECTED', 'REQUESTED'],
      ['REJECTED', 'REJECTED'],
      ['REJECTED', 'REJECTED', 'REQUESTED'],
      ['REJECTED', 'APPROVED'],
    ] as const);
    let live: string | undefined;
    for (const outcome of history) {
      const exception = await insertOnePackageException(
        admin,
        exceptionRow(row.id, { state: outcome }),
      );
      if (outcome === 'APPROVED') live = exception.id;
    }
    // An approval is carried by the request it was made for, in most of the cases and not in all of them.
    if (live !== undefined && next() < 0.8) {
      await admin.query(`update pickup_request set one_package_exception_id = $1 where id = $2`, [
        live,
        row.id,
      ]);
    }
  }
  // Clones: a request that carries the approval of another, in either hub (so that the carried exception is out of the caller's scope for some).
  const approvals = (
    await admin.query<{ id: string }>(
      `select id from one_package_exception where state = 'APPROVED' order by requested_at limit 12`,
    )
  ).rows;
  for (const approval of approvals) {
    const clone = await insertPickupRequest(
      admin,
      pickupRequestRow(vendor.organizationId, pick([HUB_A, HUB_B]), {
        state: 'PENDING',
        packages: 1,
        serviceDate: '2026-11-03',
      }),
    );
    await admin.query(`update pickup_request set one_package_exception_id = $1 where id = $2`, [
      approval.id,
      clone.id,
    ]);
    made.push({ id: clone.id, hub: HUB_A });
    arranged += 1;
  }
  // Claims: a third of the requests are on a run, a few of those have been released.
  const hubs = [HUB_A, HUB_B];
  const manifests = await Promise.all(
    hubs.map((hub) => insertManifest(admin, manifestRow(hub, { state: 'CANCELLED' }))),
  );
  let sequence = 0;
  for (const request of made) {
    const roll = next();
    if (roll >= 0.45) continue;
    const manifest = manifests[hubs.indexOf(request.hub)] ?? manifests[0];
    if (manifest === undefined) continue;
    sequence += 1;
    await insertStop(
      admin,
      stopRow({ id: manifest.id, hubId: request.hub }, request.id, sequence, {
        releasedAt: roll < 0.15 ? new Date('2026-11-02T12:00:00Z') : null,
      }),
    );
  }
  await admin.query(`set session_replication_role = origin`);
}, 180_000);

afterAll(async () => {
  await runtime.end();
  await admin.end();
  await database.drop();
});

const SCOPES = [
  { name: 'the first hub', mode: 'SET', hubs: HUB_A },
  { name: 'the second hub', mode: 'SET', hubs: HUB_B },
  { name: 'both hubs', mode: 'SET', hubs: `${HUB_A},${HUB_B}` },
  { name: 'all hubs', mode: 'ALL', hubs: '' },
  { name: 'no hub', mode: 'SET', hubs: '' },
] as const;

/** The ids a statement selects, read as the runtime role under the context of a scope: what a list is given to read. */
async function idsUnder(scope: (typeof SCOPES)[number], where: SQL): Promise<string[]> {
  await runtime.query('begin');
  try {
    await runtime.query(
      `select set_config('melarc.principal_type', 'STAFF', true), set_config('melarc.principal_id', gen_random_uuid()::text, true),
              set_config('melarc.surface', 'OPS_PORTAL', true), set_config('melarc.authorization_key', 'pickup.read', true),
              set_config('melarc.hub_scope_mode', $1, true), set_config('melarc.authorized_hub_ids', $2, true)`,
      [scope.mode, scope.hubs],
    );
    const found = await runtime.query<{ id: string }>(
      `select id from pickup_request where ${inline(where)} order by id`,
    );
    return found.rows.map((row) => row.id);
  } finally {
    await runtime.query('rollback');
  }
}

const STATES = [null, 'PENDING', 'CONFIRMED'] as const;
const EXCEPTION_STATES = [null, 'REQUESTED', 'APPROVED', 'REJECTED'] as const;
const DAYS = [null, '2026-11-03'] as const;
const MANIFESTED = [null, true, false] as const;

describe('the conditions of the list of pickup requests', () => {
  // Break caught: the data arranged for the comparison having nothing to compare, so that every combination agrees by returning nothing.
  it('are compared over requests that every way of showing an exception reaches', async () => {
    expect(arranged).toBeGreaterThan(150);
    const requested = await idsUnder(
      SCOPES[3],
      ORACLE({ state: null, exceptionState: 'REQUESTED', serviceDate: null, manifested: null }),
    );
    const approved = await idsUnder(
      SCOPES[3],
      ORACLE({ state: null, exceptionState: 'APPROVED', serviceDate: null, manifested: null }),
    );
    const rejected = await idsUnder(
      SCOPES[3],
      ORACLE({ state: null, exceptionState: 'REJECTED', serviceDate: null, manifested: null }),
    );
    const claimed = await idsUnder(
      SCOPES[3],
      ORACLE({ state: null, exceptionState: null, serviceDate: null, manifested: true }),
    );
    const unclaimed = await idsUnder(
      SCOPES[3],
      ORACLE({ state: null, exceptionState: null, serviceDate: null, manifested: false }),
    );
    for (const found of [requested, approved, rejected, claimed, unclaimed]) {
      expect(found.length).toBeGreaterThan(5);
    }
    // ... and a request that carries the approval of another shows it (an approval travels with the booking).
    const carriedElsewhere = await admin.query(
      `select 1 from pickup_request r join one_package_exception e on e.id = r.one_package_exception_id where e.pickup_request_id <> r.id limit 1`,
    );
    expect(carriedElsewhere.rowCount).toBe(1);
  });

  // Break caught: a rewrite that is faster and returns another set, for any combination of the four filters in any scope.
  it.each(SCOPES.map((scope) => [scope.name, scope] as const))(
    'return, in %s, what the definition returns, for every combination of the filters',
    async (_name, scope) => {
      let compared = 0;
      for (const state of STATES) {
        for (const exceptionState of EXCEPTION_STATES) {
          for (const serviceDate of DAYS) {
            for (const manifested of MANIFESTED) {
              const criteria = { state, exceptionState, serviceDate, manifested };
              const expected = await idsUnder(scope, ORACLE(criteria));
              const actual = await idsUnder(scope, pickupRequestCriteria(criteria));
              expect(actual, JSON.stringify(criteria)).toEqual(expected);
              compared += 1;
            }
          }
        }
      }
      expect(compared).toBe(
        STATES.length * EXCEPTION_STATES.length * DAYS.length * MANIFESTED.length,
      );
    },
    120_000,
  );
});
