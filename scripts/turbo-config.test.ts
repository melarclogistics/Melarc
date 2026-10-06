import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '..');

/** The contract is read by tests in several packages and is the input of the generated API client. */
const CONTRACT = 'contracts/openapi.yaml';

describe('turbo.json', () => {
  const turbo = JSON.parse(readFileSync(resolve(repositoryRoot, 'turbo.json'), 'utf8')) as {
    globalDependencies?: unknown;
  };

  // Break caught: a cached test or typecheck result surviving a contract change. The contract sits outside
  // every package, so Turborepo hashes it only when it is named here; without that, a green cached result
  // for the API, Ops or the generated client can describe a contract that no longer exists.
  it('hashes the canonical contract into every task', () => {
    assert.ok(Array.isArray(turbo.globalDependencies), 'turbo.json needs globalDependencies');
    assert.ok(turbo.globalDependencies.includes(CONTRACT));
  });

  // Break caught: a path that does not exist, which Turborepo hashes as nothing and so never invalidates.
  it('names a file that exists', () => {
    assert.ok(existsSync(resolve(repositoryRoot, CONTRACT)));
  });
});
