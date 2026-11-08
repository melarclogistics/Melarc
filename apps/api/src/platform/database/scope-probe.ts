import { sql } from 'drizzle-orm';

import type { DatabaseTransaction } from './database.service.js';
import { isUuid, SecurityContextError } from './transaction-context.js';
import { runExclusively } from './transaction-gate.js';

/**
 * The scope probe (SECURITY_DESIGN.md §14.4b). Row-level security hides a record outside a staff principal's hubs
 * exactly as it hides one that does not exist, and the Product decision is that authenticated staff are told the
 * difference. One narrow step does it: after a read by id found nothing in scope, `existingRecordHub` asks which hub
 * the record with that id belongs to.
 *
 * It is the only code that writes `melarc.scope_probe_id`, and it writes it for one statement. A hub-scoped table has, beside
 * its ordinary policy, a second policy FOR SELECT that admits `id = melarc.scope_probe_id()` for a staff context and nothing
 * else (a probe predicate in a policy for UPDATE, DELETE, INSERT or ALL is refused by the migration lint and the catalogue
 * check): PostgreSQL ORs the permissive policies that apply to a command, so while the setting holds an id one record is
 * readable and no command can change it. With no probe the accessor is NULL and the policy admits nothing.
 *
 * - Only a staff principal probes. The setting is made in SQL, from the context the transaction holds, so a vendor, a
 *   rider or a SYSTEM context is answered "nothing found" at once, which is what a record that does not exist gets.
 * - It names one id and reads two columns. The probed row is never loaded, returned or logged.
 * - It holds the transaction while it runs (`runExclusively`): the record is readable to the probe's own statement only,
 *   so no other statement of the transaction may run between the set and the clear, and a second probe may not start. A
 *   caller that overlaps them is refused, not served.
 * - A list never probes: the caller of a list does not call this.
 *
 * A record that belongs to **several** hubs (a session is issued for the hubs of its principal) cannot be compared by one hub, so its
 * entity is probed for its hub **set** (`createHubSetProbe`): the same hold, the same single id, the same `SELECT`-only policy, and the
 * one column read is the array of hubs (F06 of 23 October 2026). What the answer is used for is stated where it is used (`record-scope.ts`).
 */

/**
 * Where a hub-scoped entity lives. `responsible_hub_id` is the registry's name for the column that carries its hub, and the probe
 * reads that column unless the entity names another: a staff identity belongs to the hub of its `primary_hub_id` (S0.35), and the
 * table is not given a second column to say it twice.
 */
export interface HubScopedEntity {
  readonly schema: string;
  readonly table: string;
  /** The column that carries the record's hub, when it is not `responsible_hub_id`. A plain identifier, quoted when used. */
  readonly hubColumn?: string;
  /**
   * The record whose hub this one has, when the hub is not on the record itself: a vendor account belongs to the responsible hub of its
   * organisation (S0.47), and the account is not given a copy of it that could drift. The probe joins `table` (in the same schema) on its
   * `id` = this record's `key`, and reads that table's `hubColumn`. An entity names either this or its own `hubColumn`, never both.
   */
  readonly hubVia?: { readonly table: string; readonly key: string; readonly hubColumn: string };
}

/**
 * The entities that may be probed, by name. Empty until a slice adds a hub-scoped table, which adds its row in the same
 * change; a name that is not here is refused before any statement is sent.
 */
export const HUB_SCOPED_ENTITIES: Readonly<Record<string, HubScopedEntity>> = {};

export type ExistingRecordHub = (
  tx: DatabaseTransaction,
  entity: string,
  id: string,
) => Promise<string | undefined>;

/** Where a record that belongs to several hubs keeps them: a `uuid[]` column, read by the hub-set probe and by nothing else here. */
export interface HubSetEntity {
  readonly schema: string;
  readonly table: string;
  /** The array column that carries the record's hubs. A plain identifier, quoted when used. */
  readonly hubsColumn: string;
}

/** The hubs of the record with that id, or nothing when the probe is not admitted or finds no such record. An empty list is a record with no hub. */
export type ExistingRecordHubs = (
  tx: DatabaseTransaction,
  entity: string,
  id: string,
) => Promise<readonly string[] | undefined>;

const IDENTIFIER = /^[a-z][a-z0-9_]*$/;

/** The probe over a registry of entities. The application uses `existingRecordHub`, which is built over the real one. */
export function createScopeProbe(
  entities: Readonly<Record<string, HubScopedEntity>>,
): ExistingRecordHub {
  for (const entity of Object.values(entities)) {
    const via = entity.hubVia;
    if (
      !IDENTIFIER.test(entity.schema) ||
      !IDENTIFIER.test(entity.table) ||
      (entity.hubColumn !== undefined && !IDENTIFIER.test(entity.hubColumn)) ||
      (via !== undefined &&
        (entity.hubColumn !== undefined ||
          !IDENTIFIER.test(via.table) ||
          !IDENTIFIER.test(via.key) ||
          !IDENTIFIER.test(via.hubColumn)))
    ) {
      throw new Error(
        'A hub-scoped entity names its schema, its table and its hub column by a plain identifier',
      );
    }
  }

  return async (tx, entity, id) => {
    if (!isUuid(id)) throw new SecurityContextError(['scopeProbeId']);
    const target = Object.hasOwn(entities, entity) ? entities[entity] : undefined;
    if (target === undefined) throw new Error('That entity is not a hub-scoped entity');
    const recordId = id.toLowerCase();

    return probing(tx, recordId, async (held) => {
      const schema = sql.identifier(target.schema);
      const table = sql.identifier(target.table);
      const via = target.hubVia;
      // The statement keeps its own text for an entity that names no column; one that does names it and answers it as the hub; one whose
      // hub is on another record reads it there, through the key this record holds.
      const statement =
        via === undefined
          ? sql`select id, ${
              target.hubColumn === undefined
                ? sql`responsible_hub_id`
                : sql`${sql.identifier(target.hubColumn)} as responsible_hub_id`
            } from ${schema}.${table} where id = ${recordId}::uuid`
          : sql`select r.id, h.${sql.identifier(via.hubColumn)} as responsible_hub_id
                  from ${schema}.${table} as r
                  join ${schema}.${sql.identifier(via.table)} as h on h.id = r.${sql.identifier(via.key)}
                 where r.id = ${recordId}::uuid`;
      const found = await held.execute(statement);
      const hub = found.rows[0]?.responsible_hub_id;
      return typeof hub === 'string' ? hub : undefined;
    });
  };
}

/** The probe over a registry of entities that keep several hubs in an array column. */
export function createHubSetProbe(
  entities: Readonly<Record<string, HubSetEntity>>,
): ExistingRecordHubs {
  for (const entity of Object.values(entities)) {
    if (
      !IDENTIFIER.test(entity.schema) ||
      !IDENTIFIER.test(entity.table) ||
      !IDENTIFIER.test(entity.hubsColumn)
    ) {
      throw new Error(
        'A hub-set entity names its schema, its table and its hubs column by a plain identifier',
      );
    }
  }

  return async (tx, entity, id) => {
    if (!isUuid(id)) throw new SecurityContextError(['scopeProbeId']);
    const target = Object.hasOwn(entities, entity) ? entities[entity] : undefined;
    if (target === undefined) throw new Error('That entity is not a hub-set entity');
    const recordId = id.toLowerCase();

    return probing(tx, recordId, async (held) => {
      const found = await held.execute(
        sql`select id, ${sql.identifier(target.hubsColumn)} as hubs from ${sql.identifier(target.schema)}.${sql.identifier(target.table)} where id = ${recordId}::uuid`,
      );
      const row = found.rows[0];
      if (row === undefined) return undefined;
      const hubs: unknown = row.hubs;
      return Array.isArray(hubs)
        ? hubs.filter((hub): hub is string => typeof hub === 'string')
        : [];
    });
  };
}

/**
 * The hold both probes share. Everything the probe sends goes through the handle of its hold, which works until the probe ends and which
 * no other statement of the transaction can interleave with. The setting is made for a staff context only, and cleared before the hold ends.
 */
async function probing<T>(
  tx: DatabaseTransaction,
  recordId: string,
  read: (held: DatabaseTransaction) => Promise<T | undefined>,
): Promise<T | undefined> {
  return runExclusively(tx, async (held) => {
    const set = await held.execute(
      sql`select set_config('melarc.scope_probe_id', case when melarc.principal_type() = 'STAFF' then ${recordId}::text else '' end, true) as probe`,
    );
    if (set.rows[0]?.probe !== recordId) return undefined;

    let answer: T | undefined;
    try {
      answer = await read(held);
    } catch (error) {
      // An aborted transaction cannot run the clear, and the setting ends with it; the failure to report is the read's.
      await clear(held).catch(() => undefined);
      throw error;
    }
    await clear(held);
    return answer;
  });
}

function clear(held: DatabaseTransaction) {
  return held.execute(sql`select set_config('melarc.scope_probe_id', '', true) as probe`);
}

export const existingRecordHub: ExistingRecordHub = createScopeProbe(HUB_SCOPED_ENTITIES);
