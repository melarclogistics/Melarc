import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { ApiException } from '../http/api-exception.js';
import { ErrorCode } from '../http/error-codes.js';
import { accessKindOf } from './access-kind.js';

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Step 3 of the refusal order: CSRF and Origin (SECURITY_DESIGN.md §13.8; `AC-SLICE-000-130`). **It fails closed until S0.25
 * replaces it**: a request that changes state (anything but a safe method) on a declared route is refused
 * `403 CSRF_VALIDATION_FAILED`, because the exact `Origin` allow-list, the synchronizer token and the credential modes it needs are
 * not built yet, and an operation that cannot be checked is not served. A safe request is not a CSRF risk and passes. S0.25 puts
 * the real check here; the probes are `technical` and never reach it.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const kind = accessKindOf(this.reflector, context);
    if (kind === undefined || kind === 'technical') return true;
    const request = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(request.method)) return true;
    throw new ApiException(ErrorCode.CsrfValidationFailed, 403, 'CSRF validation failed');
  }
}
