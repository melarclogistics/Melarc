/**
 * The whole environment of the delivery worker under test (S0.45), as `apiEnvironment` is the API's: the worker gets exactly this and
 * nothing from the machine. It connects as the worker login (`melarc_worker_runtime`) and as no other, holds the credential-delivery
 * key and no other (the API and the worker must hold the same one, or the worker could not open what the API sealed), sends through the
 * capture adapter into a folder outside the checkout, and runs under the outbound guard like the API.
 */
export interface WorkerEnvironmentOptions {
  /** The worker login's connection string for the run's database. It carries the password. */
  readonly databaseWorkerUrl: string;
  /** Where the capture adapter writes the messages: a folder outside the checkout, private to this user. */
  readonly captureDirectory: string;
  /** Where the outbound guard records what it refuses (the same file as the API's). */
  readonly captureFile: string;
  /** The key material of the run, which `runKeys` made for the API. */
  readonly keys: Readonly<Record<string, string>>;
}

export function workerEnvironment(options: WorkerEnvironmentOptions): Record<string, string> {
  const material = options.keys.KEY_CREDENTIAL_DELIVERY_MATERIAL;
  const version = options.keys.KEY_CREDENTIAL_DELIVERY_ACTIVE_VERSION;
  if (material === undefined || version === undefined) {
    throw new Error('The run has no credential-delivery key to give the worker.');
  }
  return {
    NODE_ENV: 'test',
    APP_ENV: 'local',
    LOG_LEVEL: 'info',
    // Bounded: a run must not wait for the production default when something stalls.
    SHUTDOWN_TIMEOUT_MS: '5000',
    DATABASE_WORKER_URL: options.databaseWorkerUrl,
    KEY_CUSTODY: 'local',
    KEY_CREDENTIAL_DELIVERY_MATERIAL: material,
    KEY_CREDENTIAL_DELIVERY_ACTIVE_VERSION: version,
    DELIVERY_EMAIL_ADAPTER: 'capture',
    DELIVERY_SMS_ADAPTER: 'capture',
    DELIVERY_CAPTURE_DIRECTORY: options.captureDirectory,
    // A person waits for a link that has just been queued: the worker looks at the queue five times a second, and no more than that.
    DELIVERY_WORKER_POLL_INTERVAL_MS: '200',
    DELIVERY_WORKER_CONCURRENCY: '2',
    MELARC_E2E_CAPTURE_FILE: options.captureFile,
  };
}
