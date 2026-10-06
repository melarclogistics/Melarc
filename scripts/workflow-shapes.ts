/** Helpers for reading GitHub Actions files (workflows and composite actions) as untyped YAML. */

export type Step = Record<string, unknown>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A job's steps; a job without a steps list yields none. */
export function stepsOf(job: unknown): Step[] {
  const steps = isRecord(job) ? job.steps : undefined;
  return Array.isArray(steps) ? steps.filter(isRecord) : [];
}

export function isAction(step: Step, action: string): boolean {
  return typeof step.uses === 'string' && step.uses.startsWith(`${action}@`);
}

export function inputsOf(step: Step): Record<string, unknown> {
  return isRecord(step.with) ? step.with : {};
}
