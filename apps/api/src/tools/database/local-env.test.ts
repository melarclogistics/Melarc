import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalPostgresNotConfiguredError, readLocalPostgres } from './local-env.js';

const ENV = {
  MELARC_PG_ADMIN_PASSWORD: 'admin-secret-aaaa',
  MELARC_PG_MIGRATION_PASSWORD: 'migration-secret-bbbb',
  MELARC_PG_RUNTIME_PASSWORD: 'runtime-secret-cccc',
};

let folder: string;
let envFile: string;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'melarc-local-env-'));
  envFile = join(folder, '.env');
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

function messageOf(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return '';
}

describe('readLocalPostgres: the three passwords', () => {
  // Break caught: one password used for two roles. The migration role may create objects and run as the owner,
  // the runtime role may do neither, and a password they share makes the second a way into the first.
  it.each([
    [
      'the administrator and the migration role',
      { MELARC_PG_MIGRATION_PASSWORD: ENV.MELARC_PG_ADMIN_PASSWORD },
    ],
    [
      'the administrator and the runtime role',
      { MELARC_PG_RUNTIME_PASSWORD: ENV.MELARC_PG_ADMIN_PASSWORD },
    ],
    [
      'the migration role and the runtime role',
      { MELARC_PG_RUNTIME_PASSWORD: ENV.MELARC_PG_MIGRATION_PASSWORD },
    ],
  ])('refuses one password for %s, without saying what it is', (_label, override) => {
    const message = messageOf(() => readLocalPostgres({ env: { ...ENV, ...override }, envFile }));

    expect(message).toContain('must all differ');
    expect(message).not.toContain('secret-');
  });

  it('accepts three different passwords', () => {
    expect(() => readLocalPostgres({ env: ENV, envFile })).not.toThrow();
  });
});

describe('readLocalPostgres', () => {
  // Break caught: the settings not being read from the environment, which is how CI supplies them.
  it('reads the settings from the environment and defaults the host and port', () => {
    expect(readLocalPostgres({ env: ENV, envFile })).toEqual({
      host: '127.0.0.1',
      port: 5432,
      adminPassword: 'admin-secret-aaaa',
      migrationPassword: 'migration-secret-bbbb',
      runtimePassword: 'runtime-secret-cccc',
    });
  });

  // Break caught: the generated .env file being ignored, so a developer must export secrets by hand.
  it('reads the settings from the env file when the environment has none', () => {
    writeFileSync(
      envFile,
      [
        '# local only',
        'MELARC_PG_HOST=localhost',
        'MELARC_PG_PORT=5544',
        ...Object.entries(ENV).map(([key, value]) => `${key}=${value}`),
      ].join('\n'),
    );
    expect(readLocalPostgres({ env: {}, envFile })).toMatchObject({
      host: 'localhost',
      port: 5544,
      adminPassword: 'admin-secret-aaaa',
    });
  });

  // Break caught: the file overriding what the caller set explicitly, which would point a run at a
  // different server than the one it was told to use.
  it('lets the environment override the env file', () => {
    writeFileSync(envFile, 'MELARC_PG_PORT=5544\nMELARC_PG_ADMIN_PASSWORD=from-file\n');
    const settings = readLocalPostgres({ env: { ...ENV, MELARC_PG_PORT: '6000' }, envFile });
    expect(settings.port).toBe(6000);
    expect(settings.adminPassword).toBe('admin-secret-aaaa');
  });

  // Break caught: an empty variable in the environment masking a good value in the file.
  it('treats an empty environment value as unset', () => {
    writeFileSync(
      envFile,
      Object.entries(ENV)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n'),
    );
    expect(
      readLocalPostgres({ env: { MELARC_PG_ADMIN_PASSWORD: '' }, envFile }).adminPassword,
    ).toBe('admin-secret-aaaa');
  });

  // Break caught: a missing password falling through to an empty or default one, which would connect to a
  // server that is not the one set up for this project, or fail later with an unrelated message.
  it.each(Object.keys(ENV))('names %s when it is missing and prints no secret', (key) => {
    const env = Object.fromEntries(Object.entries(ENV).filter(([name]) => name !== key));
    const action = () => readLocalPostgres({ env, envFile });
    expect(action).toThrow(LocalPostgresNotConfiguredError);
    const message = messageOf(action);
    expect(message).toContain(key);
    for (const secret of Object.values(ENV)) expect(message).not.toContain(secret);
  });

  // Break caught: the copied example file being used unedited, which would give every checkout the same
  // well-known passwords.
  it('refuses the placeholder from the example file', () => {
    const action = () =>
      readLocalPostgres({ env: { ...ENV, MELARC_PG_RUNTIME_PASSWORD: 'CHANGE_ME' }, envFile });
    expect(action).toThrow(LocalPostgresNotConfiguredError);
    expect(messageOf(action)).toContain('MELARC_PG_RUNTIME_PASSWORD');
  });

  it.each(['0', '65536', 'abc', '54.3', '-1'])('refuses the port %j', (port) => {
    const action = () => readLocalPostgres({ env: { ...ENV, MELARC_PG_PORT: port }, envFile });
    expect(action).toThrow(LocalPostgresNotConfiguredError);
    expect(messageOf(action)).toContain('MELARC_PG_PORT');
  });

  // Break caught: the loader throwing a raw file-system error when the file is absent, which says nothing
  // about what to do.
  it('says how to configure the database when nothing is set', () => {
    const message = messageOf(() =>
      readLocalPostgres({ env: {}, envFile: join(folder, 'missing.env') }),
    );
    expect(message).toContain('MELARC_PG_ADMIN_PASSWORD');
    expect(message).toContain('infrastructure/postgres');
  });
});
