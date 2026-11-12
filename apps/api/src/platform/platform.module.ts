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
import { MFA_CHALLENGE_STORE, MFA_FACTOR_STORE, mfaProviders } from './auth/mfa/mfa-providers.js';
import { StaffSetupController } from './auth/staff/staff-setup.controller.js';
import { RiderEnrolmentController } from './auth/rider/rider-enrolment.controller.js';
import { riderEnrolmentProviders } from './auth/rider/rider-enrolment-providers.js';
import { RiderSignInController } from './auth/rider/rider-sign-in.controller.js';
import { riderSignInProviders } from './auth/rider/rider-sign-in-providers.js';
import { SessionController } from './auth/sessions/session.controller.js';
import { sessionOperationsProviders } from './auth/sessions/session-operations-providers.js';
import { StaffMfaSignInController } from './auth/staff/staff-mfa-sign-in.controller.js';
import { staffMfaSignInProviders } from './auth/staff/staff-mfa-sign-in-providers.js';
import { StaffSignInController } from './auth/staff/staff-sign-in.controller.js';
import { staffSignInProviders } from './auth/staff/staff-sign-in-providers.js';
import { staffSetupProviders } from './auth/staff/staff-setup-providers.js';
import { VendorSetupController } from './auth/vendor/vendor-setup.controller.js';
import { VendorSignInController } from './auth/vendor/vendor-sign-in.controller.js';
import { VendorDevicesController } from './auth/vendor/devices/vendor-devices.controller.js';
import { vendorDevicesProviders } from './auth/vendor/devices/vendor-devices-providers.js';
import { vendorSignInProviders } from './auth/vendor/vendor-sign-in-providers.js';
import { limitPartitionsProviders } from './auth/limit-partitions-providers.js';
import { CredentialRecoveryController } from './auth/recovery/credential-recovery.controller.js';
import {
  ADMINISTRATOR_RECOVERIES,
  RECOVERY_REQUEST_STORE,
  recoveryProviders,
} from './auth/recovery/recovery-providers.js';
import { vendorSetupProviders } from './auth/vendor/vendor-setup-providers.js';
import { TrustedBrowserController } from './auth/trusted-browsers/trusted-browser.controller.js';
import {
  TRUSTED_BROWSER_STORE,
  trustedBrowserProviders,
} from './auth/trusted-browsers/trusted-browser-providers.js';
import {
  SETUP_GRANT_STORE,
  setupGrantProviders,
} from './auth/setup-grants/setup-grant-providers.js';
import {
  OPERATION_CONTEXTS,
  OPERATION_RUNNER,
  RECORD_SCOPE_RESOLVER,
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
import { EvidenceController } from './evidence/evidence.controller.js';
import { evidenceProviders } from './evidence/evidence-providers.js';
import { RecordLookupController } from './lookup/record-lookup.controller.js';
import { recordLookupProviders } from './lookup/record-lookup-providers.js';
import { QueueSummaryController } from './queue-summary/queue-summary.controller.js';
import { queueSummaryProviders } from './queue-summary/queue-summary-providers.js';
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
  /**
   * Whether the routes of the product contract are served (S0.31 adds the first). They are by default. A test that brings routes of its
   * own and a contract of its own composes the application without them (`appWith`), because a route of the product bound to an
   * operation its contract does not hold is refused at start. The real application never turns them off.
   */
  readonly productRoutes?: boolean;
  /**
   * Where a Vendor session's organisation comes from. By default the vendor domain's directory answers it (S0.47,
   * `vendorOrganizationFromDirectory`); a test may compose its own.
   */
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
      // The routes of the product contract: the three credential setup operations (S0.31), the rider's enrolment (S0.57), challenge and
      // sign-in (S0.59), the staff sign-in (S0.32), its second step (S0.33), the read and the end of the caller's own session (S0.34), and the list and the removal of the caller's own
      // trusted browsers (staff-authentication.md section 5.8), and the count of the work waiting in each queue the session may read (task C1).
      controllers:
        options.productRoutes === false
          ? []
          : [
              StaffSetupController,
              VendorSetupController,
              VendorSignInController,
              VendorDevicesController,
              RiderEnrolmentController,
              RiderSignInController,
              StaffSignInController,
              StaffMfaSignInController,
              SessionController,
              TrustedBrowserController,
              CredentialRecoveryController,
              QueueSummaryController,
              RecordLookupController,
              EvidenceController,
            ],
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
        // The stores of setup grants and MFA factors (S0.29), each built from the ports the composition root bound and absent where
        // one is missing.
        ...setupGrantProviders,
        ...mfaProviders,
        // The store of trusted browsers and the operations on the caller's own (staff-authentication.md section 5.8).
        ...trustedBrowserProviders,
        // The service of the credential setup operations (S0.31), built from the ports above and absent where one is missing.
        ...staffSetupProviders,
        // The vendor's registered browsers and its credential setup (S0.47b), and its sign-in with the partition of its limit (S0.48).
        ...vendorSetupProviders,
        ...vendorSignInProviders,
        // The partitions of the anonymous limits: the vendor sign-in's (S0.48) and the recovery request's (S0.50).
        ...limitPartitionsProviders,
        // The store of recovery requests and the self-service request (S0.50).
        ...recoveryProviders,
        // The vendor's own browsers: the grant of another, its completion, the list and the revocation (S0.49).
        ...vendorDevicesProviders,
        // The rider's devices and the completion of their enrolment, which evaluates the handset's attestation (S0.57).
        ...riderEnrolmentProviders,
        // The rider's challenge and sign-in (S0.59), on the device store above.
        ...riderSignInProviders,
        // The service of the staff sign-in (S0.32), built from the same ports and absent where one is missing.
        ...staffSignInProviders,
        // The service of the second step of a privileged sign-in (S0.33).
        ...staffMfaSignInProviders,
        // The record scope resolver, the context builder, the operation runner and the activity interceptor (S0.26).
        ...authorizationProviders,
        // The service of the read and the end of the caller's own session (S0.34), built on the runner above.
        ...sessionOperationsProviders,
        // The service of the count of each queue the session may read (task C1), built on the runner above and the counters the domains own.
        ...queueSummaryProviders,
        // The service of the lookup of a record by its code, a name or a phone number (task C2), built on the runner above and the sources the domains own.
        ...recordLookupProviders,
        // The service of the three evidence operations (S1.11), built on the runner above, the idempotency store and the object-store port the composition root bound.
        ...evidenceProviders,
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
        // What the credential operations of the tasks after this one inject: the stores of grants and of factors (S0.29).
        SETUP_GRANT_STORE,
        MFA_FACTOR_STORE,
        MFA_CHALLENGE_STORE,
        // What the sign-ins, the reset and the enrolment ask for to make, use and end a trusted browser.
        TRUSTED_BROWSER_STORE,
        // What an administrator's recovery asks for to issue a link or coalesce onto one (S0.51b).
        RECOVERY_REQUEST_STORE,
        ADMINISTRATOR_RECOVERIES,
        // What a use case asks for to run its transaction under the context its authorization decided (S0.26).
        OPERATION_RUNNER,
        OPERATION_CONTEXTS,
        // What a use case asks when the record it acts on is named by a query and not by the path (the list of sessions, S0.37).
        RECORD_SCOPE_RESOLVER,
      ],
    };
  }
}
