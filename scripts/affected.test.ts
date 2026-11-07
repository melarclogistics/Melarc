import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  BASELINE_FILE,
  GATE_STAGE_TARGETS,
  TARGETS,
  baselineOf,
  digestOfHashes,
  forgetAll,
  markRunning,
  readStore,
  recordTargets,
  runningAffected,
  type TargetName,
} from './affected-baselines.ts';
import {
  API_BUILD_INPUTS,
  COMMAND_LINE_LIMIT,
  DEFINITIONS,
  EVERYTHING,
  OPS_ENTRY,
  PROCESS_START_UP,
  SPEC_AREAS,
  VERIFIER_RUNS,
  buildSourceModel,
  changesFor,
  childEnvironment,
  choose,
  closureOf,
  deferDevelopmentProjects,
  differences,
  exitCodeOf,
  importSpecifiers,
  isApiBuildInput,
  jdkBlock,
  matchesAny,
  needsOf,
  outcomeOf,
  parseOptions,
  readBrowserProjects,
  released,
  renderPlan,
  renderReport,
  resolveSpecifier,
  stepsFor,
  testsOf,
  unresolvedImports,
  startRefusal,
  untouchedTargets,
  type Choice,
  type ChooseInput,
  type SourceModel,
  type TargetChanges,
} from './affected.ts';
import { gateStages, treeFiles } from './gate.ts';

/**
 * The affected run (scripts/affected.ts) and its record (scripts/affected-baselines.ts). Choosing is checked on small trees made here,
 * where every import is known, and on the real tree for what must hold of the repository: every test file belongs to a target, every page
 * folder to a spec, every import of the code that runs resolves. Nothing here runs a test suite or writes outside its own folders.
 */

const root = resolve(import.meta.dirname, '..');
const made: string[] = [];
after(() => {
  for (const folder of made) rmSync(folder, { recursive: true, force: true });
});
function temp(): string {
  const folder = mkdtempSync(join(tmpdir(), 'melarc-affected-test-'));
  made.push(folder);
  return folder;
}
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

/** The one element of a list that must have exactly one. */
function only<T>(list: readonly T[]): T {
  assert.equal(list.length, 1);
  const [first] = list;
  assert.ok(first !== undefined);
  return first;
}

/** A model of a small tree: its files and their texts, read as the real run reads them. */
function modelOf(tree: Readonly<Record<string, string>>): SourceModel {
  return buildSourceModel(new Set(Object.keys(tree)), (path) => {
    const text = tree[path];
    if (text === undefined) throw new Error(`no ${path}`);
    return text;
  });
}

function chooseIn(
  tree: Readonly<Record<string, string>>,
  changed: readonly string[],
  targets: readonly TargetName[] = TARGETS,
  browserProjects: ReadonlyMap<string, readonly string[]> = new Map(),
): Map<TargetName, Choice> {
  const model = modelOf(tree);
  const files = new Set(Object.keys(tree));
  const tests = new Map(
    DEFINITIONS.map((definition) => [
      definition.name,
      testsOf(definition, files, tree['package.json'] ?? '{}'),
    ]),
  );
  const changes: TargetChanges[] = targets.map((target) => ({
    target,
    changed,
    since: 'a test',
    fromRecord: true,
  }));
  const input: ChooseInput = { model, changes, tests, browserProjects };
  return new Map(choose(input).map((choice) => [choice.target, choice]));
}

const choiceOf = (choices: Map<TargetName, Choice>, target: TargetName): Choice => {
  const choice = choices.get(target);
  assert.ok(choice !== undefined, `${target} was chosen for`);
  return choice;
};

// ------------------------------------------------------------------------------------------------ the record

describe('the record of green runs', () => {
  const files = new Map([
    ['a.ts', sha('a')],
    ['b.md', sha('b')],
  ]);

  // Break caught: a record that loses a target, keeps one for another tree, or keeps a snapshot nothing names.
  it('keeps, for each target, the tree it last passed on, and drops what no target names', () => {
    const where = temp();
    recordTargets(where, ['api-unit', 'root'], files, 'affected', new Date('2026-10-27T10:00:00Z'));
    const later = new Map([...files, ['c.ts', sha('c')]]);
    recordTargets(where, ['api-unit'], later, 'gate x');
    assert.deepEqual(baselineOf(where, 'root')?.files, files);
    assert.deepEqual(baselineOf(where, 'api-unit')?.files, later);
    assert.equal(baselineOf(where, 'api-unit')?.record.by, 'gate x');
    assert.equal(baselineOf(where, 'api-db'), undefined);
    recordTargets(where, ['root'], later, 'affected');
    assert.deepEqual(Object.keys(readStore(where).snapshots), [digestOfHashes(later)]);
  });

  // Break caught: a record changed by hand or cut short trusted, so that the run compares with a tree that never passed.
  it('trusts no snapshot whose content does not give its name, and no record of an unknown target', () => {
    const where = temp();
    recordTargets(where, ['root'], files, 'affected');
    const path = join(where, BASELINE_FILE);
    const read = (): {
      version: number;
      targets: Record<string, unknown>;
      snapshots: Record<string, Record<string, string>>;
    } =>
      JSON.parse(readFileSync(path, 'utf8')) as {
        version: number;
        targets: Record<string, unknown>;
        snapshots: Record<string, Record<string, string>>;
      };
    const valid = read();
    valid.targets['no-such-target'] = valid.targets.root;
    writeFileSync(path, JSON.stringify(valid));
    assert.deepEqual(Object.keys(readStore(where).targets), ['root']);
    writeFileSync(path, JSON.stringify({ ...valid, version: 2 }));
    assert.deepEqual(readStore(where).targets, {}, 'a record of another version is not read');
    const store = read();
    const digest = Object.keys(store.snapshots)[0] ?? '';
    const snapshot = store.snapshots[digest] ?? {};
    snapshot['a.ts'] = sha('changed by hand');
    writeFileSync(path, JSON.stringify({ ...store, version: 1 }));
    assert.equal(baselineOf(where, 'root'), undefined);
    assert.deepEqual(readStore(where).targets, {});
    writeFileSync(path, '{ not json');
    assert.deepEqual(readStore(where).targets, {});
    recordTargets(where, ['root'], files, 'affected');
    assert.deepEqual(Object.keys(readStore(where).targets), ['root']);
    forgetAll(where);
    assert.deepEqual(readStore(where).targets, {});
    assert.equal(existsSync(path), false);
  });

  // Break caught: a gate stage whose targets are not recorded (its proof wasted) or a target no stage of the gate ever proves.
  it('maps every test stage of the gate but the audit to targets, and every target to a stage', () => {
    const testStages = gateStages('local')
      .filter((stage) => stage.kind === 'test')
      .map((stage) => stage.name);
    assert.deepEqual(
      Object.keys(GATE_STAGE_TARGETS).toSorted(),
      testStages.filter((name) => name !== 'audit').toSorted(),
    );
    assert.deepEqual(Object.values(GATE_STAGE_TARGETS).flat().toSorted(), [...TARGETS].toSorted());
  });
});

// ------------------------------------------------------------------------------------------------ reading the source

describe('reading the source', () => {
  // Break caught: a form of import the code uses that the reader skips, so a test that depends on a module through it is never chosen.
  it('finds static, side-effect, dynamic, require and mock imports, and URLs against the module', () => {
    const text = [
      "import { a } from './a.js';",
      "import type { B } from '../b.js';",
      "import './c.css';",
      "export * from './d.js';",
      "const e = await import('./e.js');",
      "const f = require('./f.cjs');",
      "vi.mock('./g.js', () => ({}));",
      "const h = new URL('../../migrations', import.meta.url);",
      "import {\n  i,\n  j,\n} from './ij.js';",
    ].join('\n');
    assert.deepEqual(importSpecifiers(text).toSorted(), [
      '../../migrations',
      '../b.js',
      './a.js',
      './c.css',
      './d.js',
      './e.js',
      './f.cjs',
      './g.js',
      './ij.js',
    ]);
  });

  // Break caught: an import resolved to nothing (its importer's tests never chosen) or to the wrong file.
  it('resolves as Node, TypeScript and Vite do here: .js to .ts, no extension, index files, queries, folders and workspace exports', () => {
    const files = new Set([
      'apps/api/src/a.ts',
      'apps/api/src/b.tsx',
      'apps/api/src/c/index.ts',
      'apps/api/src/d.css',
      'apps/api/migrations/0001.sql',
      'packages/api-client/src/index.ts',
      'packages/api-client/src/browser/index.ts',
    ]);
    const folders = new Set([
      'apps',
      'apps/api',
      'apps/api/src',
      'apps/api/src/c',
      'apps/api/migrations',
      'packages/api-client/src',
    ]);
    const packages = new Map([
      [
        '@melarc/api-client',
        {
          dir: 'packages/api-client',
          exports: { '.': './src/index.ts', './browser': './src/browser/index.ts' },
        },
      ],
    ]);
    const from = 'apps/api/src/x.ts';
    const resolveIt = (specifier: string): string | null | undefined =>
      resolveSpecifier(from, specifier, files, packages, folders);
    assert.equal(resolveIt('./a.js'), 'apps/api/src/a.ts');
    assert.equal(resolveIt('./b.js'), 'apps/api/src/b.tsx');
    assert.equal(resolveIt('./b'), 'apps/api/src/b.tsx');
    assert.equal(resolveIt('./c'), 'apps/api/src/c/index.ts');
    assert.equal(resolveIt('./d.css?inline'), 'apps/api/src/d.css');
    assert.equal(resolveIt('../migrations'), 'apps/api/migrations/');
    assert.equal(resolveIt('@melarc/api-client'), 'packages/api-client/src/index.ts');
    assert.equal(
      resolveIt('@melarc/api-client/browser'),
      'packages/api-client/src/browser/index.ts',
    );
    assert.equal(resolveIt('@melarc/api-client/unknown'), 'packages/api-client/');
    assert.equal(resolveIt('@melarc/nothing'), undefined);
    assert.equal(resolveIt('./missing.js'), undefined);
    assert.equal(resolveIt('vitest'), null);
    assert.equal(resolveIt('node:fs'), null);
  });

  // Break caught: the resolver falling behind a convention of the repository, so that the imports of a real module name nothing.
  it('resolves every import of the code that runs in this repository', () => {
    const files = new Set(treeFiles(root));
    const model = buildSourceModel(files, (path) => readFileSync(join(root, path), 'utf8'));
    assert.ok(model.modules.size > 500, 'the model reads the code of the repository');
    assert.deepEqual(unresolvedImports(model), []);
  });

  // Break caught: a module that removed a file still pointing at it unseen, so a test that imports the removed file is never chosen.
  it('keeps an import that names nothing as a dependency on that path', () => {
    const model = modelOf({ 'apps/api/src/x.test.ts': "import { gone } from './gone.js';" });
    assert.ok(closureOf(model, 'apps/api/src/x.test.ts').files.has('apps/api/src/gone.js'));
  });
});

// ------------------------------------------------------------------------------------------------ choosing

const ROOT_MANIFEST = JSON.stringify({
  scripts: { 'test:root': 'node --test scripts/a.test.ts scripts/b.test.ts' },
});

describe('choosing the tests a change reaches', () => {
  const tree: Record<string, string> = {
    'package.json': ROOT_MANIFEST,
    'scripts/a.ts': 'export const a = 1;',
    'scripts/a.test.ts': "import { a } from './a.ts';",
    'scripts/b.test.ts': "import { readFileSync } from 'node:fs';\nreadFileSync('anything');",
    'apps/api/src/leaf.ts': 'export const leaf = 1;',
    'apps/api/src/middle.ts': "export { leaf } from './leaf.js';",
    'apps/api/src/middle.test.ts': "import { leaf } from './middle.js';",
    'apps/api/src/other.ts': 'export const other = 1;',
    'apps/api/src/other.test.ts': "import { other } from './other.js';",
    'apps/api/src/test-support/contract.ts':
      "import { readFileSync } from 'node:fs';\nexport const text = readFileSync(join(ROOT, 'contracts', 'audit.md'));",
    'apps/api/src/audit.test.ts': "import { text } from './test-support/contract.js';",
    'apps/api/test/support/api-process.ts': "import { spawn } from 'node:child_process';",
    'apps/api/test/tools.test.ts': "import { run } from './support/api-process.js';",
    'apps/api/test/database/leaf.db.test.ts': "import { leaf } from '../../src/leaf.js';",
    'apps/api/test/database/alone/roles.db.test.ts':
      "import { other } from '../../../src/other.js';",
    'apps/api/test/database/spawns.db.test.ts':
      "import { spawnSync } from 'node:child_process';\nspawnSync('node', ['scripts/tool.mjs']);",
    'scripts/tool.mjs': 'console.log(1);',
    'apps/api/migrations/0001_first.sql': 'create table x ();',
    'contracts/audit.md': '# audit',
    'contracts/other.md': '# other',
    'apps/attestation-verifier/service/Main.kt': 'fun main() {}',
    'e2e/harness/stack.ts': 'export const stack = 1;',
    'e2e/harness/stack.test.ts': "import { stack } from './stack.js';",
    'e2e/harness/process.test.ts': "import { spawn } from 'node:child_process';",
  };
  const pick = (
    changed: readonly string[],
    targets?: readonly TargetName[],
  ): Map<TargetName, Choice> => chooseIn(tree, changed, targets);

  // Break caught: a test above a changed module not chosen (a chain of imports followed one step only), or one beside it chosen.
  it('chooses the tests that import a changed module through any chain of imports, and only those', () => {
    const choices = pick(['apps/api/src/leaf.ts']);
    // The test that imports it through `middle`, and the cheap test that reads files (it might scan the package); not the one beside it.
    const unit = choiceOf(choices, 'api-unit');
    assert.deepEqual(unit.tests, ['apps/api/src/audit.test.ts', 'apps/api/src/middle.test.ts']);
    assert.deepEqual(unit.reasons, [
      '1 import a changed file',
      '1 read files or start processes, and apps/api/ changed',
    ]);
    assert.deepEqual(choiceOf(choices, 'api-db').tests, [
      'apps/api/test/database/leaf.db.test.ts',
      'apps/api/test/database/spawns.db.test.ts',
    ]);
    assert.equal(choiceOf(choices, 'api-client').mode, 'none');
  });

  // Break caught: a test that reads a document by name not chosen when the document changes, or chosen for another one.
  it('chooses a test whose reader names a changed file, and not one it does not name', () => {
    assert.ok(
      choiceOf(pick(['contracts/audit.md']), 'api-unit').tests.includes(
        'apps/api/src/audit.test.ts',
      ),
    );
    assert.equal(choiceOf(pick(['contracts/other.md']), 'api-unit').mode, 'none');
  });

  // Break caught: a cheap test that scans its package (the architecture test, a folder of fonts) missed for a file it never names.
  it('chooses every test of a cheap target that reads files when anything in its package changed', () => {
    const choices = pick(['apps/api/migrations/0001_first.sql']);
    assert.ok(choiceOf(choices, 'api-unit').tests.includes('apps/api/src/audit.test.ts'));
    assert.deepEqual(choiceOf(pick(['scripts/a.ts']), 'root').tests, [
      'scripts/a.test.ts',
      'scripts/b.test.ts',
    ]);
    assert.deepEqual(choiceOf(pick(['contracts/other.md']), 'root').tests, ['scripts/b.test.ts']);
  });

  // Break caught: a test that runs the built API not chosen when the API's source changes (it imports none of it), or chosen for a test file.
  it('chooses the tests that run the build, or start a process in the API, when the build’s source changes', () => {
    const choices = pick(['apps/api/src/other.ts']);
    assert.deepEqual(choiceOf(choices, 'api-process').tests, ['apps/api/test/tools.test.ts']);
    assert.ok(
      choiceOf(choices, 'api-db').tests.includes('apps/api/test/database/spawns.db.test.ts'),
    );
    assert.ok(
      choiceOf(choices, 'api-db').tests.includes('apps/api/test/database/alone/roles.db.test.ts'),
    );
    // A test of another package that starts a process starts its own, not the API's build.
    assert.equal(choiceOf(choices, 'e2e-unit').mode, 'none');
    assert.equal(choiceOf(pick(['apps/api/src/other.test.ts']), 'api-process').mode, 'none');
    // A script it starts by name, outside the build: the test that starts it is chosen when it changes.
    assert.deepEqual(choiceOf(pick(['scripts/tool.mjs']), 'api-db').tests, [
      'apps/api/test/database/spawns.db.test.ts',
    ]);
    assert.equal(isApiBuildInput('apps/api/src/test-support/contract.ts'), false);
    assert.equal(isApiBuildInput('apps/api/test/support/api-process.ts'), true);
  });

  // Break caught: a migration that does not rerun the database tests, or a lockfile change that does not rerun everything.
  it('reruns a whole target for its own inputs, and every target for what all of them depend on', () => {
    const migration = pick(['apps/api/migrations/0001_first.sql']);
    assert.equal(choiceOf(migration, 'api-db').mode, 'all');
    assert.equal(choiceOf(migration, 'api-db').tests.length, 3);
    for (const path of EVERYTHING) {
      const choices = pick([path]);
      for (const target of TARGETS)
        assert.equal(choiceOf(choices, target).mode, 'all', `${path} reruns ${target}`);
    }
    assert.equal(choiceOf(pick(['package.json']), 'root').mode, 'all');
    assert.equal(choiceOf(pick(['package.json']), 'api-unit').mode, 'none');
  });

  // Break caught: the verifier's source not rerunning its tests or the one database test that starts it; or (27 October 2026) the
  // judgement of its JDK, which the verifier's build runs first, left out of both.
  it('reruns the verifier, and the database test that starts it, when its source changes', () => {
    const choices = pick(['apps/attestation-verifier/service/Main.kt']);
    assert.equal(choiceOf(choices, 'verifier').mode, 'all');
    assert.equal(choiceOf(pick(['scripts/jdk.ts']), 'verifier').mode, 'all');
    assert.ok(matchesAny('scripts/jdk.ts', VERIFIER_RUNS.inputs));
    assert.equal(
      choiceOf(choices, 'api-db').mode,
      'none',
      'no test of this tree starts the verifier',
    );
  });

  // Break caught: the long run started unasked, or not reported when a change reaches it, or reported for a test file of another target.
  it('reports the end-to-end journeys as owed when a change reaches them, and not for a test of another target', () => {
    const owed = choiceOf(pick(['apps/api/src/leaf.ts']), 'e2e');
    assert.equal(owed.mode, 'all');
    assert.equal(owed.long, true);
    assert.match(
      renderPlan([owed], () => false, false).join('\n'),
      /OWED: a long run, left to the gate/,
    );
    assert.doesNotMatch(renderPlan([owed], () => true, false).join('\n'), /OWED/);
    assert.equal(choiceOf(pick(['apps/api/src/middle.test.ts']), 'e2e').mode, 'none');
    assert.equal(choiceOf(pick(['e2e/harness/stack.test.ts']), 'e2e').mode, 'none');
    assert.equal(choiceOf(pick(['e2e/harness/stack.ts']), 'e2e').mode, 'all');
  });

  // Break caught (the owner's decision of 27 October 2026): the process tests run for every change to the API's source, which the
  // database tests already run in process; or left owed when the change is to what only they test (start-up, configuration, shutdown,
  // the logs and probes, the tools, the tests themselves), to a whole-target input, or to what every test depends on.
  it('owes the process tests unless the change touches what they test', () => {
    const service = choiceOf(pick(['apps/api/src/other.ts']), 'api-process');
    assert.notEqual(service.mode, 'none');
    assert.equal(service.long, true);
    assert.ok(service.reasons.includes('no start-up code changed'), service.reasons.join());
    for (const path of [
      'apps/api/src/main.ts',
      'apps/api/src/platform/config/load-config.ts',
      'apps/api/src/platform/lifecycle/shutdown.ts',
      'apps/api/src/tools/db-reset.ts',
      'apps/api/test/support/api-process.ts',
      'apps/api/vitest.config.ts',
      'pnpm-lock.yaml',
    ]) {
      const choice = choiceOf(pick([path]), 'api-process');
      assert.notEqual(choice.mode, 'none', path);
      assert.equal(choice.long, false, path);
    }
    assert.equal(choiceOf(pick(['apps/api/src/other.ts']), 'api-db').long, false);
  });

  // Break caught: a long choice run unasked, or not run when asked by its own flag, or run by the other one's.
  it('runs a long choice only when asked: the journeys with --with-e2e, the process tests with --with-process', () => {
    const journeys = choiceOf(pick(['apps/api/src/leaf.ts']), 'e2e');
    const processTests = choiceOf(pick(['apps/api/src/other.ts']), 'api-process');
    const unit = choiceOf(pick(['apps/api/src/leaf.ts']), 'api-unit');
    const asked = (withE2e: boolean, withProcess: boolean) => ({ withE2e, withProcess });
    assert.deepEqual(
      [journeys, processTests, unit].map((choice) => released(choice, asked(false, false))),
      [false, false, true],
    );
    assert.deepEqual(
      [journeys, processTests].map((choice) => released(choice, asked(true, false))),
      [true, false],
    );
    assert.deepEqual(
      [journeys, processTests].map((choice) => released(choice, asked(false, true))),
      [false, true],
    );
    assert.match(
      renderPlan([processTests], () => false, false).join('\n'),
      /OWED: on request \(--with-process\)/,
    );
  });

  // Break caught: an empty change choosing something, or a run with nothing reached not saying so.
  it('chooses nothing when nothing changed', () => {
    for (const choice of pick([]).values()) assert.equal(choice.mode, 'none');
  });
});

describe('what else a change reaches (review of 27 October 2026)', () => {
  const client = JSON.stringify({
    name: '@melarc/api-client',
    exports: { '.': './src/index.ts', './browser': './src/browser/index.ts' },
  });
  const tree: Record<string, string> = {
    'package.json': ROOT_MANIFEST,
    'scripts/a.test.ts':
      "const config = await import(pathToFileURL(resolve(root, 'eslint.config.mjs')).href);",
    'eslint.config.mjs': 'export default [];',
    'packages/api-client/package.json': client,
    'packages/api-client/tsconfig.json': '{}',
    'packages/api-client/src/index.ts': 'export type Wire = string;',
    'packages/api-client/src/browser/index.ts': "export { csrf } from './csrf.js';",
    'packages/api-client/src/browser/csrf.ts': "export const csrf = 'X-CSRF-Token';",
    [OPS_ENTRY]:
      "import { csrf } from '@melarc/api-client/browser';\nimport './app/pages/riders/RiderPage.js';",
    'apps/ops-web/src/app/pages/riders/RiderPage.tsx':
      "import type { Wire } from '@melarc/api-client';",
    'apps/ops-web/src/app/pages/riders/RiderPage.test.tsx': "import './RiderPage.js';",
    'apps/ops-web/test/build.test.ts':
      "import { build } from 'vite';\nimport { readFileSync } from 'node:fs';",
    'apps/ops-web/test/logo.test.ts':
      "import { readFileSync } from 'node:fs';\nreadFileSync(LOGO);",
    'apps/ops-web/test/setup-components.ts': "import './support/dialog.js';",
    'apps/ops-web/test/support/dialog.ts': 'export const showModal = 1;',
    'apps/ops-web/test/browser/riders.spec.ts': 'export {};',
    'apps/ops-web/CLAUDE.md': '# rules',
    'apps/api/test/database/support/failure-evidence-setup.ts':
      "import '../../../src/test-support/failure-evidence.js';",
    'apps/api/src/test-support/failure-evidence.ts': 'export const watch = 1;',
    'apps/api/test/database/x.db.test.ts': 'export {};',
    'apps/api/test/database/alone/y.db.test.ts': 'export {};',
  };
  const pick = (changed: readonly string[]): Map<TargetName, Choice> => chooseIn(tree, changed);

  // Break caught: a helper of a setup file that every database test loads changing with only the files that import it chosen.
  it('reruns a whole target when a setup file it loads, or what that file imports, changes', () => {
    const choice = choiceOf(pick(['apps/api/src/test-support/failure-evidence.ts']), 'api-db');
    assert.equal(choice.mode, 'all');
    assert.match(choice.reasons.join(), /a setup file of every test loads/);
    assert.equal(choiceOf(pick(['apps/ops-web/test/support/dialog.ts']), 'ops-unit').mode, 'all');
  });

  // Break caught (review of 27 October 2026): a reader that names a file whose name holds a space never matched, since words split on spaces.
  it('ties a reader to a changed file whose name holds a space', () => {
    const spaced = {
      ...tree,
      'apps/api/test/database/photo.db.test.ts':
        "import { readFileSync } from 'node:fs';\nreadFileSync(join(ASSETS, 'photo 1.jpg'));",
      'assets/photo 1.jpg': 'jpg',
    };
    assert.deepEqual(choiceOf(chooseIn(spaced, ['assets/photo 1.jpg']), 'api-db').tests, [
      'apps/api/test/database/photo.db.test.ts',
    ]);
  });

  // Break caught: eslint.config.mjs loaded by an `import()` of a computed path, which neither imports nor names-a-read caught.
  it('takes an import() of a computed path for a read, which the name of the file then reaches', () => {
    assert.deepEqual(choiceOf(pick(['eslint.config.mjs']), 'root').tests, ['scripts/a.test.ts']);
  });

  // Break caught: a workspace package's manifest or TypeScript configuration, which shapes how its importers compile it, reaching nothing.
  it('ties a workspace package’s manifest and TypeScript configuration to every module that imports it', () => {
    for (const path of ['packages/api-client/package.json', 'packages/api-client/tsconfig.json']) {
      assert.ok(
        choiceOf(pick([path]), 'ops-unit').tests.includes(
          'apps/ops-web/src/app/pages/riders/RiderPage.test.tsx',
        ),
        path,
      );
    }
  });

  // Break caught: the production build test not chosen for a change to the client package the build bundles.
  it('chooses the tests that run Vite when a file the application loads changes', () => {
    assert.ok(
      choiceOf(pick(['packages/api-client/src/browser/csrf.ts']), 'ops-unit').tests.includes(
        'apps/ops-web/test/build.test.ts',
      ),
    );
    assert.ok(
      choiceOf(pick(['apps/ops-web/index.html']), 'ops-unit').tests.includes(
        'apps/ops-web/test/build.test.ts',
      ),
    );
  });

  // Break caught: the readers of a cheap target rerun for a document or a browser spec, which none of them reads; or a design original,
  // which the brand tests compare their copies with, reaching none of them.
  it('scans its folders for code and assets, not for documents or the browser specs, and the Ops Portal’s include design/', () => {
    assert.equal(choiceOf(pick(['apps/ops-web/CLAUDE.md']), 'ops-unit').mode, 'none');
    assert.equal(
      choiceOf(pick(['apps/ops-web/test/browser/riders.spec.ts']), 'ops-unit').mode,
      'none',
    );
    assert.ok(
      choiceOf(pick(['design/images/image 1.jpg']), 'ops-unit').tests.includes(
        'apps/ops-web/test/logo.test.ts',
      ),
    );
  });

  // Break caught: the shell's part of the client package (the CSRF header, the transport) changing with the shell spec left out.
  it('runs every browser spec when the client code the shell loads changes', () => {
    const projects = new Map([['riders.spec.ts', ['riders-chromium']]]);
    const choice = choiceOf(
      chooseIn(tree, ['packages/api-client/src/browser/csrf.ts'], ['ops-browser'], projects),
      'ops-browser',
    );
    assert.equal(choice.mode, 'all');
    assert.match(choice.reasons.join(), /the application shell changed/);
  });
});

describe('choosing the browser specs of the Ops Portal', () => {
  const pages = 'apps/ops-web/src/app/pages';
  const tree: Record<string, string> = {
    'package.json': ROOT_MANIFEST,
    [OPS_ENTRY]: "import './app/routes.js';\nimport './styles/base.css';",
    'apps/ops-web/src/app/routes.tsx': `import './navigation/registry.js';\nimport './frame.js';`,
    'apps/ops-web/src/app/frame.tsx': 'export const frame = 1;',
    'apps/ops-web/src/styles/base.css': 'body {}',
    'apps/ops-web/src/app/navigation/registry.tsx': `import '../pages/riders/RiderPage.js';\nimport '../pages/staff/StaffPage.js';`,
    [`${pages}/riders/RiderPage.tsx`]: "import '../../../components/ui/Dialog.js';",
    [`${pages}/riders/RiderPage.test.tsx`]: "import '../../../test-support/render.js';",
    [`${pages}/staff/StaffPage.tsx`]: "import '../../../components/ui/Dialog.js';",
    'apps/ops-web/src/test-support/render.tsx': "import '../app/navigation/registry.js';",
    'apps/ops-web/src/components/ui/Dialog.tsx': 'export const Dialog = 1;',
    'apps/ops-web/src/assets/fonts/inter.woff2': 'font',
    'apps/ops-web/test/browser/shell.spec.ts': "import './support/api.js';",
    'apps/ops-web/test/browser/riders.spec.ts': "import './support/rider-api.js';",
    'apps/ops-web/test/browser/staff.spec.ts': "import './support/api.js';",
    'apps/ops-web/test/browser/support/api.ts': 'export const api = 1;',
    'apps/ops-web/test/browser/support/rider-api.ts': 'export const api = 1;',
  };
  const projects = new Map([
    ['shell.spec.ts', ['shell-chromium']],
    ['riders.spec.ts', ['riders-chromium', 'riders-dev-chromium']],
    ['staff.spec.ts', ['staff-chromium', 'staff-dev-chromium']],
  ]);
  const browser = (
    changed: readonly string[],
    extra: Readonly<Record<string, string>> = {},
  ): Choice =>
    choiceOf(chooseIn({ ...tree, ...extra }, changed, ['ops-browser'], projects), 'ops-browser');

  // Break caught: a page change rerunning every spec (no saving), or a spec of that page not run.
  it('runs the specs of the pages a change reaches, with both of their projects', () => {
    const choice = browser([`${pages}/riders/RiderPage.tsx`]);
    assert.deepEqual(choice.tests, ['apps/ops-web/test/browser/riders.spec.ts']);
    assert.deepEqual(choice.projects, ['riders-chromium', 'riders-dev-chromium']);
    // A component the staff and the rider pages import reaches the specs of both folders; the shell spec is one of them for the staff folder, since it
    // follows the Sessions entry to a page there (review of 7 November 2026).
    assert.deepEqual(browser(['apps/ops-web/src/components/ui/Dialog.tsx']).tests, [
      'apps/ops-web/test/browser/riders.spec.ts',
      'apps/ops-web/test/browser/shell.spec.ts',
      'apps/ops-web/test/browser/staff.spec.ts',
    ]);
    assert.deepEqual(browser(['apps/ops-web/test/browser/support/rider-api.ts']).tests, [
      'apps/ops-web/test/browser/riders.spec.ts',
    ]);
  });

  // Break caught: the shell (routes, frame, styles) changed and only some specs run, though every page sits in it.
  it('runs every spec when the application shell changes', () => {
    for (const path of [
      'apps/ops-web/src/app/frame.tsx',
      'apps/ops-web/src/styles/base.css',
      'apps/ops-web/src/app/navigation/registry.tsx',
    ]) {
      const choice = browser([path]);
      assert.equal(choice.mode, 'all', path);
      assert.match(choice.reasons.join(), /the application shell changed/, path);
    }
    // Every spec, through every one of its projects.
    assert.deepEqual(browser(['apps/ops-web/src/app/frame.tsx']).projects, [
      'riders-chromium',
      'riders-dev-chromium',
      'shell-chromium',
      'staff-chromium',
      'staff-dev-chromium',
    ]);
  });

  // Break caught: a page folder no spec claims, or a file nothing imports (a font a stylesheet names), changing with no spec run.
  it('runs every spec for a page folder no spec claims and for a file of the application it cannot place', () => {
    const unclaimed = browser([`${pages}/reports/ReportPage.tsx`], {
      [`${pages}/reports/ReportPage.tsx`]: 'export {};',
    });
    assert.equal(unclaimed.mode, 'all');
    assert.match(unclaimed.reasons.join(), /a page folder no spec claims changed/);
    const font = browser(['apps/ops-web/src/assets/fonts/inter.woff2']);
    assert.equal(font.mode, 'all');
    assert.match(font.reasons.join(), /no spec can be tied to/);
  });

  // Break caught: a jsdom test beside a page (whose support loads every page) taken for the page, so every spec runs for a unit test.
  it('takes no jsdom test of a page folder for a change to the page', () => {
    assert.equal(browser([`${pages}/riders/RiderPage.test.tsx`]).mode, 'none');
  });
});

// ------------------------------------------------------------------------------------------------ the real repository

describe('the targets of this repository', () => {
  const files = new Set(treeFiles(root));
  const manifest = readFileSync(join(root, 'package.json'), 'utf8');
  const tests = new Map(
    DEFINITIONS.map((definition) => [definition.name, testsOf(definition, files, manifest)]),
  );

  // Break caught: a target added to one list and not the other, or run out of order.
  it('are defined once each, in the order they run', () => {
    assert.deepEqual(
      DEFINITIONS.map((definition) => definition.name),
      [...TARGETS],
    );
  });

  // Break caught: a test file in a folder no target covers, which no affected run ever chooses, or in two targets, which runs twice.
  it('cover every test file of the repository once, but the HTTPS and end-to-end specs, which the long run and CI own', () => {
    const owners = new Map<string, TargetName[]>();
    for (const [target, list] of tests)
      for (const test of list) owners.set(test, [...(owners.get(test) ?? []), target]);
    const testFiles = [...files].filter(
      (file) => /\.(test|spec)\.tsx?$/.test(file) && !file.includes('/node_modules/'),
    );
    const left = testFiles.filter((file) => !owners.has(file) && !file.startsWith('e2e/tests/'));
    assert.deepEqual(left, []);
    assert.deepEqual(
      [...owners].filter(([, targets]) => targets.length > 1),
      [],
    );
    for (const [target, list] of tests) {
      if (target === 'verifier' || target === 'e2e') continue;
      assert.ok(list.length > 0, `${target} has tests`);
    }
  });

  // Break caught: the root list read wrongly, so that a root test is never chosen.
  it('read the root tests from the test:root script', () => {
    const listed = tests.get('root') ?? [];
    assert.ok(listed.includes('scripts/affected.test.ts'));
    for (const test of listed) assert.ok(files.has(test), `${test} exists`);
  });

  // Break caught: a page folder or a spec added with no entry, so that every change to it runs every spec, or an entry naming nothing.
  it('give every browser spec its page folders, and every page folder a spec', () => {
    const specs = readdirSync(join(root, 'apps/ops-web/test/browser')).filter((name) =>
      name.endsWith('.spec.ts'),
    );
    assert.deepEqual(Object.keys(SPEC_AREAS).toSorted(), specs.toSorted());
    const folders = readdirSync(join(root, 'apps/ops-web/src/app/pages'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `apps/ops-web/src/app/pages/${entry.name}/`);
    const claimed = new Set(Object.values(SPEC_AREAS).flat());
    assert.deepEqual(
      folders.filter((folder) => !claimed.has(folder)),
      [],
    );
    for (const area of claimed)
      assert.ok(
        [...files].some((file) => file.startsWith(area)),
        `${area} exists`,
      );
    assert.ok(files.has(OPS_ENTRY));
  });

  // Break caught: the projects read from the Playwright configuration drifting from it, so a spec is chosen and none of its projects run.
  it('read the Chromium projects of every spec from the Playwright configuration', () => {
    const projects = readBrowserProjects(
      readFileSync(join(root, 'apps/ops-web/playwright.config.ts'), 'utf8'),
    );
    for (const spec of Object.keys(SPEC_AREAS)) {
      const named = projects.get(spec) ?? [];
      assert.ok(named.length > 0, `${spec} has a project`);
      for (const project of named) assert.match(project, /^[a-z-]+-chromium$/);
    }
    assert.deepEqual(projects.get('riders.spec.ts'), ['riders-chromium', 'riders-dev-chromium']);
  });

  // Break caught (review of 27 October 2026): the shell spec, which lands signed out on the sign-in page, and the specs that sign out,
  // left out when that page changes; or the one test that starts the real verifier moved without the rule that names it.
  it('tie the sign-in pages to every spec that starts signed out or signs out, and name the verifier test where it is', () => {
    for (const spec of [
      'shell.spec.ts',
      'pre-sign-in.spec.ts',
      'recovery.spec.ts',
      'staff.spec.ts',
      'riders.spec.ts',
    ]) {
      assert.ok((SPEC_AREAS[spec] ?? []).includes('apps/ops-web/src/app/pages/pre-sign-in/'), spec);
    }
    for (const test of VERIFIER_RUNS.tests) assert.ok(files.has(test), test);
  });

  // Break caught (review of 7 November 2026): My work moved into its own folder and the specs that open on it left out of that folder's claims, so a
  // change to the landing selected fewer specs than before it moved (the selector must run more, never less); or the shell spec, which follows the
  // Sessions entry of the sheet, left out of the claims of the staff pages. A spec whose text opens "/" must name the folder of My work, whichever
  // spec it is: a new one is held to it too.
  it('tie My work to every spec that opens the landing, and the staff pages to the shell spec that follows Sessions', () => {
    const folder = join(root, 'apps/ops-web/test/browser');
    const opening = readdirSync(folder).filter(
      (name) =>
        name.endsWith('.spec.ts') &&
        /goto\('\/'\)|path = '\/'/.test(readFileSync(join(folder, name), 'utf8')),
    );
    assert.deepEqual(
      opening.toSorted(),
      [
        'frame-toaster.spec.ts',
        'my-work.spec.ts',
        'palette.spec.ts',
        'queue-summary.spec.ts',
        'request-rate.spec.ts',
        'shell.spec.ts',
        'top-bar.spec.ts',
      ],
      'the specs that open on the landing (a new one is added here, with its claim)',
    );
    for (const spec of opening) {
      assert.ok((SPEC_AREAS[spec] ?? []).includes('apps/ops-web/src/app/pages/my-work/'), spec);
    }
    assert.ok(
      (SPEC_AREAS['shell.spec.ts'] ?? []).includes('apps/ops-web/src/app/pages/staff/'),
      'shell.spec.ts visits the Sessions page',
    );
    assert.ok(readFileSync(join(folder, 'shell.spec.ts'), 'utf8').includes("'/admin/sessions'"));
  });

  // Break caught: the input lists naming folders that moved, so the rules they carry fire for nothing.
  it('name inputs that exist', () => {
    const globs = [
      ...DEFINITIONS.flatMap((definition) => definition.whole),
      ...API_BUILD_INPUTS,
      ...EVERYTHING,
      ...PROCESS_START_UP,
    ];
    const unmatched = globs.filter((glob) => ![...files].some((file) => matchesAny(file, [glob])));
    // The local settings examples and the Vite configuration of a package that has none may be absent; nothing else may.
    assert.deepEqual(
      unmatched.filter((glob) => !['.npmrc'].includes(glob)),
      [],
    );
  });

  // Break caught (27 October 2026): a spec left without any project in an affected run, because its only project was the one deferred.
  it('defer only a development-server project whose spec also runs against the production build', () => {
    const projects = readBrowserProjects(
      readFileSync(join(root, 'apps/ops-web/playwright.config.ts'), 'utf8'),
    );
    for (const [spec, names] of projects) {
      const browser = {
        target: 'ops-browser',
        mode: 'some',
        tests: [spec],
        projects: names,
        reasons: [],
        since: 'x',
        long: false,
      } as const;
      const kept = only(deferDevelopmentProjects([browser], false)).projects ?? [];
      assert.ok(kept.length > 0, spec);
      assert.ok(
        kept.every((name) => !name.includes('-dev-')),
        spec,
      );
    }
  });

  // Break caught: the helper that runs the built API no longer starting processes itself (moved behind a module this cannot see), so a
  // change to the API's source stops reaching the process tests and the database tests that run tools.
  it('see the helper that runs the build start processes, which is what reaches every test that uses it', () => {
    const model = buildSourceModel(files, (path) => readFileSync(join(root, path), 'utf8'));
    assert.equal(model.modules.get('apps/api/test/support/api-process.ts')?.startsProcesses, true);
  });
});

// ------------------------------------------------------------------------------------------------ what changed

describe('what changed', () => {
  // Break caught: a removed file not counted as a change (its importers' tests never chosen), or an unchanged one counted.
  it('is every file changed, added or removed since the recorded tree', () => {
    const before = new Map([
      ['same.ts', sha('1')],
      ['edited.ts', sha('2')],
      ['removed.ts', sha('3')],
    ]);
    const now = new Map([
      ['same.ts', sha('1')],
      ['edited.ts', sha('changed')],
      ['added.ts', sha('4')],
    ]);
    assert.deepEqual(differences(now, before), ['added.ts', 'edited.ts', 'removed.ts']);
  });

  // Break caught: a target with a record compared with the last commit (more than needed), or one without a record compared with nothing.
  it('is measured from each target’s last green run, from the last commit without one, and from a revision when asked', () => {
    const where = temp();
    const recorded = new Map([['a.ts', sha('a')]]);
    recordTargets(where, ['api-unit'], recorded, 'affected');
    const now = new Map([
      ['a.ts', sha('a2')],
      ['b.ts', sha('b')],
    ]);
    const asked: string[] = [];
    const sinceRevision = (revision: string): string[] => {
      asked.push(revision);
      return ['from-git.ts'];
    };
    const [unit, database, rootTarget] = changesFor(
      where,
      now,
      ['api-unit', 'api-db', 'root'],
      undefined,
      sinceRevision,
    );
    assert.ok(unit !== undefined && database !== undefined && rootTarget !== undefined);
    assert.deepEqual(unit.changed, ['a.ts', 'b.ts']);
    assert.match(unit.since, /its last green run \(affected, /);
    assert.deepEqual(database.changed, ['from-git.ts']);
    assert.match(database.since, /the last commit/);
    assert.deepEqual(rootTarget.changed, ['from-git.ts']);
    assert.deepEqual(asked, ['HEAD'], 'the last commit is asked for once');
    const since = only(changesFor(where, now, ['api-unit'], 'main', sinceRevision));
    assert.deepEqual(since.changed, ['from-git.ts']);
    assert.deepEqual(asked, ['HEAD', 'main']);
  });
});

// ------------------------------------------------------------------------------------------------ running

describe('the browser modes an affected run leaves to the gate', () => {
  const browser = {
    target: 'ops-browser',
    mode: 'some',
    tests: [
      'apps/ops-web/test/browser/staff.spec.ts',
      'apps/ops-web/test/browser/components.spec.ts',
    ],
    projects: ['staff-chromium', 'staff-dev-chromium', 'components-chromium'],
    reasons: [],
    since: 'x',
    long: false,
  } as const;

  // Break caught (the owner's decision of 27 October 2026): both modes of every spec run on every change to a page; or a spec whose only
  // project is the development server's left out; or the second mode dropped when asked for.
  it('runs a spec against the production build and leaves its development-server project to the gate unless asked', () => {
    const deferred = only(deferDevelopmentProjects([browser], false));
    assert.deepEqual(deferred.projects, ['staff-chromium', 'components-chromium']);
    assert.deepEqual(deferred.deferred, ['staff-dev-chromium']);
    assert.deepEqual(deferDevelopmentProjects([browser], true), [browser]);
    const solo = { ...browser, projects: ['solo-dev-chromium'] } as const;
    assert.deepEqual(deferDevelopmentProjects([solo], false), [solo]);
    const other = { ...browser, target: 'api-unit', projects: undefined } as const;
    assert.deepEqual(deferDevelopmentProjects([other], false), [other]);
  });
});

describe('the commands it runs', () => {
  const choice = (
    target: TargetName,
    tests: readonly string[],
    mode: Choice['mode'] = 'some',
    projects?: readonly string[],
  ): Choice => ({
    target,
    mode,
    tests,
    reasons: [],
    since: 'a test',
    long: false,
    ...(projects === undefined ? {} : { projects }),
  });

  // Break caught (27 October 2026): the attested-enrolment test, which starts the real verifier, run on a machine with no JDK and
  // reported as a failure of the change; or every database run held to a JDK that only that test needs.
  it('needs a JDK for the database target only when it runs the test that starts the verifier', () => {
    const other = 'apps/api/test/database/a.db.test.ts';
    assert.deepEqual(needsOf(choice('api-db', [other])), ['api-build', 'database']);
    // Break caught: the alert rehearsal, which starts the verifier too, run with no JDK check, so that it fails on a Java error.
    for (const test of VERIFIER_RUNS.tests) {
      assert.deepEqual(
        needsOf(choice('api-db', [other, test])),
        ['api-build', 'database', 'jdk'],
        test,
      );
    }
    assert.deepEqual(needsOf(choice('api-unit', ['apps/api/src/a.test.ts'])), []);
  });

  it('owes that target, with the way out, when no usable JDK is found, and lets it run when one is', () => {
    assert.equal(
      jdkBlock({ ok: true, jdk: { source: 'JAVA_HOME', major: 21, hasCompiler: true } }),
      undefined,
    );
    const block = jdkBlock({
      ok: false,
      problem: 'No JDK answers (`java -version` on the path failed). The verifier needs JDK 21.',
      installHelp: true,
    });
    assert.ok(block !== undefined);
    assert.equal(block.status, 'not-run');
    assert.match(
      block.note,
      /rider-device-enrolment-attested\.db\.test\.ts and alert-rehearsal\.db\.test\.ts start the attestation verifier/,
    );
    assert.match(block.note, /No JDK answers/);
    assert.match(block.note, /JAVA_HOME/);
  });

  // Break caught: a run of the whole suite where some files were chosen (no saving), or of other files than those chosen.
  it('runs the chosen files of a Vitest target, with its projects, and every file when all are chosen', () => {
    const step = only(stepsFor(choice('api-db', ['apps/api/test/database/a.db.test.ts']), root));
    assert.deepEqual(step.argv?.slice(2), [
      'run',
      '--project',
      'database',
      '--project',
      'database-alone',
      'test/database/a.db.test.ts',
    ]);
    assert.equal(step.cwd, join(root, 'apps/api'));
    const whole = only(
      stepsFor(choice('api-db', ['apps/api/test/database/a.db.test.ts'], 'all'), root),
    );
    assert.deepEqual(whole.argv?.slice(2), [
      'run',
      '--project',
      'database',
      '--project',
      'database-alone',
    ]);
    const many = Array.from(
      { length: 2000 },
      (_, index) => `apps/api/src/a-long-name-for-a-test-file-${String(index)}.test.ts`,
    );
    assert.ok(many.join(' ').length > COMMAND_LINE_LIMIT);
    const tooLong = only(stepsFor(choice('api-unit', many), root));
    assert.deepEqual(
      tooLong.argv?.slice(2),
      ['run', '--project', 'unit'],
      'a command line Windows cannot take runs the whole target',
    );
  });

  // Break caught: the browser run starting every engine or every project, or the root run starting tests not chosen.
  it('runs the chosen Playwright projects in Chromium, and the chosen root tests with node --test', () => {
    const browser = only(
      stepsFor(choice('ops-browser', [], 'some', ['riders-chromium', 'riders-dev-chromium']), root),
    );
    assert.deepEqual(browser.argv?.slice(2), [
      'test',
      '--project=riders-chromium',
      '--project=riders-dev-chromium',
    ]);
    assert.deepEqual(browser.env, { MELARC_BROWSERS: 'chromium' });
    const rootStep = only(stepsFor(choice('root', ['scripts/a.test.ts']), root));
    assert.deepEqual(rootStep.argv?.slice(1), ['--test', 'scripts/a.test.ts']);
  });

  // Break caught (review of 27 October 2026): VITEST_MAX_WORKERS passed on, which Vitest applies to every project after its configuration,
  // so the API's one-at-a-time projects ran several at a time; or no bound at all, which starves this machine; or colour codes in the logs.
  it('gives plain logs, bounds the parallel suites with MELARC_TEST_WORKERS, and passes no VITEST_MAX_WORKERS', () => {
    const env = childEnvironment({ FORCE_COLOR: '1', VITEST_MAX_WORKERS: '4' }, 3);
    assert.equal(env.FORCE_COLOR, undefined);
    assert.equal(env.VITEST_MAX_WORKERS, undefined);
    assert.equal(env.MELARC_TEST_WORKERS, '3');
  });

  // Break caught: a `MELARC_BROWSER_SHARD` left in the shell (from reproducing one job of CI) reaching the browser run, which the Ops
  // Portal's configuration would then cut to one shard: a run that says "passed" for a part of the specs the change reaches.
  it('passes no MELARC_BROWSER_SHARD, which would cut the browser run to a part of the specs chosen', () => {
    const env = childEnvironment({ MELARC_BROWSER_SHARD: '2/7', MELARC_BROWSERS: 'firefox' }, 3);
    assert.equal(env.MELARC_BROWSER_SHARD, undefined);
    assert.equal(env.MELARC_BROWSERS, 'firefox', 'only the shard is taken out');
  });
});

describe('what a run reports and records', () => {
  const step = (couldNotRun?: readonly number[]) => ({
    label: 'x',
    cwd: root,
    ...(couldNotRun === undefined ? {} : { couldNotRun }),
  });

  // Break caught (review of 27 October 2026): a missing JDK reported as a failed test, or a failed test as a target that could not run.
  it('tells a target that could not start here from one that failed', () => {
    assert.equal(outcomeOf(step(), 0), 'passed');
    assert.equal(outcomeOf(step(), 1), 'failed');
    assert.equal(outcomeOf(step(), null), 'failed');
    assert.equal(outcomeOf(step([2]), 2), 'not-run');
    assert.equal(outcomeOf(step([2]), 1), 'failed');
    const verifier = only(
      stepsFor(
        { target: 'verifier', mode: 'all', tests: [], reasons: [], since: 'x', long: false },
        root,
      ),
    );
    assert.deepEqual(verifier.couldNotRun, [2]);
  });

  // Break caught (27 October 2026): the parts left to the gate on request not named in the closing line, so that nobody knows to ask.
  it('owes the process tests and the development-server projects it left, each with the way to run them', () => {
    const lines = renderReport({
      outcomes: [{ target: 'ops-browser', status: 'passed', note: 'log' }],
      longOwed: ['api-process'],
      deferredProjects: ['staff-dev-chromium', 'riders-dev-chromium'],
      unsettled: [],
      elapsedMs: 1_000,
    });
    assert.equal(
      lines[1],
      'Owed: api-process (on request: no start-up code changed; left to the gate or --with-process); ops-browser development-server projects staff-dev-chromium, riders-dev-chromium (left to the gate or --with-dev-browser).',
    );
  });

  // Break caught: "Owed" quoted without the targets that could not run, or a run with such a target called passed.
  it('owes, in one line, the long runs left to the gate and every target that could not run, with its reason', () => {
    const lines = renderReport({
      outcomes: [
        { target: 'api-unit', status: 'passed', note: 'log' },
        { target: 'api-db', status: 'not-run', note: 'the database does not answer' },
      ],
      longOwed: ['e2e'],
      unsettled: [],
      elapsedMs: 61_000,
    });
    assert.match(lines[0] ?? '', /^Affected run INCOMPLETE after 1:01\. Passed: api-unit\.$/);
    assert.equal(
      lines[1],
      'Owed: e2e (a long run, left to the gate or --with-e2e); api-db (not run: the database does not answer).',
    );
    assert.equal(exitCodeOf([{ target: 'api-db', status: 'not-run', note: '' }], []), 2);
    assert.equal(exitCodeOf([{ target: 'api-db', status: 'failed', note: '' }], ['a.ts']), 1);
    assert.equal(exitCodeOf([{ target: 'api-db', status: 'passed', note: '' }], ['a.ts']), 3);
    assert.equal(exitCodeOf([{ target: 'api-db', status: 'passed', note: '' }], []), 0);
  });

  // Break caught (review of 27 October 2026): a target nothing reached recorded as green after a comparison with the last commit or a
  // revision, which nothing says passed, so that a failing test is forgotten.
  it('records a target nothing reached only when it was compared with a green run of its own', () => {
    const none = (target: TargetName): Choice => ({
      target,
      mode: 'none',
      tests: [],
      reasons: [],
      since: 'x',
      long: false,
    });
    const changes = (fromRecord: boolean): TargetChanges[] =>
      (['api-unit', 'api-db'] as const).map((target) => ({
        target,
        changed: [],
        since: 'x',
        fromRecord,
      }));
    assert.deepEqual(untouchedTargets([none('api-unit'), none('api-db')], changes(true)), [
      'api-unit',
      'api-db',
    ]);
    assert.deepEqual(untouchedTargets([none('api-unit'), none('api-db')], changes(false)), []);
    const reached: Choice = {
      target: 'api-db',
      mode: 'all',
      tests: ['t'],
      reasons: [],
      since: 'x',
      long: false,
    };
    assert.deepEqual(untouchedTargets([none('api-unit'), reached], changes(true)), ['api-unit']);
  });
});

describe('one run at a time, as the command starts', () => {
  // Break caught: an affected run started beside another, or refused because of its own marker.
  it('refuses to start beside another affected run, and not because of itself', () => {
    const gates = temp();
    const runs = temp();
    assert.equal(startRefusal(gates, runs), undefined);
    const stop = markRunning(runs);
    try {
      assert.equal(startRefusal(gates, runs), undefined, 'its own marker');
    } finally {
      stop();
    }
    // Another process that is alive (the one that started this test) marks a run of its own.
    const now = new Date().toISOString();
    writeFileSync(
      join(runs, 'running.json'),
      JSON.stringify({ pid: process.ppid, startedAt: now, updatedAt: now }),
    );
    assert.match(startRefusal(gates, runs) ?? '', /Another affected run is running \(process \d+/);
  });
});

describe('one run at a time', () => {
  // Break caught: two affected runs at once, or a gate beside one, sharing ports, roles and memory; or a run long gone still counted.
  it('knows a running affected run by its live process and fresh heartbeat, and forgets it when it ends', () => {
    const base = temp();
    assert.equal(runningAffected(base), undefined);
    const stop = markRunning(base);
    assert.equal(runningAffected(base)?.pid, process.pid);
    assert.equal(
      runningAffected(base, Date.now() + 60_000),
      undefined,
      'a heartbeat older than 30 seconds is not a running run',
    );
    stop();
    assert.equal(runningAffected(base), undefined);
    writeFileSync(
      join(base, 'running.json'),
      JSON.stringify({ pid: 999_999_999, startedAt: 'x', updatedAt: new Date().toISOString() }),
    );
    assert.equal(runningAffected(base), undefined, 'a process that is gone is not a running run');
  });
});

describe('the options', () => {
  // Break caught: an option that is not one taken silently, or a value that reaches Git as something other than a revision.
  it('are read as given, and refused by name when they are not options', () => {
    assert.deepEqual(
      parseOptions([
        '--dry-run',
        '--list',
        '--only',
        'api-unit,root',
        '--since',
        'main',
        '--workers',
        '2',
        '--with-e2e',
        '--with-process',
        '--with-dev-browser',
      ]),
      {
        options: {
          dryRun: true,
          list: true,
          since: 'main',
          only: ['api-unit', 'root'],
          withE2e: true,
          withProcess: true,
          withDevBrowser: true,
          workers: 2,
          forget: false,
        },
        problems: [],
      },
    );
    assert.deepEqual(parseOptions(['--']).problems, []);
    assert.match(parseOptions(['--fast']).problems.join(), /"--fast" is not an option/);
    assert.match(parseOptions(['--only', 'api,root']).problems.join(), /--only takes targets from/);
    assert.match(parseOptions(['--since', 'main;rm']).problems.join(), /is not a revision/);
    assert.match(
      parseOptions(['--since', '-x']).problems.join(),
      /needs a value|is not a revision/,
    );
    assert.match(parseOptions(['--workers', '0']).problems.join(), /--workers is a whole number/);
    assert.match(parseOptions(['--since']).problems.join(), /--since needs a value/);
  });
});

describe('the record lives where nothing ships it', () => {
  // Break caught: the record written into the tree, where a commit or the source package would carry it.
  it('below node_modules', () => {
    assert.ok(BASELINE_FILE.startsWith('node_modules/.cache/'));
    mkdirSync(join(temp(), 'node_modules'), { recursive: true });
  });
});
