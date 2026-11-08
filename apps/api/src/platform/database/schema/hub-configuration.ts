import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { hub } from './reference-data.js';

/**
 * The hub's configuration: its service zones, the aliases that place an address in one, and its versioned settings
 * (`SLICE-001`, the Product Owner's decision of 29 October 2026, D-02: a bounded launch-fee seed; domain-model.md §6.20;
 * data-scope-registry.md `ServiceZone`, `ServiceZoneAlias`, `HubSetting`; settings.md §7.2 and §7.3).
 *
 * **Three immutable tables, written by a seed and nothing else.** A row is never updated or deleted by any login (a trigger
 * refuses both, the table owner included), and the runtime logins hold `SELECT` and no write: a new version of a setting is a
 * new row. `SLICE-014` later adds proposals and approvals that write the same tables through their own definer function, and
 * changes none of the columns.
 *
 * - **A zone answers serviceability** (is this address served, in which service area, on which days) **and is never a price
 *   input** (`MSC-DEC-207`): the fee is the service area's flat fee, whatever the origin.
 * - **An alias is the whole address-to-zone rule** (§23.3: *a free-text address is never authoritative*). It is stored in its
 *   normalised form (trimmed, case-folded, single-spaced) and a check refuses any other, so a lookup is an exact match on a
 *   normalised token sequence and never a fuzzy one. There is no geocoding. **No alias is seeded**: the data is the Product
 *   Owner's to supply (OB-S1-02).
 * - **A hub setting is versioned and effective-dated**: `(hub, key, scope_ref, version)` is unique, versions start at 1, and the
 *   value in force at an instant is the row with the greatest `effective_from` not after it. `scope_ref` is empty for a hub-wide
 *   value and a service-area code for a per-service-area one (`service_area_base_fee`, `corridor_off_day_fee`). The value is JSON
 *   in the shape its key defines (`hub-settings.ts` validates it); money is integer pesewas. A missing value is
 *   `SETTING_MISSING` and another hub's value is never used (§33.4).
 *
 * This file is the *shape*. The migration (`0042_hub_configuration.sql`) adds by hand, in the same change: the owner
 * (`melarc_owner`), `ENABLE` and `FORCE ROW LEVEL SECURITY`, the policies (a staff member reads the hubs of their scope; the
 * `configuration` capability reads for server-side rule evaluation; the `seed` capability reads and inserts for the definer
 * function; every other principal is denied by the closed `ELSE`), the read grants, the immutability triggers and
 * `melarc.seed_hub_configuration`, the one way rows enter.
 */

/** The service areas a zone belongs to (settings.md §7.2: Accra & Tema, Amasaman & Environs, Kasoa Corridor). */
export const SERVICE_AREAS = ['ACCRA_TEMA', 'AMASAMAN_ENVIRONS', 'KASOA_CORRIDOR'] as const;
export type ServiceArea = (typeof SERVICE_AREAS)[number];

/** The two kinds of alias: a named landmark, or a named area. */
export const ZONE_ALIAS_KINDS = ['LANDMARK', 'AREA'] as const;
export type ZoneAliasKind = (typeof ZONE_ALIAS_KINDS)[number];

const quoted = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(', ');

export const serviceZone = pgTable(
  'service_zone',
  {
    id: uuid('id').primaryKey(),
    hubId: uuid('hub_id').notNull(),
    /** The machine code, stable and never reused: `TEMA`, `AMASAMAN_ENVIRONS`. */
    code: text('code').notNull(),
    /** The display name: `Lapaz/Sowutuom`, `Amasaman & Environs`. */
    name: text('name').notNull(),
    serviceArea: text('service_area').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // No cascade: a hub that zones refer to is never removed under them.
    foreignKey({
      name: 'service_zone_hub_fkey',
      columns: [table.hubId],
      foreignColumns: [hub.id],
    }).onDelete('restrict'),
    unique('service_zone_hub_code_key').on(table.hubId, table.code),
    // The target of the alias's composite foreign key: an alias is in the same hub as its zone, by construction.
    unique('service_zone_id_hub_key').on(table.id, table.hubId),
    check('service_zone_code_grammar', sql`${table.code} ~ '^[A-Z][A-Z0-9_]*$'`),
    check('service_zone_name_not_empty', sql`length(btrim(${table.name})) > 0`),
    check(
      'service_zone_service_area_closed',
      sql.raw(`"service_zone"."service_area" IN (${quoted(SERVICE_AREAS)})`),
    ),
  ],
);

export const serviceZoneAlias = pgTable(
  'service_zone_alias',
  {
    id: uuid('id').primaryKey(),
    hubId: uuid('hub_id').notNull(),
    zoneId: uuid('zone_id').notNull(),
    /** Normalised: trimmed, case-folded and single-spaced. The check below refuses any other form. */
    alias: text('alias').notNull(),
    kind: text('kind').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'service_zone_alias_zone_fkey',
      columns: [table.zoneId, table.hubId],
      foreignColumns: [serviceZone.id, serviceZone.hubId],
    }).onDelete('restrict'),
    // One meaning per alias in a hub: an alias for two zones would be an ambiguous resolution that the data itself created.
    unique('service_zone_alias_hub_alias_key').on(table.hubId, table.alias),
    check(
      'service_zone_alias_normalised',
      sql`${table.alias} = lower(btrim(regexp_replace(${table.alias}, '[[:space:]]+', ' ', 'g'))) AND length(${table.alias}) > 0`,
    ),
    check(
      'service_zone_alias_kind_closed',
      sql.raw(`"service_zone_alias"."kind" IN (${quoted(ZONE_ALIAS_KINDS)})`),
    ),
  ],
);

export const hubSetting = pgTable(
  'hub_setting',
  {
    id: uuid('id').primaryKey(),
    hubId: uuid('hub_id').notNull(),
    settingKey: text('setting_key').notNull(),
    /** Empty for a hub-wide value; a service-area code for a per-service-area one. */
    scopeRef: text('scope_ref').notNull().default(''),
    /** Per `(hub, key, scope_ref)`, from 1. A new value is a new version, never an edit. */
    version: integer('version').notNull(),
    value: jsonb('value').notNull(),
    unit: text('unit').notNull(),
    /** The instant from which this version is in force. */
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Who entered it: the reserved system actor for a seed (migration 0019). */
    createdBy: uuid('created_by').notNull(),
  },
  (table) => [
    foreignKey({
      name: 'hub_setting_hub_fkey',
      columns: [table.hubId],
      foreignColumns: [hub.id],
    }).onDelete('restrict'),
    unique('hub_setting_version_key').on(
      table.hubId,
      table.settingKey,
      table.scopeRef,
      table.version,
    ),
    check('hub_setting_key_grammar', sql`${table.settingKey} ~ '^[A-Za-z][A-Za-z0-9_]*$'`),
    check('hub_setting_scope_ref_grammar', sql`${table.scopeRef} ~ '^([A-Z][A-Z0-9_]*)?$'`),
    check('hub_setting_version_positive', sql`${table.version} >= 1`),
    check('hub_setting_unit_not_empty', sql`length(btrim(${table.unit})) > 0`),
  ],
);
