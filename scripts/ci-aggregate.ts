/**
 * The verdict of the CI pipeline: one job that waits for every mandatory job and fails unless each one
 * succeeded. It is the single check a branch rule requires, so it must fail closed:
 *
 *   - a job that failed, was cancelled or was skipped is not a success (GitHub treats a skipped required
 *     check as passed, so skipping must not be a way through);
 *   - the one allowance is named on the command line (`--skipped-on-pull-request=<job id>[,<job id>...]`): the job of the
 *     Firefox and WebKit shards of the browser tests, which a pull request does not run (the Product Owner's decision of
 *     7 November 2026). Its skip is a success on a pull request, `EVENT` being exactly `pull_request`, and on no other
 *     event: a push to main, the nightly run and a manual run must have run it, and a failed or cancelled job is a failure
 *     whatever the event. A command that names such a job but gives no event fails: it cannot tell which run this is;
 *   - a mandatory job missing from `needs`, or one `needs` holds that nobody expected, means the workflow and
 *     this check have drifted apart, and the result cannot be trusted;
 *   - unreadable input, or no expected job at all, fails rather than passing for lack of anything to check.
 *
 * `scripts/ci-workflow.test.ts` holds the workflow to the same list: the aggregate job's `needs`, this
 * command's arguments and the workflow's jobs must name the same jobs, and the jobs allowed to be skipped are exactly
 * the jobs the workflow does not run on a pull request.
 *
 * Usage (in the workflow):
 *   NEEDS='${{ toJSON(needs) }}' EVENT='${{ github.event_name }}' node scripts/ci-aggregate.ts [--skipped-on-pull-request=<job id>,...] <job id>...
 */

import { isRecord } from './workflow-shapes.ts';

export type AggregateProblemCode =
  | 'NO_EXPECTED_JOBS'
  | 'NEEDS_UNREADABLE'
  | 'JOB_MISSING'
  | 'JOB_UNEXPECTED'
  | 'JOB_NOT_SUCCESSFUL'
  | 'EVENT_UNREADABLE'
  | 'SKIP_JOB_UNKNOWN'
  | 'ARGUMENT_UNREADABLE';

export interface AggregateProblem {
  code: AggregateProblemCode;
  job?: string;
  message: string;
}

export interface JobVerdict {
  job: string;
  /** What GitHub reported, or `(none)` when the entry carried no readable result. */
  result: string;
  /** Set when the result is a skip that the rule allows on a pull request, and so is not a problem. */
  allowed?: true;
}

export interface Aggregation {
  verdicts: JobVerdict[];
  problems: AggregateProblem[];
}

/** What the verdict is told besides the jobs: the event of the run, and the jobs a pull request may leave unrun. */
export interface AggregateOptions {
  /** `github.event_name`. */
  event?: string | undefined;
  skippedOnPullRequest?: readonly string[];
}

/** The only event on which a skipped job can be allowed. */
const PULL_REQUEST = 'pull_request';
const SKIP_OPTION = '--skipped-on-pull-request=';

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
  options: AggregateOptions = {},
): Aggregation {
  const verdicts: JobVerdict[] = [];
  const problems: AggregateProblem[] = [];
  const expected = [...new Set(expectedJobs)];
  const skippable = [...new Set(options.skippedOnPullRequest ?? [])];

  if (expected.length === 0) {
    problems.push({
      code: 'NO_EXPECTED_JOBS',
      message:
        'No mandatory job was named, so there is nothing to judge. Name every mandatory job.',
    });
  }

  // A skip is allowed only when the event is known to be a pull request: a run that cannot say what it is allows nothing.
  const event = options.event;
  if (skippable.length > 0 && (typeof event !== 'string' || event.trim() === '')) {
    problems.push({
      code: 'EVENT_UNREADABLE',
      message:
        'The event of the run is missing (EVENT), so it cannot be told whether a skipped job is allowed. Set EVENT to the event name of the workflow.',
    });
  }
  for (const job of skippable.filter((name) => !expected.includes(name))) {
    problems.push({
      code: 'SKIP_JOB_UNKNOWN',
      job,
      message: `The job "${job}" is allowed to be skipped on a pull request but is not among the mandatory jobs. Name it as a mandatory job, or remove it from the allowance.`,
    });
  }
  const mayBeSkipped = (job: string): boolean => event === PULL_REQUEST && skippable.includes(job);

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
    if (result === 'skipped' && mayBeSkipped(job)) {
      verdicts.push({ job, result, allowed: true });
      continue;
    }
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
  const rows = verdicts.map(({ job, result, allowed }) => {
    const note = allowed === true ? ' (allowed: a pull request does not run it)' : '';
    return `  ${job.padEnd(width)}  ${result}${note}`;
  });
  const verdict = problems.length === 0 ? 'CI result: passed' : 'CI result: FAILED';
  return [...rows, verdict].join('\n');
}

/** The command line: job ids, and the one option that names the jobs a pull request may skip. Anything else is unreadable. */
export interface Arguments {
  jobs: string[];
  skippedOnPullRequest: string[];
  unreadable: string[];
}

export function parseArguments(args: readonly string[]): Arguments {
  const parsed: Arguments = { jobs: [], skippedOnPullRequest: [], unreadable: [] };
  for (const argument of args) {
    if (!argument.startsWith('--')) {
      parsed.jobs.push(argument);
      continue;
    }
    const names = argument.startsWith(SKIP_OPTION)
      ? argument.slice(SKIP_OPTION.length).split(',')
      : [];
    if (names.length === 0 || names.includes('')) parsed.unreadable.push(argument);
    else parsed.skippedOnPullRequest.push(...names);
  }
  return parsed;
}

/** Runs the check for the command line: prints the report, annotates each problem, and returns the exit status. */
export function runAggregate(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  print: (line: string) => void,
): number {
  const parsed = parseArguments(args);
  const aggregation = aggregate(env.NEEDS, parsed.jobs, {
    event: env.EVENT,
    skippedOnPullRequest: parsed.skippedOnPullRequest,
  });
  for (const argument of parsed.unreadable) {
    aggregation.problems.push({
      code: 'ARGUMENT_UNREADABLE',
      message: `The argument ${argument} is not one this check reads (--skipped-on-pull-request=<job id>[,<job id>...] and job ids).`,
    });
  }
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
