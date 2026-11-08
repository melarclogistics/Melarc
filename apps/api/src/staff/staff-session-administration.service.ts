import { sql } from 'drizzle-orm';

import type { AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import type { SessionStore } from '../platform/auth/ports/session-store.port.js';
import type { TransactionHandle } from '../platform/auth/ports/unit-of-work.port.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import type { OperationContexts } from '../platform/authorization/operation-contexts.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import type { RecordScopeResolver } from '../platform/authorization/record-scope.js';
import { requireTier, tierForSessionPrincipal } from '../platform/authorization/tier-policy.js';
import { timestampOf } from '../platform/database/timestamps.js';
import { transactionOf } from '../platform/database/transaction-handle.js';
import { ApiException } from '../platform/http/api-exception.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { judgeSession } from '../platform/auth/sessions/session-judgement.js';
import { SESSION_IDLE_SETTING, tierOf } from '../platform/auth/sessions/session-parameters.js';
import { ReasonRefusedError, type ReasonValidator } from '../platform/settings/reason-validator.js';
import { checkedNote } from './staff-note.js';
import { SettingInvalidError, type SettingsReader } from '../platform/settings/settings-reader.js';

/** `Session`, the ordinary projection of another principal's session (openapi.yaml): no credential, no hash, no bundle, no permissions. */
export interface SessionView {
  readonly id: string;
  readonly principal_type: 'STAFF' | 'RIDER' | 'VENDOR';
  readonly principal_id: string;
  readonly state: 'ACTIVE' | 'TERMINATED';
  readonly authorized_hub_ids: readonly string[];
  readonly registered_device_id: string | null;
  readonly issued_at: string;
  readonly expires_at: string;
  readonly last_activity_at: string;
  readonly termination_reason: string | null;
}

export interface SessionListQuery {
  readonly principal_type: 'STAFF' | 'RIDER' | 'VENDOR';
  readonly principal_id: string;
}

export interface StaffSessionAdministrationOptions {
  readonly runner: Pick<OperationRunner, 'read' | 'mutate'>;
  readonly contexts: Pick<OperationContexts, 'of'>;
  readonly scope: Pick<RecordScopeResolver, 'require'>;
  readonly sessions: Pick<SessionStore, 'terminate'>;
  readonly audit: AuditWriter;
  readonly reasons: Pick<ReasonValidator, 'validate'>;
  /** The idle limit of each tier (`session_idle_timeout_minutes`), which the list judges a browser session by as the authenticator does. */
  readonly settings: Pick<SettingsReader, 'object'>;
}

interface SessionRow {
  readonly id: string;
  readonly principal_type: 'STAFF' | 'RIDER' | 'VENDOR';
  readonly principal_id: string;
  readonly authorized_hub_ids: readonly string[];
  readonly registered_device_id: string | null;
  readonly issued_at: Date | string;
  readonly expires_at: Date | string;
  readonly last_activity_at: Date | string;
  readonly terminated_at: Date | string | null;
  readonly termination_reason: string | null;
}

const COLUMNS = sql.raw(
  `id, principal_type, principal_id, authorized_hub_ids, registered_device_id, issued_at, expires_at, last_activity_at, terminated_at,
   termination_reason`,
);

function viewOf(row: SessionRow): SessionView {
  return {
    id: row.id,
    principal_type: row.principal_type,
    principal_id: row.principal_id,
    state: row.terminated_at === null ? 'ACTIVE' : 'TERMINATED',
    authorized_hub_ids: [...row.authorized_hub_ids],
    registered_device_id: row.registered_device_id,
    issued_at: timestampOf(row.issued_at).toISOString(),
    expires_at: timestampOf(row.expires_at).toISOString(),
    last_activity_at: timestampOf(row.last_activity_at).toISOString(),
    termination_reason: row.termination_reason,
  };
}

/**
 * `listSessions` and `revokeSession` (S0.37; `staff.read` and `staff.session.revoke`; `AC-SLICE-000-29`, `-114`; migration 0030).
 *
 * - **The list** is a read of another principal's `ACTIVE` sessions, newest first, so that the revocation screen has something to show. It
 *   asks the tier of the principal's type **first**, before anything is looked up (a caller who holds the key and not the tier is
 *   `INSUFFICIENT_AUTHORITY`), then whether the principal exists and is in the caller's scope: a staff member is judged by the staff
 *   identity under the scope probe (`HUB_SCOPE_VIOLATION` or `NOT_FOUND`); a vendor or a rider has no directory yet (S0.47, S0.59), so it
 *   exists when a session of it is recorded and in scope when the session's hubs are (a rider of another hub reads as absent until its
 *   directory gives the probe a hub to compare). It returns the id, the type, the hubs, the device, the moments and nothing that could
 *   present or rebuild a session.
 * - **The revocation** names a session in the path. The guard has found it visible to the caller and asked the tier of the principal's
 *   type of it (`session_principal`); a session's principal type never changes, so that answer stands and the transaction does not ask
 *   it again (the caller's own session is judged again under the shared policy locks, as for every mutation). It takes **no policy lock for the target's
 *   sessions and no identity lock**: ending a session is the very change a reduction makes, so the two commute on the session row (SECURITY_DESIGN.md
 *   section 13.10a). It ends the one session with `ADMIN_REVOKED` and writes the enhanced event; a session that has ended since (by
 *   itself, by an expiry) is returned as it ended and writes nothing, because the contract's refusals for this operation have no state
 *   conflict. The next request on the revoked session is `SESSION_INVALID`: the row is the state, with no cache between the decision and
 *   its effect.
 */
export class StaffSessionAdministration {
  readonly #options: StaffSessionAdministrationOptions;

  constructor(options: StaffSessionAdministrationOptions) {
    this.#options = options;
  }

  async list(
    authorized: AuthorizedRequest,
    correlationId: string,
    query: SessionListQuery,
  ): Promise<{ readonly items: readonly SessionView[] }> {
    const { runner, contexts, scope, settings } = this.#options;
    requireTier(authorized.grant?.tier ?? null, tierForSessionPrincipal(query.principal_type));
    if (query.principal_type === 'STAFF') {
      const context = await contexts.of(authorized, correlationId);
      await scope.require(
        { entity: 'staff_identity', param: 'principal_id' },
        query.principal_id,
        context,
      );
    }
    return runner.read(authorized, correlationId, async (handle) => {
      const tx = transactionOf(handle);
      if (query.principal_type !== 'STAFF') {
        const known = await tx.execute(
          sql`select 1 from session where principal_type = ${query.principal_type} and principal_id = ${query.principal_id}::uuid limit 1`,
        );
        if (known.rows.length === 0)
          throw ApiException.of(ErrorCode.NotFound, 'Resource not found');
      }
      const limits = await settings.object(handle, SESSION_IDLE_SETTING);
      const found = await tx.execute(sql`
        select ${COLUMNS}, privileged, clock_timestamp() as judged_at from session
         where principal_type = ${query.principal_type} and principal_id = ${query.principal_id}::uuid and terminated_at is null
         order by issued_at desc, id desc`);
      // A session is live when the authenticator would let a request through it (session-judgement.ts): not past its absolute bound and, for
      // a browser session, not past the idle limit of its tier, on one reading of the database's clock. One that is past either has not yet
      // been ended (the request that finds it out of time ends it), and is not offered to an administrator as something to revoke.
      const live = (row: SessionRow & { privileged: boolean | null; judged_at: Date | string }) => {
        // A snapshot that does not say whether its bundle is privileged is judged by the stricter tier: a missing fact of authority is never
        // read as the weaker one (the authenticator refuses such a snapshot outright).
        const tier = tierOf(row.principal_type, { privileged: row.privileged !== false });
        const minutes = limits[tier];
        if (
          tier !== 'rider' &&
          (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1)
        ) {
          throw new SettingInvalidError(
            SESSION_IDLE_SETTING,
            `the ${tier} tier is not a positive whole number of minutes`,
          );
        }
        const verdict = judgeSession(
          {
            state: 'ACTIVE',
            terminationReason: null,
            expiresAt: timestampOf(row.expires_at),
            lastActivityAt: timestampOf(row.last_activity_at),
            principalType: row.principal_type,
          },
          timestampOf(row.judged_at),
          tier === 'rider' ? null : (minutes as number),
        );
        return verdict.kind === 'ACTIVE';
      };
      const rows = found.rows as unknown as (SessionRow & {
        privileged: boolean | null;
        judged_at: Date | string;
      })[];
      const items = rows.filter(live).map(viewOf);
      await this.#auditCrossings(handle, authorized, items);
      return { items };
    });
  }

  /**
   * `auth.hub_boundary.crossed` for the hubs the answer represents that are not the actor's own (audit.md sections 5.4 and 6; F02 of
   * 23 October 2026), by the rule the S0.35 reads follow:
   *
   * - **The baseline is the actor's primary hub**; an actor with none has none of their own, so every hub they read is foreign.
   * - **A session represents every hub it was issued for**, not one chosen from them: a session of the actor's hub and another is a read of
   *   the other hub too. The hubs of a list are the union of the hubs of the sessions it returns (and only those: a session that was not
   *   returned, an ended one or one past its idle limit, represents nothing). A vendor's session carries none and crosses nothing.
   * - **One bounded event for each distinct foreign hub**, in the order of the hubs' ids: it names the hub and the operation, and carries
   *   neither a session, a row nor an identifier of either. An empty answer, and one inside the actor's own hub, write none.
   * - The event is enhanced and is written in the read's own transaction, so a ledger that cannot take it fails the read: an unaudited
   *   read outside the actor's hub is the one thing the event exists to prevent.
   */
  async #auditCrossings(
    handle: TransactionHandle,
    authorized: AuthorizedRequest,
    items: readonly SessionView[],
  ): Promise<void> {
    if (items.length === 0) return;
    const own = await transactionOf(handle).execute(
      sql`select primary_hub_id from staff_identity where id = ${authorized.session.principalId}::uuid`,
    );
    const baseline =
      (own.rows[0] as { primary_hub_id: string | null } | undefined)?.primary_hub_id ?? null;
    const foreign = [
      ...new Set(
        items
          .flatMap((item) => item.authorized_hub_ids)
          .map((hub) => hub.toLowerCase())
          .filter((hub) => hub !== baseline?.toLowerCase()),
      ),
    ].toSorted();
    for (const hubId of foreign) {
      await this.#options.audit.write(handle, {
        code: 'auth.hub_boundary.crossed',
        enhanced: true,
        outcome: 'SUCCEEDED',
        object: { type: 'HUB', id: hubId },
        responsibleHubId: hubId,
        relatedIds: { operation_id: 'listSessions' },
      });
    }
  }

  async revoke(
    authorized: AuthorizedRequest,
    correlationId: string,
    sessionId: string,
    body: { readonly reason_code: string; readonly note?: string },
  ): Promise<SessionView> {
    const { runner, sessions, audit, reasons } = this.#options;
    // The note is judged with the rest of the body, before anything is read or written.
    const note = checkedNote(body.note);
    return runner.mutate(authorized, correlationId, async (handle) => {
      const before = await this.#read(handle, sessionId);
      let reason;
      try {
        reason = await reasons.validate(handle, {
          reasonCode: body.reason_code,
          operationId: 'revokeSession',
          ...(note === undefined ? {} : { note }),
        });
      } catch (error) {
        if (error instanceof ReasonRefusedError) {
          throw ApiException.of(
            error.code === 'REASON_REQUIRED' ? ErrorCode.ReasonRequired : ErrorCode.ReasonNotActive,
            error.message,
          );
        }
        throw error;
      }
      if (before.terminated_at !== null) return viewOf(before);

      const ended = await sessions.terminate(handle, { by: 'session', sessionId }, 'ADMIN_REVOKED');
      const after = await this.#read(handle, sessionId);
      if (ended.length === 1) {
        await audit.write(handle, {
          code: 'auth.session.terminated',
          enhanced: true,
          enhancedBasis: 'ADMINISTRATIVE_REVOCATION',
          outcome: 'SUCCEEDED',
          object: { type: 'Session', id: sessionId },
          previousState: 'ACTIVE',
          resultingState: 'TERMINATED',
          reason: { code: reason.code, label: reason.label },
          ...(note === undefined ? {} : { note }),
          beforeAfter: {
            state: { before: 'ACTIVE', after: 'TERMINATED' },
            termination_reason: { before: null, after: 'ADMIN_REVOKED' },
          },
          relatedIds: { principal_id: before.principal_id },
          detail: { cause: 'ADMIN_REVOKED', principal_type: before.principal_type },
        });
      }
      return viewOf(after);
    });
  }

  /** The session as the caller's scope shows it; a session that is gone is not found. */
  async #read(handle: TransactionHandle, id: string): Promise<SessionRow> {
    const found = await transactionOf(handle).execute(
      sql`select ${COLUMNS} from session where id = ${id}::uuid`,
    );
    const row = found.rows[0] as unknown as SessionRow | undefined;
    if (row === undefined) throw ApiException.of(ErrorCode.NotFound, 'Resource not found');
    return row;
  }
}
