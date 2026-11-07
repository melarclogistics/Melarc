/**
 * The tests a change can reach, and only those: what `pnpm run test:affected` runs while a task is developed and before it is handed over
 * (DEVELOPMENT.md, "The development loop and the gate"). It is not a gate. The run of every check is `pnpm run gate`, which the owner
 * starts when they want one; this chooses, from what changed, the tests whose result the change could alter, runs them, and says what it
 * left owed.
 *
 *   node scripts/affected.ts [--dry-run [--list]] [--since <revision>] [--only <target>[,<target>...]] [--with-e2e] [--with-process]
 *                            [--with-dev-browser] [--workers <n>]
 *   node scripts/affected.ts --forget
 *
 * What changed. Each target is compared with the tree of its last green run, which an affected run records for each target it ran green
 * and a gate records for each test stage that passed on a settled tree (scripts/affected-baselines.ts). A target with no such record is
 * compared with the last commit, and so runs whole while the working tree differs much from it. `--since <revision>` compares every
 * target with that revision instead. A test that failed keeps being chosen until it passes: a target's record moves only when every test
 * chosen for it passed, on a tree that did not change while they ran, and a target nothing reached keeps its record moving only when it
 * was compared with a green run of its own (never with the last commit or a revision, which nothing says passed).
 *
 * What a change reaches. A test is chosen when:
 *   - it changed, or a file it imports changed, directly or through any chain of imports (static, dynamic and `vi.mock` imports,
 *     `new URL(..., import.meta.url)`, workspace packages through their exports, with their manifest and TypeScript configuration);
 *   - it reads files or starts processes at run time (it, or a module it imports, calls a file-reading function, an `import()` of a
 *     computed path or `node:child_process`), and that module names the changed file (its file name appears in the module's text), or,
 *     for the cheap targets (the root tests and the unit suites), anything but a document changed in the folders it scans: a test that
 *     scans its package's sources or folders cannot be told apart from one that does not;
 *   - it is a test of the API that starts a process (the built API, a tool, a fixture) and an input of the API's build changed;
 *   - it is a test of the Ops Portal that runs Vite (the production build, the development server's configuration) and a file the
 *     application loads changed;
 *   - a rule of its target says so: a test configuration, a setup file every test of the target loads (or what it imports), a migration
 *     or the server's image reruns the whole target, and the lockfile, the workspace, the Node pin or the base TypeScript configuration
 *     rerun every target.
 * The browser specs of the Ops Portal do not import the pages they test: each spec covers the page folders `SPEC_AREAS` gives it. A
 * change to the application shell (what the entry point loads outside the page folders, the client package included), to a page folder
 * no spec claims, or to a file the application loads that cannot be placed reruns every spec. The end-to-end journeys are a long run:
 * reported as owed when a change reaches them, and run only with `--with-e2e`; the gate runs them. Two more parts are run on request
 * (the owner's decision of 27 October 2026), and the gate runs them too: the API's process tests, unless the change touches what only
 * they test (`PROCESS_START_UP`), with `--with-process`; and the development-server project of a browser spec that also runs against
 * the production build, with `--with-dev-browser`. The browser target's record moves on the projects it ran.
 *
 * Every rule leans the same way: what cannot be placed runs more, never less. What a static reading cannot see (a path assembled at run
 * time from parts it never names, a git-ignored settings file) is what the gate is for, and why this records only targets that passed.
 *
 *   exit 0  every chosen test passed (or nothing was chosen); what is owed is said
 *   exit 1  a test failed, or the API it needed did not build
 *   exit 2  it would not start, or a target could not run here (a gate or another affected run is running, the database does not
 *           answer, the verifier found no JDK 21)
 *   exit 3  the tree changed while the tests ran: what passed is not recorded
 *
 * One run at a time on a machine: it refuses to start beside a gate or another affected run, and the gate beside it. It starts its own
 * commands only, passes no user input to a shell, and changes nothing in the repository: logs go below the operating system's temporary
 * folder and the record below `node_modules/.cache`.
 */

import { spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { freemem, tmpdir } from 'node:os';
import { join, posix, resolve } from 'node:path';

import {
  TARGETS,
  affectedBase,
  baselineOf,
  forgetAll,
  isTarget,
  markRunning,
  readStore,
  recordTargets,
  runningAffected,
  type FileHashes,
  type TargetName,
} from './affected-baselines.ts';
import { baselineChanges, gateBase, runningGate, snapshotTree, type TreeSnapshot } from './gate.ts';
import { checkJdk, runProgram, type JdkCheck } from './jdk.ts';
import { globToRegExp } from './test-inventory.ts';

// ------------------------------------------------------------------------------------------------ the targets

type Need = 'api-build' | 'database' | 'jdk';

export interface TargetDefinition {
  readonly name: TargetName;
  /** What it runs, for the plan. */
  readonly what: string;
  /** The folder its tests and its runner belong to, from the repository root; '' for the root tests. */
  readonly dir: string;
  /** Its test files, as globs from the repository root (the root tests are read from `test:root` instead). */
  readonly tests: readonly string[];
  /** The Vitest projects to name, if any. */
  readonly projects?: readonly string[];
  /** A change to one of these reruns the whole target. */
  readonly whole: readonly string[];
  /** Setup and global-setup files every test of the target loads: a change to one, or to anything it imports, reruns the whole target. */
  readonly setup?: readonly string[];
  /**
   * The cheap targets: a change below one of these folders chooses every test of the target that reads files or starts processes,
   * because a test that scans its package cannot be told apart from one that does not. The paths of `scanIgnore` do not: the
   * packages' documents (their readers name the one they read; the root tests, which read every document, ignore none) and, for the
   * Ops Portal, its browser specs.
   */
  readonly scanScopes?: readonly string[];
  readonly scanIgnore?: readonly string[];
  /** Its tests that run Vite are chosen whenever a file the application loads changes. */
  readonly appBundlers?: boolean;
  readonly needs: readonly Need[];
  /** Run only with --with-e2e: a long run the gate makes. */
  readonly long?: boolean;
}

/** A change to one of these reruns every target: what every package installs, runs on and compiles with. */
export const EVERYTHING: readonly string[] = [
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.node-version',
  '.npmrc',
  'tsconfig.base.json',
];

/** What the API's build is made of: a change here reaches every test that runs the build. */
export const API_BUILD_INPUTS: readonly string[] = [
  'apps/api/src/**',
  'apps/api/migrations/**',
  'apps/api/package.json',
  'apps/api/tsconfig.json',
  'apps/api/tsconfig.build.json',
  'apps/api/test/support/**',
  'contracts/openapi.yaml',
];
/** The parts of those folders that the build leaves out. */
const NOT_API_BUILD = ['apps/api/src/**/*.test.ts', 'apps/api/src/test-support/**'];

/** The documents of a package, which no test of a package scans without naming the one it reads. */
const DOCUMENTS = '**/*.md';

/** What the Ops Portal's build and its browser runs are made of beyond the source the graph follows. */
const OPS_APP_FILES: readonly string[] = [
  'apps/ops-web/index.html',
  'apps/ops-web/public/**',
  'apps/ops-web/config/**',
  'apps/ops-web/vite.config.ts',
  'apps/ops-web/package.json',
  'apps/ops-web/tsconfig*.json',
];

export const DEFINITIONS: readonly TargetDefinition[] = [
  {
    name: 'root',
    what: "the repository's own tests (node --test, the files test:root names)",
    dir: '',
    tests: [],
    whole: ['package.json', 'tsconfig.json'],
    scanScopes: [''],
    needs: [],
  },
  {
    name: 'api-client',
    what: 'the generated client (Vitest)',
    dir: 'packages/api-client',
    tests: ['packages/api-client/src/**/*.test.ts', 'packages/api-client/scripts/**/*.test.ts'],
    whole: [
      'packages/api-client/package.json',
      'packages/api-client/vitest.config.ts',
      'packages/api-client/tsconfig*.json',
    ],
    scanScopes: ['packages/api-client/'],
    scanIgnore: [DOCUMENTS],
    needs: [],
  },
  {
    name: 'e2e-unit',
    what: "the integrated harness's own tests (Vitest)",
    dir: 'e2e',
    tests: ['e2e/harness/**/*.test.ts'],
    whole: ['e2e/package.json', 'e2e/vitest.config.ts', 'e2e/tsconfig*.json'],
    scanScopes: ['e2e/'],
    scanIgnore: [DOCUMENTS],
    needs: [],
  },
  {
    name: 'ops-unit',
    what: 'the Ops Portal components and guards (Vitest, jsdom and node)',
    dir: 'apps/ops-web',
    tests: [
      'apps/ops-web/src/**/*.test.ts',
      'apps/ops-web/src/**/*.test.tsx',
      'apps/ops-web/test/**/*.test.ts',
    ],
    whole: [
      'apps/ops-web/package.json',
      'apps/ops-web/vitest.config.ts',
      'apps/ops-web/vite.config.ts',
      'apps/ops-web/tsconfig*.json',
    ],
    setup: ['apps/ops-web/test/setup-components.ts'],
    // The brand and photograph tests hold the copies in the application to the originals in design/.
    scanScopes: ['apps/ops-web/', 'design/'],
    scanIgnore: [DOCUMENTS, 'apps/ops-web/test/browser/**'],
    appBundlers: true,
    needs: [],
  },
  {
    name: 'api-unit',
    what: 'the API unit project (Vitest)',
    dir: 'apps/api',
    tests: ['apps/api/src/**/*.test.ts'],
    projects: ['unit'],
    whole: ['apps/api/package.json', 'apps/api/vitest.config.ts', 'apps/api/tsconfig.json'],
    scanScopes: ['apps/api/'],
    scanIgnore: [DOCUMENTS],
    needs: [],
  },
  {
    name: 'api-process',
    what: 'the API process project: the built API as a child process (Vitest)',
    dir: 'apps/api',
    tests: ['apps/api/test/*.test.ts', 'apps/api/test/support/**/*.test.ts'],
    projects: ['process'],
    whole: ['apps/api/package.json', 'apps/api/vitest.config.ts', 'apps/api/tsconfig.json'],
    needs: ['api-build'],
  },
  {
    name: 'api-db',
    what: 'the API database projects, against the local PostgreSQL (Vitest)',
    dir: 'apps/api',
    tests: ['apps/api/test/database/*.test.ts', 'apps/api/test/database/alone/*.test.ts'],
    projects: ['database', 'database-alone'],
    whole: [
      'apps/api/migrations/**',
      'apps/api/drizzle.config.ts',
      'apps/api/package.json',
      'apps/api/vitest.config.ts',
      'apps/api/tsconfig.json',
      'infrastructure/postgres/**',
    ],
    setup: [
      'apps/api/test/database/support/global-setup.ts',
      'apps/api/test/database/support/failure-evidence-setup.ts',
      'apps/api/test/database/support/hold-shared.ts',
      'apps/api/test/database/support/hold-alone.ts',
    ],
    needs: ['api-build', 'database'],
  },
  {
    name: 'ops-browser',
    what: 'the Ops Portal in Chromium (Playwright): the specs of the pages a change reaches',
    dir: 'apps/ops-web',
    tests: ['apps/ops-web/test/browser/*.spec.ts'],
    whole: ['apps/ops-web/playwright.config.ts', ...OPS_APP_FILES],
    needs: [],
  },
  {
    name: 'verifier',
    what: 'the attestation verifier (Gradle, a JDK 21)',
    dir: 'apps/attestation-verifier',
    tests: [],
    whole: [
      'apps/attestation-verifier/**',
      '.java-version',
      'apps/api/test/vectors/**',
      'scripts/verifier.ts',
      'scripts/verifier-process.ts',
      'scripts/jdk.ts',
      'package.json',
    ],
    needs: [],
  },
  {
    name: 'e2e',
    what: 'the end-to-end journeys: a browser, the built API and Ops Portal, a database (Playwright)',
    dir: 'e2e',
    tests: [],
    whole: [
      'e2e/**',
      ...API_BUILD_INPUTS,
      'apps/ops-web/src/**',
      ...OPS_APP_FILES,
      'packages/api-client/src/**',
      'packages/api-client/package.json',
      'packages/api-client/tsconfig*.json',
      'infrastructure/postgres/**',
      'package.json',
      'turbo.json',
    ],
    needs: ['database'],
    long: true,
  },
];

/** Changes inside the folders above that do not reach the end-to-end journeys: tests and test support of the other targets. */
const NOT_E2E: readonly string[] = [
  'e2e/harness/**/*.test.ts',
  'e2e/**/*.md',
  ...NOT_API_BUILD,
  'apps/api/test/support/**/*.test.ts',
  'apps/ops-web/src/**/*.test.ts',
  'apps/ops-web/src/**/*.test.tsx',
  'apps/ops-web/src/test-support/**',
  'apps/ops-web/src/showcase/**',
  'packages/api-client/src/**/*.test.ts',
];

/**
 * The tests that build and start the real verifier service: the attested rider enrolment, and the alert rehearsal, which reads the
 * verifier's own series. A change to the verifier reaches both, and both need a JDK.
 */
export const VERIFIER_RUNS = {
  tests: [
    'apps/api/test/database/alone/rider-device-enrolment-attested.db.test.ts',
    'apps/api/test/database/alone/alert-rehearsal.db.test.ts',
  ] as readonly string[],
  inputs: ['apps/attestation-verifier/**', '.java-version', 'scripts/jdk.ts'],
} as const;

/**
 * What only the API's process tests prove: the built API, its worker and its tools started as processes (start-up refusals, the
 * configuration, shutdown, the logs and the probes, the command-line tools), and the tests and helpers that start them. A change to one
 * of these runs them; any other change that reaches them leaves them owed to the gate or `--with-process`, since the database tests run
 * the same application in process (the owner's decision of 27 October 2026).
 */
export const PROCESS_START_UP: readonly string[] = [
  'apps/api/src/main.ts',
  'apps/api/src/app.module.ts',
  'apps/api/src/delivery-worker*.ts',
  'apps/api/src/platform/config/**',
  'apps/api/src/platform/lifecycle/**',
  'apps/api/src/platform/logging/**',
  'apps/api/src/platform/health/**',
  'apps/api/src/tools/**',
  'apps/api/test/*.test.ts',
  'apps/api/test/support/**',
];

/**
 * The page folders of the Ops Portal each browser spec visits. A folder below `src/app/pages/` (or the showcase) that no spec names
 * reruns every spec when it changes, and so does anything else the entry point reaches. The pre-sign-in screens are where every
 * signed-out start and every sign-out lands, so each spec that starts signed out or signs out names them too.
 */
export const SPEC_AREAS: Readonly<Record<string, readonly string[]>> = {
  // The shell: it opens on My work (the landing, "/"), a sign-out lands on the pre-sign-in screens, and the sheet's test follows the Sessions entry
  // (the staff folder).
  'shell.spec.ts': [
    'apps/ops-web/src/app/pages/my-work/',
    'apps/ops-web/src/app/pages/pre-sign-in/',
    'apps/ops-web/src/app/pages/staff/',
  ],
  // The measurement of a heavy session (skipped unless MELARC_MEASURE=1) walks My work, the pickup queue and records, and the run builder.
  'request-rate.spec.ts': [
    'apps/ops-web/src/app/pages/my-work/',
    'apps/ops-web/src/app/pages/pickup/',
    'apps/ops-web/src/app/pages/manifests/',
  ],
  'components.spec.ts': ['apps/ops-web/src/showcase/'],
  'secrets.spec.ts': ['apps/ops-web/src/showcase/'],
  'dialogs.spec.ts': ['apps/ops-web/src/showcase/'],
  'date-picker.spec.ts': ['apps/ops-web/src/showcase/'],
  'date-picker-policy.spec.ts': ['apps/ops-web/src/showcase/'],
  // The shadcn/ui primitives are drawn by the showcase, so a change to a primitive reaches these two through its imports.
  'primitives.spec.ts': ['apps/ops-web/src/showcase/'],
  'primitives-policy.spec.ts': ['apps/ops-web/src/showcase/'],
  // The component kit is drawn by the showcase too: a change to a component of the kit reaches these two through the showcase's imports.
  'kit.spec.ts': ['apps/ops-web/src/showcase/'],
  'kit-policy.spec.ts': ['apps/ops-web/src/showcase/'],
  'pre-sign-in.spec.ts': ['apps/ops-web/src/app/pages/pre-sign-in/'],
  'logo.spec.ts': ['apps/ops-web/src/app/pages/pre-sign-in/'],
  'recovery.spec.ts': [
    'apps/ops-web/src/app/pages/pre-sign-in/',
    'apps/ops-web/src/app/pages/vendors/',
  ],
  'staff.spec.ts': [
    'apps/ops-web/src/app/pages/staff/',
    'apps/ops-web/src/app/pages/account/',
    'apps/ops-web/src/app/pages/pre-sign-in/',
  ],
  'riders.spec.ts': [
    'apps/ops-web/src/app/pages/riders/',
    'apps/ops-web/src/app/pages/pre-sign-in/',
  ],
  'pickup.spec.ts': ['apps/ops-web/src/app/pages/pickup/'],
  // The manifest screens reuse the pickup screens' note dialog and words, so a change to those reruns this spec too.
  'manifests.spec.ts': [
    'apps/ops-web/src/app/pages/manifests/',
    'apps/ops-web/src/app/pages/pickup/',
  ],
  'messages.spec.ts': [
    'apps/ops-web/src/app/pages/messages/',
    'apps/ops-web/src/app/pages/pickup/',
  ],
  // The counts of the queues: the sidebar is the shell's (a change there reruns every spec); My work is the landing; the page it goes to for a
  // change of page is the trusted browsers', in the account folder; and the late bookings' link opens the pickup requests list, so a change to the
  // pickup screens reruns it too (`AC-QSUM-11`).
  'queue-summary.spec.ts': [
    'apps/ops-web/src/app/pages/account/',
    'apps/ops-web/src/app/pages/my-work/',
    'apps/ops-web/src/app/pages/pickup/',
  ],
  // The top bar: it opens on My work, the account menu leads to the trusted browsers (the account folder), the staff list is asked for the hub that
  // was chosen (the staff folder), and a sign-out lands on the pre-sign-in screens. The rest of what it draws is the shell's.
  'top-bar.spec.ts': [
    'apps/ops-web/src/app/pages/account/',
    'apps/ops-web/src/app/pages/my-work/',
    'apps/ops-web/src/app/pages/pre-sign-in/',
    'apps/ops-web/src/app/pages/staff/',
  ],
  // The palette: it opens on My work, a record opens the staff profile's page, and the pages it goes to are the staff and the account ones.
  'palette.spec.ts': [
    'apps/ops-web/src/app/pages/account/',
    'apps/ops-web/src/app/pages/my-work/',
    'apps/ops-web/src/app/pages/staff/',
  ],
  // My work: the landing, and the folder of the page itself.
  'my-work.spec.ts': ['apps/ops-web/src/app/pages/my-work/'],
};
export const OPS_ENTRY = 'apps/ops-web/src/main.tsx';
const OPS_PAGES = 'apps/ops-web/src/app/pages/';
const OPS_SHOWCASE = 'apps/ops-web/src/showcase/';
const OPS_SOURCE = 'apps/ops-web/src/';

// ------------------------------------------------------------------------------------------------ paths and globs

const globCache = new Map<string, RegExp>();
const globOf = (glob: string): RegExp => {
  let expression = globCache.get(glob);
  if (expression === undefined) {
    expression = globToRegExp(glob);
    globCache.set(glob, expression);
  }
  return expression;
};
export const matchesAny = (path: string, globs: readonly string[]): boolean =>
  globs.some((glob) => globOf(glob).test(path));

export const isApiBuildInput = (path: string): boolean =>
  matchesAny(path, API_BUILD_INPUTS) && !matchesAny(path, NOT_API_BUILD);

const CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
export const isCode = (path: string): boolean => CODE.test(path) && !path.endsWith('.d.ts');
export const isTestFile = (path: string): boolean =>
  /\.(test|spec)\.(ts|tsx|mts|js|mjs)$/.test(path);
const isDocument = (path: string): boolean => path.endsWith('.md');
const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

const firstFew = (paths: readonly string[], count = 3): string =>
  `${paths.slice(0, count).join(', ')}${paths.length > count ? ` and ${String(paths.length - count)} more` : ''}`;

// ------------------------------------------------------------------------------------------------ the source model

export interface ModuleFacts {
  /** What it imports, resolved to files of the repository; a folder ends with '/' and stands for every file below it. */
  readonly imports: readonly string[];
  /** Relative or workspace specifiers that name nothing in the repository (the importer depends on that path all the same). */
  readonly unresolved: readonly string[];
  /** It reads the file system at run time: a file-reading function, or an `import()` of a computed path. */
  readonly readsFiles: boolean;
  /** It imports `node:child_process`: what it starts runs files that no import shows (a fixture, a tool, the build). */
  readonly startsProcesses: boolean;
  /** It imports Vite: it builds the application or reads its configuration. */
  readonly runsVite: boolean;
  /**
   * For a module that reads files or starts processes: every word of its text that could be a file's name, and its text, a changed
   * file it names being one it may read or run.
   */
  readonly names?: ReadonlySet<string>;
  readonly text?: string;
}

export interface SourceModel {
  readonly modules: ReadonlyMap<string, ModuleFacts>;
  readonly files: ReadonlySet<string>;
}

const SPECIFIERS: readonly RegExp[] = [
  /\bfrom\s*['"]([^'"\n]+)['"]/g,
  /\bimport\s*['"]([^'"\n]+)['"]/g,
  /\bimport\(\s*['"`]([^'"`\n$]+)['"`]\s*\)/g,
  /\brequire\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  /\bvi\.(?:mock|doMock|unmock|importActual|importMock)\(\s*['"]([^'"\n]+)['"]/g,
  /\bnew\s+URL\(\s*['"]([^'"\n]+)['"]\s*,\s*import\.meta\.url/g,
];
const READS_FILES =
  /\b(readFileSync|readFile|readdirSync|readdir|opendirSync|opendir|createReadStream|globSync|statSync|lstatSync|existsSync|accessSync)\s*\(|\bimport\(\s*(?!['"`\s])/;
const STARTS_PROCESSES =
  /\bfrom\s*['"](node:)?child_process['"]|\brequire\(\s*['"](node:)?child_process['"]\s*\)/;
const RUNS_VITE = /\bfrom\s*['"]vite['"]/;

export function importSpecifiers(text: string): string[] {
  const found: string[] = [];
  for (const pattern of SPECIFIERS) {
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) found.push(specifier);
    }
  }
  return found;
}

/** The words of a text that could name a file: what is left between characters that a file name of this repository never holds. */
export function wordsOf(text: string): Set<string> {
  return new Set(text.split(/[^A-Za-z0-9_.@-]+/).filter((word) => word !== ''));
}

/** Whether a reader names a changed file: its file name is a word of the reader's text, or, for a name with a space, part of it. */
export function namesFile(facts: ModuleFacts, name: string): boolean {
  if (facts.names?.has(name) === true) return true;
  return name.includes(' ') && facts.text?.includes(name) === true;
}

/** A workspace package: its folder and its exports, by subpath. */
export interface WorkspacePackage {
  readonly dir: string;
  readonly exports: Readonly<Record<string, string>>;
}

export function readWorkspacePackages(
  files: ReadonlySet<string>,
  read: (path: string) => string,
): Map<string, WorkspacePackage> {
  const packages = new Map<string, WorkspacePackage>();
  for (const file of files) {
    const depth = file.split('/').length;
    if (!file.endsWith('/package.json') || (depth !== 3 && file !== 'e2e/package.json')) continue;
    try {
      const manifest = JSON.parse(read(file)) as { name?: unknown; exports?: unknown };
      if (typeof manifest.name !== 'string' || !manifest.name.startsWith('@melarc/')) continue;
      const exports: Record<string, string> = {};
      if (typeof manifest.exports === 'string') exports['.'] = manifest.exports;
      else if (typeof manifest.exports === 'object' && manifest.exports !== null) {
        for (const [key, value] of Object.entries(manifest.exports as Record<string, unknown>)) {
          if (typeof value === 'string') exports[key] = value;
          else if (typeof value === 'object' && value !== null) {
            const conditions = value as Record<string, unknown>;
            const chosen = conditions.import ?? conditions.default ?? conditions.types;
            if (typeof chosen === 'string') exports[key] = chosen;
          }
        }
      }
      packages.set(manifest.name, { dir: file.slice(0, -'/package.json'.length), exports });
    } catch {
      // A manifest that cannot be read names no package: an import of it names nothing and is listed as such.
    }
  }
  return packages;
}

const JS_TO_TS: Readonly<Record<string, readonly string[]>> = {
  '.js': ['.ts', '.tsx', '.js'],
  '.jsx': ['.tsx', '.jsx'],
  '.mjs': ['.mts', '.mjs'],
  '.cjs': ['.cts', '.cjs'],
};
const BARE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '.json'];

/**
 * The path inside the repository a specifier names: a file, or a folder ending with '/'. `null` for a package from the registry or a
 * built-in (outside the repository), undefined for a relative or workspace specifier that names nothing.
 */
export function resolveSpecifier(
  from: string,
  specifier: string,
  files: ReadonlySet<string>,
  packages: ReadonlyMap<string, WorkspacePackage>,
  folders: ReadonlySet<string>,
): string | null | undefined {
  const clean = specifier.split(/[?#]/)[0] ?? '';
  if (clean.startsWith('./') || clean.startsWith('../')) {
    return resolvePath(posix.normalize(posix.join(posix.dirname(from), clean)), files, folders);
  }
  const workspace = /^(@melarc\/[^/]+)(\/.*)?$/.exec(clean);
  if (workspace !== null) {
    const found = packages.get(workspace[1] ?? '');
    if (found === undefined) return undefined;
    const target = found.exports[workspace[2] === undefined ? '.' : `.${workspace[2]}`];
    if (target === undefined) return `${found.dir}/`;
    return (
      resolvePath(posix.normalize(posix.join(found.dir, target)), files, folders) ?? `${found.dir}/`
    );
  }
  return null;
}

function resolvePath(
  base: string,
  files: ReadonlySet<string>,
  folders: ReadonlySet<string>,
): string | undefined {
  if (base.startsWith('../') || base === '..') return undefined;
  const extension = /\.[A-Za-z]+$/.exec(base)?.[0];
  const swaps = extension === undefined ? undefined : JS_TO_TS[extension];
  if (extension !== undefined && swaps !== undefined) {
    const stem = base.slice(0, -extension.length);
    for (const swap of swaps) if (files.has(stem + swap)) return stem + swap;
  }
  if (files.has(base)) return base;
  for (const candidate of BARE_EXTENSIONS) if (files.has(base + candidate)) return base + candidate;
  for (const candidate of BARE_EXTENSIONS)
    if (files.has(`${base}/index${candidate}`)) return `${base}/index${candidate}`;
  if (folders.has(base)) return `${base}/`;
  return undefined;
}

/** Every folder that holds a file, without the trailing '/'. */
function foldersOf(files: ReadonlySet<string>): Set<string> {
  const folders = new Set<string>();
  for (const file of files) {
    let at = file.lastIndexOf('/');
    while (at > 0) {
      const folder = file.slice(0, at);
      if (folders.has(folder)) break;
      folders.add(folder);
      at = folder.lastIndexOf('/');
    }
  }
  return folders;
}

/** The manifest and TypeScript configurations of a package: how what imports it compiles it. */
function packageConfiguration(dir: string, files: ReadonlySet<string>): string[] {
  return [...files].filter(
    (file) =>
      file === `${dir}/package.json` || /^tsconfig[^/]*\.json$/.test(file.slice(dir.length + 1)),
  );
}

/** Reads every code file of the tree once: what it imports, and whether (and what by name) it reads or runs at run time. */
export function buildSourceModel(
  files: ReadonlySet<string>,
  read: (path: string) => string,
): SourceModel {
  const packages = readWorkspacePackages(files, read);
  const configurations = new Map(
    [...packages.values()].map((found) => [found.dir, packageConfiguration(found.dir, files)]),
  );
  const folders = foldersOf(files);
  const modules = new Map<string, ModuleFacts>();
  for (const file of files) {
    if (!isCode(file)) continue;
    let text: string;
    try {
      text = read(file);
    } catch {
      continue;
    }
    const imports = new Set<string>();
    const unresolved: string[] = [];
    for (const specifier of importSpecifiers(text)) {
      const resolved = resolveSpecifier(file, specifier, files, packages, folders);
      if (resolved === null) continue;
      if (resolved === undefined) {
        unresolved.push(specifier);
        // A path that names nothing may be a file that was removed: the importer depends on it by that path.
        imports.add(
          posix.normalize(posix.join(posix.dirname(file), specifier.split(/[?#]/)[0] ?? '')),
        );
        continue;
      }
      imports.add(resolved);
      const workspace = /^(@melarc\/[^/]+)/.exec(specifier)?.[1];
      const dir = workspace === undefined ? undefined : packages.get(workspace)?.dir;
      if (dir !== undefined)
        for (const configuration of configurations.get(dir) ?? []) imports.add(configuration);
    }
    const readsFiles = READS_FILES.test(text);
    const startsProcesses = STARTS_PROCESSES.test(text);
    const watched = readsFiles || startsProcesses;
    modules.set(file, {
      imports: [...imports],
      unresolved,
      readsFiles,
      startsProcesses,
      runsVite: RUNS_VITE.test(text),
      ...(watched ? { names: wordsOf(text), text } : {}),
    });
  }
  return { modules, files };
}

/**
 * The imports of the code that runs (not of the tests, whose strings often hold an import as an example) that name no file of the tree:
 * a removed file, or a form this cannot read. The build's output (`dist/`) and the git-ignored settings files are not in the tree by
 * design. Each one leaves its importer depending on that path all the same; the list says where the reading may be short.
 */
export function unresolvedImports(model: SourceModel): string[] {
  return [...model.modules]
    .filter(([file]) => !isTestFile(file))
    .flatMap(([file, facts]) =>
      facts.unresolved
        .filter((specifier) => !specifier.includes('/dist/') && !/(^|\/)\.env$/.test(specifier))
        .map((specifier) => `${file} imports ${specifier}`),
    );
}

/** What a file reaches through its imports, itself included: the files, and the folders it names as a whole. */
export interface Closure {
  readonly files: ReadonlySet<string>;
  readonly folders: readonly string[];
}

export function closureOf(
  model: SourceModel,
  start: string,
  cache = new Map<string, Closure>(),
  stopAt?: (path: string) => boolean,
): Closure {
  const known = cache.get(start);
  if (known !== undefined) return known;
  const seen = new Set<string>([start]);
  const stack = [start];
  while (stack.length > 0) {
    const current = stack.pop() ?? '';
    for (const next of model.modules.get(current)?.imports ?? []) {
      if (seen.has(next) || stopAt?.(next) === true) continue;
      seen.add(next);
      stack.push(next);
    }
  }
  const closure = { files: seen, folders: [...seen].filter((path) => path.endsWith('/')) };
  cache.set(start, closure);
  return closure;
}

/** Whether a changed path is in a closure: the file itself, or a file below a folder the closure names. */
export function reaches(closure: Closure, path: string): boolean {
  return closure.files.has(path) || closure.folders.some((folder) => path.startsWith(folder));
}

// ------------------------------------------------------------------------------------------------ choosing

export type Mode = 'none' | 'some' | 'all';

export interface Choice {
  readonly target: TargetName;
  readonly mode: Mode;
  /** The tests chosen, from the repository root (every test of the target when the mode is 'all'). */
  readonly tests: readonly string[];
  /** For the browser target: the Playwright projects to run. */
  readonly projects?: readonly string[];
  /** For the browser target: the development-server projects left to the gate (`--with-dev-browser` runs them). */
  readonly deferred?: readonly string[];
  /** Why, one line each. */
  readonly reasons: readonly string[];
  /** What it was compared with, for the plan. */
  readonly since: string;
  readonly long: boolean;
}

export interface TargetChanges {
  readonly target: TargetName;
  readonly changed: readonly string[];
  readonly since: string;
  /** Compared with a green run of its own: the only comparison after which a target nothing reaches is still green. */
  readonly fromRecord: boolean;
}

export interface ChooseInput {
  readonly model: SourceModel;
  readonly changes: readonly TargetChanges[];
  /** The test files of each target, from the repository root. */
  readonly tests: ReadonlyMap<TargetName, readonly string[]>;
  /** The Chromium Playwright projects of the Ops Portal, by the spec file each runs. */
  readonly browserProjects: ReadonlyMap<string, readonly string[]>;
}

export const definitionOf = (name: TargetName): TargetDefinition => {
  const found = DEFINITIONS.find((definition) => definition.name === name);
  if (found === undefined) throw new Error(`no definition for ${name}`);
  return found;
};

type Base = Pick<Choice, 'target' | 'since' | 'long'>;

/** What the application loads: the entry point's closure, pages and the client package included. */
const applicationOf = (model: SourceModel, cache: Map<string, Closure>): Closure =>
  closureOf(model, OPS_ENTRY, cache);

/** The tests of every target that the changes reach. */
export function choose(input: ChooseInput): Choice[] {
  const cache = new Map<string, Closure>();
  return input.changes.map((entry) =>
    processOnRequest(chooseTarget(input, entry, cache), entry.changed),
  );
}

/** The API's process tests, owed on request unless the change touches what only they test, a whole-target input or what all depend on. */
export function processOnRequest(choice: Choice, changed: readonly string[]): Choice {
  if (choice.target !== 'api-process' || choice.mode === 'none') return choice;
  const runsNow = changed.some(
    (path) =>
      EVERYTHING.includes(path) ||
      matchesAny(path, [...definitionOf('api-process').whole, ...PROCESS_START_UP]),
  );
  return runsNow
    ? choice
    : { ...choice, long: true, reasons: [...choice.reasons, 'no start-up code changed'] };
}

/** Whether a choice runs in this run: a long one only when asked, the journeys with --with-e2e and the process tests with --with-process. */
export function released(
  choice: Choice,
  asked: { readonly withE2e: boolean; readonly withProcess: boolean },
): boolean {
  if (!choice.long) return true;
  if (choice.target === 'e2e') return asked.withE2e;
  if (choice.target === 'api-process') return asked.withProcess;
  return false;
}

/**
 * The browser target without the development-server project of each spec that also runs against the production build, which is left
 * to the gate unless `withDevelopment` (the owner's decision of 27 October 2026). A spec that has only a development-server project (the
 * showcase) keeps it.
 */
export function deferDevelopmentProjects(
  choices: readonly Choice[],
  withDevelopment: boolean,
): Choice[] {
  return choices.map((choice) => {
    const projects = choice.projects ?? [];
    if (withDevelopment || choice.target !== 'ops-browser') return choice;
    const deferred = projects.filter(
      (name) =>
        name.endsWith('-dev-chromium') &&
        projects.includes(name.replace(/-dev-chromium$/, '-chromium')),
    );
    if (deferred.length === 0) return choice;
    return { ...choice, projects: projects.filter((name) => !deferred.includes(name)), deferred };
  });
}

/** The tests of one target that its changes reach. */
function chooseTarget(
  input: ChooseInput,
  entry: TargetChanges,
  cache: Map<string, Closure>,
): Choice {
  const definition = definitionOf(entry.target);
  const tests = input.tests.get(entry.target) ?? [];
  const base: Base = { target: entry.target, since: entry.since, long: definition.long === true };
  const none = (reason: string): Choice => ({
    ...base,
    mode: 'none',
    tests: [],
    reasons: [reason],
  });
  const all = (reason: string): Choice => ({
    ...base,
    mode: 'all',
    tests,
    ...(entry.target === 'ops-browser'
      ? { projects: tests.flatMap((spec) => input.browserProjects.get(basename(spec)) ?? []) }
      : {}),
    reasons: [reason],
  });
  if (entry.changed.length === 0) return none('nothing changed since then');
  const everything = entry.changed.filter((path) => EVERYTHING.includes(path));
  if (everything.length > 0)
    return all(`${firstFew(everything)} changed, which every test depends on`);
  const whole = entry.changed.filter(
    (path) =>
      matchesAny(path, definition.whole) && !(entry.target === 'e2e' && matchesAny(path, NOT_E2E)),
  );
  if (whole.length > 0) return all(`${firstFew(whole)} changed, which reruns the whole target`);
  const setup = (definition.setup ?? []).map((file) => closureOf(input.model, file, cache));
  const setupChanges = entry.changed.filter((path) =>
    setup.some((closure) => reaches(closure, path)),
  );
  if (setupChanges.length > 0) {
    return all(`${firstFew(setupChanges)} changed, which a setup file of every test loads`);
  }
  if (entry.target === 'verifier' || entry.target === 'e2e') return none('no change reaches it');
  if (entry.target === 'ops-browser') return chooseBrowserSpecs(input, entry, base, cache, all);
  return chooseByGraph(input.model, definition, tests, entry.changed, base, cache);
}

function chooseByGraph(
  model: SourceModel,
  definition: TargetDefinition,
  tests: readonly string[],
  changed: readonly string[],
  base: Base,
  cache: Map<string, Closure>,
): Choice {
  const counts = { changed: 0, imports: 0, scans: 0, reads: 0, build: 0, bundles: 0, verifier: 0 };
  const changedSet = new Set(changed);
  const changedNames = [...new Set(changed.map(basename))];
  const scopes = definition.scanScopes ?? [];
  const scanned = changed.some(
    (path) =>
      scopes.some((scope) => path.startsWith(scope)) &&
      !matchesAny(path, definition.scanIgnore ?? []),
  );
  const buildChanged = changed.some(isApiBuildInput);
  const verifierChanged = changed.some((path) => matchesAny(path, VERIFIER_RUNS.inputs));
  // In the API's targets, a test that starts a process may be starting the build (a tool, a fixture that imports `dist/`).
  const startsTheBuild = definition.dir === 'apps/api';
  const application = definition.appBundlers === true ? applicationOf(model, cache) : undefined;
  const applicationChanged =
    application !== undefined &&
    changed.some((path) => reaches(application, path) || matchesAny(path, OPS_APP_FILES));
  const chosen: string[] = [];
  for (const test of tests) {
    const closure = closureOf(model, test, cache);
    let watches = false;
    let startsProcesses = false;
    let runsVite = false;
    let namesChanged = false;
    for (const path of closure.files) {
      const facts = model.modules.get(path);
      if (facts === undefined) continue;
      runsVite ||= facts.runsVite;
      if (!facts.readsFiles && !facts.startsProcesses) continue;
      watches = true;
      startsProcesses ||= facts.startsProcesses;
      if (!namesChanged) namesChanged = changedNames.some((name) => namesFile(facts, name));
    }
    let why: keyof typeof counts | undefined;
    if (changedSet.has(test)) why = 'changed';
    else if (changed.some((path) => reaches(closure, path))) why = 'imports';
    else if (watches && scanned) why = 'scans';
    else if (namesChanged) why = 'reads';
    else if (buildChanged && startsTheBuild && startsProcesses) why = 'build';
    else if (applicationChanged && runsVite) why = 'bundles';
    else if (verifierChanged && VERIFIER_RUNS.tests.includes(test)) why = 'verifier';
    if (why === undefined) continue;
    counts[why] += 1;
    chosen.push(test);
  }
  if (chosen.length === 0)
    return { ...base, mode: 'none', tests: [], reasons: ['no change reaches its tests'] };
  const where = scopes.map((scope) => (scope === '' ? 'the repository' : scope)).join(' or ');
  const reasons = [
    counts.changed > 0 ? `${String(counts.changed)} changed` : '',
    counts.imports > 0 ? `${String(counts.imports)} import a changed file` : '',
    counts.scans > 0
      ? `${String(counts.scans)} read files or start processes, and ${where} changed`
      : '',
    counts.reads > 0 ? `${String(counts.reads)} read a file that changed` : '',
    counts.build > 0
      ? `${String(counts.build)} start a process of the API, whose source changed`
      : '',
    counts.bundles > 0
      ? `${String(counts.bundles)} run Vite over the application, which changed`
      : '',
    counts.verifier > 0
      ? `${String(counts.verifier)} start the verifier, whose source changed`
      : '',
  ].filter((reason) => reason !== '');
  return { ...base, mode: chosen.length === tests.length ? 'all' : 'some', tests: chosen, reasons };
}

function chooseBrowserSpecs(
  input: ChooseInput,
  entry: TargetChanges,
  base: Base,
  cache: Map<string, Closure>,
  all: (reason: string) => Choice,
): Choice {
  const { model } = input;
  const specs = input.tests.get('ops-browser') ?? [];
  // The page folders: those a spec claims, and any other, whose change reruns every spec.
  const claimed = new Set(Object.values(SPEC_AREAS).flat());
  const pageFolders = new Set<string>([OPS_SHOWCASE]);
  for (const file of model.files) {
    if (!file.startsWith(OPS_PAGES)) continue;
    const rest = file.slice(OPS_PAGES.length);
    if (rest.includes('/')) pageFolders.add(`${OPS_PAGES}${rest.slice(0, rest.indexOf('/'))}/`);
  }
  const folderOf = (path: string): string | undefined =>
    [...pageFolders].find((folder) => path.startsWith(folder));
  const application = applicationOf(model, cache);
  const shell = closureOf(model, OPS_ENTRY, new Map(), (path) => folderOf(path) !== undefined);
  // What the application loads or holds that changed: its source, and anything else its entry point reaches (the client package).
  const changedApp = entry.changed.filter(
    (path) =>
      !isTestFile(path) &&
      !path.startsWith('apps/ops-web/src/test-support/') &&
      !isDocument(path) &&
      (path.startsWith(OPS_SOURCE) || reaches(application, path)),
  );
  const shellChanges = changedApp.filter(
    (path) => folderOf(path) === undefined && reaches(shell, path),
  );
  if (shellChanges.length > 0)
    return all(`the application shell changed (${firstFew(shellChanges)})`);
  const unclaimedChanges = changedApp.filter((path) => {
    const folder = folderOf(path);
    return folder !== undefined && !claimed.has(folder);
  });
  if (unclaimedChanges.length > 0) {
    return all(
      `a page folder no spec claims changed (${firstFew(unclaimedChanges)}): every spec runs until SPEC_AREAS names it`,
    );
  }
  const chosen = new Set<string>();
  const placed = new Set<string>();
  for (const spec of specs) {
    const reach: Closure[] = [closureOf(model, spec, cache)];
    for (const area of SPEC_AREAS[basename(spec)] ?? []) {
      // The pages' code, not the jsdom tests beside it: those load every page through the test support, and the browser runs none of them.
      for (const file of model.files) {
        if (file.startsWith(area) && isCode(file) && !isTestFile(file))
          reach.push(closureOf(model, file, cache));
      }
      // A file of the folder that no code imports (an image, a stylesheet) is the folder's all the same.
      for (const path of changedApp)
        if (path.startsWith(area)) reach.push({ files: new Set([path]), folders: [] });
    }
    for (const path of entry.changed) {
      if (reach.some((closure) => reaches(closure, path))) {
        chosen.add(spec);
        placed.add(path);
      }
    }
  }
  // A file the application loads that nothing above places (a font a stylesheet names, a module no page imports) reruns every spec.
  const unplaced = changedApp.filter((path) => !placed.has(path));
  if (unplaced.length > 0)
    return all(
      `a file of the application that no spec can be tied to changed (${firstFew(unplaced)})`,
    );
  if (chosen.size === 0)
    return { ...base, mode: 'none', tests: [], reasons: ['no change reaches a page or a spec'] };
  const tests = specs.filter((spec) => chosen.has(spec));
  return {
    ...base,
    mode: tests.length === specs.length ? 'all' : 'some',
    tests,
    projects: tests.flatMap((spec) => input.browserProjects.get(basename(spec)) ?? []),
    reasons: [`the pages or the support of ${tests.map(basename).join(', ')} changed`],
  };
}

// ------------------------------------------------------------------------------------------------ what changed

/** Files that differ between the tree now and a recorded one: changed, added or gone. */
export function differences(now: FileHashes, before: FileHashes): string[] {
  const changed: string[] = [];
  for (const [path, hash] of now) if (before.get(path) !== hash) changed.push(path);
  for (const path of before.keys()) if (!now.has(path)) changed.push(path);
  return changed.toSorted();
}

/** The files that differ from a revision: tracked changes (staged or not, removals included) and new files Git does not ignore. */
export function changesSinceRevision(root: string, revision: string): string[] {
  const run = (args: readonly string[]): string[] => {
    const result = spawnSync('git', args, { cwd: root, maxBuffer: 256 * 1024 * 1024 });
    if (result.status !== 0) {
      const said = result.stderr.toString('utf8').trim();
      throw new Error(
        `git ${args.join(' ')} failed: ${said === '' ? `exit ${String(result.status)}` : said}`,
      );
    }
    return result.stdout
      .toString('utf8')
      .split('\0')
      .filter((path) => path !== '');
  };
  const tracked = run(['diff', '--name-only', '--no-renames', '-z', revision, '--']);
  const untracked = run(['ls-files', '--others', '--exclude-standard', '-z']);
  return [...new Set([...tracked, ...untracked])].toSorted();
}

export const hashesOf = (snapshot: TreeSnapshot): FileHashes =>
  new Map([...snapshot].map(([path, state]) => [path, state.hash]));

/** For each target: what changed, and since what. */
export function changesFor(
  root: string,
  now: FileHashes,
  targets: readonly TargetName[],
  since: string | undefined,
  sinceRevision: (revision: string) => string[] = (revision) =>
    changesSinceRevision(root, revision),
): TargetChanges[] {
  if (since !== undefined) {
    const changed = sinceRevision(since);
    return targets.map((target) => ({
      target,
      since: `revision ${since}`,
      changed,
      fromRecord: false,
    }));
  }
  const store = readStore(root);
  let sinceHead: string[] | undefined;
  return targets.map((target) => {
    const baseline = baselineOf(root, target, store);
    if (baseline !== undefined) {
      const at = baseline.record.recordedAt.slice(0, 16).replace('T', ' ');
      return {
        target,
        since: `its last green run (${baseline.record.by}, ${at} UTC)`,
        changed: differences(now, baseline.files),
        fromRecord: true,
      };
    }
    sinceHead ??= sinceRevision('HEAD');
    return {
      target,
      since: 'the last commit (no green run recorded yet)',
      changed: sinceHead,
      fromRecord: false,
    };
  });
}

// ------------------------------------------------------------------------------------------------ the tests of each target

export function rootTests(manifest: string): string[] {
  const parsed = JSON.parse(manifest) as { scripts?: Record<string, string> };
  return (parsed.scripts?.['test:root'] ?? '')
    .split(/\s+/)
    .filter((token) => token.endsWith('.test.ts'));
}

export function testsOf(
  definition: TargetDefinition,
  files: ReadonlySet<string>,
  rootManifest: string,
): string[] {
  if (definition.name === 'root') return rootTests(rootManifest);
  if (definition.tests.length === 0) return [];
  return [...files].filter((file) => matchesAny(file, definition.tests)).toSorted();
}

/** The Chromium projects of the Ops Portal's Playwright configuration, by the spec file each runs, read from its text. */
export function readBrowserProjects(text: string): Map<string, string[]> {
  const projects = new Map<string, string[]>();
  for (const match of text.matchAll(
    /name:\s*`([a-z][a-z-]*)-\$\{engine\}`,\s*testMatch:\s*'([^']+)'/g,
  )) {
    const [, name, spec] = match;
    if (name === undefined || spec === undefined) continue;
    projects.set(spec, [...(projects.get(spec) ?? []), `${name}-chromium`]);
  }
  return projects;
}

// ------------------------------------------------------------------------------------------------ running

export interface RunStep {
  readonly label: string;
  /** A program and its arguments, started without a shell. */
  readonly argv?: readonly string[];
  /** Or a fixed command line for the shell (`pnpm` is a script on Windows and needs one). */
  readonly shell?: string;
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Exit codes that mean the step could not run here (a missing JDK), not that a test failed. */
  readonly couldNotRun?: readonly number[];
}

/** Longer than this, a command line is not trusted to Windows (its limit is 32 767 characters): the whole target runs instead. */
export const COMMAND_LINE_LIMIT = 24_000;

/** What a choice needs of the machine: its target's needs, and a JDK when it runs the test that starts the attestation verifier. */
export function needsOf(choice: Pick<Choice, 'target' | 'tests'>): Need[] {
  const own = definitionOf(choice.target).needs;
  return choice.tests.some((test) => VERIFIER_RUNS.tests.includes(test))
    ? [...own, 'jdk']
    : [...own];
}

/**
 * Why the test that starts the verifier cannot run here, or undefined when the JDK is usable: without one it fails before it tests
 * anything, which is the machine's and not the change's, so its target is owed, with the way out, instead of failed.
 */
export function jdkBlock(
  check: JdkCheck,
): { readonly status: OutcomeStatus; readonly note: string } | undefined {
  if (check.ok) return undefined;
  return {
    status: 'not-run',
    note: `${VERIFIER_RUNS.tests.map((test) => posix.basename(test)).join(' and ')} start the attestation verifier, which needs a JDK: ${check.problem} Set JAVA_HOME to it; DEVELOPMENT.md, "The attestation verifier", says how`,
  };
}

/** How the choice for a target is run. */
export function stepsFor(choice: Choice, root: string): RunStep[] {
  const definition = definitionOf(choice.target);
  const dir = join(root, definition.dir);
  switch (choice.target) {
    case 'root':
      return [
        {
          label: `node --test (${String(choice.tests.length)} files)`,
          argv: [process.execPath, '--test', ...choice.tests],
          cwd: root,
        },
      ];
    case 'ops-browser': {
      const projects = (choice.projects ?? []).map((project) => `--project=${project}`);
      return [
        {
          label: `playwright test ${projects.join(' ')}`,
          argv: [
            process.execPath,
            join(dir, 'node_modules', '@playwright', 'test', 'cli.js'),
            'test',
            ...projects,
          ],
          cwd: dir,
          // The projects named are the Chromium ones, whatever the shell asks for.
          env: { MELARC_BROWSERS: 'chromium' },
        },
      ];
    }
    case 'verifier':
      // scripts/verifier.ts exits 2 when it would not start (no JDK 21): the target could not run here; nothing failed.
      return [
        {
          label: 'pnpm run verifier:test',
          shell: 'pnpm run verifier:test',
          cwd: root,
          couldNotRun: [2],
        },
      ];
    case 'e2e':
      return [{ label: 'pnpm run test:e2e', shell: 'pnpm run test:e2e', cwd: root }];
    default: {
      const projects = (definition.projects ?? []).flatMap((project) => ['--project', project]);
      const relative = choice.tests.map((test) => test.slice(definition.dir.length + 1));
      const files =
        choice.mode === 'all' || relative.join(' ').length > COMMAND_LINE_LIMIT ? [] : relative;
      const named = files.length === 0 ? 'every file' : `${String(files.length)} files`;
      return [
        {
          label: `vitest run ${[...projects, named].join(' ')}`,
          argv: [
            process.execPath,
            join(dir, 'node_modules', 'vitest', 'vitest.mjs'),
            'run',
            ...projects,
            ...files,
          ],
          cwd: dir,
        },
      ];
    }
  }
}

/**
 * The environment of every command: plain text, the bound on the parallel suites' workers (`MELARC_TEST_WORKERS`, which every Vitest
 * configuration reads), and no `VITEST_MAX_WORKERS`, which Vitest would apply to every project, the one-at-a-time ones included, and
 * no `MELARC_BROWSER_SHARD`, with which the Ops Portal's configuration would run only a part of the browser specs chosen.
 */
export function childEnvironment(base: NodeJS.ProcessEnv, workers: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, NO_COLOR: '1' };
  delete env.FORCE_COLOR;
  delete env.VITEST_MAX_WORKERS;
  delete env.MELARC_BROWSER_SHARD;
  env.MELARC_TEST_WORKERS = String(workers);
  return env;
}

export type OutcomeStatus = 'passed' | 'failed' | 'not-run';

/** What the exit code of a step says about its target. */
export function outcomeOf(step: RunStep, exitCode: number | null): OutcomeStatus {
  if (exitCode === 0) return 'passed';
  if (exitCode !== null && (step.couldNotRun ?? []).includes(exitCode)) return 'not-run';
  return 'failed';
}

function runStep(step: RunStep, log: string, env: NodeJS.ProcessEnv): Promise<number | null> {
  writeFileSync(log, `$ ${step.label}\n\n`, { flag: 'a' });
  const descriptor = openSync(log, 'a');
  const options = {
    cwd: step.cwd,
    env: { ...env, ...step.env },
    stdio: ['ignore', descriptor, descriptor] as ['ignore', number, number],
    windowsHide: true,
  };
  return new Promise((done) => {
    let child;
    try {
      child =
        step.argv === undefined
          ? spawn(step.shell ?? '', { ...options, shell: true })
          : spawn(step.argv[0] ?? '', step.argv.slice(1), options);
    } catch (error) {
      writeFileSync(
        log,
        `could not start: ${error instanceof Error ? error.message : String(error)}\n`,
        { flag: 'a' },
      );
      done(null);
      return;
    } finally {
      closeSync(descriptor);
    }
    child.once('error', (error) => {
      writeFileSync(log, `could not start: ${error.message}\n`, { flag: 'a' });
      done(null);
    });
    child.once('close', (code) => {
      done(code);
    });
  });
}

const tailOf = (log: string, lines: number): string =>
  readFileSync(log, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');

const clock = (ms: number): string =>
  `${String(Math.floor(ms / 60_000))}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}`;

// ------------------------------------------------------------------------------------------------ the plan and the report

/** What would run and why, a line per target, and the tests chosen when they are some of the target's. */
export function renderPlan(
  choices: readonly Choice[],
  runs: (choice: Choice) => boolean,
  listAll: boolean,
): string[] {
  const lines: string[] = [];
  const width = Math.max(...choices.map((choice) => choice.target.length));
  for (const choice of choices) {
    const owed = choice.mode !== 'none' && !runs(choice);
    const count = (noun: string, n: number): string => `${String(n)} ${noun}${n === 1 ? '' : 's'}`;
    let what: string;
    if (choice.mode === 'none') what = 'nothing';
    else if (owed)
      what =
        choice.target === 'api-process'
          ? 'OWED: on request (--with-process)'
          : 'OWED: a long run, left to the gate';
    else if (choice.target === 'ops-browser')
      what = `${count('spec', choice.tests.length)}, ${count('project', choice.projects?.length ?? 0)}`;
    else if (choice.tests.length === 0) what = 'the whole suite';
    else if (choice.mode === 'all') what = `all ${count('test file', choice.tests.length)}`;
    else what = count('test file', choice.tests.length);
    lines.push(`  ${choice.target.padEnd(width)}  ${what.padEnd(34)} ${choice.reasons.join('; ')}`);
    if (!owed && (choice.deferred ?? []).length > 0) {
      lines.push(
        `  ${' '.repeat(width)}    left to the gate or --with-dev-browser: ${(choice.deferred ?? []).join(', ')}`,
      );
    }
    if (choice.mode === 'some' && !owed) {
      const shown = listAll ? choice.tests : choice.tests.slice(0, 6);
      for (const test of shown) lines.push(`  ${' '.repeat(width)}    ${test}`);
      if (shown.length < choice.tests.length) {
        lines.push(
          `  ${' '.repeat(width)}    and ${String(choice.tests.length - shown.length)} more (--dry-run --list names them all)`,
        );
      }
    }
  }
  return lines;
}

/** The run of one target: passed, failed, or not run and why. */
export interface Outcome {
  readonly target: TargetName;
  readonly status: OutcomeStatus;
  readonly note: string;
}

/**
 * The closing lines of a run. "Owed" is everything the change reaches that did not pass here: the long runs left to the gate, and the
 * targets that could not run, each with its reason, so that whoever quotes the line quotes all of it.
 */
export function renderReport(input: {
  readonly outcomes: readonly Outcome[];
  readonly longOwed: readonly TargetName[];
  /** The development-server projects of the browser specs that ran, left to the gate. */
  readonly deferredProjects?: readonly string[];
  readonly unsettled: readonly string[];
  readonly elapsedMs: number;
}): string[] {
  const of = (status: OutcomeStatus): Outcome[] =>
    input.outcomes.filter((outcome) => outcome.status === status);
  const failed = of('failed');
  const notRun = of('not-run');
  const verdict =
    failed.length > 0
      ? 'FAILED'
      : input.unsettled.length > 0
        ? 'UNSETTLED'
        : notRun.length > 0
          ? 'INCOMPLETE'
          : 'passed';
  const owed = [
    ...input.longOwed.map((target) =>
      target === 'api-process'
        ? `${target} (on request: no start-up code changed; left to the gate or --with-process)`
        : `${target} (a long run, left to the gate or --with-e2e)`,
    ),
    ...((input.deferredProjects ?? []).length > 0
      ? [
          `ops-browser development-server projects ${(input.deferredProjects ?? []).join(', ')} (left to the gate or --with-dev-browser)`,
        ]
      : []),
    ...notRun.map((outcome) => `${outcome.target} (not run: ${outcome.note})`),
  ];
  const lines = [
    [
      `Affected run ${verdict} after ${clock(input.elapsedMs)}.`,
      of('passed').length > 0
        ? `Passed: ${of('passed')
            .map((outcome) => outcome.target)
            .join(', ')}.`
        : '',
      failed.length > 0 ? `Failed: ${failed.map((outcome) => outcome.target).join(', ')}.` : '',
    ]
      .filter((part) => part !== '')
      .join(' '),
  ];
  if (owed.length > 0) lines.push(`Owed: ${owed.join('; ')}.`);
  if (input.unsettled.length > 0) {
    lines.push(
      `The tree changed while the tests ran (${firstFew(input.unsettled)}): nothing was recorded, and the next run chooses again.`,
    );
  }
  return lines;
}

/**
 * The targets nothing reached that may be recorded as green on this tree without running: only those compared with a green run of their
 * own. One compared with the last commit or a revision is not, because nothing says that commit or revision passed.
 */
export function untouchedTargets(
  choices: readonly Choice[],
  changes: readonly TargetChanges[],
): TargetName[] {
  return choices
    .filter(
      (choice) =>
        choice.mode === 'none' &&
        changes.find((entry) => entry.target === choice.target)?.fromRecord === true,
    )
    .map((choice) => choice.target);
}

/** The exit code of a run: a failure first, then a tree that changed, then a target that could not run. */
export function exitCodeOf(outcomes: readonly Outcome[], unsettled: readonly string[]): number {
  if (outcomes.some((outcome) => outcome.status === 'failed')) return 1;
  if (unsettled.length > 0) return 3;
  if (outcomes.some((outcome) => outcome.status === 'not-run')) return 2;
  return 0;
}

// ------------------------------------------------------------------------------------------------ the command line

export interface Options {
  readonly dryRun: boolean;
  readonly list: boolean;
  readonly since: string | undefined;
  readonly only: readonly TargetName[] | undefined;
  readonly withE2e: boolean;
  readonly withProcess: boolean;
  readonly withDevBrowser: boolean;
  readonly workers: number;
  readonly forget: boolean;
}

export function parseOptions(argv: readonly string[]): {
  readonly options?: Options;
  readonly problems: readonly string[];
} {
  const problems: string[] = [];
  const options = {
    dryRun: false,
    list: false,
    since: undefined as string | undefined,
    only: undefined as TargetName[] | undefined,
    withE2e: false,
    withProcess: false,
    withDevBrowser: false,
    workers: 4,
    forget: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? '';
    const value = argv[index + 1];
    if (flag === '--') continue;
    if (flag === '--dry-run') options.dryRun = true;
    else if (flag === '--list') options.list = true;
    else if (flag === '--with-e2e') options.withE2e = true;
    else if (flag === '--with-process') options.withProcess = true;
    else if (flag === '--with-dev-browser') options.withDevBrowser = true;
    else if (flag === '--forget') options.forget = true;
    else if (flag === '--since' || flag === '--only' || flag === '--workers') {
      index += 1;
      if (value === undefined || value.startsWith('--')) {
        problems.push(`${flag} needs a value.`);
      } else if (flag === '--since') {
        // A revision is handed to Git as one argument, never to a shell; this keeps out what is not a revision's name at all.
        if (/^[\w./~^@{}-]+$/.test(value) && !value.startsWith('-')) options.since = value;
        else problems.push(`"${value}" is not a revision.`);
      } else if (flag === '--only') {
        const names = value.split(',').filter((name) => name !== '');
        const unknown = names.filter((name) => !isTarget(name));
        if (names.length === 0 || unknown.length > 0)
          problems.push(`--only takes targets from: ${TARGETS.join(', ')}.`);
        else options.only = names.filter(isTarget);
      } else {
        const count = Number(value);
        if (Number.isInteger(count) && count >= 1 && count <= 16) options.workers = count;
        else problems.push('--workers is a whole number from 1 to 16.');
      }
    } else problems.push(`"${flag}" is not an option.`);
  }
  return problems.length > 0 ? { problems } : { options, problems };
}

const USAGE = [
  'Usage: pnpm run test:affected [options]',
  '  --dry-run              say what would run and why, and run nothing (add --list to name every test chosen)',
  '  --since <revision>     compare every target with that revision instead of with its last green run',
  `  --only <targets>       these targets only, separated by commas: ${TARGETS.join(', ')}`,
  '  --with-e2e             also run the end-to-end journeys when a change reaches them (a long run)',
  '  --with-process         also run the API process tests when only code other than start-up reaches them',
  '  --with-dev-browser     also run the development-server project of each browser spec (the gate runs both modes)',
  '  --workers <n>          workers of the parallel Vitest suites (MELARC_TEST_WORKERS; 4)',
  '  --forget               forget every recorded green run: the next run compares every target with the last commit',
].join('\n');

/** Why an affected run may not start now, or undefined: one run at a time on a machine, and never beside a gate. */
export function startRefusal(
  base: string = gateBase(),
  affectedRuns: string = affectedBase(),
): string | undefined {
  const gate = runningGate(base);
  if (gate !== undefined) {
    return `A gate is running (${gate.name}, process ${String(gate.runnerPid)}): tests beside it would starve it, and it reads this tree. Wait for it (pnpm run gate:status) or stop it (pnpm run gate:stop).`;
  }
  const other = runningAffected(affectedRuns);
  if (other !== undefined && other.pid !== process.pid) {
    return `Another affected run is running (process ${String(other.pid)}, since ${other.startedAt}): two at once share the browsers' ports, the database server's roles, the Ops Portal's build and the memory, and each fails for the other. Let it finish.`;
  }
  return undefined;
}

export async function main(argv: readonly string[], root: string): Promise<number> {
  const parsed = parseOptions(argv);
  if (parsed.options === undefined) {
    for (const problem of parsed.problems) console.error(problem);
    console.error(USAGE);
    return 2;
  }
  const { options } = parsed;
  if (options.forget) {
    forgetAll(root);
    console.log(
      'Every recorded green run is forgotten: the next run compares every target with the last commit.',
    );
    return 0;
  }
  if (!options.dryRun) {
    const refused = startRefusal();
    if (refused !== undefined) {
      console.error(refused);
      return 2;
    }
  }
  const stopMarking = options.dryRun ? () => undefined : markRunning();
  try {
    return await affectedRun(options, root);
  } finally {
    stopMarking();
  }
}

async function affectedRun(options: Options, root: string): Promise<number> {
  const started = Date.now();
  const snapshot = snapshotTree(root);
  const now = hashesOf(snapshot);
  const files = new Set(snapshot.keys());
  const read = (path: string): string => readFileSync(join(root, path), 'utf8');
  const targets = TARGETS.filter((target) => options.only?.includes(target) ?? true);
  const changes = changesFor(root, now, targets, options.since);
  const model = buildSourceModel(files, read);
  const rootManifest = read('package.json');
  const tests = new Map(
    DEFINITIONS.map((definition) => [definition.name, testsOf(definition, files, rootManifest)]),
  );
  const browserProjects = readBrowserProjects(read('apps/ops-web/playwright.config.ts'));
  const choices = deferDevelopmentProjects(
    choose({ model, changes, tests, browserProjects }),
    options.withDevBrowser,
  );
  const runs = (choice: Choice): boolean => released(choice, options);

  console.log(
    `Affected tests, chosen in ${clock(Date.now() - started)} from ${String(files.size)} files.`,
  );
  for (const since of new Set(changes.map((entry) => entry.since))) {
    const named = changes.filter((entry) => entry.since === since);
    const changed = new Set(named.flatMap((entry) => entry.changed)).size;
    console.log(
      `  ${named.map((entry) => entry.target).join(', ')}: ${String(changed)} files changed since ${since}`,
    );
  }
  if (changes.some((entry) => !entry.fromRecord) && options.since === undefined) {
    console.log(
      '  A target with no green run recorded runs whole while the tree differs much from the last commit: a passed gate records every target it runs.',
    );
  }
  console.log('');
  for (const line of renderPlan(choices, runs, options.list)) console.log(line);
  const unresolved = unresolvedImports(model);
  if (unresolved.length > 0) {
    console.log('');
    console.log(
      `Imports that name no file (a removed file, or a form this cannot read): ${firstFew(unresolved, 5)}`,
    );
  }
  if (process.env.VITEST_MAX_WORKERS !== undefined && process.env.VITEST_MAX_WORKERS !== '') {
    console.log(
      'VITEST_MAX_WORKERS is ignored: Vitest applies it to every project, the one-at-a-time ones included. --workers bounds the parallel suites.',
    );
  }
  const longOwed = choices
    .filter((choice) => choice.mode !== 'none' && !runs(choice))
    .map((choice) => choice.target);
  if (options.dryRun) return 0;

  const untouched = untouchedTargets(choices, changes);
  const reached = choices.filter((choice) => choice.mode !== 'none' && runs(choice));
  const deferredProjects = reached.flatMap((choice) => choice.deferred ?? []);
  if (reached.length === 0) {
    recordTargets(root, untouched, now, 'affected');
    console.log('');
    for (const line of renderReport({
      outcomes: [],
      longOwed,
      deferredProjects,
      unsettled: [],
      elapsedMs: Date.now() - started,
    }))
      console.log(line);
    return 0;
  }

  const logs = join(tmpdir(), 'melarc-affected', new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(logs, { recursive: true });
  const env = childEnvironment(process.env, options.workers);
  const needs = new Set(reached.flatMap((choice) => needsOf(choice)));
  const blocked = new Map<Need, { readonly status: OutcomeStatus; readonly note: string }>();
  if (needs.has('database')) {
    const probe = spawnSync('pnpm run infra:check', {
      cwd: root,
      shell: true,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (probe.status !== 0) {
      blocked.set('database', {
        status: 'not-run',
        note: 'the database does not answer (pnpm run infra:check says why; the developer starts it)',
      });
    }
  }
  if (needs.has('jdk')) {
    const block = jdkBlock(checkJdk(root, process.env, process.platform, runProgram));
    if (block !== undefined) blocked.set('jdk', block);
  }
  console.log('');
  const wantBuild = reached.some((choice) => {
    const own = needsOf(choice);
    return own.includes('api-build') && !own.some((need) => blocked.has(need));
  });
  if (wantBuild) {
    console.log(
      'Building the API for the tests that run it (turbo, cached when nothing changed)...',
    );
    const log = join(logs, 'api-build.log');
    const code = await runStep(
      {
        label: 'turbo run build --filter=@melarc/api',
        shell: 'pnpm exec turbo run build --filter=@melarc/api --output-logs=errors-only',
        cwd: root,
      },
      log,
      env,
    );
    // An API that does not build is a failure of the change, not of the machine.
    if (code !== 0)
      blocked.set('api-build', { status: 'failed', note: `the API did not build (${log})` });
  }
  const freeGb = freemem() / 1024 ** 3;
  if (freeGb < 2) {
    console.log(
      `Warning: only ${freeGb.toFixed(1)} GB of memory is free. A test whose worker cannot start, or that times out, may be the machine's.`,
    );
  }

  const outcomes: Outcome[] = [];
  let unsettled: string[] = [];
  for (const choice of reached) {
    const stop = needsOf(choice)
      .map((need) => blocked.get(need))
      .find((reason) => reason !== undefined);
    if (stop !== undefined) {
      outcomes.push({ target: choice.target, status: stop.status, note: stop.note });
      console.log(
        `  ${choice.target}: ${stop.status === 'failed' ? 'FAILED' : 'not run'}: ${stop.note}`,
      );
      continue;
    }
    const log = join(logs, `${choice.target}.log`);
    const at = Date.now();
    console.log(`  ${choice.target}: running`);
    let status: OutcomeStatus = 'passed';
    for (const step of stepsFor(choice, root)) {
      status = outcomeOf(step, await runStep(step, log, env));
      if (status !== 'passed') break;
    }
    if (unsettled.length === 0) unsettled = baselineChanges(root, snapshot);
    const said =
      status === 'passed'
        ? 'passed'
        : status === 'failed'
          ? 'FAILED'
          : 'not run (it could not start here)';
    console.log(`  ${choice.target}: ${said} after ${clock(Date.now() - at)} (log: ${log})`);
    outcomes.push({
      target: choice.target,
      status,
      note: status === 'not-run' ? `it could not start here; ${log}` : log,
    });
    if (status !== 'passed') {
      console.log('');
      console.log(tailOf(log, 40));
      console.log('');
    }
  }

  const passed = outcomes
    .filter((outcome) => outcome.status === 'passed')
    .map((outcome) => outcome.target);
  if (unsettled.length === 0) recordTargets(root, [...passed, ...untouched], now, 'affected');
  console.log('');
  for (const line of renderReport({
    outcomes,
    longOwed,
    deferredProjects,
    unsettled,
    elapsedMs: Date.now() - started,
  }))
    console.log(line);
  return exitCodeOf(outcomes, unsettled);
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), resolve(import.meta.dirname, '..'));
}
