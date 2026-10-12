import type { Provider } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { UNIT_OF_WORK, type UnitOfWork } from '../auth/ports/unit-of-work.port.js';
import { POLICY_COORDINATOR } from '../auth/sessions/session-providers.js';
import type { PolicyCoordinator } from '../database/policy-lock/coordinate.js';
import {
  OperationContexts,
  VENDOR_ORGANIZATION_RESOLVER,
  type VendorOrganizationResolver,
} from './operation-contexts.js';
import { OperationRunner } from './operation-runner.js';
import { RECORD_ENTITIES_TOKEN, RecordScopeResolver, type RecordEntities } from './record-scope.js';
import { SessionActivityInterceptor } from './session-activity.interceptor.js';
import { TIER_RULES_TOKEN, type TierRules } from './tier-policy.js';

/** The injection tokens of what a use case and the authorization guard ask the platform for (S0.26). */
export const RECORD_SCOPE_RESOLVER = Symbol('RECORD_SCOPE_RESOLVER');
export const OPERATION_CONTEXTS = Symbol('OPERATION_CONTEXTS');
export const OPERATION_RUNNER = Symbol('OPERATION_RUNNER');

const optional = (token: symbol) => ({ token, optional: true });

/**
 * The authorization machinery as the platform provides it (S0.26), each built from the ports the composition root bound and
 * `undefined` where one is missing, as the session services are: an application composed without a database has no resolver of a
 * record's scope and no runner of an operation, and a route that needs one fails closed (`503`) and never falls back to a
 * stand-in. The activity interceptor is registered here, **before** the contract validation of the module the platform imports, so
 * that it wraps it and the validation failure of an authorized action counts as activity.
 */
export const authorizationProviders: readonly Provider[] = [
  { provide: APP_INTERCEPTOR, useClass: SessionActivityInterceptor },
  {
    provide: RECORD_SCOPE_RESOLVER,
    useFactory: (
      unitOfWork: UnitOfWork | undefined,
      entities: RecordEntities,
      tierRules: TierRules,
    ): RecordScopeResolver | undefined =>
      unitOfWork === undefined
        ? undefined
        : new RecordScopeResolver({ unitOfWork, entities, tierRules }),
    inject: [optional(UNIT_OF_WORK), RECORD_ENTITIES_TOKEN, TIER_RULES_TOKEN],
  },
  {
    provide: OPERATION_CONTEXTS,
    useFactory: (vendorOrganization: VendorOrganizationResolver | undefined): OperationContexts =>
      new OperationContexts(vendorOrganization),
    inject: [optional(VENDOR_ORGANIZATION_RESOLVER)],
  },
  {
    provide: OPERATION_RUNNER,
    useFactory: (
      coordinator: PolicyCoordinator | undefined,
      unitOfWork: UnitOfWork | undefined,
      contexts: OperationContexts,
      tierRules: TierRules,
    ): OperationRunner | undefined =>
      coordinator === undefined || unitOfWork === undefined
        ? undefined
        : new OperationRunner({ coordinator, unitOfWork, contexts, tierRules }),
    inject: [POLICY_COORDINATOR, optional(UNIT_OF_WORK), OPERATION_CONTEXTS, TIER_RULES_TOKEN],
  },
];
