import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WORKER_RUNTIME_ROLE } from '../../platform/database/technical-roles.js';
import { LocalPostgresNotConfiguredError } from '../database/local-env.js';
import { localLoginPassword } from '../database/local-logins.js';
import { localWorkerUrl, withLocalWorkerDefaults } from './worker-local-env.js';

const URL_GIVEN = 'postgres://melarc_worker_runtime:given@db.example.test:5432/melarc_dev';

let directory: string;
let envFile: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'melarc-worker-env-test-'));
  envFile = join(directory, 'pg.env');
  await writeFile(
    envFile,
    [
      'MELARC_PG_ADMIN_PASSWORD=admin-secret-for-the-test',
      'MELARC_PG_MIGRATION_PASSWORD=migration-secret-for-the-test',
      'MELARC_PG_RUNTIME_PASSWORD=runtime-secret-for-the-test',
      '',
    ].join('\n'),
  );
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('the local defaults of the delivery worker (S0.18)', () => {
  // Break caught: the worker logging in as another identity locally, or with a password that is not the one the tools gave it.
  it('derives the worker’s own login on the local cluster, as the tools set it', () => {
    const url = new URL(localWorkerUrl({ env: {}, envFile }));

    expect(url.username).toBe(WORKER_RUNTIME_ROLE);
    expect(decodeURIComponent(url.password)).toBe(
      localLoginPassword('admin-secret-for-the-test', WORKER_RUNTIME_ROLE),
    );
    expect(url.hostname).toBe('127.0.0.1');
    expect(url.pathname).toBe('/melarc_dev');
  });

  // Break caught: a derived credential aimed at a server that is not this machine's (the derivation exists for a local cluster only).
  it('refuses a server that is not on this machine', () => {
    expect(() => localWorkerUrl({ env: { MELARC_PG_HOST: 'db.example.test' }, envFile })).toThrow(
      /local/i,
    );
  });

  // Break caught: a local default that says nothing when the cluster is not set up, or that repeats a password in saying so.
  it('says what is missing, naming settings and never their values', () => {
    const attempt = () => localWorkerUrl({ env: {}, envFile: join(directory, 'absent.env') });

    expect(attempt).toThrow(LocalPostgresNotConfiguredError);
    try {
      attempt();
    } catch (error) {
      expect((error as Error).message).toContain('MELARC_PG_ADMIN_PASSWORD');
      expect((error as Error).message).not.toContain('secret-for-the-test');
    }
  });

  const deps = {
    localUrl: () => 'postgres://derived',
    homeDirectory: () => join('home', 'dev'),
  };

  // Break caught: the defaults missing for a local run, or applied over what the developer set.
  it('fills the worker’s login and its sink in a local run, and leaves what is set alone', () => {
    expect(withLocalWorkerDefaults({ APP_ENV: 'local' }, deps)).toEqual({
      APP_ENV: 'local',
      DATABASE_WORKER_URL: 'postgres://derived',
      DELIVERY_CAPTURE_DIRECTORY: join('home', 'dev', '.melarc', 'capture'),
    });
    expect(
      withLocalWorkerDefaults(
        {
          APP_ENV: 'local',
          DATABASE_WORKER_URL: URL_GIVEN,
          DELIVERY_CAPTURE_DIRECTORY: '/own/sink',
        },
        deps,
      ),
    ).toEqual({
      APP_ENV: 'local',
      DATABASE_WORKER_URL: URL_GIVEN,
      DELIVERY_CAPTURE_DIRECTORY: '/own/sink',
    });
    // A copied template leaves its lines empty, which is absent.
    expect(
      withLocalWorkerDefaults(
        { APP_ENV: 'local', DATABASE_WORKER_URL: '', DELIVERY_CAPTURE_DIRECTORY: '' },
        deps,
      ),
    ).toMatchObject({ DATABASE_WORKER_URL: 'postgres://derived' });
  });

  // Break caught: a deployed environment (or one that says nothing) being given a local default: a derived password for a cluster that is
  // not this machine's, or a sink in a home directory of a server.
  it.each([['staging'], ['production'], [undefined], ['']])(
    'gives nothing to an environment whose APP_ENV is %j, and does not look for the cluster',
    (appEnv) => {
      let looked = false;
      const env = appEnv === undefined ? {} : { APP_ENV: appEnv };

      const result = withLocalWorkerDefaults(env, {
        ...deps,
        localUrl: () => {
          looked = true;
          return 'postgres://derived';
        },
      });

      expect(result).toEqual(env);
      expect(looked).toBe(false);
    },
  );

  // Break caught: the cluster being looked for when the developer has set the login, which would fail a run that needs nothing from it.
  it('does not look for the local cluster when the login is given', () => {
    let looked = false;

    withLocalWorkerDefaults(
      { APP_ENV: 'local', DATABASE_WORKER_URL: URL_GIVEN },
      {
        ...deps,
        localUrl: () => {
          looked = true;
          return 'postgres://derived';
        },
      },
    );

    expect(looked).toBe(false);
  });
});
