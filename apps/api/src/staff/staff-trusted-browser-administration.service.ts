import { sql } from 'drizzle-orm';

import type { AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import type { IdempotencyStore } from '../platform/auth/ports/idempotency-store.port.js';
import type { TrustedBrowserStore } from '../platform/auth/trusted-browsers/trusted-browser-store.js';
import {
  trustedBrowserView,
  type TrustedBrowserView,
} from '../platform/auth/trusted-browsers/trusted-browser-view.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import type { TransactionHandle } from '../platform/auth/ports/unit-of-work.port.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import { requireTier } from '../platform/authorization/tier-policy.js';
import { transactionOf } from '../platform/database/transaction-handle.js';
import { ApiException } from '../platform/http/api-exception.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { isIdempotencyKey } from '../platform/idempotency/idempotency-scope.js';
import { ReasonRefusedError, type ReasonValidator } from '../platform/settings/reason-validator.js';
import { lockStaffIdentity } from './staff-locked-identity.js';
import { checkedNote } from './staff-note.js';

export interface StaffTrustedBrowserAdministrationOptions {
  readonly runner: Pick<OperationRunner, 'read' | 'mutate'>;
  readonly store: Pick<TrustedBrowserStore, 'list' | 'revokeAll'>;
  readonly audit: AuditWriter;
  readonly reasons: Pick<ReasonValidator, 'validate'>;
  /** Keeps the answer of a removal by the caller's `Idempotency-Key`, so that a retry of a lost answer removes nothing more. */
  readonly idempotency: IdempotencyStore;
}

/** The operation's id as the idempotency store keys it. */
const OPERATION_REVOKE = 'revokeStaffTrustedBrowsers';

const invalidKey = (): ApiException =>
  new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
    violations: [{ in: 'header', pointer: 'Idempotency-Key', rule: 'format' }],
  });

/**
 * `listStaffTrustedBrowsers` and `revokeStaffTrustedBrowsers` (staff-authentication.md §5.8): another person's trusted browsers, read and
 * removed by a Platform Admin. A trusted browser is standing access of a staff identity, of the same kind as a staff session, and it ends at
 * the same authority: `staff.session.revoke` at tier `P`, asked by the guard before the record is looked for and asked again here.
 *
 * - **The list** is a read in the caller's own context: the identity must be in the caller's scope (the guard has answered `HUB_SCOPE_VIOLATION`
 *   or `NOT_FOUND` already), and what it shows is a label and dates. `current` is always false: the credential of the request is the
 *   administrator's, not the person's. **It is an authorised read of another person's records, so it is audited when it crosses a hub**
 *   (audit.md sections 5.4 and 6; G04 of the audit of 26 October 2026), by the rule the other staff lists follow: the hub it represents is
 *   the **primary hub of the identity in the path**, read from the identity under the caller's own scope and never taken from the client;
 *   the baseline is the actor's primary hub (an actor with none, a Platform Admin, has none of their own, so every hub they read is
 *   foreign); a hub that is the actor's own, an identity with no hub and an empty list write nothing; a list that shows browsers of
 *   another hub writes one enhanced `auth.hub_boundary.crossed` naming the hub and the operation, with no browser, label or id in it.
 *   The event is written in the read's own transaction, so a ledger that cannot take it fails the read: an unaudited read of another
 *   hub is the one thing the event exists to prevent.
 * - **The removal** takes an `Idempotency-Key` (the audit of 26 October 2026, G03). "Every valid trusted browser the identity holds" is not a
 *   fixed set: a retry of a removal whose answer was lost would remove a browser the person enrolled in between. The receipt is begun first
 *   in the transaction that acts and completed in it, with the removals and the event, so that a replay answers the original count, runs
 *   nothing and writes nothing, the same key with another identity, reason or note is `IDEMPOTENCY_KEY_CONFLICT`, and a failed attempt
 *   leaves no receipt behind (the transaction takes it back with the rest). It then locks the identity first, in the caller's scope
 *   (`melarc.staff_locked_facts`, which also binds the identity the table's policy names), so that the removal and a sign-in that is issuing a
 *   trusted browser at the same moment are ordered: the sign-in's browser is removed with the rest if it was issued first, and a person
 *   who proves a code after the removal is given a new one, because **a removal ends what exists and is not a ban**; then validates the reason against the
 *   session-revocation domain (a trusted browser is revoked for the same causes a session is, and the catalogue holds no second set); then
 *   removes **all** the identity's valid trusted browsers with the cause `ADMINISTRATOR`; and writes the enhanced
 *   `auth.trusted_browser.admin_revoked` with the reason, the note and the number removed. Removing none is not an error.
 */
export class StaffTrustedBrowserAdministration {
  readonly #options: StaffTrustedBrowserAdministrationOptions;

  constructor(options: StaffTrustedBrowserAdministrationOptions) {
    this.#options = options;
  }

  async list(
    authorized: AuthorizedRequest,
    correlationId: string,
    staffIdentityId: string,
  ): Promise<{ readonly items: readonly TrustedBrowserView[] }> {
    const { runner, store } = this.#options;
    requireTier(authorized.grant?.tier ?? null, 'P');
    return runner.read(authorized, correlationId, async (handle) => {
      const browsers = await store.list(handle, staffIdentityId);
      if (browsers.length > 0) await this.#auditCrossing(handle, authorized, staffIdentityId);
      return { items: browsers.map((browser) => trustedBrowserView(browser, null)) };
    });
  }

  /** One `auth.hub_boundary.crossed` when the identity whose browsers were shown belongs to a hub other than the actor's own. */
  async #auditCrossing(
    handle: TransactionHandle,
    authorized: AuthorizedRequest,
    staffIdentityId: string,
  ): Promise<void> {
    const hubs = await transactionOf(handle).execute(
      sql`select (select primary_hub_id from staff_identity where id = ${staffIdentityId}::uuid) as represented,
                 (select primary_hub_id from staff_identity where id = ${authorized.session.principalId}::uuid) as own`,
    );
    const row = hubs.rows[0] as { represented: string | null; own: string | null } | undefined;
    const represented = row?.represented ?? null;
    if (represented === null || represented === (row?.own ?? null)) return;
    await this.#options.audit.write(handle, {
      code: 'auth.hub_boundary.crossed',
      enhanced: true,
      outcome: 'SUCCEEDED',
      object: { type: 'HUB', id: represented },
      responsibleHubId: represented,
      relatedIds: { operation_id: 'listStaffTrustedBrowsers' },
    });
  }

  async revoke(
    authorized: AuthorizedRequest,
    correlationId: string,
    staffIdentityId: string,
    request: {
      readonly body: { readonly reason_code: string; readonly note?: string };
      readonly idempotencyKey: string;
      /** `fingerprintOfRequest`: the operation, the identity in the path, the reason and the note. */
      readonly fingerprint: string;
    },
  ): Promise<{ readonly revoked: number }> {
    const { runner, store, audit, reasons, idempotency } = this.#options;
    const { body } = request;
    requireTier(authorized.grant?.tier ?? null, 'P');
    // The note is judged with the rest of the body, before anything is read or written.
    const note = checkedNote(body.note);
    // The key is the store's to keep: one it would refuse is a request that is not valid, not a defect of the server.
    if (!isIdempotencyKey(request.idempotencyKey)) throw invalidKey();
    return runner.mutate(authorized, correlationId, async (handle) => {
      const scope = {
        principalType: 'STAFF',
        principalId: authorized.session.principalId,
        operationId: OPERATION_REVOKE,
        key: request.idempotencyKey,
      } as const;
      const begun = await idempotency.begin(handle, scope, request.fingerprint);
      if (begun.outcome === 'REPLAY') {
        return JSON.parse(Buffer.from(begun.response.body).toString('utf8')) as {
          readonly revoked: number;
        };
      }
      if (begun.outcome === 'CONFLICT') {
        throw ApiException.of(
          ErrorCode.IdempotencyKeyConflict,
          'That Idempotency-Key was used with a different request',
        );
      }
      if (begun.outcome !== 'NEW') {
        // A record that began and did not complete is a stranded one (OB-100): the command is not run again, and nothing is invented.
        throw new Error('An idempotency record of this command is stranded');
      }
      const locked = await lockStaffIdentity(handle, staffIdentityId);
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
      const removed = await store.revokeAll(handle, {
        staffIdentityId,
        cause: 'ADMINISTRATOR',
        revokedBy: authorized.session.principalId,
      });
      await audit.write(handle, {
        code: 'auth.trusted_browser.admin_revoked',
        enhanced: true,
        outcome: 'SUCCEEDED',
        object: { type: 'StaffIdentity', id: staffIdentityId },
        ...(locked.row.primary_hub_id === null
          ? {}
          : { responsibleHubId: locked.row.primary_hub_id }),
        reason: { code: reason.code, label: reason.label },
        ...(note === undefined ? {} : { note }),
        beforeAfter: { valid_trusted_browsers: { before: removed.length, after: 0 } },
        relatedIds: { trusted_browser_ids: removed },
        detail: { revoked: removed.length },
      });
      const answer = { revoked: removed.length };
      await idempotency.complete(handle, scope, {
        status: 200,
        body: new TextEncoder().encode(JSON.stringify(answer)),
      });
      return answer;
    });
  }
}
