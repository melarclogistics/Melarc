import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { ApiException } from '../http/api-exception.js';
import { ErrorCode } from '../http/error-codes.js';
import { accessKindOf } from './access-kind.js';

/**
 * The first link of the guard chain (SOLUTION_ARCHITECTURE.md §6; `AC-SLICE-000-25`): a route that declares no access is refused,
 * never permitted by framework default (SECURITY_DESIGN.md; engineering-standards.md §7). It judges that a declaration exists and
 * nothing more: what each kind then requires is the later links' (the limiter, authentication, CSRF and Origin, authorization). The
 * route inventory test is the mechanical half of the same rule.
 */
@Injectable()
export class DenyByDefaultGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (accessKindOf(this.reflector, context) !== undefined) return true;
    throw new ApiException(ErrorCode.PermissionDenied, 403, 'Permission denied');
  }
}
