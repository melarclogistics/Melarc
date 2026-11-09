import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  MIGRATIONS_DIRECTORY,
  MigrationBaseError,
  MigrationImmutabilityError,
  checkMigrationImmutability,
} from './migration-immutability.ts';

/**
 * The guard of task A3.3 (the audit follow-up of 7 November 2026): a migration that main has is never changed, renamed or removed; one that is only on a
 * branch is free until it merges. Nothing here is mocked: each case is a real repository and the guard asks Git itself, as CI and the precheck do.
 */
const SCRIPT = resolve(import.meta.dirname, 'migration-immutability.ts');
const created: string[] = [];
after(() => {
  for (const directory of created) rmSync(directory, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function write(root: string, path: string, content: string): void {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

const journalOf = (...tags: string[]): string =>
  JSON.stringify(
    {
      version: '7',
      dialect: 'postgresql',
      entries: tags.map((tag, idx) => ({
        idx,
        version: '7',
        when: 1_790_000_000_000 + idx,
        tag,
        breakpoints: true,
      })),
    },
    null,
    2,
  );

const MIGRATION = `${MIGRATIONS_DIRECTORY}/0000_foundation.sql`;
const SNAPSHOT = `${MIGRATIONS_DIRECTORY}/meta/0000_snapshot.json`;
const JOURNAL = `${MIGRATIONS_DIRECTORY}/meta/_journal.json`;

/** A repository whose `main` holds migration 0000, its snapshot and the journal of one entry, and a branch `feature` at the same commit. */
function repository(
  options: { readonly withMain?: boolean; readonly withMigrations?: boolean } = {},
): string {
  const root = mkdtempSync(join(tmpdir(), 'melarc-migrations-'));
  created.push(root);
  git(root, 'init', '--quiet');
  git(root, 'config', 'user.email', 'guard@example.invalid');
  git(root, 'config', 'user.name', 'Guard test');
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'config', 'commit.gpgsign', 'false');
  write(root, '.gitattributes', '* text=auto eol=lf\n');
  write(root, 'README.md', 'the repository\n');
  if (options.withMigrations !== false) {
    write(root, MIGRATION, 'create table a ();\n');
    write(root, SNAPSHOT, '{"id":"0"}\n');
    write(root, JOURNAL, journalOf('0000_foundation'));
  }
  git(root, 'add', '-A');
  git(root, 'commit', '--quiet', '-m', 'main');
  git(root, 'branch', '-M', options.withMain === false ? 'trunk' : 'main');
  git(root, 'checkout', '--quiet', '-b', 'feature');
  return root;
}

/** The branch adds migration 0001 with its snapshot and a journal entry, commits, and may then edit it. */
function addMigrationOnBranch(root: string): void {
  write(root, `${MIGRATIONS_DIRECTORY}/0001_next.sql`, 'create table b ();\n');
  write(root, `${MIGRATIONS_DIRECTORY}/meta/0001_snapshot.json`, '{"id":"1"}\n');
  write(root, JOURNAL, journalOf('0000_foundation', '0001_next'));
  git(root, 'add', '-A');
  git(root, 'commit', '--quiet', '-m', 'branch');
}

describe('a branch beside a main that holds migration 0000', () => {
  // Break caught: a guard that freezes what main does not have, so that a branch could not correct its own unreleased migration; or one that does not
  // look at the files that are added (a new migration and its snapshot) and fails on the journal that gains an entry with each of them.
  it('passes with nothing changed, and with a migration added and its journal entry appended', () => {
    const root = repository();
    addMigrationOnBranch(root);

    const report = checkMigrationImmutability({ root });

    assert.deepEqual(report.problems, []);
    assert.equal(report.held, 3, 'the migration, its snapshot and the journal are what main has');
    assert.equal(report.free, 2, 'the new migration and its snapshot are not on main');
  });

  // Break caught: the whole point of the guard: a migration main has, edited on the branch (committed or not).
  for (const [how, commit] of [
    ['committed', true],
    ['not committed', false],
  ] as const) {
    it(`fails when migration 0000 is edited, ${how}`, () => {
      const root = repository();
      write(root, MIGRATION, 'create table a (id int);\n');
      if (commit) {
        git(root, 'add', '-A');
        git(root, 'commit', '--quiet', '-m', 'edit');
      }

      const report = checkMigrationImmutability({ root });

      assert.equal(report.problems.length, 1);
      assert.match(report.problems[0] ?? '', /0000_foundation\.sql is changed, and main has it/);
    });
  }

  // Break caught: a removal or a rename, which leaves no changed file to compare: the migration main has simply is not there.
  it('fails when migration 0000 is removed or renamed', () => {
    const root = repository();
    unlinkSync(join(root, MIGRATION));
    write(root, `${MIGRATIONS_DIRECTORY}/0000_renamed.sql`, 'create table a ();\n');

    const report = checkMigrationImmutability({ root });

    assert.equal(report.problems.length, 1);
    assert.match(report.problems[0] ?? '', /0000_foundation\.sql is removed or renamed/);
  });

  // Break caught: the snapshot of a frozen migration treated as free, or any other file of the folder that main has.
  it('fails when the snapshot of migration 0000 is edited', () => {
    const root = repository();
    write(root, SNAPSHOT, '{"id":"changed"}\n');

    const report = checkMigrationImmutability({ root });

    assert.match(report.problems.join('\n'), /0000_snapshot\.json is changed, and main has it/);
  });

  // Break caught: a migration of the branch frozen the moment it is committed. It is on no environment until it merges.
  it('does not freeze a migration that only the branch has: it may be corrected in place', () => {
    const root = repository();
    addMigrationOnBranch(root);
    write(root, `${MIGRATIONS_DIRECTORY}/0001_next.sql`, 'create table b (id int);\n');
    git(root, 'add', '-A');
    git(root, 'commit', '--quiet', '-m', 'correct the branch migration');

    assert.deepEqual(checkMigrationImmutability({ root }).problems, []);
  });

  // Break caught: a guard that compares bytes of the working copy, so that a Windows checkout with CRLF fails on every file; Git's own form is what counts.
  it('does not count a working copy that has other line endings than Git stores', () => {
    const root = repository();
    write(root, MIGRATION, 'create table a ();\r\n');

    assert.deepEqual(checkMigrationImmutability({ root }).problems, []);
  });
});

describe('the journal, which gains an entry with every migration', () => {
  // Break caught: the journal held byte for byte (every new migration would fail the guard), or not held at all (an applied migration's entry rewritten).
  for (const [what, replacement, expected] of [
    [
      'an entry of main changed',
      journalOf('0000_renamed'),
      /entry 0 \(0000_foundation\), which main has, is changed/,
    ],
    [
      'an entry of main removed',
      JSON.stringify({ version: '7', dialect: 'postgresql', entries: [] }),
      /entry 0 \(0000_foundation\), which main has, is gone/,
    ],
  ] as const) {
    it(`fails when ${what}`, () => {
      const root = repository();
      write(root, JOURNAL, replacement);

      const report = checkMigrationImmutability({ root });

      assert.match(report.problems.join('\n'), expected);
    });
  }

  // Break caught: a journal that is not JSON any more being read as "no entries to hold".
  it('fails when the journal is no longer a journal of entries', () => {
    const root = repository();
    write(root, JOURNAL, 'not json');

    assert.match(
      checkMigrationImmutability({ root }).problems.join('\n'),
      /is not a journal of entries any more/,
    );
  });
});

describe('what the guard will not decide', () => {
  // Break caught: a guard that passes when it has no main to look at, which is how a missing fetch in CI would turn a safety check into a ritual.
  it('says there is no main, and does not pass, when the clone has none', () => {
    const root = repository({ withMain: false });

    assert.throws(
      () => checkMigrationImmutability({ root }),
      (error: unknown) =>
        error instanceof MigrationImmutabilityError && error.message.includes('no main to compare'),
    );
  });

  // Break caught: a base with no migration in it (a wrong base, or a moved folder) passing because there is nothing to differ from.
  it('says so, and does not pass, when the base holds no migration at all', () => {
    const root = repository({ withMigrations: false });

    assert.throws(
      () => checkMigrationImmutability({ root }),
      (error: unknown) =>
        error instanceof MigrationImmutabilityError &&
        error.message.includes('holds no file under'),
    );
  });

  // Break caught: a base name taken on trust (a typo that compares with nothing and passes), or an all-zero revision (what a push event names for a new
  // branch) taken for a commit.
  it('refuses a base that is not a commit, and reads an all-zero base as none named', () => {
    const root = repository();
    write(root, MIGRATION, 'create table a (id int);\n');

    assert.throws(
      () => checkMigrationImmutability({ root, base: 'no-such-revision' }),
      (error: unknown) =>
        error instanceof MigrationImmutabilityError && error.message.includes('is not a commit'),
    );
    const report = checkMigrationImmutability({ root, base: '0'.repeat(40) });
    assert.equal(report.problems.length, 1, 'the merge base was used instead');
  });

  // Break caught (run 5, Stage 1.4): an empty base ignored, so that `MELARC_MIGRATION_BASE=$BASE` with an unset variable, or `--base ""`, holds the tree to the merge base
  // and says nothing; and a mistyped base told as "could not tell", which the precheck shows as a warning and goes on. A base that was named and cannot be used is a mistake of
  // the caller: its own error, which the command ends with exit 1 everywhere.
  it('refuses a base that is named and empty, or named and not a commit, as a mistake of the caller and not as a guard that cannot tell', () => {
    const root = repository();
    const mistake = (error: unknown, words: RegExp): boolean =>
      error instanceof MigrationBaseError && words.test(error.message);

    for (const empty of ['', '   ', '\t']) {
      assert.throws(
        () => checkMigrationImmutability({ root, base: empty }),
        (error: unknown) => mistake(error, /is empty/),
        `the argument ${JSON.stringify(empty)}`,
      );
      assert.throws(
        () => checkMigrationImmutability({ root, env: { MELARC_MIGRATION_BASE: empty } }),
        (error: unknown) => mistake(error, /MELARC_MIGRATION_BASE is set but empty/),
        `the variable ${JSON.stringify(empty)}`,
      );
    }
    for (const mistyped of ['no-such-revision', '0'.repeat(39), 'a'.repeat(40)]) {
      assert.throws(
        () => checkMigrationImmutability({ root, base: mistyped }),
        (error: unknown) => mistake(error, /is not a commit/),
        `the base ${mistyped}`,
      );
    }
    // A variable that is not set at all is no base named, and the merge base is used.
    assert.equal(checkMigrationImmutability({ root, env: {} }).problems.length, 0);
    // The mistake is not "could not decide" for any caller that tells the two apart.
    assert.ok(new MigrationBaseError('x') instanceof MigrationImmutabilityError);
  });

  // Break caught: the environment's base ignored (a CI push event names the revision it came from), or preferred over an explicit argument.
  it('takes the base from MELARC_MIGRATION_BASE, and an argument wins over it', () => {
    const root = repository();
    const first = git(root, 'rev-parse', 'HEAD');
    write(root, MIGRATION, 'create table a (id int);\n');
    git(root, 'add', '-A');
    git(root, 'commit', '--quiet', '-m', 'edit');
    const second = git(root, 'rev-parse', 'HEAD');

    const against = (env: NodeJS.ProcessEnv, base?: string) =>
      checkMigrationImmutability({ root, env, base }).problems.length;

    assert.equal(against({}), 1, 'against the merge base, main, the edit is seen');
    assert.equal(
      against({ MELARC_MIGRATION_BASE: second }),
      0,
      'against the edited commit it is not',
    );
    assert.equal(against({ MELARC_MIGRATION_BASE: second }, first), 1, 'the argument wins');
  });

  // Break caught: on main itself the merge base is HEAD, and a guard that then passes without looking would let an edit of a committed migration through;
  // what it holds there is the working tree against HEAD.
  it('on main itself, holds the working tree to HEAD', () => {
    const root = repository();
    git(root, 'checkout', '--quiet', 'main');

    assert.deepEqual(checkMigrationImmutability({ root }).problems, []);
    write(root, MIGRATION, 'create table a (id int);\n');
    assert.equal(checkMigrationImmutability({ root }).problems.length, 1);
  });
});

describe('the command', () => {
  /** The command as a developer's shell runs it (no `CI`) and as CI does (`CI=true`). */
  const environment = (ci: boolean): NodeJS.ProcessEnv => {
    const copy: NodeJS.ProcessEnv = { ...process.env };
    delete copy.CI;
    return ci ? { ...copy, CI: 'true' } : copy;
  };
  const runIn = (ci: boolean, root: string, ...args: string[]) =>
    spawnSync('node', [SCRIPT, ...args], { cwd: root, encoding: 'utf8', env: environment(ci) });
  const run = (root: string, ...args: string[]) => runIn(true, root, ...args);

  // Break caught: the exit codes the precheck and CI read: 0 held, 1 changed, 2 could not decide, with the words that say what to do.
  it('exits 0 when held, 1 when a migration of main was changed and 2 when it cannot tell', () => {
    const held = repository();
    const ok = run(held);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /Migrations held: 3 files of the base/);

    const changed = repository();
    write(changed, MIGRATION, 'create table a (id int);\n');
    const failed = run(changed);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /A migration that main has was changed/);
    assert.match(failed.stderr, /Put it back and add a new migration/);

    const undecided = repository({ withMain: false });
    const unknown = run(undecided);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /Cannot tell whether a migration was changed: There is no main/);
  });

  // Break caught (run 5, Stage 1.4; it replaces the exit 0 that run 4 gave outside CI): a guard that cannot tell exiting 0 outside CI, so that the precheck said "passed"
  // and kept the warning in a log nobody opens. It exits 2, in CI and outside it, with the words that say why on stderr and no word of having held anything; whoever
  // calls it decides what 2 costs (the precheck shows it as warned, the gate and CI fail on it).
  it('exits 2 when it cannot tell, in CI and outside it, and says nothing was held', () => {
    const undecided = repository({ withMain: false });

    for (const ci of [false, true]) {
      const result = runIn(ci, undecided);
      assert.equal(result.status, 2, `${ci ? 'in' : 'outside'} CI: ${result.stderr}`);
      assert.match(
        result.stderr,
        /Cannot tell whether a migration was changed: There is no main to compare/,
      );
      assert.doesNotMatch(result.stderr, /Warning, not a failure/);
      assert.doesNotMatch(result.stdout, /Migrations held/, 'nothing was held');
    }

    // A tree that has a revision to be held to can name it, and then it decides, outside CI as in CI.
    const base = git(undecided, 'rev-parse', 'HEAD');
    for (const ci of [false, true]) {
      const named = runIn(ci, undecided, '--base', base);
      assert.equal(named.status, 0, named.stderr);
      assert.match(named.stdout, /Migrations held/);
    }
  });

  // Break caught (run 5, Stage 1.4): a base that is empty or mistyped treated as none named (CI's expression for a pull request is empty), or as "could not tell" (a warning
  // in the precheck). It is exit 1 whoever runs it, with a message that names what was wrong, and a base that is all zeros (what a push event names for a new branch) is
  // still none named.
  it('fails with exit 1, in CI and outside it, when the base named is empty or is not a commit', () => {
    const root = repository();
    const cases: {
      readonly label: string;
      readonly args: string[];
      readonly env: NodeJS.ProcessEnv;
      readonly words: RegExp;
    }[] = [
      {
        label: 'an empty variable',
        args: [],
        env: { MELARC_MIGRATION_BASE: '' },
        words: /MELARC_MIGRATION_BASE is set but empty/,
      },
      {
        label: 'a blank variable',
        args: [],
        env: { MELARC_MIGRATION_BASE: '  ' },
        words: /MELARC_MIGRATION_BASE is set but empty/,
      },
      { label: 'an empty --base', args: ['--base', ''], env: {}, words: /--base is empty/ },
      {
        label: 'a mistyped variable',
        args: [],
        env: { MELARC_MIGRATION_BASE: 'mian' },
        words: /"mian" is not a commit/,
      },
      {
        label: 'a mistyped --base',
        args: ['--base', 'mian'],
        env: {},
        words: /"mian" is not a commit/,
      },
    ];
    for (const ci of [false, true]) {
      for (const { label, args, env, words } of cases) {
        const result = spawnSync('node', [SCRIPT, ...args], {
          cwd: root,
          encoding: 'utf8',
          env: { ...environment(ci), ...env },
        });
        assert.equal(result.status, 1, `${label}, ${ci ? 'in' : 'outside'} CI: ${result.stderr}`);
        assert.match(result.stderr, words, label);
        assert.doesNotMatch(result.stdout, /Migrations held/, label);
      }
    }
    // The zero revision is no base named: the merge base is used and the guard decides.
    const zero = runIn(false, root, '--base', '0'.repeat(40));
    assert.equal(zero.status, 0, zero.stderr);
  });

  // Break caught: a change of a migration main has going unnoticed outside CI because the warning's exit 0 was given to every outcome.
  it('still fails outside CI when a migration of main was changed', () => {
    const changed = repository();
    write(changed, MIGRATION, 'create table a (id int);\n');

    const failed = runIn(false, changed);

    assert.equal(failed.status, 1);
  });

  // Break caught: an option the command does not know being ignored, so that a typo of --base compares with the wrong revision without a word. It is exit 1 and not 2 (run 5,
  // Stage 1.4): 2 is "could not tell", which the precheck shows as a warning and goes on, and a misuse of the command must stop it.
  it('refuses an argument it does not know, and --base without a revision, with exit 1', () => {
    const root = repository();

    for (const ci of [false, true]) {
      assert.equal(runIn(ci, root, '--bsae', 'x').status, 1);
      assert.equal(runIn(ci, root, '--base').status, 1);
    }
  });
});
