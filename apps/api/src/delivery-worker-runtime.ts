import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DestinationStream, Logger } from 'pino';

import { SystemClock } from './platform/auth/clock/system.clock.adapter.js';
import { AesGcmSecretCipher } from './platform/auth/crypto/aes-gcm.secret-cipher.adapter.js';
import type { Clock } from './platform/auth/ports/clock.port.js';
import type { DeliveryProvider } from './platform/auth/ports/delivery-provider.port.js';
import type { DeliveryChannel } from './platform/auth/ports/delivery-queue.port.js';
import type { DeliveryAdapterConfig } from './platform/config/load-config.js';
import { composeNotificationSender } from './notification-sender.js';
import { HandshakeCodes } from './platform/auth/crypto/handshake-codes.js';
import type { TextMessageSender } from './platform/auth/ports/text-message-sender.port.js';
import { createPool } from './platform/database/database.module.js';
import { DatabaseService } from './platform/database/database.service.js';
import { postgresConnectionSettings } from './platform/database/postgres-url.js';
import { PgStatementCanceller } from './platform/database/statement-canceller.js';
import {
  CAPTURE_CALL_TIMEOUT_MS,
  RETENTION_INTERVAL_MS,
  jobBudgetMsFor,
  leaseMsFor,
} from './platform/delivery/delivery-parameters.js';
import { PostgresDeliveryQueue } from './platform/delivery/postgres.delivery-queue.adapter.js';
import { RetentionCleanup } from './platform/delivery/retention/retention-cleanup.js';
import { retentionTask } from './platform/delivery/retention/retention-task.js';
import { AllowListedDeliveryProvider } from './platform/delivery/worker/allow-listed.delivery-provider.adapter.js';
import { CaptureDeliveryProvider } from './platform/delivery/worker/capture.delivery-provider.adapter.js';
import { FileCaptureSink } from './platform/delivery/worker/capture-sink.js';
import { parseAllowList } from './platform/delivery/worker/delivery-allow-list.js';
import {
  DeliveryWorker,
  workerNameFor,
  type StopReport,
} from './platform/delivery/worker/delivery-worker.js';
import {
  assertOutsideCheckout,
  assertPrivateDirectory,
  type PrivacyProbe,
} from './platform/delivery/worker/outside-checkout.js';
import {
  UNBUILT_REDEMPTION_READER,
  redemptionReaderOver,
  type RedemptionRecordReader,
} from './platform/delivery/worker/redemption-record-reader.js';
import { RecoveryRequestRedemptionReader } from './platform/delivery/worker/recovery-request-redemption-reader.js';
import { SetupGrantRedemptionReader } from './platform/delivery/worker/setup-grant-redemption-reader.js';
import { WorkerJobStore } from './platform/delivery/worker/worker-job-store.js';
import {
  assertWorkerConfigAccepted,
  type WorkerConfig,
} from './platform/delivery/worker/worker-config.js';
import { DISPOSAL_BOUND_MS } from './platform/execution/execution-parameters.js';
import { ReadinessRegistry } from './platform/health/readiness.registry.js';
import {
  createLanePolicy,
  type NotificationSettings,
} from './platform/notifications/lane-policy.js';
import { NotificationLane } from './platform/notifications/notification-lane.js';
import {
  NOTIFICATION_LANE_INTERVAL_MS,
  notificationRunBudgetMs,
} from './platform/notifications/notification-parameters.js';
import {
  DatabaseNotificationSettings,
  DatabaseSettingsReader,
} from './platform/notifications/notification-settings.js';
import { NotificationStore } from './platform/notifications/notification-store.js';
import type { ShutdownOutcome } from './platform/lifecycle/graceful-shutdown.js';
import { ShutdownRegistry, type CloseReport } from './platform/lifecycle/shutdown.registry.js';
import { createServiceLogger } from './platform/logging/create-logger.js';
import { BoundedMetrics } from './platform/metrics/bounded.metrics.adapter.js';
import { labelPolicyFor } from './platform/metrics/metric-catalogue.js';
import { startProcessMetrics } from './platform/metrics/process-metrics.js';

/**
 * The composition root of the delivery worker process (S0.18): the one file that binds the production clock, the database
 * service, the cipher, the queue, the metrics registry and the delivery providers for it, as `app.module.ts` does for the API. It
 * is on the architecture test's list of composition-root files, so the worker's own logic (`platform/delivery/worker/`) imports no
 * adapter.
 *
 * The worker is its own process, and its only inbound listener is the optional private metrics endpoint (S0.68, off unless its port is
 * set). It holds the `credential_delivery` key and no other, connects as
 * `melarc_worker_runtime` and nothing else, and sends only through the capture adapter: **no real provider is built** (the
 * providers are external deployment inputs no document has selected; release gate G3 builds the first), so selecting one is
 * refused at composition, with the setting named, rather than stubbed.
 */

export const WORKER_APPLICATION_NAME = 'melarc-delivery-worker';

/** A real provider was selected, and no provider adapter exists. The message names the setting and never the endpoint. */
export class DeliveryProviderNotBuiltError extends Error {
  constructor(readonly key: string) {
    super(
      `${key} selects a real delivery provider, and no provider adapter is built: the first is a prerequisite of release gate G3.`,
    );
    this.name = 'DeliveryProviderNotBuiltError';
  }
}

export interface ProviderDependencies {
  readonly clock: Clock;
  readonly captureDirectory: string | undefined;
}

/** Builds the provider of one channel from its configuration. */
export type ProviderFactory = (
  channel: DeliveryChannel,
  adapter: DeliveryAdapterConfig,
  dependencies: ProviderDependencies,
) => DeliveryProvider;

/** The capture adapter over the configured sink; a real provider is refused, because none is built. */
export const defaultProviderFactory: ProviderFactory = (
  channel,
  adapter,
  { clock, captureDirectory },
) => {
  if (adapter.kind === 'provider' || captureDirectory === undefined) {
    throw new DeliveryProviderNotBuiltError(`DELIVERY_${channel}_ADAPTER`);
  }
  return new CaptureDeliveryProvider({ sink: new FileCaptureSink(captureDirectory), clock });
};

/**
 * One provider for each channel. A real provider is put behind the recipient allow-list when the controlled window is configured
 * (DEPLOYMENT_AND_ENVIRONMENTS.md §4.1: "enforced by the delivery adapter before any provider call"); the capture adapter reaches
 * nobody and is never put behind it.
 */
export function composeProviders(
  config: WorkerConfig,
  clock: Clock,
  factory: ProviderFactory = defaultProviderFactory,
): Record<DeliveryChannel, DeliveryProvider> {
  const window = config.delivery.providerWindow;
  const allowed = window === undefined ? undefined : parseAllowList(window.allowList.join(','));
  const build = (channel: DeliveryChannel, adapter: DeliveryAdapterConfig): DeliveryProvider => {
    const provider = factory(channel, adapter, {
      clock,
      captureDirectory: config.delivery.captureDirectory,
    });
    return adapter.kind === 'provider' && allowed !== undefined
      ? new AllowListedDeliveryProvider(provider, allowed)
      : provider;
  };
  return { EMAIL: build('EMAIL', config.delivery.email), SMS: build('SMS', config.delivery.sms) };
}

/** The longest one call to each channel's provider may take: its setting, or the capture adapter's own bound. */
export function providerTimeouts(config: WorkerConfig): Record<DeliveryChannel, number> {
  const of = (adapter: DeliveryAdapterConfig): number =>
    adapter.kind === 'provider' ? adapter.timeoutMs : CAPTURE_CALL_TIMEOUT_MS;
  return { EMAIL: of(config.delivery.email), SMS: of(config.delivery.sms) };
}

/** The lease a claim asks for, from the longest call it must outlast, and the budget of the work under it. */
export function leaseFor(timeouts: Record<DeliveryChannel, number>): {
  readonly leaseMs: number;
  readonly jobBudgetMs: number;
} {
  const leaseMs = leaseMsFor(Math.max(timeouts.EMAIL, timeouts.SMS));
  return { leaseMs, jobBudgetMs: jobBudgetMsFor(leaseMs) };
}

/**
 * The worker's cipher: the `credential_delivery` key and no other, because each purpose has its own access policy (SECURITY_DESIGN.md
 * §14.9) and a worker that could open a TOTP seed or a saved answer would hold a power it has no use for, whatever its environment carried.
 */
export function workerCipher(config: WorkerConfig): AesGcmSecretCipher {
  return new AesGcmSecretCipher(config.keys, { serves: ['DELIVERY_PAYLOAD'] });
}

/** Clean only when everything was confirmed: no lease left that could not be given back, and every resource closed. */
export function shutdownOutcome(report: StopReport, closed: CloseReport): ShutdownOutcome {
  return report.unconfirmed === 0 &&
    closed.failed.length === 0 &&
    closed.stalled.length === 0 &&
    closed.unreached.length === 0
    ? 'clean'
    : 'forced';
}

export interface RuntimeOptions {
  /** Where the log goes: stdout by default. */
  readonly destination?: DestinationStream;
  /** Builds a provider; the capture adapter by default. A test gives one, to see what stands in front of it. */
  readonly providerFactory?: ProviderFactory;
  /**
   * How the worker reads a redemption record before it sends. By default the reader of setup grants (S0.29) and of recovery requests
   * (S0.50), over the worker's own database; a record of a kind it cannot read is not confirmed and its message is not sent. A test
   * gives one that answers, to see a message sent, or `UNBUILT_REDEMPTION_READER`, which confirms nothing: the worker then claims no
   * message at all.
   */
  readonly redemptionReader?: RedemptionRecordReader;
  /** The text-message sender of the notification lane; built from the configuration by default (`composeNotificationSender`). */
  readonly notificationSender?: TextMessageSender;
  /** What the notification lane reads of the settings (the switch and the day's limits); the platform settings of the database by default. */
  readonly notificationSettings?: NotificationSettings;
  /** How often the retention cleanup runs: `RETENTION_INTERVAL_MS` by default. A test gives a short one. */
  readonly retentionIntervalMs?: number;
  /** Where to look for the checkout the sink must stay out of: the working directory and the application's own folder by default. */
  readonly startingPoints?: readonly string[];
  /** What the check that the sink's folder is private reads of the file system: the real one by default. A test gives its own. */
  readonly privacyProbe?: PrivacyProbe;
}

export interface DeliveryWorkerRuntime {
  readonly worker: DeliveryWorker;
  readonly logger: Logger;
  readonly metrics: BoundedMetrics;
  /**
   * Starts the private metrics endpoint when it is configured (S0.68), and nothing when it is not: the delivery counters, and the age of
   * the oldest due message read from the queue at each read. Closed with the other resources on shutdown.
   */
  startMetrics(): Promise<void>;
  /** Begins the lanes. */
  start(): void;
  /** Stops claiming, finishes or gives back what is in flight, and closes the pool, all inside the shutdown budget. */
  shutdown(): Promise<ShutdownOutcome>;
}

export function createDeliveryWorkerRuntime(
  config: WorkerConfig,
  options: RuntimeOptions = {},
): DeliveryWorkerRuntime {
  const clock = new SystemClock();
  // The environment's refusals hold for a configuration made by hand, as for the loader's: nothing is opened before they are judged.
  assertWorkerConfigAccepted(config);
  if (config.delivery.captureDirectory !== undefined) {
    assertOutsideCheckout(
      config.delivery.captureDirectory,
      options.startingPoints ?? [process.cwd(), dirname(fileURLToPath(import.meta.url))],
    );
    assertPrivateDirectory(config.delivery.captureDirectory, options.privacyProbe);
  }

  const logger = createServiceLogger({
    service: WORKER_APPLICATION_NAME,
    level: config.logLevel,
    appEnv: config.appEnv,
    ...(options.destination === undefined ? {} : { destination: options.destination }),
  });
  const providers = composeProviders(config, clock, options.providerFactory);
  const timeouts = providerTimeouts(config);
  const { leaseMs, jobBudgetMs } = leaseFor(timeouts);

  const registry = new ShutdownRegistry();
  const { url, poolMax, deadlines } = config.database;
  const database = new DatabaseService(
    createPool({ url, poolMax, deadlines, applicationName: WORKER_APPLICATION_NAME }),
    logger,
    registry,
    new ReadinessRegistry(),
    {
      clock,
      poolMax,
      deadlines,
      canceller: new PgStatementCanceller(postgresConnectionSettings(url), {
        timeoutMilliseconds: DISPOSAL_BOUND_MS,
        clock,
      }),
    },
  );
  // The worker reads a setup grant's standing (S0.29) and a recovery request's (S0.50) through its own database and its own capability.
  // A kind of record it does not know is not confirmed, so nothing is sent for it.
  const redemptionReader =
    options.redemptionReader ??
    redemptionReaderOver({
      SETUP_GRANT: new SetupGrantRedemptionReader({ database, clock }),
      RECOVERY_REQUEST: new RecoveryRequestRedemptionReader({ database, clock }),
    });
  const queue = new PostgresDeliveryQueue({ cipher: workerCipher(config), clock, work: database });
  const metrics = new BoundedMetrics({
    policy: labelPolicyFor(config.nodeEnv),
    clock,
    onDiagnostic: (diagnostic) => {
      logger.warn({ ...diagnostic }, 'metrics sample dropped');
    },
  });

  // The notification lane (S1.12): the relay of the outbox, the sending of the business texts and the network's word on them, in this
  // process and under the worker's own login, as one periodic task beside the lanes. Its sender reaches nobody (capture) or Hubtel behind
  // the guards of the controlled window; the wording a real provider may send is the approved wording only (`createLanePolicy`).
  const workerId = workerNameFor(hostname(), process.pid, randomBytes(4).toString('hex'));
  const notificationSms = config.delivery.notificationSms;
  // One answer for the two uses: a real provider is put behind the wording gate (only wording the owner approved is sent to it), and the
  // worker says so when it starts, so that an operator can read which mode the lane is in and a test can see the gate was composed.
  const realProvider = notificationSms.kind === 'provider';
  const notificationTimeoutMs =
    notificationSms.kind === 'provider' ? notificationSms.timeoutMs : CAPTURE_CALL_TIMEOUT_MS;
  const notificationStore = new NotificationStore({ database, clock, workerId });
  // The same store answers the gauge of the metrics endpoint: the age of the oldest work that is due and not done.
  const notificationBacklog = notificationStore;
  const notificationLane = new NotificationLane({
    store: notificationStore,
    sender:
      options.notificationSender ??
      composeNotificationSender(config, clock, {
        ...(options.startingPoints === undefined ? {} : { startingPoints: options.startingPoints }),
        ...(options.privacyProbe === undefined ? {} : { privacyProbe: options.privacyProbe }),
      }),
    metrics,
    policy: createLanePolicy({
      realProvider,
      // The switch and the day's limits are the platform's settings, read through the lane's capability and kept for a few seconds. A
      // setting that is missing or unusable holds the texts back, and the log names the key.
      settings:
        options.notificationSettings ??
        new DatabaseNotificationSettings({
          reader: new DatabaseSettingsReader({ database, clock }),
          clock,
          onUnusable: (key) => {
            logger.error(
              { setting: key },
              'a text-message setting is missing or unusable: texts are held back',
            );
          },
        }),
    }),
    logger,
    leaseMs: leaseMsFor(notificationTimeoutMs),
    providerTimeoutMs: notificationTimeoutMs,
    // The collection handshake's codes (S1.27): the lane makes the code it texts from the same `credential_delivery` key the API makes the rider's from,
    // in memory and at the send, so that no code is stored anywhere.
    handshakeCodes: new HandshakeCodes(config.keys),
  });

  const worker = new DeliveryWorker({
    queue,
    providers,
    providerTimeoutMs: timeouts,
    redemption: redemptionReader,
    clock,
    logger,
    metrics,
    workerId,
    concurrency: config.delivery.concurrency,
    pollIntervalMs: config.delivery.pollIntervalMs,
    leaseMs,
    jobBudgetMs,
    // With no reader that can confirm a redemption record, every claim would end without a send: the worker claims nothing, so no queued
    // message is spent. Since S0.29 the worker as composed has the reader of setup grants, so its lanes run; a worker given the reader that
    // confirms nothing (a test, and no deployment) still claims nothing. The periodic tasks run either way.
    consume: redemptionReader !== UNBUILT_REDEMPTION_READER,
    // Credential material whose time has passed is erased on a schedule, in the worker (S0.19).
    periodic: [
      retentionTask({
        cleanup: new RetentionCleanup({ database, clock }),
        logger,
        metrics,
        intervalMs: options.retentionIntervalMs ?? RETENTION_INTERVAL_MS,
      }),
      {
        name: 'notifications',
        intervalMs: NOTIFICATION_LANE_INTERVAL_MS,
        budgetMs: notificationRunBudgetMs(notificationTimeoutMs),
        run: (stop) => notificationLane.runOnce(stop),
      },
    ],
  });

  let stopped: Promise<ShutdownOutcome> | undefined;
  return {
    worker,
    logger,
    metrics,
    startMetrics: async () => {
      // A reader of the queue over the worker's own login and capability, for the backlog gauge; it reads two timestamps and no payload.
      const backlog = new WorkerJobStore({ database, cipher: workerCipher(config), clock });
      const listener = await startProcessMetrics({
        endpoint: config.metrics,
        source: metrics,
        gauges: async () => [
          {
            name: 'credential_delivery_oldest_due_age_seconds',
            value: await backlog.oldestDueAgeSeconds(),
          },
          {
            name: 'notification_oldest_due_age_seconds',
            value: await notificationBacklog.oldestDueAgeSeconds(),
          },
          {
            name: 'notification_dead_envelopes',
            value: await notificationBacklog.deadEnvelopeCount(),
          },
        ],
        logger,
      });
      if (listener === undefined) return;
      // A shutdown that began while the endpoint was opening has already closed what was registered by then, and would never close this
      // one: it holds the event loop open, and a clean shutdown becomes a process that does not end.
      if (stopped !== undefined) {
        await listener.close();
        return;
      }
      registry.register({ name: 'metrics endpoint', close: () => listener.close() });
    },
    start: () => {
      // A worker told to stop while its endpoint was opening does not begin: the shutdown ran first.
      if (stopped !== undefined) return;
      logger.info(
        { notification_sms: notificationSms.kind, wording_gate: realProvider },
        'notification lane composed',
      );
      // An operator who sees messages queue up must find out why: the worker does not claim them, and does not spend them.
      if (redemptionReader === UNBUILT_REDEMPTION_READER) {
        logger.warn(
          'redemption record readers are not built yet: the worker claims no message, and every queued message waits unspent until they are',
        );
      }
      // As composed, the worker reads both kinds of redemption record, a setup grant's (S0.29) and a recovery request's (S0.50), and says
      // nothing; it said that the second was "not built yet" until S0.69 found the line out of date. A record of a kind it cannot read is
      // still not confirmed and its message waits unspent (`redemptionReaderOver`).
      worker.start();
    },
    shutdown: () => {
      stopped ??= (async (): Promise<ShutdownOutcome> => {
        const startedAt = performance.now();
        const budgetMs = config.shutdown.timeoutMs;
        const report = await worker.stop(budgetMs);
        const closed = await registry.closeAll(
          Math.max(0, budgetMs - (performance.now() - startedAt)),
        );
        const outcome = shutdownOutcome(report, closed);
        if (outcome === 'clean') logger.info('shutdown complete');
        else {
          logger.error(
            {
              unconfirmed_leases: report.unconfirmed,
              failed_resources: closed.failed.map((failure) => failure.name),
              stalled_resources: closed.stalled,
              unreached_resources: closed.unreached,
            },
            'shutdown forced',
          );
        }
        return outcome;
      })();
      return stopped;
    },
  };
}
