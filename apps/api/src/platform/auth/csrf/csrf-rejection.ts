import type { Logger } from 'pino';

import type { SecurityContext } from '../../database/transaction-context.js';
import type { AuditWriter } from '../ports/audit-writer.port.js';
import type { UnitOfWork } from '../ports/unit-of-work.port.js';
import type { StoredSession } from '../ports/session-store.port.js';
import { AUTHENTICATION_PRINCIPAL_ID } from '../sessions/session-parameters.js';
import type { CsrfCheck } from './csrf-decision.js';

/** What a rejection records: where it happened, which check failed, and the session only where one identified a principal. */
export interface CsrfRejection {
  readonly method: string;
  /** The route as the router matched it (`/api/v1/auth/staff/sign-in`, `/api/v1/ops/vendors/:id`): never the address as sent. */
  readonly route: string;
  readonly check: CsrfCheck;
  /** The session the request was authenticated with. A pre-session refusal has none, and no principal is invented for it. */
  readonly session?: Pick<StoredSession, 'id' | 'principalType' | 'principalId' | 'authority'>;
  readonly correlationId: string;
}

export interface CsrfRejectionRecorderOptions {
  readonly unitOfWork: UnitOfWork;
  readonly audit: AuditWriter;
  readonly logger: Pick<Logger, 'warn'>;
}

const AUDIT_ACTOR = { STAFF: 'STAFF', RIDER: 'RIDER', VENDOR: 'VENDOR_ACCOUNT' } as const;

/**
 * Writes `auth.csrf.rejected` (S0.25; audit.md §5.4; `GBT-W11`): a cookie-authenticated unsafe request that failed the synchronizer
 * token, or a browser credential mutation (a pre-session one included) that failed the `Origin` check. It records **the route and
 * which check failed**, and the principal only where a session identified one: a pre-session refusal has none and records none, so
 * the actor is the platform itself with no id and no object is named. The token, its hash and the `Origin` the caller sent are
 * never recorded (the first two are secrets, the third is attacker-chosen text).
 *
 * - It runs in a short transaction of its own under the `authentication` capability, because a refused request has no other, and
 *   the record must not depend on anything the request would have done. A SYSTEM transaction may name the person it
 *   authenticated, which is how a session's principal is recorded as the actor.
 * - **It never throws and never changes the answer.** The refusal is `403` whether or not the record could be written: a refusal
 *   that failed because the audit table was unreachable would turn an audit outage into a way past the check. A failure is
 *   logged, with the error and nothing of the request.
 * - The event is not enhanced (audit.md §5), so there is no act that must fail when it cannot be written.
 *
 * One event is written for each refused request. That makes the audit volume of an unauthenticated flood of cross-site writes the
 * flood's own: the transport limits and the edge bound it, and nothing here coalesces it (plan §7.18, finding).
 */
export class CsrfRejectionRecorder {
  readonly #options: CsrfRejectionRecorderOptions;

  constructor(options: CsrfRejectionRecorderOptions) {
    this.#options = options;
  }

  async record(rejection: CsrfRejection): Promise<void> {
    const { unitOfWork, audit, logger } = this.#options;
    const context: SecurityContext = {
      principalType: 'SYSTEM',
      principalId: AUTHENTICATION_PRINCIPAL_ID,
      surface: 'SYSTEM',
      taskCapability: 'authentication',
      correlationId: rejection.correlationId,
    };
    const { session } = rejection;
    try {
      await unitOfWork.run(context, (handle) =>
        audit.write(handle, {
          code: 'auth.csrf.rejected',
          enhanced: false,
          outcome: 'REJECTED',
          ...(session === undefined
            ? {}
            : {
                actor: { type: AUDIT_ACTOR[session.principalType], id: session.principalId },
                actorBundle: session.authority.snapshot.name,
              }),
          object: { type: 'Session', id: session?.id ?? null },
          detail: { route: `${rejection.method} ${rejection.route}`, check: rejection.check },
        }),
      );
    } catch (error) {
      logger.warn(
        { err: error },
        'a rejected CSRF check could not be recorded; the request is still refused',
      );
    }
  }
}
