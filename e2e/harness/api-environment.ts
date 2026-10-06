/**
 * Settings a test may add or change, but never these: they are what make a run local, sandboxed and safe.
 * Exported so that its test can try every one of them.
 */
export const PROTECTED_KEYS: readonly string[] = [
  'APP_ENV',
  'NODE_ENV',
  'DATABASE_URL',
  'DATABASE_MIGRATION_URL',
  'MELARC_E2E_CAPTURE_FILE',
];

export interface ApiEnvironmentOptions {
  readonly port: number;
  /** The runtime identity's connection string, the only database credential the API is given. */
  readonly runtimeUrl: string;
  /** Where the sandbox writes what it refuses. */
  readonly captureFile: string;
  readonly extra?: Readonly<Record<string, string>>;
}

/**
 * The whole environment of the API under test. The API gets exactly this, nothing from the machine
 * (ManagedProcess passes no more), so a run is the same on any machine and cannot be steered by a developer's
 * own settings. It runs as a local, non-production environment, on loopback, as the runtime identity only.
 */
export function apiEnvironment(options: ApiEnvironmentOptions): Record<string, string> {
  for (const key of Object.keys(options.extra ?? {})) {
    if (PROTECTED_KEYS.includes(key))
      throw new Error(`${key} is set by the harness and cannot be overridden.`);
  }
  return {
    NODE_ENV: 'test',
    APP_ENV: 'local',
    HTTP_HOST: '127.0.0.1',
    HTTP_PORT: String(options.port),
    LOG_LEVEL: 'info',
    // Bounded: a run must not wait for the production default when something stalls.
    SHUTDOWN_TIMEOUT_MS: '5000',
    SHUTDOWN_DRAIN_DELAY_MS: '0',
    DATABASE_URL: options.runtimeUrl,
    DATABASE_POOL_MAX: '3',
    MELARC_E2E_CAPTURE_FILE: options.captureFile,
    ...options.extra,
  };
}
