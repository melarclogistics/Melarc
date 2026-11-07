import { randomUUID } from 'node:crypto';

import { PgDialect } from 'drizzle-orm/pg-core';
import { sql, type SQL } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { API_RUNTIME_ROLE } from '../../src/platform/config/load-config.js';
import {
  pickupRequestCriteria,
  shownException,
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
 * new one two milliseconds. **A rewrite that is faster is worth nothing if it returns another set**, so the definition is kept here, written
 * out by hand as a plain condition for each filter (the form the criteria were rewritten from, with the two rules of tasks C1.1 and P1.1: only the pending
 * requests are in the approver's queue (C1.1 left out the cancelled ones, P1.1 every one that is not pending), and the cut-off decision is a filter of its own), and the two are compared, for every combination
 * of the filters and in every scope, over requests arranged to meet every
 * way an exception can be shown: none, requested, approved and carried, approved and not carried, refused, refused and asked for again,
 * several refused, an approval another request carries, and one the caller cannot see.
 *
 * **The hub (task C3, `hub_id`; features/operations/hub-filters.md) is one more filter of the definition**, written out as the plainest condition there
 * is (`responsible_hub_id = $hub`, with a null for none), and it is crossed with a reduced set of the others (a third dimension on the whole cross
 * would triple it) under the same five scopes: which is the proof, under the runtime role and the real policies, that **a hub outside a scope returns
 * nothing and a hub inside it returns only that hub's requests**, whatever the other filters are.
 */
const ORACLE = (criteria: PickupRequestCriteria): SQL => {
  const { state, exceptionState, cutoffExceptionState, serviceDate, manifested, hubId } = criteria;
  const pool = manifested === false && state === 'CONFIRMED';
  // Task C1.1 changed the definition in two deliberate places, and the definition is written out here in its new form: a filter by the
  // cut-off state (`cutoff_exception_state`, AC-QSUM-10), and the approver's queue (`REQUESTED`) of the pending requests alone, the ones whose
  // exception can still be decided (AC-QSUM-12; task C1.1 left out the cancelled ones, the decision of 6 November 2026 made it every state the
  // approval guard refuses).
  return sql`(${state}::text is null or state = ${state}::text)
    and (${exceptionState}::text is null or (
          select e.state from one_package_exception e
           where e.id = pickup_request.one_package_exception_id or e.pickup_request_id = pickup_request.id
           order by (e.id = pickup_request.one_package_exception_id) desc, e.requested_at desc, e.id desc
           limit 1) = ${exceptionState}::text)
    and (${exceptionState}::text is distinct from 'REQUESTED' or state = 'PENDING')
    and (${cutoffExceptionState}::text is null or cutoff_exception_state = ${cutoffExceptionState}::text)
    and (${serviceDate}::date is null or scheduled_service_date = ${serviceDate}::date)
    and (${manifested}::boolean is null or exists (
          select 1 from pickup_stop s
           where s.pickup_request_id = pickup_request.id and s.released_at is null) = ${manifested}::boolean)
    and (not ${pool}::boolean or cutoff_exception_state is distinct from 'PENDING_OPS_REVIEW')
    and (${hubId}::uuid is null or responsible_hub_id = ${hubId}::uuid)`;
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
let vendorOrganization = '';

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
  vendorOrganization = vendor.organizationId;
  runtime = clientFor(database.urlFor(API_RUNTIME_ROLE));
  await runtime.connect();

  const next = generator(20261105);
  const pick = <T>(choices: readonly T[]): T => choices[Math.floor(next() * choices.length)] as T;
  /**
   * The cut-off state a request is arranged with, so that the filter by it has every state of the field to tell apart: a confirmed request is
   * late and waiting for its decision (a quarter), or the decision was taken at the same day (a fifth); a cancelled one was rescheduled, or was
   * cancelled while its decision was waiting. The others have none.
   */
  const cutoffOf = (
    state: string,
  ): { cutoffState?: 'PENDING_OPS_REVIEW' | 'SAME_DAY_APPROVED' | 'RESCHEDULED' } => {
    if (state !== 'CONFIRMED' && state !== 'CANCELLED') return {};
    const roll = next();
    if (state === 'CONFIRMED') {
      if (roll < 0.25) return { cutoffState: 'PENDING_OPS_REVIEW' };
      if (roll < 0.45) return { cutoffState: 'SAME_DAY_APPROVED' };
      return {};
    }
    if (roll < 0.3) return { cutoffState: 'RESCHEDULED' };
    if (roll < 0.45) return { cutoffState: 'PENDING_OPS_REVIEW' };
    return {};
  };
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
        ...cutoffOf(state),
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

/**
 * The ids a statement selects as a Vendor session of the organisation that made the requests (task C3): the other branch of the read policies of the
 * requests and of the exceptions. A Vendor reads its own organisation's requests in every hub, and may send the exception filter and a hub.
 */
async function idsUnderVendor(organization: string, where: SQL): Promise<string[]> {
  await runtime.query('begin');
  try {
    await runtime.query(
      `select set_config('melarc.principal_type', 'VENDOR', true), set_config('melarc.principal_id', gen_random_uuid()::text, true),
              set_config('melarc.surface', 'VENDOR_PWA', true), set_config('melarc.authorization_key', 'pickup.read', true),
              set_config('melarc.vendor_organization_id', $1, true)`,
      [organization],
    );
    const found = await runtime.query<{ id: string }>(
      `select id from pickup_request where ${inline(where)} order by id`,
    );
    return found.rows.map((row) => row.id);
  } finally {
    await runtime.query('rollback');
  }
}

const STATES = [null, 'PENDING', 'CONFIRMED', 'CANCELLED'] as const;
const EXCEPTION_STATES = [null, 'REQUESTED', 'APPROVED', 'REJECTED'] as const;
const CUTOFF_STATES = [null, 'PENDING_OPS_REVIEW', 'SAME_DAY_APPROVED', 'RESCHEDULED'] as const;
const DAYS = [null, '2026-11-03'] as const;
const MANIFESTED = [null, true, false] as const;

describe('the conditions of the list of pickup requests', () => {
  // Break caught: the data arranged for the comparison having nothing to compare, so that every combination agrees by returning nothing.
  it('are compared over requests that every way of showing an exception reaches', async () => {
    expect(arranged).toBeGreaterThan(150);
    const any = {
      state: null,
      exceptionState: null,
      cutoffExceptionState: null,
      serviceDate: null,
      manifested: null,
      hubId: null,
    } as const;
    const requested = await idsUnder(SCOPES[3], ORACLE({ ...any, exceptionState: 'REQUESTED' }));
    const approved = await idsUnder(SCOPES[3], ORACLE({ ...any, exceptionState: 'APPROVED' }));
    const rejected = await idsUnder(SCOPES[3], ORACLE({ ...any, exceptionState: 'REJECTED' }));
    const claimed = await idsUnder(SCOPES[3], ORACLE({ ...any, manifested: true }));
    const unclaimed = await idsUnder(SCOPES[3], ORACLE({ ...any, manifested: false }));
    const waiting = await idsUnder(
      SCOPES[3],
      ORACLE({ ...any, cutoffExceptionState: 'PENDING_OPS_REVIEW' }),
    );
    const sameDay = await idsUnder(
      SCOPES[3],
      ORACLE({ ...any, cutoffExceptionState: 'SAME_DAY_APPROVED' }),
    );
    const rescheduled = await idsUnder(
      SCOPES[3],
      ORACLE({ ...any, cutoffExceptionState: 'RESCHEDULED' }),
    );
    for (const found of [
      requested,
      approved,
      rejected,
      claimed,
      unclaimed,
      waiting,
      sameDay,
      rescheduled,
    ]) {
      expect(found.length).toBeGreaterThan(5);
    }
    // ... and the rules tasks C1.1 and P1.1 made have something to act on: a cancelled request, and a confirmed one, whose exception is still
    // asked for (they must leave the approver's queue; the generator makes no declined request), and a late booking that is not confirmed (the
    // filter by the cut-off state alone keeps it, the queue does not).
    const cancelledAsked = await admin.query<{ n: number }>(
      `select count(*)::int as n from pickup_request r where r.state = 'CANCELLED'
          and (select e.state from one_package_exception e where e.pickup_request_id = r.id order by e.requested_at desc, e.id desc limit 1) = 'REQUESTED'`,
    );
    expect(cancelledAsked.rows[0]?.n).toBeGreaterThan(0);
    const confirmedAsked = await admin.query<{ n: number }>(
      `select count(*)::int as n from pickup_request r where r.state = 'CONFIRMED'
          and (select e.state from one_package_exception e where e.pickup_request_id = r.id order by e.requested_at desc, e.id desc limit 1) = 'REQUESTED'`,
    );
    expect(confirmedAsked.rows[0]?.n).toBeGreaterThan(0);
    const lateNotConfirmed = await admin.query<{ n: number }>(
      `select count(*)::int as n from pickup_request where state <> 'CONFIRMED' and cutoff_exception_state = 'PENDING_OPS_REVIEW'`,
    );
    expect(lateNotConfirmed.rows[0]?.n).toBeGreaterThan(0);
    // ... and a request that carries the approval of another shows it (an approval travels with the booking).
    const carriedElsewhere = await admin.query(
      `select 1 from pickup_request r join one_package_exception e on e.id = r.one_package_exception_id where e.pickup_request_id <> r.id limit 1`,
    );
    expect(carriedElsewhere.rowCount).toBe(1);
    // ... and the hub (task C3) has two sides to tell apart: requests of both hubs, in each state the reduced cross of the hub uses (a hub whose
    // requests are all of one state would agree with any condition on that state, and a hub with none would agree with a hub that does not exist).
    const byHubAndState = await admin.query<{ hub: string; state: string; n: number }>(
      `select responsible_hub_id as hub, state, count(*)::int as n from pickup_request group by 1, 2`,
    );
    for (const hub of [HUB_A, HUB_B]) {
      for (const state of ['PENDING', 'CONFIRMED', 'CANCELLED']) {
        const n = byHubAndState.rows.find((row) => row.hub === hub && row.state === state)?.n ?? 0;
        expect(n, `${hub} ${state}`).toBeGreaterThan(2);
      }
    }
  });

  // Break caught: a rewrite that is faster and returns another set, for any combination of the four filters in any scope.
  it.each(SCOPES.map((scope) => [scope.name, scope] as const))(
    'return, in %s, what the definition returns, for every combination of the filters',
    async (_name, scope) => {
      let compared = 0;
      for (const state of STATES) {
        for (const exceptionState of EXCEPTION_STATES) {
          for (const cutoffExceptionState of CUTOFF_STATES) {
            for (const serviceDate of DAYS) {
              for (const manifested of MANIFESTED) {
                const criteria = {
                  state,
                  exceptionState,
                  cutoffExceptionState,
                  serviceDate,
                  manifested,
                  // The whole cross is the proof of the other five filters, with no hub asked for; the hub is crossed with a reduced set below.
                  hubId: null,
                };
                const expected = await idsUnder(scope, ORACLE(criteria));
                const actual = await idsUnder(scope, pickupRequestCriteria(criteria));
                expect(actual, JSON.stringify(criteria)).toEqual(expected);
                compared += 1;
              }
            }
          }
        }
      }
      expect(compared).toBe(
        STATES.length *
          EXCEPTION_STATES.length *
          CUTOFF_STATES.length *
          DAYS.length *
          MANIFESTED.length,
      );
    },
    180_000,
  );
});

/**
 * **The hub (task C3, `AC-HUBF-01`, `-05`, `-06`)** is crossed with a reduced set of the other filters, and not with the whole cross above (384
 * combinations a scope, which a third dimension would triple): each of the other filters alone, over every value that has requests in both hubs,
 * the filters of the queues as the counters write them, and the pairs that interact (the pool's rule with a day or a cut-off state, an exception
 * with a day). Every combination is read as each hub and as none, in each scope, and checked against three judges that do not depend on the
 * criteria under test: the definition written out by hand (`ORACLE`), the share of the hub in what the same scope reads with no hub (by the hub
 * the table gives each request, read by the administrator), and the partition (the two hubs between them are the whole read, and no request is
 * in both).
 */
type OtherFilters = Omit<PickupRequestCriteria, 'hubId'>;
const NO_OTHER_FILTER: OtherFilters = {
  state: null,
  exceptionState: null,
  cutoffExceptionState: null,
  serviceDate: null,
  manifested: null,
};
const beside = (name: string, others: Partial<OtherFilters>) => ({
  name,
  others: { ...NO_OTHER_FILTER, ...others },
});

const HUBS = [null, HUB_A, HUB_B] as const;

const CROSSED = [
  beside('no other filter', {}),
  ...(['PENDING', 'CONFIRMED', 'CANCELLED'] as const).map((state) =>
    beside(`the state ${state}`, { state }),
  ),
  ...(['REQUESTED', 'APPROVED', 'REJECTED'] as const).map((exceptionState) =>
    beside(`the exception state ${exceptionState}`, { exceptionState }),
  ),
  ...(['PENDING_OPS_REVIEW', 'SAME_DAY_APPROVED', 'RESCHEDULED'] as const).map(
    (cutoffExceptionState) =>
      beside(`the cut-off state ${cutoffExceptionState}`, { cutoffExceptionState }),
  ),
  beside('the day 2026-11-03', { serviceDate: '2026-11-03' }),
  beside('the day 2026-11-04', { serviceDate: '2026-11-04' }),
  beside('the requests on a run', { manifested: true }),
  beside('the requests on no run', { manifested: false }),
  // The filters of the queues, as the counters write them (state and the rest): the late bookings, and the pool.
  beside('the late bookings (confirmed, the cut-off decision waiting)', {
    state: 'CONFIRMED',
    cutoffExceptionState: 'PENDING_OPS_REVIEW',
  }),
  beside('the pool (confirmed, on no run)', { state: 'CONFIRMED', manifested: false }),
  // The pairs that interact: the pool's rule beside a day and a cut-off state, a run beside a state, an exception beside a day.
  beside('the confirmed requests on a run', { state: 'CONFIRMED', manifested: true }),
  beside('the pool on a day', { state: 'CONFIRMED', manifested: false, serviceDate: '2026-11-03' }),
  beside('the pool with a cut-off decision taken the same day', {
    state: 'CONFIRMED',
    manifested: false,
    cutoffExceptionState: 'SAME_DAY_APPROVED',
  }),
  beside('the pending requests with an approved exception', {
    state: 'PENDING',
    exceptionState: 'APPROVED',
  }),
  beside('the approver’s queue on a day', {
    exceptionState: 'REQUESTED',
    serviceDate: '2026-11-03',
  }),
];

/** The hubs a scope reaches: the set it names, or every hub that exists where it is of all. */
const reachOf = (scope: (typeof SCOPES)[number]): ReadonlySet<string> =>
  new Set(
    scope.mode === 'ALL' ? [HUB_A, HUB_B] : scope.hubs.split(',').filter((hub) => hub !== ''),
  );

/** The hub of every request, as the table holds it and the administrator reads it: the judge of whose a request is, never the criteria under test. */
async function hubOfEveryRequest(): Promise<Map<string, string>> {
  const found = await admin.query<{ id: string; hub: string }>(
    `select id, responsible_hub_id as hub from pickup_request`,
  );
  return new Map(found.rows.map((row) => [row.id, row.hub]));
}

describe('the hub in the conditions of the list of pickup requests (task C3)', () => {
  // Break caught: the data arranged for the comparison having nothing for a hub to tell apart in some combination the hub is crossed with (a state,
  // an exception, a cut-off state, a day or the pool in one hub alone), so that the combination agrees by returning nothing for the other hub: each
  // combination has requests in each hub, as the scope that reaches both reads them (the states of each hub are the first test's).
  it('are compared over requests of both hubs, in every combination the hub is crossed with', async () => {
    const hubOf = await hubOfEveryRequest();
    expect(new Set(hubOf.values())).toEqual(new Set([HUB_A, HUB_B]));
    for (const hub of [HUB_A, HUB_B]) {
      expect([...hubOf.values()].filter((each) => each === hub).length, hub).toBeGreaterThan(30);
    }
    for (const { name, others } of CROSSED) {
      for (const hub of [HUB_A, HUB_B]) {
        const found = await idsUnder(SCOPES[3], ORACLE({ ...others, hubId: hub }));
        expect(found.length, `${name} in ${hub}`).toBeGreaterThan(0);
      }
    }
  });

  // Break caught (AC-HUBF-06, GBT-GS14): a hub that is lost from the criteria (every hub's requests for the hub asked for), applied in some of the
  // paths only (the pool, the exception filter and the plain filters build their conditions along different ones), compared with another column,
  // or a scope that the hub widens (a hub outside the scope returns its requests) or narrows to nothing (a hub inside it returns none): the
  // criteria return what the definition returns, in each scope, for each hub and for none, beside each of the other filters.
  it.each(SCOPES.map((scope) => [scope.name, scope] as const))(
    'return, in %s, what the definition returns for each hub and for none, beside each of the other filters',
    async (scopeName, scope) => {
      const reach = reachOf(scope);
      const hubOf = await hubOfEveryRequest();
      let compared = 0;
      for (const { name, others } of CROSSED) {
        const read = new Map<string | null, string[]>();
        for (const hubId of HUBS) {
          const criteria: PickupRequestCriteria = { ...others, hubId };
          const expected = await idsUnder(scope, ORACLE(criteria));
          const actual = await idsUnder(scope, pickupRequestCriteria(criteria));
          expect(actual, `${name}, hub ${String(hubId)}`).toEqual(expected);
          read.set(hubId, actual);
          compared += 1;
        }
        const everything = read.get(null) ?? [];
        for (const hub of [HUB_A, HUB_B]) {
          const found = read.get(hub) ?? [];
          // The judge that is not the definition: the hub's share of what the same scope reads with no hub, by the hub the table gives each request.
          expect(found, `${name}: the share of ${hub} in the read with no hub`).toEqual(
            everything.filter((id) => hubOf.get(id) === hub),
          );
          // A hub the scope does not reach returns nothing, whatever else is asked; a hub it reaches returns something (each combination has
          // requests in each hub, which the test above shows).
          expect(found.length > 0, `${name}: ${hub} in ${scopeName}`).toBe(reach.has(hub));
        }
        // The two hubs between them are the whole of what the scope reads with no hub, and no request is in both.
        if (reach.has(HUB_A) && reach.has(HUB_B)) {
          expect([...(read.get(HUB_A) ?? []), ...(read.get(HUB_B) ?? [])].toSorted()).toEqual(
            everything,
          );
        }
      }
      // A pin of the size of the cross, which fails if a loop is shortened: 21 combinations of the other filters, each read as three hubs (none, the
      // first and the second).
      expect(compared).toBe(63);
    },
    120_000,
  );

  // Break caught: a hub that names no hub answered with something (an existence check that fails open, a condition that is not an equality, one
  // that falls back to no filter): it is nothing, in the scope that reaches every hub, whatever else is asked.
  it('return nothing for an identifier that names no hub, in the scope of all hubs, beside each of the other filters', async () => {
    const nobody = randomUUID();
    for (const { name, others } of CROSSED) {
      const criteria: PickupRequestCriteria = { ...others, hubId: nobody };
      expect(await idsUnder(SCOPES[3], pickupRequestCriteria(criteria)), name).toEqual([]);
      expect(await idsUnder(SCOPES[3], ORACLE(criteria)), `${name} (the definition)`).toEqual([]);
    }
  });

  // Break caught: a text comparison (`responsible_hub_id::text = $1`), which a hub written in capitals would not match: a UUID in capitals is the same
  // hub as in lower case, in a scope that reaches it and in one that reaches every hub, for each hub.
  it.each([
    ['the second hub', SCOPES[1]],
    ['all hubs', SCOPES[3]],
  ] as const)(
    'read a hub written in capitals as the same hub, in the scope of %s',
    async (_name, scope) => {
      for (const hub of [HUB_A, HUB_B]) {
        expect(
          hub.toUpperCase(),
          'a hub with letters, so that its capitals are another text',
        ).not.toBe(hub);
        for (const { name, others } of CROSSED) {
          const lower = await idsUnder(scope, pickupRequestCriteria({ ...others, hubId: hub }));
          const upper = await idsUnder(
            scope,
            pickupRequestCriteria({ ...others, hubId: hub.toUpperCase() }),
          );
          expect(upper, `${name}, hub ${hub}`).toEqual(lower);
        }
      }
    },
    120_000,
  );
});

/**
 * **The candidates of the exception filter were rewritten in task C3**: `id in (subquery)` became `id = any (array(subquery))`, because with the hub
 * as a condition of the same statement the planner ran the first as a nested loop that read the requested exceptions again for each pending request
 * of the hub (1.3 seconds against 39 milliseconds at 400,000 requests: features/operations/hub-filters.md, section 14.1). The Product Owner accepted the
 * rewrite on one condition (6 November 2026): **that it returns exactly what the old condition returned, across the roles, the hubs and the filters,
 * like the comparison with the definition above.** The old condition is kept here as the test's own text (`LEGACY_CANDIDATES`, the form of tasks C1 to
 * P1.1), the criteria are rebuilt with it (`legacyCriteria`: everything else is the function under test, the exception block is the old text), and the
 * two are compared in every scope (the roles: an Ops Staff or Senior Ops user of the first or of the second hub, one that reads both, a Platform Admin
 * of every hub, and a session that reads none), for each state of an exception, each hub and none, beside 48 combinations of the other filters; and,
 * for a Vendor session (the other branch of the read policies), beside the 16 of them that a Vendor can send.
 */
const LEGACY_CANDIDATES = (state: string): SQL => sql`pickup_request.id in (
            select x.pickup_request_id from one_package_exception x where x.state = ${state}::text
            union all
            select r.id from pickup_request r join one_package_exception c on c.id = r.one_package_exception_id where c.state = ${state}::text)`;

function legacyCriteria(criteria: PickupRequestCriteria): SQL {
  const { exceptionState } = criteria;
  const rest = pickupRequestCriteria({ ...criteria, exceptionState: null });
  if (exceptionState === null) return rest;
  // The approver's queue holds the pending requests alone (tasks C1.1 and P1.1); the other states have no such rule.
  const pending = exceptionState === 'REQUESTED' ? sql` and state = 'PENDING'` : sql``;
  return sql`${rest} and ${LEGACY_CANDIDATES(exceptionState)} and ${shownException('state')} = ${exceptionState}::text${pending}`;
}

describe('the exception filter, before and after the rewrite of its candidates (task C3)', () => {
  const EXCEPTIONS = ['REQUESTED', 'APPROVED', 'REJECTED'] as const;
  const OTHERS: OtherFilters[] = [];
  for (const state of STATES) {
    for (const manifested of MANIFESTED) {
      for (const serviceDate of DAYS) {
        for (const cutoffExceptionState of [null, 'PENDING_OPS_REVIEW'] as const) {
          OTHERS.push({
            state,
            exceptionState: null,
            cutoffExceptionState,
            serviceDate,
            manifested,
          });
        }
      }
    }
  }

  // Break caught: a comparison of the new text with itself (a legacy text that is no longer the subquery form, or criteria that are not the array form):
  // the two texts are different, and each is the form it is called.
  it('compares two different texts', () => {
    const asked = { ...NO_OTHER_FILTER, exceptionState: 'REQUESTED', hubId: null } as const;
    const before = inline(legacyCriteria(asked));
    const after = inline(pickupRequestCriteria(asked));

    expect(before).toMatch(/pickup_request\.id in \(/);
    expect(before).not.toMatch(/= any \(array\(/);
    expect(after).toMatch(/pickup_request\.id = any \(array\(/);
    expect(after).not.toMatch(/pickup_request\.id in \(/);
    expect(OTHERS).toHaveLength(48);
  });

  // Break caught: a rewrite of the candidates that returns another set than the condition it replaced (a request that shows an exception in the state
  // left out, as one the exception was raised for or one that carries it; or one let in that does not show it), in any scope, for any hub and for none,
  // beside any of the other filters.
  it.each(SCOPES.map((scope) => [scope.name, scope] as const))(
    'returns, in %s, exactly what the subquery form returned, for each state of an exception, each hub and none, beside the other filters',
    async (scopeName, scope) => {
      let compared = 0;
      const found = { REQUESTED: 0, APPROVED: 0, REJECTED: 0 };
      for (const exceptionState of EXCEPTIONS) {
        for (const hubId of HUBS) {
          for (const others of OTHERS) {
            const criteria: PickupRequestCriteria = { ...others, exceptionState, hubId };
            const before = await idsUnder(scope, legacyCriteria(criteria));
            const after = await idsUnder(scope, pickupRequestCriteria(criteria));
            expect(after, JSON.stringify(criteria)).toEqual(before);
            compared += 1;
            if (before.length > 0) found[exceptionState] += 1;
          }
        }
      }
      // A pin of the size of the cross, which fails if a loop is shortened: 3 states of an exception x 3 hubs x 48 combinations of the other filters.
      expect(compared).toBe(432);
      // Not a comparison of empty sets: a scope that reads requests finds some for EACH state of an exception in this cross, and the session that reads
      // none finds none.
      for (const exceptionState of EXCEPTIONS) {
        expect(found[exceptionState] > 0, `${scopeName}: ${exceptionState}`).toBe(
          scopeName !== 'no hub',
        );
      }
    },
    180_000,
  );

  // Break caught: the same, for a Vendor session: the other branch of the read policies of the requests and of the exceptions. A Vendor may send the
  // exception filter, the state, the day, the cut-off state and a hub; it may not send `manifested` (the service refuses it to a caller that is not
  // staff) and it reads no stop, so the cross leaves `manifested` out: 16 of the 48 combinations. One organisation made every request here, so this
  // session reads what the staff scope of all hubs reads: that the two forms agree for a Vendor is what this test shows; that a Vendor reads nothing of
  // another organisation is held by AC-HUBF-12 (hub-filters.db.test.ts), not by this test.
  it('returns, for a Vendor session of the organisation that made the requests, exactly what the subquery form returned', async () => {
    const vendorOthers = OTHERS.filter((others) => others.manifested === null);
    expect(vendorOthers).toHaveLength(16);
    let compared = 0;
    const found = { REQUESTED: 0, APPROVED: 0, REJECTED: 0 };
    for (const exceptionState of EXCEPTIONS) {
      for (const hubId of HUBS) {
        for (const others of vendorOthers) {
          const criteria: PickupRequestCriteria = { ...others, exceptionState, hubId };
          const before = await idsUnderVendor(vendorOrganization, legacyCriteria(criteria));
          const after = await idsUnderVendor(vendorOrganization, pickupRequestCriteria(criteria));
          expect(after, JSON.stringify(criteria)).toEqual(before);
          compared += 1;
          if (before.length > 0) found[exceptionState] += 1;
        }
      }
    }
    // A pin of the size of the cross, which fails if a loop is shortened: 3 states of an exception x 3 hubs x 16 combinations of the other filters.
    expect(compared).toBe(144);
    for (const exceptionState of EXCEPTIONS) {
      expect(found[exceptionState], exceptionState).toBeGreaterThan(0);
    }
    // The organisation reads every hub: with the filter of the second hub it finds the second hub's requests, which a one-hub staff session of the first hub never does.
    expect(
      await idsUnderVendor(
        vendorOrganization,
        pickupRequestCriteria({ ...NO_OTHER_FILTER, hubId: HUB_B }),
      ),
    ).not.toEqual([]);
  }, 180_000);
});
