import { randomBytes } from 'node:crypto';

/**
 * Settings a test may add or change, but never these: they are what make a run local, sandboxed and safe. Which adapters run
 * is among them: a run uses the PostgreSQL limiter, the capture sink and the substitute verifier, and no test can select
 * another. Exported so that its test can try every one of them.
 */
export const PROTECTED_KEYS: readonly string[] = [
  'APP_ENV',
  'NODE_ENV',
  'DATABASE_URL',
  'DATABASE_MIGRATION_URL',
  'MELARC_E2E_CAPTURE_FILE',
  'KEY_CUSTODY',
  'RATE_LIMITER',
  'DELIVERY_EMAIL_ADAPTER',
  'DELIVERY_SMS_ADAPTER',
  'ATTESTATION_VERIFIER',
];

/** The key purposes of SECURITY_DESIGN.md section 14.9, as the API names their settings. A test compares this with the API's example. */
const KEY_SETTINGS: readonly string[] = [
  'TOTP_SEED',
  'CREDENTIAL_DELIVERY',
  'IDEMPOTENT_REPLAY',
  'LIMITER_DIGEST',
  'PASSWORD_PEPPER',
];

/**
 * Throwaway key material for one run: a fresh random key for each purpose (32 bytes as 43 unpadded base64url characters),
 * all different, held in memory for the life of the process it is given to and written nowhere. It protects nothing real.
 */
function runKeys(): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const purpose of KEY_SETTINGS) {
    keys[`KEY_${purpose}_MATERIAL`] = `1:${randomBytes(32).toString('base64url')}`;
    keys[`KEY_${purpose}_ACTIVE_VERSION`] = '1';
  }
  return keys;
}

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
    // The surfaces are not served by this run; the settings are required and judged at start, and nothing reads them yet.
    OPS_ORIGIN: 'http://127.0.0.1:4173',
    VENDOR_ORIGIN: 'http://127.0.0.1:4174',
    RATE_LIMITER: 'postgres',
    KEY_CUSTODY: 'local',
    ...runKeys(),
    DELIVERY_EMAIL_ADAPTER: 'capture',
    DELIVERY_SMS_ADAPTER: 'capture',
    ATTESTATION_VERIFIER: 'substitute',
    MELARC_E2E_CAPTURE_FILE: options.captureFile,
    ...options.extra,
  };
}
