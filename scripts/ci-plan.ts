/**
 * The plan of a run of the CI workflow: whether its jobs are to run at all (task CI.2, the Product Owner's decision of 7 November 2026).
 *
 * Only the nightly run can be told to stand down: it tests the head of main, and when a nightly run that succeeded already tested that very
 * commit, running again proves nothing new. Every other run (a push to main, a pull request, a manual run) always runs, because each of them
 * is about a commit nobody has a verdict on yet, or somebody asked for one.
 *
 * The decision is one question put to GitHub: the latest successful run of this workflow made by the `schedule` event on main, and the commit
 * it tested. The same commit means `run=false`. Everything else means `run=true`, including every way the question can fail (no token, no
 * answer, an answer that is not what was expected): a night's tests are never skipped on a guess. A run the plan stands down is itself a
 * success, so it becomes the "last successful nightly run" and the next night asks the same question about the same commit; a run that
 * was cut short or failed is never counted, so the next night runs again.
 *
 * The verdict job (scripts/ci-aggregate.ts, `--plan`) accepts the skipped jobs of a run only on the schedule event and only when this plan,
 * a job that succeeded, said `run=false`. `scripts/ci-workflow.test.ts` holds the workflow to that design: this job first, every other job
 * but the dependency audit after it and conditioned on its answer (the audit is not decided by the plan: an advisory is published with no commit, so
 * it runs on every run, a night that stands down included, and the verdict never accepts a skip of it: `--runs-always=audit`).
 *
 * Usage (in the workflow, one step with the id `plan`; the token needs `actions: read`):
 *   GH_TOKEN='${{ github.token }}' node scripts/ci-plan.ts
 * It reads GITHUB_EVENT_NAME, GITHUB_SHA, GITHUB_REPOSITORY, GITHUB_API_URL and GITHUB_OUTPUT, which GitHub sets, and writes `run=true` or
 * `run=false` to GITHUB_OUTPUT.
 */

import { appendFileSync } from 'node:fs';

import { isRecord } from './workflow-shapes.ts';

/** The workflow whose runs are asked about, as GitHub names it in the API. */
export const WORKFLOW_FILE = 'ci.yml';
/** The branch the nightly run tests, and the event that starts it. */
export const NIGHTLY_BRANCH = 'main';
export const NIGHTLY_EVENT = 'schedule';
const DEFAULT_API = 'https://api.github.com';
/** How long the question may take before the answer is "run": a slow API must not hold up the night's tests. */
export const QUESTION_TIMEOUT_MS = 20_000;

export interface Plan {
  run: boolean;
  /** In words, for the log of the job. */
  reason: string;
}

/**
 * What the plan is, given the event, the commit under test and the commit the last successful nightly run tested (undefined when there is
 * none, or when it could not be read).
 */
export function decide(
  event: string | undefined,
  sha: string | undefined,
  lastNightlySha: string | undefined,
): Plan {
  if (event !== NIGHTLY_EVENT) {
    return {
      run: true,
      reason: `a run of the event ${JSON.stringify(event ?? '(none)')} always runs; only the nightly run can stand down`,
    };
  }
  if (sha === undefined || sha.trim() === '') {
    return { run: true, reason: 'the commit under test is not known, so nothing can be compared' };
  }
  if (lastNightlySha === undefined) {
    return {
      run: true,
      reason: 'no successful nightly run of this commit history could be read, so the tests run',
    };
  }
  if (lastNightlySha.trim().toLowerCase() === sha.trim().toLowerCase()) {
    return {
      run: false,
      reason: `main is still at ${sha.slice(0, 12)}, which the last successful nightly run tested: nothing changed, so nothing runs`,
    };
  }
  return {
    run: true,
    reason: `main is at ${sha.slice(0, 12)}; the last successful nightly run tested ${lastNightlySha.slice(0, 12)}`,
  };
}

/** The part of `fetch` this script uses, so that a test can stand in for GitHub. */
export type Fetcher = (url: string, init: { headers: Record<string, string> }) => Promise<Response>;

/** `owner/name`, as GitHub writes it: nothing that could add to a path or a query. */
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** The address that lists the latest successful run of the nightly kind. */
export function lastNightlyUrl(repository: string, apiUrl: string = DEFAULT_API): string {
  const query = new URLSearchParams({
    event: NIGHTLY_EVENT,
    status: 'success',
    branch: NIGHTLY_BRANCH,
    per_page: '1',
  });
  return `${apiUrl.replace(/\/+$/, '')}/repos/${repository}/actions/workflows/${WORKFLOW_FILE}/runs?${query.toString()}`;
}

/**
 * The commit the latest successful nightly run tested, or undefined when there is none or the answer cannot be read. Never throws: an
 * error of any kind is "unknown", which the plan turns into "run".
 */
export async function lastNightlySha(
  fetcher: Fetcher,
  repository: string | undefined,
  token: string | undefined,
  apiUrl: string = DEFAULT_API,
): Promise<string | undefined> {
  if (repository === undefined || !REPOSITORY.test(repository)) return undefined;
  if (token === undefined || token === '') return undefined;
  try {
    const response = await fetcher(lastNightlyUrl(repository, apiUrl), {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    const runs = isRecord(body) ? body.workflow_runs : undefined;
    if (!Array.isArray(runs) || runs.length === 0) return undefined;
    const latest: unknown = runs[0];
    const sha = isRecord(latest) ? latest.head_sha : undefined;
    return typeof sha === 'string' && /^[0-9a-f]{40}$/i.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

type Environment = Readonly<Record<string, string | undefined>>;

/** Makes the plan for the run the environment describes, and says it: returns what was decided. */
export async function plan(
  env: Environment,
  fetcher: Fetcher,
  print: (line: string) => void,
): Promise<Plan> {
  // Only the nightly run asks GitHub anything: every other event has its answer already.
  const last =
    env.GITHUB_EVENT_NAME === NIGHTLY_EVENT
      ? await lastNightlySha(
          fetcher,
          env.GITHUB_REPOSITORY,
          env.GH_TOKEN,
          env.GITHUB_API_URL ?? DEFAULT_API,
        )
      : undefined;
  const decided = decide(env.GITHUB_EVENT_NAME, env.GITHUB_SHA, last);
  print(`${decided.run ? 'Plan: run' : 'Plan: stand down'} (${decided.reason})`);
  return decided;
}

/** The fetch of the platform, held to a time limit. */
const timedFetch: Fetcher = (url, init) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(QUESTION_TIMEOUT_MS) });

if (import.meta.main) {
  const decided = await plan(process.env, timedFetch, (line) => {
    console.log(line);
  });
  const output = process.env.GITHUB_OUTPUT;
  if (output === undefined || output === '') {
    console.log(`run=${String(decided.run)}`);
  } else {
    appendFileSync(output, `run=${String(decided.run)}\n`);
  }
}
