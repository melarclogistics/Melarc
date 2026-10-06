import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

/**
 * `.gitignore` is the first line of defence for what must never be committed. It is held to what Git itself says
 * about names, with no file created: `git check-ignore --no-index` applies the patterns to a name whether or not
 * the file exists or is tracked.
 */
const root = resolve(import.meta.dirname, '..');

interface Verdict {
  path: string;
  /** The last pattern that matches the path (a `!` pattern re-includes it), or undefined when none does. */
  pattern: string | undefined;
  /** Whether Git ignores the path: a pattern matched it and it was not a `!` one. */
  ignored: boolean;
}

/** What `.gitignore` says about each name (one process for all of them). Git prints every name, matched or not. */
function verdicts(paths: readonly string[]): Verdict[] {
  const run = spawnSync(
    'git',
    ['check-ignore', '--no-index', '--verbose', '--non-matching', '--stdin', '-z'],
    { cwd: root, input: `${paths.join('\0')}\0`, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  // Exit status 0 says some name is ignored and 1 that none is; anything else is Git failing.
  assert.ok(run.status === 0 || run.status === 1, `git check-ignore failed: ${run.stderr}`);
  const output = run.stdout;
  // Each record is four fields: the file the pattern is in, its line, the pattern, the path.
  const fields = output.split('\0');
  const found: Verdict[] = [];
  for (let index = 0; index + 3 < fields.length; index += 4) {
    const pattern = fields[index + 2] ?? '';
    found.push({
      path: fields[index + 3] ?? '',
      pattern: pattern === '' ? undefined : pattern,
      ignored: pattern !== '' && !pattern.startsWith('!'),
    });
  }
  return found;
}

const ignored = (paths: readonly string[]): string[] =>
  verdicts(paths)
    .filter((verdict) => verdict.ignored)
    .map((verdict) => verdict.path);

describe('.gitignore', () => {
  // Break caught: a key, credential or dump that a mobile or database workflow produces being committed because
  // no pattern names it. The first block is what the repository ignored before; the second is the keystores
  // and credentials of the Android, Apple and PostgreSQL tools.
  const secrets = [
    '.env',
    'apps/api/.env',
    'apps/api/.env.local',
    'infrastructure/postgres/.env',
    // What a killed `setup:env` can leave beside a settings file (createPrivateFile in setup-env.ts).
    'infrastructure/postgres/.env.tmp-0a1b2c3d4e5f',
    'apps/api/.env.tmp-0a1b2c3d4e5f',
    'certs/server.pem',
    'keys/signing.key',
    'certs/bundle.p12',
    'certs/bundle.pfx',
    'release.jks',
    'android/app/release.jks',
    'android/upload.keystore',
    'debug.keystore',
    'AuthKey_ABC123XYZ.p8',
    'ios/keys/AuthKey_ABC123XYZ.p8',
    '.pgpass',
    'home/user/.pgpass',
    'pgpass.conf',
    'AppData/postgresql/pgpass.conf',
    'google-services.json',
    'apps/android/app/google-services.json',
    'GoogleService-Info.plist',
    'apps/ios/App/GoogleService-Info.plist',
    'backup.dump',
    'db/prod.dump',
    'nightly/2026-10-06.dump',
  ];

  it('ignores the keys, credentials, dumps and local settings it must keep out', () => {
    assert.deepEqual(
      secrets.filter((path) => !ignored([path]).includes(path)),
      [],
      'not ignored',
    );
  });

  for (const [path, pattern] of [
    ['release.jks', '*.jks'],
    ['upload.keystore', '*.keystore'],
    ['AuthKey_ABC123XYZ.p8', '*.p8'],
    ['.pgpass', '.pgpass'],
    ['pgpass.conf', 'pgpass.conf'],
    ['google-services.json', 'google-services.json'],
    ['GoogleService-Info.plist', 'GoogleService-Info.plist'],
    ['db/prod.dump', '*.dump'],
  ] as const) {
    it(`ignores ${path} by the pattern ${pattern}`, () => {
      assert.equal(verdicts([path])[0]?.pattern, pattern);
    });
  }

  // Break caught: a pattern so broad that it hides source, a migration or a committed example.
  it('does not ignore source, migrations, examples or names that only resemble the ignored ones', () => {
    const source = [
      'apps/api/migrations/0000_database_foundation.sql',
      'apps/api/migrations/0000_init.sql',
      'apps/api/migrations/meta/_journal.json',
      'apps/api/.env.example',
      'apps/ops-web/.env.example',
      'infrastructure/postgres/.env.example',
      '.github/workflows/ci.yml',
      'pnpm-lock.yaml',
      'docs/dump.md',
      'src/dump.ts',
      'src/dumpster.dump.ts',
      'db/dump.sql',
      'src/jks-reader.ts',
      'src/keystore.ts',
      'docs/keystore.md',
      'src/p8.ts',
      'docs/pgpass.md',
      'docs/google-services.md',
      'google-services.json.example',
      'GoogleService-Info.plist.example',
      'design/assets/brand/logo.svg',
    ];
    assert.deepEqual(ignored(source), []);
  });

  // Break caught: a tracked file that a new pattern would now hide from `git add` (it stays tracked, but a
  // change to it, or a sibling of the same name, would no longer show up).
  it('ignores none of the files Git already tracks', () => {
    const tracked = execFileSync(
      'git',
      ['ls-files', '-z', '--cached', '--ignored', '--exclude-standard'],
      {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      },
    )
      .split('\0')
      .filter((path) => path !== '');
    assert.deepEqual(tracked, []);
  });

  it('asks Git about every name it was given, so a silent result cannot pass', () => {
    const names = ['a.txt', '.env', 'release.jks'];
    assert.deepEqual(
      verdicts(names).map((verdict) => verdict.path),
      names,
    );
    assert.equal(verdicts(['a.txt'])[0]?.pattern, undefined);
    assert.equal(verdicts(['.env'])[0]?.pattern, '.env');
  });
});
