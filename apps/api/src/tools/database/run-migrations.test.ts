import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PostgresUrlError } from '../../platform/database/postgres-url.js';
import { runMigrations } from './run-migrations.js';
import { UnsafeTargetError } from './safety.js';

/**
 * Nothing listens on port 1. A run that got as far as connecting would fail with a connection error, so
 * every refusal below is told apart from a connection failure by its own error type.
 */
const MIGRATION = 'postgres://melarc_migration_elevated:SECRET-PW@127.0.0.1:1/melarc_dev';

async function failureOf(url: string): Promise<unknown> {
  return runMigrations({ url }).then(
    () => new Error('expected the run to be refused'),
    (error: unknown) => error,
  );
}

describe('runMigrations: what it refuses before it connects', () => {
  // Break caught (audit F01): a migration URL whose authority names the migration identity while its query
  // string makes the driver connect as another. The identity check approved one user and the driver used
  // another, and migrations create objects owned by whoever runs them.
  it.each([
    ['a user override', `${MIGRATION}?user=postgres`],
    ['a host override', `${MIGRATION}?host=db.example`],
    ['a port override', `${MIGRATION}?port=6543`],
    ['a repeated user', `${MIGRATION}?user=a&user=postgres`],
    ['an encoded option name', `${MIGRATION}?%75ser=postgres`],
    ['a TLS option', `${MIGRATION}?sslmode=require`],
    ['an empty query string', `${MIGRATION}?`],
    ['a fragment', `${MIGRATION}#section`],
  ])('refuses a URL with %s, and does not say what it held', async (_label, url) => {
    const error = await failureOf(url);

    expect(error).toBeInstanceOf(PostgresUrlError);
    expect(String(error)).not.toContain('SECRET-PW');
    expect(String(error)).not.toContain('127.0.0.1');
  });

  // Break caught (audit F01): the reverse of the above. An authority that names the runtime identity with a
  // query string that names the migration identity is refused as well: neither reading is trusted.
  it('refuses the runtime identity that a query string renames to the migration identity', async () => {
    const error = await failureOf(
      'postgres://melarc_api_runtime:SECRET-PW@127.0.0.1:1/melarc_dev?user=melarc_migration_elevated',
    );

    expect(error).toBeInstanceOf(PostgresUrlError);
  });

  // Break caught: the identity check lost in the change. Migrations still run as the migration identity only.
  it.each(['melarc_api_runtime', 'melarc_owner', 'postgres'])(
    'still refuses the user %s',
    async (user) => {
      const error = await failureOf(`postgres://${user}:SECRET-PW@127.0.0.1:1/melarc_dev`);

      expect(error).toBeInstanceOf(UnsafeTargetError);
      expect(String(error)).not.toContain('SECRET-PW');
    },
  );

  it.each(['not a url', 'mysql://melarc_migration_elevated@127.0.0.1/melarc_dev'])(
    'refuses %j as a URL it cannot use',
    async (url) => {
      expect(await failureOf(url)).toBeInstanceOf(PostgresUrlError);
    },
  );

  describe('what the driver is given', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    // Break caught (audit F01): the client being built from the URL string, which the driver reads again.
    // Whatever the URL holds, the driver is given the settings that were checked and nothing else, and what
    // is escaped in the URL arrives decoded. The client is replaced by one that stops before connecting, so
    // that what it was given can be read without a server.
    it('is the checked settings, decoded, and no connection string', async () => {
      const configs: pg.ClientConfig[] = [];
      class StopsBeforeConnecting {
        constructor(config: pg.ClientConfig) {
          configs.push(config);
        }
        connect(): Promise<never> {
          return Promise.reject(new Error('stopped before connecting'));
        }
      }
      vi.spyOn(pg, 'Client').mockImplementation(
        StopsBeforeConnecting as unknown as typeof pg.Client,
      );

      await expect(
        runMigrations({
          url: 'postgres://melarc_migration_elevated:SECRET%40PW@localhost/melarc%5Fdev',
        }),
      ).rejects.toThrow('stopped before connecting');

      expect(configs).toStrictEqual([
        {
          host: 'localhost',
          port: 5432,
          user: 'melarc_migration_elevated',
          password: 'SECRET@PW',
          database: 'melarc_dev',
          application_name: 'melarc-migrate',
          connectionTimeoutMillis: 5_000,
        },
      ]);
    });
  });

  // Control for the refusals above: an acceptable URL is not refused. The run gets as far as connecting,
  // and what it reports is that nothing is listening, not a refusal.
  it('does not refuse the migration identity with nothing else in the URL', async () => {
    const error = await failureOf(MIGRATION);

    expect(error).not.toBeInstanceOf(PostgresUrlError);
    expect(error).not.toBeInstanceOf(UnsafeTargetError);
    expect((error as { code?: string }).code).toBe('ECONNREFUSED');
  });
});
