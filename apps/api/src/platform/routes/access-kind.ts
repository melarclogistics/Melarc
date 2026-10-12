import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';

import {
  ACCESS_DECLARATION_KEY,
  ACCESS_DETAIL_KEY,
  type AccessDeclaration,
  type AccessDetail,
} from './access-declaration.js';

/** What a route declares, read from the route first and its controller after: the one way the guards of the chain ask. */
export function accessKindOf(
  reflector: Reflector,
  context: ExecutionContext,
): AccessDeclaration | undefined {
  return reflector.getAllAndOverride<AccessDeclaration | undefined>(ACCESS_DECLARATION_KEY, [
    context.getHandler(),
    context.getClass(),
  ]);
}

/** What the declaration adds to its kind (the permission key, the bucket), if it adds anything. */
export function accessDetailOf(
  reflector: Reflector,
  context: ExecutionContext,
): AccessDetail | undefined {
  return reflector.getAllAndOverride<AccessDetail | undefined>(ACCESS_DETAIL_KEY, [
    context.getHandler(),
    context.getClass(),
  ]);
}
