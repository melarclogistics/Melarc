import type { Type } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AuthenticationGuard } from './authentication.guard.js';
import { AuthorizationGuard } from './authorization.guard.js';
import { CsrfGuard } from './csrf.guard.js';
import { DenyByDefaultGuard } from './deny-by-default.guard.js';
import { RateLimitGuard } from './rate-limit.guard.js';

/**
 * The guard chain, in the refusal order of permission-enforcement.md §5.1: **declaration, rate limit, authentication, CSRF and
 * Origin, authorization** (the surface gate, the permission, the tier and the scope). The first refusal wins, so a caller who may
 * not use an operation learns nothing about its schema, and the request validation, the idempotency, version and state steps, and
 * the maker-checker step, which follow the guards, are the interceptor's and the use case's.
 *
 * Nest runs global guards in the order they are registered, so this list is the order, and `guard-chain.test.ts` pins both the list
 * and the registration. Each slot after the limiter exists and fails closed until the task that owns it replaces its body
 * (S0.24, S0.25, S0.26): the chain's shape does not change when they land.
 */
export const GUARD_CHAIN: readonly Type<unknown>[] = [
  DenyByDefaultGuard,
  RateLimitGuard,
  AuthenticationGuard,
  CsrfGuard,
  AuthorizationGuard,
];

/** The chain as the global guards of the application, in order. */
export const guardChainProviders = GUARD_CHAIN.map((useClass) => ({
  provide: APP_GUARD,
  useClass,
}));
