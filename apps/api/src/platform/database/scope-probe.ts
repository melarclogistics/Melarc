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
 */

/** Where a hub-scoped entity lives. `responsible_hub_id` is the registry's name for the column that carries its hub. */
export interface HubScopedEntity {
  readonly schema: string;
  readonly table: string;
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

const IDENTIFIER = /^[a-z][a-z0-9_]*$/;

/** The probe over a registry of entities. The application uses `existingRecordHub`, which is built over the real one. */
export function createScopeProbe(
  entities: Readonly<Record<string, HubScopedEntity>>,
): ExistingRecordHub {
  for (const entity of Object.values(entities)) {
    if (!IDENTIFIER.test(entity.schema) || !IDENTIFIER.test(entity.table)) {
      throw new Error('A hub-scoped entity names its schema and table by a plain identifier');
    }
  }

  return async (tx, entity, id) => {
    if (!isUuid(id)) throw new SecurityContextError(['scopeProbeId']);
    const target = Object.hasOwn(entities, entity) ? entities[entity] : undefined;
    if (target === undefined) throw new Error('That entity is not a hub-scoped entity');
    const recordId = id.toLowerCase();

    // Everything the probe sends goes through the handle of its hold, which works until the probe ends and which no other
    // statement of the transaction can interleave with.
    return runExclusively(tx, async (held) => {
      const set = await held.execute(
        sql`select set_config('melarc.scope_probe_id', case when melarc.principal_type() = 'STAFF' then ${recordId}::text else '' end, true) as probe`,
      );
      if (set.rows[0]?.probe !== recordId) return undefined;

      let found;
      try {
        found = await held.execute(
          sql`select id, responsible_hub_id from ${sql.identifier(target.schema)}.${sql.identifier(target.table)} where id = ${recordId}::uuid`,
        );
      } catch (error) {
        // An aborted transaction cannot run the clear, and the setting ends with it; the failure to report is the read's.
        await clear(held).catch(() => undefined);
        throw error;
      }
      await clear(held);

      const hub = found.rows[0]?.responsible_hub_id;
      return typeof hub === 'string' ? hub : undefined;
    });
  };
}

function clear(held: DatabaseTransaction) {
  return held.execute(sql`select set_config('melarc.scope_probe_id', '', true) as probe`);
}

export const existingRecordHub: ExistingRecordHub = createScopeProbe(HUB_SCOPED_ENTITIES);
