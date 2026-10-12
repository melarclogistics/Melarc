import { sql, type SQL } from 'drizzle-orm';

import { timestampOf } from '../../database/timestamps.js';
import { isUuid } from '../../database/transaction-context.js';
import { transactionOf } from '../../database/transaction-handle.js';
import { randomUUIDv7 } from '../crypto/uuid-v7.js';
import type { Clock } from '../ports/clock.port.js';
import {
  BUNDLE_SNAPSHOT_FORMAT,
  SESSION_PRINCIPAL_TYPES,
  SESSION_TERMINATION_REASONS,
  type BundleGrantSnapshot,
  type BundleSnapshot,
  type ClientRootSignal,
  type NewSession,
  type SessionPrincipalType,
  type SessionSelector,
  type SessionStore,
  type SessionTerminationReason,
  type StoredSession,
} from '../ports/session-store.port.js';
import type { TransactionHandle } from '../ports/unit-of-work.port.js';
import { SessionSnapshotUnreadableError } from './session-errors.js';
import { ACTIVITY_COALESCE_MS } from './session-parameters.js';

/** The columns a `StoredSession` is made from. The token hash is not among them: nothing that reads a session needs it again. */
const COLUMNS = sql.raw(
  `id, principal_type, principal_id, bundle_snapshot, bundle_id, bundle_revision, policy_revision, authorized_hub_ids,
   registered_device_id, client_root_signal, csrf_token_hash, issued_at, expires_at, last_activity_at, terminated_at,
   termination_reason`,
);

interface SessionColumns {
  readonly id: string;
  readonly principal_type: SessionPrincipalType;
  readonly principal_id: string;
  readonly bundle_snapshot: unknown;
  readonly bundle_id: string;
  readonly bundle_revision: number;
  readonly policy_revision: number | null;
  readonly authorized_hub_ids: readonly string[];
  readonly registered_device_id: string | null;
  readonly client_root_signal: ClientRootSignal | null;
  readonly csrf_token_hash: Buffer | null;
  /** A raw statement returns an instant as the server's text; `timestampOf` reads it. */
  readonly issued_at: Date | string;
  readonly expires_at: Date | string;
  readonly last_activity_at: Date | string;
  readonly terminated_at: Date | string | null;
  readonly termination_reason: SessionTerminationReason | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (values as readonly string[]).includes(value);

function grantOf(value: unknown): BundleGrantSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  const { permission, hubScope, ownershipScope, tier } = value;
  if (
    typeof permission !== 'string' ||
    !isOneOf(['none', 'own', 'all'], hubScope) ||
    !isOneOf(['own', 'assigned', 'any'], ownershipScope) ||
    !(tier === null || isOneOf(['A', 'S', 'P'], tier))
  ) {
    return undefined;
  }
  return { permission, hubScope, ownershipScope, tier };
}

/**
 * The snapshot as stored, or the refusal: a format this build does not know, and a body that does not have the shape of the format it
 * names, are both a session it cannot read, which is not trusted and is not guessed at.
 */
function snapshotOf(value: unknown): BundleSnapshot {
  if (!isRecord(value) || value.format !== BUNDLE_SNAPSHOT_FORMAT) {
    throw new SessionSnapshotUnreadableError(isRecord(value) ? value.format : undefined);
  }
  const { name, audience, privileged, grants } = value;
  const parsed = Array.isArray(grants) ? (grants as unknown[]).map(grantOf) : undefined;
  if (
    typeof name !== 'string' ||
    !isOneOf(SESSION_PRINCIPAL_TYPES, audience) ||
    typeof privileged !== 'boolean' ||
    parsed === undefined ||
    parsed.some((grant) => grant === undefined)
  ) {
    throw new SessionSnapshotUnreadableError(value.format);
  }
  return {
    format: BUNDLE_SNAPSHOT_FORMAT,
    name,
    audience,
    privileged,
    grants: parsed as BundleGrantSnapshot[],
  };
}

function sessionOf(row: SessionColumns): StoredSession {
  return {
    id: row.id,
    principalType: row.principal_type,
    principalId: row.principal_id,
    state: row.terminated_at === null ? 'ACTIVE' : 'TERMINATED',
    issuedAt: timestampOf(row.issued_at),
    expiresAt: timestampOf(row.expires_at),
    lastActivityAt: timestampOf(row.last_activity_at),
    terminatedAt: row.terminated_at === null ? null : timestampOf(row.terminated_at),
    terminationReason: row.termination_reason,
    authority: {
      bundleId: row.bundle_id,
      bundleRevision: row.bundle_revision,
      policyRevision: row.policy_revision,
      snapshot: snapshotOf(row.bundle_snapshot),
      authorizedHubIds: [...row.authorized_hub_ids],
    },
    registeredDeviceId: row.registered_device_id,
    clientRootSignal: row.client_root_signal,
    csrfTokenHash: row.csrf_token_hash === null ? null : new Uint8Array(row.csrf_token_hash),
  };
}

/** The `WHERE` of an ending, for a selector that is well formed; anything else is a programming error, refused before any statement. */
function selection(selector: SessionSelector): SQL {
  const given = selector as unknown as Record<string, unknown>;
  switch (given.by) {
    case 'session':
      if (!isUuid(given.sessionId)) throw new TypeError('A session is selected by its id (a UUID)');
      return sql`id = ${given.sessionId}`;
    case 'principal':
      if (!isOneOf(SESSION_PRINCIPAL_TYPES, given.principalType) || !isUuid(given.principalId)) {
        throw new TypeError(
          'A principal is selected by its type (staff, rider or vendor) and its id',
        );
      }
      return sql`principal_type = ${given.principalType} and principal_id = ${given.principalId}`;
    case 'bundle': {
      if (!isUuid(given.bundleId)) throw new TypeError('A bundle is selected by its id (a UUID)');
      const below = given.belowRevision;
      if (below === undefined) return sql`bundle_id = ${given.bundleId}`;
      if (typeof below !== 'number' || !Number.isInteger(below) || below < 1) {
        throw new TypeError(
          'The revision a bundle selection is bounded by is a whole number from 1',
        );
      }
      return sql`bundle_id = ${given.bundleId} and bundle_revision < ${below}`;
    }
    default:
      throw new TypeError('A selection of sessions is by session, by principal or by bundle');
  }
}

/**
 * The session store over PostgreSQL (S0.24; SECURITY_DESIGN.md §13; domain-model.md §6.8 `Session`). Every operation joins the
 * caller's transaction, under the context the caller opened it with (the authentication capability: row-level security admits
 * nothing else to write a session), so issuing a session, ending others and the audit event commit together.
 *
 * - **A session is found by the hash of its token and by nothing else**, in whatever state it is in. The store does not judge
 *   expiry: that is the caller's, on one fresh database time after the locks it needs. An ended session is returned with the
 *   reason it ended, which is how a displaced vendor is told so and how a refused request can say why in the audit.
 * - **Activity is coalesced and judged by the statement that writes it**: a write only when the recorded activity is at least
 *   `ACTIVITY_COALESCE_MS` old, never backwards, and only on a session that is live at the database's clock when the statement runs
 *   (not ended, before its absolute end, not idle), so a wait on a revocation's lock cannot revive a session. One conditional
 *   `UPDATE`, so a burst of requests writes once.
 * - **Ending is one statement that takes the row locks in id order** (`ORDER BY id FOR UPDATE` under the `UPDATE`), so two endings
 *   that overlap cannot wait for each other in a cycle (SECURITY_DESIGN.md §13.10a, lock order: session rows by id ascending). A
 *   session that has already ended is not touched, so it keeps its first reason. The end is recorded at the database's time, **never
 *   earlier than the session's own issue**: the table refuses an end before the issue, and a clock that stepped back past an issue
 *   would otherwise fail the revocation and roll back the transaction that asked for it (a suspension, a credential change).
 * - **The snapshot is read strictly.** A format this build does not know, or a body that does not have the shape of its format, is
 *   `SessionSnapshotUnreadableError`: the session is not trusted and not guessed at.
 */
export class PostgresSessionStore implements SessionStore {
  readonly #clock: Pick<Clock, 'now'>;

  constructor(clock: Pick<Clock, 'now'>) {
    this.#clock = clock;
  }

  async create(transaction: TransactionHandle, session: NewSession): Promise<StoredSession> {
    const { authority } = session;
    if (!authority.authorizedHubIds.every((hub) => isUuid(hub))) {
      throw new TypeError('The hubs of a session are ids (UUIDs)');
    }
    const result = await transactionOf(transaction).execute(sql`
      insert into session (id, principal_type, principal_id, bundle_snapshot, bundle_id, bundle_revision, policy_revision,
                           authorized_hub_ids, registered_device_id, client_root_signal, token_hash, csrf_token_hash,
                           issued_at, expires_at, last_activity_at)
      values (${randomUUIDv7(this.#clock)}, ${session.principalType}, ${session.principalId},
              ${JSON.stringify(authority.snapshot)}::jsonb, ${authority.bundleId}, ${authority.bundleRevision},
              ${authority.policyRevision}, ${`{${authority.authorizedHubIds.join(',')}}`}::uuid[],
              ${session.registeredDeviceId ?? null}, ${session.clientRootSignal ?? null},
              ${Buffer.from(session.tokenHash)},
              ${session.csrfTokenHash === undefined ? null : Buffer.from(session.csrfTokenHash)},
              ${session.issuedAt}, ${session.expiresAt}, ${session.issuedAt})
      returning ${COLUMNS}`);
    return sessionOf(result.rows[0] as unknown as SessionColumns);
  }

  async findByTokenHash(
    transaction: TransactionHandle,
    tokenHash: Uint8Array,
  ): Promise<StoredSession | null> {
    const result = await transactionOf(transaction).execute(sql`
      select ${COLUMNS} from session where token_hash = ${Buffer.from(tokenHash)}`);
    const row = result.rows[0] as unknown as SessionColumns | undefined;
    return row === undefined ? null : sessionOf(row);
  }

  async recordActivity(
    transaction: TransactionHandle,
    sessionId: string,
    idleMinutes: number | null,
  ): Promise<boolean> {
    if (!isUuid(sessionId)) throw new TypeError('A session is identified by its id (a UUID)');
    if (idleMinutes !== null && (!Number.isInteger(idleMinutes) || idleMinutes < 1)) {
      throw new RangeError('An idle limit is a positive whole number of minutes, or none');
    }
    // The lock first, the judgement after it. A single UPDATE that waited for the row would have judged on the clock it read before
    // the wait: PostgreSQL re-checks a waiting UPDATE's qualification only against a row that the other transaction *changed*, and a
    // transaction that merely locked the row (`SELECT ... FOR UPDATE`) leaves the statement to go on with the tuple and the time it
    // had. So the lock is taken in a statement of its own, which waits for every holder; under READ COMMITTED it is a lock on the
    // latest version of the row (a revocation that ended the session while this waited is seen), and the statement that judges and
    // writes runs afterwards, on the clock as it is then (a session that went idle, or reached its absolute end, while this waited
    // is not written). One row, and no other lock, so it adds nothing to the lock order of section 13.10a.
    const database = transactionOf(transaction);
    const locked = await database.execute(
      sql`select 1 from session where id = ${sessionId} for no key update`,
    );
    if (locked.rows.length === 0) return false;
    const result = await database.execute(sql`
      update session
         set last_activity_at = greatest(last_activity_at, clock_timestamp())
       where id = ${sessionId}
         and terminated_at is null
         and expires_at > clock_timestamp()
         and (${idleMinutes}::int is null
              or last_activity_at + make_interval(mins => ${idleMinutes}::int) > clock_timestamp())
         and last_activity_at <= clock_timestamp() - make_interval(secs => ${ACTIVITY_COALESCE_MS / 1000}::double precision)
      returning 1`);
    return result.rows.length === 1;
  }

  async terminate(
    transaction: TransactionHandle,
    selector: SessionSelector,
    reason: SessionTerminationReason,
  ): Promise<readonly string[]> {
    if (!isOneOf(SESSION_TERMINATION_REASONS, reason)) {
      throw new TypeError('A session is ended with one of the reasons of the contract');
    }
    const where = selection(selector);
    const result = await transactionOf(transaction).execute(sql`
      with locked as (
        select id from session where ${where} and terminated_at is null order by id for update
      )
      update session as s set terminated_at = greatest(clock_timestamp(), s.issued_at), termination_reason = ${reason}
        from locked where s.id = locked.id
      returning s.id`);
    return (result.rows as { id: string }[]).map((row) => row.id).toSorted();
  }
}
