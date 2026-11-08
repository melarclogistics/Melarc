import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const root = resolve(import.meta.dirname, '..');

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

/** Names that belong to the retired Python governance tooling or to another language's package manager. */
const FOREIGN_TOOLING =
  /(?:^|\/)(?:requirements[^/]*\.txt|pyproject\.toml|Pipfile(?:\.lock)?|setup\.py|setup\.cfg|poetry\.lock|tox\.ini|package-lock\.json|yarn\.lock|bun\.lockb?)$|\.(?:py|pyc|ipynb)$/;

/**
 * A populated settings file, a key or a local database. A settings file is `.env` or `.env.<anything>`, except a template: a name that ends in
 * `.example` (`.env.example`, `.env.sms.example`, `.env.production.example`). The template is the committed record of which settings exist, and
 * `scripts/package-source.ts` already treats every `.env.*.example` as source.
 */
const SECRET_FILES =
  /(?:^|\/)\.env(?:\.(?!(?:[^/]*\.)?example$)[^/]+)?$|\.(?:pem|key|p12|pfx|jks|keystore|sqlite3?|db)$/i;

describe('the repository holds only what this stack uses', () => {
  // Break caught (runbook B0.1): the retired Python governance and audit tooling coming back, or a second package
  // manager's lockfile appearing beside pnpm's, which would give two answers to which versions are installed.
  it('has no Python tooling and no other package manager lockfile', () => {
    assert.ok(tracked.length > 300, 'expected the whole repository to be tracked');
    assert.deepEqual(
      tracked.filter((path) => FOREIGN_TOOLING.test(path)),
      [],
    );
  });

  it('is told apart from what it refuses: the matcher finds each of them', () => {
    for (const path of [
      'tools/check.py',
      'requirements.txt',
      'docs/requirements-dev.txt',
      'pyproject.toml',
      'Pipfile',
      'a/notebook.ipynb',
      'package-lock.json',
      'apps/api/yarn.lock',
      'bun.lockb',
    ]) {
      assert.ok(FOREIGN_TOOLING.test(path), `${path} should be refused`);
    }
    for (const path of [
      'pnpm-lock.yaml',
      'apps/api/package.json',
      'scripts/design-tokens.ts',
      'README.md',
    ]) {
      assert.ok(!FOREIGN_TOOLING.test(path), `${path} should be allowed`);
    }
  });

  // Break caught: a populated settings file, a key or a local database committed. Tracked files only: what is merely
  // ignored is the .gitignore tests' business.
  it('tracks no settings file, key, certificate store or local database', () => {
    assert.deepEqual(
      tracked.filter((path) => SECRET_FILES.test(path)),
      [],
    );
  });

  // Break caught: the matcher refusing a committed template (the check then fails on a file that belongs in the repository, and is
  // loosened until it catches nothing), or letting a populated settings file or a key through under a name that only looks like one.
  it('refuses a populated settings file, a key and a database, and allows a template', () => {
    for (const path of [
      '.env',
      'apps/api/.env',
      '.env.local',
      '.env.production',
      'apps/api/.env.sms',
      // A name that only ends like a template is not one: the last dot-separated word must be exactly `example`.
      'a/.env.counterexample',
      'a/.env.exampleX',
      'a/.env.example.bak',
      'a/.env.production.local',
      'certs/server.pem',
      'certs/server.key',
      'certs/store.p12',
      'certs/store.pfx',
      'certs/store.jks',
      'certs/store.keystore',
      'data/local.db',
      'data/local.sqlite',
      'data/local.sqlite3',
      'CERTS/SERVER.PEM',
    ]) {
      assert.ok(SECRET_FILES.test(path), `${path} should be refused`);
    }
    for (const path of [
      '.env.example',
      'apps/api/.env.example',
      'apps/ops-web/.env.example',
      'infrastructure/postgres/.env.example',
      'apps/api/.env.sms.example',
      'a/.env.production.example',
      'a/.env.local.example',
      'apps/api/src/environment.ts',
      'docs/environment.md',
    ]) {
      assert.ok(!SECRET_FILES.test(path), `${path} should be allowed`);
    }
  });
});
