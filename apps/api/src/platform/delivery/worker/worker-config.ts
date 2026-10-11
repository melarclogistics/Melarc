import { isAbsolute } from 'node:path';

import { z } from 'zod';

import {
  EXPECTED,
  OPTIONAL_KEYS,
  envShape,
  integerBetween,
  type ConfigKey,
} from '../../config/config-settings.js';
import { deliveryAdapterProblems } from '../../config/delivery-adapter-problems.js';
import {
  KEY_PURPOSES,
  keyEnvName,
  parseKeyMaterial,
  type KeyHolding,
  type PurposeKeys,
} from '../../config/key-material.js';
import type {
  ConfigProblem,
  DatabaseDeadlines,
  DeliveryAdapterConfig,
} from '../../config/load-config.js';
import { Secret } from '../../config/secret.js';
import { parsePostgresUrl } from '../../database/postgres-url.js';
import { WORKER_RUNTIME_ROLE } from '../../database/technical-roles.js';
import { parseAllowList } from './delivery-allow-list.js';

/**
 * The delivery worker's configuration (S0.18; DEPLOYMENT_AND_ENVIRONMENTS.md §12.3 and §12.5). The worker is its own process, so it
 * has its own loader: it reads the settings it shares with the API **by the same names, bounds and meaning** (the environment and
 * log level, the one shutdown budget, the database deadlines, the key material of the delivery purpose, the delivery adapters),
 * and the few that are its own. It does not read the API's other settings and does not need them.
 *
 * **What it holds, and what it does not.** The worker connects as `melarc_worker_runtime` (`DATABASE_WORKER_URL`; any other user is
 * refused) and holds the `credential_delivery` key and **no other** (each purpose has its own access policy, SECURITY_DESIGN.md §14.9):
 * the key material of the other purposes in its environment is not read, and in a deployed environment it is refused. Likewise the
 * API's connection (`DATABASE_URL`) and the verifier's caller secret: a deployed worker whose environment carried them would turn
 * the compromise of the worker into the compromise of more. A local run shares one settings file with the API, so the refusal
 * applies to Staging and Production only. The migration and provisioning URLs are refused everywhere, as in the API.
 *
 * **Refusals.** As the API: production refuses the capture adapter (on either channel) and the local key custody. **Staging
 * refuses a real provider unless the approval reference and the recipient allow-list of the controlled window are configured**
 * (DEPLOYMENT_AND_ENVIRONMENTS.md §4.1), and production refuses the window's settings altogether (an allow-list in production
 * would silently drop real recipients). The capture adapter needs a directory for its sink.
 *
 * Pure: it reads only the keys listed here, and a problem names a key and what a valid value looks like, never a value. The
 * defaults the process applies to a local run (the sink's directory, the worker's login) are the entry point's, not this
 * function's.
 */

/** The settings the worker shares with the API, by the same names. */
export const WORKER_SHARED_KEYS = [
  'NODE_ENV',
  'APP_ENV',
  'LOG_LEVEL',
  'SHUTDOWN_TIMEOUT_MS',
  'DATABASE_ACQUIRE_TIMEOUT_MS',
  'DATABASE_LOCK_TIMEOUT_MS',
  'DATABASE_STATEMENT_TIMEOUT_MS',
  'DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS',
  'DATABASE_TRANSACTION_TIMEOUT_MS',
  'DATABASE_POOL_MAX_WAITERS',
  'KEY_CUSTODY',
  'KEY_CREDENTIAL_DELIVERY_MATERIAL',
  'KEY_CREDENTIAL_DELIVERY_ACTIVE_VERSION',
  'DELIVERY_EMAIL_ADAPTER',
  'DELIVERY_EMAIL_ENDPOINT',
  'DELIVERY_EMAIL_TIMEOUT_MS',
  'DELIVERY_SMS_ADAPTER',
  'DELIVERY_SMS_ENDPOINT',
  'DELIVERY_SMS_TIMEOUT_MS',
] as const satisfies readonly ConfigKey[];

/** The settings only the worker reads. */
export const WORKER_ONLY_KEYS = [
  'DATABASE_WORKER_URL',
  'DELIVERY_WORKER_CONCURRENCY',
  'DELIVERY_WORKER_POLL_INTERVAL_MS',
  'DELIVERY_CAPTURE_DIRECTORY',
  'DELIVERY_PROVIDER_APPROVAL_REF',
  'DELIVERY_PROVIDER_ALLOWLIST',
] as const;

type WorkerOnlyKey = (typeof WORKER_ONLY_KEYS)[number];

/** Every environment variable the worker reads. `.env.example` and the deployment document must account for each. */
export const WORKER_CONFIG_KEYS: readonly string[] = [...WORKER_SHARED_KEYS, ...WORKER_ONLY_KEYS];

/**
 * The defaults of the worker's own settings: **development-qualified, not production-qualified** (plan section 3, "Engineering
 * parameters"; DEPLOYMENT_AND_ENVIRONMENTS.md §12.5, "What S0.18 applied"). Four lanes keep a worker busy under a burst of
 * credential issue without taking more than a handful of database connections; two seconds is how long a person waits for a
 * link that has just been queued, at most, when the worker is idle. S0.65 calibrates both.
 */
export const WORKER_DEFAULTS = {
  DELIVERY_WORKER_CONCURRENCY: '4',
  DELIVERY_WORKER_POLL_INTERVAL_MS: '2000',
} as const;

/** What a valid value of the worker's own settings looks like. Static text: never built from what was supplied. */
export const WORKER_EXPECTED: Readonly<Record<WorkerOnlyKey, string>> = {
  DATABASE_WORKER_URL: `a postgres:// or postgresql:// URL naming a host, one database and the user ${WORKER_RUNTIME_ROLE}, with no query string or fragment`,
  DELIVERY_WORKER_CONCURRENCY:
    'an integer from 1 to 32: the most messages the worker has in flight at once',
  DELIVERY_WORKER_POLL_INTERVAL_MS:
    'an integer from 100 to 60000: how long an idle lane waits before it looks for a due message again',
  DELIVERY_CAPTURE_DIRECTORY:
    'an absolute path, outside the checkout, to a directory only this user can read, without a ".." segment; required when a channel uses the capture adapter',
  DELIVERY_PROVIDER_APPROVAL_REF:
    'a reference of 4 to 64 letters, digits and . _ : - to the written approval of the controlled window; required in Staging with a real provider, absent with capture and in production',
  DELIVERY_PROVIDER_ALLOWLIST:
    'one to 50 comma-separated email addresses or numbers in the form of E.164, none repeated; required in Staging with a real provider, absent with capture and in production',
};

const FORBIDDEN_EVERYWHERE = {
  DATABASE_MIGRATION_URL:
    'absent: migration credentials must never be present in the worker environment',
  DATABASE_SEED_URL:
    'absent: provisioning credentials must never be present in the worker environment',
} as const;

const FORBIDDEN_WHEN_DEPLOYED_TEXT =
  "absent in Staging and Production: the delivery worker holds its own login and the credential_delivery key and nothing of the API's";
/** What a deployed worker's environment may not carry: the API's connection, and every key but its own. */
const FORBIDDEN_WHEN_DEPLOYED: readonly string[] = [
  'DATABASE_URL',
  ...KEY_PURPOSES.filter((purpose) => purpose !== 'credential_delivery').map((purpose) =>
    keyEnvName(purpose, 'MATERIAL'),
  ),
  'ATTESTATION_VERIFIER_CALLER_SECRET',
];

const expectedText = (key: string): string =>
  key in WORKER_EXPECTED ? WORKER_EXPECTED[key as WorkerOnlyKey] : EXPECTED[key as ConfigKey];

const OPTIONAL_WORKER_KEYS: readonly string[] = [
  'DELIVERY_CAPTURE_DIRECTORY',
  'DELIVERY_PROVIDER_APPROVAL_REF',
  'DELIVERY_PROVIDER_ALLOWLIST',
  ...OPTIONAL_KEYS.filter((key) => (WORKER_SHARED_KEYS as readonly string[]).includes(key)),
];

const pickShape = <K extends ConfigKey>(keys: readonly K[]): Pick<typeof envShape, K> =>
  Object.fromEntries(keys.map((key) => [key, envShape[key]])) as Pick<typeof envShape, K>;

const WORKER_NAME = /^[A-Za-z0-9._:-]{4,64}$/;

const workerSchema = z.object({
  ...pickShape(WORKER_SHARED_KEYS),
  DATABASE_WORKER_URL: z
    .string()
    .refine((url) => parsePostgresUrl(url)?.user === WORKER_RUNTIME_ROLE),
  DELIVERY_WORKER_CONCURRENCY: integerBetween(1, 32).default(
    Number(WORKER_DEFAULTS.DELIVERY_WORKER_CONCURRENCY),
  ),
  DELIVERY_WORKER_POLL_INTERVAL_MS: integerBetween(100, 60_000).default(
    Number(WORKER_DEFAULTS.DELIVERY_WORKER_POLL_INTERVAL_MS),
  ),
  DELIVERY_CAPTURE_DIRECTORY: z
    .string()
    .refine(
      (text) =>
        text.length <= 1024 &&
        !text.includes('\0') &&
        isAbsolute(text) &&
        !text.split(/[\\/]+/).includes('..'),
    )
    .optional(),
  DELIVERY_PROVIDER_APPROVAL_REF: z.string().regex(WORKER_NAME).optional(),
  DELIVERY_PROVIDER_ALLOWLIST: z
    .string()
    .refine((text) => parseAllowList(text) !== undefined)
    .optional(),
});

type ParsedEnv = z.infer<typeof workerSchema>;

export interface WorkerDeliveryConfig {
  readonly email: DeliveryAdapterConfig;
  readonly sms: DeliveryAdapterConfig;
  /** The most messages in flight at once: the number of lanes the worker runs. */
  readonly concurrency: number;
  /** How long an idle lane waits before it looks for a due message again. */
  readonly pollIntervalMs: number;
  /** Where the capture adapter's sink is, when a channel uses it. */
  readonly captureDirectory?: string;
  /** The controlled real-provider window, when a real provider is selected and the window is configured. */
  readonly providerWindow?: {
    readonly approvalRef: string;
    readonly allowList: readonly string[];
  };
}

export interface WorkerConfig {
  readonly nodeEnv: ParsedEnv['NODE_ENV'];
  readonly appEnv: ParsedEnv['APP_ENV'];
  readonly logLevel: ParsedEnv['LOG_LEVEL'];
  /** The one budget for the whole shutdown: stop claiming, finish or relinquish what is in flight, close the pool. */
  readonly shutdown: { readonly timeoutMs: number };
  /** Connects as `melarc_worker_runtime`. Carries the password, so it is never logged or echoed. */
  readonly database: {
    readonly url: string;
    readonly poolMax: number;
    readonly deadlines: DatabaseDeadlines;
  };
  /** The key material the worker holds: the `credential_delivery` purpose and no other. */
  readonly keys: KeyHolding;
  readonly delivery: WorkerDeliveryConfig;
}

export type LoadWorkerConfigResult =
  | { readonly ok: true; readonly config: WorkerConfig }
  | { readonly ok: false; readonly problems: readonly ConfigProblem[] };

const deliveryAdapter = (
  adapter: 'capture' | 'provider',
  endpoint: string | undefined,
  timeoutMs: number | undefined,
): DeliveryAdapterConfig =>
  adapter === 'provider' && endpoint !== undefined && timeoutMs !== undefined
    ? Object.freeze({ kind: 'provider', endpoint, timeoutMs })
    : Object.freeze({ kind: 'capture' });

/** The splitting an allow-list was validated by: the entries as written, trimmed, in order. */
const allowListEntries = (text: string): string[] => text.split(',').map((entry) => entry.trim());

function relationProblems(env: ParsedEnv): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  const invalid = (key: string, expected?: string): void => {
    problems.push({ key, problem: 'invalid', expected: expected ?? expectedText(key) });
  };
  const missing = (key: string): void => {
    problems.push({ key, problem: 'missing', expected: expectedText(key) });
  };

  // DEPLOYMENT_AND_ENVIRONMENTS.md §12.3: production permits no development-mode bypass.
  if (env.APP_ENV !== 'local' && env.NODE_ENV !== 'production') {
    invalid('NODE_ENV', 'production when APP_ENV is staging or production');
  }

  // SECURITY_DESIGN.md §14.6: lock wait inside statement time inside transaction time.
  if (env.DATABASE_LOCK_TIMEOUT_MS >= env.DATABASE_STATEMENT_TIMEOUT_MS) {
    invalid('DATABASE_LOCK_TIMEOUT_MS');
  }
  if (env.DATABASE_STATEMENT_TIMEOUT_MS >= env.DATABASE_TRANSACTION_TIMEOUT_MS) {
    invalid('DATABASE_STATEMENT_TIMEOUT_MS');
  }

  // SECURITY_DESIGN.md §14.9: the active version is one the purpose holds, and no key is used twice.
  const versions = parseKeyMaterial(String(env.KEY_CREDENTIAL_DELIVERY_MATERIAL)) ?? [];
  const active = Number(env.KEY_CREDENTIAL_DELIVERY_ACTIVE_VERSION);
  if (!versions.some(([version]) => version === active)) {
    invalid('KEY_CREDENTIAL_DELIVERY_ACTIVE_VERSION');
  }
  const seen = new Set(versions.map(([, key]) => key.reveal()));
  if (seen.size !== versions.length) invalid('KEY_CREDENTIAL_DELIVERY_MATERIAL');

  deliveryAdapterProblems(env, invalid, missing);

  const channels = [env.DELIVERY_EMAIL_ADAPTER, env.DELIVERY_SMS_ADAPTER];
  if (channels.includes('capture') && env.DELIVERY_CAPTURE_DIRECTORY === undefined) {
    missing('DELIVERY_CAPTURE_DIRECTORY');
  }

  // DEPLOYMENT_AND_ENVIRONMENTS.md §4.1: the window belongs to a real provider in Staging. The worker refuses to start in Staging with
  // one selected unless both are configured; it refuses them with capture (there is nothing to allow-list) and in production.
  const provider = channels.includes('provider');
  const window = [env.DELIVERY_PROVIDER_APPROVAL_REF, env.DELIVERY_PROVIDER_ALLOWLIST];
  const windowKeys = ['DELIVERY_PROVIDER_APPROVAL_REF', 'DELIVERY_PROVIDER_ALLOWLIST'] as const;
  if (env.APP_ENV === 'staging' && provider) {
    windowKeys.forEach((key, index) => {
      if (window[index] === undefined) missing(key);
    });
  } else if (!provider || env.APP_ENV === 'production') {
    windowKeys.forEach((key, index) => {
      if (window[index] !== undefined) invalid(key);
    });
  }
  return problems;
}

/**
 * What a configuration selects that its environment refuses (DEPLOYMENT_AND_ENVIRONMENTS.md §12.3), as the API refuses it. It judges
 * the built configuration, so it holds for one made by hand as for one made from the environment: the controlled window is judged
 * here too (a real provider in Staging without it, its settings in production), as well as on the environment, where the loader
 * names the key that is missing.
 */
function refusals(config: WorkerConfig): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  const refuse = (key: string): void => {
    problems.push({ key, problem: 'invalid', expected: expectedText(key) });
  };
  const provider =
    config.delivery.email.kind === 'provider' || config.delivery.sms.kind === 'provider';
  if (config.appEnv === 'production') {
    // There is no production key custody yet, so a production start is refused until a task builds one (OB-36).
    if (config.keys.custody === 'local') refuse('KEY_CUSTODY');
    if (config.delivery.email.kind === 'capture') refuse('DELIVERY_EMAIL_ADAPTER');
    if (config.delivery.sms.kind === 'capture') refuse('DELIVERY_SMS_ADAPTER');
    if (config.delivery.providerWindow !== undefined) {
      refuse('DELIVERY_PROVIDER_APPROVAL_REF');
      refuse('DELIVERY_PROVIDER_ALLOWLIST');
    }
  }
  if (config.appEnv === 'staging' && provider && config.delivery.providerWindow === undefined) {
    refuse('DELIVERY_PROVIDER_APPROVAL_REF');
    refuse('DELIVERY_PROVIDER_ALLOWLIST');
  }
  // A local run, and CI, which runs as one, uses the capture adapter only (OB-127, closed by the owner's decision of 11 October 2026).
  if (config.appEnv === 'local') {
    if (config.delivery.email.kind === 'provider') refuse('DELIVERY_EMAIL_ADAPTER');
    if (config.delivery.sms.kind === 'provider') refuse('DELIVERY_SMS_ADAPTER');
  }
  return problems;
}

/** A configuration was refused when it was judged again at composition. The message names the settings and never a value. */
export class WorkerConfigRefusedError extends Error {
  constructor(readonly keys: readonly string[]) {
    super(`The delivery worker's configuration is refused: ${keys.join(', ')}`);
    this.name = 'WorkerConfigRefusedError';
  }
}

/**
 * Judges a built configuration again, as the loader does, and refuses what its environment refuses. The loader judges the
 * environment; a configuration made by hand (a test, a later composition) comes here, so the rules hold for it as well.
 */
export function assertWorkerConfigAccepted(config: WorkerConfig): void {
  const refused = refusals(config);
  if (refused.length > 0) throw new WorkerConfigRefusedError(refused.map((problem) => problem.key));
}

function keysFrom(env: ParsedEnv): KeyHolding {
  const versions = Object.fromEntries(
    parseKeyMaterial(String(env.KEY_CREDENTIAL_DELIVERY_MATERIAL)) ?? [],
  ) as Record<number, Secret>;
  const delivery: PurposeKeys = Object.freeze({
    activeVersion: Number(env.KEY_CREDENTIAL_DELIVERY_ACTIVE_VERSION),
    versions: Object.freeze(versions),
  });
  return Object.freeze({
    custody: 'local',
    purposes: Object.freeze({ credential_delivery: delivery }),
  });
}

/** One problem per forbidden variable that is set. An empty value, as a copied template leaves, is absent. */
function forbiddenProblems(env: Readonly<Record<string, string | undefined>>): ConfigProblem[] {
  const set = (key: string): boolean => (env[key] ?? '') !== '';
  const everywhere = Object.entries(FORBIDDEN_EVERYWHERE).filter(([key]) => set(key));
  const deployed = env.APP_ENV === 'local' ? [] : FORBIDDEN_WHEN_DEPLOYED.filter(set);
  return [
    ...everywhere.map(([key, expected]) => ({ key, problem: 'invalid' as const, expected })),
    ...deployed.map((key) => ({
      key,
      problem: 'invalid' as const,
      expected: FORBIDDEN_WHEN_DEPLOYED_TEXT,
    })),
  ];
}

/** Validates the process environment for the delivery worker. Pure: reads only the keys the worker owns or shares. */
export function loadWorkerConfig(
  env: Readonly<Record<string, string | undefined>>,
): LoadWorkerConfigResult {
  // A blank optional setting is an absent one: a copied template leaves its optional lines empty.
  const input = Object.fromEntries(
    WORKER_CONFIG_KEYS.map((key) => [
      key,
      OPTIONAL_WORKER_KEYS.includes(key) && env[key] === '' ? undefined : env[key],
    ]),
  );
  const forbidden = forbiddenProblems(env);
  const parsed = workerSchema.safeParse(input);
  if (!parsed.success) {
    const failing = new Set(parsed.error.issues.map((issue) => issue.path[0]));
    const problems: ConfigProblem[] = WORKER_CONFIG_KEYS.filter((key) => failing.has(key)).map(
      (key) => ({
        key,
        problem: input[key] === undefined ? 'missing' : 'invalid',
        expected: expectedText(key),
      }),
    );
    return { ok: false, problems: [...problems, ...forbidden] };
  }

  const values = parsed.data;
  const problems = [...relationProblems(values), ...forbidden];
  if (problems.length > 0) return { ok: false, problems };

  const window =
    values.DELIVERY_PROVIDER_APPROVAL_REF !== undefined &&
    values.DELIVERY_PROVIDER_ALLOWLIST !== undefined
      ? Object.freeze({
          approvalRef: values.DELIVERY_PROVIDER_APPROVAL_REF,
          allowList: Object.freeze(allowListEntries(values.DELIVERY_PROVIDER_ALLOWLIST)),
        })
      : undefined;
  const config: WorkerConfig = {
    nodeEnv: values.NODE_ENV,
    appEnv: values.APP_ENV,
    logLevel: values.LOG_LEVEL,
    shutdown: Object.freeze({ timeoutMs: values.SHUTDOWN_TIMEOUT_MS }),
    database: Object.freeze({
      url: values.DATABASE_WORKER_URL,
      // One connection for each lane, one to poll and one for the cleanup: nothing is held across a send.
      poolMax: values.DELIVERY_WORKER_CONCURRENCY + 2,
      deadlines: Object.freeze({
        acquireTimeoutMs: values.DATABASE_ACQUIRE_TIMEOUT_MS,
        lockTimeoutMs: values.DATABASE_LOCK_TIMEOUT_MS,
        statementTimeoutMs: values.DATABASE_STATEMENT_TIMEOUT_MS,
        idleInTransactionTimeoutMs: values.DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS,
        transactionTimeoutMs: values.DATABASE_TRANSACTION_TIMEOUT_MS,
        maxWaiters: values.DATABASE_POOL_MAX_WAITERS,
      }),
    }),
    keys: keysFrom(values),
    delivery: Object.freeze({
      email: deliveryAdapter(
        values.DELIVERY_EMAIL_ADAPTER,
        values.DELIVERY_EMAIL_ENDPOINT,
        values.DELIVERY_EMAIL_TIMEOUT_MS,
      ),
      sms: deliveryAdapter(
        values.DELIVERY_SMS_ADAPTER,
        values.DELIVERY_SMS_ENDPOINT,
        values.DELIVERY_SMS_TIMEOUT_MS,
      ),
      concurrency: values.DELIVERY_WORKER_CONCURRENCY,
      pollIntervalMs: values.DELIVERY_WORKER_POLL_INTERVAL_MS,
      ...(values.DELIVERY_CAPTURE_DIRECTORY === undefined
        ? {}
        : { captureDirectory: values.DELIVERY_CAPTURE_DIRECTORY }),
      ...(window === undefined ? {} : { providerWindow: window }),
    }),
  };

  const refused = refusals(config);
  if (refused.length > 0) return { ok: false, problems: refused };
  return { ok: true, config: Object.freeze(config) };
}
