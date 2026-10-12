import {
  Inject,
  Injectable,
  Optional,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import type { Request } from 'express';
import { catchError, from, mergeMap, throwError, type Observable } from 'rxjs';

import type { ActivityRecorder } from '../auth/sessions/activity-recorder.js';
import { ACTIVITY_RECORDER } from '../auth/sessions/session-providers.js';
import { ApiException } from '../http/api-exception.js';
import { ErrorCode } from '../http/error-codes.js';
import { currentRequestContext } from '../logging/request-context.js';
import { authorizationOf, type AuthorizedRequest } from './authorized-request.js';

/**
 * The answers that are a **refusal of authority**, and so never count as the person acting (decision A of 12 October 2026): not a
 * session, not the right origin or token, not allowed, not allowed at this tier or in this hub, and not allowed so many times. A
 * request answered by one of them was not an action the person was entitled to take, whoever sent it. (The guards that raise most
 * of these refuse before this interceptor runs at all; the use cases raise the tier and the hub ones.)
 */
const REFUSALS_OF_AUTHORITY: ReadonlySet<string> = new Set([
  ErrorCode.SessionInvalid,
  ErrorCode.SessionSuperseded,
  ErrorCode.CsrfValidationFailed,
  ErrorCode.PermissionDenied,
  ErrorCode.InsufficientAuthority,
  ErrorCode.HubScopeViolation,
  ErrorCode.RateLimited,
]);

/**
 * Whether the end of a request is the person acting. **Not "every 4xx is inactivity"**: an authenticated, authorized action that
 * is answered with a validation failure, a version or state conflict or a business-rule refusal is still the person at the screen,
 * and is activity. What does not count is a refusal of authority (above), and a failure of the platform itself (a `5xx`, an
 * unexpected error), which says nothing about the person.
 */
export function countsAsActivity(error: unknown): boolean {
  if (error instanceof ApiException) {
    return !REFUSALS_OF_AUTHORITY.has(error.code) && error.getStatus() < 500;
  }
  if (error instanceof HttpException) {
    const status = error.getStatus();
    return status < 500 && status !== 401 && status !== 403 && status !== 429;
  }
  return false;
}

/**
 * Records that the person acted (S0.26; decision A of 12 October 2026; SECURITY_DESIGN.md section 13.3; plan `OB-131`). It runs
 * around the part of the request that follows the guards, so a request that the rate limit, authentication, the CSRF check or the
 * authorization guard refused never reaches it and never extends the idle lifetime, and it decides from the **outcome**:
 *
 * - **Only a route that declared itself `qualifying` records anything.** A `background` route (a poll, a refresh) never does, so an
 *   unattended page that polls does not keep a session alive; there is no header, query or body that can say otherwise, because the
 *   policy is the route's and is read from its declaration.
 * - **The outcome decides.** A request that succeeded, or that was answered with a validation, conflict, state or business-rule
 *   answer, counts (`countsAsActivity`); one the use case refused for authority (tier, hub) or the platform failed does not.
 * - **The write judges the session, after the lock.** It takes the session's row lock, waiting for any holder, and then judges on the
 *   database's own clock whether the session is live (not ended, before its absolute end, not idle) at that moment, so a request
 *   cannot revive a session that ended, went idle or reached its end while it ran, however long it waited and whether the holder
 *   changed the row or only locked it. It does not change the answer: the work has been done and is answered as it was, and a
 *   session that is no longer live simply is not extended.
 * - **It is quiet and never throws.** The write is the recorder's (`ActivityRecorder`, under `platform/auth/`, which alone may open
 *   the capability the write needs): a failure to record is logged there and does not turn a served request into an error, and a
 *   recorded activity younger than the coalescing window is skipped without a statement.
 *
 * It sits **outside** the contract validation (it is registered first), so the validation failure of an authorized action is
 * activity too.
 */
@Injectable()
export class SessionActivityInterceptor implements NestInterceptor {
  constructor(
    @Optional() @Inject(ACTIVITY_RECORDER) private readonly recorder: ActivityRecorder | undefined,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const authorized = authorizationOf(context.switchToHttp().getRequest<Request>());
    if (authorized?.activity !== 'qualifying' || this.recorder === undefined) return next.handle();

    return next.handle().pipe(
      catchError((error: unknown) =>
        countsAsActivity(error)
          ? from(this.#record(authorized)).pipe(mergeMap(() => throwError(() => error)))
          : throwError(() => error),
      ),
      mergeMap((value: unknown) => from(this.#record(authorized)).pipe(mergeMap(() => [value]))),
    );
  }

  async #record(authorized: AuthorizedRequest): Promise<void> {
    await this.recorder?.record({
      session: authorized.session,
      judgedAt: authorized.judgedAt,
      idleMinutes: authorized.idleMinutes,
      correlationId: currentRequestContext()?.requestId ?? authorized.session.id,
    });
  }
}
