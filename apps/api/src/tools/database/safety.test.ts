import { describe, expect, it } from 'vitest';

import {
  assertDisposableName,
  assertLocalHost,
  assertMigrationIdentity,
  assertNotDeployedEnvironment,
  assertTestDatabaseName,
  isLoopbackHost,
  UnsafeTargetError,
} from './safety.js';

describe('isLoopbackHost', () => {
  // Break caught: a local database not recognised as local, so a developer can never reset their own.
  it.each(['localhost', 'LOCALHOST', '127.0.0.1', '127.0.0.254', '127.255.255.255', '::1'])(
    'accepts %s',
    (host) => {
      expect(isLoopbackHost(host)).toBe(true);
    },
  );

  // Break caught: a remote or look-alike host treated as local, which is how a reset reaches a shared or
  // production database. Matching must be on the whole host, never on a prefix or a substring.
  it.each([
    '',
    '0.0.0.0',
    '10.0.0.5',
    '192.168.1.20',
    '172.16.0.1',
    'db.internal',
    'localhost.evil.example',
    '127.0.0.1.evil.example',
    'evil-localhost',
    '127.0.0',
    '127.0.0.256',
    '::',
    '::2',
    'prod-db.melarc.example',
  ])('refuses %j', (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});

describe('assertLocalHost', () => {
  // Break caught: the guard returning quietly for a remote host.
  it('throws an UnsafeTargetError for a host that is not on this machine', () => {
    expect(() => {
      assertLocalHost('db.internal');
    }).toThrow(UnsafeTargetError);
    expect(() => {
      assertLocalHost('127.0.0.1');
    }).not.toThrow();
  });
});

describe('assertDisposableName', () => {
  // Break caught: the names the tools themselves use being refused.
  it.each(['melarc_dev', 'melarc_test', 'melarc_test_ab12cd34', 'melarc_dev_0a1b'])(
    'accepts %s',
    (name) => {
      expect(() => {
        assertDisposableName(name);
      }).not.toThrow();
    },
  );

  // Break caught: any database that is not plainly a development or test one being droppable, including
  // the cluster's own, a production-looking name, a case-folded name and an injection attempt.
  it.each([
    'postgres',
    'template0',
    'template1',
    'melarc',
    'melarc_prod',
    'melarc_production',
    'melarc_staging',
    'melarc_devops',
    'melarc_test_',
    'melarc_test_AB12',
    'Melarc_Dev',
    'melarc_dev_abc',
    `melarc_test_${'a'.repeat(33)}`,
    'melarc_dev"; DROP DATABASE postgres; --',
    'melarc_dev; select 1',
    '',
    // Text before the name, or whitespace around it: a database that merely contains a disposable name is not one.
    // Without the start anchor "prod_melarc_dev" would be droppable.
    'prod_melarc_dev',
    'x_melarc_test_ab12cd34',
    'old-melarc_test',
    ' melarc_dev',
    'melarc_dev ',
    'melarc_dev\n',
  ])('refuses %j', (name) => {
    expect(() => {
      assertDisposableName(name);
    }).toThrow(UnsafeTargetError);
  });
});

describe('assertTestDatabaseName (audit F07)', () => {
  // Break caught: the names the test tooling makes being refused by the command that cleans them up.
  it.each(['melarc_test_ab12cd34', 'melarc_test_abcd', `melarc_test_${'a'.repeat(32)}`])(
    'accepts %s',
    (name) => {
      expect(() => {
        assertTestDatabaseName(name);
      }).not.toThrow();
    },
  );

  // Break caught: the cleanup of test databases being able to name the development database or anything else.
  // `melarc_dev` is disposable (db:reset drops it) but it is never a leftover of a test run.
  it.each([
    'melarc_dev',
    'melarc_dev_0a1b',
    'melarc_test',
    'melarc_test_',
    'melarc_test_abc',
    'melarc_test_AB12CD34',
    `melarc_test_${'a'.repeat(33)}`,
    // Text before the name: a database that merely contains a test database's name is not one.
    'x_melarc_test_ab12cd34',
    'old-melarc_test_ab12cd34',
    'Xmelarc_test_ab12cd34',
    'postgres',
    'template1',
    'melarc',
    'melarc_prod',
    'melarc_test_ab12"; DROP DATABASE postgres; --',
    '',
  ])('refuses %j', (name) => {
    expect(() => {
      assertTestDatabaseName(name);
    }).toThrow(UnsafeTargetError);
  });
});

describe('assertMigrationIdentity', () => {
  // Break caught: migrations run as a superuser or as the owner, which would leave objects owned by the
  // wrong role and make row-level security bypassable by the roles that own the tables.
  it('accepts only melarc_migration_elevated', () => {
    expect(() => {
      assertMigrationIdentity('melarc_migration_elevated');
    }).not.toThrow();
    for (const user of [
      'postgres',
      'melarc_owner',
      'melarc_api_runtime',
      'melarc_worker_runtime',
      '',
    ]) {
      expect(() => {
        assertMigrationIdentity(user);
      }).toThrow(UnsafeTargetError);
    }
  });
});

describe('assertNotDeployedEnvironment', () => {
  // Break caught: a destructive local command running with a staging or production environment in scope.
  it.each(['staging', 'production'])('refuses APP_ENV=%s', (appEnv) => {
    expect(() => {
      assertNotDeployedEnvironment({ APP_ENV: appEnv });
    }).toThrow(UnsafeTargetError);
  });

  // Break caught: a guard that recognises two spellings and lets every other one through. A mistyped or oddly
  // cased environment name is not a local one: the guard allows what it knows to be local, and nothing else.
  it.each([
    'Production',
    'STAGING',
    'prod',
    'production ',
    ' staging',
    'prd',
    'live',
    'test',
    'local ',
  ])('refuses APP_ENV=%j, which is not the local environment', (appEnv) => {
    expect(() => {
      assertNotDeployedEnvironment({ APP_ENV: appEnv });
    }).toThrow(UnsafeTargetError);
  });

  // Break caught: the refusal echoing something that is not a name, such as a control character or a very long value.
  it('says which value it refused, with anything that is not a word character made visible', () => {
    expect(() => {
      assertNotDeployedEnvironment({ APP_ENV: 'prod\nx ' + 'y'.repeat(100) });
    }).toThrow(/APP_ENV=prod\?x\?y{33}: only/);
    expect(() => {
      assertNotDeployedEnvironment({ APP_ENV: 'staging' });
    }).toThrow('APP_ENV=staging:');
  });

  it.each([{}, { APP_ENV: 'local' }, { APP_ENV: '' }])('allows %j', (env) => {
    expect(() => {
      assertNotDeployedEnvironment(env);
    }).not.toThrow();
  });
});
