import { homedir } from 'node:os';
import { join } from 'node:path';

import { WORKER_RUNTIME_ROLE } from '../../platform/database/technical-roles.js';
import { readLocalPostgres } from '../database/local-env.js';
import { localLoginPassword } from '../database/local-logins.js';
import { buildDatabaseUrl } from '../database/provisioning.js';
import { assertLocalHost } from '../database/safety.js';

/**
 * What a **local** run of the delivery worker is given when its settings leave it out (S0.18), so that
 * `pnpm --filter @melarc/api run start:worker:local` works on a machine that has been through `setup:env`, as `db:seed` does
 * (`tools/seed/seed-command.ts`):
 *
 * - **Its login.** The worker connects as `melarc_worker_runtime`. A local cluster gives it a password derived from the
 *   administrator's (`localLoginPassword`), so there is no `MELARC_PG_*` setting of its own and an existing settings file keeps
 *   working. The derivation exists for a cluster on this machine only, and a server that is not is refused.
 * - **Its sink.** The capture adapter writes where the settings say; a local run with none says writes under the developer's own
 *   home (`~/.melarc/capture`), outside the repository and private to the user.
 *
 * Only `APP_ENV=local` is given anything. A deployed environment names its login and its sink itself, and an environment that
 * says nothing is not assumed to be local. Nothing here is read, derived or looked for when the setting is present.
 */

/** The facts a local default is made from, which a test replaces. */
export interface LocalWorkerDefaults {
  /** The local worker login's URL. Called only when no `DATABASE_WORKER_URL` was given. */
  readonly localUrl: () => string;
  readonly homeDirectory: () => string;
}

export const realLocalWorkerDefaults: LocalWorkerDefaults = {
  localUrl: () => localWorkerUrl(),
  homeDirectory: () => homedir(),
};

/** The worker's login on the development database of this machine, from the local settings. It refuses a server that is not local. */
export function localWorkerUrl(
  options: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly envFile?: string;
  } = {},
): string {
  const local = readLocalPostgres(options);
  assertLocalHost(local.host);
  return buildDatabaseUrl({
    host: local.host,
    port: local.port,
    user: WORKER_RUNTIME_ROLE,
    password: localLoginPassword(local.adminPassword, WORKER_RUNTIME_ROLE),
    database: 'melarc_dev',
  });
}

const absent = (value: string | undefined): boolean => value === undefined || value === '';

export function withLocalWorkerDefaults(
  env: Readonly<Record<string, string | undefined>>,
  defaults: LocalWorkerDefaults = realLocalWorkerDefaults,
): Record<string, string | undefined> {
  if (env.APP_ENV !== 'local') return { ...env };
  return {
    ...env,
    ...(absent(env.DATABASE_WORKER_URL) ? { DATABASE_WORKER_URL: defaults.localUrl() } : {}),
    ...(absent(env.DELIVERY_CAPTURE_DIRECTORY)
      ? { DELIVERY_CAPTURE_DIRECTORY: join(defaults.homeDirectory(), '.melarc', 'capture') }
      : {}),
  };
}
