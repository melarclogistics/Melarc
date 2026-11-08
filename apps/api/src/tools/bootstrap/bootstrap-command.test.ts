import { describe, expect, it, vi } from 'vitest';

import { Sha256TokenService } from '../../platform/auth/crypto/sha256.token-service.adapter.js';
import {
  CommitOutcomeUnknownError,
  TransactionRolledBackError,
} from '../../platform/database/database-failures.js';
import { FakeAccess, FakeDisk } from '../../test-support/custody-fakes.js';
import {
  runBootstrapResume,
  runBootstrapSeed,
  targetOf,
  type BootstrapDependencies,
  type BootstrapTarget,
} from './bootstrap-command.js';
import type {
  BootstrapCalls,
  BootstrapDatabase,
  IdentityFacts,
  ResumeOutcome,
  SeedOutcome,
} from './bootstrap-database.js';
import {
  BootstrapCustodyError,
  BootstrapInputError,
  BootstrapRefusedError,
} from './bootstrap-vocabulary.js';
import { CustodyStore } from './custody-store.js';

const DIRECTORY = '/custody';
const NOW = new Date('2026-10-21T09:00:00.000Z');
const CLOCK = { now: () => NOW };
const tokens = new Sha256TokenService();

const FIRST = 'Kofi Boateng <kofi.boateng@melarc.example>';
const SECOND = 'Efua Addo <efua.addo@melarc.example>';

interface Run {
  readonly calls: string[];
  readonly documents: string[];
  readonly contexts: string[];
  closed: number;
}

interface Behaviour {
  rows?: number;
  seed?: () => Promise<SeedOutcome>;
  facts?: IdentityFacts;
  factsFailure?: Error;
  resume?: (document: string) => Promise<ResumeOutcome>;
  /** What the transaction answers when its work is done: a failure to commit. */
  commit?: Error;
}

const GOOD_SEED: SeedOutcome = { staffIdentity: 2, setupGrant: 2, auditEvent: 6 };

function build(behaviour: Behaviour = {}) {
  const disk = new FakeDisk();
  const access = new FakeAccess(disk);
  let counter = 0;
  const store = new CustodyStore(disk, access, () => {
    counter += 1;
    return counter.toString(16).padStart(32, '0');
  });
  const run: Run = { calls: [], documents: [], contexts: [], closed: 0 };
  const calls: BootstrapCalls = {
    status: () => {
      run.calls.push('status');
      disk.calls.push('db:status');
      return Promise.resolve({ staffIdentities: behaviour.rows ?? 0 });
    },
    seed: (document) => {
      run.calls.push('seed');
      disk.calls.push('db:seed');
      run.documents.push(document);
      return (behaviour.seed ?? (() => Promise.resolve(GOOD_SEED)))();
    },
    identityState: (email) => {
      run.calls.push(`state:${email}`);
      disk.calls.push('db:state');
      if (behaviour.factsFailure !== undefined) return Promise.reject(behaviour.factsFailure);
      if (behaviour.facts === undefined) throw new Error('the test gave no identity');
      return Promise.resolve(behaviour.facts);
    },
    resume: (document) => {
      run.calls.push('resume');
      disk.calls.push('db:resume');
      run.documents.push(document);
      if (behaviour.resume === undefined) throw new Error('the test gave no resume');
      return behaviour.resume(document);
    },
  };
  const database: BootstrapDatabase = {
    run: async (correlationId, work) => {
      run.contexts.push(correlationId);
      const result = await work(calls);
      if (behaviour.commit !== undefined) throw behaviour.commit;
      return result;
    },
  };
  const target: BootstrapTarget = {
    database,
    close: () => {
      run.closed += 1;
      return Promise.resolve();
    },
  };
  const opened: string[] = [];
  const dependencies: BootstrapDependencies = {
    localUrl: () => 'postgres://local',
    open: (url) => {
      opened.push(url);
      return target;
    },
    store,
    tokens,
    clock: CLOCK,
    custodyDirectory: (value) => {
      if (value === undefined) throw new BootstrapCustodyError('DIRECTORY_MISSING');
      return value;
    },
    correlationId: () => 'bootstrap-run-1',
  };
  return { disk, access, store, run, dependencies, opened };
}

const ENV = { BOOTSTRAP_CUSTODY_DIRECTORY: DIRECTORY };

async function outcomeOf(run: Promise<unknown>): Promise<Error> {
  try {
    await run;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the command to fail');
}

const lines = (): { write: (line: string) => void; text: () => string; all: string[] } => {
  const all: string[] = [];
  return { write: (line) => all.push(line), text: () => all.join('\n'), all };
};

const bundlesWritten = (disk: FakeDisk): string[] =>
  disk.everWritten.filter((text) => text.startsWith('MELARC-BOOTSTRAP-BUNDLE'));

const secretOf = (bundle: string): string => bundle.split('\nsecret:\n')[1]?.split('\n')[0] ?? '';

describe('the bootstrap seed command (S0.30)', () => {
  // Break caught: the order that makes an interrupted run leave no pair, or a pair with its bundles: the table is judged first, the
  // orphans of an earlier run are swept only when it is empty and under the lock, the pair is made in the transaction, and each
  // bundle is written before that transaction commits.
  it('judges the table, sweeps, makes the pair and writes the bundles, in that order, in one transaction', async () => {
    const { disk, run, dependencies, opened } = build();
    const out = lines();
    await runBootstrapSeed(
      ['--custodian', FIRST, '--custodian', SECOND],
      ENV,
      out.write,
      dependencies,
    );

    expect(run.calls).toEqual(['status', 'seed']);
    expect(run.contexts).toEqual(['bootstrap-run-1']);
    expect(disk.calls).toEqual([
      'ensureDirectory',
      'assertPrivateDirectory',
      'inspectDirectory',
      'db:status',
      'db:seed',
      'create',
      'secure',
      'inspect',
      'write',
      'close',
      'create',
      'secure',
      'inspect',
      'write',
      'close',
    ]);
    expect(opened).toEqual(['postgres://local']);
    expect(run.closed).toBe(1);
  });

  it('writes one bundle for each custodian, each naming that custodian and no other, with a secret of its own', async () => {
    const { disk, dependencies } = build();
    await runBootstrapSeed(
      ['--custodian', FIRST, '--custodian', SECOND],
      ENV,
      lines().write,
      dependencies,
    );
    const bundles = bundlesWritten(disk);
    expect(bundles).toHaveLength(2);
    expect(bundles[0]).toContain('custodian: Kofi Boateng <kofi.boateng@melarc.example>');
    expect(bundles[0]).not.toContain('Efua');
    expect(bundles[1]).toContain('custodian: Efua Addo <efua.addo@melarc.example>');
    expect(bundles[1]).not.toContain('Kofi');
    expect(secretOf(bundles[0] ?? '')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(secretOf(bundles[0] ?? '')).not.toBe(secretOf(bundles[1] ?? ''));
    for (const bundle of bundles) expect(bundle).toContain('purpose: BOOTSTRAP_SETUP');
  });

  // Break caught: the one place a secret may be written (the bundle) not being the only one: a secret in the document the database
  // receives, in what the command prints, or in an error.
  it('keeps each secret out of the document, the output and every other file write', async () => {
    const { disk, run, dependencies } = build();
    const out = lines();
    await runBootstrapSeed(
      ['--custodian', FIRST, '--custodian', SECOND],
      ENV,
      out.write,
      dependencies,
    );
    for (const bundle of bundlesWritten(disk)) {
      const secret = secretOf(bundle);
      expect(secret).not.toBe('');
      for (const document of run.documents) expect(document).not.toContain(secret);
      expect(out.text()).not.toContain(secret);
      expect(disk.everWritten.filter((text) => text.includes(secret))).toEqual([bundle]);
    }
  });

  // Break caught: a custodian's address or name, or a path, printed: the output is kept by a terminal, a CI log or a ticket.
  it('prints what happened and names no custodian, no address and no path', async () => {
    const { dependencies } = build();
    const out = lines();
    await runBootstrapSeed(
      ['--custodian', FIRST, '--custodian', SECOND],
      ENV,
      out.write,
      dependencies,
    );
    const text = out.text();
    for (const forbidden of ['Kofi', 'Boateng', 'Efua', 'Addo', 'melarc.example', '@', DIRECTORY]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
    expect(text).toMatch(/staff_identity: 2/);
    expect(text).toMatch(/custodian 1 of 2: melarc-bootstrap-[0-9a-f]{32}\.bundle/);
    expect(text).toMatch(/custodian 2 of 2: melarc-bootstrap-[0-9a-f]{32}\.bundle/);
  });

  // Break caught: an operator's input that makes one person two custodians being accepted, or any file or connection made before the
  // input is judged.
  it.each([
    [[], 'CUSTODIAN_COUNT'],
    [['--custodian', FIRST], 'CUSTODIAN_COUNT'],
    [
      [
        '--custodian',
        FIRST,
        '--custodian',
        SECOND,
        '--custodian',
        'Yaw Owusu <yaw@melarc.example>',
      ],
      'CUSTODIAN_COUNT',
    ],
    [
      ['--custodian', FIRST, '--custodian', 'Same Person <KOFI.BOATENG@melarc.example>'],
      'CUSTODIANS_NOT_DISTINCT',
    ],
    [['--custodian', FIRST, '--custodian', FIRST], 'CUSTODIANS_NOT_DISTINCT'],
    [['--custodian', FIRST, '--custodian', 'No Address'], 'ARGUMENTS'],
    [['--custodian', FIRST, '--custodian'], 'ARGUMENTS'],
    [['--custodian', FIRST, '--other', SECOND], 'ARGUMENTS'],
    [['--custodian', FIRST, '--custodian', 'Bad <not-an-address>'], 'CUSTODIAN_EMAIL'],
    [['--custodian', FIRST, '--custodian', ' <efua@melarc.example>'], 'ARGUMENTS'],
  ] as const)(
    'refuses the arguments %j (%s) before it opens a database or touches a folder',
    async (argv, problem) => {
      const { disk, run, dependencies, opened } = build();
      const failure = await outcomeOf(
        runBootstrapSeed([...argv], ENV, lines().write, dependencies),
      );
      expect(failure).toBeInstanceOf(BootstrapInputError);
      expect((failure as BootstrapInputError).problem).toBe(problem);
      expect(opened).toEqual([]);
      expect(run.calls).toEqual([]);
      expect(disk.calls).toEqual([]);
    },
  );

  it('refuses a custody folder that is not given, before it opens a database', async () => {
    const { run, dependencies, opened } = build();
    const failure = await outcomeOf(
      runBootstrapSeed(
        ['--custodian', FIRST, '--custodian', SECOND],
        {},
        lines().write,
        dependencies,
      ),
    );
    expect(failure).toBeInstanceOf(BootstrapCustodyError);
    expect((failure as BootstrapCustodyError).problem).toBe('DIRECTORY_MISSING');
    expect(opened).toEqual([]);
    expect(run.calls).toEqual([]);
  });

  // Break caught: a seed that writes its files first and asks the table afterwards, or one that sweeps a folder it has no right to.
  it('refuses a table that holds identities: no sweep, no pair, no file, and it says how many', async () => {
    const { disk, run, dependencies } = build({ rows: 2 });
    disk.files.set(
      `${DIRECTORY}/melarc-bootstrap-${'a'.repeat(32)}.bundle`,
      'MELARC-BOOTSTRAP-BUNDLE v1\nvalid bundle of the committed pair',
    );
    const failure = await outcomeOf(
      runBootstrapSeed(
        ['--custodian', FIRST, '--custodian', SECOND],
        ENV,
        lines().write,
        dependencies,
      ),
    );
    expect(failure).toBeInstanceOf(BootstrapRefusedError);
    expect((failure as BootstrapRefusedError).reason).toBe('STAFF_TABLE_NOT_EMPTY');
    expect((failure as BootstrapRefusedError).rows).toBe(2);
    expect(run.calls).toEqual(['status']);
    expect(disk.calls).not.toContain('create');
    expect(disk.calls).not.toContain('remove');
    expect(disk.files.size).toBe(1);
    expect(run.closed).toBe(1);
  });

  // Break caught: an interrupted run's bundles surviving into the next, or the sweep running before the table was judged empty.
  it('sweeps the bundles of an earlier run that did not commit, after judging the table empty and before it writes', async () => {
    const { disk, dependencies } = build();
    const orphan = `${DIRECTORY}/melarc-bootstrap-${'b'.repeat(32)}.bundle`;
    const other = `${DIRECTORY}/notes.txt`;
    disk.files.set(
      orphan,
      `MELARC-BOOTSTRAP-BUNDLE v1\ntarget: ${targetOf('postgres://local')}\nthe secret of a pair that was never committed`,
    );
    disk.files.set(other, 'not mine');
    const out = lines();
    await runBootstrapSeed(
      ['--custodian', FIRST, '--custodian', SECOND],
      ENV,
      out.write,
      dependencies,
    );
    expect(disk.files.has(orphan)).toBe(false);
    expect(disk.files.get(other)).toBe('not mine');
    expect(disk.calls.indexOf('db:status')).toBeLessThan(disk.calls.indexOf('remove'));
    expect(disk.calls.indexOf('remove')).toBeLessThan(disk.calls.indexOf('create'));
    expect(out.text()).toMatch(/removed 1 bundle of an earlier run/);
  });

  // Break caught: a sweep that takes every bundle in the folder for an orphan: in a folder that also served another environment, it
  // deletes the bundles of a pair that did commit, the only copies of secrets still to be handed over, and says they were orphans.
  it('leaves a bundle of another database alone, says so, and records its own target in every bundle it writes', async () => {
    const { disk, dependencies } = build();
    const foreign = `${DIRECTORY}/melarc-bootstrap-${'c'.repeat(32)}.bundle`;
    const production = targetOf('postgres://provisioning@db.production.example:5432/melarc');
    disk.files.set(
      foreign,
      `MELARC-BOOTSTRAP-BUNDLE v1\ntarget: ${production}\nthe secret of another environment`,
    );
    const out = lines();

    await runBootstrapSeed(
      ['--custodian', FIRST, '--custodian', SECOND],
      ENV,
      out.write,
      dependencies,
    );

    expect(disk.files.get(foreign)).toContain('the secret of another environment');
    expect(out.text()).toMatch(/left 1 other bundle in the folder alone/);
    expect(out.text()).not.toMatch(/removed/);
    expect(bundlesWritten(disk)).toHaveLength(2);
    for (const bundle of bundlesWritten(disk)) {
      expect(bundle.split('\n')[1]).toBe(`target: ${targetOf('postgres://local')}`);
    }
  });

  // Break caught: a target that names the user or the password (it is written into a file, and printed nowhere), or one that does not
  // tell two databases apart.
  it('makes a target of the host, the port and the database, and of no credential', () => {
    const base = 'postgres://provisioning:pw-one@db.example:5432/melarc';
    expect(targetOf(base)).toMatch(/^[0-9a-f]{32}$/);
    expect(targetOf('postgres://someone-else:pw-two@db.example:5432/melarc')).toBe(targetOf(base));
    expect(targetOf('postgres://provisioning@DB.EXAMPLE:5432/melarc')).toBe(targetOf(base));
    for (const other of [
      'postgres://provisioning@db.example:5433/melarc',
      'postgres://provisioning@db2.example:5432/melarc',
      'postgres://provisioning@db.example:5432/melarc_staging',
    ]) {
      expect(targetOf(other), other).not.toBe(targetOf(base));
    }
  });

  // Break caught: a bundle that was being written when the run was judged failed (the database's budget ran out, or its connection
  // was lost) left behind with its secret in it, for a pair that was never committed; or a second file begun after the failure.
  it('waits for a bundle that was being written when the run failed, removes what it made and begins no other', async () => {
    const { disk, dependencies } = build();
    let release: () => void = () => undefined;
    disk.writeGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: BootstrapCalls = {
      status: () => Promise.resolve({ staffIdentities: 0 }),
      seed: () => Promise.resolve(GOOD_SEED),
      identityState: () => Promise.reject(new Error('not used by the seed')),
      resume: () => Promise.reject(new Error('not used by the seed')),
    };
    // The run is rejected while the first file is still being written, and its work goes on, as the database service's does.
    const failedSoon = new Promise<never>((_resolve, reject) => {
      setTimeout(() => {
        reject(new Error('the budget ran out'));
      }, 20);
    });
    const racing: BootstrapDependencies = {
      ...dependencies,
      open: () => ({
        database: { run: (_id, work) => Promise.race([work(calls), failedSoon]) },
        close: () => Promise.resolve(),
      }),
    };
    setTimeout(release, 80);

    const failure = await outcomeOf(
      runBootstrapSeed(['--custodian', FIRST, '--custodian', SECOND], ENV, lines().write, racing),
    );

    expect(failure.message).toBe('the budget ran out');
    // The file that was in flight was written, found and removed; the second was never begun.
    expect(bundlesWritten(disk)).toHaveLength(1);
    expect(disk.files.size).toBe(0);
    expect(disk.calls.filter((call) => call === 'create')).toHaveLength(1);
  });

  // Break caught: files written for a pair the database refused, or a refusal reported in the database's words.
  it('writes no bundle when the database refuses the pair, and says the rule that refused', async () => {
    const { disk, run, dependencies } = build({
      seed: () => Promise.reject(new BootstrapRefusedError('REFERENCE_DATA_MISSING')),
    });
    const failure = await outcomeOf(
      runBootstrapSeed(
        ['--custodian', FIRST, '--custodian', SECOND],
        ENV,
        lines().write,
        dependencies,
      ),
    );
    expect((failure as BootstrapRefusedError).reason).toBe('REFERENCE_DATA_MISSING');
    expect(run.calls).toEqual(['status', 'seed']);
    expect(disk.calls).not.toContain('create');
    expect(run.closed).toBe(1);
  });

  // Break caught: the first bundle left behind when the second cannot be written, which would be a secret for a pair that was
  // rolled back (the throw is what rolls the transaction back).
  it('removes the bundle it wrote when the second cannot be written, and the pair is not committed', async () => {
    const { disk, dependencies } = build();
    disk.failWriteNumber = 2;
    const failure = await outcomeOf(
      runBootstrapSeed(
        ['--custodian', FIRST, '--custodian', SECOND],
        ENV,
        lines().write,
        dependencies,
      ),
    );
    expect((failure as BootstrapCustodyError).problem).toBe('WRITE_FAILED');
    expect(disk.files.size).toBe(0);
    expect(bundlesWritten(disk)).toHaveLength(1);
  });

  it('removes the bundles when the commit is refused, because the pair was rolled back', async () => {
    const { disk, dependencies } = build({ commit: new TransactionRolledBackError() });
    const failure = await outcomeOf(
      runBootstrapSeed(
        ['--custodian', FIRST, '--custodian', SECOND],
        ENV,
        lines().write,
        dependencies,
      ),
    );
    expect(failure).toBeInstanceOf(TransactionRolledBackError);
    expect(disk.files.size).toBe(0);
  });

  // Break caught: bundles removed after a commit whose outcome is not known: if the pair did commit, they are the only copies of its
  // secrets. They stay, and what the operator is told does not infer a rollback from a read that found nothing (the review of
  // 21 October 2026, C01): the transaction may still be finishing.
  it('leaves the bundles in place when it cannot tell whether the commit happened, and says so', async () => {
    const { disk, dependencies } = build({
      commit: new CommitOutcomeUnknownError('connection-lost', {
        cause: new Error('connection lost'),
      }),
    });
    const out = lines();
    const failure = await outcomeOf(
      runBootstrapSeed(['--custodian', FIRST, '--custodian', SECOND], ENV, out.write, dependencies),
    );
    expect(failure).toBeInstanceOf(CommitOutcomeUnknownError);
    expect(disk.files.size).toBe(2);
    expect(out.text()).toMatch(/could not tell whether the pair was committed/);
    const text = out.text();
    // the run's own identifier, so that the audit trail can be asked for it
    expect(text).toContain('bootstrap-run-1');
    // the bundles are kept until the outcome is established, and finding no event is said not to establish it
    expect(text).toMatch(/do not delete/i);
    expect(text).toMatch(/does not show that it did not commit/i);
    // the seed is its own reconciliation: it waits at the lock of the original, refuses a table that holds the pair, and sweeps only an
    // empty one
    expect(text).toMatch(/waits at the same lock/i);
    expect(text).toMatch(/refuses a staff table that holds the pair/i);
    expect(text).toMatch(/only from an empty one/i);
    // a bundle is handed over only while its grant is still the current one
    expect(text).toMatch(/still the current one/i);
    // the unsafe inference: that a missing event, or an immediate retry, settles it
    expect(text).not.toMatch(/if it is not,? run the seed again|none says it is not|finding none/i);
    expect(text).not.toMatch(/hand them over \(the seed refuses/i);
  });

  it('names the bundles it could not remove, by name and never by path', async () => {
    const { disk, dependencies } = build({ commit: new TransactionRolledBackError() });
    disk.stuck.add(`${DIRECTORY}/melarc-bootstrap-${'1'.padStart(32, '0')}.bundle`);
    const out = lines();
    await outcomeOf(
      runBootstrapSeed(['--custodian', FIRST, '--custodian', SECOND], ENV, out.write, dependencies),
    );
    expect(out.text()).toContain(`melarc-bootstrap-${'1'.padStart(32, '0')}.bundle`);
    expect(out.text()).toMatch(/could not be removed/);
    expect(out.text()).not.toContain(DIRECTORY);
  });

  /**
   * A write that fails and whose file cannot be removed leaves a file that may hold the secret, whole or in part (the audit of
   * 21 October 2026, A05). The failure the operator gets is still the rule that was broken; the leftover is named beside it, by its
   * random name and never by a path, together with every bundle that could not be discarded.
   */
  describe('a bundle that fails to write and cannot be removed', () => {
    const NAME_2 = `melarc-bootstrap-${'2'.padStart(32, '0')}.bundle`;
    const PATH_2 = `${DIRECTORY}/${NAME_2}`;

    // Break caught: the leftover of a failed write lost because only the bundles that were written are tracked, so that a file holding
    // part of a secret stays in the custody folder and the operator is told only that a write failed.
    it('names the file that holds part of a secret, keeps the primary failure and removes the bundle that was written', async () => {
      const { disk, dependencies } = build();
      disk.partialWriteChars = 300;
      disk.partialWriteNumber = 2;
      disk.stuck.add(PATH_2);
      const out = lines();

      const failure = await outcomeOf(
        runBootstrapSeed(
          ['--custodian', FIRST, '--custodian', SECOND],
          ENV,
          out.write,
          dependencies,
        ),
      );

      expect((failure as BootstrapCustodyError).problem).toBe('WRITE_FAILED');
      expect(out.text()).toContain(NAME_2);
      expect(out.text()).toMatch(/could not be removed/);
      expect(out.text()).toMatch(/may hold (a|the) secret/);
      // the first bundle was discarded, and only the second is left, with the part of the secret it was given
      expect([...disk.files.keys()]).toEqual([PATH_2]);
      expect(out.text()).not.toContain(DIRECTORY);
      for (const bundle of bundlesWritten(disk)) {
        expect(out.text()).not.toContain(secretOf(bundle));
      }
    });

    // Break caught: the leftover of a write that was still in flight when the run was abandoned, and that failed afterwards.
    it('names the file of a write that failed after the run was abandoned', async () => {
      const { disk, dependencies } = build();
      let release: () => void = () => undefined;
      disk.writeGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      disk.partialWriteChars = 300;
      disk.stuck.add(`${DIRECTORY}/melarc-bootstrap-${'1'.padStart(32, '0')}.bundle`);
      const calls: BootstrapCalls = {
        status: () => Promise.resolve({ staffIdentities: 0 }),
        seed: () => Promise.resolve(GOOD_SEED),
        identityState: () => Promise.reject(new Error('not used by the seed')),
        resume: () => Promise.reject(new Error('not used by the seed')),
      };
      const failedSoon = new Promise<never>((_resolve, reject) => {
        setTimeout(() => {
          reject(new Error('the budget ran out'));
        }, 20);
      });
      const racing: BootstrapDependencies = {
        ...dependencies,
        open: () => ({
          database: { run: (_id, work) => Promise.race([work(calls), failedSoon]) },
          close: () => Promise.resolve(),
        }),
      };
      setTimeout(release, 80);
      const out = lines();

      const failure = await outcomeOf(
        runBootstrapSeed(['--custodian', FIRST, '--custodian', SECOND], ENV, out.write, racing),
      );

      expect(failure.message).toBe('the budget ran out');
      expect(out.text()).toContain(`melarc-bootstrap-${'1'.padStart(32, '0')}.bundle`);
      expect(out.text()).toMatch(/could not be removed/);
      expect(disk.calls.filter((call) => call === 'create')).toHaveLength(1);
    });

    it('says nothing about leftovers when every failed file was removed', async () => {
      const { disk, dependencies } = build();
      disk.partialWriteChars = 300;
      disk.partialWriteNumber = 2;
      const out = lines();

      await outcomeOf(
        runBootstrapSeed(
          ['--custodian', FIRST, '--custodian', SECOND],
          ENV,
          out.write,
          dependencies,
        ),
      );

      expect(out.text()).not.toMatch(/could not be removed/);
      expect(disk.files.size).toBe(0);
    });

    // Break caught (the audit: "preserving unknown-commit bundles"): the report of a leftover discarding the bundles of a commit whose
    // outcome is not known, which are the only copies of the secrets if the pair did commit.
    it('keeps the bundles of a commit whose outcome is not known, whatever else it reports', async () => {
      const { disk, dependencies } = build({
        commit: new CommitOutcomeUnknownError('connection-lost', { cause: new Error('lost') }),
      });
      disk.stuck.add(`${DIRECTORY}/melarc-bootstrap-${'1'.padStart(32, '0')}.bundle`);
      const out = lines();

      await outcomeOf(
        runBootstrapSeed(
          ['--custodian', FIRST, '--custodian', SECOND],
          ENV,
          out.write,
          dependencies,
        ),
      );

      expect(disk.files.size).toBe(2);
      expect(disk.calls).not.toContain('remove');
    });
  });

  it('closes the database on every path', async () => {
    for (const behaviour of [
      {},
      { rows: 1 },
      { commit: new TransactionRolledBackError() },
    ] as Behaviour[]) {
      const { run, dependencies } = build(behaviour);
      await runBootstrapSeed(
        ['--custodian', FIRST, '--custodian', SECOND],
        ENV,
        lines().write,
        dependencies,
      ).catch(() => undefined);
      expect(run.closed).toBe(1);
    }
  });

  // Break caught: the command refusing the argument list the documented invocation produces. `pnpm run bootstrap:seed -- --custodian ..`
  // hands the script a leading `--`, which separates pnpm's options from the script's and names no flag of the command.
  it('accepts the leading -- that pnpm passes, once, and no other stray argument', async () => {
    const { run, dependencies } = build();
    await runBootstrapSeed(
      ['--', '--custodian', FIRST, '--custodian', SECOND],
      ENV,
      lines().write,
      dependencies,
    );
    expect(run.calls).toEqual(['status', 'seed']);

    for (const argv of [
      ['--', '--', '--custodian', FIRST, '--custodian', SECOND],
      ['--custodian', FIRST, '--', '--custodian', SECOND],
      ['--custodian', FIRST, '--custodian', SECOND, '--'],
    ]) {
      const refused = build();
      const failure = await outcomeOf(
        runBootstrapSeed(argv, ENV, lines().write, refused.dependencies),
      );
      expect(failure, argv.join(' ')).toBeInstanceOf(BootstrapInputError);
      expect(refused.opened).toEqual([]);
    }
  });

  it('accepts the leading -- on the resume command as well', async () => {
    const { run, dependencies } = build({ facts: STRANDED, resume: resumed() });
    await runBootstrapResume(
      ['--', '--custodian', 'kofi.boateng@melarc.example'],
      ENV,
      lines().write,
      dependencies,
    );
    expect(run.calls).toEqual(['state:kofi.boateng@melarc.example', 'resume']);
  });

  it('judges the target the way the seed command does: a deployed database is named, with its environment', async () => {
    const { dependencies, opened } = build();
    const env = {
      ...ENV,
      DATABASE_SEED_URL: 'postgresql://melarc_provisioning:x@db.internal:5432/melarc',
      APP_ENV: 'production',
    };
    await runBootstrapSeed(
      ['--custodian', FIRST, '--custodian', SECOND],
      env,
      lines().write,
      dependencies,
    );
    expect(opened).toEqual([env.DATABASE_SEED_URL]);
    const refused = build();
    await expect(
      runBootstrapSeed(
        ['--custodian', FIRST, '--custodian', SECOND],
        { ...ENV, DATABASE_SEED_URL: env.DATABASE_SEED_URL },
        lines().write,
        refused.dependencies,
      ),
    ).rejects.toThrow(/APP_ENV/);
    expect(refused.opened).toEqual([]);
    const wrongLogin = build();
    await expect(
      runBootstrapSeed(
        ['--custodian', FIRST, '--custodian', SECOND],
        {
          ...ENV,
          DATABASE_SEED_URL: 'postgresql://melarc_api_runtime:x@db.internal:5432/melarc',
          APP_ENV: 'production',
        },
        lines().write,
        wrongLogin.dependencies,
      ),
    ).rejects.toThrow(/provisioning login/);
    expect(wrongLogin.opened).toEqual([]);
  });
});

const IDENTITY = '0197a0a0-0000-7000-8000-0000000000aa';
const FACTOR = '0197a0a0-0000-7000-8000-0000000000bb';
const STRANDED: IdentityFacts = {
  state: {
    id: IDENTITY,
    credentialEstablished: true,
    pendingFactorIds: [FACTOR],
    liveBootstrapGrantId: null,
    lapsedGrants: [],
  },
  custodian: { fullName: 'Kofi Boateng', workEmail: 'Kofi.Boateng@melarc.example' },
};
const LOST: IdentityFacts = {
  state: {
    id: IDENTITY,
    credentialEstablished: false,
    pendingFactorIds: [],
    liveBootstrapGrantId: '0197a0a0-0000-7000-8000-0000000000cc',
    lapsedGrants: [],
  },
  custodian: STRANDED.custodian,
};

const resumed = (
  overrides: Partial<ResumeOutcome> = {},
): ((document: string) => Promise<ResumeOutcome>) => {
  return (document) => {
    const parsed = JSON.parse(document) as {
      grant: { id: string };
      path: 'REENROLMENT' | 'BUNDLE_LOST';
    };
    return Promise.resolve({
      path: parsed.path,
      grantId: parsed.grant.id,
      purpose: parsed.path === 'REENROLMENT' ? 'MFA_REENROLMENT' : 'BOOTSTRAP_SETUP',
      issuedAt: NOW,
      expiresAt: parsed.path === 'REENROLMENT' ? new Date(NOW.getTime() + 30 * 60_000) : null,
      revokedFactorIds: parsed.path === 'REENROLMENT' ? [FACTOR] : [],
      supersededGrantId:
        parsed.path === 'BUNDLE_LOST' ? '0197a0a0-0000-7000-8000-0000000000cc' : null,
      expiredGrantIds: [],
      ...overrides,
    });
  };
};

describe('the bootstrap resume command (S0.30)', () => {
  it('reads the identity by its canonical work email, plans the path its state shows, and writes one bundle after the change', async () => {
    const { disk, run, dependencies } = build({ facts: STRANDED, resume: resumed() });
    const out = lines();
    await runBootstrapResume(
      ['--custodian', 'KOFI.Boateng@Melarc.Example'],
      ENV,
      out.write,
      dependencies,
    );

    expect(run.calls).toEqual(['state:kofi.boateng@melarc.example', 'resume']);
    expect(disk.calls).toEqual([
      'ensureDirectory',
      'assertPrivateDirectory',
      'inspectDirectory',
      'db:state',
      'db:resume',
      'create',
      'secure',
      'inspect',
      'write',
      'close',
    ]);
    const [bundle] = bundlesWritten(disk);
    expect(bundle).toContain('custodian: Kofi Boateng <Kofi.Boateng@melarc.example>');
    expect(bundle).toContain('purpose: MFA_REENROLMENT');
    expect(bundle).toContain('expires: 2026-10-21T09:30:00.000Z');
    expect(out.text()).toMatch(/path REENROLMENT/);
    expect(out.text()).toMatch(/revoked 1 stale factor/);
    expect(out.text()).toMatch(/bundle: melarc-bootstrap-[0-9a-f]{32}\.bundle/);
    expect(run.closed).toBe(1);
  });

  it('supersedes a lost secret with a new BOOTSTRAP_SETUP that never expires, on the lost-bundle path', async () => {
    const { disk, dependencies } = build({ facts: LOST, resume: resumed() });
    const out = lines();
    await runBootstrapResume(
      ['--custodian', 'kofi.boateng@melarc.example'],
      ENV,
      out.write,
      dependencies,
    );
    const [bundle] = bundlesWritten(disk);
    expect(bundle).toContain('purpose: BOOTSTRAP_SETUP');
    expect(bundle).toContain('expires: never');
    expect(out.text()).toMatch(/path BUNDLE_LOST/);
    expect(out.text()).toMatch(/superseded the unconsumed secret/);
  });

  // Break caught: the same leaks as the seed's: the secret in the document, the output, or anywhere but the bundle; an address printed.
  it('keeps the secret out of the document and the output, and names no custodian', async () => {
    const { disk, run, dependencies } = build({ facts: STRANDED, resume: resumed() });
    const out = lines();
    await runBootstrapResume(
      ['--custodian', 'kofi.boateng@melarc.example'],
      ENV,
      out.write,
      dependencies,
    );
    const [bundle] = bundlesWritten(disk);
    const secret = secretOf(bundle ?? '');
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    for (const document of run.documents) expect(document).not.toContain(secret);
    expect(out.text()).not.toContain(secret);
    for (const forbidden of ['Kofi', 'Boateng', 'melarc.example', '@', DIRECTORY]) {
      expect(out.text(), forbidden).not.toContain(forbidden);
    }
  });

  // Break caught: a bundle written for a change the database refused: a secret for nobody, or one that looks live.
  it.each([
    'NOT_BOOTSTRAP_IDENTITY',
    'OFFBOARDED',
    'ACTIVE_FACTOR',
    'LIVE_SESSION',
    'LIVE_GRANT',
    'SETTING_MISSING',
    'STATE_CHANGED',
  ] as const)(
    'writes no bundle when the database refuses on %s, and says the rule',
    async (reason) => {
      const { disk, run, dependencies } = build({
        facts: STRANDED,
        resume: () => Promise.reject(new BootstrapRefusedError(reason)),
      });
      const failure = await outcomeOf(
        runBootstrapResume(
          ['--custodian', 'kofi.boateng@melarc.example'],
          ENV,
          lines().write,
          dependencies,
        ),
      );
      expect(failure).toBeInstanceOf(BootstrapRefusedError);
      expect((failure as BootstrapRefusedError).reason).toBe(reason);
      expect(disk.calls).not.toContain('create');
      expect(run.closed).toBe(1);
    },
  );

  it('writes no bundle and plans nothing when the identity is not one to resume', async () => {
    const { disk, run, dependencies } = build({
      factsFailure: new BootstrapRefusedError('NO_SUCH_IDENTITY'),
    });
    const failure = await outcomeOf(
      runBootstrapResume(
        ['--custodian', 'nobody@melarc.example'],
        ENV,
        lines().write,
        dependencies,
      ),
    );
    expect((failure as BootstrapRefusedError).reason).toBe('NO_SUCH_IDENTITY');
    expect(run.calls).toEqual(['state:nobody@melarc.example']);
    expect(disk.calls).not.toContain('create');
  });

  // The change is in the open transaction when the bundle is written: a bundle that cannot be written rolls it back, and the
  // identity keeps the state it had.
  it('rolls the change back when its bundle cannot be written, leaving no file', async () => {
    const { disk, dependencies } = build({ facts: STRANDED, resume: resumed() });
    disk.failWrite = true;
    const failure = await outcomeOf(
      runBootstrapResume(
        ['--custodian', 'kofi.boateng@melarc.example'],
        ENV,
        lines().write,
        dependencies,
      ),
    );
    expect((failure as BootstrapCustodyError).problem).toBe('WRITE_FAILED');
    expect(disk.files.size).toBe(0);
  });

  it('removes its bundle when the commit is refused, and keeps it when the outcome is unknown', async () => {
    const refused = build({
      facts: STRANDED,
      resume: resumed(),
      commit: new TransactionRolledBackError(),
    });
    await outcomeOf(
      runBootstrapResume(
        ['--custodian', 'kofi.boateng@melarc.example'],
        ENV,
        lines().write,
        refused.dependencies,
      ),
    );
    expect(refused.disk.files.size).toBe(0);

    const unknown = build({
      facts: STRANDED,
      resume: resumed(),
      commit: new CommitOutcomeUnknownError('connection-lost', {
        cause: new Error('connection lost'),
      }),
    });
    const out = lines();
    await outcomeOf(
      runBootstrapResume(
        ['--custodian', 'kofi.boateng@melarc.example'],
        ENV,
        out.write,
        unknown.dependencies,
      ),
    );
    expect(unknown.disk.files.size).toBe(1);
    expect(out.text()).toMatch(/could not tell whether the change was committed/);
  });

  /**
   * After a commit whose outcome is unknown the bundle stays, because if the change did commit it holds the only copy of the new
   * secret. The guidance is not "run it again": on the lost-bundle path a second run supersedes the secret again (and the bundle left
   * behind then holds one that no longer works), and on the re-enrolment path it is refused while the first grant lives. And it is not
   * "no event means it did not commit" either: an absent row in one read is not a rollback (the transaction may still be finishing, the
   * read may not be of the primary database or may not see the rows), so the operator reconciles on the primary, with access that
   * sees the audit trail, in a fresh transaction that first waits for the original one to end, and only a definite rollback permits
   * the bundle to go (the review of 21 October 2026, C01; MIGRATION_AND_SEEDING.md §3.3b).
   */
  describe('after a commit whose outcome is not known', () => {
    it.each([
      ['the re-enrolment path', STRANDED, 'REENROLMENT'],
      ['the lost-bundle path', LOST, 'BUNDLE_LOST'],
    ] as const)(
      'keeps the bundle and says to find out before running it again, on %s',
      async (_name, facts, path) => {
        const { disk, run, dependencies } = build({
          facts,
          resume: resumed(),
          commit: new CommitOutcomeUnknownError('connection-lost', { cause: new Error('lost') }),
        });
        const out = lines();

        const failure = await outcomeOf(
          runBootstrapResume(
            ['--custodian', 'kofi.boateng@melarc.example'],
            ENV,
            out.write,
            dependencies,
          ),
        );

        expect(failure).toBeInstanceOf(CommitOutcomeUnknownError);
        expect(JSON.parse(run.documents[0] ?? '{}')).toMatchObject({ path });
        // the bundle is the only copy of the secret if the change committed, so it is never removed
        expect(disk.files.size).toBe(1);
        expect(disk.calls).not.toContain('remove');
        const text = out.text();
        expect(text).toMatch(/could not tell whether the change was committed/);
        expect(text).toContain('bootstrap-run-1');
        // the bundle is kept, and so is the secret: neither is deleted nor replaced until the outcome is established
        expect(text).toMatch(/do not delete it/i);
        expect(text).toMatch(/do not run the resume again/i);
        // an absent event is unresolved, and the reconciliation is the one that waits for the original transaction on the primary
        expect(text).toMatch(/does not show that it did not commit/i);
        expect(text).toMatch(/primary database/i);
        expect(text).toMatch(/fresh transaction that first waits for the original one to end/i);
        // the four outcomes it must tell apart, and which of them lets the bundle go
        expect(text).toMatch(/committed and current/i);
        expect(text).toMatch(/replaced or used/i);
        expect(text).toMatch(/not committed/i);
        expect(text).toMatch(/unresolved/i);
        expect(text).toMatch(/3\.3b/);
        // the wrong advice: that running it again is safe either way, or that a missing event lets the bundle go
        expect(text).not.toMatch(/run the resume again: it refuses/);
        expect(text).not.toMatch(/sweeps and rewrites/);
        expect(text).not.toMatch(/none says it is not|finding none|if it is not there/i);
        expect(text).not.toMatch(/until you know:? if the change was committed/i);
        for (const forbidden of ['Kofi', 'Boateng', 'melarc.example', '@', DIRECTORY]) {
          expect(text, forbidden).not.toContain(forbidden);
        }
      },
    );
  });

  // Break caught: the leftover of a bundle that failed to write and could not be removed, on the resume as on the seed.
  it('names a file that holds part of a secret when its bundle fails to write and cannot be removed', async () => {
    const { disk, dependencies } = build({ facts: STRANDED, resume: resumed() });
    const name = `melarc-bootstrap-${'1'.padStart(32, '0')}.bundle`;
    disk.partialWriteChars = 300;
    disk.stuck.add(`${DIRECTORY}/${name}`);
    const out = lines();

    const failure = await outcomeOf(
      runBootstrapResume(
        ['--custodian', 'kofi.boateng@melarc.example'],
        ENV,
        out.write,
        dependencies,
      ),
    );

    expect((failure as BootstrapCustodyError).problem).toBe('WRITE_FAILED');
    expect(out.text()).toContain(name);
    expect(out.text()).toMatch(/could not be removed/);
    expect(out.text()).not.toContain(DIRECTORY);
  });

  it.each([
    [[], 'ARGUMENTS'],
    [['--custodian'], 'ARGUMENTS'],
    [['--custodian', 'a@melarc.example', '--custodian', 'b@melarc.example'], 'ARGUMENTS'],
    [['--custodian', 'not-an-address'], 'CUSTODIAN_EMAIL'],
    [['kofi@melarc.example'], 'ARGUMENTS'],
  ] as const)('refuses the arguments %j (%s) before it opens a database', async (argv, problem) => {
    const { run, dependencies, opened } = build({ facts: STRANDED, resume: resumed() });
    const failure = await outcomeOf(
      runBootstrapResume([...argv], ENV, lines().write, dependencies),
    );
    expect((failure as BootstrapInputError).problem).toBe(problem);
    expect(opened).toEqual([]);
    expect(run.calls).toEqual([]);
  });

  it('calls no function of the seed: the resume never creates an identity', async () => {
    const { run, dependencies } = build({ facts: STRANDED, resume: resumed() });
    await runBootstrapResume(
      ['--custodian', 'kofi.boateng@melarc.example'],
      ENV,
      lines().write,
      dependencies,
    );
    expect(run.calls).not.toContain('seed');
    expect(run.calls).not.toContain('status');
  });

  it('is run for one identity and so makes one grant: the document names one identity and one grant', async () => {
    const spy = vi.fn(resumed());
    const { run, dependencies } = build({ facts: STRANDED, resume: spy });
    await runBootstrapResume(
      ['--custodian', 'kofi.boateng@melarc.example'],
      ENV,
      lines().write,
      dependencies,
    );
    expect(spy).toHaveBeenCalledTimes(1);
    const document = JSON.parse(run.documents[0] ?? '{}') as {
      identity_id: string;
      grant: { id: string };
    };
    expect(document.identity_id).toBe(IDENTITY);
    expect(document.grant.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
