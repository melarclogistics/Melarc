import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import type { AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import type {
  IdempotencyScope,
  IdempotencyStart,
  IdempotencyStore,
  StoredResponse,
} from '../platform/auth/ports/idempotency-store.port.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import type { DatabaseTransaction } from '../platform/database/database.service.js';
import type { SecurityContext } from '../platform/database/transaction-context.js';
import { registerTransactionFacts } from '../platform/database/transaction-facts.js';
import { bindTransactionHandle } from '../platform/database/transaction-handle.js';
import { ApiException } from '../platform/http/api-exception.js';
import type { ReasonValidator } from '../platform/settings/reason-validator.js';
import { serverError } from '../test-support/fake-pg.js';
import { ATTACH_CHUNK } from './collection-parcel-photos.js';
import { Collections, type CollectionBody } from './collection.service.js';
import { stopViewOf, type PickupStopRow } from './pickup-manifest-view.js';
import { pickupStopEtagOf } from './pickup-stop-etag.js';

/**
 * What `recordCollection` refuses before it reads anything (S1.26). The contract's validation answers most of these first, on the route; the service
 * states them again because it is the one place that knows what a count may hold, and a request that trusted its caller to have checked would pass a
 * bad value on to a statement. The route test of the real operation proves the answer a client sees; this proves the refusal, with no statement attempted.
 */
const RIDER = {
  session: { principalType: 'RIDER', principalId: 'A0000000-0000-4000-8000-000000000001' },
} as AuthorizedRequest;
const OFFICER = {
  session: { principalType: 'STAFF', principalId: 'B0000000-0000-4000-8000-000000000002' },
} as AuthorizedRequest;
const KEY = '0191a4f8-6c2e-7a3e-8f10-5d6c7b8a9e01';

/** A runner that notes that a transaction was attempted and answers an empty record. */
function service(): { readonly collections: Collections; readonly transactions: () => number } {
  let transactions = 0;
  const runner = {
    mutate: () => {
      transactions += 1;
      return Promise.resolve({ record: {} });
    },
  } as unknown as Pick<OperationRunner, 'mutate'>;
  const collections = new Collections({
    runner,
    audit: {} as AuditWriter,
    idempotency: {} as IdempotencyStore,
    clock: { now: () => new Date(0) },
    reasons: {} as Pick<ReasonValidator, 'validate'>,
  });
  return { collections, transactions: () => transactions };
}

const attempt = async (
  body: Partial<CollectionBody> & { readonly collected_count: number },
  over: { readonly who?: AuthorizedRequest; readonly key?: string } = {},
) => {
  const { collections, transactions } = service();
  const error = await collections
    .record(over.who ?? RIDER, 'correlation', 'stop', {
      body,
      ifMatch: '"x"',
      idempotencyKey: over.key ?? KEY,
      fingerprint: 'f',
    })
    .then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
  return { error, transactions: transactions() };
};

describe('the collection refuses what no count may hold, before it reads (S1.26)', () => {
  // Break caught: an officer or a vendor reaching the service, or a refusal that opened a transaction first.
  it('is the rider’s alone', async () => {
    const { error, transactions } = await attempt({ collected_count: 3 }, { who: OFFICER });
    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).code).toBe('PERMISSION_DENIED');
    expect(transactions).toBe(0);
  });

  // Break caught: a retry key that is not one reaching the idempotency store.
  it.each([
    ['an empty key', ''],
    ['a key with a control character', 'a\tb'],
    ['a key too long', 'k'.repeat(129)],
  ])('refuses %s as a validation failure naming the header', async (_what, key) => {
    const { error, transactions } = await attempt({ collected_count: 3 }, { key });
    expect((error as ApiException).code).toBe('VALIDATION_FAILED');
    expect((error as ApiException).details).toMatchObject({
      violations: [{ in: 'header', pointer: 'Idempotency-Key' }],
    });
    expect(transactions).toBe(0);
  });

  // Break caught: a count of zero that makes anything (it is a failed pickup, whatever else the body says), or one that is not a whole number or is negative.
  it('refuses zero as a failed pickup, and a count that is not a whole non-negative number', async () => {
    const zero = await attempt({ collected_count: 0, variance_reason_code: 'X' });
    expect((zero.error as ApiException).code).toBe('ZERO_COLLECTION_IS_FAILURE');
    expect(zero.transactions).toBe(0);
    for (const count of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      const refused = await attempt({ collected_count: count });
      expect((refused.error as ApiException).code, String(count)).toBe('VALIDATION_FAILED');
      expect(refused.transactions, String(count)).toBe(0);
    }
  });

  // Break caught: a note the ledger cannot keep reaching a statement, or the refusal repeating the text.
  it.each([
    ['a note with a line break', 'two\nlines'],
    ['a note with a control character', 'bell\u0007'],
    ['a note too long', 'x'.repeat(1001)],
  ])('refuses %s as a malformed body, naming the field', async (_what, note) => {
    const { error, transactions } = await attempt({ collected_count: 2, variance_note: note });
    expect((error as ApiException).code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify((error as ApiException).details)).toContain('/variance_note');
    expect(JSON.stringify((error as ApiException).details)).not.toContain('bell');
    expect(transactions).toBe(0);
  });

  // Break caught: a moment the database cannot hold (it has no year 0), that is not RFC 3339, or has no offset, reaching a statement as a server error.
  it.each([
    ['the year zero', '0000-06-01T00:00:00Z'],
    ['text that is not a moment', 'yesterday'],
    ['a moment with no offset', '2026-11-03T08:15:00'],
    ['a date with no time', '2026-11-03'],
    ['an impossible day', '2026-02-30T08:15:00Z'],
    ['an hour of 24, which the language reads as the next midnight', '2026-11-03T24:00:00Z'],
    ['a minute of 60', '2026-11-03T08:60:00Z'],
    ['an offset of 24 hours', '2026-11-03T08:15:00+24:00'],
  ])('refuses %s as a moment', async (_what, moment) => {
    const { error, transactions } = await attempt({ collected_count: 2, captured_at: moment });
    expect((error as ApiException).code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify((error as ApiException).details)).toContain('/captured_at');
    expect(transactions).toBe(0);
  });

  // Break caught: a refusal that is too wide, which would turn a legitimate count into a 400.
  it.each([
    ['a clean count', { collected_count: 3 }],
    ['the smallest count', { collected_count: 1 }],
    [
      'a short count with its reason and note',
      {
        collected_count: 2,
        variance_reason_code: 'SOME_PARCELS_NOT_READY',
        variance_note: 'Two boxes are in the back',
      },
    ],
    [
      'a moment with an offset and a fraction',
      { collected_count: 3, captured_at: '2026-11-03T08:15:00.250+00:00' },
    ],
    ['the first year there is', { collected_count: 3, captured_at: '0001-01-01T00:00:00Z' }],
  ])('goes on to the transaction with %s', async (_what, body) => {
    const { error, transactions } = await attempt(body);
    expect(error).toBeUndefined();
    expect(transactions).toBe(1);
  });
});

/**
 * `stageParcelPhotos` and the count that attaches what was staged (D-E1, 17 November 2026; the plan's Stage 6b), on a scripted transaction: every statement the service gives the
 * driver is read as the driver is given it (its text and its bound values), classified by what it does, and answered from a scenario. What the database decides (the guard of the
 * staged table, the deferred check of the count) is `parcel-photos.db.test.ts`'s; this is what the application does with the answer, and in what order it asks.
 */
const dialect = new PgDialect();
const STOP = '0191a4f8-6c2e-7a3e-8f10-5d6c7b8a9f01';
const RUN = '0191a4f8-6c2e-7a3e-8f10-5d6c7b8a9f02';
const REQUEST = '0191a4f8-6c2e-7a3e-8f10-5d6c7b8a9f03';
const HUB = '0191a4f8-6c2e-7a3e-8f10-5d6c7b8a9f04';
const RIDER_ID = RIDER.session.principalId.toLowerCase();
const CONTEXT: SecurityContext = {
  principalType: 'RIDER',
  principalId: RIDER_ID,
  surface: 'RIDER_ANDROID',
  hubScopeMode: 'SET',
  authorizedHubIds: [],
  correlationId: 'correlation',
};

const photo = (n: number): string => `0191a4f8-6c2e-7a3e-8f10-${n.toString(16).padStart(12, '0')}`;
const photos = (from: number, count: number): string[] =>
  Array.from({ length: count }, (_, index) => photo(from + index));

type Kind =
  | 'stop'
  | 'run'
  | 'recorded'
  | 'excused'
  | 'stored'
  | 'stagedInsert'
  | 'stagedCount'
  | 'stagedNamed'
  | 'attachStaged'
  | 'attachNamed'
  | 'direction'
  | 'recordInsert'
  | 'envelope'
  | 'promote';

/** The statements the two acts give, told apart by what they say. The first that matches names the statement. */
const KINDS: readonly (readonly [Kind, RegExp])[] = [
  ['stop', /from pickup_stop where id = \$1::uuid for update/],
  ['run', /from pickup_manifest where id/],
  ['recorded', /from collection_record where pickup_stop_id/],
  ['excused', /from parcel_photo_exception/],
  ['stored', /from evidence as e/],
  ['stagedInsert', /insert into collection_parcel_photo_staged/],
  ['stagedCount', /count\(\*\) as staged from collection_parcel_photo_staged/],
  ['stagedNamed', /select 1 as staged from collection_parcel_photo_staged/],
  [
    'attachStaged',
    /insert into collection_parcel_photo \(evidence_id, collection_record_id\) select s.evidence_id/,
  ],
  [
    'attachNamed',
    /insert into collection_parcel_photo \(evidence_id, collection_record_id\) select photo/,
  ],
  ['direction', /collection_handshake_type/],
  ['recordInsert', /insert into collection_record/],
  ['envelope', /shortfall_envelope|over_count_envelope/],
  ['promote', /promote_collected_sender/],
];

interface Statement {
  readonly kind: Kind;
  readonly sql: string;
  readonly params: readonly unknown[];
}

interface Scenario {
  /** The stop the database finds: `null` for none; the state it is in and the number its booking declared. */
  readonly stop?: { readonly state?: string; readonly declared?: number } | null;
  /** The state of the stop's run: `null` for none. */
  readonly run?: string | null;
  /** A collection record exists for the stop. */
  readonly recorded?: boolean;
  /** Ops let the stop through without parcel photos. */
  readonly excused?: boolean;
  /** Every named photo is a stored one of this rider and this stop (the default); `false` leaves one of them out of what the database finds. */
  readonly usable?: boolean;
  /** How many photos are staged for the stop when the service counts them. */
  readonly staged?: number;
  /** One of the named photos is also staged. */
  readonly stagedNamed?: boolean;
  /** What the idempotency store answers: a new command by default. */
  readonly begun?: IdempotencyStart;
  /** How many rows each statement that attaches the staged photos answers, in turn (a full chunk is told that another may follow); none when it is not given. */
  readonly attached?: readonly number[];
  /** A statement that is refused by the database, by the kind of statement. */
  readonly fail?: Partial<Record<Kind, Error>>;
}

const kindOf = (text: string): Kind | undefined =>
  KINDS.find(([, pattern]) => pattern.test(text))?.[0];

/** The collections service on a scripted transaction, with everything it gave the driver, the idempotency store and the audit. */
function scripted(scenario: Scenario = {}) {
  const log: Statement[] = [];
  const begins: { scope: IdempotencyScope; fingerprint: string }[] = [];
  const completed: { scope: IdempotencyScope; response: StoredResponse }[] = [];
  const audits: string[] = [];
  let transactions = 0;
  let attachments = 0;
  const declared = scenario.stop?.declared ?? 3;
  const stopRow = {
    id: STOP,
    pickup_manifest_id: RUN,
    pickup_request_id: REQUEST,
    sequence: 1,
    state: scenario.stop?.state ?? 'ARRIVED',
    arrived_at: '2026-11-17T08:00:00.000Z',
    failure_category: null,
    failure_reason_snapshot: null,
    skip_snapshot: null,
    pickup_summary: {
      reference: 'PR-1',
      sender_display_name: 'A sender',
      declared_package_count: declared,
      resolved_pickup_location: { address: 'A road' },
      location_note: null,
      contact_phone: null,
    },
    version: 1,
    responsible_hub_id: HUB,
  } as unknown as PickupStopRow & { version: number; responsible_hub_id: string };
  const etag = pickupStopEtagOf(stopViewOf(stopRow), 1);

  const transaction = {
    execute: (statement: SQL) => {
      const query = dialect.sqlToQuery(statement);
      const text = query.sql.replace(/\s+/g, ' ').trim();
      const kind = kindOf(text);
      if (kind === undefined) return Promise.reject(new Error(`An unexpected statement: ${text}`));
      log.push({ kind, sql: text, params: query.params });
      const refused = scenario.fail?.[kind];
      if (refused !== undefined) return Promise.reject(refused);
      switch (kind) {
        case 'stop':
          return Promise.resolve({ rows: scenario.stop === null ? [] : [stopRow] });
        case 'run':
          return Promise.resolve({
            rows: scenario.run === null ? [] : [{ state: scenario.run ?? 'IN_PROGRESS' }],
          });
        case 'recorded':
          return Promise.resolve({ rows: scenario.recorded === true ? [{ id: 'x' }] : [] });
        case 'excused':
          return Promise.resolve({ rows: scenario.excused === true ? [{ excused: 1 }] : [] });
        case 'stored': {
          const named = String(query.params[0]).slice(1, -1).split(',').length;
          const found = scenario.usable === false ? named - 1 : named;
          return Promise.resolve({ rows: Array.from({ length: found }, (_, id) => ({ id })) });
        }
        case 'stagedCount':
          return Promise.resolve({ rows: [{ staged: String(scenario.staged ?? 0) }] });
        case 'stagedNamed':
          return Promise.resolve({ rows: scenario.stagedNamed === true ? [{ staged: 1 }] : [] });
        case 'attachStaged': {
          const rows = scenario.attached?.[attachments] ?? 0;
          attachments += 1;
          return Promise.resolve({
            rows: Array.from({ length: rows }, (_, id) => ({ evidence_id: id })),
          });
        }
        case 'direction':
          return Promise.resolve({ rows: [{ handshake_type: 'VENDOR_ENTERED_RIDER_DISPLAYED' }] });
        case 'recordInsert':
          return Promise.resolve({
            rows: [
              {
                id: query.params[0],
                pickup_stop_id: STOP,
                responsible_hub_id: HUB,
                declared_count: declared,
                collected_count: query.params[3],
                variance: 'MATCH',
                variance_reason_snapshot: null,
                office_notified_at: null,
                handshake_type: 'VENDOR_ENTERED_RIDER_DISPLAYED',
                captured_at: null,
                recorded_by: RIDER_ID,
              },
            ],
          });
        default:
          return Promise.resolve({ rows: [] });
      }
    },
  } as unknown as DatabaseTransaction;
  registerTransactionFacts(transaction, {
    statementsSinceContext: () => log.length,
    markContextApplied: () => undefined,
    appliedContext: () => CONTEXT,
  });
  const handle = bindTransactionHandle(transaction);

  const runner = {
    mutate: (
      _authorized: unknown,
      _correlation: unknown,
      work: (given: unknown) => Promise<unknown>,
    ) => {
      transactions += 1;
      return work(handle);
    },
  } as unknown as Pick<OperationRunner, 'mutate'>;
  const idempotency = {
    begin: (_handle: unknown, scope: IdempotencyScope, fingerprint: string) => {
      begins.push({ scope, fingerprint });
      return Promise.resolve(scenario.begun ?? { outcome: 'NEW', recordId: 'r' });
    },
    complete: (_handle: unknown, scope: IdempotencyScope, response: StoredResponse) => {
      completed.push({ scope, response });
      return Promise.resolve();
    },
  } as unknown as IdempotencyStore;
  const audit = {
    write: (_handle: unknown, event: { code: string }) => {
      audits.push(event.code);
      return Promise.resolve();
    },
  } as unknown as AuditWriter;
  const collections = new Collections({
    runner,
    audit,
    idempotency,
    clock: { now: () => new Date(0) },
    reasons: {
      validate: () => Promise.reject(new Error('A count that matches asks for no reason')),
    },
  });
  return {
    collections,
    etag,
    log,
    kinds: (): Kind[] => log.map((statement) => statement.kind),
    statement: (kind: Kind): Statement | undefined => log.find((one) => one.kind === kind),
    begins,
    completed,
    audits,
    transactions: () => transactions,
  };
}

const outcomeOf = <T>(work: Promise<T>) =>
  work.then(
    (answer): { answer: T | undefined; error: unknown } => ({ answer, error: undefined }),
    (error: unknown): { answer: T | undefined; error: unknown } => ({ answer: undefined, error }),
  );

async function staging(
  scenario: Scenario,
  ids: unknown,
  over: { readonly who?: AuthorizedRequest; readonly key?: string } = {},
) {
  const run = scripted(scenario);
  const outcome = await outcomeOf(
    run.collections.stage(over.who ?? RIDER, 'correlation', STOP, {
      body: { parcel_photo_ids: ids as string[] },
      idempotencyKey: over.key ?? KEY,
      fingerprint: 'f',
    }),
  );
  return { ...run, ...outcome };
}

async function counting(
  scenario: Scenario,
  body: Partial<CollectionBody> & { readonly collected_count: number },
) {
  const run = scripted(scenario);
  const outcome = await outcomeOf(
    run.collections.record(RIDER, 'correlation', STOP, {
      body,
      ifMatch: run.etag,
      idempotencyKey: KEY,
      fingerprint: 'f',
    }),
  );
  return { ...run, ...outcome };
}

/** What a refusal says: its code, and the rule it names, in `details.rule` or in the first violation. */
function refusalOf(error: unknown): { code: string; rule?: string } {
  expect(error).toBeInstanceOf(ApiException);
  const refused = error as ApiException;
  const details = refused.details as
    { rule?: string; violations?: { rule?: string }[] } | undefined;
  const rule = details?.rule ?? details?.violations?.[0]?.rule;
  return { code: refused.code, ...(rule === undefined ? {} : { rule }) };
}

/** A refusal of the guard of the staged table (migration 0108), as the server sends it: SQLSTATE 23514, the reason in the DETAIL and the rule in the HINT. */
function guarded(reason: string, rule?: string): Error {
  const error = serverError('23514', 'the staged photo is refused');
  error.detail = `reason=${reason}`;
  if (rule !== undefined) error.hint = `rule=${rule}`;
  return error;
}

describe('stageParcelPhotos refuses what no batch may hold, before it reads (D-E1)', () => {
  const some = photos(1, 2);

  // Break caught: an officer or a vendor reaching the service, or a refusal that opened a transaction first.
  it('is the rider’s alone', async () => {
    const { error, transactions, log } = await staging({}, some, { who: OFFICER });
    expect(refusalOf(error)).toEqual({ code: 'PERMISSION_DENIED' });
    expect(transactions()).toBe(0);
    expect(log).toHaveLength(0);
  });

  // Break caught: a retry key that is not one reaching the idempotency store.
  it.each([
    ['an empty key', ''],
    ['a key with a control character', 'a\tb'],
    ['a key too long', 'k'.repeat(129)],
  ])('refuses %s as a validation failure naming the header', async (_what, key) => {
    const { error, transactions } = await staging({}, some, { key });
    expect(refusalOf(error).code).toBe('VALIDATION_FAILED');
    expect((error as ApiException).details).toMatchObject({
      violations: [{ in: 'header', pointer: 'Idempotency-Key' }],
    });
    expect(transactions()).toBe(0);
  });

  // Break caught: a batch that is not one (none, too many, not an identifier, one twice) reaching a statement; the refusal is the batch's rule and no transaction was opened.
  it.each([
    ['an empty batch', 'minItems', []],
    ['no list', 'minItems', undefined],
    ['501 photos', 'maxItems', photos(1, 501)],
    ['a value that is not an identifier', 'format', [photo(1), 'not-a-uuid']],
    ['an identifier that is a list of two', 'format', [`${photo(1)},${photo(2)}`]],
    ['a photo twice', 'duplicate', [photo(1), photo(2), photo(1).toUpperCase()]],
  ])('refuses %s as %s, with no transaction and no statement', async (_what, rule, batch) => {
    const { error, transactions, log } = await staging({}, batch);
    expect(refusalOf(error)).toEqual({ code: 'VALIDATION_FAILED', rule });
    expect(transactions()).toBe(0);
    expect(log).toHaveLength(0);
  });
});

describe('stageParcelPhotos judges the retry and the stop, in this order (D-E1)', () => {
  const batch = photos(1, 3);

  // Break caught: a replay that runs the command again, or that answers anything but the stored answer.
  it('answers the stored answer of a replay and gives the database no statement', async () => {
    const stored = { pickup_stop_id: STOP, staged_count: 41 };
    const { answer, log, completed } = await staging(
      {
        begun: {
          outcome: 'REPLAY',
          response: { status: 200, body: new TextEncoder().encode(JSON.stringify(stored)) },
        },
      },
      batch,
    );
    expect(answer).toEqual(stored);
    expect(log).toHaveLength(0);
    expect(completed).toHaveLength(0);
  });

  // Break caught: another body under the same key run as if it were new.
  it('refuses another body under the same key as IDEMPOTENCY_KEY_CONFLICT, with no statement', async () => {
    const { error, log, completed } = await staging({ begun: { outcome: 'CONFLICT' } }, batch);
    expect(refusalOf(error).code).toBe('IDEMPOTENCY_KEY_CONFLICT');
    expect(log).toHaveLength(0);
    expect(completed).toHaveLength(0);
  });

  // Break caught: a command that began and did not complete run again, or answered as a refusal of the client's.
  it('treats a stranded command as a defect and runs nothing', async () => {
    const { error, log } = await staging(
      { begun: { outcome: 'STRANDED' } as unknown as IdempotencyStart },
      batch,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ApiException);
    expect(log).toHaveLength(0);
  });

  // Break caught: a stop that is not the rider's, and one that does not exist, told apart (one answer), or the run of a stop that is not there taken for the rider's.
  it.each([
    ['a stop that is not found', { stop: null }],
    ['a stop whose run is not found', { run: null }],
  ])('answers NOT_ASSIGNED_RIDER for %s, and stages nothing', async (_what, scenario) => {
    const { error, kinds } = await staging(scenario, batch);
    expect(refusalOf(error).code).toBe('NOT_ASSIGNED_RIDER');
    expect(kinds()).not.toContain('stagedInsert');
  });

  // Break caught: a batch staged on a run that is not in progress (not yet started, or over).
  it('answers MANIFEST_NOT_STARTED for a run that is dispatched and not started', async () => {
    const { error, kinds } = await staging({ run: 'DISPATCHED' }, batch);
    expect(refusalOf(error)).toEqual({ code: 'MANIFEST_NOT_STARTED' });
    expect(kinds()).toEqual(['stop', 'run']);
  });

  it.each(['COMPLETED', 'CANCELLED', 'DRAFT'])(
    'answers STATE_CONFLICT run_not_in_progress for a run that is %s',
    async (state) => {
      const { error, kinds } = await staging({ run: state }, batch);
      expect(refusalOf(error)).toEqual({ code: 'STATE_CONFLICT', rule: 'run_not_in_progress' });
      expect(kinds()).toEqual(['stop', 'run']);
    },
  );

  // Break caught: a batch staged for a stop the rider has not arrived at, or one that was worked or skipped.
  it('answers stop_not_arrived for a stop that is pending, and stop_resolved for one that was worked', async () => {
    const pending = await staging({ stop: { state: 'PENDING' } }, batch);
    expect(refusalOf(pending.error)).toEqual({ code: 'STATE_CONFLICT', rule: 'stop_not_arrived' });
    for (const state of ['COLLECTED', 'FAILED', 'SKIPPED']) {
      const resolved = await staging({ stop: { state } }, batch);
      expect(refusalOf(resolved.error), state).toEqual({
        code: 'STATE_CONFLICT',
        rule: 'stop_resolved',
      });
      expect(resolved.kinds(), state).not.toContain('stagedInsert');
    }
  });

  // Break caught (the staged set is closed by the count): a batch staged for a stop that has its count.
  it('answers collection_recorded for a stop that has its count, before it reads any photo', async () => {
    const { error, kinds } = await staging({ recorded: true }, batch);
    expect(refusalOf(error)).toEqual({ code: 'STATE_CONFLICT', rule: 'collection_recorded' });
    expect(kinds()).toEqual(['stop', 'run', 'recorded']);
  });

  // Break caught: a batch staged for a stop Ops let through without photos (the photos would be staged and never counted).
  it('answers parcel_photo_exception for a stop Ops let through without photos, before it reads any photo', async () => {
    const { error, kinds } = await staging({ excused: true }, batch);
    expect(refusalOf(error)).toEqual({ code: 'STATE_CONFLICT', rule: 'parcel_photo_exception' });
    expect(kinds()).toEqual(['stop', 'run', 'recorded', 'excused']);
  });

  // Break caught: a photo that cannot be used staged, or told apart from the others (one answer), or the insert run after the refusal.
  it('answers EVIDENCE_NOT_STORED when one photo of the batch cannot be used, and inserts nothing', async () => {
    const { error, kinds, completed } = await staging({ usable: false }, batch);
    expect(refusalOf(error)).toEqual({ code: 'EVIDENCE_NOT_STORED' });
    expect(kinds()).not.toContain('stagedInsert');
    expect(completed).toHaveLength(0);
  });
});

describe('stageParcelPhotos answers the guard of the staged table as the contract names it (D-E1)', () => {
  const batch = photos(1, 2);

  // Break caught: a refusal of the database (a count or an exception that came between the service's reading and its insert) answered as a server error, or as another rule.
  it.each([
    [
      'a count that was made meanwhile',
      guarded('STATE_CONFLICT', 'collection_recorded'),
      { code: 'STATE_CONFLICT', rule: 'collection_recorded' },
    ],
    [
      'an exception that was authorised meanwhile',
      guarded('STATE_CONFLICT', 'parcel_photo_exception'),
      { code: 'STATE_CONFLICT', rule: 'parcel_photo_exception' },
    ],
    [
      'a stop that is no longer arrived at',
      guarded('STATE_CONFLICT'),
      { code: 'STATE_CONFLICT', rule: 'stop_not_arrived' },
    ],
    [
      'a stop refused with a rule the service does not know',
      guarded('STATE_CONFLICT', 'something_else'),
      { code: 'STATE_CONFLICT', rule: 'stop_not_arrived' },
    ],
    [
      'a photo that is no longer usable',
      guarded('EVIDENCE_NOT_STORED'),
      { code: 'EVIDENCE_NOT_STORED' },
    ],
    [
      'a refusal the driver wrapped',
      new Error('Failed query', { cause: guarded('STATE_CONFLICT', 'collection_recorded') }),
      { code: 'STATE_CONFLICT', rule: 'collection_recorded' },
    ],
  ])('answers %s', async (_what, failure, expected) => {
    const { error, completed } = await staging({ fail: { stagedInsert: failure } }, batch);
    expect(refusalOf(error)).toEqual(expected);
    expect(completed).toHaveLength(0);
  });

  // Break caught: any other failure of the insert (a lost connection, a SQLSTATE of no guard) taken for a refusal of the client's, and so hidden.
  it.each([
    ['a failure that is not the server’s', new Error('connection lost')],
    ['another SQLSTATE', serverError('23505', 'duplicate key')],
    ['a check violation with no reason', serverError('23514', 'a check')],
    ['another reason', guarded('GRANT_EXPIRED')],
  ])('lets %s go up as it is', async (_what, failure) => {
    const { error } = await staging({ fail: { stagedInsert: failure } }, batch);
    expect(error).toBe(failure);
  });
});

describe('stageParcelPhotos puts the photos aside (D-E1)', () => {
  // Break caught: the answer built from the batch's size and not from the rows the stop has staged now, so that a batch sent twice is counted twice; or an answer that lists the photos.
  it('inserts the batch in one statement, answers how many are staged now and completes the key with that answer', async () => {
    const batch = photos(1, 3).map((id, index) => (index === 1 ? id.toUpperCase() : id));
    const { answer, log, kinds, completed, begins, audits, transactions } = await staging(
      { staged: 7 },
      batch,
    );
    expect(answer).toEqual({ pickup_stop_id: STOP, staged_count: 7 });
    expect(Object.keys(answer as object).sort()).toEqual(['pickup_stop_id', 'staged_count']);
    // The stop, the run, the count, the exception, the photos found, the insert, and then the number of rows the stop has.
    expect(kinds()).toEqual([
      'stop',
      'run',
      'recorded',
      'excused',
      'stored',
      'stagedInsert',
      'stagedCount',
    ]);
    const insert = log.find((statement) => statement.kind === 'stagedInsert');
    expect(insert?.params).toEqual([`{${photos(1, 3).join(',')}}`]);
    expect(insert?.sql).toContain('on conflict (evidence_id) do nothing');
    expect(log.find((statement) => statement.kind === 'stop')?.sql).toContain('for update');
    expect(transactions()).toBe(1);
    // It changes nothing but its rows: no event, no count.
    expect(audits).toEqual([]);
    expect(kinds()).not.toContain('recordInsert');
    // The retry key is of this operation, this rider (in lower case) and this key.
    expect(begins).toEqual([
      {
        scope: {
          principalType: 'RIDER',
          principalId: RIDER_ID,
          operationId: 'stageParcelPhotos',
          key: KEY,
        },
        fingerprint: 'f',
      },
    ]);
    expect(completed).toHaveLength(1);
    expect(completed[0]?.scope).toEqual(begins[0]?.scope);
    expect(completed[0]?.response.status).toBe(200);
    expect(JSON.parse(Buffer.from(completed[0]?.response.body ?? []).toString('utf8'))).toEqual({
      pickup_stop_id: STOP,
      staged_count: 7,
    });
  });

  // Break caught: the photos read for the rider's own and this stop's by a statement that does not say so (any photo of any rider staged), or a statement that is not one for the whole batch.
  it('asks the database for photos that are stored, this rider’s and this stop’s, in one statement for a full batch', async () => {
    const { statement, kinds, answer } = await staging({ staged: 500 }, photos(1, 500));
    const found = statement('stored');
    expect(found?.sql).toMatch(/e\.state = 'STORED'/);
    expect(found?.sql).toMatch(/e\.purpose = 'PARCEL_PHOTO'/);
    expect(found?.sql).toMatch(/e\.owner_type = 'PICKUP_STOP' and e\.owner_id = \$2::uuid/);
    expect(found?.sql).toMatch(/e\.captured_by_actor = \$3::uuid/);
    expect(found?.params.slice(1)).toEqual([STOP, RIDER_ID]);
    expect(kinds().filter((kind) => kind === 'stagedInsert')).toHaveLength(1);
    expect(answer).toEqual({ pickup_stop_id: STOP, staged_count: 500 });
  });
});

describe('recordCollection attaches the staged photos with the ones it names (D-E1)', () => {
  const named = photos(100, 1);

  // Break caught: the staged photos left out of the number or of the attachment: a count that staged two photos and names one refused, or attached with the named one alone.
  it('counts the staged and the named together, attaches the staged ones first and then the named ones, and answers how many in all', async () => {
    const { answer, error, kinds, statement, completed } = await counting(
      { staged: 2 },
      { collected_count: 3, parcel_photo_ids: named },
    );
    expect(error).toBeUndefined();
    // The order of the reading: the exception, the number staged, the staged ones among the named, the named ones found, and only then the count; the attachment follows it, staged first.
    expect(kinds()).toEqual([
      'stop',
      'run',
      'recorded',
      'direction',
      'excused',
      'stagedCount',
      'stagedNamed',
      'stored',
      'recordInsert',
      'attachStaged',
      'attachNamed',
      'promote',
    ]);
    expect(statement('stagedCount')?.params).toEqual([STOP]);
    expect(statement('stagedNamed')?.params).toEqual([`{${named.join(',')}}`]);
    const recordId = statement('recordInsert')?.params[0];
    expect(statement('attachNamed')?.params).toEqual([recordId, `{${named.join(',')}}`]);
    expect(statement('attachStaged')?.params).toEqual([recordId, STOP, ATTACH_CHUNK]);
    expect(statement('attachStaged')?.sql).toMatch(/order by s.staged_at, s.evidence_id/);
    // The answer lists the photos the request named and states how many were attached in all; the replay returns the same.
    expect(answer?.record.parcel_photo_ids).toEqual(named);
    expect(answer?.record.parcel_photo_count).toBe(3);
    expect(JSON.parse(Buffer.from(completed[0]?.response.body ?? []).toString('utf8'))).toEqual({
      record: answer?.record,
    });
  });

  // Break caught: a count that staged all of its photos refused for naming none, or one that asks the database for named photos it does not have, or an answer that lists the staged ones.
  it('takes a count that staged all of its photos and names none, in one attachment, and lists none', async () => {
    const { answer, error, kinds } = await counting({ staged: 3 }, { collected_count: 3 });
    expect(error).toBeUndefined();
    expect(kinds()).toContain('attachStaged');
    expect(kinds()).not.toContain('attachNamed');
    expect(kinds()).not.toContain('stored');
    expect(kinds()).not.toContain('stagedNamed');
    expect(Object.keys(answer?.record ?? {})).not.toContain('parcel_photo_ids');
    expect(answer?.record.parcel_photo_count).toBe(3);
  });

  // Break caught: a collection above what a request names, taken as a count that is not the photos' number (D-E1: no cap on a pickup), or the staged ones read into the answer.
  it('takes a collection of 600 parcels with 599 staged and one named, and answers one identifier and a count of 600', async () => {
    const { answer, error } = await counting(
      { staged: 599, stop: { declared: 600 } },
      { collected_count: 600, parcel_photo_ids: named },
    );
    expect(error).toBeUndefined();
    expect(answer?.record.parcel_photo_ids).toEqual(named);
    expect(answer?.record.parcel_photo_count).toBe(600);
  });

  // Break caught: a count that stages nothing changed for the worse: a statement for staged photos where there are none, or the attachment of the ones named lost.
  it('attaches only the named ones when none is staged, as before', async () => {
    const three = photos(100, 3);
    const { answer, error, kinds } = await counting(
      { staged: 0 },
      { collected_count: 3, parcel_photo_ids: three },
    );
    expect(error).toBeUndefined();
    expect(kinds()).not.toContain('attachStaged');
    expect(kinds()).toContain('attachNamed');
    expect(answer?.record.parcel_photo_ids).toEqual(three);
    expect(answer?.record.parcel_photo_count).toBe(3);
  });

  // Break caught: the number that is not the count's let through (staged and named too few or too many), or the refusal made after the record was written; and the staged set touched by a refusal.
  it.each([
    ['too few photos', { staged: 1 }, 1],
    ['too many photos', { staged: 3 }, 1],
    ['none at all', { staged: 0 }, 0],
  ])(
    'refuses a count with %s as parcel_photo_count, before it writes and leaving the staged set as it was',
    async (_what, scenario, namedCount) => {
      const { error, kinds, log, completed } = await counting(scenario, {
        collected_count: 3,
        parcel_photo_ids: photos(100, namedCount),
      });
      expect(refusalOf(error)).toEqual({ code: 'VALIDATION_FAILED', rule: 'parcel_photo_count' });
      expect(kinds()).not.toContain('recordInsert');
      expect(kinds()).not.toContain('attachStaged');
      expect(
        log.filter(
          (statement) =>
            statement.sql.includes('collection_parcel_photo_staged') &&
            /\b(insert|update|delete)\b/i.test(statement.sql),
        ),
      ).toEqual([]);
      expect(completed).toHaveLength(0);
    },
  );

  // Break caught: a photo that is staged and named too counted twice (the number would be right with one photo too few).
  it('refuses a photo that is staged and named as duplicate, before it writes', async () => {
    const { error, kinds } = await counting(
      { staged: 2, stagedNamed: true },
      { collected_count: 3, parcel_photo_ids: named },
    );
    expect(refusalOf(error)).toEqual({ code: 'VALIDATION_FAILED', rule: 'duplicate' });
    expect(kinds()).not.toContain('recordInsert');
    expect(kinds()).not.toContain('stored');
  });

  // Break caught: the number judged before the names, so that a photo that is staged and named is told as a wrong number whenever the two add up wrongly (the retry of a rider that does not know whether its
  // batch committed: staged three, count three, names the same three).
  it('tells a photo that is staged and named as duplicate even when the numbers do not add up', async () => {
    const { error, kinds } = await counting(
      { staged: 3, stagedNamed: true },
      { collected_count: 3, parcel_photo_ids: photos(100, 3) },
    );
    expect(refusalOf(error)).toEqual({ code: 'VALIDATION_FAILED', rule: 'duplicate' });
    expect(kinds()).not.toContain('recordInsert');
  });

  // Break caught: a collection attached in one statement however large (the statement timeout is one for all of it), or a loop that stops at the first chunk or never stops.
  it('attaches the staged photos in chunks and goes on while a chunk is full', async () => {
    const { error, kinds } = await counting(
      { staged: 4500, stop: { declared: 4500 }, attached: [ATTACH_CHUNK, ATTACH_CHUNK, 500] },
      { collected_count: 4500 },
    );
    expect(error).toBeUndefined();
    expect(kinds().filter((kind) => kind === 'attachStaged')).toHaveLength(3);
  });

  it('stops at a chunk that is not full, and asks once for a collection that fits in one', async () => {
    const { error, kinds } = await counting({ staged: 3, attached: [3] }, { collected_count: 3 });
    expect(error).toBeUndefined();
    expect(kinds().filter((kind) => kind === 'attachStaged')).toHaveLength(1);
  });

  // Break caught: a named photo that cannot be used let through beside the staged ones, or refused as another answer, or after the record was made.
  it('refuses a named photo that cannot be used as EVIDENCE_NOT_STORED, before it writes', async () => {
    const { error, kinds } = await counting(
      { staged: 2, usable: false },
      { collected_count: 3, parcel_photo_ids: named },
    );
    expect(refusalOf(error)).toEqual({ code: 'EVIDENCE_NOT_STORED' });
    expect(kinds()).not.toContain('recordInsert');
  });

  // Break caught: what is staged for a stop Ops let through counted (the stop would then refuse a count with no photos, or attach what Ops excused), or the number stated for it.
  it('ignores what is staged for a stop Ops let through, attaches nothing and states no number', async () => {
    const { answer, error, kinds } = await counting(
      { excused: true, staged: 4 },
      { collected_count: 3 },
    );
    expect(error).toBeUndefined();
    expect(kinds()).not.toContain('stagedCount');
    expect(kinds()).not.toContain('attachStaged');
    expect(kinds()).not.toContain('attachNamed');
    expect(kinds()).toContain('recordInsert');
    expect(Object.keys(answer?.record ?? {})).not.toContain('parcel_photo_count');
    expect(Object.keys(answer?.record ?? {})).not.toContain('parcel_photo_ids');
  });

  it('still refuses a photo named for a stop Ops let through, whatever is staged for it', async () => {
    const { error, kinds } = await counting(
      { excused: true, staged: 3 },
      { collected_count: 3, parcel_photo_ids: named },
    );
    expect(refusalOf(error)).toEqual({ code: 'VALIDATION_FAILED', rule: 'parcel_photo_count' });
    expect(kinds()).not.toContain('recordInsert');
  });

  // Break caught: a refusal of the attachment (a photo another count attached first) answered as a server error.
  it('answers EVIDENCE_NOT_STORED when the database refuses an attachment of the staged photos', async () => {
    const { error } = await counting(
      { staged: 3, fail: { attachStaged: guarded('EVIDENCE_NOT_STORED') } },
      { collected_count: 3 },
    );
    expect(refusalOf(error)).toEqual({ code: 'EVIDENCE_NOT_STORED' });
  });
});
