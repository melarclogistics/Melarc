import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  BOOTSTRAP_RESUME,
  BOOTSTRAP_SEED,
  killAll,
  requireBuild,
  run,
} from './support/api-process.js';

beforeAll(requireBuild);
afterEach(killAll);

/**
 * The two bootstrap commands (S0.30) as processes, the way an operator starts them: the built entry scripts, with no database and no
 * file made. Until now their composition root (`bootstrap-runtime.ts`) and the two scripts were run by no test: the command's logic
 * is tested against fakes and, with a real database, against an entry that the test builds itself. What only a process shows is
 * what these check: the arguments as `pnpm run` hands them, the refusals that come before a database or a file, the failure of a
 * database that cannot be reached, and that none of it prints a secret, a custodian or a path.
 *
 * **No custody file and no credential is made**: every run here ends before a bundle exists, and the folder the last test names is
 * a disposable one of the temporary directory that is empty when the command is gone.
 */

const SECRETS = ['ADMIN-SECRET-PW', 'MIGRATION-SECRET-PW', 'RUNTIME-SECRET-PW'];
const FIRST = 'Kofi Boateng <kofi.boateng@melarc.example>';
const SECOND = 'Efua Addo <efua.addo@melarc.example>';
const PERSONAL = ['kofi.boateng', 'Kofi Boateng', 'efua.addo', 'Efua Addo'];

/** A complete local configuration that points at a port nothing listens on, as the other tool process tests have. */
const LOCAL: Record<string, string> = {
  MELARC_PG_HOST: '127.0.0.1',
  MELARC_PG_PORT: '1',
  MELARC_PG_ADMIN_PASSWORD: SECRETS[0] ?? '',
  MELARC_PG_MIGRATION_PASSWORD: SECRETS[1] ?? '',
  MELARC_PG_RUNTIME_PASSWORD: SECRETS[2] ?? '',
  // A child process is given only what a test passes: the temporary directory is what the access inspection of Windows works in.
  TEMP: tmpdir(),
  TMP: tmpdir(),
  TMPDIR: tmpdir(),
};

const disposable: string[] = [];
afterAll(() => {
  for (const directory of disposable) rmSync(directory, { recursive: true, force: true });
});

function nothingSensitive(output: string): void {
  for (const value of [...SECRETS, ...PERSONAL]) expect(output).not.toContain(value);
}

describe('bootstrap:seed as a process', () => {
  // Break caught: the mapping of a mistake in the arguments to a usage message (and not a stack trace), or a command that opens a
  // database or a folder before it has judged what it was given.
  it.each([
    ['no custodian', []],
    ['one custodian', ['--custodian', FIRST]],
    ['three custodians', ['--custodian', FIRST, '--custodian', SECOND, '--custodian', FIRST]],
  ])('refuses %s with the usage, before it opens anything', async (_name, args) => {
    const result = await run(BOOTSTRAP_SEED, LOCAL, args);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('exactly two custodians');
    expect(result.stderr).toContain('usage: bootstrap:seed');
    expect(result.stderr).not.toMatch(/not reachable|at .*\.js:/);
    nothingSensitive(`${result.stdout}${result.stderr}`);
  });

  it('refuses an argument it does not take', async () => {
    const result = await run(BOOTSTRAP_SEED, LOCAL, ['--custodian', FIRST, '--other', SECOND]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('the arguments of the command are not the ones it takes');
    expect(result.stderr).toContain('usage: bootstrap:seed');
  });

  // Break caught: a custody folder that is not named (a default would put secrets wherever the command was started), is relative,
  // or is inside the repository, which the source package is built from.
  it.each([
    [{}, 'BOOTSTRAP_CUSTODY_DIRECTORY is not set'],
    [{ BOOTSTRAP_CUSTODY_DIRECTORY: 'relative/custody' }, 'is an absolute path'],
    [
      { BOOTSTRAP_CUSTODY_DIRECTORY: join(process.cwd(), 'custody-never-made') },
      'is inside a checkout',
    ],
  ])(
    'refuses a custody folder that is %j, before it opens a database or makes a folder',
    async (env, said) => {
      const result = await run(BOOTSTRAP_SEED, { ...LOCAL, ...env }, [
        '--custodian',
        FIRST,
        '--custodian',
        SECOND,
      ]);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(said);
      expect(result.stderr).not.toMatch(/not reachable/);
      expect(existsSync(join(process.cwd(), 'custody-never-made'))).toBe(false);
      nothingSensitive(`${result.stdout}${result.stderr}`);
    },
  );

  // The whole of it as an operator runs it, as far as it can go with no database: the leading `--` that `pnpm run` passes is
  // accepted, the folder is made and judged private by the real adapters of this platform, the database is asked and cannot be
  // reached, and the command says so: and nothing was written, because the pair is made before any bundle is.
  it('runs as pnpm starts it, judges a real folder, fails on a database it cannot reach, and writes no bundle', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'melarc-bootstrap-process-'));
    disposable.push(folder);
    const custody = join(folder, 'custody');

    const result = await run(
      BOOTSTRAP_SEED,
      { ...LOCAL, BOOTSTRAP_CUSTODY_DIRECTORY: custody },
      ['--', '--custodian', FIRST, '--custodian', SECOND],
      20_000,
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/PostgreSQL is not reachable/);
    expect(result.stderr).not.toMatch(/exactly two custodians|usage:/);
    expect(readdirSync(custody)).toEqual([]);
    expect(result.stdout).toBe('');
    nothingSensitive(`${result.stdout}${result.stderr}`);
    expect(result.stderr).not.toContain(custody);
  }, 30_000);
});

describe('bootstrap:resume as a process', () => {
  it.each([
    ['no custodian', []],
    ['two', ['--custodian', 'a@melarc.example', '--custodian', 'b@melarc.example']],
    ['a custodian that is not an address', ['--custodian', 'not an address']],
  ])('refuses %s with the usage, before it opens anything', async (_name, args) => {
    const result = await run(BOOTSTRAP_RESUME, LOCAL, args);

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/usage: bootstrap:resume|work email in the form of an address/);
    expect(result.stderr).not.toMatch(/not reachable/);
    nothingSensitive(`${result.stdout}${result.stderr}`);
  });

  it('refuses a custody folder that is not named', async () => {
    const result = await run(BOOTSTRAP_RESUME, LOCAL, [
      '--custodian',
      'kofi.boateng@melarc.example',
    ]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('BOOTSTRAP_CUSTODY_DIRECTORY is not set');
    nothingSensitive(`${result.stdout}${result.stderr}`);
  });
});
