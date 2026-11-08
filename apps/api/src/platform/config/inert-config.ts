import { DEVELOPMENT_QUALIFIED_ARGON2ID } from '../auth/crypto/argon2-parameters.js';
import { ENGINEERING_DEFAULTS, HASH_ADMISSION_DEFAULTS } from './config-settings.js';
import type { AppConfig, DatabaseDeadlines, ExecutionConfig, HttpConfig } from './load-config.js';
import { linkTemplates } from './origins.js';

const ORIGINS = Object.freeze({ ops: 'http://127.0.0.1:5173', vendor: 'http://127.0.0.1:5174' });
const LINKS = linkTemplates(ORIGINS);

/** The transport bounds of a run that serves nothing: the development defaults, on a port nobody listens on. */
export const INERT_HTTP: HttpConfig = Object.freeze({
  host: '127.0.0.1',
  port: 1,
  trustProxy: Object.freeze([]),
  bodyLimitBytes: Number(ENGINEERING_DEFAULTS.HTTP_BODY_LIMIT_BYTES),
  headerTimeoutMs: Number(ENGINEERING_DEFAULTS.HTTP_HEADER_TIMEOUT_MS),
  bodyTimeoutMs: Number(ENGINEERING_DEFAULTS.HTTP_BODY_TIMEOUT_MS),
  admissionTimeoutMs: Number(ENGINEERING_DEFAULTS.HTTP_ADMISSION_TIMEOUT_MS),
  admissionConcurrency: Number(ENGINEERING_DEFAULTS.HTTP_ADMISSION_CONCURRENCY),
});

/** The database waits of a run that connects to nothing real: the development defaults. */
export const INERT_DEADLINES: DatabaseDeadlines = Object.freeze({
  acquireTimeoutMs: Number(ENGINEERING_DEFAULTS.DATABASE_ACQUIRE_TIMEOUT_MS),
  lockTimeoutMs: Number(ENGINEERING_DEFAULTS.DATABASE_LOCK_TIMEOUT_MS),
  statementTimeoutMs: Number(ENGINEERING_DEFAULTS.DATABASE_STATEMENT_TIMEOUT_MS),
  idleInTransactionTimeoutMs: Number(ENGINEERING_DEFAULTS.DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS),
  transactionTimeoutMs: Number(ENGINEERING_DEFAULTS.DATABASE_TRANSACTION_TIMEOUT_MS),
  maxWaiters: Number(ENGINEERING_DEFAULTS.DATABASE_POOL_MAX_WAITERS),
});

/** The request budget of a run that serves nothing: the development default. */
export const INERT_EXECUTION: ExecutionConfig = Object.freeze({
  requestBudgetMs: Number(ENGINEERING_DEFAULTS.REQUEST_EXECUTION_BUDGET_MS),
});

/**
 * A configuration for code that builds the application without running it: the tools that describe it to itself, and tests. It
 * holds fixed values and reads nothing from the environment, holds no key material (the custody is `describe`), has no
 * database, and selects the `describe` composition, whose adapters never connect, deliver or read a secret. It is local-only:
 * `adapterRefusals` refuses it in staging and production. Fields may be replaced, one whole field at a time.
 */
export function inertConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return Object.freeze({
    nodeEnv: 'development',
    appEnv: 'local',
    composition: 'describe',
    http: INERT_HTTP,
    logLevel: 'silent',
    shutdown: Object.freeze({ timeoutMs: 15_000, drainDelayMs: 0 }),
    execution: INERT_EXECUTION,
    origins: ORIGINS,
    links: Object.freeze({ ops: Object.freeze(LINKS.ops), vendor: Object.freeze(LINKS.vendor) }),
    keys: Object.freeze({ custody: 'describe' }),
    credentialHashing: Object.freeze({
      profile: DEVELOPMENT_QUALIFIED_ARGON2ID,
      acceptedProfiles: Object.freeze([]),
    }),
    hashAdmission: Object.freeze({
      slots: Number(HASH_ADMISSION_DEFAULTS.HASH_ADMISSION_SLOTS),
      memoryBudgetMiB: Number(HASH_ADMISSION_DEFAULTS.HASH_ADMISSION_MEMORY_BUDGET_MIB),
    }),
    adapters: Object.freeze({
      limiter: 'postgres',
      delivery: Object.freeze({
        email: Object.freeze({ kind: 'capture' }),
        sms: Object.freeze({ kind: 'capture' }),
      }),
      attestationVerifier: Object.freeze({ kind: 'substitute' }),
    }),
    ...overrides,
  });
}
