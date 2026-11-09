import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';

import { parse } from 'yaml';

/**
 * Every file ESLint reads is read by some lint run (run 5, Stage 1.5). Lint is one task for each workspace through turbo, and the files of the repository's own root
 * (`scripts/`, the configuration, a fixture of the verifier) are linted by `lint:root`: a workspace whose package has no `lint` script, or a new folder of code that
 * is neither a workspace nor named by `lint:root`, would be linted by nothing, and the precheck, the gate and CI would all say "lint passed". These hold the layout to
 * that: each workspace lints the whole of itself, the root names its own folders, and every TypeScript or JavaScript file Git tracks is under one of them.
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
