import { z } from 'zod';

import { ARGON2ID_LIMITS } from '../auth/crypto/argon2-parameters.js';
import { parsePostgresUrl } from '../database/postgres-url.js';
import { parseAcceptedProfiles } from './credential-hashing.js';
import { keyEnvName, parseKeyMaterial, perKeySetting } from './key-material.js';
import { parseOrigin } from './origins.js';
import { parseTrustProxy } from './trust-proxy.js';

/** The only database identity the API connects as (SECURITY_DESIGN.md §14.17). */
export const API_RUNTIME_ROLE = 'melarc_api_runtime';

export const NODE_ENVS = ['development', 'test', 'production'] as const;
export const APP_ENVS = ['local', 'staging', 'production'] as const;
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export const LIMITERS = ['postgres', 'memory'] as const;
export const DELIVERY_ADAPTERS = ['capture', 'provider'] as const;
export const VERIFIER_KINDS = ['substitute', 'service'] as const;
export const KEY_CUSTODIES = ['local'] as const;

/**
 * The engineering bounds this task introduces, each with the value an environment gets when it sets none
 * (plan section 3, "Engineering parameters").
 *
 * **Provisional until their first consumer.** Each is a concrete value chosen so that a development or test run is bounded. The
 * loader checks it against its bounds and, for the database deadlines, their nesting, and `load-config.test.ts` proves the
 * bounds and the relations and nothing about behaviour. The engineering-parameter rule of the plan (section 3) puts the
 * qualification with the first consumer, which chooses a measured development or test value, records the environment and the
 * test, and labels the value development-qualified, not production-qualified. S0.6 (resource deadlines) has done so for the
 * database deadlines and S0.20 (transport admission) for the HTTP limits and deadlines and the request budget
 * (DEPLOYMENT_AND_ENVIRONMENTS.md section 12.5); S0.18 (delivery worker process) still owes it for the provider timeouts, which
 * no real provider applies yet. S0.65 (benchmark and capacity) then calibrates all of them on a recorded machine and proposes
 * release values for the owner's approval.
 */
export const ENGINEERING_DEFAULTS = {
  HTTP_BODY_LIMIT_BYTES: '102400',
  HTTP_HEADER_TIMEOUT_MS: '10000',
  HTTP_BODY_TIMEOUT_MS: '10000',
  HTTP_ADMISSION_TIMEOUT_MS: '2000',
  HTTP_ADMISSION_CONCURRENCY: '64',
  DATABASE_ACQUIRE_TIMEOUT_MS: '5000',
  DATABASE_LOCK_TIMEOUT_MS: '2000',
  DATABASE_STATEMENT_TIMEOUT_MS: '5000',
  DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: '5000',
  DATABASE_TRANSACTION_TIMEOUT_MS: '10000',
  DATABASE_POOL_MAX_WAITERS: '50',
  REQUEST_EXECUTION_BUDGET_MS: '15000',
} as const;

/**
 * The credential-hashing profile new hashes are written at (SECURITY_DESIGN.md §13.4): the development-qualified one, which
 * `argon2-parameters.ts` records the measurement of and `credential-hashing.test.ts` ties these strings to. **Not
 * production-qualified.** Unlike the resource defaults above it has been measured, on one development machine; S0.65 proposes the
 * release profile. Staging and production refuse a profile below `ARGON2ID_DEPLOYED_FLOOR`.
 */
export const HASHING_DEFAULTS = {
  ARGON2_MEMORY_KIB: '65536',
  ARGON2_PASSES: '2',
  ARGON2_PARALLELISM: '1',
} as const;

/**
 * Hash admission (SECURITY_DESIGN.md §13.4c): how many password hashes may run at once, and the memory they may take together.
 * **Development-qualified, not production-qualified** (S0.16; S0.65 proposes the release figures). The slot count is below the
 * libuv pool of four that hashing shares with the rest of the process, so that hashing never takes every thread; the memory
 * budget holds the slots at the largest profile that may be derived (`hashingProblems` in `load-config.ts`). The deployment record
 * of what was measured and where is DEPLOYMENT_AND_ENVIRONMENTS.md §12.5, "What S0.16 applied and where it was exercised".
 */
export const HASH_ADMISSION_DEFAULTS = {
  HASH_ADMISSION_SLOTS: '2',
  HASH_ADMISSION_MEMORY_BUDGET_MIB: '256',
} as const;

const ENDPOINT_TEXT =
  'an https URL (http only to a loopback host when APP_ENV is local) with no user information, query or fragment';
const KEY_TEXT =
  'one to eight comma-separated <version>:<key> entries, a version being a positive integer without leading zeros and a key 32 random bytes as 43 unpadded base64url characters, every key different from every other';

const keyExpected = perKeySetting((purpose, part) =>
  part === 'MATERIAL'
    ? KEY_TEXT
    : `an integer from 1 to 999999 naming one of the versions in ${keyEnvName(purpose, 'MATERIAL')}`,
);

/** What a valid value looks like, per key. Static text: never built from what was supplied. */
export const EXPECTED = {
  NODE_ENV: `one of: ${NODE_ENVS.join(', ')}`,
  APP_ENV: `one of: ${APP_ENVS.join(', ')}`,
  HTTP_HOST: 'a host name or IP address without spaces',
  HTTP_PORT: 'an integer from 1 to 65535',
  LOG_LEVEL: `one of: ${LOG_LEVELS.join(', ')}`,
  SHUTDOWN_TIMEOUT_MS: 'an integer from 1000 to 300000',
  SHUTDOWN_DRAIN_DELAY_MS: 'an integer from 0 to 60000',
  DATABASE_URL: `a postgres:// or postgresql:// URL naming a host, one database and the user ${API_RUNTIME_ROLE}, with no query string or fragment`,
  DATABASE_POOL_MAX: 'an integer from 1 to 100',
  DATABASE_ACQUIRE_TIMEOUT_MS: 'an integer from 100 to 60000',
  DATABASE_LOCK_TIMEOUT_MS: 'an integer from 100 to 60000, less than DATABASE_STATEMENT_TIMEOUT_MS',
  DATABASE_STATEMENT_TIMEOUT_MS:
    'an integer from 100 to 120000, less than DATABASE_TRANSACTION_TIMEOUT_MS',
  DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: 'an integer from 100 to 120000',
  DATABASE_TRANSACTION_TIMEOUT_MS: 'an integer from 100 to 300000',
  DATABASE_POOL_MAX_WAITERS: 'an integer from 1 to 10000',
  REQUEST_EXECUTION_BUDGET_MS: 'an integer from 1000 to 300000',
  OPS_ORIGIN:
    'an exact browser origin: http or https, a host and an optional port, with no path, query, fragment or trailing slash; https unless APP_ENV is local',
  VENDOR_ORIGIN:
    'an exact browser origin, as OPS_ORIGIN, and different from it; https unless APP_ENV is local',
  HTTP_TRUST_PROXY:
    'off, or up to 16 comma-separated trusted hops, each an IP address or an address with a prefix length of at least 1 (never a count, true, a wildcard or a host name)',
  HTTP_BODY_LIMIT_BYTES: 'an integer from 1024 to 1048576',
  HTTP_HEADER_TIMEOUT_MS: 'an integer from 1000 to 60000',
  HTTP_BODY_TIMEOUT_MS: 'an integer from 1000 to 120000',
  HTTP_ADMISSION_TIMEOUT_MS: 'an integer from 100 to 30000',
  HTTP_ADMISSION_CONCURRENCY: 'an integer from 1 to 10000',
  RATE_LIMITER: `one of: ${LIMITERS.join(', ')}; memory only when APP_ENV is local`,
  KEY_CUSTODY: `one of: ${KEY_CUSTODIES.join(', ')}; the local substitute is refused when APP_ENV is production`,
  ...keyExpected,
  ARGON2_MEMORY_KIB: `an integer from 8 to ${String(ARGON2ID_LIMITS.maxMemoryKiB)}, at least 8 and a multiple of 4 per lane (ARGON2_PARALLELISM); staging and production refuse less than 19456`,
  ARGON2_PASSES: `an integer from 1 to ${String(ARGON2ID_LIMITS.maxPasses)}; staging and production refuse fewer than 2`,
  ARGON2_PARALLELISM: `an integer from 1 to ${String(ARGON2ID_LIMITS.maxParallelism)}`,
  ARGON2_ACCEPTED_PROFILES:
    'absent, or one to eight comma-separated <memory KiB>:<passes>:<lanes> profiles, each valid as above, none repeated and none the write profile',
  HASH_ADMISSION_SLOTS:
    'an integer from 1 to 64 such that the slots, each at the largest memory of the write profile and every accepted profile, fit HASH_ADMISSION_MEMORY_BUDGET_MIB',
  HASH_ADMISSION_MEMORY_BUDGET_MIB:
    'an integer from 64 to 65536: the memory, in MiB, that the hash slots may take together',
  DELIVERY_EMAIL_ADAPTER: `one of: ${DELIVERY_ADAPTERS.join(', ')}; capture is refused when APP_ENV is production`,
  DELIVERY_EMAIL_ENDPOINT: `${ENDPOINT_TEXT}; required with provider, absent with capture`,
  DELIVERY_EMAIL_TIMEOUT_MS:
    'an integer from 100 to 60000; required with provider, absent with capture',
  DELIVERY_SMS_ADAPTER: `one of: ${DELIVERY_ADAPTERS.join(', ')}; capture is refused when APP_ENV is production`,
  DELIVERY_SMS_ENDPOINT: `${ENDPOINT_TEXT}; required with provider, absent with capture`,
  DELIVERY_SMS_TIMEOUT_MS:
    'an integer from 100 to 60000; required with provider, absent with capture',
  ATTESTATION_VERIFIER: `one of: ${VERIFIER_KINDS.join(', ')}; substitute is refused when APP_ENV is production`,
  ATTESTATION_VERIFIER_URL: `${ENDPOINT_TEXT}; required with service, absent with substitute`,
  ATTESTATION_VERIFIER_TIMEOUT_MS:
    'an integer from 100 to 60000; required with service, absent with substitute',
  ATTESTATION_VERIFIER_CALLER_SECRET:
    'a 32-byte key as 43 unpadded base64url characters; required with service when the URL is not on a loopback host, absent with substitute',
} as const satisfies Record<string, string>;

export type ConfigKey = keyof typeof EXPECTED;

/** Keys that mean "not set" when blank, because a copied template leaves them empty and their meaning is "absent". */
export const OPTIONAL_KEYS: readonly ConfigKey[] = [
  'ARGON2_ACCEPTED_PROFILES',
  'DELIVERY_EMAIL_ENDPOINT',
  'DELIVERY_EMAIL_TIMEOUT_MS',
  'DELIVERY_SMS_ENDPOINT',
  'DELIVERY_SMS_TIMEOUT_MS',
  'ATTESTATION_VERIFIER_URL',
  'ATTESTATION_VERIFIER_TIMEOUT_MS',
  'ATTESTATION_VERIFIER_CALLER_SECRET',
];

export const integerBetween = (min: number, max: number) =>
  z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(min).max(max));

/** An endpoint a service is reached at: http or https, a host, no user information, query or fragment, a path allowed. */
export function parseEndpoint(text: string): URL | undefined {
  if (text.length > 2048 || !/^https?:\/\/[^\s?#@]+$/.test(text)) return undefined;
  try {
    const url = new URL(text);
    return url.username === '' && url.password === '' && url.hostname !== '' ? url : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a URL's host is on the local machine: the only place plain http is accepted, and only when APP_ENV is local. */
export const isLoopbackHost = (url: URL): boolean =>
  ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
  /^127\.\d+\.\d+\.\d+$/.test(url.hostname);

const canonicalKey = z.string().refine((text) => parseKeyMaterial(`1:${text}`) !== undefined);
const endpoint = z.string().refine((text) => parseEndpoint(text) !== undefined);
const keyShape = perKeySetting((_purpose, part) =>
  part === 'MATERIAL'
    ? z.string().refine((text) => parseKeyMaterial(text) !== undefined)
    : integerBetween(1, 999_999),
);

/** The schema of the whole environment. The relations between keys are judged afterwards, once each key is valid alone. */
export const envShape = {
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
  DATABASE_ACQUIRE_TIMEOUT_MS: integerBetween(100, 60_000).default(5_000),
  DATABASE_LOCK_TIMEOUT_MS: integerBetween(100, 60_000).default(2_000),
  DATABASE_STATEMENT_TIMEOUT_MS: integerBetween(100, 120_000).default(5_000),
  DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: integerBetween(100, 120_000).default(5_000),
  DATABASE_TRANSACTION_TIMEOUT_MS: integerBetween(100, 300_000).default(10_000),
  DATABASE_POOL_MAX_WAITERS: integerBetween(1, 10_000).default(50),
  REQUEST_EXECUTION_BUDGET_MS: integerBetween(1_000, 300_000).default(15_000),
  OPS_ORIGIN: z.string().refine((text) => parseOrigin(text) !== undefined),
  VENDOR_ORIGIN: z.string().refine((text) => parseOrigin(text) !== undefined),
  HTTP_TRUST_PROXY: z
    .string()
    .refine((text) => parseTrustProxy(text) !== undefined)
    .default('off'),
  HTTP_BODY_LIMIT_BYTES: integerBetween(1024, 1_048_576).default(102_400),
  HTTP_HEADER_TIMEOUT_MS: integerBetween(1000, 60_000).default(10_000),
  HTTP_BODY_TIMEOUT_MS: integerBetween(1000, 120_000).default(10_000),
  HTTP_ADMISSION_TIMEOUT_MS: integerBetween(100, 30_000).default(2_000),
  HTTP_ADMISSION_CONCURRENCY: integerBetween(1, 10_000).default(64),
  RATE_LIMITER: z.enum(LIMITERS).default('postgres'),
  KEY_CUSTODY: z.enum(KEY_CUSTODIES),
  ...keyShape,
  ARGON2_MEMORY_KIB: integerBetween(8, ARGON2ID_LIMITS.maxMemoryKiB).default(65_536),
  ARGON2_PASSES: integerBetween(1, ARGON2ID_LIMITS.maxPasses).default(2),
  ARGON2_PARALLELISM: integerBetween(1, ARGON2ID_LIMITS.maxParallelism).default(1),
  ARGON2_ACCEPTED_PROFILES: z
    .string()
    .refine((text) => parseAcceptedProfiles(text) !== undefined)
    .optional(),
  HASH_ADMISSION_SLOTS: integerBetween(1, 64).default(2),
  HASH_ADMISSION_MEMORY_BUDGET_MIB: integerBetween(64, 65_536).default(256),
  DELIVERY_EMAIL_ADAPTER: z.enum(DELIVERY_ADAPTERS).default('capture'),
  DELIVERY_EMAIL_ENDPOINT: endpoint.optional(),
  DELIVERY_EMAIL_TIMEOUT_MS: integerBetween(100, 60_000).optional(),
  DELIVERY_SMS_ADAPTER: z.enum(DELIVERY_ADAPTERS).default('capture'),
  DELIVERY_SMS_ENDPOINT: endpoint.optional(),
  DELIVERY_SMS_TIMEOUT_MS: integerBetween(100, 60_000).optional(),
  ATTESTATION_VERIFIER: z.enum(VERIFIER_KINDS).default('substitute'),
  ATTESTATION_VERIFIER_URL: endpoint.optional(),
  ATTESTATION_VERIFIER_TIMEOUT_MS: integerBetween(100, 60_000).optional(),
  ATTESTATION_VERIFIER_CALLER_SECRET: canonicalKey.optional(),
} satisfies Record<ConfigKey, z.ZodType>;
