import { sql } from 'drizzle-orm';

import type { UnitOfWork } from '../auth/ports/unit-of-work.port.js';
import { createScopeProbe, type ExistingRecordHub } from '../database/scope-probe.js';
import { isUuid, type SecurityContext } from '../database/transaction-context.js';
import { transactionOf } from '../database/transaction-handle.js';
import { ApiException } from '../http/api-exception.js';
import { ErrorCode } from '../http/error-codes.js';
import type { RecordScope } from '../routes/access-declaration.js';
import { requireTargetTier, type Tier, type TierRule, type TierRules } from './tier-policy.js';

/**
 * A table whose records an operation can name by id (S0.26), and whether its records belong to a hub. A hub-scoped table has the
 * probe policy beside its ordinary one (SECURITY_DESIGN.md section 14.4b), which is what lets a staff member's miss be told apart
 * from a record that does not exist.
 */
export interface RecordEntity {
  readonly schema: string;
  readonly table: string;
  /** True where the table has the probe policy and a `responsible_hub_id`. */
  readonly hubScoped: boolean;
}

export type RecordEntities = Readonly<Record<string, RecordEntity>>;

/**
 * The entities the application's routes may name. **Empty until a slice adds a table that an operation addresses by id**: the slice
 * adds its row here in the same change, as it adds a row to `HUB_SCOPED_ENTITIES` when the table is hub-scoped. A route that names an
 * entity that is not here stops the application at start (`assertRoutesAreSound`).
 */
export const RECORD_ENTITIES: RecordEntities = Object.freeze({});

export const RECORD_ENTITIES_TOKEN = Symbol('RECORD_ENTITIES');

const IDENTIFIER = /^[a-z][a-z0-9_]*$/;

/**
 * Whether a hub is one the operation reaches: every hub for the all-hub mode, otherwise the set it runs under, compared as lower-case
 * ids. The context is the operation's own (the grant's scope intersected with the session's reach), not the session's alone.
 */
function hubIsInScope(hub: string, context: SecurityContext): boolean {
  if (context.hubScopeMode === 'ALL') return true;
  const wanted = hub.toLowerCase();
  return (context.authorizedHubIds ?? []).some((each) => each.toLowerCase() === wanted);
}

/** The entities as the probe wants them: only the hub-scoped ones. */
function hubScopedOf(entities: RecordEntities): Record<string, { schema: string; table: string }> {
  return Object.fromEntries(
    Object.entries(entities)
      .filter(([, entity]) => entity.hubScoped)
      .map(([name, entity]) => [name, { schema: entity.schema, table: entity.table }]),
  );
}

/** The tier a record may need, asked of a rule once the record is found visible: the rule and the tier of the grant that acts. */
export interface TierCheck {
  readonly rule: string;
  readonly grantTier: Tier | null;
}

export interface RecordScopeResolverOptions {
  readonly unitOfWork: Pick<UnitOfWork, 'run'>;
  readonly entities: RecordEntities;
  /** The rules a route may name (`TIER_RULES`); a test composes its own. */
  readonly tierRules?: TierRules;
  /** Defaults to a probe over the hub-scoped entities of `entities`. A test supplies a spy to show what it was asked. */
  readonly probe?: ExistingRecordHub;
}

/**
 * Step 7 of the refusal order for a route that names a record (permission-enforcement.md section 5.1; SECURITY_DESIGN.md
 * sections 4 and 14.4b; `AC-SLICE-000-30`, `-130`): **before the body is validated**, find out whether the caller can see the
 * record the path names.
 *
 * - A record the caller **can see** is a pass. The use case reads it again for itself, in its own transaction; this is a question
 *   about the answer to give, not a handover of the row, and the row is never loaded, returned or logged here.
 * - A record the caller **can see** and whose route declares a tier rule is asked of that rule (step 6, for a requirement that depends
 *   on the target): `403 INSUFFICIENT_AUTHORITY` when the grant's tier does not meet it. A record the caller cannot see is never asked.
 * - A record the caller cannot see is `404 NOT_FOUND`, and for a **staff** caller on a **hub-scoped** entity the answer is
 *   decided by the scope probe: a record that exists in a hub **outside the scope the operation runs under** is
 *   `403 HUB_SCOPE_VIOLATION` (informative by Product decision, on the hub axis only); one that exists in a hub the operation reaches
 *   and is hidden for another reason, and one that does not exist, are `NOT_FOUND`. The probe is `SELECT`-only, reads two columns of
 *   one id, holds the transaction while it runs and runs only for a staff principal.
 * - **A Vendor and a Rider are answered `NOT_FOUND` at once**, by the same code path as a record that does not exist: no probe, no
 *   second query, so the two answers cannot differ in status, code, body shape or timing class.
 * - An id that is not a UUID names no record and is not looked up: the request validation of the next step answers it.
 *
 * It runs in a short read-only transaction under the operation's own context (the principal, the surface, the authorizing key and
 * the hub scope of the grant), so row-level security decides what is visible, and never under a wider one.
 */
export class RecordScopeResolver {
  readonly #unitOfWork: Pick<UnitOfWork, 'run'>;
  readonly #entities: RecordEntities;
  readonly #tierRules: TierRules;
  readonly #probe: ExistingRecordHub;

  constructor(options: RecordScopeResolverOptions) {
    for (const [name, entity] of Object.entries(options.entities)) {
      if (
        !IDENTIFIER.test(name) ||
        !IDENTIFIER.test(entity.schema) ||
        !IDENTIFIER.test(entity.table)
      ) {
        throw new TypeError(
          'A record entity names itself, its schema and its table by plain identifiers',
        );
      }
    }
    this.#unitOfWork = options.unitOfWork;
    this.#entities = options.entities;
    this.#tierRules = options.tierRules ?? {};
    this.#probe = options.probe ?? createScopeProbe(hubScopedOf(options.entities));
  }

  has(entity: string): boolean {
    return Object.hasOwn(this.#entities, entity);
  }

  #ruleNamed(name: string): TierRule {
    const rule = Object.hasOwn(this.#tierRules, name) ? this.#tierRules[name] : undefined;
    if (rule === undefined) throw new Error('That tier rule is not one of the application’s');
    return rule;
  }

  async require(
    scope: RecordScope,
    id: string,
    context: SecurityContext,
    tier?: TierCheck,
  ): Promise<void> {
    if (!isUuid(id)) return;
    const entity = Object.hasOwn(this.#entities, scope.entity)
      ? this.#entities[scope.entity]
      : undefined;
    if (entity === undefined)
      throw new Error('That entity is not a record entity of this application');

    await this.#unitOfWork.run(context, async (handle) => {
      const transaction = transactionOf(handle);
      const visible = await transaction.execute(
        sql`select 1 from ${sql.identifier(entity.schema)}.${sql.identifier(entity.table)} where id = ${id.toLowerCase()}::uuid`,
      );
      if (visible.rows.length > 0) {
        // Step 6 for a requirement that depends on the target: the caller can see the record, so what it needs may be told. A caller
        // who cannot see it never reaches this, and is answered by the existence rule below.
        if (tier !== undefined) {
          await requireTargetTier(this.#ruleNamed(tier.rule), tier.grantTier, handle, id);
        }
        return;
      }
      if (context.principalType === 'STAFF' && entity.hubScoped) {
        const hub = await this.#probe(transaction, scope.entity, id);
        // The answer is informative on the hub axis only. A record that exists and is hidden for another reason (its owner, a state
        // the policy reads) while its hub is one the operation reaches is not "outside your hubs", and an all-hub caller has no hub
        // outside their scope: both are answered as a record that is not there.
        if (hub !== undefined && !hubIsInScope(hub, context)) {
          throw ApiException.of(ErrorCode.HubScopeViolation, 'The record is outside your hubs');
        }
      }
      throw ApiException.of(ErrorCode.NotFound, 'Resource not found');
    });
  }
}
