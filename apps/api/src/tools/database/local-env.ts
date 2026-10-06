import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

/** Where `infrastructure/postgres/compose.yaml` expects the generated settings. Git-ignored. */
export const DEFAULT_ENV_FILE = fileURLToPath(
  new URL('../../../../../infrastructure/postgres/.env', import.meta.url),
);

/** The local PostgreSQL server the tools talk to, and the three passwords provisioning sets on it. */
export interface LocalPostgres {
  readonly host: string;
  readonly port: number;
  readonly adminPassword: string;
  readonly migrationPassword: string;
  readonly runtimePassword: string;
}

/** The local database is not set up. The message names settings, never their values. */
export class LocalPostgresNotConfiguredError extends Error {
  constructor(problems: readonly string[]) {
    super(
      `local PostgreSQL is not configured: ${problems.join('; ')}. Copy infrastructure/postgres/.env.example to ` +
        'infrastructure/postgres/.env with real passwords and start the container from ' +
        'infrastructure/postgres/compose.yaml, or set the MELARC_PG_* variables.',
    );
    this.name = 'LocalPostgresNotConfiguredError';
  }
}

const PLACEHOLDER = 'CHANGE_ME';

/**
 * Reads the `MELARC_PG_*` settings from `env`, falling back to the env file for anything the environment
 * leaves unset or empty. An explicit environment value always wins, so a run can be pointed elsewhere
 * without editing the file.
 */
export function readLocalPostgres(
  options: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly envFile?: string;
  } = {},
): LocalPostgres {
  const env = options.env ?? process.env;
  const envFile = options.envFile ?? DEFAULT_ENV_FILE;
  const fromFile = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {};

  const read = (key: string): string | undefined => {
    const value = env[key] === undefined || env[key] === '' ? fromFile[key] : env[key];
    return value === undefined || value === '' ? undefined : value;
  };

  const problems: string[] = [];
  const password = (key: string): string => {
    const value = read(key);
    if (value === undefined) problems.push(`${key} is not set`);
    else if (value === PLACEHOLDER) problems.push(`${key} is still the ${PLACEHOLDER} placeholder`);
    return value ?? '';
  };

  const adminPassword = password('MELARC_PG_ADMIN_PASSWORD');
  const migrationPassword = password('MELARC_PG_MIGRATION_PASSWORD');
  const runtimePassword = password('MELARC_PG_RUNTIME_PASSWORD');

  // Each role has its own password: the migration role can create objects and act as the owner, and the runtime
  // role must be able to do neither, which a password they share would not keep true.
  const passwords = [adminPassword, migrationPassword, runtimePassword].filter(
    (value) => value !== '',
  );
  if (new Set(passwords).size !== passwords.length) {
    problems.push(
      'MELARC_PG_ADMIN_PASSWORD, MELARC_PG_MIGRATION_PASSWORD and MELARC_PG_RUNTIME_PASSWORD must all differ',
    );
  }

  const rawPort = read('MELARC_PG_PORT') ?? '5432';
  const port = /^\d{1,5}$/.test(rawPort) ? Number(rawPort) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    problems.push('MELARC_PG_PORT must be an integer from 1 to 65535');
  }

  if (problems.length > 0) throw new LocalPostgresNotConfiguredError(problems);
  return {
    host: read('MELARC_PG_HOST') ?? '127.0.0.1',
    port,
    adminPassword,
    migrationPassword,
    runtimePassword,
  };
}
