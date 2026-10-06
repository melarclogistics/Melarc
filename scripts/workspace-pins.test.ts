import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';

import { stringify } from 'yaml';

import { findPinProblems, readPinInputs, type PinInputs } from './workspace-pins.ts';

type Step = Record<string, unknown>;

const SHA = '0123456789abcdef0123456789abcdef01234567';
const CHECKOUT: Step = { uses: `actions/checkout@${SHA}` };
const PNPM_SETUP: Step = { uses: `pnpm/action-setup@${SHA}` };
const NODE_SETUP: Step = {
  uses: `actions/setup-node@${SHA}`,
  with: { 'node-version-file': '.node-version', cache: 'pnpm' },
};
const FROZEN_INSTALL: Step = { run: 'pnpm install --frozen-lockfile' };

function workflowOf(...steps: Step[]): string {
  return stringify({ name: 'CI', jobs: { checks: { 'runs-on': 'ubuntu-24.04', steps } } });
}

const GOOD_PACKAGE_JSON = { packageManager: 'pnpm@11.1.3', engines: { node: '^24.15.0' } };

const GOOD: PinInputs = {
  nodeVersionFile: '24.15.0\n',
  packageJson: GOOD_PACKAGE_JSON,
  ciWorkflow: workflowOf(CHECKOUT, PNPM_SETUP, NODE_SETUP, FROZEN_INSTALL),
};

/** Problem codes reported for the consistent fixture with some inputs replaced. */
function codesFor(overrides: Partial<PinInputs>): string[] {
  return findPinProblems({ ...GOOD, ...overrides }).map((problem) => problem.code);
}

describe('Node.js pin', () => {
  it('accepts a consistent set of pins', () => {
    assert.deepEqual(findPinProblems(GOOD), []);
  });

  // Break caught: .node-version loosened to a floating spec, so local and CI Node drift apart.
  for (const floating of ['24', '24.15', 'lts/*', 'v24.15.0', '']) {
    it(`rejects non-exact .node-version ${JSON.stringify(floating)}`, () => {
      assert.deepEqual(codesFor({ nodeVersionFile: `${floating}\n` }), ['NODE_VERSION_FORMAT']);
    });
  }

  // Break caught: .node-version moved outside the range package.json declares (and pnpm enforces).
  const rangeCases: [version: string, accepted: boolean][] = [
    ['24.15.0', true], // exactly the floor
    ['24.15.1', true],
    ['24.21.0', true], // later minor of the same major
    ['24.14.9', false], // just below the floor
    ['23.99.0', false], // previous major
    ['25.0.0', false], // next major is excluded by ^24
  ];
  for (const [version, accepted] of rangeCases) {
    it(`${accepted ? 'accepts' : 'rejects'} .node-version ${version} against engines.node ^24.15.0`, () => {
      assert.deepEqual(
        codesFor({ nodeVersionFile: version }),
        accepted ? [] : ['NODE_OUTSIDE_ENGINES'],
      );
    });
  }

  // Break caught: an engines.node loose enough to accept anything, silently skipping the comparison.
  const unevaluable: [label: string, engines: unknown][] = [
    ['missing engines', undefined],
    ['engines without node', {}],
    ['a lower bound only', { node: '>=24.15.0' }],
    ['a wildcard', { node: '*' }],
    ['a bare major', { node: '24' }],
    ['a non-string value', { node: 24 }],
  ];
  for (const [label, engines] of unevaluable) {
    it(`fails closed on ${label}`, () => {
      assert.deepEqual(codesFor({ packageJson: { ...GOOD_PACKAGE_JSON, engines } }), [
        'ENGINES_NODE_FORMAT',
      ]);
    });
  }
});

describe('package manager pin', () => {
  // Break caught: packageManager loosened to a range or tag, so local pnpm and CI pnpm diverge,
  // or switched to a manager the lockfile and scripts do not support.
  for (const accepted of ['pnpm@11.1.3', 'pnpm@11.1.3+sha512.0a1b2c3d']) {
    it(`accepts packageManager ${accepted}`, () => {
      const packageJson = { ...GOOD_PACKAGE_JSON, packageManager: accepted };
      assert.deepEqual(codesFor({ packageJson }), []);
    });
  }

  for (const rejected of ['pnpm@11', 'pnpm@^11.1.3', 'pnpm@latest', 'npm@10.9.2', 'pnpm', '']) {
    it(`rejects packageManager ${JSON.stringify(rejected)}`, () => {
      const packageJson = { ...GOOD_PACKAGE_JSON, packageManager: rejected };
      assert.deepEqual(codesFor({ packageJson }), ['PACKAGE_MANAGER_FORMAT']);
    });
  }

  it('rejects a missing packageManager', () => {
    const packageJson = { engines: GOOD_PACKAGE_JSON.engines };
    assert.deepEqual(codesFor({ packageJson }), ['PACKAGE_MANAGER_FORMAT']);
  });

  it('rejects a non-string packageManager', () => {
    const packageJson = { ...GOOD_PACKAGE_JSON, packageManager: 11 };
    assert.deepEqual(codesFor({ packageJson }), ['PACKAGE_MANAGER_FORMAT']);
  });
});

describe('CI workflow pins', () => {
  /** Codes reported when CI consists of exactly these steps. */
  function codesForSteps(...steps: Step[]): string[] {
    return codesFor({ ciWorkflow: workflowOf(...steps) });
  }

  // Break caught: CI hard-codes or ignores the Node version instead of reading .node-version.
  const driftedNodeSetups: [label: string, inputs: Record<string, unknown>][] = [
    ['a hard-coded node-version', { 'node-version': '22', cache: 'pnpm' }],
    ['a different version file', { 'node-version-file': '.nvmrc', cache: 'pnpm' }],
    [
      'node-version beside the version file',
      { 'node-version-file': '.node-version', 'node-version': '22' },
    ],
    ['no version input at all', { cache: 'pnpm' }],
  ];
  for (const [label, inputs] of driftedNodeSetups) {
    it(`rejects setup-node with ${label}`, () => {
      const drifted = { ...NODE_SETUP, with: inputs };
      assert.deepEqual(codesForSteps(CHECKOUT, PNPM_SETUP, drifted, FROZEN_INSTALL), [
        'CI_NODE_PIN',
      ]);
    });
  }

  it('rejects a workflow without a setup-node step', () => {
    assert.deepEqual(codesForSteps(CHECKOUT, PNPM_SETUP, FROZEN_INSTALL), ['CI_NODE_PIN']);
  });

  // Break caught: a second job added later with its own hard-coded Node version.
  it('rejects when only one of several setup-node steps drifts', () => {
    const drifted = { ...NODE_SETUP, with: { 'node-version': '22' } };
    assert.deepEqual(codesForSteps(CHECKOUT, PNPM_SETUP, NODE_SETUP, drifted, FROZEN_INSTALL), [
      'CI_NODE_PIN',
    ]);
  });

  // Break caught: CI pins its own pnpm instead of using package.json packageManager.
  it('rejects a hard-coded pnpm version', () => {
    const hardCoded = { ...PNPM_SETUP, with: { version: 10 } };
    assert.deepEqual(codesForSteps(CHECKOUT, hardCoded, NODE_SETUP, FROZEN_INSTALL), [
      'CI_PNPM_PIN',
    ]);
  });

  it('rejects a workflow without a pnpm setup step', () => {
    assert.deepEqual(codesForSteps(CHECKOUT, NODE_SETUP, FROZEN_INSTALL), ['CI_PNPM_PIN']);
  });

  // Break caught: CI installs without the frozen lockfile, so it can resolve different versions.
  for (const run of ['pnpm install', 'pnpm install --no-frozen-lockfile', 'pnpm run build']) {
    it(`rejects ${JSON.stringify(run)} as the only install`, () => {
      assert.deepEqual(codesForSteps(CHECKOUT, PNPM_SETUP, NODE_SETUP, { run }), [
        'CI_FROZEN_INSTALL',
      ]);
    });
  }

  for (const run of ['pnpm install --frozen-lockfile', 'pnpm ci']) {
    it(`accepts ${JSON.stringify(run)} as the install`, () => {
      assert.deepEqual(codesForSteps(CHECKOUT, PNPM_SETUP, NODE_SETUP, { run }), []);
    });
  }

  // Break caught: a mutable tag or branch lets an action's code change without a reviewed commit.
  const mutableRefs = ['v7', 'v7.0.1', 'main', SHA.slice(0, 39), SHA.toUpperCase()];
  for (const ref of mutableRefs) {
    it(`rejects action reference @${ref}`, () => {
      const unpinned = { uses: `actions/checkout@${ref}` };
      assert.deepEqual(codesForSteps(unpinned, PNPM_SETUP, NODE_SETUP, FROZEN_INSTALL), [
        'CI_ACTION_UNPINNED',
      ]);
    });
  }

  it('does not require a commit SHA for a repository-local action', () => {
    const local = { uses: './.github/actions/setup' };
    const localActions = {
      './.github/actions/setup': stringify({ runs: { using: 'composite', steps: [] } }),
    };
    const codes = findPinProblems({
      ...GOOD,
      ciWorkflow: workflowOf(local, CHECKOUT, PNPM_SETUP, NODE_SETUP, FROZEN_INSTALL),
      localActions,
    }).map((problem) => problem.code);
    assert.deepEqual(codes, []);
  });

  // Break caught: an implementation that stops at the first problem hides the rest.
  it('reports every independent problem', () => {
    const codes = codesForSteps(
      { uses: 'actions/checkout@v7' },
      { ...PNPM_SETUP, with: { version: 10 } },
      { ...NODE_SETUP, with: { 'node-version': '22' } },
      { run: 'pnpm install' },
    );
    assert.deepEqual(codes.toSorted(), [
      'CI_ACTION_UNPINNED',
      'CI_FROZEN_INSTALL',
      'CI_NODE_PIN',
      'CI_PNPM_PIN',
    ]);
  });

  // Break caught: an emptied workflow file crashing the check instead of being reported.
  it('reports an empty workflow file', () => {
    assert.deepEqual(codesFor({ ciWorkflow: '' }).toSorted(), [
      'CI_FROZEN_INSTALL',
      'CI_NODE_PIN',
      'CI_PNPM_PIN',
    ]);
  });
});

// The toolchain and install steps live once, in a composite action the jobs share. The pins must hold for the
// steps it contains exactly as if they were written in the workflow.
describe('CI composite actions', () => {
  const SETUP = './.github/actions/setup';
  const LOCAL: Step = { uses: SETUP };

  function compositeOf(...steps: Step[]): string {
    return stringify({ name: 'Set up', runs: { using: 'composite', steps } });
  }

  const GOOD_COMPOSITE = compositeOf(PNPM_SETUP, NODE_SETUP, { ...FROZEN_INSTALL, shell: 'bash' });

  /** Problem codes when the workflow is `steps` and the setup action is `composite` (absent when undefined). */
  function codesWith(composite: string | undefined, ...steps: Step[]): string[] {
    const localActions: Record<string, string> =
      composite === undefined ? {} : { [SETUP]: composite };
    return findPinProblems({ ...GOOD, ciWorkflow: workflowOf(...steps), localActions }).map(
      (problem) => problem.code,
    );
  }

  it('accepts pins that are all inside the composite action', () => {
    assert.deepEqual(codesWith(GOOD_COMPOSITE, CHECKOUT, LOCAL), []);
  });

  // Break caught: moving the setup into a shared action and so putting it out of the check's sight.
  it('finds a hard-coded Node version inside the composite action', () => {
    const drifted = compositeOf(
      PNPM_SETUP,
      { ...NODE_SETUP, with: { 'node-version': '22' } },
      FROZEN_INSTALL,
    );
    assert.deepEqual(codesWith(drifted, CHECKOUT, LOCAL), ['CI_NODE_PIN']);
  });

  it('finds a hard-coded pnpm version inside the composite action', () => {
    const drifted = compositeOf(
      { ...PNPM_SETUP, with: { version: 10 } },
      NODE_SETUP,
      FROZEN_INSTALL,
    );
    assert.deepEqual(codesWith(drifted, CHECKOUT, LOCAL), ['CI_PNPM_PIN']);
  });

  it('finds a mutable action reference inside the composite action', () => {
    const drifted = compositeOf(PNPM_SETUP, {
      uses: 'actions/setup-node@v7',
      with: NODE_SETUP.with,
    });
    assert.deepEqual(codesWith(drifted, CHECKOUT, LOCAL, FROZEN_INSTALL), ['CI_ACTION_UNPINNED']);
  });

  it('finds an install that is not frozen inside the composite action', () => {
    const drifted = compositeOf(PNPM_SETUP, NODE_SETUP, { run: 'pnpm install', shell: 'bash' });
    assert.deepEqual(codesWith(drifted, CHECKOUT, LOCAL), ['CI_FROZEN_INSTALL']);
  });

  // Break caught: a workflow that names a local action nobody can read passing as though it were set up.
  it('reports a local action whose file is missing', () => {
    assert.deepEqual(
      codesWith(undefined, CHECKOUT, PNPM_SETUP, NODE_SETUP, FROZEN_INSTALL, LOCAL),
      ['CI_LOCAL_ACTION_MISSING'],
    );
  });

  it('follows a composite action that uses another', () => {
    const inner = compositeOf(PNPM_SETUP, NODE_SETUP, FROZEN_INSTALL);
    const outer = compositeOf({ uses: './.github/actions/inner' });
    const codes = findPinProblems({
      ...GOOD,
      ciWorkflow: workflowOf(CHECKOUT, LOCAL),
      localActions: { [SETUP]: outer, './.github/actions/inner': inner },
    }).map((problem) => problem.code);
    assert.deepEqual(codes, []);
  });

  it('stops at an action that uses itself', () => {
    const loop = compositeOf(PNPM_SETUP, NODE_SETUP, FROZEN_INSTALL, LOCAL);
    assert.deepEqual(codesWith(loop, CHECKOUT, LOCAL), []);
  });
});

// Reading the pin sources from a directory finds the local actions the workflow uses, and the ones those use.
describe('reading the pin sources from a repository', () => {
  const directories: string[] = [];
  after(() => {
    for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  });

  function repositoryWith(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'melarc-pins-'));
    directories.push(root);
    const everything = {
      '.node-version': '24.15.0\n',
      'package.json': JSON.stringify(GOOD_PACKAGE_JSON),
      ...files,
    };
    for (const [path, content] of Object.entries(everything)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return root;
  }

  const action = (...steps: Step[]): string => stringify({ runs: { using: 'composite', steps } });
  const OUTER = './.github/actions/outer';
  const INNER = './.github/actions/inner';
  const workflow = workflowOf(CHECKOUT, { uses: OUTER }, FROZEN_INSTALL);

  it('finds a local action and the action it uses in turn', () => {
    const inner = action(PNPM_SETUP, NODE_SETUP);
    const root = repositoryWith({
      '.github/workflows/ci.yml': workflow,
      '.github/actions/outer/action.yml': action({ uses: INNER }),
      '.github/actions/inner/action.yml': inner,
    });
    const inputs = readPinInputs(root);
    assert.deepEqual(Object.keys(inputs.localActions ?? {}).toSorted(), [INNER, OUTER]);
    assert.deepEqual(findPinProblems(inputs), []);
  });

  // Break caught: a pin put wrong in an action that another action pulls in, out of the check's sight.
  it('checks the steps of the nested action', () => {
    const drifted = action(PNPM_SETUP, { ...NODE_SETUP, with: { 'node-version': '22' } });
    const root = repositoryWith({
      '.github/workflows/ci.yml': workflow,
      '.github/actions/outer/action.yml': action({ uses: INNER }),
      '.github/actions/inner/action.yml': drifted,
    });
    const codes = findPinProblems(readPinInputs(root)).map((problem) => problem.code);
    assert.deepEqual(codes, ['CI_NODE_PIN']);
  });

  it('reads an action file spelled action.yaml', () => {
    const root = repositoryWith({
      '.github/workflows/ci.yml': workflowOf(CHECKOUT, { uses: OUTER }, FROZEN_INSTALL),
      '.github/actions/outer/action.yaml': action(PNPM_SETUP, NODE_SETUP),
    });
    assert.deepEqual(findPinProblems(readPinInputs(root)), []);
  });

  it('reports a local action whose folder holds no action file', () => {
    const root = repositoryWith({ '.github/workflows/ci.yml': workflow });
    const codes = findPinProblems(readPinInputs(root)).map((problem) => problem.code);
    assert.ok(codes.includes('CI_LOCAL_ACTION_MISSING'));
  });
});

describe('this repository', () => {
  // Break caught: .node-version, package.json and the CI workflow drifting apart in a real commit.
  it('keeps its Node.js, pnpm and CI pins consistent', () => {
    const repositoryRoot = resolve(import.meta.dirname, '..');
    assert.deepEqual(findPinProblems(readPinInputs(repositoryRoot)), []);
  });
});
