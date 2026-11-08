import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import ts from 'typescript';

/**
 * A second real build of the API, for the proof of the fixed-policy rule (S0.63; SECURITY_DESIGN.md section 13.10a, obligation 13): the
 * repository's own source, compiled by the same compiler with the options of `tsconfig.build.json`, with the few changes of a release that
 * moves the compiled Vendor and Rider policy to revision 2. Nothing in it is a test double: the changes are made to the source text before
 * the compiler reads it, the program must type-check, and the output is a complete application started with `node main.js` like `dist`.
 *
 * **The release it compiles** (`RELEASE_2`) raises the compiled revision of both audiences and changes an actual predicate for each:
 *
 * - **Rider, an ownership predicate.** `riderHoldsAssignedWork` answers true, so a Rider who holds `settings.reason.read` passes the
 *   use case's assignment check of `listReasonDefinitions`, which the current build refuses with `403` (there is no assigned work yet).
 * - **Vendor, a required key.** `listReasonDefinitions` is served on the Vendor PWA, to a Vendor whose snapshot holds `settings.reason.read`;
 *   the current build serves the operation on the Ops Portal and the Rider app only, so it gives a Vendor nothing for that key.
 *
 * Both are widenings, so the honest declaration of this release to the database is an addition; a test may also declare it a reduction,
 * which is always allowed ("a change that cannot be shown to be a widening is a reduction") and only ends more sessions.
 *
 * **Where it is written.** Inside the API package, so that its imports resolve to the package's `node_modules` as `dist`'s do, in a folder
 * named `dist` that git, Prettier and ESLint already ignore: `.policy-release/dist/<name>/<key>/`. The key is a digest of everything the output
 * depends on (the compiler's version, the three tsconfig files, the changes and every source file the program reads), so an unchanged
 * tree reuses the build and any change makes a new one; the folders of a build's other keys are removed. A missing folder is simply built.
 */

const API_ROOT = resolve(import.meta.dirname, '../..');
const SOURCE_ROOT = join(API_ROOT, 'src');
const BUILD_CONFIG = join(API_ROOT, 'tsconfig.build.json');
const CONFIG_FILES = [
  BUILD_CONFIG,
  join(API_ROOT, 'tsconfig.json'),
  join(API_ROOT, '../../tsconfig.base.json'),
];
export const RELEASE_ROOT = join(API_ROOT, '.policy-release', 'dist');

/** One change to one source file: `from` must occur exactly once in it, and is replaced by `to`. */
export interface SourceChange {
  /** The file, relative to `src/`. */
  readonly file: string;
  readonly from: string;
  readonly to: string;
}

/** The compiled revisions of the release, as the second build declares them. */
export const RELEASE_2_REVISION = { VENDOR: 2, RIDER: 2 } as const;

export const RELEASE_2: readonly SourceChange[] = [
  {
    file: 'app.module.ts',
    from: 'export const BUILD_FIXED_POLICY: CompiledFixedPolicy = Object.freeze({ VENDOR: 1, RIDER: 1 });',
    to: `export const BUILD_FIXED_POLICY: CompiledFixedPolicy = Object.freeze({ VENDOR: ${String(RELEASE_2_REVISION.VENDOR)}, RIDER: ${String(RELEASE_2_REVISION.RIDER)} });`,
  },
  {
    file: 'settings/rider-assigned-work.ts',
    from: 'export function riderHoldsAssignedWork(): boolean {\n  return false;\n}',
    to: 'export function riderHoldsAssignedWork(): boolean {\n  return true;\n}',
  },
  {
    file: 'settings/reason-definitions.controller.ts',
    from: "surfaces: ['OPS_PORTAL', 'RIDER_ANDROID'],",
    to: "surfaces: ['OPS_PORTAL', 'RIDER_ANDROID', 'VENDOR_PWA'],",
  },
];

/** Paths compared the way the file system compares them: Windows ignores case. */
const normal = (path: string): string => {
  const absolute = resolve(path);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
};

/** The text of each changed file after its changes, keyed by its path under `src/`. Throws when a change does not match exactly once. */
export function applyChanges(changes: readonly SourceChange[]): Map<string, string> {
  const changed = new Map<string, string>();
  for (const change of changes) {
    const text =
      changed.get(change.file) ??
      readFileSync(join(SOURCE_ROOT, change.file), 'utf8').replaceAll('\r\n', '\n');
    const found = text.split(change.from).length - 1;
    if (found !== 1) {
      throw new Error(
        `The release changes ${change.file} where it says ${JSON.stringify(change.from)}, which it says ${String(found)} times, not once: ` +
          'the source moved, and the release must be written again against it.',
      );
    }
    // A function, so that the replacement is taken as written (`$&` and `$1` are patterns in a replacement string).
    changed.set(
      change.file,
      text.replace(change.from, () => change.to),
    );
  }
  return changed;
}

function parsedConfig(outDir: string): ts.ParsedCommandLine {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    BUILD_CONFIG,
    { outDir, sourceMap: false },
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic(diagnostic) {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
      },
    },
  );
  if (parsed === undefined) throw new Error(`${BUILD_CONFIG} could not be read`);
  if (parsed.errors.length > 0) throw new Error(describe(parsed.errors));
  return parsed;
}

function describe(diagnostics: readonly ts.Diagnostic[]): string {
  return ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: (name) => name,
    getCurrentDirectory: () => API_ROOT,
    getNewLine: () => '\n',
  });
}

function keyOf(fileNames: readonly string[], changes: readonly SourceChange[]): string {
  const digest = createHash('sha256');
  digest.update(`typescript ${ts.version}\n`);
  for (const config of CONFIG_FILES)
    digest.update(`${relative(API_ROOT, config)}\n`).update(readFileSync(config));
  digest.update(JSON.stringify(changes));
  for (const file of [...fileNames].map((name) => relative(API_ROOT, name)).toSorted()) {
    digest.update(`\n${file}\n`).update(readFileSync(join(API_ROOT, file)));
  }
  return digest.digest('hex').slice(0, 16);
}

/**
 * Compiles a build of this tree with `changes` (none: the current build) into a folder of its own `name`, or finds it already compiled
 * for this exact tree, and returns the path of its `main.js`. Both builds of the proof are compiled here, the same way, so that they
 * differ by the changes and by nothing else (not by a `dist` that is older than the source). It fails, saying why, when a change does
 * not apply, when the program does not type-check, or when the compiler emits nothing.
 */
export function buildRelease(name: string, changes: readonly SourceChange[]): string {
  if (!/^[a-z0-9-]+$/.test(name))
    throw new RangeError('A build is named in lower-case letters, digits and hyphens');
  const root = join(RELEASE_ROOT, name);
  const changed = new Map(
    [...applyChanges(changes)].map(
      ([file, text]) => [normal(join(SOURCE_ROOT, file)), text] as const,
    ),
  );
  const key = keyOf(parsedConfig(root).fileNames, changes);
  const output = join(root, key);
  const main = join(output, 'main.js');
  // Written last: a folder without it is a compile that did not finish, and is compiled again (Windows refuses to rename a folder a
  // scanner still holds a file of, so the build is not moved into place).
  const complete = join(output, '.complete');
  if (existsSync(complete)) return main;

  mkdirSync(root, { recursive: true });
  for (const entry of readdirSync(root))
    rmSync(join(root, entry), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  const parsed = parsedConfig(output);
  const host = ts.createCompilerHost(parsed.options);
  const readSource = host.getSourceFile.bind(host);
  const readText = host.readFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const text = changed.get(normal(fileName));
    return text === undefined
      ? readSource(fileName, languageVersion, onError, shouldCreateNewSourceFile)
      : ts.createSourceFile(fileName, text, languageVersion);
  };
  host.readFile = (fileName) => changed.get(normal(fileName)) ?? readText(fileName);

  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options, host });
  const unread = [...changed.keys()].filter(
    (path) => !program.getSourceFiles().some((source) => normal(source.fileName) === path),
  );
  if (unread.length > 0)
    throw new Error(`The compiler never read the changed files: ${unread.join(', ')}`);
  const problems = ts.getPreEmitDiagnostics(program);
  if (problems.length > 0) throw new Error(`The release does not compile:\n${describe(problems)}`);
  const emitted = program.emit();
  if (emitted.emitSkipped || emitted.diagnostics.length > 0) {
    throw new Error(`The release was not emitted:\n${describe(emitted.diagnostics)}`);
  }
  writeFileSync(
    complete,
    `${key}
`,
  );
  return main;
}
