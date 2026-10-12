import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { ApiException } from '../http/api-exception.js';
import { ErrorCode } from '../http/error-codes.js';
import { accessKindOf } from './access-kind.js';

/**
 * Steps 4 to 7 of the refusal order: the surface gate, the permission, the tier and the hub scope. **It fails closed until S0.26
 * replaces it**: a route that needs a principal is refused `403 PERMISSION_DENIED` (the default when no permission matches,
 * errors-and-enums.md §4). While authentication fails closed too, no request reaches it; it exists so that building S0.24 cannot
 * make a declared route servable before the authorization it needs has been built.
 */
@Injectable()
export class AuthorizationGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const kind = accessKindOf(this.reflector, context);
    if (kind !== 'self' && kind !== 'permission') return true;
    throw new ApiException(ErrorCode.PermissionDenied, 403, 'Permission denied');
  }
}
