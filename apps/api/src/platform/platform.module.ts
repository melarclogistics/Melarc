import { Global, Module, type DynamicModule } from '@nestjs/common';
import type { Logger } from 'pino';

import type { AppConfig } from './config/load-config.js';
import { ContractValidationModule } from './contract/contract-validation.module.js';
import { fileContractSource, type ContractSource } from './contract/contract-source.js';
import { DatabaseModule } from './database/database.module.js';
import type { CompiledFixedPolicy } from './auth/sessions/session-authority.js';
import {
  COMPILED_FIXED_POLICY,
  POLICY_COORDINATOR,
  SESSION_ISSUER,
  sessionProviders,
} from './auth/sessions/session-providers.js';
import { csrfProviders } from './auth/csrf/csrf-providers.js';
import {
  OPERATION_CONTEXTS,
  OPERATION_RUNNER,
  authorizationProviders,
} from './authorization/authorization-providers.js';
import {
  VENDOR_ORGANIZATION_RESOLVER,
  type VendorOrganizationResolver,
} from './authorization/operation-contexts.js';
import {
  RECORD_ENTITIES,
  RECORD_ENTITIES_TOKEN,
  type RecordEntities,
} from './authorization/record-scope.js';
import { TIER_RULES, TIER_RULES_TOKEN, type TierRules } from './authorization/tier-policy.js';
import { HealthModule } from './health/health.module.js';
import { NotFoundFallback } from './http/not-found-fallback.js';
import { LifecycleService } from './lifecycle/lifecycle.service.js';
import { ShutdownRegistry } from './lifecycle/shutdown.registry.js';
import { APP_CONFIG, LOGGER } from './platform.tokens.js';
import { guardChainProviders } from './routes/guard-chain.js';

export interface PlatformModuleOptions {
  readonly config: AppConfig;
  readonly logger: Logger;
  /** Where the contract is read from when a handler is bound to an operation. Defaults to the repository's file. */
  readonly contractSource?: ContractSource;
  /**
   * The fixed-policy revision of this build for each audience that has one (SECURITY_DESIGN.md §13.10). None by default: the
   * tasks that build the Vendor and Rider sign-ins declare theirs where the application is composed.
   */
  readonly compiledFixedPolicy?: CompiledFixedPolicy;
  /**
   * The entities a route may name as the record it addresses (`RecordScope`), and so the tables the authorization step looks in
   * before the body is validated. A slice that adds such a table adds it to `RECORD_ENTITIES`; a test composes its own.
   */
  readonly recordEntities?: RecordEntities;
  /**
   * The rules that derive what a target needs from its own record (`TIER_RULES`, step 6 of the refusal order), by the name a route
   * gives them. A slice that adds a rule adds it there; a test composes its own.
   */
  readonly tierRules?: TierRules;
  /** Where a Vendor session's organisation comes from. The vendor domain supplies it (S0.47); none is composed before then. */
  readonly vendorOrganization?: VendorOrganizationResolver;
}

/**
 * Cross-cutting technical services every module may use. Nothing in platform/ may depend on a domain
 * module (SOLUTION_ARCHITECTURE.md §5); the direction is domain -> platform only.
 */
@Global()
@Module({})
export class PlatformModule {
  static register(options: PlatformModuleOptions): DynamicModule {
    const { database } = options.config;
    return {
      module: PlatformModule,
      imports: [
        HealthModule,
        ContractValidationModule.register({ source: options.contractSource ?? fileContractSource }),
        ...(database === undefined ? [] : [DatabaseModule.register(database)]),
      ],
      providers: [
        { provide: APP_CONFIG, useValue: options.config },
        { provide: LOGGER, useValue: options.logger },
        { provide: COMPILED_FIXED_POLICY, useValue: options.compiledFixedPolicy ?? {} },
        { provide: RECORD_ENTITIES_TOKEN, useValue: options.recordEntities ?? RECORD_ENTITIES },
        { provide: TIER_RULES_TOKEN, useValue: options.tierRules ?? TIER_RULES },
        ...(options.vendorOrganization === undefined
          ? []
          : [{ provide: VENDOR_ORGANIZATION_RESOLVER, useValue: options.vendorOrganization }]),
        // The guard chain, in the refusal order (S0.22): declaration, rate limit, authentication, CSRF and Origin, authorization.
        ...guardChainProviders,
        // The coordinator of policy-locked operations, the authenticator and the session-issue protocol (S0.24), each built from the
        // ports the composition root bound and absent where one is missing.
        ...sessionProviders,
        // The recorder of rejected CSRF and Origin checks (S0.25), which the CSRF guard asks for.
        ...csrfProviders,
        // The record scope resolver, the context builder, the operation runner and the activity interceptor (S0.26).
        ...authorizationProviders,
        NotFoundFallback,
        LifecycleService,
        ShutdownRegistry,
      ],
      exports: [
        APP_CONFIG,
        LOGGER,
        LifecycleService,
        ShutdownRegistry,
        // What the sign-in operations of the tasks after this one inject; the authenticator is the guard's and stays inside.
        POLICY_COORDINATOR,
        SESSION_ISSUER,
        // What a use case asks for to run its transaction under the context its authorization decided (S0.26).
        OPERATION_RUNNER,
        OPERATION_CONTEXTS,
      ],
    };
  }
}
