import { sql } from 'drizzle-orm';

import { serverErrorIn } from '../../platform/database/database-failures.js';
import type { DatabaseService } from '../../platform/database/database.service.js';
import type { SecurityContext } from '../../platform/database/transaction-context.js';
import type { IdentityState, LapsedGrant } from './bootstrap-plan.js';
import {
  BOOTSTRAP_PRINCIPAL_ID,
  BootstrapRefusedError,
  isRefusalReason,
  type BundlePurpose,
  type Custodian,
} from './bootstrap-vocabulary.js';

/**
 * The database side of the bootstrap seed and the resume command (S0.30): the four functions of migration 0019, each called by its
 * name and by no other, in **one transaction** under the `bootstrap` capability, as the provisioning login. The command's own logic
 * (`bootstrap-command.ts`) is written against this port, so that the order of its steps is shown without a database; the adapter below
 * is shown against a real one (`test/database/alone/bootstrap-command.db.test.ts`).
 *
 * What the adapter does with a refusal: a rule the database states (SQLSTATE 55000 with a `reason=` detail) becomes the
 * `BootstrapRefusedError` of that rule; the missing Platform Admin bundle (the foreign key of the identity) becomes
 * `REFERENCE_DATA_MISSING`; any other database failure becomes one line with its SQLSTATE and constraint name, **never the server's
 * detail, which for a failed check carries the row**, and the row of a staff identity holds a work email and a name.
 */

export interface SeedOutcome {
  readonly staffIdentity: number;
  readonly setupGrant: number;
  readonly auditEvent: number;
}

export interface IdentityFacts {
  readonly state: IdentityState;
  readonly custodian: Custodian;
}

export interface ResumeOutcome {
  readonly path: 'REENROLMENT' | 'BUNDLE_LOST';
  readonly grantId: string;
  readonly purpose: BundlePurpose;
  readonly issuedAt: Date;
  /** `null` for a `BOOTSTRAP_SETUP`. */
  readonly expiresAt: Date | null;
  readonly revokedFactorIds: readonly string[];
  readonly supersededGrantId: string | null;
  readonly expiredGrantIds: readonly string[];
}

/** What a run may ask of the database, inside its one transaction. */
export interface BootstrapCalls {
  /** Locks the staff table against any other seed (until the transaction ends) and counts it. */
  status(): Promise<{ readonly staffIdentities: number }>;
  seed(document: string): Promise<SeedOutcome>;
  identityState(canonicalEmail: string): Promise<IdentityFacts>;
  resume(document: string): Promise<ResumeOutcome>;
}

export interface BootstrapDatabase {
  /** Runs `work` in one transaction that commits when it resolves and is rolled back when it rejects. */
  run<T>(correlationId: string, work: (calls: BootstrapCalls) => Promise<T>): Promise<T>;
}

/** What the database says, as plain data, before it is read into the shapes above. */
type Json = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const UNEXPECTED = 'the database answered a bootstrap function with something it does not return';

function objectOf(rows: readonly unknown[], column: string): Json {
  const row = rows[0];
  const value = isObject(row) ? row[column] : undefined;
  if (!isObject(value)) throw new Error(UNEXPECTED);
  return value;
}

const text = (value: unknown): string => {
  if (typeof value !== 'string') throw new Error(UNEXPECTED);
  return value;
};

const count = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error(UNEXPECTED);
  return value;
};

const ids = (value: unknown): readonly string[] => {
  if (!Array.isArray(value)) throw new Error(UNEXPECTED);
  return value.map(text);
};

/** The grants of the identity that were pending and past their expiry when its state was read, each by id and purpose. */
const lapsedGrants = (value: unknown): readonly LapsedGrant[] => {
  if (!Array.isArray(value)) throw new Error(UNEXPECTED);
  return value.map((item: unknown) => {
    if (!isObject(item)) throw new Error(UNEXPECTED);
    return { id: text(item.id), purpose: text(item.purpose) };
  });
};

const instant = (value: unknown): Date => {
  const date = new Date(text(value));
  if (Number.isNaN(date.getTime())) throw new Error(UNEXPECTED);
  return date;
};

/** The rule a refusal of the database states, or `undefined` when it is not one. */
function refusalOf(error: unknown): BootstrapRefusedError | undefined {
  const server = serverErrorIn(error);
  if (server === undefined) return undefined;
  if (server.code === '23503' && server.constraint === 'staff_identity_bundle_fkey') {
    return new BootstrapRefusedError('REFERENCE_DATA_MISSING');
  }
  if (server.code !== '55000') return undefined;
  const reason = /reason=([A-Z_]+)/.exec(server.detail ?? '')?.[1];
  if (!isRefusalReason(reason)) return undefined;
  const rows = /rows=(\d+)/.exec(server.detail ?? '')?.[1];
  return new BootstrapRefusedError(reason, rows === undefined ? undefined : Number(rows));
}

/** One line for any other failure of the database: its class and its constraint, and never the row, the value or the secret. */
function describedFailure(error: unknown): Error | undefined {
  const server = serverErrorIn(error);
  if (server === undefined) return undefined;
  const where = server.constraint === undefined ? '' : `, constraint ${server.constraint}`;
  return new Error(
    `the database refused the bootstrap (SQLSTATE ${server.code ?? 'unknown'}${where}); no row, value or secret is shown`,
  );
}

/** How far down a chain of causes the search for bound values goes. */
const MAX_CAUSE_DEPTH = 8;

/** drizzle-orm ends the message of a failed statement with its bound values ("Failed query: <sql>\nparams: <values>"). */
const BOUND_VALUES_MARK = '\nparams: ';

/**
 * One line for a failure the server did not state (a connection that dropped while a statement ran), when it or anything it was caused
 * by is a failed statement of the driver: its message ends in the statement's bound values, which here are the whole seed document
 * (both custodians' names and work emails and the hash of each secret) or the canonical work email of the resume, and the command line
 * prints a failure's message and the message of its cause. Only the kind of failure is kept: the code of the deepest cause, or its
 * name. A failure that holds no bound values is returned as it is, as useful as it was.
 */
function withoutBoundValues(error: unknown): Error | undefined {
  let carriesValues = false;
  let deepest: Error | undefined;
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (current.message.includes(BOUND_VALUES_MARK)) carriesValues = true;
    deepest = current;
    current = current.cause;
  }
  if (!carriesValues || deepest === undefined) return undefined;
  const code = (deepest as { code?: unknown }).code;
  const kind = typeof code === 'string' ? code : deepest.name;
  return new Error(
    `the database failed while the bootstrap ran (${kind}); no row, value or secret is shown`,
  );
}

const translated = async <T>(call: () => Promise<T>): Promise<T> => {
  try {
    return await call();
  } catch (error) {
    throw refusalOf(error) ?? describedFailure(error) ?? withoutBoundValues(error) ?? error;
  }
};

export class PostgresBootstrapDatabase implements BootstrapDatabase {
  readonly #database: Pick<DatabaseService, 'transactionWithContext'>;

  constructor(database: Pick<DatabaseService, 'transactionWithContext'>) {
    this.#database = database;
  }

  run<T>(correlationId: string, work: (calls: BootstrapCalls) => Promise<T>): Promise<T> {
    const context: SecurityContext = {
      principalType: 'SYSTEM',
      principalId: BOOTSTRAP_PRINCIPAL_ID,
      surface: 'SYSTEM',
      taskCapability: 'bootstrap',
      correlationId,
    };
    return this.#database.transactionWithContext(context, (tx) =>
      work({
        status: () =>
          translated(async () => {
            const result = await tx.execute(sql`select melarc.bootstrap_status() as status`);
            return { staffIdentities: count(objectOf(result.rows, 'status').staff_identity) };
          }),
        seed: (document) =>
          translated(async () => {
            const result = await tx.execute(
              sql`select melarc.seed_bootstrap_administrators(${document}::jsonb) as report`,
            );
            const report = objectOf(result.rows, 'report');
            return {
              staffIdentity: count(report.staff_identity),
              setupGrant: count(report.setup_grant),
              auditEvent: count(report.audit_event),
            };
          }),
        identityState: (canonicalEmail) =>
          translated(async () => {
            const result = await tx.execute(
              sql`select melarc.bootstrap_identity_state(${canonicalEmail}::text) as state`,
            );
            const state = objectOf(result.rows, 'state');
            const pending = ids(state.pending_factor_ids);
            return {
              state: {
                id: text(state.id),
                credentialEstablished: state.credential_established === true,
                pendingFactorIds: pending,
                liveBootstrapGrantId:
                  state.live_bootstrap_grant_id === null
                    ? null
                    : text(state.live_bootstrap_grant_id),
                lapsedGrants: lapsedGrants(state.lapsed_grants),
              },
              custodian: { fullName: text(state.full_name), workEmail: text(state.work_email) },
            };
          }),
        resume: (document) =>
          translated(async () => {
            const result = await tx.execute(
              sql`select melarc.resume_bootstrap_identity(${document}::jsonb) as report`,
            );
            const report = objectOf(result.rows, 'report');
            const path = report.path;
            const purpose = report.purpose;
            if (path !== 'REENROLMENT' && path !== 'BUNDLE_LOST') throw new Error(UNEXPECTED);
            if (purpose !== 'MFA_REENROLMENT' && purpose !== 'BOOTSTRAP_SETUP')
              throw new Error(UNEXPECTED);
            return {
              path,
              purpose,
              grantId: text(report.grant_id),
              issuedAt: instant(report.issued_at),
              expiresAt: report.expires_at === null ? null : instant(report.expires_at),
              revokedFactorIds: ids(report.revoked_factor_ids),
              supersededGrantId:
                report.superseded_grant_id === null ? null : text(report.superseded_grant_id),
              expiredGrantIds: ids(report.expired_grant_ids),
            };
          }),
      }),
    );
  }
}
