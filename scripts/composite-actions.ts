/**
 * The composite actions a workflow uses from this repository (`uses: ./.github/actions/setup`). The checks on a
 * workflow's steps must also see the steps inside those actions, or a pin or a rule could be moved out of their
 * sight by moving it into a shared action.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse } from 'yaml';

import { isRecord, stepsOf, type Step } from './workflow-shapes.ts';

/** The contents of each local action's file, by the `uses` path that names it. */
export type LocalActions = Readonly<Record<string, string>>;

export const isLocalAction = (uses: unknown): uses is string =>
  typeof uses === 'string' && uses.startsWith('./');

/** Every step of every job; an empty or job-less workflow yields no steps. */
export function workflowSteps(workflowText: string): Step[] {
  const workflow: unknown = parse(workflowText);
  const jobs = isRecord(workflow) ? workflow.jobs : undefined;
  if (!isRecord(jobs)) return [];
  return Object.values(jobs).flatMap(stepsOf);
}

/** The steps of a composite action's file; any other shape of file yields none. */
export function compositeSteps(actionFile: string): Step[] {
  const action: unknown = parse(actionFile);
  return stepsOf(isRecord(action) ? action.runs : undefined);
}

/**
 * The steps themselves followed, wherever one uses a local action, by that action's steps. The local actions
 * that could not be read are collected in `missing`. An action already being expanded is not entered again.
 */
export function expandSteps(
  steps: readonly Step[],
  localActions: LocalActions,
  missing: Set<string>,
  inProgress: readonly string[] = [],
): Step[] {
  return steps.flatMap((step) => {
    const uses = step.uses;
    if (!isLocalAction(uses)) return [step];
    const actionFile = Object.hasOwn(localActions, uses) ? localActions[uses] : undefined;
    if (actionFile === undefined) {
      missing.add(uses);
      return [step];
    }
    if (inProgress.includes(uses)) return [step];
    return [
      step,
      ...expandSteps(compositeSteps(actionFile), localActions, missing, [...inProgress, uses]),
    ];
  });
}

/** Reads the file of a local action (`./path` names the folder holding `action.yml`), or undefined. */
function readLocalAction(rootDir: string, uses: string): string | undefined {
  for (const name of ['action.yml', 'action.yaml']) {
    try {
      return readFileSync(join(rootDir, uses, name), 'utf8');
    } catch {
      // Try the other spelling; a folder with neither is reported by the checks as a missing action.
    }
  }
  return undefined;
}

/** The local actions the steps use, and those they use in turn, read from a repository root. */
export function readLocalActions(
  rootDir: string,
  steps: readonly Step[],
  found: Record<string, string> = {},
): LocalActions {
  for (const { uses } of steps) {
    if (!isLocalAction(uses) || Object.hasOwn(found, uses)) continue;
    const actionFile = readLocalAction(rootDir, uses);
    if (actionFile === undefined) continue;
    found[uses] = actionFile;
    readLocalActions(rootDir, compositeSteps(actionFile), found);
  }
  return found;
}
