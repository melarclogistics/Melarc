import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';

import { ESLint } from 'eslint';
import { parse } from 'yaml';

/**
 * Every file ESLint reads is read by some lint run (run 5, Stage 1.5). Lint is one task for each workspace through turbo, and the files of the repository's own root
 * (`scripts/`, the configuration, a fixture of the verifier) are linted by `lint:root`: a workspace whose package has no `lint` script, or a new folder of code that
 * is neither a workspace nor named by `lint:root`, would be linted by nothing, and the precheck, the gate and CI would all say "lint passed". These hold the layout to
 * that: each workspace lints the whole of itself, the root names its own folders, and every TypeScript or JavaScript file Git tracks is under one of them.
 *
 * **And ESLint says so itself** (run 6, Stage 1.4). The layout is read from package scripts and folder prefixes, which cannot see that `eslint.config.mjs` ignores a folder
 * (it counted `packages/api-client/src/generated/` as read, and a folder added to `globalIgnores` would have been read by nothing while every lint stage passed). So each
 * tracked file is also put to ESLint's own API: `isPathIgnored` must be false, and the configuration it computes for the file (`calculateConfigForFile`) must exist and have
 * a rule on. What ESLint ignores on purpose is named, with its reason, in `IGNORED_ON_PURPOSE`, and that list must be true: an entry whose files ESLint reads, or which holds
 * none, fails too.
 */
const root = resolve(import.meta.dirname, '..');
const created: string[] = [];
after(() => {
  for (const directory of created) rmSync(directory, { recursive: true, force: true });
});

/** The files ESLint reads here: TypeScript and JavaScript. */
const LINTABLE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

interface PackageJson {
  readonly scripts?: Readonly<Record<string, string>>;
}

const readJson = (path: string): PackageJson =>
  JSON.parse(readFileSync(path, 'utf8')) as PackageJson;

/** The folders of the workspace, as `pnpm-workspace.yaml` lists them (`apps/*`, `packages/*`, `e2e`) that hold a package. */
function workspacesOf(base: string): string[] {
  const text = readFileSync(join(base, 'pnpm-workspace.yaml'), 'utf8');
  const listed = (parse(text) as { packages?: unknown }).packages;
  assert.ok(Array.isArray(listed), 'pnpm-workspace.yaml lists its packages');
  const folders: string[] = [];
  for (const pattern of listed as string[]) {
    if (pattern.endsWith('/*')) {
      const parent = pattern.slice(0, -2);
      for (const entry of readdirSync(join(base, parent), { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith('.'))
          folders.push(`${parent}/${entry.name}`);
      }
    } else folders.push(pattern);
  }
  return folders.filter((folder) => existsPackage(base, folder)).toSorted();
}

function existsPackage(base: string, folder: string): boolean {
  try {
    readFileSync(join(base, folder, 'package.json'));
    return true;
  } catch {
    return false;
  }
}

/** What an ESLint command line names to lint: the words after `eslint.js` up to the first option. Undefined when the script does not run ESLint. */
function targetsOf(script: string | undefined): string[] | undefined {
  const words = (script ?? '').split(/\s+/);
  const at = words.findIndex((word) => /(?:^|\/)eslint(?:\.js)?$/.test(word));
  if (at < 0) return undefined;
  const targets: string[] = [];
  for (const word of words.slice(at + 1)) {
    if (word.startsWith('--')) break;
    targets.push(word);
  }
  return targets;
}

/** What is wrong with the layout of a repository rooted at `base` whose tracked files are `files`: empty when every file is linted by some run. */
function lintCoverageProblems(base: string, files: readonly string[]): string[] {
  const problems: string[] = [];
  const covered: string[] = [];
  for (const folder of workspacesOf(base)) {
    const lint = readJson(join(base, folder, 'package.json')).scripts?.lint;
    const targets = targetsOf(lint);
    if (targets === undefined) {
      problems.push(`${folder} has no lint script that runs ESLint, so no lint run reads it`);
    } else if (targets.length !== 1 || targets[0] !== '.') {
      problems.push(
        `${folder}: its lint script names ${targets.join(' ') || 'nothing'} and not "." (the whole of the workspace)`,
      );
    } else covered.push(folder);
  }
  const scripts = readJson(join(base, 'package.json')).scripts ?? {};
  if (!/\bturbo run lint\b/.test(scripts.lint ?? '')) {
    problems.push('the root lint script does not run "turbo run lint", which lints each workspace');
  }
  if (!/\bpnpm run lint:root\b/.test(scripts.lint ?? '')) {
    problems.push('the root lint script does not run lint:root, which lints the root folders');
  }
  const rootTargets = targetsOf(scripts['lint:root']);
  if (rootTargets === undefined || rootTargets.length === 0) {
    problems.push('lint:root does not run ESLint over any folder');
  } else covered.push(...rootTargets);

  const outside = files
    .filter((file) => LINTABLE.test(file))
    .filter((file) => !covered.some((place) => file === place || file.startsWith(`${place}/`)));
  for (const file of outside) {
    problems.push(
      `${file} is read by no lint run: it is in no workspace that lints itself and not under a folder lint:root names`,
    );
  }
  return problems;
}

/**
 * What ESLint is told to ignore on purpose, by folder, and why: the one fact the layout check could not see. A folder added to `globalIgnores` in `eslint.config.mjs` is not
 * here, so it fails `eslintProblems`; one removed from the configuration while it is here fails it too.
 */
const IGNORED_ON_PURPOSE: Readonly<Record<string, string>> = {
  'packages/api-client/src/generated/':
    'machine output of the generator, held to the contract by `api-client:check` (that it is current) and not to a style',
};

/** Whether a computed configuration has a rule that is on (a severity of warn or error, as ESLint writes it: `[2]`, `[1, options]`, or the bare value). */
function hasRuleOn(config: { readonly rules?: Readonly<Record<string, unknown>> }): boolean {
  return Object.values(config.rules ?? {}).some((value) => {
    const severity: unknown = Array.isArray(value) ? (value as unknown[])[0] : value;
    return severity === 1 || severity === 2 || severity === 'warn' || severity === 'error';
  });
}

/**
 * What ESLint itself says of each lintable file of a repository rooted at `base` (run 6, Stage 1.4): that it is not ignored (by a global ignore, or because no
 * configuration matches it), that the configuration computed for it has a rule on, and that what is ignored is exactly `onPurpose`, folder by folder.
 */
async function eslintProblems(
  base: string,
  files: readonly string[],
  onPurpose: readonly string[],
): Promise<string[]> {
  const eslint = new ESLint({ cwd: base });
  const problems: string[] = [];
  const ignoredBy = new Map<string, { read: number; ignored: number }>(
    onPurpose.map((folder) => [folder, { read: 0, ignored: 0 }]),
  );
  for (const file of files.filter((candidate) => LINTABLE.test(candidate))) {
    const folder = onPurpose.find((place) => file.startsWith(place));
    const ignored = await eslint.isPathIgnored(file);
    if (folder !== undefined) {
      const count = ignoredBy.get(folder);
      if (count !== undefined) {
        if (ignored) count.ignored += 1;
        else count.read += 1;
      }
      continue;
    }
    if (ignored) {
      problems.push(
        `${file} is ignored by ESLint's own configuration (a global ignore, or no configuration matches it), so no lint run reads it: take the ignore out, or name the folder in IGNORED_ON_PURPOSE with the reason`,
      );
      continue;
    }
    const config = (await eslint.calculateConfigForFile(file)) as
      { readonly rules?: Readonly<Record<string, unknown>> } | undefined;
    if (config === undefined) {
      problems.push(`ESLint computes no configuration for ${file}, so no lint run reads it`);
    } else if (!hasRuleOn(config)) {
      problems.push(
        `The configuration ESLint computes for ${file} has no rule on, so a lint run reads it for nothing`,
      );
    }
  }
  for (const [folder, count] of ignoredBy) {
    if (count.ignored === 0 && count.read === 0) {
      problems.push(
        `${folder} is named in IGNORED_ON_PURPOSE and holds no tracked file to ignore: take it out of the list`,
      );
    } else if (count.read > 0) {
      problems.push(
        `${folder} is named in IGNORED_ON_PURPOSE, but ESLint reads ${String(count.read)} of its files: take it out of the list, or ignore it in eslint.config.mjs`,
      );
    }
  }
  return problems;
}

function gitFiles(base: string): string[] {
  return execFileSync('git', ['ls-files', '-z'], {
    cwd: base,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter((file) => file !== '');
}

describe('this repository', () => {
  const files = gitFiles(root);

  // Break caught: a workspace added with no lint script, or one that lints only part of itself, or a folder of code beside the workspaces that nothing lints. Each
  // would pass every lint stage with its files unread.
  it('has every TypeScript and JavaScript file under a lint run', () => {
    assert.deepEqual(lintCoverageProblems(root, files), []);
  });

  // Break caught (run 6, Stage 1.4): a folder added to `globalIgnores` in eslint.config.mjs (or a configuration that no longer matches a kind of file, or one that turns every rule
  // off for a folder). The layout above cannot see it: the folder is under a workspace that lints itself, and ESLint reads nothing in it, so every lint stage passes. ESLint's
  // own API is asked of every tracked file.
  it('has every TypeScript and JavaScript file read by ESLint itself, but for the folders it ignores on purpose', async () => {
    assert.deepEqual(await eslintProblems(root, files, Object.keys(IGNORED_ON_PURPOSE)), []);
  });

  // A check over nothing passes: the repository has these workspaces and this many files to read.
  it('reads the workspaces and the files it judges', () => {
    const workspaces = workspacesOf(root);
    for (const expected of ['apps/api', 'apps/ops-web', 'e2e', 'packages/api-client']) {
      assert.ok(workspaces.includes(expected), `${expected} is a workspace`);
    }
    assert.ok(files.filter((file) => LINTABLE.test(file)).length > 1_000);
    assert.deepEqual(
      targetsOf(readJson(join(root, 'package.json')).scripts?.['lint:root']),
      ['scripts', 'eslint.config.mjs', 'apps/attestation-verifier/fixtures'],
      'the root files that lint:root names',
    );
    // The one folder ESLint ignores on purpose is a tracked folder with files in it, so that the list is judged against something.
    assert.deepEqual(Object.keys(IGNORED_ON_PURPOSE), ['packages/api-client/src/generated/']);
    assert.ok(
      files.some(
        (file) => file.startsWith('packages/api-client/src/generated/') && LINTABLE.test(file),
      ),
    );
  });
});

describe('the check itself', () => {
  /** A repository on disk with the workspaces and root scripts given, for the layout to be judged. */
  function repository(options: {
    readonly workspaces: Readonly<Record<string, string | undefined>>;
    readonly rootScripts?: Readonly<Record<string, string>>;
  }): string {
    const base = mkdtempSync(join(tmpdir(), 'melarc-lint-coverage-'));
    created.push(base);
    const write = (path: string, text: string): void => {
      mkdirSync(dirname(join(base, path)), { recursive: true });
      writeFileSync(join(base, path), text);
    };
    write('pnpm-workspace.yaml', 'packages:\n  - apps/*\n  - e2e\n');
    write(
      'package.json',
      JSON.stringify({
        scripts: options.rootScripts ?? {
          lint: 'turbo run lint --concurrency=1 && pnpm run lint:root',
          'lint:root': 'node ./node_modules/eslint/bin/eslint.js scripts --max-warnings 0',
        },
      }),
    );
    for (const [folder, lint] of Object.entries(options.workspaces)) {
      write(
        `${folder}/package.json`,
        JSON.stringify({ scripts: lint === undefined ? {} : { lint } }),
      );
    }
    return base;
  }
  const ESLINT_ALL = 'node ../../node_modules/eslint/bin/eslint.js . --max-warnings 0';

  // Break caught: a check that says "covered" whatever the layout is. Each of these must be reported, and the layout that is right must not.
  it('accepts a layout in which every file is linted', () => {
    const base = repository({ workspaces: { 'apps/api': ESLINT_ALL, e2e: ESLINT_ALL } });

    assert.deepEqual(
      lintCoverageProblems(base, ['apps/api/src/a.ts', 'e2e/b.mjs', 'scripts/c.ts', 'README.md']),
      [],
    );
  });

  it('reports a workspace without a lint script, and one that lints only part of itself', () => {
    const base = repository({
      workspaces: {
        'apps/api': ESLINT_ALL,
        'apps/web': undefined,
        'apps/part': 'node ../../node_modules/eslint/bin/eslint.js src --max-warnings 0',
        e2e: 'vitest run',
      },
    });

    const problems = lintCoverageProblems(base, []);

    assert.match(problems.join('\n'), /apps\/web has no lint script that runs ESLint/);
    assert.match(problems.join('\n'), /apps\/part: its lint script names src and not "\."/);
    assert.match(problems.join('\n'), /e2e has no lint script that runs ESLint/);
    assert.equal(problems.length, 3);
  });

  it('reports a file in a folder that is no workspace and that lint:root does not name', () => {
    const base = repository({ workspaces: { 'apps/api': ESLINT_ALL } });

    const problems = lintCoverageProblems(base, [
      'apps/api/src/a.ts',
      'scripts/b.ts',
      'tools/c.ts',
      'design/d.mjs',
      'design/e.css',
    ]);

    assert.deepEqual(problems, [
      'tools/c.ts is read by no lint run: it is in no workspace that lints itself and not under a folder lint:root names',
      'design/d.mjs is read by no lint run: it is in no workspace that lints itself and not under a folder lint:root names',
    ]);
  });

  it('reports a root that no longer runs the workspaces’ lint or its own', () => {
    const base = repository({
      workspaces: { 'apps/api': ESLINT_ALL },
      rootScripts: { lint: 'echo lint', 'lint:root': 'echo root' },
    });

    const problems = lintCoverageProblems(base, ['scripts/a.ts']);

    assert.match(problems.join('\n'), /does not run "turbo run lint"/);
    assert.match(problems.join('\n'), /does not run lint:root/);
    assert.match(problems.join('\n'), /lint:root does not run ESLint over any folder/);
    assert.match(problems.join('\n'), /scripts\/a\.ts is read by no lint run/);
  });
});

describe('the check itself, against ESLint', () => {
  /** A repository on disk with the flat configuration given, for ESLint to judge. It needs no dependency: a configuration is an array. */
  function configured(config: string): string {
    const base = mkdtempSync(join(tmpdir(), 'melarc-lint-eslint-'));
    created.push(base);
    writeFileSync(join(base, 'eslint.config.mjs'), config);
    return base;
  }
  const RULE = "{ files: ['**/*.ts'], rules: { 'no-undef': 'error' } }";

  // Break caught: a check that says "read" whatever ESLint says.
  it('accepts files that ESLint reads, with a rule on', async () => {
    const base = configured(`export default [${RULE}];`);

    assert.deepEqual(await eslintProblems(base, ['src/a.ts', 'src/b.ts', 'README.md'], []), []);
  });

  // Break caught (run 6, Stage 1.4): a folder added to `globalIgnores`, the very thing the layout check could not see.
  it('reports a folder that a global ignore names, with the file and what to do', async () => {
    const base = configured(`export default [{ ignores: ['generated/'] }, ${RULE}];`);

    const problems = await eslintProblems(base, ['src/a.ts', 'generated/b.ts'], []);

    assert.equal(problems.length, 1, problems.join('\n'));
    assert.match(problems[0] ?? '', /^generated\/b\.ts is ignored by ESLint's own configuration/);
    assert.match(problems[0] ?? '', /IGNORED_ON_PURPOSE/);
  });

  // Break caught: a kind of file that no configuration matches any more (ESLint then reads nothing in it, and only warns when it is named).
  it('reports a file that no configuration matches', async () => {
    const base = configured(`export default [${RULE}];`);

    const problems = await eslintProblems(base, ['src/a.ts', 'src/view.jsx'], []);

    assert.equal(problems.length, 1, problems.join('\n'));
    assert.match(problems[0] ?? '', /src\/view\.jsx/);
  });

  // Break caught: a configuration that matches a folder and turns every rule off for it, so that a lint run reads it for nothing.
  it('reports a file whose computed configuration has no rule on', async () => {
    const base = configured(
      `export default [${RULE}, { files: ['quiet/**'], rules: { 'no-undef': 'off' } }];`,
    );

    const problems = await eslintProblems(base, ['src/a.ts', 'quiet/c.ts'], []);

    assert.equal(problems.length, 1, problems.join('\n'));
    assert.match(
      problems[0] ?? '',
      /configuration ESLint computes for quiet\/c\.ts has no rule on/,
    );
  });

  // The folders named as ignored on purpose are accepted when ESLint ignores them, and the list is held to the truth in both directions.
  it('accepts a folder that is ignored on purpose, and reports an entry that is not true', async () => {
    const base = configured(`export default [{ ignores: ['generated/'] }, ${RULE}];`);
    const files = ['src/a.ts', 'generated/b.ts'];

    assert.deepEqual(await eslintProblems(base, files, ['generated/']), []);

    const reads = await eslintProblems(base, files, ['generated/', 'src/']);
    assert.deepEqual(reads, [
      'src/ is named in IGNORED_ON_PURPOSE, but ESLint reads 1 of its files: take it out of the list, or ignore it in eslint.config.mjs',
    ]);

    const empty = await eslintProblems(base, files, ['generated/', 'gone/']);
    assert.deepEqual(empty, [
      'gone/ is named in IGNORED_ON_PURPOSE and holds no tracked file to ignore: take it out of the list',
    ]);
  });
});
