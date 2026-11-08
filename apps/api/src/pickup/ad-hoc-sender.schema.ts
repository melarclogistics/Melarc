import { sql } from 'drizzle-orm';
import { check, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

export const AD_HOC_SENDER_STATES = ['PROVISIONAL', 'REUSABLE'] as const;

/**
 * The canonical ad-hoc sender (S1.13, `SLICE-001`; domain-model.md section 6.9 and 6.2; data-scope-registry.md `AdHocSender`;
 * `MSC-DEC-172`, `MSC-DEC-335`): a walk-in who is not a registered vendor, identified by a **verified phone**.
 *
 * - **The phone is the identity** (section 29.7): unique across the platform, normalised to E.164, with the form it was entered in kept
 *   beside it. A name is a label and identifies nobody. Cross-checking the phone against a rider's (section 30 forbids a collision) is
 *   not built here: the rider roster is read under another key.
 * - **Provisional until a physical pickup completes successfully** (sections 35.2.7 and 35.12.10): `PROVISIONAL`, then `REUSABLE`, a
 *   promotion made by the collection that completes (a later task of this slice). A provisional sender is **not searchable for reuse**;
 *   a second booking by the same phone while it is provisional reuses the row, because the phone is unique.
 * - **Never promoted to a registered vendor** by anything here: onboarding is a separate act (`SLICE-008`).
 * - **Goods are not part of the profile.** Identity is reusable and goods are not: today's description is captured on each request.
 *
 * Global (not hub-scoped): a phone identity is platform-wide, which is what makes the record platform-scoped. The migration
 * (`0045_pickup_requests.sql`) adds by hand: the owner, `ENABLE` and `FORCE ROW LEVEL SECURITY`, the policies and the grants.
 */
export const adHocSender = pgTable(
  'ad_hoc_sender',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    phone: text('phone').notNull(),
    phoneAsEntered: text('phone_as_entered').notNull(),
    businessName: text('business_name'),
    pickupContactName: text('pickup_contact_name'),
    pickupLocation: jsonb('pickup_location'),
    state: text('state').notNull().default('PROVISIONAL'),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('ad_hoc_sender_phone_key').on(table.phone),
    check('ad_hoc_sender_name_not_blank', sql`length(btrim(${table.name})) > 0`),
    check('ad_hoc_sender_phone_e164', sql`${table.phone} ~ '^\\+[1-9][0-9]{6,14}$'`),
    check(
      'ad_hoc_sender_state_closed',
      sql.raw(
        `"ad_hoc_sender"."state" IN (${AD_HOC_SENDER_STATES.map((value) => `'${value}'`).join(', ')})`,
      ),
    ),
    check(
      'ad_hoc_sender_location_has_address',
      sql`${table.pickupLocation} IS NULL OR (jsonb_typeof(${table.pickupLocation}) = 'object' AND coalesce(length(btrim(${table.pickupLocation}->>'address')), 0) > 0)`,
    ),
  ],
);
