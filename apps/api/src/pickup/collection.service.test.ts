import { describe, expect, it } from 'vitest';

import type { AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import type { IdempotencyStore } from '../platform/auth/ports/idempotency-store.port.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import { ApiException } from '../platform/http/api-exception.js';
import type { ReasonValidator } from '../platform/settings/reason-validator.js';
import { Collections, type CollectionBody } from './collection.service.js';

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
