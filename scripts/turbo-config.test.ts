import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { describe, it } from 'node:test';

import { workspaceDirectories } from './test-inventory.ts';

const repositoryRoot = resolve(import.meta.dirname, '..');

/** The contract is read by tests in several packages and is the input of the generated API client. */
const CONTRACT = 'contracts/openapi.yaml';

/**
 * What tasks read that sits outside every package, so that Turborepo's per-package hash does not see it:
 *
 *   the contract            read by tests in several packages, and the input of the generated API client
 *   tsconfig.base.json      extended by every package's tsconfig.json: its strictness decides what typechecks
 *   pnpm-workspace.yaml     the install's rules (build scripts, peer rules, engine strictness) and the package list
 *   .node-version           the Node.js every task ran on: a green cached result is about that version
 */
const GLOBAL_INPUTS = [CONTRACT, 'tsconfig.base.json', 'pnpm-workspace.yaml', '.node-version'];

interface Turbo {
  globalDependencies?: unknown;
  tasks?: Record<string, { cache?: boolean; passThroughEnv?: string[] } | undefined>;
}

const turbo = JSON.parse(readFileSync(resolve(repositoryRoot, 'turbo.json'), 'utf8')) as Turbo;

describe('turbo.json', () => {
  const globals = (): string[] => {
    assert.ok(Array.isArray(turbo.globalDependencies), 'turbo.json needs globalDependencies');
    return turbo.globalDependencies as string[];
  };

  // Break caught: a cached test or typecheck result surviving a contract change. The contract sits outside
  // every package, so Turborepo hashes it only when it is named here; without that, a green cached result
  // for the API, Ops or the generated client can describe a contract that no longer exists.
  it('hashes the canonical contract into every task', () => {
    assert.ok(globals().includes(CONTRACT));
  });

  // Break caught: a change to the shared TypeScript settings, the install's rules or the Node.js version that
  // leaves every cached build, typecheck and test result in place, because no package's own files changed.
  for (const input of GLOBAL_INPUTS) {
    it(`hashes ${input} into every task`, () => {
      assert.ok(globals().includes(input), `${input} is not in globalDependencies`);
    });
  }

  // Break caught: a path that does not exist, which Turborepo hashes as nothing and so never invalidates.
  it('names files that exist', () => {
    for (const input of globals()) {
      assert.ok(existsSync(resolve(repositoryRoot, input)), `${input} does not exist`);
    }
    assert.ok(existsSync(resolve(repositoryRoot, CONTRACT)));
  });

  it('names no file twice', () => {
    assert.equal(new Set(globals()).size, globals().length);
  });

  // Break caught: a package that starts to extend a configuration file outside its folder, which no task hash
  // sees. Whatever a package's tsconfig files extend from outside the package must be a global input.
  it('hashes every configuration file that a package extends from outside its folder', () => {
    const outside: string[] = [];
    for (const directory of workspaceDirectories(repositoryRoot)) {
      const files = readdirSync(resolve(repositoryRoot, directory)).filter((name) =>
        /^tsconfig(?:\..+)?\.json$/.test(name),
      );
      assert.ok(files.length > 0, `${directory} has no tsconfig file`);
      for (const file of files) {
        const parsed = JSON.parse(
          readFileSync(resolve(repositoryRoot, directory, file), 'utf8'),
        ) as { extends?: unknown };
        const extended = typeof parsed.extends === 'string' ? [parsed.extends] : [];
        for (const base of extended.filter((path) => path.startsWith('.'))) {
          const target = posix.normalize(posix.join(directory, base));
          if (!target.startsWith(`${directory}/`)) outside.push(target);
        }
      }
    }
    assert.ok(outside.length > 0, 'the packages are expected to extend the root configuration');
    for (const target of new Set(outside)) {
      assert.ok(globals().includes(target), `${target} is extended from outside a package`);
    }
  });

  // Break caught: the variables the browser tests need being dropped by Turborepo's strict environment, so CI
  // sets MELARC_BROWSERS and the tests still run Chromium alone.
  it('passes the browser selection and the browsers location through to the browser tests', () => {
    const task = turbo.tasks?.['test:browser'];
    assert.ok(task !== undefined, 'test:browser is a task');
    const passed = task.passThroughEnv ?? [];
    assert.ok(passed.includes('MELARC_BROWSERS'));
    assert.ok(passed.includes('PLAYWRIGHT_BROWSERS_PATH'));
    assert.equal(task.cache, false, 'a browser run is never replayed from the cache');
  });
});
