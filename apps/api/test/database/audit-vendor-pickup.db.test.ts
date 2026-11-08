import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { serverErrorIn } from '../../src/platform/database/database-failures.js';
import type { SecurityContext } from '../../src/platform/database/transaction-context.js';
import { HUB_A, VENDOR_1, VENDOR_2, vendorContext } from './support/rls-fixture.js';
import { buildService } from './support/service.js';
import { createTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * S1.14: what a vendor's context may write to the audit ledger. Until `createPickupRequest` it wrote one event, its own sign-out
 * (migrations 0023 and 0026), and the policy named the actor, the surface, the code, the object and the outcome so that a principal
 * could not write a fact about anyone else's. A vendor books for itself and the act is audited in its transaction, so the policy gains
 * the same shape of arm for the vendor's own booking and its own cancellation of a request, and for nothing else: the actor is the
 * vendor's account, the surface its own, the object a pickup request, the request one of its own organisation, and the tier ordinary.
 */
let database: TestDatabase;
const ACCOUNT = '7e570000-0000-4000-8000-0000000000a1';

beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database.drop();
});

const context = (organisation: string): SecurityContext => ({
  ...vendorContext(organisation),
  principalId: ACCOUNT,
});

/** The state a vendor's insert of an event ends with, or `undefined` if the ledger took it. */
async function insertAs(
  as: SecurityContext,
  event: Partial<Record<string, string | boolean>> & { code: string },
): Promise<string | undefined> {
  const { service, close } = buildService(database);
  const fields = {
    event_code: event.code,
    actor_type: 'VENDOR_ACCOUNT',
    actor_id: ACCOUNT,
    surface_context: 'VENDOR_PWA',
    object_type: 'PickupRequest',
    object_id: randomUUID(),
    vendor_organization_id: VENDOR_1,
    responsible_hub_id: HUB_A,
    outcome: 'SUCCEEDED',
    enhanced: false,
    ...event,
  } as Record<string, string | boolean>;
  try {
    await service.transactionWithContext(as, async (tx) => {
      await tx.execute(sql`
        insert into audit_event (id, event_code, occurred_at, actor_type, actor_id, surface_context, vendor_organization_id,
                                 responsible_hub_id, object_type, object_id, correlation_id, outcome, enhanced, serialisation_version)
        values (gen_random_uuid(), ${fields.event_code}, now(), ${fields.actor_type}, ${fields.actor_id}::uuid,
                ${fields.surface_context}, ${fields.vendor_organization_id}::uuid, ${fields.responsible_hub_id}::uuid,
                ${fields.object_type}, ${fields.object_id}::uuid, 'test', ${fields.outcome}, ${fields.enhanced}, 1)`);
    });
    return undefined;
  } catch (error) {
    return serverErrorIn(error)?.code ?? 'other';
  } finally {
    await close();
  }
}

describe('a vendor’s own bookings in the ledger', () => {
  // Break caught: the vendor's booking unaudited (the act would commit with no record, or not commit at all).
  it.each(['pickup.request.created', 'pickup.request.cancelled'])(
    'takes its own %s for a request of its organisation',
    async (code) => {
      expect(await insertAs(context(VENDOR_1), { code })).toBeUndefined();
    },
  );

  // Break caught: a vendor writing a fact about another organisation's request, about another actor, from another surface, a request
  // outcome it did not have, or an enhanced event (whose failure would have to abort the act, which is not the vendor's to decide).
  it.each([
    ['another organisation’s request', { vendor_organization_id: VENDOR_2 }],
    ['another actor', { actor_id: randomUUID() }],
    ['the staff actor type', { actor_type: 'STAFF' }],
    ['another surface', { surface_context: 'OPS_PORTAL' }],
    ['an object that is not a pickup request', { object_type: 'Session' }],
    ['a failed outcome', { outcome: 'REJECTED' }],
    ['an enhanced tier', { enhanced: true }],
  ] as const)('refuses an event about %s', async (_label, over) => {
    expect(await insertAs(context(VENDOR_1), { code: 'pickup.request.created', ...over })).toBe(
      '42501',
    );
  });

  // Break caught: the arm widened to any event of the vendor's own: it may write these two and its sign-out, and nothing else.
  it.each([
    'pickup.request.confirmed',
    'pickup.request.cancelled_chargeable',
    'pickup.cancellation_charge.waived',
    'pickup.sender.saved',
    'staff.identity.created',
    'pickup.attempt.extended',
  ])('refuses %s', async (code) => {
    expect(await insertAs(context(VENDOR_1), { code })).toBe('42501');
  });

  it('refuses a context that is not a vendor’s, whatever the event says', async () => {
    const { service, close } = buildService(database);
    try {
      const refused = await service
        .transactionWithContext(
          {
            principalType: 'RIDER',
            principalId: ACCOUNT,
            surface: 'RIDER_ANDROID',
            riderId: ACCOUNT,
            correlationId: 'x',
          },
          async (tx) => {
            await tx.execute(sql`
              insert into audit_event (id, event_code, occurred_at, actor_type, actor_id, surface_context, vendor_organization_id,
                                       responsible_hub_id, object_type, object_id, correlation_id, outcome, enhanced, serialisation_version)
              values (gen_random_uuid(), 'pickup.request.created', now(), 'RIDER', ${ACCOUNT}::uuid, 'RIDER_ANDROID', ${VENDOR_1}::uuid,
                      ${HUB_A}::uuid, 'PickupRequest', gen_random_uuid(), 'test', 'SUCCEEDED', false, 1)`);
          },
        )
        .then(
          () => undefined,
          (error: unknown) => serverErrorIn(error)?.code,
        );
      expect(refused).toBe('42501');
    } finally {
      await close();
    }
  });
});
