import type { Logger } from 'pino';

import type { SecurityContext } from '../../database/transaction-context.js';
import type { SessionStore, StoredSession } from '../ports/session-store.port.js';
import type { UnitOfWork } from '../ports/unit-of-work.port.js';
import { ACTIVITY_COALESCE_MS, AUTHENTICATION_PRINCIPAL_ID } from './session-parameters.js';

/** What one recording needs to know of the request whose activity it records. */
export interface ActivityRecording {
  readonly session: Pick<StoredSession, 'id' | 'lastActivityAt'>;
  /** The database instant authentication judged the session at, and the idle limit it was judged by (none for a rider). */
  readonly judgedAt: Date;
  readonly idleMinutes: number | null;
  readonly correlationId: string;
}

export interface ActivityRecorderOptions {
  readonly unitOfWork: UnitOfWork;
  readonly sessions: Pick<SessionStore, 'recordActivity'>;
  readonly logger: Pick<Logger, 'warn'>;
}

/**
 * Writes that a person acted on a session (S0.26; decision A of 12 October 2026; SECURITY_DESIGN.md section 13.3), in a short
 * transaction of its own under the `authentication` capability, which only code under `platform/auth/` may open. The decision that a
 * request counts is not made here: the route's policy and the outcome of the request decide it (`SessionActivityInterceptor`), and
 * this is the door that writes.
 *
 * - **The write judges the session, after the lock.** `SessionStore.recordActivity` takes the session's row lock first, which waits
 *   for every holder, and only then runs the statement that judges on the database's own clock whether the session is live (not
 *   ended, before its absolute end, not idle) and writes. A single statement would have judged on the clock it read before the wait,
 *   and PostgreSQL re-checks a waiting UPDATE only against a row that was changed, not one that was merely locked; so a wait cannot
 *   revive a session that ended, went idle or reached its end meanwhile (the review of 12 October 2026, V01).
 * - **It is skipped without a statement when the activity authentication read is younger than the coalescing window**: the write
 *   would find the window covered. A burst of requests costs one statement per window and no more.
 * - **It never throws.** A failure to record is logged, with the error, and the request is answered as it was: the work has been
 *   done, and a person is not made to fail by an audit-like bookkeeping write.
 */
export class ActivityRecorder {
  readonly #options: ActivityRecorderOptions;

  constructor(options: ActivityRecorderOptions) {
    this.#options = options;
  }

  async record(recording: ActivityRecording): Promise<void> {
    const { unitOfWork, sessions, logger } = this.#options;
    const { session, judgedAt, idleMinutes } = recording;
    if (judgedAt.getTime() - session.lastActivityAt.getTime() < ACTIVITY_COALESCE_MS) return;
    const identity: SecurityContext = {
      principalType: 'SYSTEM',
      principalId: AUTHENTICATION_PRINCIPAL_ID,
      surface: 'SYSTEM',
      taskCapability: 'authentication',
      correlationId: recording.correlationId,
    };
    try {
      await unitOfWork.run(identity, (handle) =>
        sessions.recordActivity(handle, session.id, idleMinutes),
      );
    } catch (error) {
      logger.warn({ err: error }, 'the activity of a session could not be recorded');
    }
  }
}
