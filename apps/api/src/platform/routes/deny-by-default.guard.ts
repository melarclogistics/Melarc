import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { ApiException } from '../http/api-exception.js';
import { ErrorCode } from '../http/error-codes.js';
import { ACCESS_DECLARATION_KEY, type AccessDeclaration } from './access-declaration.js';

/**
 * The first link of the guard chain (SOLUTION_ARCHITECTURE.md §6): a route that declares no access
 * is refused, never permitted by framework default (SECURITY_DESIGN.md; engineering-standards.md §7).
 * The route inventory test is the mechanical half of the same rule.
 */
@Injectable()
export class DenyByDefaultGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const declaration = this.reflector.getAllAndOverride<AccessDeclaration | undefined>(
      ACCESS_DECLARATION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (declaration === 'technical') return true;
    throw new ApiException(ErrorCode.PermissionDenied, 403, 'Permission denied');
  }
}
