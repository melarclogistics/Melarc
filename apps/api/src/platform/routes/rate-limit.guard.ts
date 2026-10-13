import {
  Inject,
  Injectable,
  Optional,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { RATE_LIMITER, type RateLimiter } from '../auth/ports/rate-limiter.port.js';
import { ApiException } from '../http/api-exception.js';
import { boundedIdentifier } from '../http/admission/bounded-identifier.js';
import { ErrorCode } from '../http/error-codes.js';
import { LimiterUnavailableError } from '../limiter/limiter-errors.js';
import { accessDetailOf } from './access-kind.js';

/**
 * Step 1 of the refusal order (permission-enforcement.md §5.1; `AC-SLICE-000-130`): the rate limit, **before anything is verified or
 * counted**. For a pre-authentication operation that names a bucket it takes the bucket's identifier from the body with a bounded
 * extraction, without the validation of step 8, puts it in the bucket's canonical form, and asks the authoritative limiter. A
 * refusal is `429 RATE_LIMITED` (no `Retry-After`: errors-and-enums.md §4), and consumption is the limiter's own commit, which does not
 * wait for what the request goes on to do.
 *
 * - **Where no identifier can be taken** (no body, not an object, absent, not text, empty, over its bound, a body that could not be
 *   parsed), the request meets the coarse admission limits of the transport and is neither counted nor refused for it.
 * - **A limiter that cannot decide, or none composed for a route that names a bucket, fails closed**: `LimiterUnavailableError`, which
 *   the platform answers `503` with no code. There is no permissive fallback (SECURITY_DESIGN.md §14.12).
 * - **The authenticated-API bucket is not applied here.** It is keyed on the *active* session, which exists only once the session has
 *   been looked up; keyed on a credential that has not been verified it would let any caller invent keys and fill the table
 *   (plan §7.16, finding on step 1). The authentication guard (S0.24) applies it, right after the session is found and before
 *   CSRF, authorization and validation.
 *
 * It runs after the declaration guard and before the authentication slot, and it calls the limiter with no transaction of the
 * request's open (a guard runs before any handler does), which the limiter requires.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Optional() @Inject(RATE_LIMITER) private readonly limiter: RateLimiter | undefined,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Only `Anonymous(limit)` puts a limit in the detail, so a route that names a bucket is a pre-authentication one.
    const limit = accessDetailOf(this.reflector, context)?.limit;
    if (limit === undefined) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const raw = boundedIdentifier(request, limit.identifier);
    const key = raw === undefined ? undefined : limit.canonical(raw);
    if (key === undefined) return true;

    if (this.limiter === undefined) throw new LimiterUnavailableError();
    const decision = await this.limiter.admit(limit.bucket, key);
    if (!decision.allowed) throw ApiException.of(ErrorCode.RateLimited, 'Too many requests');
    return true;
  }
}
