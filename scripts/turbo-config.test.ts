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

  // Break caught (the first hosted run, 12 October 2026): the variables that say "this is a GitHub-hosted runner" dropped by Turborepo's
  // strict environment, so that the HTTPS run sees `CI` and not `GITHUB_ACTIONS` or `RUNNER_ENVIRONMENT`, refuses to put the CA in the
  // system store, and WebKit's proofs fail to trust for a reason that has nothing to do with WebKit. The run decides what it may do on
  // exactly these variables (`e2e/harness/https-run.ts`, `e2e/harness/system-trust.ts`).
  it('passes the variables the HTTPS run decides on through to it', () => {
    const task = turbo.tasks?.['test:e2e:https'];
    assert.ok(task !== undefined, 'test:e2e:https is a task');
    const passed = task.passThroughEnv ?? [];
    for (const name of [
      'CI',
      'GITHUB_ACTIONS',
      'RUNNER_ENVIRONMENT',
      'MELARC_E2E_KEYS_CLEARED',
      'OPENSSL',
      'CERTUTIL',
      'PLAYWRIGHT_BROWSERS_PATH',
    ]) {
      assert.ok(passed.includes(name), `${name} reaches the HTTPS run`);
    }
    assert.equal(task.cache, false, 'a run that makes a CA is never replayed from the cache');
  });
});

/**
 * The local test profile (decision D of the owner, 12 October 2026). `pnpm test` runs the four package suites at once, and on the
 * developer machine the Ops Portal suite has more than once failed to start its workers ("Timeout waiting for worker to respond");
 * the cause is not established. `pnpm run test:local` is **bounded local scheduling**, not an explanation: the same tests, the same
 * assertions and the same timeouts, with one package suite at a time. CI keeps the canonical command.
 */
describe('the local test profile', () => {
  const rootScripts = (): Record<string, string> => {
    const parsed = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    return parsed.scripts;
  };

  // Break caught: the profile drifting into a different test run: a filter that skips a package, a retry that hides a flaky test,
  // `--continue` that reports past the first failure, a raised timeout, or a missing root half.
  it('runs the root tests and then every package suite, one at a time, and nothing else', () => {
    assert.equal(
      rootScripts()['test:local'],
      'pnpm run test:root && turbo run test --concurrency=1',
    );
  });

  // Break caught: the canonical command changed to make the local one look like a copy of it. CI and `pnpm test` stay as they were.
  it('leaves the canonical test command as it was', () => {
    assert.equal(rootScripts().test, 'pnpm run test:root && turbo run test');
  });

  // Break caught: CI quietly adopting the local profile, so that the hosted run no longer tests what the canonical command tests.
  it('is never run by the CI workflow', () => {
    const workflow = readFileSync(resolve(repositoryRoot, '.github/workflows/ci.yml'), 'utf8');
    assert.ok(!workflow.includes('test:local'), 'ci.yml must run the canonical command');
  });

  // Break caught: a package-level retry, which is how a flaky test is made to look green.
  it('adds no retry, no continue-on-failure and no timeout', () => {
    const command = rootScripts()['test:local'] ?? '';
    assert.doesNotMatch(command, /--retry|--continue|--timeout|--bail=0|--no-bail/);
  });
});
