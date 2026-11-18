import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse } from 'yaml';

import {
  expandSteps,
  readLocalActions,
  workflowSteps,
  type LocalActions,
} from './composite-actions.ts';
import { inputsOf, isAction, isRecord, stepsOf, type Step } from './workflow-shapes.ts';

export type PinProblemCode =
  | 'NODE_VERSION_FORMAT'
  | 'ENGINES_NODE_FORMAT'
  | 'NODE_OUTSIDE_ENGINES'
  | 'PACKAGE_MANAGER_FORMAT'
  | 'JAVA_VERSION_FORMAT'
  | 'CI_NODE_PIN'
  | 'CI_JAVA_PIN'
  | 'CI_PNPM_PIN'
  | 'CI_FROZEN_INSTALL'
  | 'CI_APT_MIRROR'
  | 'CI_ACTION_UNPINNED'
  | 'CI_LOCAL_ACTION_MISSING';

export interface PinProblem {
  code: PinProblemCode;
  message: string;
}

export interface PinInputs {
  /** Contents of `.node-version`. */
  nodeVersionFile: string;
  /** Contents of `.java-version`, the JDK of the attestation verifier (S0.55). */
  javaVersionFile: string;
  /** Parsed contents of the root `package.json`. */
  packageJson: unknown;
  /** Contents of `.github/workflows/ci.yml`. */
  ciWorkflow: string;
  /**
   * Contents of the composite actions the workflow uses from this repository, by the `uses` path that names
   * them (`./.github/actions/setup`). Their steps count as the workflow's own, so a pin cannot be moved out of
   * the check's sight by moving it into a shared action.
   */
  localActions?: LocalActions;
}

type Version = readonly [major: number, minor: number, patch: number];

const EXACT_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const CARET_VERSION = /^\^(\d+)\.(\d+)\.(\d+)$/;
/** An exact pnpm version, optionally followed by the integrity hash Corepack writes. */
const PNPM_PIN = /^pnpm@\d+\.\d+\.\d+(\+sha\d+\.[0-9a-f]+)?$/;

function parseVersion(pattern: RegExp, text: string): Version | undefined {
  const match = pattern.exec(text);
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** `^floor` accepts the floor itself and anything newer within the same major version. */
function satisfiesCaret(version: Version, floor: Version): boolean {
  const [major, minor, patch] = version;
  const [floorMajor, floorMinor, floorPatch] = floor;
  if (major !== floorMajor) return false;
  return minor > floorMinor || (minor === floorMinor && patch >= floorPatch);
}

function checkNodePin(nodeVersionFile: string, packageJson: unknown): PinProblem[] {
  const problems: PinProblem[] = [];

  const pinned = parseVersion(EXACT_VERSION, nodeVersionFile.trim());
  if (pinned === undefined) {
    problems.push({
      code: 'NODE_VERSION_FORMAT',
      message: '.node-version must contain one exact version such as 24.15.0.',
    });
  }

  const engines = isRecord(packageJson) ? packageJson.engines : undefined;
  const enginesNode = isRecord(engines) ? engines.node : undefined;
  const floor =
    typeof enginesNode === 'string' ? parseVersion(CARET_VERSION, enginesNode) : undefined;
  if (floor === undefined) {
    problems.push({
      code: 'ENGINES_NODE_FORMAT',
      message: 'package.json engines.node must be a caret range such as ^24.15.0.',
    });
  }

  if (pinned !== undefined && floor !== undefined && !satisfiesCaret(pinned, floor)) {
    problems.push({
      code: 'NODE_OUTSIDE_ENGINES',
      message: `.node-version ${pinned.join('.')} is outside package.json engines.node ${String(enginesNode)}.`,
    });
  }

  return problems;
}

function checkPackageManagerPin(packageJson: unknown): PinProblem[] {
  const packageManager = isRecord(packageJson) ? packageJson.packageManager : undefined;
  if (typeof packageManager === 'string' && PNPM_PIN.test(packageManager)) return [];
  return [
    {
      code: 'PACKAGE_MANAGER_FORMAT',
      message: 'package.json packageManager must pin an exact pnpm version such as pnpm@11.1.3.',
    },
  ];
}

function checkJavaPin(javaVersionFile: string): PinProblem[] {
  if (parseVersion(EXACT_VERSION, javaVersionFile.trim()) !== undefined) return [];
  return [
    {
      code: 'JAVA_VERSION_FORMAT',
      message: '.java-version must contain one exact version such as 21.0.12.',
    },
  ];
}

function readsNodeVersionFile(step: Step): boolean {
  const inputs = inputsOf(step);
  return inputs['node-version-file'] === '.node-version' && !('node-version' in inputs);
}

/** The JDK comes from `.java-version`, from Temurin (the distribution the tests ran on), and from nothing else. */
function readsJavaVersionFile(step: Step): boolean {
  const inputs = inputsOf(step);
  return (
    inputs['java-version-file'] === '.java-version' &&
    !('java-version' in inputs) &&
    inputs.distribution === 'temurin'
  );
}

const FULL_COMMIT_SHA = /@[0-9a-f]{40}$/;

/** The lines of a script, a line continued by a trailing backslash joined to the next. */
function commandLines(script: string): string[] {
  return script.replace(/\\\r?\n/g, ' ').split(/\r?\n/);
}

/** The freeze switched off: `--no-frozen-lockfile`, or `--frozen-lockfile=` with any value but `true`. */
const FREEZE_OFF = /--no-frozen-lockfile|--frozen-lockfile=(?!true(?:\s|$))/;

/**
 * Whether a command line is, from its first word, a frozen install: `pnpm ci`, or `pnpm install` with
 * `--frozen-lockfile` (or `=true`). A line that only mentions the command (in an echo, a comment, a condition or
 * after another command) is not one; neither is a line that turns the freeze off anywhere (`&& pnpm install
 * --no-frozen-lockfile`) or answers the failure of the frozen install with another command (`||`).
 */
function isFrozenInstall(line: string): boolean {
  const code = line.replace(/\s#.*$/, '');
  if (code.includes('||') || FREEZE_OFF.test(code)) return false;
  const command = (code.split(/&&|;|\||&/)[0] ?? '').trim();
  const [program, subcommand, ...flags] = command.split(/\s+/);
  if (program !== 'pnpm') return false;
  if (subcommand === 'ci') return true;
  return (
    subcommand === 'install' &&
    flags.some((flag) => flag === '--frozen-lockfile' || flag === '--frozen-lockfile=true')
  );
}

const APT_MIRRORS_FILE = '/etc/apt/apt-mirrors.txt';
/** The package mirror that was fast from every runner, the Amazon ones included, when it was measured (18 November 2026): the setup action puts it first. */
const FAST_PACKAGE_MIRROR = 'http://azure.archive.ubuntu.com/ubuntu/';

/** Whether a step installs a package with apt, directly or as Playwright does for the browsers' system libraries (`install --with-deps`, `install-deps`). */
function usesApt(step: Step): boolean {
  if (typeof step.run !== 'string') return false;
  return commandLines(step.run).some((line) => {
    const code = line.replace(/\s#.*$/, '').trim();
    return (
      /(?:^|[\s;&|])apt(?:-get)?\s+(?:install|update|upgrade)\b/.test(code) ||
      /\bplaywright\s+(?:install\s+[^\n]*--with-deps|install-deps)\b/.test(code)
    );
  });
}

/**
 * Whether a step puts the fast mirror first in apt's list of mirrors: a privileged command (`sudo ...`) writes the real list, the mirror is named in the step's commands (not in a comment),
 * and no condition can skip it, `continue-on-error` cannot pass it over and no `||` answers a failure with another command. A step that only echoes the names is not one.
 */
function pinsPackageMirror(step: Step): boolean {
  if (typeof step.run !== 'string' || 'if' in step || 'continue-on-error' in step) return false;
  const lines = commandLines(step.run)
    .map((line) => line.replace(/\s#.*$/, ''))
    .filter((line) => !line.trim().startsWith('#'));
  const code = lines.join('\n');
  const writesTheList = lines.some(
    (line) => /^\s*sudo\s/.test(line) && line.includes(APT_MIRRORS_FILE),
  );
  return writesTheList && code.includes(FAST_PACKAGE_MIRROR) && !code.includes('||');
}

/**
 * Every job that installs a package with apt puts the fast mirror first before its first such step. Hosted runners come from two clouds under one label, and the default mirror of the Amazon
 * ones gave a WebKit job its system libraries at 93 kB/s (22 minutes, the job cancelled at its limit, three times running): which cloud a job lands on is luck, so no job may take the default.
 */
function checkAptMirror(ciWorkflow: string, localActions: LocalActions): PinProblem[] {
  const workflow: unknown = parse(ciWorkflow);
  const jobs = isRecord(workflow) && isRecord(workflow.jobs) ? workflow.jobs : {};
  const problems: PinProblem[] = [];
  for (const [id, job] of Object.entries(jobs)) {
    const steps = expandSteps(stepsOf(job), localActions, new Set<string>());
    const first = steps.findIndex(usesApt);
    if (first !== -1 && !steps.slice(0, first).some(pinsPackageMirror)) {
      problems.push({
        code: 'CI_APT_MIRROR',
        message: `Job ${id} installs a package with apt before any step has put ${FAST_PACKAGE_MIRROR} first in ${APT_MIRRORS_FILE} (the setup action does, and every such job starts with it): the default mirror of an Amazon runner is slow enough to cancel a job.`,
      });
    }
  }
  return problems;
}

function checkCiWorkflowPins(ciWorkflow: string, localActions: LocalActions): PinProblem[] {
  const missing = new Set<string>();
  const steps = expandSteps(workflowSteps(ciWorkflow), localActions, missing);
  const problems: PinProblem[] = [];

  if (missing.size > 0) {
    problems.push({
      code: 'CI_LOCAL_ACTION_MISSING',
      message: `The workflow uses local actions that cannot be read, so their steps are unchecked: ${[...missing].join(', ')}.`,
    });
  }

  const nodeSetups = steps.filter((step) => isAction(step, 'actions/setup-node'));
  if (nodeSetups.length === 0 || !nodeSetups.every(readsNodeVersionFile)) {
    problems.push({
      code: 'CI_NODE_PIN',
      message: 'Every actions/setup-node step must read .node-version and set no node-version.',
    });
  }

  const javaSetups = steps.filter((step) => isAction(step, 'actions/setup-java'));
  if (javaSetups.length === 0 || !javaSetups.every(readsJavaVersionFile)) {
    problems.push({
      code: 'CI_JAVA_PIN',
      message:
        'Every actions/setup-java step must read .java-version, set no java-version and use the temurin distribution, and CI needs one (the attestation verifier is built and tested there).',
    });
  }

  const pnpmSetups = steps.filter((step) => isAction(step, 'pnpm/action-setup'));
  if (pnpmSetups.length === 0 || pnpmSetups.some((step) => 'version' in inputsOf(step))) {
    problems.push({
      code: 'CI_PNPM_PIN',
      message: 'CI needs pnpm/action-setup without a version input, so it uses packageManager.',
    });
  }

  const runs = steps.map((step) => step.run).filter((run) => typeof run === 'string');
  if (!runs.some((run) => commandLines(run).some(isFrozenInstall))) {
    problems.push({
      code: 'CI_FROZEN_INSTALL',
      message: 'CI must install with pnpm install --frozen-lockfile (or pnpm ci).',
    });
  }

  const unpinned = steps
    .flatMap((step) => (typeof step.uses === 'string' ? [step.uses] : []))
    .filter((uses) => !uses.startsWith('./') && !FULL_COMMIT_SHA.test(uses));
  if (unpinned.length > 0) {
    problems.push({
      code: 'CI_ACTION_UNPINNED',
      message: `Pin these actions to a full commit SHA: ${unpinned.join(', ')}.`,
    });
  }

  return problems;
}

export function findPinProblems(inputs: PinInputs): PinProblem[] {
  return [
    ...checkNodePin(inputs.nodeVersionFile, inputs.packageJson),
    ...checkPackageManagerPin(inputs.packageJson),
    ...checkJavaPin(inputs.javaVersionFile),
    ...checkCiWorkflowPins(inputs.ciWorkflow, inputs.localActions ?? {}),
    ...checkAptMirror(inputs.ciWorkflow, inputs.localActions ?? {}),
  ];
}

/** Reads the real pin sources from a repository root. A missing file is an error, not a pass. */
export function readPinInputs(rootDir: string): PinInputs {
  const ciWorkflow = readFileSync(join(rootDir, '.github', 'workflows', 'ci.yml'), 'utf8');
  return {
    nodeVersionFile: readFileSync(join(rootDir, '.node-version'), 'utf8'),
    javaVersionFile: readFileSync(join(rootDir, '.java-version'), 'utf8'),
    packageJson: JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8')) as unknown,
    ciWorkflow,
    localActions: readLocalActions(rootDir, workflowSteps(ciWorkflow)),
  };
}
