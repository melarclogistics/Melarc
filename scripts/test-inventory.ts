/**
 * Holds the repository to its own tests: a test file that no runner picks up is worse than no test, because it
 * reads as a guarantee and proves nothing. This reads the files and the runner configurations as text and fails
 * when:
 *
 *   - a `scripts/*.test.ts` file is not named by `test:root` (`node --test` runs only the files it is given and
 *     passes on zero tests), or `test:root` names a file that is not there, or names one twice;
 *   - a test file of a workspace package is matched by no `include` of its Vitest configuration and by no
 *     `testMatch` of its Playwright configuration (the Ops Portal's browser tests run only the specs its
 *     projects name);
 *   - a configuration is written in a form this reads wrongly (an `exclude`, an `include` or `testMatch` that is
 *     not a list of string literals): it says so, instead of assuming nothing is excluded;
 *   - an `include` or `testMatch` pattern matches no file, so the project it belongs to runs nothing;
 *   - a Vitest project or a Playwright configuration is run by no script that CI runs.
 *
 * It does not run a test and starts nothing. Each rule is a pure function of the facts it is given, so the test
 * can show that it fails.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';

import { parse } from 'yaml';

import { isRecord } from './workflow-shapes.ts';

export type InventoryProblemCode =
  | 'ROOT_TEST_NOT_LISTED'
  | 'ROOT_TEST_MISSING'
  | 'ROOT_TEST_DUPLICATE'
  | 'ROOT_SCRIPT_UNREADABLE'
  | 'TEST_NOT_RUN'
  | 'CONFIG_UNREADABLE'
  | 'PATTERN_MATCHES_NOTHING'
  | 'PROJECT_NOT_RUN';

export interface InventoryProblem {
  code: InventoryProblemCode;
  message: string;
}

/** A file that is a test by its name, for Vitest, Playwright and `node --test` alike. */
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
/** Playwright's own default, used by a configuration that gives no `testMatch`. */
const PLAYWRIGHT_DEFAULT = TEST_FILE;

/** Folders that hold installed, generated or machine-local files, never tests that someone is meant to run. */
const SKIPPED_FOLDERS: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'tmp',
  'temp',
  'test-results',
  'playwright-report',
  'blob-report',
]);

const posix = (path: string): string => path.split(sep).join('/');
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A glob as the Vitest and Playwright configurations write it, as a pattern for a whole relative path: `**` and
 * `**` followed by a slash match any run of folders (none included), `*` anything but a slash, `?` one such
 * character, `{a,b}` alternatives. Nothing else is special.
 */
export function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob.charAt(index);
    if (glob.startsWith('**/', index)) {
      source += '(?:.*/)?';
      index += 2;
    } else if (glob.startsWith('**', index)) {
      source += '.*';
      index += 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else if (char === '{' && glob.includes('}', index)) {
      const end = glob.indexOf('}', index);
      source += `(?:${glob
        .slice(index + 1, end)
        .split(',')
        .map(escapeRegExp)
        .join('|')})`;
      index = end;
    } else {
      source += escapeRegExp(char);
    }
  }
  return new RegExp(`^${source}$`);
}

/** The test files under `directory`, as paths relative to it with forward slashes, sorted. */
export function listTestFiles(directory: string): string[] {
  const found: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || SKIPPED_FOLDERS.has(entry.name)) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (TEST_FILE.test(entry.name)) found.push(posix(path.slice(directory.length + 1)));
    }
  };
  visit(directory);
  return found.sort();
}

// ---------------------------------------------------------------------------------------------------------------
// The root tests: `node --test` runs only the files it is given

/** The files `test:root` names, which must be `node --test` followed by files only. */
function namedByRootScript(script: string): string[] | undefined {
  const words = script.trim().split(/\s+/);
  if (words[0] !== 'node' || words[1] !== '--test') return undefined;
  const files = words.slice(2);
  return files.length > 0 && files.every((file) => !file.startsWith('-')) ? files : undefined;
}

/**
 * `testFiles` are the paths (relative to the repository root) of the tests that must run under `test:root`:
 * the ones under `scripts/`. `exists` says whether a named path is a file.
 */
export function findRootTestProblems(
  testFiles: readonly string[],
  testRootScript: string | undefined,
  exists: (path: string) => boolean,
): InventoryProblem[] {
  const named = testRootScript === undefined ? undefined : namedByRootScript(testRootScript);
  if (named === undefined) {
    return [
      {
        code: 'ROOT_SCRIPT_UNREADABLE',
        message:
          'The root package.json needs a "test:root" script of the form "node --test <file> <file> ...", naming every root test file.',
      },
    ];
  }
  const problems: InventoryProblem[] = [];
  for (const file of testFiles.filter((candidate) => !named.includes(candidate))) {
    problems.push({
      code: 'ROOT_TEST_NOT_LISTED',
      message: `${file} is not named by "test:root" in package.json, so "pnpm test" never runs it.`,
    });
  }
  for (const file of named.filter((candidate, index) => named.indexOf(candidate) !== index)) {
    problems.push({
      code: 'ROOT_TEST_DUPLICATE',
      message: `"test:root" names ${file} more than once.`,
    });
  }
  for (const file of new Set(named)) {
    if (!exists(file)) {
      problems.push({
        code: 'ROOT_TEST_MISSING',
        message: `"test:root" names ${file}, which is not a file.`,
      });
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------
// The runners of a workspace package

export interface VitestFacts {
  /** Every pattern of every `include` list, relative to the package. */
  includes: string[];
  /** The names of the projects the configuration declares; none when it declares no project. */
  projects: string[];
  /** Why the configuration cannot be read; empty when it can. */
  unreadable: string[];
}

const STRING_LITERAL = /(['"])((?:(?!\1).)*)\1/g;

const stringLiterals = (text: string): string[] =>
  [...text.matchAll(STRING_LITERAL)].map((match) => match[2] ?? '');

/** What a Vitest configuration says about which files it runs, read from its text. */
export function readVitestConfig(text: string): VitestFacts {
  const lists = [...text.matchAll(/\binclude\s*:\s*\[([^\]]*)\]/g)];
  const keys = [...text.matchAll(/\binclude\s*:/g)];
  const unreadable: string[] = [];
  if (keys.length !== lists.length) {
    unreadable.push('an include that is not a list of string literals');
  }
  if (/\bexclude\s*:/.test(text)) {
    unreadable.push('an exclude, which this check does not model');
  }
  return {
    includes: lists.flatMap((list) => stringLiterals(list[1] ?? '')),
    projects: [...text.matchAll(/\bname\s*:\s*(['"])((?:(?!\1).)*)\1/g)].map(
      (match) => match[2] ?? '',
    ),
    unreadable,
  };
}

export interface PlaywrightFacts {
  /** The folder the specs are looked for in, relative to the package, without a leading `./`. */
  testDir: string | undefined;
  /** Every `testMatch` pattern; none when the configuration keeps Playwright's default. */
  testMatch: string[];
  unreadable: string[];
}

/** What a Playwright configuration says about which specs it runs, read from its text. */
export function readPlaywrightConfig(text: string): PlaywrightFacts {
  const unreadable: string[] = [];
  const dirs = [...text.matchAll(/\btestDir\s*:\s*(['"])((?:(?!\1).)*)\1/g)];
  if (dirs.length !== 1 || [...text.matchAll(/\btestDir\s*:/g)].length !== 1) {
    unreadable.push('anything but one testDir given as a string literal');
  }
  const matches = [...text.matchAll(/\btestMatch\s*:\s*(['"])((?:(?!\1).)*)\1/g)];
  if ([...text.matchAll(/\btestMatch\s*:/g)].length !== matches.length) {
    unreadable.push('a testMatch that is not a string literal');
  }
  if (/\btestIgnore\s*:/.test(text)) {
    unreadable.push('a testIgnore, which this check does not model');
  }
  return {
    testDir: (dirs[0]?.[2] ?? '').replace(/^\.\//, '').replace(/\/$/, ''),
    testMatch: matches.map((match) => match[2] ?? ''),
    unreadable,
  };
}

/** Whether Playwright would run `file` (relative to the package) under these facts. */
export function playwrightRuns(facts: PlaywrightFacts, file: string): boolean {
  const dir = facts.testDir ?? '';
  const prefix = dir === '' ? '' : `${dir}/`;
  if (!file.startsWith(prefix)) return false;
  const inside = file.slice(prefix.length);
  if (facts.testMatch.length === 0) return PLAYWRIGHT_DEFAULT.test(inside);
  // A pattern without a slash is matched against the file's name wherever it sits under the test folder.
  return facts.testMatch.some((pattern) =>
    globToRegExp(pattern).test(pattern.includes('/') ? inside : (inside.split('/').at(-1) ?? '')),
  );
}

export interface PackageFacts {
  /** The folder of the package from the repository root, such as `apps/ops-web`. */
  directory: string;
  /** Its test files, relative to it. */
  testFiles: readonly string[];
  /** The `scripts` of its package.json. */
  scripts: Readonly<Record<string, string>>;
  vitestConfig?: string;
  playwrightConfig?: string;
}

/** The scripts of a package that CI runs for tests (`pnpm run test` and `pnpm run test:db` run them through turbo). */
const CI_TEST_SCRIPTS = ['test', 'test:db'];
/** What a configuration without named projects is called in a message. */
const ONLY_PROJECT = '(the only project)';

/** The Vitest projects that some script CI runs would start. */
function projectsRun(
  scripts: Readonly<Record<string, string>>,
  names: readonly string[],
): string[] {
  const commands = CI_TEST_SCRIPTS.map((name) => scripts[name] ?? '').filter((command) =>
    /\bvitest\b/.test(command),
  );
  if (commands.some((command) => !/--project\b/.test(command))) return [...names];
  const chosen = new Set(
    commands.flatMap((command) =>
      [...command.matchAll(/--project[ =](\S+)/g)].map((match) => match[1] ?? ''),
    ),
  );
  return names.filter((name) => chosen.has(name));
}

/** Every way a package's tests can fail to run, found from its files, its runner configurations and its scripts. */
export function findPackageProblems(facts: PackageFacts): InventoryProblem[] {
  const { directory, testFiles, scripts } = facts;
  const problems: InventoryProblem[] = [];
  const vitest =
    facts.vitestConfig === undefined ? undefined : readVitestConfig(facts.vitestConfig);
  const playwright =
    facts.playwrightConfig === undefined ? undefined : readPlaywrightConfig(facts.playwrightConfig);

  for (const [runner, config] of [
    ['Vitest', vitest],
    ['Playwright', playwright],
  ] as const) {
    for (const reason of config?.unreadable ?? []) {
      problems.push({
        code: 'CONFIG_UNREADABLE',
        message: `The ${runner} configuration of ${directory} has ${reason}: teach scripts/test-inventory.ts to read it, or write it as a list of string literals.`,
      });
    }
  }

  const includes = (vitest?.includes ?? []).map((pattern) => ({
    pattern,
    expression: globToRegExp(pattern),
  }));
  for (const file of testFiles) {
    const runs =
      includes.some(({ expression }) => expression.test(file)) ||
      (playwright !== undefined && playwrightRuns(playwright, file));
    if (!runs) {
      problems.push({
        code: 'TEST_NOT_RUN',
        message: `${directory}/${file} is matched by no include of the Vitest configuration and no testMatch of the Playwright configuration of ${directory}, so no runner picks it up.`,
      });
    }
  }

  for (const { pattern, expression } of includes) {
    if (!testFiles.some((file) => expression.test(file))) {
      problems.push({
        code: 'PATTERN_MATCHES_NOTHING',
        message: `The Vitest include "${pattern}" of ${directory} matches no test file, so the project it belongs to runs nothing.`,
      });
    }
  }
  if (playwright !== undefined) {
    for (const pattern of playwright.testMatch) {
      const alone: PlaywrightFacts = { ...playwright, testMatch: [pattern] };
      if (!testFiles.some((file) => playwrightRuns(alone, file))) {
        problems.push({
          code: 'PATTERN_MATCHES_NOTHING',
          message: `The Playwright testMatch "${pattern}" of ${directory} matches no spec file, so the project it belongs to runs nothing.`,
        });
      }
    }
  }

  if (vitest !== undefined) {
    const names = vitest.projects.length === 0 ? [ONLY_PROJECT] : vitest.projects;
    const started = projectsRun(scripts, names);
    for (const name of names.filter((project) => !started.includes(project))) {
      problems.push({
        code: 'PROJECT_NOT_RUN',
        message: `The Vitest project ${name} of ${directory} is started by none of the scripts ${CI_TEST_SCRIPTS.join(' and ')} of its package.json, which are what CI runs.`,
      });
    }
  }
  if (playwright !== undefined) {
    const browser = Object.entries(scripts).some(
      ([name, command]) => name.startsWith('test:') && /\bplaywright test\b/.test(command),
    );
    if (!browser) {
      problems.push({
        code: 'PROJECT_NOT_RUN',
        message: `${directory} has a Playwright configuration but no "test:*" script that runs "playwright test".`,
      });
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------
// The repository

/** The folders of the workspace packages named by pnpm-workspace.yaml (`apps/*`, `packages/*`, `e2e`). */
export function workspaceDirectories(root: string): string[] {
  const workspace: unknown = parse(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8'));
  const patterns: unknown = isRecord(workspace) ? workspace.packages : undefined;
  if (!Array.isArray(patterns)) return [];
  return patterns
    .filter((pattern): pattern is string => typeof pattern === 'string')
    .flatMap((pattern) => {
      if (!pattern.endsWith('/*'))
        return existsSync(join(root, pattern, 'package.json')) ? [pattern] : [];
      const parent = pattern.slice(0, -2);
      return readdirSync(join(root, parent), { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isDirectory() && existsSync(join(root, parent, entry.name, 'package.json')),
        )
        .map((entry) => `${parent}/${entry.name}`);
    })
    .sort();
}

function scriptsOf(packageJson: string): Record<string, string> {
  const parsed: unknown = JSON.parse(packageJson);
  const scripts = isRecord(parsed) ? parsed.scripts : undefined;
  return Object.fromEntries(
    Object.entries(isRecord(scripts) ? scripts : {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

function readIfThere(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

/** The facts of each workspace package, read from the repository at `root`. */
export function readPackageFacts(root: string): PackageFacts[] {
  return workspaceDirectories(root).map((directory) => {
    const folder = join(root, directory);
    const facts: PackageFacts = {
      directory,
      testFiles: listTestFiles(folder),
      scripts: scriptsOf(readFileSync(join(folder, 'package.json'), 'utf8')),
    };
    const vitestConfig = readIfThere(join(folder, 'vitest.config.ts'));
    const playwrightConfig = readIfThere(join(folder, 'playwright.config.ts'));
    return {
      ...facts,
      ...(vitestConfig === undefined ? {} : { vitestConfig }),
      ...(playwrightConfig === undefined ? {} : { playwrightConfig }),
    };
  });
}

/** Every inventory problem of the repository at `root`. */
export function findInventoryProblems(root: string): InventoryProblem[] {
  const scripts = scriptsOf(readFileSync(join(root, 'package.json'), 'utf8'));
  const rootTests = listTestFiles(join(root, 'scripts')).map((file) => `scripts/${file}`);
  return [
    ...findRootTestProblems(rootTests, scripts['test:root'], (path) =>
      existsSync(join(root, path)),
    ),
    ...readPackageFacts(root).flatMap(findPackageProblems),
  ];
}
