import { describe, expect, it } from 'vitest';

import { CliUsageError, databaseArgument, describeFailure } from './cli.js';

function networkError(code: string, address?: string, port?: number): Error {
  return Object.assign(new Error(`connect ${code}`), { code, address, port });
}

describe('describeFailure', () => {
  // Break caught: an unreachable server reported as a raw Node error, which tells nobody to start the
  // container.
  it('says an unreachable server is unreachable, where, and what to check', () => {
    const message = describeFailure(networkError('ECONNREFUSED', '127.0.0.1', 5432));
    expect(message).toContain('PostgreSQL is not reachable at 127.0.0.1:5432');
    expect(message).toContain('ECONNREFUSED');
    expect(message).toContain('infrastructure/postgres/compose.yaml');
  });

  // Break caught: a name that resolves to several addresses (localhost) hiding the real cause inside an
  // AggregateError whose own message is empty.
  it('finds the cause inside an AggregateError', () => {
    const wrapped = new AggregateError(
      [networkError('ECONNREFUSED', '::1', 5432), networkError('ECONNREFUSED', '127.0.0.1', 5432)],
      '',
    );
    expect(describeFailure(wrapped)).toContain('PostgreSQL is not reachable at ::1:5432');
  });

  // Break caught: a refusal or a usage error being dressed up as a connection problem.
  it('passes the message of any other error through, with its cause', () => {
    expect(describeFailure(new CliUsageError('DATABASE_MIGRATION_URL is not a URL'))).toBe(
      'DATABASE_MIGRATION_URL is not a URL',
    );
    expect(
      describeFailure(new Error('migration failed', { cause: new Error('relation exists') })),
    ).toBe('migration failed\n  caused by: relation exists');
  });

  // Break caught: a thrown value that is not an Error crashing the reporter.
  it('survives a thrown value that is not an Error', () => {
    expect(describeFailure('boom')).toBe('the command failed for an unexpected reason');
  });

  // Break caught: a stack trace written to the terminal, which names the files and, for some libraries,
  // the connection settings.
  it('never includes a stack trace', () => {
    expect(describeFailure(new Error('x'))).not.toContain('    at ');
  });
});

describe('databaseArgument', () => {
  it('defaults to the local development database and takes the first argument otherwise', () => {
    expect(databaseArgument(['node', 'tool.js'])).toBe('melarc_dev');
    expect(databaseArgument(['node', 'tool.js', 'melarc_test_ab12cd34'])).toBe(
      'melarc_test_ab12cd34',
    );
  });
});
