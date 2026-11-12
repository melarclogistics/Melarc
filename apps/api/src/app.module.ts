import { Logger, Module, type DynamicModule } from '@nestjs/common';

import { PostgresAuditWriter } from './platform/audit/postgres.audit-writer.adapter.js';
import { InProcessEvidenceStore } from './platform/evidence/in-process.evidence-store.adapter.js';
import { fetchTransport, R2EvidenceStore } from './platform/evidence/r2.evidence-store.adapter.js';
import { ServiceAttestationVerifier } from './platform/auth/attestation/service.attestation-verifier.adapter.js';
import { SubstituteAttestationVerifier } from './platform/auth/attestation/substitute.attestation-verifier.adapter.js';
import { SystemClock } from './platform/auth/clock/system.clock.adapter.js';
import { DESCRIBE_PORT_BINDINGS } from './platform/auth/describe/describe-ports.adapter.js';
import {
  assertNoDescribeAdapterWritten,
  portBindingCheck,
} from './platform/auth/describe/port-binding-check.js';
import { LimiterDigest } from './platform/auth/crypto/limiter-digest.js';
import { Sha256TokenService } from './platform/auth/crypto/sha256.token-service.adapter.js';
import { AesGcmSecretCipher } from './platform/auth/crypto/aes-gcm.secret-cipher.adapter.js';
import { Argon2Hasher } from './platform/auth/crypto/argon2.hasher.adapter.js';
import { Rfc6238TotpVerifier } from './platform/auth/crypto/rfc6238.totp-verifier.adapter.js';
import { RoutedIdentityDirectory } from './platform/auth/directory/routed.identity-directory.adapter.js';
import { CLOCK, type Clock } from './platform/auth/ports/clock.port.js';
import { METRICS, type Metrics } from './platform/auth/ports/metrics.port.js';
import { portProviders, type PortBindings } from './platform/auth/ports/port-bindings.js';
import { SECRET_CIPHER, type SecretCipher } from './platform/auth/ports/secret-cipher.port.js';
import { PostgresSessionStore } from './platform/auth/sessions/postgres.session-store.adapter.js';
import { assertAdaptersAllowed } from './platform/config/adapter-refusals.js';
import type { AppConfig } from './platform/config/load-config.js';
import { DatabaseService } from './platform/database/database.service.js';
import { PostgresUnitOfWork } from './platform/database/postgres.unit-of-work.adapter.js';
import { PostgresDeliveryQueue } from './platform/delivery/postgres.delivery-queue.adapter.js';
import { PostgresIdempotencyStore } from './platform/idempotency/postgres.idempotency-store.adapter.js';
import { SettingsBucketLimits } from './platform/limiter/bucket-limits.js';
import {
  BoundedHashAdmission,
  libuvThreadpoolSize,
  planHashAdmission,
} from './platform/limiter/bounded.hash-admission.adapter.js';
import { PostgresRateLimiter } from './platform/limiter/postgres.rate-limiter.adapter.js';
import { BoundedMetrics } from './platform/metrics/bounded.metrics.adapter.js';
import { labelPolicyFor } from './platform/metrics/metric-catalogue.js';
import { PlatformModule, type PlatformModuleOptions } from './platform/platform.module.js';
import { SettingsReader } from './platform/settings/settings-reader.js';
import { BUILD_FIXED_POLICY } from './platform/auth/sessions/build-fixed-policy.js';
import { DispatchModule } from './dispatch/dispatch.module.js';
import { DomainPortsModule } from './domain-ports.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { FleetModule } from './fleet/fleet.module.js';
import { PickupModule } from './pickup/pickup.module.js';
import { PermissionModule } from './permission/permission.module.js';
import { PostgresRiderIdentityDirectory } from './staff/postgres.rider-identity-directory.adapter.js';
import { PostgresStaffIdentityDirectory } from './staff/postgres.staff-identity-directory.adapter.js';
import { PostgresVendorAccountDirectory } from './vendor/postgres.vendor-account-directory.adapter.js';
import { SettingsModule } from './settings/settings.module.js';
import { StaffModule } from './staff/staff.module.js';
import { VendorModule } from './vendor/vendor.module.js';

/** Where the metrics registry says that it dropped a sample (a defect in code that counts, never a value). */
const metricsLogger = new Logger('Metrics');

export interface AppModuleOptions extends PlatformModuleOptions {
  /**
   * The adapters bound to the ports of `platform/auth`, keyed by port. A binding here replaces the describe adapter of that
   * port when the application is composed to be described, and is the only binding there is in the runtime composition. The
   * task that builds an adapter adds its binding here, and no file outside the composition root listed in
   * `src/architecture.test.ts` imports the adapter (SOLUTION_ARCHITECTURE.md §5).
   */
  readonly ports?: PortBindings;
}

/**
 * The real adapters the runtime composition binds itself, whatever the options say. Every other port is bound by the first task
 * that consumes it (OB-38), by adding its binding here. `options.ports` still replaces any of them, which is how a test supplies a
 * clock it controls.
 *
 * - **Always:** the production `Clock` (S0.6), which the deadline machinery of the database layer reads, and the SHA-256
 *   `TokenService` (S0.24), which needs no key and no database.
 * - **With a database (S0.24):** the `UnitOfWork`, the `SessionStore`, the staff `IdentityDirectory` and the `AuditWriter`, which
 *   the authentication guard, the policy coordinator and the session-issue protocol are built from (`sessionProviders`). Without a
 *   database none is bound, and the services built from them are absent: a credential is then `503` and nobody can be signed in.
 * - **With a database and local key custody (S0.29):** the `SecretCipher` (serving the TOTP seed and the delivery payload) and the issuing
 *   side of the `DeliveryQueue`, which the stores of MFA factors and of setup grants are built from (`mfaProviders`,
 *   `setupGrantProviders`). A configuration without a database or without local key material binds neither and has neither store.
 * - **With a database and local key custody (S0.31):** the Argon2id `Hasher` (the password pepper must be held: a missing one stops the
 *   application at start, with no degraded mode), the bounded `HashAdmission` (the slots the configuration states, fitted to the memory
 *   budget and to the libuv pool the process has) and the RFC 6238 `TotpVerifier`, which the three credential setup operations are built
 *   from (`staffSetupProviders`). Where any is missing the service is absent and its routes fail closed (`503`).
 * - **The limiter (S0.22) is bound only where it can be built and is the one the configuration asks for**: `RATE_LIMITER=postgres`,
 *   a database to decide in, and key material to digest the identifiers under (`limiter_digest`). `RATE_LIMITER=memory` is for a
 *   local run and for unit tests and is never bound by the composition itself (a test supplies it through `ports`): the in-memory
 *   limiter resets on restart and multiplies each bucket by the number of instances, so nothing falls back to it. Where no limiter is
 *   bound, a route that names a bucket fails closed (`rate-limit.guard.ts`) and so does an authenticated one
 *   (`authentication.guard.ts`). A key purpose that is missing stops the application at start.
 */
function runtimePortBindings(config: AppConfig): PortBindings {
  const verifier = config.adapters.attestationVerifier;
  const evidence = config.adapters.evidenceStore;
  const bindings: PortBindings = {
    clock: { useClass: SystemClock },
    tokenService: { useClass: Sha256TokenService },
    // The metrics registry (S0.56; the first consumer is the attestation verifier adapter, OB-38): bounded labels, a sample outside the
    // catalogue throws in development and test and is dropped, counted and diagnosed in production. Nothing serves it yet (S0.68).
    // It reads the system clock itself and injects no port: its only use of time is the spacing of its own diagnostics, and a test that
    // controls the Clock must not make this a request-scoped provider by propagation.
    metrics: {
      useFactory: () =>
        new BoundedMetrics({
          policy: labelPolicyFor(config.nodeEnv),
          clock: new SystemClock(),
          onDiagnostic: (diagnostic) => {
            metricsLogger.warn(JSON.stringify(diagnostic));
          },
        }),
    },
    // The substitute attestation verifier (S0.54) is the one the configuration may select for a local run and for staging (production refuses
    // it, `adapter-refusals.ts`); it holds no state and needs no database. The production adapter asks the private verifier service over
    // HTTP (S0.56) and is the only one a production configuration can select.
    attestationVerifier:
      verifier.kind === 'substitute'
        ? { useFactory: () => new SubstituteAttestationVerifier() }
        : {
            useFactory: (metrics: Metrics) =>
              new ServiceAttestationVerifier({
                url: verifier.url,
                timeoutMs: verifier.timeoutMs,
                ...(verifier.callerSecret === undefined
                  ? {}
                  : { callerSecret: verifier.callerSecret }),
                metrics,
              }),
            inject: [METRICS],
          },
    // The object store of the evidence records (S1.11): the in-process stand-in that a local run and CI select (production refuses it, `adapter-refusals.ts`), or Cloudflare R2, whose
    // credential is the `Secret` of the configuration. No environment selects R2 until the owner provides a bucket; nothing here calls the network until one does.
    evidenceStore:
      evidence.kind === 'in-process'
        ? { useFactory: () => new InProcessEvidenceStore() }
        : {
            useFactory: () =>
              new R2EvidenceStore({
                accountId: evidence.accountId,
                bucket: evidence.bucket,
                accessKeyId: evidence.accessKeyId,
                secretAccessKey: evidence.secretAccessKey,
                transport: fetchTransport,
              }),
          },
    ...(config.database === undefined
      ? {}
      : {
          unitOfWork: {
            useFactory: (database: DatabaseService) => new PostgresUnitOfWork(database),
            inject: [DatabaseService],
          },
          sessionStore: {
            useFactory: (clock: Clock) => new PostgresSessionStore(clock),
            inject: [CLOCK],
          },
          // Each audience's directory is its domain's; the platform is given one port over them (S0.47).
          identityDirectory: {
            useFactory: () =>
              new RoutedIdentityDirectory({
                STAFF: new PostgresStaffIdentityDirectory(),
                VENDOR: new PostgresVendorAccountDirectory(),
                RIDER: new PostgresRiderIdentityDirectory(),
              }),
          },
          auditWriter: {
            useFactory: (clock: Clock) => new PostgresAuditWriter(clock),
            inject: [CLOCK],
          },
        }),
  };
  if (config.database === undefined || config.keys.custody !== 'local') return bindings;
  const { keys } = config;
  // The first consumers of the secret cipher and of the issuing side of the delivery queue (S0.29; OB-38, OB-107): the MFA factor store
  // seals a TOTP seed and the setup grant store queues the message that carries a grant. The API's cipher serves those two purposes
  // and the sealed replay of an idempotent answer, which `registerRiderDevice` alone keeps (S0.53b: the store refuses a seal for any
  // other operation); the worker holds the delivery key under a cipher of its own (`delivery-worker-runtime.ts`).
  const withCredentials: PortBindings = {
    ...bindings,
    secretCipher: {
      useFactory: () =>
        new AesGcmSecretCipher(keys, {
          serves: ['TOTP_SEED', 'DELIVERY_PAYLOAD', 'REPLAY_SECRET'],
        }),
    },
    deliveryQueue: {
      useFactory: (cipher: SecretCipher, clock: Clock) =>
        new PostgresDeliveryQueue({ cipher, clock }),
      inject: [SECRET_CIPHER, CLOCK],
    },
    // The first consumer of the idempotency store (S0.36, `createStaffIdentity`; OB-38). It is built on the API's cipher, which serves the
    // TOTP seed and the delivery payload and, since S0.53b, the sealed replay of the one operation that replays a secret.
    idempotencyStore: {
      useFactory: (cipher: SecretCipher, clock: Clock) =>
        new PostgresIdempotencyStore(cipher, clock),
      inject: [SECRET_CIPHER, CLOCK],
    },
    // The first consumers of the hasher, the hash admission and the TOTP verifier (S0.31; OB-38): the credential setup operations.
    hasher: {
      useFactory: () =>
        new Argon2Hasher(
          keys,
          config.credentialHashing.profile,
          config.credentialHashing.acceptedProfiles,
        ),
    },
    hashAdmission: {
      useFactory: () => {
        const threadpoolSize = libuvThreadpoolSize(process.env);
        const plan = planHashAdmission({
          hashAdmission: config.hashAdmission,
          credentialHashing: config.credentialHashing,
          threadpoolSize,
        });
        return new BoundedHashAdmission({ slots: plan.slots, threadpoolSize });
      },
    },
    totpVerifier: {
      useFactory: (clock: Clock) => new Rfc6238TotpVerifier(clock),
      inject: [CLOCK],
    },
  };
  if (config.adapters.limiter !== 'postgres') return withCredentials;
  return {
    ...withCredentials,
    rateLimiter: {
      useFactory: (clock: Clock, database: DatabaseService) =>
        new PostgresRateLimiter({
          database,
          digest: new LimiterDigest(keys),
          limits: new SettingsBucketLimits(new SettingsReader()),
          clock,
        }),
      inject: [CLOCK, DatabaseService],
    },
  };
}

/** The fixed-policy revision this build is compiled for: declared in one place (`build-fixed-policy.ts`), which the seed reads too. */
export { BUILD_FIXED_POLICY };

/** `base` with every defined binding of `over` laid on it. An explicit `undefined` means no binding and replaces nothing. */
function overlay(base: PortBindings, over: PortBindings = {}): PortBindings {
  // What arrives may not be what the compiler promised, so each value is read as unknown before it is judged.
  const given: [string, unknown][] = Object.entries(over);
  const defined = given.filter(([, binding]) => binding !== undefined);
  return { ...base, ...(Object.fromEntries(defined) as PortBindings) };
}

/**
 * The root of the module graph and the composition root: the one place where adapters are bound to the injection tokens of the
 * ports. A platform service asks for a token and never imports an adapter; a domain module implements its persistence adapter
 * and the root binds it. Domain modules are imported here as product slices add them, as siblings of platform/
 * (SOLUTION_ARCHITECTURE.md §5). There are none yet; the only business routes are the three credential setup operations of
 * `platform/auth/staff/` (S0.31), which the platform module registers and `productRoutes: false` leaves out of a test composition.
 *
 * **Two compositions.** When the configuration selects `describe` (the OpenAPI generator, the contract check, the default test
 * application) every port resolves to an inert describe adapter, so the application can be built and described with no
 * database, provider or key. When it selects `runtime` the adapters of `runtimePortBindings` are bound (the production `Clock`, the
 * token service and, with a database, the unit of work, the session store, the staff identity directory, the audit writer and the
 * PostgreSQL rate limiter), and every other port stays unbound until the first task that consumes it adds its real adapter. The configuration
 * is checked first: an environment that refuses what the configuration selects (the describe composition outside a local
 * run, a test adapter in production) stops the application here, whichever way the configuration was made. **The bindings
 * are checked too, not only the mode:** the runtime composition refuses an inert describe adapter however it is supplied
 * (`useClass`, `useValue`, a factory, `useExisting`), the written forms here and every form again when the application
 * initialises (`port-binding-check.ts`). That keeps a mis-wired root from answering a request with a describe failure; it
 * is a wiring check, not a defence against code that is already running inside the application.
 *
 * **Every port binding is an application singleton, in both compositions.** A request or transient lifetime is refused when
 * the binding is registered, and what the container makes of a binding (a class whose metadata is request-scoped, an alias or
 * a factory that reaches a request-scoped provider, a constructor that injects one) is judged by the container's own record
 * of each port once it is built, before the application listens. The check injects no port, so a scoped binding cannot keep
 * it from judging another one.
 *
 * **It is global on purpose, and its reach is the port tokens and nothing else.** A platform service and a domain module both ask
 * for a port by its token, and neither may import the module that binds it, so the bound tokens have to be visible everywhere.
 * `exports` is exactly the tokens bound (an empty list when none is), and the platform it imports re-exports
 * nothing through it. `src/app.module.test.ts` pins that, so widening what this module offers every module is a visible change.
 * The module graph is otherwise unchanged: a domain module is imported here, exports its adapter, and the root binds it with
 * `useExisting`.
 */
@Module({})
export class AppModule {
  static register(options: AppModuleOptions): DynamicModule {
    assertAdaptersAllowed(options.config);
    const describing = options.config.composition === 'describe';
    const bound = portProviders(
      overlay(
        describing ? DESCRIBE_PORT_BINDINGS : runtimePortBindings(options.config),
        options.ports,
      ),
    );
    // The describe composition binds inert adapters on purpose; the runtime composition must not end up with one, so the
    // bindings it was given are judged here. Both compositions require every port to be an application singleton. What the
    // container made of the bindings (an alias, a factory, a dependency) is judged once it has built them, when the
    // application initialises and before it listens.
    if (!describing) assertNoDescribeAdapterWritten(bound);
    const check = portBindingCheck(bound, describing ? 'describe' : 'runtime');
    return {
      module: AppModule,
      global: true,
      // The domain modules (S0.35: `settings` first), whose routes are the product's and are left out with the platform's by
      // `productRoutes: false`: a test that brings its own routes and contract composes the application without them.
      imports: [
        PlatformModule.register({
          ...options,
          compiledFixedPolicy: options.compiledFixedPolicy ?? BUILD_FIXED_POLICY,
        }),
        ...(options.productRoutes === false
          ? []
          : [
              DispatchModule,
              DomainPortsModule,
              FleetModule,
              NotificationsModule,
              PermissionModule,
              PickupModule,
              SettingsModule,
              StaffModule,
              VendorModule,
            ]),
      ],
      providers: check === undefined ? bound : [...bound, check],
      exports: bound.map((provider) => provider.provide),
    };
  }
}
