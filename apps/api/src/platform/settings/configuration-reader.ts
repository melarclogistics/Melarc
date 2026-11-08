import { sql } from 'drizzle-orm';

import type { DatabaseService } from '../database/database.service.js';
import type { SecurityContext } from '../database/transaction-context.js';
import {
  HubConfiguration,
  type CompanyRuleRecord,
  type HubSettingRecord,
  type ServiceZoneRecord,
  type ZoneAliasRecord,
} from './hub-configuration.js';

/**
 * The reader of a hub's configuration (S1.4, `SLICE-001`; registry `configuration` capability, `CAPABILITY_ACCESS.configuration`).
 *
 * **Why it is a separate transaction under its own capability.** A booking placed by a vendor is priced as an estimate, and a vendor
 * context may read none of the hub's settings, zones or company rules (the registry denies it every one of them; `DENY` is the
 * closed `ELSE` of their policies). The rule is still the server's to evaluate, so the evaluation reads the configuration as a
 * `SYSTEM` context under the `configuration` capability, which sees the hub’s rows and the `COMPANY`-scope settings and nothing
 * else (migration 0042). The result is a plain snapshot (`HubConfiguration`); the operation then does its own work in the caller's
 * context with the snapshot in hand, and no vendor or rider context ever reads a table it is denied.
 *
 * It reads once, in one statement per table, at one instant: the version of each key and scope **in force at `at`** (the greatest
 * `effective_from` not after it, then the greatest version), so a value changed at a later date does not alter a snapshot taken
 * earlier. It never asks for a row of another hub: every statement names the hub.
 *
 * This file is one of the few places that may open the capability (`CAPABILITY_ACCESS.configuration.openedUnder`); the architecture
 * test enforces it.
 */

/** The technical identifier of the configuration reader as a `SYSTEM` principal: stable, and not the id of any business record. */
export const CONFIGURATION_PRINCIPAL_ID = '5eed0000-0000-4000-8000-0000000000c1';

export class ConfigurationReader {
  readonly #database: Pick<DatabaseService, 'transactionWithContext'>;

  constructor(database: Pick<DatabaseService, 'transactionWithContext'>) {
    this.#database = database;
  }

  /**
   * The configuration of one hub at an instant. **By default the database's own**: the database stamps when a version takes effect
   * (`effective_from` is its transaction time), so it is the one clock that can say what is in force, and an application whose clock runs
   * a little behind it never reads a value a moment too old. A caller that asks about another instant (a price as it stood on a date) states it.
   */
  async forHub(hubId: string, at?: Date): Promise<HubConfiguration> {
    const context: SecurityContext = {
      principalType: 'SYSTEM',
      principalId: CONFIGURATION_PRINCIPAL_ID,
      surface: 'SYSTEM',
      taskCapability: 'configuration',
      correlationId: 'configuration-read',
    };
    return this.#database.transactionWithContext(context, async (tx) => {
      const moment =
        at ??
        new Date(
          String((await tx.execute(sql`select transaction_timestamp() as now`)).rows[0]?.now),
        );
      const instant = moment.toISOString();
      const settings = await tx.execute(sql`
        select distinct on (setting_key, scope_ref)
               hub_id, setting_key, scope_ref, version, value, unit, effective_from
          from hub_setting
         where hub_id = ${hubId}::uuid and effective_from <= ${instant}::timestamptz
         order by setting_key, scope_ref, effective_from desc, version desc`);
      const zones = await tx.execute(sql`
        select id, hub_id, code, name, service_area, active
          from service_zone where hub_id = ${hubId}::uuid order by code`);
      const aliases = await tx.execute(sql`
        select id, hub_id, zone_id, alias, kind
          from service_zone_alias where hub_id = ${hubId}::uuid order by alias`);
      const company = await tx.execute(sql`
        select key, value_type, value, unit from setting where scope = 'COMPANY' order by key`);
      const hub = await tx.execute(sql`select name from hub where id = ${hubId}::uuid`);
      const hubName = hub.rows[0]?.name;

      return new HubConfiguration({
        hubId,
        ...(typeof hubName === 'string' ? { hubName } : {}),
        at: moment,
        settings: settings.rows.map((row): HubSettingRecord => ({
          hubId: String(row.hub_id),
          key: String(row.setting_key),
          scopeRef: String(row.scope_ref),
          version: Number(row.version),
          value: row.value,
          unit: String(row.unit),
          effectiveFrom: new Date(row.effective_from as string | Date),
        })),
        zones: zones.rows.map((row): ServiceZoneRecord => ({
          id: String(row.id),
          hubId: String(row.hub_id),
          code: String(row.code),
          name: String(row.name),
          serviceArea: String(row.service_area),
          active: row.active === true,
        })),
        aliases: aliases.rows.map((row): ZoneAliasRecord => ({
          id: String(row.id),
          hubId: String(row.hub_id),
          zoneId: String(row.zone_id),
          alias: String(row.alias),
          kind: row.kind === 'LANDMARK' ? 'LANDMARK' : 'AREA',
        })),
        company: company.rows.map((row): CompanyRuleRecord => ({
          key: String(row.key),
          valueType: String(row.value_type),
          value: row.value,
          unit: String(row.unit),
        })),
      });
    });
  }
}
