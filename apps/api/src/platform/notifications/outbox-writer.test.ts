import { describe, expect, it } from 'vitest';

import type { TransactionHandle } from '../auth/ports/unit-of-work.port.js';
import { OutboxEventError, OutboxWriter, type OutboxEvent } from './outbox-writer.js';

/**
 * What the envelope writer refuses before it touches the transaction (S1.12a): an event that is not an audit event code, an operation
 * with no name, and a payload that may carry something personal or secret. The refusals come first, so a handle that stands for no
 * transaction is enough to see them; what the writer writes, and what the database then checks, is proved against PostgreSQL
 * (`notification-outbox.db.test.ts`, `pickup-request-confirmation-routes.db.test.ts`).
 */
const writer = new OutboxWriter({ now: () => new Date('2026-10-29T12:00:00Z') });
const handle = Object.freeze(Object.create(null) as object) as TransactionHandle;

const event = (over: Partial<OutboxEvent> = {}): OutboxEvent => ({
  eventType: 'pickup.request.confirmed',
  aggregate: { type: 'PICKUP_REQUEST', id: '5d1c8c1e-0000-4000-8000-000000000001' },
  responsibleHubId: '5eed0100-0000-4000-8000-000000000001',
  operationId: 'confirmPickupRequest',
  ...over,
});

/** The refusal of the payload or the event, and not the later failure of a handle that is bound to nothing. */
const refusal = (over: Partial<OutboxEvent>) =>
  writer.write(handle, event(over)).then(
    () => 'WRITTEN',
    (error: unknown) => (error instanceof OutboxEventError ? 'REFUSED' : 'OTHER'),
  );

describe('the outbox envelope writer’s refusals', () => {
  // Break caught: an event name the table would refuse, found by the act's transaction failing at the database.
  it.each([
    'Pickup.Confirmed',
    'pickup',
    'pickup..confirmed',
    'pickup.request confirmed',
    '',
    `pickup.${'x'.repeat(70)}`,
  ])('refuses %j as an event type', async (eventType) => {
    expect(await refusal({ eventType })).toBe('REFUSED');
  });

  it.each(['', 'x'.repeat(97)])('refuses an operation name of %j', async (operationId) => {
    expect(await refusal({ operationId: operationId === '' ? '' : operationId })).toBe('REFUSED');
  });

  // Break caught: a payload that carries what a dead-letter queue must not hold: a number, an address, a code, a token, a credential, a
  // name, a link.
  it.each([
    'phone',
    'phone_number',
    'msisdn',
    'address',
    'handshake_code',
    'otp',
    'token',
    'secret',
    'password',
    'email',
    'credential',
    'link',
    'url',
    'sender_name',
  ])('refuses a payload member called %s', async (key) => {
    expect(await refusal({ payload: { [key]: 'x' } })).toBe('REFUSED');
  });

  it.each([
    ['a name in capitals', { Count: 1 }],
    ['a name with a dash', { 'a-b': 1 }],
    ['a name that begins with a digit', { '1a': 1 }],
    ['a name that is too long', { [`k${'x'.repeat(32)}`]: 1 }],
    ['a value that is long text', { note: 'x'.repeat(65) }],
    ['a value that is not finite', { size: Number.POSITIVE_INFINITY }],
    ['a value that is an object', { size: { a: 1 } as unknown as string }],
    ['a value that is nothing', { size: null as unknown as string }],
    [
      'nine members',
      Object.fromEntries(Array.from({ length: 9 }, (_, at) => [`m${String(at)}`, at])),
    ],
  ])('refuses a payload with %s', async (_what, payload) => {
    expect(await refusal({ payload })).toBe('REFUSED');
  });

  // Break caught: a refusal that is a rejected promise of another kind (a defect), or a payload that is checked after the transaction is
  // touched: the handle here stands for nothing, so a payload that passes goes on to fail at the handle, and that is not a refusal.
  it('lets a small payload of plain names and short values through to the transaction', async () => {
    expect(await refusal({ payload: { packages: 3, late: false, band: 'A' } })).toBe('OTHER');
    expect(await refusal({})).toBe('OTHER');
  });
});
