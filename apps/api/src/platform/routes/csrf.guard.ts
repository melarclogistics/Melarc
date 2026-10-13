import { randomUUID } from 'node:crypto';

import {
  Inject,
  Injectable,
  Optional,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { decideBrowserMutation, type CsrfCheck } from '../auth/csrf/csrf-decision.js';
import { CSRF_REJECTION_RECORDER } from '../auth/csrf/csrf-providers.js';
import type { CsrfRejectionRecorder } from '../auth/csrf/csrf-rejection.js';
import { TOKEN_SERVICE, type TokenService } from '../auth/ports/token-service.port.js';
import { authenticatedSessionOf } from '../auth/sessions/request-session.js';
import type { AppConfig } from '../config/load-config.js';
import { ApiException } from '../http/api-exception.js';
import { ErrorCode } from '../http/error-codes.js';
import { currentRequestContext } from '../logging/request-context.js';
import { APP_CONFIG } from '../platform.tokens.js';
import { accessDetailOf, accessKindOf } from './access-kind.js';
import { BROWSER_ON_BOTH_SURFACES, type BrowserSurface } from './access-declaration.js';

/** The methods that change nothing: a read, a probe and a preflight get no blanket `Origin` requirement (SECURITY_DESIGN.md §13.8). */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Step 3 of the refusal order: CSRF and Origin (permission-enforcement.md §5.1; SECURITY_DESIGN.md §13.8; S0.25;
 * `AC-SLICE-000-130`). It decides, for a request that changes state, which of three cases it is, and applies the rule of that case
 * and no other:
 *
 * 1. **A browser pre-session mutation** (an `anonymous` route that serves a browser page): an `Origin` that exactly matches an
 *    origin configured for one of the route's surfaces. Missing, `null`, malformed or unlisted is `403 CSRF_VALIDATION_FAILED`.
 *    There is no session and no token to check; Fetch Metadata is read beside the `Origin`.
 * 2. **A cookie-authenticated mutation** (the request authenticated with a browser session's cookie): the `Origin` of the
 *    **session's own surface** (a staff session is the Ops origin's, a vendor session the Vendor origin's), the synchronizer token
 *    the session stored, and Fetch Metadata. All three; the first that fails is named in the audit.
 * 3. **A native operation** (an `anonymous` route declared `native`, or a request authenticated with the Rider's bearer
 *    credential): no `Origin`, no token and no Fetch Metadata are required, and none is refused for its absence. This is not a
 *    browser bypass. What the request is, is decided by the credential it was authenticated with, which cannot be forged by a
 *    header: a browser session is accepted only from its cookie and a Rider's only as a bearer credential, so no browser-made
 *    request can be judged under case 3, and a cookie never satisfies a Rider-only operation (the authentication step refuses it
 *    first). A `User-Agent`, or a client-type string the caller sends, changes nothing here.
 *
 * Safe methods pass. A route that is technical or undeclared is not this guard's (the declaration guard refuses the latter). It
 * fails closed on what it cannot place: a route that needs a principal reached with no session held is refused, because this
 * guard must never be the one that lets such a request on.
 *
 * Every refusal is the same `403 CSRF_VALIDATION_FAILED` whatever failed. The cause goes to the audit (`auth.csrf.rejected`), which
 * records the route and the check, never the token, its hash or the `Origin` as sent.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Optional() @Inject(TOKEN_SERVICE) private readonly tokens: TokenService | undefined,
    @Optional()
    @Inject(CSRF_REJECTION_RECORDER)
    private readonly recorder: CsrfRejectionRecorder | undefined,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const kind = accessKindOf(this.reflector, context);
    if (kind === undefined || kind === 'technical') return true;
    const request = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(request.method)) return true;

    const session = authenticatedSessionOf(request);
    let check: CsrfCheck | undefined;

    if (kind === 'anonymous') {
      const client = accessDetailOf(this.reflector, context)?.client ?? BROWSER_ON_BOTH_SURFACES;
      if (client.kind === 'native') return true;
      check = this.#judge(request, this.#originsOf(client.surfaces));
    } else if (session === undefined) {
      // A route that needs a principal is only reached through authentication, which holds the session it found.
      throw new ApiException(ErrorCode.CsrfValidationFailed, 403, 'CSRF validation failed');
    } else if (session.credential === 'BEARER') {
      return true;
    } else {
      const surface: BrowserSurface | undefined =
        session.session.principalType === 'STAFF'
          ? 'OPS_PORTAL'
          : session.session.principalType === 'VENDOR'
            ? 'VENDOR_PWA'
            : undefined;
      check = this.#judge(
        request,
        surface === undefined ? [] : this.#originsOf([surface]),
        session.session.csrfTokenHash,
      );
    }

    if (check === undefined) return true;
    // The recorder keeps its own failures; this keeps the answer if it were to break that promise, so that the record can never be
    // what decides whether the request is refused.
    await this.recorder
      ?.record({
        method: request.method,
        route: this.#routeOf(request),
        check,
        ...(session === undefined ? {} : { session: session.session }),
        correlationId: currentRequestContext()?.requestId ?? randomUUID(),
      })
      .catch(() => undefined);
    throw new ApiException(ErrorCode.CsrfValidationFailed, 403, 'CSRF validation failed');
  }

  /** The origins configured for these surfaces. */
  #originsOf(surfaces: readonly BrowserSurface[]): string[] {
    const { ops, vendor } = this.config.origins;
    return surfaces.map((surface) => (surface === 'OPS_PORTAL' ? ops : vendor));
  }

  /** `undefined` when the request passes; the failed check otherwise. `storedHash` is given only for a cookie session. */
  #judge(
    request: Request,
    allowedOrigins: readonly string[],
    storedHash?: Uint8Array | null,
  ): CsrfCheck | undefined {
    const decision = decideBrowserMutation({
      allowedOrigins,
      rawHeaders: request.rawHeaders,
      // The synchronizer is required exactly when a session's cookie is what authenticated the request.
      ...(storedHash === undefined
        ? {}
        : {
            synchronizer: {
              storedHash,
              // No token service composed means no token can be verified, and so none is accepted.
              tokens: this.tokens ?? { matches: () => false },
            },
          }),
    });
    return decision.allowed ? undefined : decision.check;
  }

  /** The route as the router matched it, or a fixed word where it cannot say: never the address as sent. */
  #routeOf(request: Request): string {
    const matched: unknown = (request.route as { path?: unknown } | undefined)?.path;
    return typeof matched === 'string' ? matched : '(unmatched)';
  }
}
