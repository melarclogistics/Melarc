import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  expandSteps,
  readLocalActions,
  workflowSteps,
  type LocalActions,
} from './composite-actions.ts';
import { inputsOf, isAction, isRecord, type Step } from './workflow-shapes.ts';

export type PinProblemCode =
  | 'NODE_VERSION_FORMAT'
  | 'ENGINES_NODE_FORMAT'
  | 'NODE_OUTSIDE_ENGINES'
  | 'PACKAGE_MANAGER_FORMAT'
  | 'CI_NODE_PIN'
  | 'CI_PNPM_PIN'
  | 'CI_FROZEN_INSTALL'
  | 'CI_ACTION_UNPINNED'
  | 'CI_LOCAL_ACTION_MISSING';

export interface PinProblem {
  code: PinProblemCode;
  message: string;
}

export interface PinInputs {
  /** Contents of `.node-version`. */
  nodeVersionFile: string;
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

function readsNodeVersionFile(step: Step): boolean {
  const inputs = inputsOf(step);
  return inputs['node-version-file'] === '.node-version' && !('node-version' in inputs);
}

const FROZEN_INSTALL = /\bpnpm\s+(?:install\b[^\n]*--frozen-lockfile|ci)\b/;
const FULL_COMMIT_SHA = /@[0-9a-f]{40}$/;

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

  const pnpmSetups = steps.filter((step) => isAction(step, 'pnpm/action-setup'));
  if (pnpmSetups.length === 0 || pnpmSetups.some((step) => 'version' in inputsOf(step))) {
    problems.push({
      code: 'CI_PNPM_PIN',
      message: 'CI needs pnpm/action-setup without a version input, so it uses packageManager.',
    });
  }

  const runs = steps.map((step) => step.run).filter((run) => typeof run === 'string');
  if (!runs.some((run) => FROZEN_INSTALL.test(run))) {
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
    ...checkCiWorkflowPins(inputs.ciWorkflow, inputs.localActions ?? {}),
  ];
}

/** Reads the real pin sources from a repository root. A missing file is an error, not a pass. */
export function readPinInputs(rootDir: string): PinInputs {
  const ciWorkflow = readFileSync(join(rootDir, '.github', 'workflows', 'ci.yml'), 'utf8');
  return {
    nodeVersionFile: readFileSync(join(rootDir, '.node-version'), 'utf8'),
    packageJson: JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8')) as unknown,
    ciWorkflow,
    localActions: readLocalActions(rootDir, workflowSteps(ciWorkflow)),
  };
}
