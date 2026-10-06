/**
 * The dependency policy, held to the files that state it: package.json of the root and of every workspace package,
 * pnpm-workspace.yaml and pnpm-lock.yaml. Nothing is installed or downloaded.
 *
 *   - every dependency is an exact version (or `workspace:*` for a package of this repository): no range, tag,
 *     alias, git URL, tarball URL, `file:` or `link:`, so what runs is what was reviewed and a lockfile refresh
 *     cannot move it;
 *   - nothing rewrites what the lockfile resolves or what the install does: no overrides, resolutions, patches,
 *     package extensions or pnpmfile, in package.json files, pnpm-workspace.yaml, the lockfile or on disk;
 *   - dependency build scripts run only when approved, and none is: `allowBuilds` may hold `false` values only;
 *   - the lockfile resolves every package from the registry, with an integrity hash: no git, tarball URL, `file:`
 *     or directory source, and a `link:` only to a package of this workspace.
 *
 * The Node.js and pnpm pins and the CI install are held by workspace-pins.ts, not here.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

import { parse } from 'yaml';

import { isRecord } from './workflow-shapes.ts';
import { workspaceDirectories } from './test-inventory.ts';

export type PolicyProblemCode =
  | 'SPECIFIER_NOT_EXACT'
  | 'FORBIDDEN_SETTING'
  | 'BUILD_ALLOWED'
  | 'CUSTOMISATION_FILE'
  | 'LOCK_UNREADABLE'
  | 'LOCK_SOURCE'
  | 'LOCK_LINK';

export interface PolicyProblem {
  code: PolicyProblemCode;
  message: string;
}

export interface PolicyInputs {
  /** The parsed package.json of the root and of every workspace package, by path (`apps/api/package.json`). */
  packageJsons: Readonly<Record<string, unknown>>;
  workspaceYaml: string;
  lockfile: string;
  /** The folders of the workspace packages (`apps/api`). */
  workspaceDirectories: readonly string[];
  /** Which of the customisation files exist in the repository root. */
  customisationFiles: readonly string[];
}

/** pnpm's customisation files: code or patches that change what an install does. */
export const CUSTOMISATION_FILES: readonly string[] = [
  '.pnpmfile.cjs',
  '.pnpmfile.mjs',
  'pnpmfile.cjs',
  'pnpmfile.mjs',
  'patches',
];

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];
/** Settings that rewrite what is resolved, or what an install does, wherever they are written. */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  'overrides',
  'resolutions',
  'patchedDependencies',
  'packageExtensions',
  'pnpmfile',
  'globalPnpmfile',
  'pnpmfileChecksum',
  'packageExtensionsChecksum',
]);

const SEMVER = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?`;
const EXACT_VERSION = new RegExp(`^${SEMVER}$`);
/** A lockfile entry key: `name@version`, a snapshot's also followed by the peers it was resolved with. */
const PACKAGE_KEY = new RegExp(`^(?:@[^/@]+/)?[^/@]+@${SEMVER}$`);
const SNAPSHOT_KEY = new RegExp(`^(?:@[^/@]+/)?[^/@]+@${SEMVER}(?:\\(.*\\))?$`);
const INTEGRITY = /^sha(?:256|384|512)-\S+$/;
const WORKSPACE = 'workspace:*';

const exact = (specifier: unknown): boolean =>
  typeof specifier === 'string' && (EXACT_VERSION.test(specifier) || specifier === WORKSPACE);

/**
 * The places where a document keeps settings: its top level and the maps that package.json (`pnpm`, `config`) and
 * the lockfile (`settings`) put them in. The maps of dependencies are not searched: a package may be named
 * `overrides`.
 */
const SETTING_MAPS = ['pnpm', 'config', 'settings'];

function forbiddenSettings(where: string, document: unknown): PolicyProblem[] {
  if (!isRecord(document)) return [];
  const maps: [prefix: string, map: unknown][] = [
    ['', document],
    ...SETTING_MAPS.map((name): [string, unknown] => [`${name}.`, document[name]]),
  ];
  return maps.flatMap(([prefix, map]) =>
    Object.keys(isRecord(map) ? map : {})
      .filter((key) => FORBIDDEN_KEYS.has(key))
      .map((key) => ({
        code: 'FORBIDDEN_SETTING' as const,
        message: `${where} sets ${prefix}${key}: nothing may rewrite what is resolved or what an install does.`,
      })),
  );
}

function specifierProblems(path: string, json: unknown): PolicyProblem[] {
  const problems: PolicyProblem[] = [];
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = isRecord(json) ? json[field] : undefined;
    if (!isRecord(dependencies)) continue;
    for (const [name, specifier] of Object.entries(dependencies)) {
      if (!exact(specifier)) {
        problems.push({
          code: 'SPECIFIER_NOT_EXACT',
          message: `${path}: ${field}.${name} is ${JSON.stringify(specifier)}; use an exact version such as 1.2.3 (or ${WORKSPACE} for a package of this repository).`,
        });
      }
    }
  }
  return problems;
}

function workspaceProblems(yaml: string): PolicyProblem[] {
  const workspace: unknown = parse(yaml);
  const problems = forbiddenSettings('pnpm-workspace.yaml', workspace);
  const settings = isRecord(workspace) ? workspace : {};

  const allowBuilds = settings.allowBuilds;
  if (allowBuilds !== undefined) {
    const entries = isRecord(allowBuilds) ? Object.entries(allowBuilds) : [['(not a map)', true]];
    for (const [name, allowed] of entries.filter(([, value]) => value !== false)) {
      problems.push({
        code: 'BUILD_ALLOWED',
        message: `pnpm-workspace.yaml allowBuilds lets ${String(name)} run its build script (${JSON.stringify(allowed)}); only false is allowed.`,
      });
    }
  }
  const only = settings.onlyBuiltDependencies;
  if (only !== undefined && !(Array.isArray(only) && only.length === 0)) {
    problems.push({
      code: 'BUILD_ALLOWED',
      message:
        'pnpm-workspace.yaml onlyBuiltDependencies approves build scripts; it must be empty or absent.',
    });
  }
  if (
    settings.dangerouslyAllowAllBuilds !== undefined &&
    settings.dangerouslyAllowAllBuilds !== false
  ) {
    problems.push({
      code: 'BUILD_ALLOWED',
      message: 'pnpm-workspace.yaml dangerouslyAllowAllBuilds approves every build script.',
    });
  }
  return problems;
}

/** Where a `link:` version in an importer leads: relative to that importer's folder, from the repository root. */
const linkTarget = (importer: string, version: string): string =>
  posix.normalize(posix.join(importer, version.slice('link:'.length)));

function importerProblems(
  lock: Record<string, unknown>,
  directories: readonly string[],
): PolicyProblem[] {
  const problems: PolicyProblem[] = [];
  const importers = isRecord(lock.importers) ? lock.importers : {};
  for (const [importer, sections] of Object.entries(importers)) {
    for (const [section, entries] of Object.entries(isRecord(sections) ? sections : {})) {
      if (!isRecord(entries)) continue;
      for (const [name, entry] of Object.entries(entries)) {
        const specifier = isRecord(entry) ? entry.specifier : undefined;
        const version = isRecord(entry) ? entry.version : undefined;
        const where = `pnpm-lock.yaml ${importer} ${section}.${name}`;
        if (!exact(specifier)) {
          problems.push({
            code: 'SPECIFIER_NOT_EXACT',
            message: `${where} was locked from the specifier ${JSON.stringify(specifier)}, which is not an exact version.`,
          });
        }
        if (typeof version !== 'string') {
          problems.push({ code: 'LOCK_SOURCE', message: `${where} has no version.` });
        } else if (version.startsWith('link:')) {
          const target = linkTarget(importer, version);
          if (specifier !== WORKSPACE || !directories.includes(target)) {
            problems.push({
              code: 'LOCK_LINK',
              message: `${where} links to ${target}, which is not a package of this workspace declared as ${WORKSPACE}.`,
            });
          }
        } else if (!EXACT_VERSION.test(version.replace(/\(.*$/, ''))) {
          problems.push({
            code: 'LOCK_SOURCE',
            message: `${where} resolves to ${version}, which is not a registry version.`,
          });
        }
      }
    }
  }
  return problems;
}

function packageProblems(lock: Record<string, unknown>): PolicyProblem[] {
  const problems: PolicyProblem[] = [];
  const packages = isRecord(lock.packages) ? lock.packages : {};
  for (const [key, entry] of Object.entries(packages)) {
    if (!PACKAGE_KEY.test(key)) {
      problems.push({
        code: 'LOCK_SOURCE',
        message: `pnpm-lock.yaml packages: ${key} is not a name and an exact registry version (a git, tarball, file or alias source).`,
      });
    }
    const resolution = isRecord(entry) ? entry.resolution : undefined;
    const keys = isRecord(resolution) ? Object.keys(resolution) : [];
    const integrity = isRecord(resolution) ? resolution.integrity : undefined;
    if (keys.length !== 1 || typeof integrity !== 'string' || !INTEGRITY.test(integrity)) {
      problems.push({
        code: 'LOCK_SOURCE',
        message: `pnpm-lock.yaml packages: ${key} is resolved by ${keys.join(', ') || 'nothing'}; a registry package is resolved by an integrity hash alone.`,
      });
    }
  }
  for (const key of Object.keys(isRecord(lock.snapshots) ? lock.snapshots : {})) {
    if (!SNAPSHOT_KEY.test(key)) {
      problems.push({
        code: 'LOCK_SOURCE',
        message: `pnpm-lock.yaml snapshots: ${key} is not a name and an exact registry version.`,
      });
    }
  }
  return problems;
}

function lockProblems(text: string, directories: readonly string[]): PolicyProblem[] {
  const lock: unknown = parse(text);
  const importers = isRecord(lock) && isRecord(lock.importers) ? lock.importers : {};
  const packages = isRecord(lock) && isRecord(lock.packages) ? lock.packages : {};
  if (
    !isRecord(lock) ||
    Object.keys(importers).length === 0 ||
    Object.keys(packages).length === 0
  ) {
    return [
      {
        code: 'LOCK_UNREADABLE',
        message: 'pnpm-lock.yaml has no importers or no packages, so there is nothing to check.',
      },
    ];
  }
  return [
    ...forbiddenSettings('pnpm-lock.yaml', lock),
    ...importerProblems(lock, directories),
    ...packageProblems(lock),
  ];
}

/** Every way the dependency policy is broken; empty means it holds. */
export function findPolicyProblems(inputs: PolicyInputs): PolicyProblem[] {
  return [
    ...Object.entries(inputs.packageJsons).flatMap(([path, json]) => [
      ...specifierProblems(path, json),
      ...forbiddenSettings(path, json),
    ]),
    ...workspaceProblems(inputs.workspaceYaml),
    ...lockProblems(inputs.lockfile, inputs.workspaceDirectories),
    ...inputs.customisationFiles.map((file) => ({
      code: 'CUSTOMISATION_FILE' as const,
      message: `${file} exists in the repository root: it changes what an install does.`,
    })),
  ];
}

/** Reads the policy's sources from a repository root. A missing file is an error, not a pass. */
export function readPolicyInputs(root: string): PolicyInputs {
  const directories = workspaceDirectories(root);
  const packageJsons: Record<string, unknown> = {};
  for (const path of ['package.json', ...directories.map((dir) => `${dir}/package.json`)]) {
    packageJsons[path] = JSON.parse(readFileSync(join(root, path), 'utf8')) as unknown;
  }
  return {
    packageJsons,
    workspaceYaml: readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8'),
    lockfile: readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'),
    workspaceDirectories: directories,
    customisationFiles: CUSTOMISATION_FILES.filter((file) => existsSync(join(root, file))),
  };
}
