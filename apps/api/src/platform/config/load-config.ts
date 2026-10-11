import { z } from 'zod';

import { isValidArgon2idParameters, profileKey } from '../auth/crypto/argon2-parameters.js';
import { adapterRefusals } from './adapter-refusals.js';
import {
  APP_ENVS,
  EXPECTED,
  LOG_LEVELS,
  NODE_ENVS,
  OPTIONAL_KEYS,
  envShape,
  isLoopbackHost,
  parseEndpoint,
  type ConfigKey,
} from './config-settings.js';
import { parseAcceptedProfiles, type CredentialHashingConfig } from './credential-hashing.js';
import { deliveryAdapterProblems, endpointNeedsHttps } from './delivery-adapter-problems.js';
import {
  KEY_PURPOSES,
  keyEnvName,
  parseKeyMaterial,
  type KeyPurpose,
  type PurposeKeys,
} from './key-material.js';
import { linkTemplates, type LinkTemplates } from './origins.js';
import { Secret } from './secret.js';
import { parseTrustProxy } from './trust-proxy.js';

export { API_RUNTIME_ROLE } from './config-settings.js';

/**
 * Which adapters the application is composed with. `runtime` is the real one; `describe` binds inert adapters that never
 * connect, deliver or read a secret, for the tools that describe the application to itself and for tests. No environment
 * variable selects `describe`, so only code that builds a configuration by hand can, and production refuses it
 * (`adapter-refusals.ts`).
 */
export type Composition = 'describe' | 'runtime';

/** The finite bounds on every database wait (SECURITY_DESIGN.md §14.6). Lock wait is inside statement time inside transaction time. */
export interface DatabaseDeadlines {
  readonly acquireTimeoutMs: number;
  readonly lockTimeoutMs: number;
  readonly statementTimeoutMs: number;
  readonly idleInTransactionTimeoutMs: number;
  readonly transactionTimeoutMs: number;
  /** The most callers allowed to wait for a pooled connection at once. */
  readonly maxWaiters: number;
}

/**
 * The per-request execution budget (plan section 11.8): the longest one request may run once it has been received and admitted,
 * database work and everything else included. The database layer consumes it now; S0.20 wraps every request in one. It is not
 * an HTTP receipt limit (those end a slow sender) and not a database timeout (those bound waiting inside the database).
 */
export interface ExecutionConfig {
  readonly requestBudgetMs: number;
}

export interface DatabaseConfig {
  /** Connects as the runtime identity. Carries the password, so it is never logged or echoed. */
  readonly url: string;
  /** The most connections the API keeps open. */
  readonly poolMax: number;
  readonly deadlines: DatabaseDeadlines;
}

export interface HttpConfig {
  readonly host: string;
  readonly port: number;
  /** The trusted hops by address. Empty means `trust proxy` is off: no forwarded header is believed. */
  readonly trustProxy: readonly string[];
  /** Counts received bytes, chunked requests included. */
  readonly bodyLimitBytes: number;
  /**
   * The two receipt limits: how long the server waits for a client to send the request head, and then the body. They end a
   * slow sender. They do not bound a handler: once a request has been received, no value here limits how long its handler
   * runs (DEPLOYMENT_AND_ENVIRONMENTS.md §12.5, "Deadlines").
   */
  readonly headerTimeoutMs: number;
  readonly bodyTimeoutMs: number;
  /** How long a request may wait for an admission slot, and how many are admitted at once. Neither bounds a handler. */
  readonly admissionTimeoutMs: number;
  readonly admissionConcurrency: number;
}

export interface OriginsConfig {
  readonly ops: string;
  readonly vendor: string;
}

/** Key material, held as secrets that print as `[REDACTED]`. Only the local substitute exists; see `adapter-refusals.ts`. */
export type KeyConfig =
  | { readonly custody: 'local'; readonly purposes: Readonly<Record<KeyPurpose, PurposeKeys>> }
  | { readonly custody: 'describe' };

export type DeliveryAdapterConfig =
  | { readonly kind: 'capture' }
  | { readonly kind: 'provider'; readonly endpoint: string; readonly timeoutMs: number };

export type VerifierConfig =
  | { readonly kind: 'substitute' }
  | {
      readonly kind: 'service';
      readonly url: string;
      readonly timeoutMs: number;
      /** Authenticates the API to a service on another host. */
      readonly callerSecret?: Secret;
    };

export interface AdaptersConfig {
  readonly limiter: 'postgres' | 'memory';
  readonly delivery: { readonly email: DeliveryAdapterConfig; readonly sms: DeliveryAdapterConfig };
  readonly attestationVerifier: VerifierConfig;
}

/**
 * The bound on concurrent password hashing (SECURITY_DESIGN.md §13.4c). Validated at start: the slots, each at the largest memory
 * a hash may be derived at (the write profile and every accepted profile), fit the budget.
 */
export interface HashAdmissionConfig {
  readonly slots: number;
  readonly memoryBudgetMiB: number;
}

export interface AppConfig {
  /** Framework mode. Express and other libraries read the same variable directly. */
  readonly nodeEnv: (typeof NODE_ENVS)[number];
  /** The Melarc environment (DEPLOYMENT_AND_ENVIRONMENTS.md §3). */
  readonly appEnv: (typeof APP_ENVS)[number];
  readonly composition: Composition;
  readonly http: HttpConfig;
  readonly logLevel: (typeof LOG_LEVELS)[number];
  readonly shutdown: { readonly timeoutMs: number; readonly drainDelayMs: number };
  readonly execution: ExecutionConfig;
  readonly origins: OriginsConfig;
  /** Where setup and recovery links point, derived from the origins. */
  readonly links: LinkTemplates;
  readonly keys: KeyConfig;
  /**
   * The profile new credential hashes are written at, and the older profiles that stored hashes may still be verified at. Validated
   * at start; the Hasher is given it by whoever binds it. Staging and production refuse a profile below the floor
   * (`adapter-refusals.ts`).
   */
  readonly credentialHashing: CredentialHashingConfig;
  /** How many hashes may run at once, and the memory they may take together. */
  readonly hashAdmission: HashAdmissionConfig;
  readonly adapters: AdaptersConfig;
  /**
   * Always present in a configuration that `loadConfig` returns, so the real API cannot start without
   * a database. It is optional in the type only so that code that builds a configuration by hand, the
   * OpenAPI generator and the unit tests that need no database, does not need a live dependency.
   */
  readonly database?: DatabaseConfig;
}

export interface ConfigProblem {
  /** The environment variable, or for a configuration built by hand the name of the field. */
  readonly key: string;
  readonly problem: 'missing' | 'invalid';
  /** What a valid value looks like. Static text: never built from what was supplied. */
  readonly expected: string;
}

export type LoadConfigResult =
  | { readonly ok: true; readonly config: AppConfig }
  | { readonly ok: false; readonly problems: readonly ConfigProblem[] };

const KEYS = Object.keys(EXPECTED) as ConfigKey[];

/** Every environment variable the API reads. apps/api/.env.example must document each of them. */
export const CONFIG_KEYS: readonly string[] = KEYS;

/**
 * Variables that must not be present at all. The migration identity exists for the deployment window
 * only (MIGRATION_AND_SEEDING.md §5.1) and is never a runtime identity (SECURITY_DESIGN.md §14.17a), and the provisioning
 * identity that runs the seed is "a login outside the API's and every worker's configuration" (§14.17), so an API
 * environment that carries either connection is refused, whether or not anything would use it.
 */
const FORBIDDEN_KEYS = {
  DATABASE_MIGRATION_URL:
    'absent: migration credentials must never be present in the API environment',
  DATABASE_SEED_URL:
    'absent: provisioning credentials must never be present in the API environment',
  // The delivery worker's own login (S0.18): its capability reads the sealed payload of every queued message, so an API that
  // carried the connection would be one compromise away from the destinations and the tokens it queues.
  DATABASE_WORKER_URL:
    "absent: the delivery worker's credentials must never be present in the API environment",
} as const;

const envSchema = z.object(envShape);

type ParsedEnv = z.infer<typeof envSchema>;

/**
 * Rules that relate keys. They run only once every key is individually valid, so a bad value
 * is reported once, against its own key, and never judged against another one.
 */
function relationProblems(env: ParsedEnv): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  const invalid = (key: ConfigKey, expected: string = EXPECTED[key]): void => {
    problems.push({ key, problem: 'invalid', expected });
  };
  const missing = (key: ConfigKey): void => {
    problems.push({ key, problem: 'missing', expected: EXPECTED[key] });
  };

  // DEPLOYMENT_AND_ENVIRONMENTS.md §12.3: production permits no development-mode bypass.
  if (env.APP_ENV !== 'local' && env.NODE_ENV !== 'production') {
    invalid('NODE_ENV', 'production when APP_ENV is staging or production');
  }
  if (env.SHUTDOWN_DRAIN_DELAY_MS >= env.SHUTDOWN_TIMEOUT_MS) {
    invalid('SHUTDOWN_DRAIN_DELAY_MS', 'less than SHUTDOWN_TIMEOUT_MS');
  }

  // SECURITY_DESIGN.md §14.6: lock wait inside statement time inside transaction time.
  if (env.DATABASE_LOCK_TIMEOUT_MS >= env.DATABASE_STATEMENT_TIMEOUT_MS) {
    invalid('DATABASE_LOCK_TIMEOUT_MS');
  }
  if (env.DATABASE_STATEMENT_TIMEOUT_MS >= env.DATABASE_TRANSACTION_TIMEOUT_MS) {
    invalid('DATABASE_STATEMENT_TIMEOUT_MS');
  }

  // SECURITY_DESIGN.md §14.8: two surfaces, two origins; DEPLOYMENT_AND_ENVIRONMENTS.md §12.2: HTTPS everywhere.
  if (env.OPS_ORIGIN === env.VENDOR_ORIGIN) invalid('VENDOR_ORIGIN');
  if (env.APP_ENV !== 'local') {
    if (!env.OPS_ORIGIN.startsWith('https://')) invalid('OPS_ORIGIN');
    if (!env.VENDOR_ORIGIN.startsWith('https://')) invalid('VENDOR_ORIGIN');
  }

  keyProblems(env, invalid);
  hashingProblems(env, invalid);
  adapterProblems(env, invalid, missing);
  return problems;
}

/**
 * The write profile is a cost the algorithm honours exactly (memory is a multiple of 4 KiB per lane and at least 8 per lane: a
 * relation between two keys, reported against the memory), and the older profiles that may still be verified do not include it.
 */
function hashingProblems(env: ParsedEnv, invalid: (key: ConfigKey) => void): void {
  const profile = {
    memoryKiB: env.ARGON2_MEMORY_KIB,
    passes: env.ARGON2_PASSES,
    parallelism: env.ARGON2_PARALLELISM,
  };
  if (!isValidArgon2idParameters(profile)) {
    invalid('ARGON2_MEMORY_KIB');
    return;
  }
  const accepted =
    env.ARGON2_ACCEPTED_PROFILES === undefined
      ? []
      : (parseAcceptedProfiles(env.ARGON2_ACCEPTED_PROFILES) ?? []);
  if (accepted.some((older) => profileKey(older) === profileKey(profile))) {
    invalid('ARGON2_ACCEPTED_PROFILES');
  }
  // SECURITY_DESIGN.md §13.4c: memory is budgeted for the largest profile a slot may be asked to derive. An old hash verifies at the
  // cost it was made with, so that is the largest of the write profile and every accepted one, not the write profile alone.
  const largestKiB = Math.max(profile.memoryKiB, ...accepted.map((older) => older.memoryKiB));
  if (env.HASH_ADMISSION_SLOTS * largestKiB > env.HASH_ADMISSION_MEMORY_BUDGET_MIB * 1024) {
    invalid('HASH_ADMISSION_SLOTS');
  }
}

/** The active version is one the purpose holds, and no key is used twice anywhere (SECURITY_DESIGN.md §14.9). */
function keyProblems(env: ParsedEnv, invalid: (key: ConfigKey) => void): void {
  const seen = new Set<string>();
  for (const purpose of KEY_PURPOSES) {
    const material = keyEnvName(purpose, 'MATERIAL');
    const versions = parseKeyMaterial(String(env[material])) ?? [];
    if (
      !versions.some(([version]) => version === Number(env[keyEnvName(purpose, 'ACTIVE_VERSION')]))
    ) {
      invalid(keyEnvName(purpose, 'ACTIVE_VERSION'));
    }
    let repeated = false;
    for (const [, key] of versions) {
      if (seen.has(key.reveal())) repeated = true;
      seen.add(key.reveal());
    }
    if (repeated) invalid(material);
  }
}

function adapterProblems(
  env: ParsedEnv,
  invalid: (key: ConfigKey) => void,
  missing: (key: ConfigKey) => void,
): void {
  deliveryAdapterProblems(env, invalid, missing);

  const url = env.ATTESTATION_VERIFIER_URL;
  const timeout = env.ATTESTATION_VERIFIER_TIMEOUT_MS;
  const secret = env.ATTESTATION_VERIFIER_CALLER_SECRET;
  if (env.ATTESTATION_VERIFIER === 'service') {
    if (url === undefined) missing('ATTESTATION_VERIFIER_URL');
    else if (endpointNeedsHttps(url, env.APP_ENV)) invalid('ATTESTATION_VERIFIER_URL');
    if (timeout === undefined) missing('ATTESTATION_VERIFIER_TIMEOUT_MS');
    // SECURITY_DESIGN.md §15.2.3: the service authenticates its caller if it crosses hosts.
    const parsed = url === undefined ? undefined : parseEndpoint(url);
    if (parsed !== undefined && !isLoopbackHost(parsed) && secret === undefined) {
      missing('ATTESTATION_VERIFIER_CALLER_SECRET');
    }
  } else {
    if (url !== undefined) invalid('ATTESTATION_VERIFIER_URL');
    if (timeout !== undefined) invalid('ATTESTATION_VERIFIER_TIMEOUT_MS');
    if (secret !== undefined) invalid('ATTESTATION_VERIFIER_CALLER_SECRET');
  }
}

/** One problem per failing key. Key names and static text only, so a rejected secret is never echoed. */
function toProblems(
  issues: readonly z.core.$ZodIssue[],
  input: Readonly<Record<string, string | undefined>>,
): ConfigProblem[] {
  const failing = new Set(issues.map((issue) => issue.path[0]));
  return KEYS.filter((key) => failing.has(key)).map((key) => ({
    key,
    problem: input[key] === undefined ? 'missing' : 'invalid',
    expected: EXPECTED[key],
  }));
}

/** One problem per forbidden variable that is set. An empty value, as a copied template leaves, is absent. */
function forbiddenProblems(env: Readonly<Record<string, string | undefined>>): ConfigProblem[] {
  return Object.entries(FORBIDDEN_KEYS)
    .filter(([key]) => (env[key] ?? '') !== '')
    .map(([key, expected]) => ({ key, problem: 'invalid' as const, expected }));
}

const delivery = (
  adapter: 'capture' | 'provider',
  endpoint: string | undefined,
  timeoutMs: number | undefined,
): DeliveryAdapterConfig =>
  adapter === 'provider' && endpoint !== undefined && timeoutMs !== undefined
    ? Object.freeze({ kind: 'provider', endpoint, timeoutMs })
    : Object.freeze({ kind: 'capture' });

function keysFrom(values: ParsedEnv): KeyConfig {
  const purposes = Object.fromEntries(
    KEY_PURPOSES.map((purpose) => {
      const versions = Object.fromEntries(
        parseKeyMaterial(String(values[keyEnvName(purpose, 'MATERIAL')])) ?? [],
      ) as Record<number, Secret>;
      const activeVersion = Number(values[keyEnvName(purpose, 'ACTIVE_VERSION')]);
      return [purpose, Object.freeze({ activeVersion, versions: Object.freeze(versions) })];
    }),
  ) as Record<KeyPurpose, PurposeKeys>;
  return Object.freeze({ custody: 'local', purposes: Object.freeze(purposes) });
}

function hashingFrom(values: ParsedEnv): CredentialHashingConfig {
  const accepted =
    values.ARGON2_ACCEPTED_PROFILES === undefined
      ? []
      : (parseAcceptedProfiles(values.ARGON2_ACCEPTED_PROFILES) ?? []);
  return Object.freeze({
    profile: Object.freeze({
      memoryKiB: values.ARGON2_MEMORY_KIB,
      passes: values.ARGON2_PASSES,
      parallelism: values.ARGON2_PARALLELISM,
    }),
    acceptedProfiles: Object.freeze(accepted.map((older) => Object.freeze({ ...older }))),
  });
}

function verifierFrom(values: ParsedEnv): VerifierConfig {
  const { ATTESTATION_VERIFIER_URL: url, ATTESTATION_VERIFIER_TIMEOUT_MS: timeoutMs } = values;
  if (values.ATTESTATION_VERIFIER !== 'service' || url === undefined || timeoutMs === undefined) {
    return Object.freeze({ kind: 'substitute' });
  }
  const secret = values.ATTESTATION_VERIFIER_CALLER_SECRET;
  return Object.freeze({
    kind: 'service',
    url,
    timeoutMs,
    ...(secret === undefined ? {} : { callerSecret: new Secret(secret) }),
  });
}

/** Validates the process environment. Pure: reads only the keys this API owns. */
export function loadConfig(env: Readonly<Record<string, string | undefined>>): LoadConfigResult {
  // A blank optional setting is an absent one: a copied template leaves its optional lines empty.
  const input = Object.fromEntries(
    KEYS.map((key) => [key, OPTIONAL_KEYS.includes(key) && env[key] === '' ? undefined : env[key]]),
  );
  const forbidden = forbiddenProblems(env);
  const parsed = envSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, problems: [...toProblems(parsed.error.issues, input), ...forbidden] };
  }

  const values = parsed.data;
  const problems = [...relationProblems(values), ...forbidden];
  if (problems.length > 0) return { ok: false, problems };

  const origins: OriginsConfig = Object.freeze({
    ops: values.OPS_ORIGIN,
    vendor: values.VENDOR_ORIGIN,
  });
  const links = linkTemplates(origins);
  const config: AppConfig = {
    nodeEnv: values.NODE_ENV,
    appEnv: values.APP_ENV,
    composition: 'runtime',
    http: Object.freeze({
      host: values.HTTP_HOST,
      port: values.HTTP_PORT,
      trustProxy: Object.freeze([...(parseTrustProxy(values.HTTP_TRUST_PROXY) ?? [])]),
      bodyLimitBytes: values.HTTP_BODY_LIMIT_BYTES,
      headerTimeoutMs: values.HTTP_HEADER_TIMEOUT_MS,
      bodyTimeoutMs: values.HTTP_BODY_TIMEOUT_MS,
      admissionTimeoutMs: values.HTTP_ADMISSION_TIMEOUT_MS,
      admissionConcurrency: values.HTTP_ADMISSION_CONCURRENCY,
    }),
    logLevel: values.LOG_LEVEL,
    shutdown: Object.freeze({
      timeoutMs: values.SHUTDOWN_TIMEOUT_MS,
      drainDelayMs: values.SHUTDOWN_DRAIN_DELAY_MS,
    }),
    execution: Object.freeze({ requestBudgetMs: values.REQUEST_EXECUTION_BUDGET_MS }),
    origins,
    links: Object.freeze({
      ops: Object.freeze(links.ops),
      vendor: Object.freeze(links.vendor),
    }),
    keys: keysFrom(values),
    credentialHashing: hashingFrom(values),
    hashAdmission: Object.freeze({
      slots: values.HASH_ADMISSION_SLOTS,
      memoryBudgetMiB: values.HASH_ADMISSION_MEMORY_BUDGET_MIB,
    }),
    adapters: Object.freeze({
      limiter: values.RATE_LIMITER,
      delivery: Object.freeze({
        email: delivery(
          values.DELIVERY_EMAIL_ADAPTER,
          values.DELIVERY_EMAIL_ENDPOINT,
          values.DELIVERY_EMAIL_TIMEOUT_MS,
        ),
        sms: delivery(
          values.DELIVERY_SMS_ADAPTER,
          values.DELIVERY_SMS_ENDPOINT,
          values.DELIVERY_SMS_TIMEOUT_MS,
        ),
      }),
      attestationVerifier: verifierFrom(values),
    }),
    database: Object.freeze({
      url: values.DATABASE_URL,
      poolMax: values.DATABASE_POOL_MAX,
      deadlines: Object.freeze({
        acquireTimeoutMs: values.DATABASE_ACQUIRE_TIMEOUT_MS,
        lockTimeoutMs: values.DATABASE_LOCK_TIMEOUT_MS,
        statementTimeoutMs: values.DATABASE_STATEMENT_TIMEOUT_MS,
        idleInTransactionTimeoutMs: values.DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS,
        transactionTimeoutMs: values.DATABASE_TRANSACTION_TIMEOUT_MS,
        maxWaiters: values.DATABASE_POOL_MAX_WAITERS,
      }),
    }),
  };

  // The same refusals that guard a configuration built by hand, applied to what the environment produced.
  const refusals = adapterRefusals(config);
  if (refusals.length > 0) return { ok: false, problems: refusals };
  return { ok: true, config: Object.freeze(config) };
}
