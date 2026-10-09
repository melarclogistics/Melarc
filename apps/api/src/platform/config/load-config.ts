import { z } from 'zod';

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

export interface AppConfig {
  /** Framework mode. Express and other libraries read the same variable directly. */
  readonly nodeEnv: (typeof NODE_ENVS)[number];
  /** The Melarc environment (DEPLOYMENT_AND_ENVIRONMENTS.md §3). */
  readonly appEnv: (typeof APP_ENVS)[number];
  readonly composition: Composition;
  readonly http: HttpConfig;
  readonly logLevel: (typeof LOG_LEVELS)[number];
  readonly shutdown: { readonly timeoutMs: number; readonly drainDelayMs: number };
  readonly origins: OriginsConfig;
  /** Where setup and recovery links point, derived from the origins. */
  readonly links: LinkTemplates;
  readonly keys: KeyConfig;
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
 * only (MIGRATION_AND_SEEDING.md §5.1) and is never a runtime identity (SECURITY_DESIGN.md §14.17a), so
 * an API environment that carries its connection is refused, whether or not anything would use it.
 */
const FORBIDDEN_KEYS = {
  DATABASE_MIGRATION_URL:
    'absent: migration credentials must never be present in the API environment',
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
  adapterProblems(env, invalid, missing);
  return problems;
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

/** A provider or service endpoint: https, or plain http to a loopback host in a local run only. */
function endpointNeedsHttps(text: string, appEnv: ParsedEnv['APP_ENV']): boolean {
  const url = parseEndpoint(text);
  if (url === undefined) return true;
  return !(url.protocol === 'https:' || (appEnv === 'local' && isLoopbackHost(url)));
}

function adapterProblems(
  env: ParsedEnv,
  invalid: (key: ConfigKey) => void,
  missing: (key: ConfigKey) => void,
): void {
  const channels = [
    [
      'EMAIL',
      env.DELIVERY_EMAIL_ADAPTER,
      env.DELIVERY_EMAIL_ENDPOINT,
      env.DELIVERY_EMAIL_TIMEOUT_MS,
    ],
    ['SMS', env.DELIVERY_SMS_ADAPTER, env.DELIVERY_SMS_ENDPOINT, env.DELIVERY_SMS_TIMEOUT_MS],
  ] as const;
  for (const [channel, adapter, endpoint, timeout] of channels) {
    const endpointKey = `DELIVERY_${channel}_ENDPOINT` as const;
    const timeoutKey = `DELIVERY_${channel}_TIMEOUT_MS` as const;
    if (adapter === 'provider') {
      if (endpoint === undefined) missing(endpointKey);
      else if (endpointNeedsHttps(endpoint, env.APP_ENV)) invalid(endpointKey);
      if (timeout === undefined) missing(timeoutKey);
    } else {
      if (endpoint !== undefined) invalid(endpointKey);
      if (timeout !== undefined) invalid(timeoutKey);
    }
  }

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
    origins,
    links: Object.freeze({
      ops: Object.freeze(links.ops),
      vendor: Object.freeze(links.vendor),
    }),
    keys: keysFrom(values),
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
