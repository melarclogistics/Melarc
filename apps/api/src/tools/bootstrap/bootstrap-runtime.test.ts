import { describe, expect, it } from 'vitest';

import { INERT_DEADLINES } from '../../platform/config/inert-config.js';
import { BOOTSTRAP_DEADLINES, bootstrapDependencies } from './bootstrap-runtime.js';
import { PROGRAM_TIMEOUT_MS, PROGRAMS_PER_SEED_RUN } from './custody-node.js';

describe('the composition of the bootstrap commands (S0.30)', () => {
  // Break caught: the engineering defaults (5 seconds idle in a transaction, 10 in all) left on a transaction that writes two files,
  // on Windows with `icacls`, before it commits: a loaded machine has the server end the session, and the run fails for nothing.
  it('lets the transaction wait for the longest the files of a run can take, and the whole transaction longer than that', () => {
    const longestSilence = PROGRAMS_PER_SEED_RUN * PROGRAM_TIMEOUT_MS;

    expect(BOOTSTRAP_DEADLINES.idleInTransactionTimeoutMs).toBeGreaterThan(longestSilence);
    expect(BOOTSTRAP_DEADLINES.transactionTimeoutMs).toBeGreaterThan(
      BOOTSTRAP_DEADLINES.idleInTransactionTimeoutMs,
    );
    // And it changes nothing else of the defaults: a statement is still bounded as every other is.
    expect({
      ...BOOTSTRAP_DEADLINES,
      idleInTransactionTimeoutMs: 0,
      transactionTimeoutMs: 0,
    }).toEqual({
      ...INERT_DEADLINES,
      idleInTransactionTimeoutMs: 0,
      transactionTimeoutMs: 0,
    });
  });

  it('binds the adapters of this platform without opening a connection or making a file', () => {
    const dependencies = bootstrapDependencies();

    expect(typeof dependencies.open).toBe('function');
    expect(dependencies.correlationId()).toMatch(/^bootstrap-[0-9a-f-]{36}$/);
    expect(() => dependencies.custodyDirectory(undefined)).toThrow();
  });
});
