import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { parseEnv } from 'node:util';

import { runSetupEnv, setupLocalEnv, SetupEnvError } from './setup-env.ts';

const repositoryRoot = resolve(import.meta.dirname, '..');
const PG_ENV = 'infrastructure/postgres/.env';
const API_ENV = 'apps/api/.env';

const created: string[] = [];
after(() => {
  for (const directory of created) rmSync(directory, { recursive: true, force: true });
});

/** The real example files, which are what the script must keep working with: a renamed key shows up here. */
const examples = {
  [`${PG_ENV}.example`]: readFileSync(resolve(repositoryRoot, `${PG_ENV}.example`), 'utf8'),
  [`${API_ENV}.example`]: readFileSync(resolve(repositoryRoot, `${API_ENV}.example`), 'utf8'),
};

/** A bare checkout: the two example files and nothing else. `extra` adds or replaces files. */
function checkout(extra: Record<string, string> = {}, withExamples = true): string {
  const root = mkdtempSync(join(tmpdir(), 'melarc-setup-env-'));
  created.push(root);
  const files = { ...(withExamples ? examples : {}), ...extra };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const read = (root: string, path: string): string => readFileSync(join(root, path), 'utf8');

/** A source of passwords that are different every time and recognizable in a failure. */
function counter(): () => string {
  let next = 0;
  return () => `secret${String((next += 1)).padStart(2, '0')}x`;
}

const PG_VALUES = {
  MELARC_PG_HOST: '127.0.0.1',
  MELARC_PG_PORT: '5432',
  MELARC_PG_ADMIN_PASSWORD: 'adminpw',
  MELARC_PG_MIGRATION_PASSWORD: 'migrationpw',
  MELARC_PG_RUNTIME_PASSWORD: 'runtimepw',
};
const pgEnvText = (overrides: Record<string, string> = {}): string =>
  Object.entries({ ...PG_VALUES, ...overrides })
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

describe('on a checkout with neither file', () => {
  it('creates both, and says so', () => {
    const root = checkout();
    const result = setupLocalEnv(root, { random: counter() });
    assert.deepEqual(result.created, [PG_ENV, API_ENV]);
    assert.deepEqual(result.leftAlone, []);
    assert.deepEqual(result.notes, []);
  });

  // Break caught: a database password left as the placeholder, or the same one used for two identities.
  it('gives each of the three passwords its own random value and leaves no placeholder', () => {
    const root = checkout();
    setupLocalEnv(root, { random: counter() });
    const text = read(root, PG_ENV);
    assert.ok(
      !/^[A-Z][A-Z0-9_]*=CHANGE_ME\s*$/m.test(text),
      'a setting still holds the placeholder',
    );
    const values = parseEnv(text);
    const passwords = [
      values.MELARC_PG_ADMIN_PASSWORD,
      values.MELARC_PG_MIGRATION_PASSWORD,
      values.MELARC_PG_RUNTIME_PASSWORD,
    ];
    assert.equal(new Set(passwords).size, 3);
    // The first three draws, in the order the settings appear: none is spent anywhere else.
    assert.deepEqual(passwords, ['secret01x', 'secret02x', 'secret03x']);
    assert.equal(values.MELARC_PG_HOST, '127.0.0.1');
    assert.equal(values.MELARC_PG_PORT, '5432');
  });

  // Break caught: the placeholder in the example's own explanation being replaced like a setting, which writes a
  // random value into a comment of the developer's file and spends a draw on it.
  it('changes nothing in the database example except the three password lines', () => {
    const root = checkout();
    setupLocalEnv(root, { random: counter() });
    const example = examples[`${PG_ENV}.example`].split('\n');
    const generated = read(root, PG_ENV).split('\n');
    assert.equal(generated.length, example.length);
    const changed = generated.flatMap((line, index) =>
      line === example[index] ? [] : [example[index]?.split('=')[0] ?? ''],
    );
    assert.deepEqual(changed, [
      'MELARC_PG_ADMIN_PASSWORD',
      'MELARC_PG_MIGRATION_PASSWORD',
      'MELARC_PG_RUNTIME_PASSWORD',
    ]);
  });

  it('uses real randomness by default: long, hexadecimal and different on each call', () => {
    const first = checkout();
    const second = checkout();
    setupLocalEnv(first);
    setupLocalEnv(second);
    const a = parseEnv(read(first, PG_ENV)).MELARC_PG_ADMIN_PASSWORD ?? '';
    const b = parseEnv(read(second, PG_ENV)).MELARC_PG_ADMIN_PASSWORD ?? '';
    assert.match(a, /^[0-9a-f]{48}$/);
    assert.notEqual(a, b);
  });

  // Break caught: the API pointed at a password the database does not have, which is the manual step this replaces.
  it("points the API's DATABASE_URL at the runtime identity with the runtime password", () => {
    const root = checkout();
    setupLocalEnv(root, { random: counter() });
    const runtime = parseEnv(read(root, PG_ENV)).MELARC_PG_RUNTIME_PASSWORD;
    const api = parseEnv(read(root, API_ENV));
    assert.equal(
      api.DATABASE_URL,
      `postgres://melarc_api_runtime:${runtime ?? ''}@127.0.0.1:5432/melarc_dev`,
    );
  });

  it("changes nothing else in the API's example: only the DATABASE_URL line differs", () => {
    const root = checkout();
    setupLocalEnv(root, { random: counter() });
    const before = examples[`${API_ENV}.example`].split('\n');
    const after = read(root, API_ENV).split('\n');
    assert.equal(after.length, before.length);
    const differing = before.flatMap((line, index) => (line === after[index] ? [] : [index]));
    assert.equal(differing.length, 1);
    assert.match(before[differing[0] ?? 0] ?? '', /^DATABASE_URL=/);
    assert.match(after[differing[0] ?? 0] ?? '', /^DATABASE_URL=/);
  });

  // Break caught: a secrets file readable by other users of a shared machine (POSIX; Windows has no such bits).
  it('keeps the files private to the owner where the platform has permissions', () => {
    const root = checkout();
    setupLocalEnv(root, { random: counter() });
    if (process.platform !== 'win32') {
      for (const path of [PG_ENV, API_ENV]) {
        assert.equal(
          statSync(join(root, path)).mode & 0o077,
          0,
          `${path} must not be group or world accessible`,
        );
      }
    }
  });
});

describe('when the files already exist', () => {
  // Break caught: a second run replacing passwords the running database was started with.
  it('leaves both alone, byte for byte', () => {
    const root = checkout();
    setupLocalEnv(root, { random: counter() });
    const before = [read(root, PG_ENV), read(root, API_ENV)];
    const result = setupLocalEnv(root, { random: counter() });
    assert.deepEqual(result.created, []);
    assert.deepEqual(result.leftAlone, [PG_ENV, API_ENV]);
    assert.deepEqual([read(root, PG_ENV), read(root, API_ENV)], before);
  });

  it('does not touch a file somebody edited by hand', () => {
    const root = checkout({
      [PG_ENV]: pgEnvText(),
      [API_ENV]:
        'DATABASE_URL=postgres://melarc_api_runtime:runtimepw@127.0.0.1:5432/melarc_dev\nHTTP_PORT=3999\n',
    });
    setupLocalEnv(root, { random: counter() });
    assert.equal(read(root, PG_ENV), pgEnvText());
    assert.match(read(root, API_ENV), /HTTP_PORT=3999/);
  });

  // Break caught: the API file created with a new password when the database already has its own.
  it('builds a missing API file from the database file that is already there', () => {
    const root = checkout({ [PG_ENV]: pgEnvText({ MELARC_PG_RUNTIME_PASSWORD: 'kept-pw' }) });
    const result = setupLocalEnv(root, { random: counter() });
    assert.deepEqual(result.created, [API_ENV]);
    assert.deepEqual(result.leftAlone, [PG_ENV]);
    assert.match(read(root, API_ENV), /melarc_api_runtime:kept-pw@127\.0\.0\.1:5432\/melarc_dev/);
  });

  // Break caught: the API told to use 5432 while the database was moved because something else holds that port.
  it('follows the host and port chosen for the database', () => {
    const root = checkout({
      [PG_ENV]: pgEnvText({ MELARC_PG_HOST: 'localhost', MELARC_PG_PORT: '5433' }),
    });
    setupLocalEnv(root, { random: counter() });
    assert.match(read(root, API_ENV), /@localhost:5433\/melarc_dev$/m);
  });

  it('assumes the usual host and port when the database file names none', () => {
    const text = pgEnvText()
      .replace(/MELARC_PG_HOST=.*\n/, '')
      .replace(/MELARC_PG_PORT=.*\n/, '');
    assert.ok(!text.includes('MELARC_PG_HOST') && !text.includes('MELARC_PG_PORT'));
    const root = checkout({ [PG_ENV]: text });
    setupLocalEnv(root, { random: counter() });
    assert.match(read(root, API_ENV), /@127\.0\.0\.1:5432\/melarc_dev$/m);
  });

  // Break caught: a password with characters a URL treats specially breaking the connection string.
  it('escapes a password that has characters a URL reads specially', () => {
    const root = checkout({
      [PG_ENV]: pgEnvText({ MELARC_PG_RUNTIME_PASSWORD: 'p@ss/w:rd?x&y=%1' }),
    });
    setupLocalEnv(root, { random: counter() });
    const url = new URL(parseEnv(read(root, API_ENV)).DATABASE_URL ?? '');
    assert.equal(decodeURIComponent(url.password), 'p@ss/w:rd?x&y=%1');
    assert.equal(url.username, 'melarc_api_runtime');
    assert.equal(url.hostname, '127.0.0.1');
  });
});

describe('notes about an API file that does not match', () => {
  const apiWith = (password: string): string =>
    `DATABASE_URL=postgres://melarc_api_runtime:${password}@127.0.0.1:5432/melarc_dev\n`;

  it('says nothing when its password is the runtime password', () => {
    const root = checkout({ [PG_ENV]: pgEnvText(), [API_ENV]: apiWith('runtimepw') });
    assert.deepEqual(setupLocalEnv(root).notes, []);
  });

  // Break caught: a correct, percent-encoded password in the API file reported as a mismatch.
  it('compares the decoded password, so an escaped one that matches raises no note', () => {
    const root = checkout({
      [PG_ENV]: pgEnvText({ MELARC_PG_RUNTIME_PASSWORD: 'p@ss/w:rd' }),
      [API_ENV]: apiWith(encodeURIComponent('p@ss/w:rd')),
    });
    assert.deepEqual(setupLocalEnv(root).notes, []);
  });

  // Break caught: a database file regenerated while the API file still holds the old password, which fails only
  // at the API's start and is easy to misread as a database fault.
  it('names the file and the setting, never a password, when it differs', () => {
    const root = checkout({ [PG_ENV]: pgEnvText(), [API_ENV]: apiWith('stalepw') });
    const { notes } = setupLocalEnv(root);
    assert.equal(notes.length, 1);
    assert.match(notes[0] ?? '', /apps\/api\/\.env/);
    assert.match(notes[0] ?? '', /DATABASE_URL/);
    assert.match(notes[0] ?? '', /MELARC_PG_RUNTIME_PASSWORD/);
    for (const secret of ['stalepw', 'runtimepw', 'adminpw', 'migrationpw']) {
      assert.ok(!(notes[0] ?? '').includes(secret), 'a note must not carry a password');
    }
    assert.equal(read(root, API_ENV), apiWith('stalepw'));
  });

  it('says it cannot read a DATABASE_URL that is not a URL, or that is missing', () => {
    for (const text of ['DATABASE_URL=not a url\n', 'HTTP_PORT=3000\n', 'DATABASE_URL=\n']) {
      const root = checkout({ [PG_ENV]: pgEnvText(), [API_ENV]: text });
      const { notes } = setupLocalEnv(root);
      assert.equal(notes.length, 1, text);
      assert.match(notes[0] ?? '', /DATABASE_URL/);
    }
  });
});

describe('refusals', () => {
  // Break caught: an API file written with a placeholder or empty password because the database file was not finished.
  const unusable: [label: string, text: string][] = [
    ['the placeholder', pgEnvText({ MELARC_PG_RUNTIME_PASSWORD: 'CHANGE_ME' })],
    ['an empty value', pgEnvText({ MELARC_PG_RUNTIME_PASSWORD: '' })],
    ['no setting', pgEnvText().replace(/\nMELARC_PG_RUNTIME_PASSWORD=.*/, '')],
  ];
  for (const [label, text] of unusable) {
    it(`refuses to build the API file from a runtime password that is ${label}`, () => {
      const root = checkout({ [PG_ENV]: text });
      assert.throws(
        () => setupLocalEnv(root),
        (error: unknown) => {
          assert.ok(error instanceof SetupEnvError);
          assert.match(error.message, /MELARC_PG_RUNTIME_PASSWORD/);
          return true;
        },
      );
      assert.throws(() => read(root, API_ENV), { code: 'ENOENT' });
    });
  }

  it('names the example file it cannot find, and writes nothing', () => {
    const root = checkout({}, false);
    assert.throws(
      () => setupLocalEnv(root),
      (error: unknown) => {
        assert.ok(error instanceof SetupEnvError);
        assert.match(error.message, /infrastructure\/postgres\/\.env\.example/);
        return true;
      },
    );
    assert.throws(() => read(root, PG_ENV), { code: 'ENOENT' });
  });

  it('refuses an API example that no longer has a DATABASE_URL line to fill in', () => {
    const root = checkout({ [`${API_ENV}.example`]: 'HTTP_PORT=3000\n' });
    assert.throws(() => setupLocalEnv(root, { random: counter() }), /DATABASE_URL/);
    // Break caught: a refusal that leaves half of what was asked for on disk (here, a database file whose
    // passwords nothing was told about).
    assert.throws(() => read(root, PG_ENV), { code: 'ENOENT' });
    assert.throws(() => read(root, API_ENV), { code: 'ENOENT' });
  });
});

describe('the command', () => {
  function run(root: string): { status: number; lines: string[] } {
    const lines: string[] = [];
    const status = runSetupEnv(root, (line) => lines.push(line), counter());
    return { status, lines };
  }

  it('reports what it created, then what to do next, and exits 0', () => {
    const root = checkout();
    const { status, lines } = run(root);
    assert.equal(status, 0);
    const text = lines.join('\n');
    assert.match(text, /created\s+infrastructure\/postgres\/\.env/);
    assert.match(text, /created\s+apps\/api\/\.env/);
    assert.match(text, /pnpm run infra:up/);
  });

  // Break caught: a password in the console, a terminal log or a CI log.
  it('never prints a password', () => {
    const root = checkout();
    const { lines } = run(root);
    const secrets = Object.values(parseEnv(read(root, PG_ENV))).filter(
      (value): value is string => value?.startsWith('secret') === true,
    );
    assert.equal(secrets.length, 3);
    for (const secret of secrets) assert.ok(!lines.join('\n').includes(secret));
    const again = run(root).lines.join('\n');
    for (const secret of secrets) assert.ok(!again.includes(secret));
  });

  it('says a second run left both alone', () => {
    const root = checkout();
    run(root);
    const { status, lines } = run(root);
    assert.equal(status, 0);
    assert.match(lines.join('\n'), /left alone\s+infrastructure\/postgres\/\.env/);
    assert.match(lines.join('\n'), /left alone\s+apps\/api\/\.env/);
  });

  it('prints each note, and a refusal, and exits 1 on the refusal', () => {
    const noted = checkout({
      [PG_ENV]: pgEnvText(),
      [API_ENV]: 'DATABASE_URL=postgres://melarc_api_runtime:old@127.0.0.1:5432/melarc_dev\n',
    });
    assert.match(run(noted).lines.join('\n'), /note: .*DATABASE_URL/);

    const refused = checkout({ [PG_ENV]: pgEnvText({ MELARC_PG_RUNTIME_PASSWORD: 'CHANGE_ME' }) });
    const { status, lines } = run(refused);
    assert.equal(status, 1);
    assert.match(lines.join('\n'), /MELARC_PG_RUNTIME_PASSWORD/);
  });
});

// The command a developer types, started as a real process against a directory of its own.
describe('the command line', () => {
  const script = resolve(import.meta.dirname, 'setup-env.ts');

  it('prepares the directory it is given and exits 0', () => {
    const root = checkout();
    const result = spawnSync(process.execPath, [script, root], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(read(root, PG_ENV).includes('MELARC_PG_RUNTIME_PASSWORD='));
    assert.ok(
      !result.stdout.includes(parseEnv(read(root, PG_ENV)).MELARC_PG_ADMIN_PASSWORD ?? 'x'),
    );
  });

  it('exits 1 for a directory that is not a checkout', () => {
    const empty = mkdtempSync(join(tmpdir(), 'melarc-setup-env-empty-'));
    created.push(empty);
    const result = spawnSync(process.execPath, [script, empty], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr + result.stdout, /\.env\.example/);
  });
});
