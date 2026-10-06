/**
 * The verdict of the CI pipeline: one job that waits for every mandatory job and fails unless each one
 * succeeded. It is the single check a branch rule requires, so it must fail closed:
 *
 *   - a job that failed, was cancelled or was skipped is not a success (GitHub treats a skipped required
 *     check as passed, so skipping must not be a way through);
 *   - a mandatory job missing from `needs`, or one `needs` holds that nobody expected, means the workflow and
 *     this check have drifted apart, and the result cannot be trusted;
 *   - unreadable input, or no expected job at all, fails rather than passing for lack of anything to check.
 *
 * `scripts/ci-workflow.test.ts` holds the workflow to the same list: the aggregate job's `needs`, this
 * command's arguments and the workflow's jobs must name the same jobs.
 *
 * Usage (in the workflow): NEEDS='${{ toJSON(needs) }}' node scripts/ci-aggregate.ts <job id>...
 */

import { isRecord } from './workflow-shapes.ts';

export type AggregateProblemCode =
  'NO_EXPECTED_JOBS' | 'NEEDS_UNREADABLE' | 'JOB_MISSING' | 'JOB_UNEXPECTED' | 'JOB_NOT_SUCCESSFUL';

export interface AggregateProblem {
  code: AggregateProblemCode;
  job?: string;
  message: string;
}

export interface JobVerdict {
  job: string;
  /** What GitHub reported, or `(none)` when the entry carried no readable result. */
  result: string;
}

export interface Aggregation {
  verdicts: JobVerdict[];
  problems: AggregateProblem[];
}

function parseNeeds(needsJson: string | undefined): Record<string, unknown> | undefined {
  if (needsJson === undefined || needsJson.trim() === '') return undefined;
  try {
    const parsed: unknown = JSON.parse(needsJson);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function resultOf(entry: unknown): string | undefined {
  const result = isRecord(entry) ? entry.result : undefined;
  return typeof result === 'string' ? result : undefined;
}

/** Judges the `needs` context (as JSON) against the jobs the pipeline must have run. */
export function aggregate(
  needsJson: string | undefined,
  expectedJobs: readonly string[],
): Aggregation {
  const verdicts: JobVerdict[] = [];
  const problems: AggregateProblem[] = [];
  const expected = [...new Set(expectedJobs)];

  if (expected.length === 0) {
    problems.push({
      code: 'NO_EXPECTED_JOBS',
      message:
        'No mandatory job was named, so there is nothing to judge. Name every mandatory job.',
    });
  }

  const needs = parseNeeds(needsJson);
  if (needs === undefined) {
    problems.push({
      code: 'NEEDS_UNREADABLE',
      message:
        'The needs context is missing or is not a JSON object, so no job result can be read.',
    });
    return { verdicts, problems };
  }

  for (const job of expected) {
    if (!Object.hasOwn(needs, job)) {
      problems.push({
        code: 'JOB_MISSING',
        job,
        message: `Mandatory job "${job}" is not in the needs context. Add it to the aggregate job's needs.`,
      });
      continue;
    }
    const result = resultOf(needs[job]) ?? '(none)';
    verdicts.push({ job, result });
    if (result !== 'success') {
      problems.push({
        code: 'JOB_NOT_SUCCESSFUL',
        job,
        message: `Mandatory job "${job}" finished with the result ${result}, not success.`,
      });
    }
  }

  for (const job of Object.keys(needs)) {
    if (!expected.includes(job)) {
      problems.push({
        code: 'JOB_UNEXPECTED',
        job,
        message: `The needs context holds job "${job}", which this check was not told to expect. Name it, or remove it from needs.`,
      });
    }
  }

  return { verdicts, problems };
}

export function renderReport({ verdicts, problems }: Aggregation): string {
  const width = Math.max(0, ...verdicts.map(({ job }) => job.length));
  const rows = verdicts.map(({ job, result }) => `  ${job.padEnd(width)}  ${result}`);
  const verdict = problems.length === 0 ? 'CI result: passed' : 'CI result: FAILED';
  return [...rows, verdict].join('\n');
}

/** Runs the check for the command line: prints the report, annotates each problem, and returns the exit status. */
export function runAggregate(
  expectedJobs: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  print: (line: string) => void,
): number {
  const aggregation = aggregate(env.NEEDS, expectedJobs);
  print(renderReport(aggregation));
  for (const problem of aggregation.problems) {
    print(`::error title=CI result::${problem.message}`);
  }
  return aggregation.problems.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = runAggregate(process.argv.slice(2), process.env, (line) => {
    console.log(line);
  });
}
