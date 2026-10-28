/**
 * The citation inventory of SLICE-000 (S0.67): every acceptance criterion the slice owns is cited by at least one test that runs. It
 * reads the criteria from their headings in the five feature files the slice builds (`features/identity/*.md`, `### \`AC-SLICE-000-nn\``)
 * and the citations from the repository's test files, and fails when:
 *
 *   - a criterion is cited by no test (`UNCITED`);
 *   - every test that cites it is skipped outright (`it.skip`, `describe.skip`, `test.skip(title, body)`, `.todo`, `.fixme`, `xit`):
 *     a skipped test reads as a guarantee and proves nothing (`ONLY_SKIPPED`);
 *   - a test cites a criterion that no feature file defines (`UNKNOWN`), which is a typo or a criterion that moved out of the slice.
 *
 * A test that runs only somewhere (`skipIf`, `runIf`, Playwright's `test.skip(condition, reason)`) is a declared condition, not a hidden
 * skip: its citation counts, and a criterion cited by such tests alone is reported with the conditions, so a reader sees where its
 * evidence runs. Whether a test file is run at all is `test-inventory.ts`'s rule, which this one relies on.
 *
 * **What a citation is.** The full identifier anywhere in a test file (a title, a comment, a string), and the abbreviated identifiers
 * that continue it, as the tests write them: `AC-SLICE-000-92, -94 and -126`, `` `AC-SLICE-000-17`, `-22` ``, and the ranges
 * `AC-SLICE-000-60 to -66` (the two ends, and nothing between them: the criteria between are named one by one, or they are not cited),
 * across a comment's line breaks. A citation belongs to the
 * innermost test or suite whose text holds it, the comment block directly above it included. **A citation that no test or suite holds**
 * (a file's header, set apart from the tests by a blank line) belongs to the file, and runs as the best of the file's tests runs: a
 * header over tests that are all skipped is no evidence, one over tests that run only somewhere is conditional, and one over a file with
 * no test at all is skipped. This is an inventory only: whether a test proves what it cites is reviewed in each task's handoff.
 *
 * **Which files are tests.** A file whose name says so (`*.test.ts`, `*.spec.ts`, and their variants), and the journeys of the integrated
 * harness (`e2e/harness/journeys/`), which the journey specs register and run one by one (e2e/CLAUDE.md). A journey module counts only
 * when a spec reaches it by its imports, directly or through another journey module: one that nothing registers runs nothing. (An
 * exported journey that the registered list leaves out is not seen by this inventory; the list itself is read in review.)
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import ts from 'typescript';

export type CitationProblemCode = 'UNCITED' | 'ONLY_SKIPPED' | 'UNKNOWN';

export interface CitationProblem {
  readonly code: CitationProblemCode;
  readonly criterion: string;
  readonly message: string;
}

/** How a citation's test runs: always, only where a condition holds, or never. */
export type Standing = 'RUNS' | 'CONDITIONAL' | 'SKIPPED';

export interface Citation {
  readonly criterion: string;
  readonly file: string;
  readonly standing: Standing;
  /** The condition's text, for a conditional citation. */
  readonly condition?: string;
}

const FEATURES = [
  'staff-authentication',
  'rider-authentication',
  'vendor-authentication',
  'credential-recovery',
  'permission-enforcement',
];
const HEADING = /^### `(AC-SLICE-000-\d{2,3})`/gm;

/** The criteria the slice owns, in the order their files state them. */
export function readCriteria(texts: readonly string[]): string[] {
  return texts.flatMap((text) => [...text.matchAll(HEADING)].map((match) => match[1] ?? ''));
}

const idOf = (number: number): string => `AC-SLICE-000-${String(number).padStart(2, '0')}`;

const HEAD = /AC-SLICE-000-(\d{1,3})(?!\d)/g;
/** What may continue a citation: a separator, then an abbreviated identifier, across backticks and a comment's line breaks. */
const NEXT = /^`?[\s*/]*(,\s*and|,\s*or|,|and|or|to)[\s*/]*`?-(\d{1,3})(?!\d)/;

/** Every criterion a text cites, with the offset of the citation that names it. */
export function citationsIn(text: string): { readonly criterion: string; readonly at: number }[] {
  const found: { criterion: string; at: number }[] = [];
  for (const head of text.matchAll(HEAD)) {
    const at = head.index;
    found.push({ criterion: idOf(Number(head[1])), at });
    let rest = at + head[0].length;
    for (;;) {
      const next = NEXT.exec(text.slice(rest));
      if (next === null) break;
      // A range (`-47 to -49`) names its two ends and nothing between them: a comment that names two criteria is not evidence of a third.
      found.push({ criterion: idOf(Number(next[2])), at });
      rest += next[0].length;
    }
  }
  return found;
}

interface Region {
  readonly start: number;
  readonly end: number;
  readonly standing: Standing;
  readonly condition?: string;
}

const TEST_CALLEES = new Set(['it', 'test', 'describe', 'suite']);
const SKIPPED_FORMS = new Set(['skip', 'todo', 'fixme']);
const CONDITIONAL_FORMS = new Set(['skipIf', 'runIf']);

/** `it`, `test.describe`, `it.skipIf(c)`, `describe.each(t)`: the root name and the member words of a test call's callee. */
function calleeWords(expression: ts.Expression): {
  readonly root: string;
  readonly words: string[];
  readonly condition?: ts.Expression;
} {
  if (ts.isIdentifier(expression)) return { root: expression.text, words: [] };
  if (ts.isPropertyAccessExpression(expression)) {
    const inner = calleeWords(expression.expression);
    return { ...inner, words: [...inner.words, expression.name.text] };
  }
  if (ts.isCallExpression(expression)) {
    // `it.skipIf(condition)(...)` and `describe.each(table)(...)`: the inner call names the form.
    const inner = calleeWords(expression.expression);
    const last = inner.words.at(-1);
    return last !== undefined &&
      CONDITIONAL_FORMS.has(last) &&
      expression.arguments[0] !== undefined
      ? { ...inner, condition: expression.arguments[0] }
      : inner;
  }
  return { root: '', words: [] };
}

/** A node's parent, which the compiler's types call always present and a source file does not have. */
const parentOf = (node: ts.Node): ts.Node | undefined => node.parent;

/** Where a statement's own text begins: the comment block directly above it (no blank line between), or its first token. */
function regionStart(source: ts.SourceFile, node: ts.Node): number {
  let statement: ts.Node = node;
  for (
    let parent = parentOf(statement);
    parent !== undefined && ts.isCallExpression(parent);
    parent = parentOf(statement)
  ) {
    statement = parent;
  }
  const parent = parentOf(statement);
  if (ts.isCallExpression(statement) && parent !== undefined && ts.isExpressionStatement(parent)) {
    statement = parent;
  }
  const text = source.text;
  const ranges = ts.getLeadingCommentRanges(text, statement.pos) ?? [];
  let start = statement.getStart(source);
  for (const range of ranges.toReversed()) {
    const between = text.slice(range.end, start);
    if ((between.match(/\n/g) ?? []).length > 1) break;
    start = range.pos;
  }
  return start;
}

/** Playwright's `test.skip(title, body)` declares a skipped test; `test.skip(condition, reason)` skips the test or suite it is in. */
function declaresSkippedTest(call: ts.CallExpression): boolean {
  const [first, second] = call.arguments;
  return (
    first !== undefined &&
    ts.isStringLiteralLike(first) &&
    second !== undefined &&
    ts.isFunctionLike(second)
  );
}

const parse = (fileName: string, text: string): ts.SourceFile =>
  ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    // Only a file that has JSX is read as having it: in a `.ts` file `<T>(x) => …` is a generic arrow, which JSX would misread.
    /\.[jt]sx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

/** The words a test call may carry between its name and its title: the modifiers of Vitest, node:test and Playwright. */
const LEAF_MODIFIERS = new Set([
  'each',
  'skip',
  'skipIf',
  'runIf',
  'only',
  'concurrent',
  'sequential',
  'fixme',
  'fails',
  'failing',
]);

/** Whether a call declares one test with a body (`it('…', fn)`, `test.skipIf(c)('…', fn)`, `it.each(t)('…', fn)`), not a suite, a hook or a step. */
function isLeafTest(call: ts.CallExpression): boolean {
  const { root, words } = calleeWords(call.expression);
  if (root !== 'it' && root !== 'test') return false;
  if (!words.every((word) => LEAF_MODIFIERS.has(word))) return false;
  // The inner call of `it.skipIf(c)('…', fn)` and of `it.each(t)('…', fn)` has no body: it is the callee of the test, not a test.
  if (!call.arguments.some((argument) => ts.isFunctionLike(argument))) return false;
  // Playwright's `test.skip(condition, reason)` is a skip inside a test.
  return !(
    root === 'test' &&
    words.length === 1 &&
    words[0] === 'skip' &&
    !declaresSkippedTest(call)
  );
}

/** The text spans of a file's tests and suites (the comment block above each included), and where each of its tests begins. */
function structureOf(
  fileName: string,
  text: string,
): { readonly containers: readonly { start: number; end: number }[]; readonly leaves: number[] } {
  const source = parse(fileName, text);
  const containers: { start: number; end: number }[] = [];
  const leaves: number[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const { root } = calleeWords(node.expression);
      if (
        TEST_CALLEES.has(root) &&
        node.arguments.some((argument) => ts.isFunctionLike(argument))
      ) {
        containers.push({ start: regionStart(source, node), end: node.getEnd() });
        if (isLeafTest(node)) leaves.push(node.getStart(source));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { containers, leaves };
}

/** The suites and tests of a file whose standing is not plain: skipped outright, or run only where a condition holds. */
export function regionsOf(fileName: string, text: string): Region[] {
  const source = parse(fileName, text);
  const regions: Region[] = [];
  const enclosingTest = (node: ts.Node): ts.CallExpression | undefined => {
    for (let parent = parentOf(node); parent !== undefined; parent = parentOf(parent)) {
      if (ts.isCallExpression(parent) && isTestCall(parent)) return parent;
    }
    return undefined;
  };
  const isTestCall = (call: ts.CallExpression): boolean => {
    const { root, words } = calleeWords(call.expression);
    return (
      TEST_CALLEES.has(root) &&
      !(words.length === 1 && words[0] === 'skip' && !declaresSkippedTest(call))
    );
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const { root, words, condition } = calleeWords(node.expression);
      if (TEST_CALLEES.has(root)) {
        const skipped = words.some((word) => SKIPPED_FORMS.has(word));
        const region = { start: regionStart(source, node), end: node.getEnd() };
        if (condition !== undefined) {
          const text = condition.getText(source).trim();
          // A condition that is a literal and decides the same way every time is a skip: `skipIf(true)`, `runIf(false)`.
          const never =
            (words.includes('skipIf') && text === 'true') ||
            (words.includes('runIf') && text === 'false');
          regions.push(
            never
              ? { ...region, standing: 'SKIPPED' }
              : { ...region, standing: 'CONDITIONAL', condition: text },
          );
        } else if (
          skipped &&
          root === 'test' &&
          words.length === 1 &&
          words[0] === 'skip' &&
          !declaresSkippedTest(node)
        ) {
          // A runtime skip: its condition governs the test or suite it is written in, or the whole file at the top level.
          const owner = enclosingTest(node);
          const when = node.arguments[0]?.getText(source).trim() ?? 'always';
          regions.push({
            start: owner === undefined ? 0 : regionStart(source, owner),
            end: owner === undefined ? text.length : owner.getEnd(),
            // `test.skip(true, …)` and `test.skip()` skip the test or suite every time.
            ...(when === 'true' || when === 'always'
              ? { standing: 'SKIPPED' as const }
              : { standing: 'CONDITIONAL' as const, condition: when }),
          });
        } else if (skipped || (words.length === 0 && /^x(it|test|describe)$/.test(root))) {
          regions.push({ ...region, standing: 'SKIPPED' });
        }
      } else if (/^x(it|test|describe)$/.test(root)) {
        regions.push({ start: regionStart(source, node), end: node.getEnd(), standing: 'SKIPPED' });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return regions;
}

/** A citation's standing: that of the innermost region holding it, and plain where none does. A skipped region inside wins. */
function standingAt(
  regions: readonly Region[],
  at: number,
): { readonly standing: Standing; readonly condition?: string } {
  const holding = regions
    .filter((region) => region.start <= at && at < region.end)
    .toSorted((a, b) => b.start - a.start || a.end - b.end);
  if (holding.some((region) => region.standing === 'SKIPPED')) return { standing: 'SKIPPED' };
  const conditional = holding.find((region) => region.standing === 'CONDITIONAL');
  return conditional === undefined
    ? { standing: 'RUNS' }
    : {
        standing: 'CONDITIONAL',
        ...(conditional.condition === undefined ? {} : { condition: conditional.condition }),
      };
}

export interface FileContext {
  /** For a journey module, which has no tests of its own: whether a spec registers it (and so runs it). */
  readonly journeyRuns?: boolean;
}

/**
 * The citations of one file, each with how its test runs. A citation inside a test or a suite runs as that test or suite does; one that
 * none holds belongs to the file and runs as the best of the file's tests does (see the header of this file).
 */
export function citationsOfFile(file: string, text: string, context: FileContext = {}): Citation[] {
  const found = citationsIn(text);
  if (found.length === 0) return [];
  const regions = regionsOf(file, text);
  const { containers, leaves } = structureOf(file, text);
  const ofTheFile = (): { readonly standing: Standing; readonly condition?: string } => {
    if (leaves.length === 0) return { standing: context.journeyRuns === true ? 'RUNS' : 'SKIPPED' };
    const standings = leaves.map((start) => standingAt(regions, start));
    if (standings.some((one) => one.standing === 'RUNS')) return { standing: 'RUNS' };
    const conditions = standings.flatMap((one) =>
      one.standing === 'CONDITIONAL' ? [one.condition ?? ''] : [],
    );
    return conditions.length === 0
      ? { standing: 'SKIPPED' }
      : { standing: 'CONDITIONAL', condition: [...new Set(conditions)].join('; ') };
  };
  return found.map(({ criterion, at }) => ({
    criterion,
    file,
    ...(containers.some((one) => one.start <= at && at < one.end)
      ? standingAt(regions, at)
      : ofTheFile()),
  }));
}

/** The problems of an inventory: what no running test cites, and what the tests cite that the slice does not define. */
export function findCitationProblems(
  criteria: readonly string[],
  citations: readonly Citation[],
): CitationProblem[] {
  const problems: CitationProblem[] = [];
  const known = new Set(criteria);
  for (const criterion of criteria) {
    const mine = citations.filter((citation) => citation.criterion === criterion);
    if (mine.length === 0) {
      problems.push({ code: 'UNCITED', criterion, message: `${criterion} is cited by no test` });
    } else if (mine.every((citation) => citation.standing === 'SKIPPED')) {
      const files = [...new Set(mine.map((citation) => citation.file))].join(', ');
      problems.push({
        code: 'ONLY_SKIPPED',
        criterion,
        message: `${criterion} is cited only by skipped tests (${files})`,
      });
    }
  }
  for (const citation of citations) {
    if (!known.has(citation.criterion)) {
      problems.push({
        code: 'UNKNOWN',
        criterion: citation.criterion,
        message: `${citation.file} cites ${citation.criterion}, which no feature file of the slice defines`,
      });
    }
  }
  return problems;
}

/** The criteria whose every running citation is conditional, with the conditions: evidence that runs only somewhere. */
export function conditionalOnly(
  criteria: readonly string[],
  citations: readonly Citation[],
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const criterion of criteria) {
    const counted = citations.filter(
      (citation) => citation.criterion === criterion && citation.standing !== 'SKIPPED',
    );
    if (counted.length > 0 && counted.every((citation) => citation.standing === 'CONDITIONAL')) {
      result.set(criterion, [
        ...new Set(counted.map((citation) => `${citation.file}: ${citation.condition ?? ''}`)),
      ]);
    }
  }
  return result;
}

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const JOURNEYS = join('e2e', 'harness', 'journeys');
const SKIPPED_FOLDERS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'tmp',
  'temp',
  'test-results',
  'playwright-report',
  '.git',
  '.turbo',
]);
const SEARCHED = ['apps', 'packages', 'e2e', 'scripts'];
/** This inventory's own test, whose identifiers are fixtures of the parser and prove no criterion. */
const OWN_TEST = 'scripts/slice-000-citations.test.ts';

/** The test files of the repository, relative to it with `/`, and the journey modules. */
export function testFilesOf(root: string): string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || SKIPPED_FOLDERS.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (
        TEST_FILE.test(entry.name) ||
        (relative(root, directory) === JOURNEYS && entry.name.endsWith('.ts'))
      ) {
        files.push(relative(root, path).split(sep).join('/'));
      }
    }
  };
  for (const folder of SEARCHED) walk(join(root, folder));
  return files.filter((file) => file !== OWN_TEST).toSorted();
}

const JOURNEY_FOLDER = 'e2e/harness/journeys/';
const isJourneyModule = (file: string): boolean =>
  file.startsWith(JOURNEY_FOLDER) && !TEST_FILE.test(file);

/**
 * The journey modules a spec reaches, directly or through another journey module, by relative imports: the ones that run. The specs are
 * the test files of `e2e/` (the staff journeys are registered by the two `*-staff-journeys.secret.test.ts` files).
 */
export function registeredJourneyModules(root: string, files: readonly string[]): Set<string> {
  const reached = new Set<string>();
  const queue = files.filter((file) => file.startsWith('e2e/') && !isJourneyModule(file));
  const seen = new Set(queue);
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    let text: string;
    try {
      text = readFileSync(join(root, next), 'utf8');
    } catch {
      continue;
    }
    for (const imported of ts.preProcessFile(text, true, true).importedFiles) {
      if (!imported.fileName.startsWith('.')) continue;
      const target = relative(
        root,
        join(root, next, '..', imported.fileName.replace(/\.js$/, '.ts')),
      )
        .split(sep)
        .join('/');
      if (!isJourneyModule(target) || seen.has(target)) continue;
      seen.add(target);
      reached.add(target);
      queue.push(target);
    }
  }
  return reached;
}

export interface Inventory {
  readonly criteria: string[];
  readonly citations: Citation[];
  readonly problems: CitationProblem[];
}

export function readInventory(root: string): Inventory {
  const criteria = readCriteria(
    FEATURES.map((feature) =>
      readFileSync(join(root, 'features', 'identity', `${feature}.md`), 'utf8'),
    ),
  );
  const files = testFilesOf(root);
  const registered = registeredJourneyModules(root, files);
  const citations = files.flatMap((file) =>
    citationsOfFile(
      file,
      readFileSync(join(root, file), 'utf8'),
      isJourneyModule(file) ? { journeyRuns: registered.has(file) } : {},
    ),
  );
  return { criteria, citations, problems: findCitationProblems(criteria, citations) };
}

if (import.meta.main) {
  const inventory = readInventory(join(import.meta.dirname, '..'));
  const cited = new Set(
    inventory.citations.filter((c) => c.standing !== 'SKIPPED').map((c) => c.criterion),
  );
  console.log(
    `${String(inventory.criteria.length)} criteria; ${String(inventory.criteria.filter((c) => cited.has(c)).length)} cited by a test that runs`,
  );
  for (const [criterion, where] of conditionalOnly(inventory.criteria, inventory.citations)) {
    console.log(`${criterion} runs only where a condition holds:\n  ${where.join('\n  ')}`);
  }
  for (const problem of inventory.problems) console.error(`${problem.code}: ${problem.message}`);
  process.exitCode = inventory.problems.length === 0 ? 0 : 1;
}
