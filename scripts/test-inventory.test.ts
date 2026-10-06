import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';

import {
  findInventoryProblems,
  findPackageProblems,
  findRootTestProblems,
  globToRegExp,
  listTestFiles,
  playwrightRuns,
  readPackageFacts,
  readPlaywrightConfig,
  readVitestConfig,
  workspaceDirectories,
  type PackageFacts,
} from './test-inventory.ts';

const root = resolve(import.meta.dirname, '..');

const rootScripts = (): Record<string, string> =>
  (
    JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    }
  ).scripts;

const codes = (facts: PackageFacts): string[] =>
  findPackageProblems(facts)
    .map((problem) => problem.code)
    .toSorted();

describe('globToRegExp', () => {
  const matches = (glob: string, path: string): boolean => globToRegExp(glob).test(path);

  it('reads ** followed by a slash as any number of folders, none included', () => {
    assert.ok(matches('src/**/*.test.ts', 'src/a.test.ts'));
    assert.ok(matches('src/**/*.test.ts', 'src/a/b/c.test.ts'));
    assert.ok(!matches('src/**/*.test.ts', 'srcx/a.test.ts'));
    assert.ok(!matches('src/**/*.test.ts', 'lib/src/a.test.ts'));
  });

  // Break caught: a * that crosses folders, which would make a test in a subfolder look matched by a pattern
  // that Vitest would not apply to it.
  it('reads * as anything but a slash', () => {
    assert.ok(matches('test/*.test.ts', 'test/a.test.ts'));
    assert.ok(!matches('test/*.test.ts', 'test/support/a.test.ts'));
    assert.ok(!matches('test/*.test.ts', 'test/.test.ts.bak'));
  });

  // Break caught: a dot that matches any character, so a.testxts would count as a.test.ts.
  it('takes the other characters literally', () => {
    assert.ok(!matches('src/**/*.test.ts', 'src/a.testxts'));
    assert.ok(!matches('src/**/*.test.ts', 'src/a.test.tsx'));
    assert.ok(matches('a+b.ts', 'a+b.ts'));
    assert.ok(!matches('a+b.ts', 'aab.ts'));
  });

  it('reads {a,b} as alternatives and ? as one character', () => {
    assert.ok(matches('src/**/*.test.{ts,tsx}', 'src/x/y.test.tsx'));
    assert.ok(matches('src/**/*.test.{ts,tsx}', 'src/y.test.ts'));
    assert.ok(!matches('src/**/*.test.{ts,tsx}', 'src/y.test.js'));
    assert.ok(matches('a?c.ts', 'abc.ts'));
    assert.ok(!matches('a?c.ts', 'a/c.ts'));
  });

  it('reads ** at the end as everything below', () => {
    assert.ok(matches('test/**', 'test/a/b.ts'));
    assert.ok(!matches('test/**', 'tests/a.ts'));
  });
});

describe('the test:root script', () => {
  const FILES = ['scripts/a.test.ts', 'scripts/b.test.ts'];
  const script = 'node --test scripts/a.test.ts scripts/b.test.ts';
  const problems = (files: readonly string[], text: string | undefined, there = FILES): string[] =>
    findRootTestProblems(files, text, (path) => there.includes(path)).map((p) => p.code);

  it('accepts a script that names every test file once', () => {
    assert.deepEqual(problems(FILES, script), []);
    assert.deepEqual(problems(FILES, '  node --test scripts/b.test.ts   scripts/a.test.ts '), []);
  });

  // Break caught (the reason test:root names files and not a glob): a new test file that nobody added to the
  // list, which `node --test` never runs and does not complain about.
  it('reports a test file the script does not name', () => {
    const found = findRootTestProblems([...FILES, 'scripts/new.test.ts'], script, (path) =>
      FILES.includes(path),
    );
    assert.deepEqual(
      found.map((p) => p.code),
      ['ROOT_TEST_NOT_LISTED'],
    );
    assert.match(found[0]?.message ?? '', /scripts\/new\.test\.ts/);
  });

  it('reports a test file in a subfolder the same way', () => {
    assert.deepEqual(problems([...FILES, 'scripts/more/c.test.ts'], script), [
      'ROOT_TEST_NOT_LISTED',
    ]);
  });

  // Break caught: a renamed or deleted file still named, which node reports only when it runs.
  it('reports a named file that is not there', () => {
    assert.deepEqual(problems(FILES, `${script} scripts/gone.test.ts`), ['ROOT_TEST_MISSING']);
  });

  it('reports a file named twice', () => {
    assert.deepEqual(problems(FILES, `${script} scripts/a.test.ts`), ['ROOT_TEST_DUPLICATE']);
  });

  // Break caught: a script that is no longer a list of files (a glob, a flag first, another runner), whose
  // coverage this cannot read, passing as though it covered everything.
  for (const text of [
    undefined,
    '',
    'node --test',
    'node --test --watch scripts/a.test.ts scripts/b.test.ts',
    'node --test scripts/a.test.ts --watch scripts/b.test.ts',
    'node scripts/a.test.ts scripts/b.test.ts',
    'vitest run scripts/a.test.ts scripts/b.test.ts',
    'pnpm run test:other',
  ]) {
    it(`cannot read ${JSON.stringify(text)}`, () => {
      assert.deepEqual(problems(FILES, text), ['ROOT_SCRIPT_UNREADABLE']);
    });
  }

  // A glob names no file: the files it would find are reported as unnamed, and the glob as a file that is not
  // there, so a script written with one fails instead of passing.
  it('does not take a glob for the files it would find', () => {
    assert.deepEqual(problems(FILES, 'node --test scripts/*.test.ts'), [
      'ROOT_TEST_NOT_LISTED',
      'ROOT_TEST_NOT_LISTED',
      'ROOT_TEST_MISSING',
    ]);
  });
});

describe('listing the test files of a folder', () => {
  // Break caught: output, installed and machine-local folders searched, so copies of tests (or someone else's)
  // are reported as tests of this package that no runner picks up.
  it('finds test and spec files at any depth, and skips what is not source', () => {
    const folder = mkdtempSync(join(tmpdir(), 'melarc-inventory-'));
    try {
      const files = [
        'a.test.ts',
        'sub/deep/b.spec.ts',
        'c.test.tsx',
        'd.test.mjs',
        'plain.ts',
        'atest.ts',
        'node_modules/pkg/e.test.ts',
        'dist/f.test.js',
        'build/g.test.js',
        'coverage/h.test.js',
        'test-results/i.spec.ts',
        'playwright-report/j.spec.ts',
        'tmp/k.test.ts',
        '.hidden/l.test.ts',
      ];
      for (const file of files) {
        mkdirSync(dirname(join(folder, file)), { recursive: true });
        writeFileSync(join(folder, file), '');
      }
      assert.deepEqual(listTestFiles(folder), [
        'a.test.ts',
        'c.test.tsx',
        'd.test.mjs',
        'sub/deep/b.spec.ts',
      ]);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe('the Vitest configuration', () => {
  const API = `
    projects: [
      { extends: true, test: { name: 'unit', include: ['src/**/*.test.ts'] } },
      { extends: true, test: { name: "process", include: ['test/*.test.ts', "test/support/**/*.test.ts"] } },
    ],`;

  it('reads the include patterns and the project names', () => {
    const facts = readVitestConfig(API);
    assert.deepEqual(facts.includes, [
      'src/**/*.test.ts',
      'test/*.test.ts',
      'test/support/**/*.test.ts',
    ]);
    assert.deepEqual(facts.projects, ['unit', 'process']);
    assert.deepEqual(facts.unreadable, []);
  });

  // Break caught: a form this reads wrongly, taken as though nothing were excluded or the pattern known.
  it('says when an include is not a list of strings', () => {
    assert.equal(readVitestConfig('test: { include: PATTERNS }').unreadable.length, 1);
    assert.equal(
      readVitestConfig("test: { include: ['a', ...MORE], name: 'x' }").unreadable.length,
      0,
    );
  });

  it('says when it has an exclude, which it does not model', () => {
    assert.equal(readVitestConfig("test: { include: ['a'], exclude: ['b'] }").unreadable.length, 1);
  });
});

describe('the Playwright configuration', () => {
  const OPS = `
    testDir: './test/browser',
    projects: [
      { name: 'shell', testMatch: 'shell.spec.ts' },
      { name: "components", testMatch: "components.spec.ts" },
    ],`;

  it('reads the folder and the patterns', () => {
    const facts = readPlaywrightConfig(OPS);
    assert.equal(facts.testDir, 'test/browser');
    assert.deepEqual(facts.testMatch, ['shell.spec.ts', 'components.spec.ts']);
    assert.deepEqual(facts.unreadable, []);
  });

  // Break caught: a spec added to the folder that no project names, which Playwright skips without a word.
  it('runs the specs the projects name, wherever they sit under the folder, and no others', () => {
    const facts = readPlaywrightConfig(OPS);
    assert.ok(playwrightRuns(facts, 'test/browser/shell.spec.ts'));
    assert.ok(playwrightRuns(facts, 'test/browser/components.spec.ts'));
    assert.ok(playwrightRuns(facts, 'test/browser/nested/shell.spec.ts'));
    assert.ok(!playwrightRuns(facts, 'test/browser/new.spec.ts'));
    assert.ok(!playwrightRuns(facts, 'test/browser/shell.spec.tsx'));
    assert.ok(!playwrightRuns(facts, 'test/shell.spec.ts'), 'outside the test folder');
    assert.ok(!playwrightRuns(facts, 'src/shell.spec.ts'));
  });

  it('runs any spec or test under its folder when no project narrows it', () => {
    const facts = readPlaywrightConfig("testDir: './tests', projects: [{ name: 'chromium' }]");
    assert.deepEqual(facts.testMatch, []);
    assert.ok(playwrightRuns(facts, 'tests/a.spec.ts'));
    assert.ok(playwrightRuns(facts, 'tests/deep/a.test.ts'));
    assert.ok(!playwrightRuns(facts, 'tests/helper.ts'));
    assert.ok(!playwrightRuns(facts, 'other/a.spec.ts'));
  });

  it('matches a pattern with a slash against the path under the folder', () => {
    const facts = readPlaywrightConfig("testDir: 't', testMatch: 'sub/*.spec.ts'");
    assert.ok(playwrightRuns(facts, 't/sub/a.spec.ts'));
    assert.ok(!playwrightRuns(facts, 't/a.spec.ts'));
  });

  it('says when it is written in a form it does not read', () => {
    assert.equal(readPlaywrightConfig("testMatch: 'a.spec.ts'").unreadable.length, 1, 'no testDir');
    assert.equal(
      readPlaywrightConfig("testDir: 'a', testDir: 'b'").unreadable.length,
      1,
      'two testDirs',
    );
    assert.equal(readPlaywrightConfig('testDir: DIR').unreadable.length, 1, 'a testDir variable');
    assert.equal(
      readPlaywrightConfig("testDir: 'a', testMatch: /x/").unreadable.length,
      1,
      'a testMatch pattern that is not a string',
    );
    assert.equal(
      readPlaywrightConfig("testDir: 'a', testIgnore: 'b'").unreadable.length,
      1,
      'a testIgnore',
    );
  });
});

describe('the tests of a package', () => {
  const API_CONFIG = `
    projects: [
      { test: { name: 'unit', include: ['src/**/*.test.ts'] } },
      { test: { name: 'database', include: ['test/database/**/*.test.ts'] } },
    ],`;
  const OPS_VITEST = `projects: [{ test: { name: 'components', include: ['src/**/*.test.{ts,tsx}'] } }],`;
  const OPS_PLAYWRIGHT = `testDir: './test/browser', projects: [{ testMatch: 'shell.spec.ts' }]`;

  const api: PackageFacts = {
    directory: 'apps/api',
    testFiles: ['src/a.test.ts', 'src/deep/b.test.ts', 'test/database/c.test.ts'],
    scripts: { test: 'vitest run --project unit', 'test:db': 'vitest run --project database' },
    vitestConfig: API_CONFIG,
  };
  const ops: PackageFacts = {
    directory: 'apps/ops-web',
    testFiles: ['src/a.test.tsx', 'test/browser/shell.spec.ts'],
    scripts: { test: 'vitest run', 'test:browser': 'playwright test' },
    vitestConfig: OPS_VITEST,
    playwrightConfig: OPS_PLAYWRIGHT,
  };

  it('accepts packages whose every test file is run', () => {
    assert.deepEqual(codes(api), []);
    assert.deepEqual(codes(ops), []);
  });

  // Break caught: a test file put where no runner looks, which then reads as a guarantee and proves nothing.
  it('reports a test file that no include matches', () => {
    const found = findPackageProblems({
      ...api,
      testFiles: [...api.testFiles, 'scripts/x.test.ts'],
    });
    assert.deepEqual(
      found.map((p) => p.code),
      ['TEST_NOT_RUN'],
    );
    assert.match(found[0]?.message ?? '', /apps\/api\/scripts\/x\.test\.ts/);
  });

  it('reports a test of another name that no include matches', () => {
    assert.deepEqual(codes({ ...api, testFiles: [...api.testFiles, 'src/x.spec.ts'] }), [
      'TEST_NOT_RUN',
    ]);
    assert.deepEqual(codes({ ...api, testFiles: [...api.testFiles, 'test/x.test.ts'] }), [
      'TEST_NOT_RUN',
    ]);
  });

  it('reports a spec in the browser folder that no project names', () => {
    assert.deepEqual(
      codes({ ...ops, testFiles: [...ops.testFiles, 'test/browser/components.spec.ts'] }),
      ['TEST_NOT_RUN'],
    );
  });

  it('reports a spec outside the browser folder, which no runner looks in', () => {
    assert.deepEqual(codes({ ...ops, testFiles: [...ops.testFiles, 'src/shell.spec.ts'] }), [
      'TEST_NOT_RUN',
    ]);
  });

  it('reports a package that has test files and no runner configuration at all', () => {
    const bare: PackageFacts = {
      directory: 'packages/x',
      testFiles: ['src/a.test.ts', 'src/b.test.ts'],
      scripts: {},
    };
    assert.deepEqual(codes(bare), ['TEST_NOT_RUN', 'TEST_NOT_RUN']);
  });

  // Break caught: a project that runs nothing because its pattern was mistyped or its files moved; the run
  // still passes when another project found tests.
  it('reports an include that matches no file', () => {
    assert.deepEqual(
      codes({
        ...api,
        testFiles: ['src/a.test.ts'],
      }),
      ['PATTERN_MATCHES_NOTHING'],
    );
  });

  it('reports a testMatch that matches no spec', () => {
    assert.deepEqual(codes({ ...ops, testFiles: ['src/a.test.tsx'] }), ['PATTERN_MATCHES_NOTHING']);
  });

  // Break caught: a project whose script was dropped from `test` or `test:db`, so CI never starts it.
  it('reports a Vitest project that no CI script starts', () => {
    assert.deepEqual(codes({ ...api, scripts: { test: 'vitest run --project unit' } }), [
      'PROJECT_NOT_RUN',
    ]);
    assert.deepEqual(codes({ ...api, scripts: {} }), ['PROJECT_NOT_RUN', 'PROJECT_NOT_RUN']);
  });

  it('does not count a script that CI does not run', () => {
    assert.deepEqual(
      codes({
        ...api,
        scripts: {
          test: 'vitest run --project unit',
          'test:other': 'vitest run --project database',
        },
      }),
      ['PROJECT_NOT_RUN'],
    );
  });

  it('counts a script that starts every project', () => {
    assert.deepEqual(codes({ ...api, scripts: { test: 'vitest run' } }), []);
    assert.deepEqual(
      codes({ ...api, scripts: { test: 'vitest run --project unit --project database' } }),
      [],
    );
  });

  it('expects a Vitest configuration without projects to be started by a test script', () => {
    const plain: PackageFacts = {
      directory: 'packages/p',
      testFiles: ['src/a.test.ts'],
      scripts: { build: 'tsc' },
      vitestConfig: "test: { include: ['src/**/*.test.ts'] }",
    };
    assert.deepEqual(codes(plain), ['PROJECT_NOT_RUN']);
    assert.deepEqual(codes({ ...plain, scripts: { test: 'vitest run' } }), []);
  });

  it('expects a Playwright configuration to be started by a test:* script', () => {
    assert.deepEqual(codes({ ...ops, scripts: { test: 'vitest run' } }), ['PROJECT_NOT_RUN']);
  });

  it('passes on the unreadable form of a configuration as a problem of its own', () => {
    const found = codes({ ...api, vitestConfig: `${API_CONFIG}\nexclude: ['src/skipped/**']` });
    assert.deepEqual(found, ['CONFIG_UNREADABLE']);
  });
});

describe('this repository', () => {
  const facts = readPackageFacts(root);
  const named = (directory: string): PackageFacts => {
    const found = facts.find((candidate) => candidate.directory === directory);
    assert.ok(found !== undefined, `${directory} is not a workspace package`);
    return found;
  };

  // Never write a check that passes when it has nothing to check.
  it('has the packages and the tests this check is about', () => {
    assert.deepEqual(workspaceDirectories(root), [
      'apps/api',
      'apps/ops-web',
      'e2e',
      'packages/api-client',
    ]);
    for (const directory of workspaceDirectories(root)) {
      assert.ok(named(directory).testFiles.length > 0, `${directory} has no test files`);
    }
    assert.ok(named('apps/ops-web').testFiles.some((file) => file.endsWith('.spec.ts')));
    assert.ok(named('e2e').testFiles.some((file) => file.startsWith('tests/')));
    assert.ok(listTestFiles(resolve(root, 'scripts')).length >= 10);
    assert.ok(named('apps/api').testFiles.length > 20);
  });

  it('runs every test file by some runner, and names every root test in test:root', () => {
    assert.deepEqual(findInventoryProblems(root), []);
  });

  it('names this file itself in test:root', () => {
    const script = rootScripts()['test:root'] ?? '';
    assert.ok(script.split(/\s+/).includes('scripts/test-inventory.test.ts'));
  });

  // Break caught: the guard passing because it looks at the wrong thing: a stray file in each place is found.
  it('finds a stray test file in each kind of place', () => {
    const stray = (directory: string, file: string): string[] =>
      findPackageProblems({
        ...named(directory),
        testFiles: [...named(directory).testFiles, file],
      }).map((problem) => problem.code);
    assert.deepEqual(stray('apps/api', 'scripts/stray.test.ts'), ['TEST_NOT_RUN']);
    assert.deepEqual(stray('apps/ops-web', 'test/browser/stray.spec.ts'), ['TEST_NOT_RUN']);
    assert.deepEqual(stray('apps/ops-web', 'src/stray.spec.ts'), ['TEST_NOT_RUN']);
    assert.deepEqual(stray('packages/api-client', 'test/stray.test.ts'), ['TEST_NOT_RUN']);
    assert.deepEqual(stray('e2e', 'src/stray.test.ts'), ['TEST_NOT_RUN']);
    assert.deepEqual(stray('e2e', 'harness/stray.spec.ts'), ['TEST_NOT_RUN']);
  });

  it('finds a root test that test:root does not name', () => {
    const script = rootScripts()['test:root'];
    const found = findRootTestProblems(
      [
        ...listTestFiles(resolve(root, 'scripts')).map((file) => `scripts/${file}`),
        'scripts/new.test.ts',
      ],
      script,
      () => true,
    );
    assert.deepEqual(
      found.map((problem) => problem.code),
      ['ROOT_TEST_NOT_LISTED'],
    );
  });
});
