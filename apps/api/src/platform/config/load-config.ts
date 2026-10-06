import { z } from 'zod';

import { parsePostgresUrl } from '../database/postgres-url.js';

const NODE_ENVS = ['development', 'test', 'production'] as const;
const APP_ENVS = ['local', 'staging', 'production'] as const;
const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

/** The only database identity the API connects as (SECURITY_DESIGN.md §14.17). */
export const API_RUNTIME_ROLE = 'melarc_api_runtime';

export interface DatabaseConfig {
  /** Connects as the runtime identity. Carries the password, so it is never logged or echoed. */
  readonly url: string;
  /** The most connections the API keeps open. */
  readonly poolMax: number;
}

export interface AppConfig {
  /** Framework mode. Express and other libraries read the same variable directly. */
  readonly nodeEnv: (typeof NODE_ENVS)[number];
  /** The Melarc environment (DEPLOYMENT_AND_ENVIRONMENTS.md §3). */
  readonly appEnv: (typeof APP_ENVS)[number];
  readonly http: { readonly host: string; readonly port: number };
  readonly logLevel: (typeof LOG_LEVELS)[number];
  readonly shutdown: { readonly timeoutMs: number; readonly drainDelayMs: number };
  /**
   * Always present in a configuration that `loadConfig` returns, so the real API cannot start without
   * a database. It is optional in the type only so that code that builds a configuration by hand, the
   * OpenAPI generator and the unit tests that need no database, does not need a live dependency.
   */
  readonly database?: DatabaseConfig;
}

export interface ConfigProblem {
  readonly key: string;
  readonly problem: 'missing' | 'invalid';
  /** What a valid value looks like. Static text: never built from what was supplied. */
  readonly expected: string;
}

export type LoadConfigResult =
  | { readonly ok: true; readonly config: AppConfig }
  | { readonly ok: false; readonly problems: readonly ConfigProblem[] };

const EXPECTED = {
  NODE_ENV: `one of: ${NODE_ENVS.join(', ')}`,
  APP_ENV: `one of: ${APP_ENVS.join(', ')}`,
  HTTP_HOST: 'a host name or IP address without spaces',
  HTTP_PORT: 'an integer from 1 to 65535',
  LOG_LEVEL: `one of: ${LOG_LEVELS.join(', ')}`,
  SHUTDOWN_TIMEOUT_MS: 'an integer from 1000 to 300000',
  SHUTDOWN_DRAIN_DELAY_MS: 'an integer from 0 to 60000',
  DATABASE_URL: `a postgres:// or postgresql:// URL naming a host, one database and the user ${API_RUNTIME_ROLE}, with no query string or fragment`,
  DATABASE_POOL_MAX: 'an integer from 1 to 100',
} as const;

type ConfigKey = keyof typeof EXPECTED;

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

const integerBetween = (min: number, max: number) =>
  z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(min).max(max));

const envSchema = z.object({
  NODE_ENV: z.enum(NODE_ENVS),
  APP_ENV: z.enum(APP_ENVS),
  HTTP_HOST: z
    .string()
    .regex(/^[A-Za-z0-9._:-]+$/)
    .default('127.0.0.1'),
  HTTP_PORT: integerBetween(1, 65535),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  SHUTDOWN_TIMEOUT_MS: integerBetween(1000, 300_000).default(15_000),
  SHUTDOWN_DRAIN_DELAY_MS: integerBetween(0, 60_000).default(0),
  DATABASE_URL: z.string().refine((url) => parsePostgresUrl(url)?.user === API_RUNTIME_ROLE),
  DATABASE_POOL_MAX: integerBetween(1, 100).default(10),
});

type ParsedEnv = z.infer<typeof envSchema>;

/**
 * Rules that relate two keys. They run only once every key is individually valid, so a bad value
 * is reported once, against its own key, and never judged against another one.
 */
function relationProblems(env: ParsedEnv): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  // DEPLOYMENT_AND_ENVIRONMENTS.md §12.3: production permits no development-mode bypass.
  if (env.APP_ENV !== 'local' && env.NODE_ENV !== 'production') {
    problems.push({
      key: 'NODE_ENV',
      problem: 'invalid',
      expected: 'production when APP_ENV is staging or production',
    });
  }
  if (env.SHUTDOWN_DRAIN_DELAY_MS >= env.SHUTDOWN_TIMEOUT_MS) {
    problems.push({
      key: 'SHUTDOWN_DRAIN_DELAY_MS',
      problem: 'invalid',
      expected: 'less than SHUTDOWN_TIMEOUT_MS',
    });
  }
  return problems;
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

/** Validates the process environment. Pure: reads only the keys this API owns. */
export function loadConfig(env: Readonly<Record<string, string | undefined>>): LoadConfigResult {
  const input = Object.fromEntries(KEYS.map((key) => [key, env[key]]));
  const forbidden = forbiddenProblems(env);
  const parsed = envSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, problems: [...toProblems(parsed.error.issues, input), ...forbidden] };
  }

  const values = parsed.data;
  const problems = [...relationProblems(values), ...forbidden];
  if (problems.length > 0) return { ok: false, problems };

  const config: AppConfig = {
    nodeEnv: values.NODE_ENV,
    appEnv: values.APP_ENV,
    http: Object.freeze({ host: values.HTTP_HOST, port: values.HTTP_PORT }),
    logLevel: values.LOG_LEVEL,
    shutdown: Object.freeze({
      timeoutMs: values.SHUTDOWN_TIMEOUT_MS,
      drainDelayMs: values.SHUTDOWN_DRAIN_DELAY_MS,
    }),
    database: Object.freeze({ url: values.DATABASE_URL, poolMax: values.DATABASE_POOL_MAX }),
  };
  return { ok: true, config: Object.freeze(config) };
}
