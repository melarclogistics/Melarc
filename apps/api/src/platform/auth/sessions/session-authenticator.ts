import { SettingInvalidError, type SettingsReader } from '../../settings/settings-reader.js';
import type { SecurityContext } from '../../database/transaction-context.js';
import type { SessionStore, StoredSession } from '../ports/session-store.port.js';
import type { TokenService } from '../ports/token-service.port.js';
import type { UnitOfWork } from '../ports/unit-of-work.port.js';
import type { PresentedCredential } from './session-credentials.js';
import { judgeSession } from './session-judgement.js';
import {
  AUTHENTICATION_PRINCIPAL_ID,
  SESSION_IDLE_SETTING,
  tierOf,
  type SessionTier,
} from './session-parameters.js';

/** The injection token of the authenticator, which the authentication guard asks for. */
export const SESSION_AUTHENTICATOR = Symbol('SESSION_AUTHENTICATOR');

/** A request that a live session stands behind, and the instant that was judged. */
export interface AuthenticatedSession {
  readonly session: StoredSession;
  /** How it was presented: a browser session travels in a cookie and a Rider's in a bearer credential. */
  readonly credential: 'COOKIE' | 'BEARER';
  /** The fresh database time the session was judged on. */
  readonly judgedAt: Date;
}

/**
 * Why a request has no usable session. **Outward it is one answer** (`SESSION_INVALID`, or `SESSION_SUPERSEDED` for a displaced
 * vendor session alone): distinguishing them tells an unauthenticated caller which guess was closest (errors-and-enums.md §4). The
 * cause is for the log and the audit, which keep the precise reason: undifferentiated outward, precise inward.
 */
export type AuthenticationRefusalCause =
  | 'NO_CREDENTIAL'
  | 'AMBIGUOUS_CREDENTIAL'
  | 'MALFORMED_TOKEN'
  | 'UNKNOWN_SESSION'
  | 'WRONG_CREDENTIAL_FOR_SESSION'
  | 'SESSION_TERMINATED'
  | 'SESSION_EXPIRED_ABSOLUTE'
  | 'SESSION_EXPIRED_IDLE';

export type AuthenticationOutcome =
  | { readonly kind: 'AUTHENTICATED'; readonly authenticated: AuthenticatedSession }
  | {
      readonly kind: 'REFUSED';
      readonly code: 'SESSION_INVALID' | 'SESSION_SUPERSEDED';
      readonly cause: AuthenticationRefusalCause;
    };

export interface SessionAuthenticatorOptions {
  readonly unitOfWork: UnitOfWork;
  readonly sessions: Pick<SessionStore, 'findByTokenHash' | 'recordActivity'>;
  readonly tokens: Pick<TokenService, 'hash'>;
  readonly settings: Pick<SettingsReader, 'object'>;
}

const refused = (
  cause: AuthenticationRefusalCause,
  code: 'SESSION_INVALID' | 'SESSION_SUPERSEDED' = 'SESSION_INVALID',
): AuthenticationOutcome => ({ kind: 'REFUSED', code, cause });

/**
 * Authentication: who is behind this request, from the session credential it presents (S0.24; SECURITY_DESIGN.md §13; step 2 of the
 * refusal order of permission-enforcement.md §5.1). It looks the session up by the hash of the token, in one short transaction under
 * the `authentication` capability, and judges it on **one fresh database time** read in that transaction.
 *
 * - **The credential is judged before the database is asked.** No credential, a cookie and a bearer credential together, a session
 *   cookie twice, and a token that is not a well-formed token are all refused without a statement.
 * - **The three authentication models never mix.** A browser session (staff, vendor) is accepted from the cookie and a Rider's from
 *   a bearer credential, and a session presented the other way is refused as though it did not exist.
 * - **Expiry is decided here, at request time, never by a job**: `now >= expires_at` ends a session, and for a browser session so
 *   does `now - last_activity_at >= idle` (the idle limit of its tier, read from `session_idle_timeout_minutes`); equality is
 *   expired. A rider has no idle rule. Nothing is written for a refused request.
 * - **Activity is recorded** for an accepted one, coalesced by the store, in the same transaction as the lookup.
 * - **A displaced vendor is told so**: a vendor session ended by a newer sign-in is `SESSION_SUPERSEDED`; every other refusal is
 *   `SESSION_INVALID`.
 * - It does **not** judge the session's authority: whether the bundle it was issued from has since been reduced, and the fixed
 *   policy of a vendor or a rider, are the request-time authority checks of the authorization step (S0.26, S0.27). Authentication
 *   is that the session is live; authorization is what it may do.
 */
export class SessionAuthenticator {
  readonly #options: SessionAuthenticatorOptions;

  constructor(options: SessionAuthenticatorOptions) {
    this.#options = options;
  }

  async authenticate(
    credential: PresentedCredential,
    correlationId: string,
  ): Promise<AuthenticationOutcome> {
    if (credential.kind === 'NONE') return refused('NO_CREDENTIAL');
    if (credential.kind === 'AMBIGUOUS') return refused('AMBIGUOUS_CREDENTIAL');
    const hash = this.#options.tokens.hash(credential.token);
    if (hash === null) return refused('MALFORMED_TOKEN');

    const context: SecurityContext = {
      principalType: 'SYSTEM',
      principalId: AUTHENTICATION_PRINCIPAL_ID,
      surface: 'SYSTEM',
      taskCapability: 'authentication',
      correlationId,
    };
    const { unitOfWork, sessions } = this.#options;
    return unitOfWork.run(context, async (handle): Promise<AuthenticationOutcome> => {
      const found = await sessions.findByTokenHash(handle, hash);
      if (found === null) return refused('UNKNOWN_SESSION');
      // A browser session in a cookie, a rider's in a bearer credential, and never the other way round.
      if ((credential.kind === 'COOKIE') !== (found.principalType !== 'RIDER')) {
        return refused('WRONG_CREDENTIAL_FOR_SESSION');
      }

      const now = await unitOfWork.databaseNow(handle);
      const idle =
        found.principalType === 'RIDER'
          ? null
          : await this.#idleMinutes(handle, tierOf(found.principalType, found.authority.snapshot));
      const verdict = judgeSession(found, now, idle);
      switch (verdict.kind) {
        case 'TERMINATED':
          return found.principalType === 'VENDOR' && verdict.reason === 'SUPERSEDED_BY_NEW_LOGIN'
            ? refused('SESSION_TERMINATED', 'SESSION_SUPERSEDED')
            : refused('SESSION_TERMINATED');
        case 'EXPIRED':
          return refused(
            verdict.cause === 'ABSOLUTE' ? 'SESSION_EXPIRED_ABSOLUTE' : 'SESSION_EXPIRED_IDLE',
          );
        case 'ACTIVE':
          await sessions.recordActivity(handle, found.id, now);
          return {
            kind: 'AUTHENTICATED',
            authenticated: { session: found, credential: credential.kind, judgedAt: now },
          };
      }
    });
  }

  /** The idle limit of a tier, from the setting that holds it for all three. A missing or malformed one is a refusal, never "none". */
  async #idleMinutes(
    handle: Parameters<UnitOfWork['databaseNow']>[0],
    tier: SessionTier,
  ): Promise<number> {
    const limits = await this.#options.settings.object(handle, SESSION_IDLE_SETTING);
    const minutes = limits[tier];
    if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1) {
      throw new SettingInvalidError(
        SESSION_IDLE_SETTING,
        `the ${tier} tier is not a positive whole number of minutes`,
      );
    }
    return minutes;
  }
}
