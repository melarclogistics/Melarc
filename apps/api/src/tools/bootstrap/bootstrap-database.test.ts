import { describe, expect, it } from 'vitest';

import type { DatabaseService } from '../../platform/database/database.service.js';
import { describeFailure } from '../database/cli.js';
import { PostgresBootstrapDatabase } from './bootstrap-database.js';

/**
 * What the commands print when the database fails in a way the server does not state (S0.30): a connection that drops while a
 * statement runs. drizzle-orm ends the message of such a failure with the statement's bound values ("Failed query: <sql>\nparams:
 * <values>"), and the values of these two statements are the whole document of the seed (both custodians' names and work emails and
 * the hash of each secret) and the canonical work email of the resume. The command line prints the message and the message of its
 * cause, so nothing may reach it that carries them (MIGRATION_AND_SEEDING.md §3.2: "never prints a secret, a work email or a path").
 */

const EMAIL = 'custodian.one@example.test';
const NAME = 'Custodian Alpha-Bravo';
const HASH = 'ab'.repeat(32);
const DOCUMENT = JSON.stringify({
  administrators: [{ work_email: EMAIL, full_name: NAME, grant: { token_hash: HASH } }],
});

/** What the driver throws when the connection goes away while a statement runs. */
function droppedConnection(statement: string, values: string): Error {
  return new Error(`Failed query: ${statement}\nparams: ${values}`, {
    cause: new Error('Connection terminated unexpectedly'),
  });
}

/** A database whose statements all fail with `error`, as the transaction of a run sees it. */
function failingWith(error: Error): Pick<DatabaseService, 'transactionWithContext'> {
  // Only `execute` is ever used by the adapter, so only `execute` is faked.
  const transaction = { execute: () => Promise.reject(error) };
  return { transactionWithContext: (_context, work) => work(transaction as never) };
}

const printed = async (
  error: Error,
  call: (calls: Parameters<Parameters<PostgresBootstrapDatabase['run']>[1]>[0]) => Promise<unknown>,
): Promise<string> => {
  const thrown = await new PostgresBootstrapDatabase(failingWith(error))
    .run('bootstrap-test', call)
    .then(
      () => undefined,
      (rejected: unknown) => rejected,
    );
  return describeFailure(thrown);
};

describe('a failure of the database that is not the server’s own words (S0.30)', () => {
  // Break caught: the failure rethrown as it came, so that the command line prints the statement's bound values: both custodians'
  // names and work emails and the hash of each secret.
  it('prints nothing of the seed document when the connection drops while the seed runs', async () => {
    const shown = await printed(
      droppedConnection(
        'select melarc.seed_bootstrap_administrators($1::jsonb) as report',
        DOCUMENT,
      ),
      (calls) => calls.seed(DOCUMENT),
    );

    for (const value of [EMAIL, NAME, HASH, 'work_email', 'params'])
      expect(shown).not.toContain(value);
    // It still says that the database failed, and how, so that an operator knows what happened.
    expect(shown).toMatch(/the database failed/);
    expect(shown).toMatch(/no row, value or secret is shown/);
  });

  // Break caught: the same, for the canonical address the resume command looks an identity up by.
  it('prints nothing of the address when the connection drops while the resume looks the identity up', async () => {
    const shown = await printed(
      droppedConnection('select melarc.bootstrap_identity_state($1::text) as state', EMAIL),
      (calls) => calls.identityState(EMAIL),
    );

    expect(shown).not.toContain(EMAIL);
    expect(shown).toMatch(/the database failed/);
  });

  // Break caught: a failure whose cause is the one that carries the values (the wrapper's own message holds none).
  it('prints nothing of the values when it is the cause of the failure that carries them', async () => {
    const wrapper = new Error('the statement could not be run', {
      cause: droppedConnection(
        'select melarc.resume_bootstrap_identity($1::jsonb) as report',
        DOCUMENT,
      ),
    });

    const shown = await printed(wrapper, (calls) => calls.resume(DOCUMENT));

    for (const value of [EMAIL, NAME, HASH]) expect(shown).not.toContain(value);
  });

  // The control of the three above: a failure that holds no values is not made less useful than it was.
  it('leaves a failure that carries no bound values as it is', async () => {
    const shown = await printed(
      new Error('the pool could not give a connection in time'),
      (calls) => calls.status(),
    );

    expect(shown).toBe('the pool could not give a connection in time');
  });
});
