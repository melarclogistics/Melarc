import { AppModule } from '../../../src/app.module.js';
import type { AttestationVerifier } from '../../../src/platform/auth/ports/attestation-verifier.port.js';
import type { Metrics } from '../../../src/platform/auth/ports/metrics.port.js';
import type { CompiledFixedPolicy } from '../../../src/platform/auth/sessions/session-authority.js';
import type { VendorOrganizationResolver } from '../../../src/platform/authorization/operation-contexts.js';
import { API_RUNTIME_ROLE, loadConfig } from '../../../src/platform/config/load-config.js';
import type {
  CapturedMessage,
  CaptureSink as DeliveryCaptureSink,
} from '../../../src/platform/delivery/worker/capture-sink.js';
import { validEnv } from '../../../src/test-support/config-env.js';
import {
  createCapture,
  deliverySinkOver,
  type CaptureReader,
  type CaptureSink,
} from '../../../src/test-support/capture.js';
import { Opened } from '../../../src/test-support/cleanup.js';
import { ManualClock } from '../../../src/test-support/manual-clock.js';
import { startTestApp, type TestApp } from '../../../src/test-support/test-app.js';
import { TestClient } from '../../../src/test-support/test-client.js';
import { registerWatch, watchServerFailures } from '../../../src/test-support/failure-evidence.js';
import { traceStatements } from '../../../src/test-support/work-shape.js';
import { openAdmin, type Admin } from './admin.js';
import { observe, type Observer } from './observe.js';
import type { TestDatabase } from './test-database.js';

/**
 * The integration kit (S0.10): the real application, wired as it ships, on a real PostgreSQL database of its own, with the hands a
 * test needs. A test file makes a database (`createTestDatabase`, one per file, migrated, dropped by that file) and starts one
 * of these over it:
 *
 * - `app`, `client`: the application on an ephemeral port, in the runtime composition and connected as `melarc_api_runtime` over a
 *   pool of one (unless the test asks for more), and a `TestClient` for it (cookie jar, CSRF echo, bearer);
 * - `clock`: the `Clock` the application was given, a `ManualClock` the test moves. It is bound through the same `ports` option a
 *   test double always was, in this file's composition only: **no setting and no environment variable of the application turns
 *   it on, and nothing in the production tree imports the kit** (`integration-kit.test.ts` pins both);
 * - `admin`: arranges data the application will never arrange (age a row, change a status, break a write);
 * - `observe`: a second, read-only connection that asserts what the application did;
 * - `capture`: what the delivery adapters in `capture` mode would have sent (a `CapturedMessage`: the setup link, who it was for).
 *   Empty until the capture adapter writes to it, which it does when it is given `deliverySink` (OB-88);
 * - `trace`: the shapes of the statements the application's login sent while some work ran.
 *
 * Several kits can run at once (each has its own database and port); the database project still runs its files one at a time, because
 * the roles are cluster-wide and some tests change them and put them back.
 */
export interface IntegrationKit {
  readonly app: TestApp;
  readonly client: TestClient;
  readonly clock: ManualClock;
  readonly database: TestDatabase;
  readonly admin: Admin;
  readonly observe: Observer;
  readonly capture: CaptureReader<CapturedMessage>;
  readonly captureSink: CaptureSink<CapturedMessage>;
  /** The sink to give a capture delivery adapter (`CaptureDeliveryProvider`): what it writes is what `capture` reads. */
  readonly deliverySink: DeliveryCaptureSink;
  /** Runs `work` and returns it with the statements the application's login sent meanwhile, each reduced to its shape. */
  trace<T>(work: () => Promise<T>): Promise<{ readonly result: T; readonly statements: string[] }>;
  /**
   * Stops the application and closes the connections; the database stays for its file to drop. Every close is attempted whatever
   * the others do, and the failures are reported together (one as itself, several as an `AggregateError`). Calling it again does
   * nothing.
   */
  stop(): Promise<void>;
}

export interface IntegrationOptions {
  /** The clock the application is given. Defaults to a new `ManualClock`. */
  readonly clock?: ManualClock;
  /** The pool of the application. Defaults to one connection. */
  readonly poolMax?: number;
  /** Settings beyond the defaults of `validEnv`; a key mapped to `undefined` is removed. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * The fixed-policy revisions the application is composed with. By default the build's own (`BUILD_FIXED_POLICY`: the Vendor's revision
   * since S0.48 and the Rider's since S0.59); a test of another revision, or of none, gives its own.
   */
  readonly compiledFixedPolicy?: CompiledFixedPolicy;
  /** Where a Vendor session's organisation comes from; by default the vendor domain's own resolver, as the runtime composes it. */
  readonly vendorOrganization?: VendorOrganizationResolver;
  /**
   * A metrics registry bound to the port. The runtime composition of the API binds none until the private metrics endpoint does (S0.68), so
   * an operation that counts (the excluded recovery requests, S0.50) counts nothing there; a test that reads a count gives one.
   */
  readonly metrics?: Metrics;
  /**
   * The attestation verifier the application is given in place of the one its configuration selects (S0.57): a test that counts the calls it
   * makes, or controls the verdicts, supplies one through the same `ports` option a test double always was. The runtime composition binds the
   * substitute for a local configuration and the HTTP adapter for a service one, whatever is said here is this file's composition only.
   */
  readonly attestationVerifier?: AttestationVerifier;
}

export async function startIntegrationKit(
  database: TestDatabase,
  options: IntegrationOptions = {},
): Promise<IntegrationKit> {
  const clock = options.clock ?? new ManualClock();
  const loaded = loadConfig(
    validEnv({
      DATABASE_URL: database.urlFor(API_RUNTIME_ROLE),
      DATABASE_POOL_MAX: String(options.poolMax ?? 1),
      ...options.env,
    }),
  );
  if (!loaded.ok) {
    throw new Error(
      `the kit's configuration was refused: ${loaded.problems.map((problem) => problem.key).join(', ')}`,
    );
  }

  // Everything the kit opens is recorded the moment it is open. A failure part-way closes exactly what is open (last opened first,
  // every close attempted) and reports the failure that caused it; `stop()` closes the same things the same way. The database is
  // the caller's and is never closed or dropped here.
  const opened = new Opened();
  try {
    const app = opened.add(
      'the application',
      await startTestApp({
        config: loaded.config,
        rootModule: (moduleOptions) =>
          AppModule.register({
            ...moduleOptions,
            ports: {
              clock: { useValue: clock },
              ...(options.metrics === undefined ? {} : { metrics: { useValue: options.metrics } }),
              ...(options.attestationVerifier === undefined
                ? {}
                : { attestationVerifier: { useValue: options.attestationVerifier } }),
            },
            ...(options.compiledFixedPolicy === undefined
              ? {}
              : { compiledFixedPolicy: options.compiledFixedPolicy }),
            ...(options.vendorOrganization === undefined
              ? {}
              : { vendorOrganization: options.vendorOrganization }),
          }),
      }),
      (running) => running.stop(),
    );
    const admin = opened.add('the administrator’s connection', await openAdmin(database), (each) =>
      each.close(),
    );
    const reader = opened.add('the observer’s connection', await observe(database), (each) =>
      each.close(),
    );
    const { reader: capture, sink: captureSink } = createCapture<CapturedMessage>();
    const client = new TestClient({ baseUrl: app.baseUrl, now: () => clock.now() });
    opened.add(
      'the server-error watch',
      registerWatch(watchServerFailures(client, app.logs)),
      (forget) => {
        forget();
      },
    );

    return {
      app,
      client,
      clock,
      database,
      admin,
      observe: reader,
      capture,
      captureSink,
      deliverySink: deliverySinkOver(capture, captureSink),
      trace: (work) => traceStatements(API_RUNTIME_ROLE, work),
      stop: () => opened.close(),
    };
  } catch (failure) {
    try {
      await opened.close();
    } catch (closing) {
      throw new AggregateError(
        [
          failure,
          ...(closing instanceof AggregateError ? (closing.errors as unknown[]) : [closing]),
        ],
        'The integration kit failed to start, and closing what it had opened failed too',
        { cause: closing },
      );
    }
    throw failure;
  }
}
