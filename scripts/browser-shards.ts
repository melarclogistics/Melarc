/**
 * The proof that the browser jobs of the CI workflow run every browser test of the Ops Portal that each kind of run must run, once, from
 * Playwright's own list of the tests and not from a reading of the workflow's text or of the configuration:
 *
 *   - the workflow's browser jobs list a shard of an engine in each entry of their matrices (`browserMatrix`, scripts/ci-workflow.ts);
 *   - which of those jobs a kind of run makes is read from the job's condition (`jobRunsOn`): a pull request makes the jobs with none,
 *     which must hold the Chromium shards and no other; a push to main, the nightly run and a manual run make them all, which must
 *     hold the shards of every engine (the Product Owner's decision of 7 November 2026);
 *   - the Ops Portal's configuration (apps/ops-web/playwright.config.ts) is asked, as a job asks it, for the tests of the engine
 *     (`MELARC_BROWSERS`) and for the shard (`MELARC_BROWSER_SHARD`, Playwright's `--shard`), with `playwright test --list`, which starts
 *     no browser and no server;
 *   - the shards that a kind of run makes of an engine it must run hold, between them, every test of every project of that engine once:
 *     none left to no job, none run by two, none that the whole run does not have, no shard empty, and no project that no engine's name
 *     claims; and a kind of run that must not run an engine makes no shard of it.
 *
 * It starts nothing but the listing, so it runs wherever the dependencies are installed (the unit job of CI, a developer's machine).
 * The listing is a function (`TestLister`), so that the proof can be shown to fail on a double of Playwright, and on the real one with
 * a shard or an engine taken out of the matrix.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import {
  BROWSERS,
  RUN_EVENTS,
  browserJobsOf,
  jobRunsOn,
  requiredEngines,
  type BrowserShard,
} from './ci-workflow.ts';
import { isRecord } from './workflow-shapes.ts';

/** What `playwright test --list` says of one run. */
export interface TestListing {
  /** Every test the run holds, by a key that names its project, file, place and title: the key of a test is the same in every run. */
  readonly tests: readonly string[];
  /** Every project the configuration was loaded with, whether or not it holds a test. */
  readonly projects: readonly string[];
  /** The shard the configuration says it ran as `current/total`, or null when it ran whole. */
  readonly shard: string | null;
}

/** The run to list: the engines of `MELARC_BROWSERS` and, when given, the shard of `MELARC_BROWSER_SHARD`. */
export interface ListQuery {
  readonly engines: readonly string[];
  readonly shard?: { readonly current: number; readonly total: number };
}

export type TestLister = (query: ListQuery) => Promise<TestListing>;

const BROWSER_TESTS = 'pnpm run test:browser';

/** The project a test key belongs to. */
const projectOf = (key: string): string => key.slice(0, Math.max(0, key.indexOf('|')));

/** The number of tests of each project among the keys, as "riders-chromium 12, staff-dev-chromium 3". */
function byProject(keys: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(projectOf(key), (counts.get(projectOf(key)) ?? 0) + 1);
  return [...counts].map(([project, count]) => `${project} ${String(count)}`).join(', ');
}

const sameNames = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.toSorted().join('\n') === b.toSorted().join('\n');

/**
 * What is wrong with the way the entries (the shards that a kind of run makes) cover the tests, from the listing of each run; empty
 * means that for every engine in `required` the entries' shards hold every test of every project of that engine exactly once, and
 * that no entry runs an engine that is not in it. It asks for the listing it needs, so that a double can stand for Playwright, and a
 * failed listing is a problem and never a pass.
 */
export async function findShardProblems(
  entries: readonly BrowserShard[],
  list: TestLister,
  required: readonly string[] = BROWSERS,
): Promise<string[]> {
  const problems: string[] = [];
  const attempt = async (query: ListQuery, what: string): Promise<TestListing | undefined> => {
    try {
      return await list(query);
    } catch (failure) {
      problems.push(
        `${what}: the tests could not be listed (${failure instanceof Error ? failure.message : 'not an error'})`,
      );
      return undefined;
    }
  };

  const everything = await attempt({ engines: BROWSERS }, 'all engines');
  if (everything === undefined) return problems;
  for (const project of everything.projects) {
    if (BROWSERS.filter((engine) => project.endsWith(`-${engine}`)).length !== 1) {
      problems.push(
        `the project ${project} is not named for one engine (${BROWSERS.map((engine) => `-${engine}`).join(', ')}), so no engine's jobs can be said to run it`,
      );
    }
  }
  for (const entry of entries) {
    if (!BROWSERS.includes(entry.engine)) {
      problems.push(
        `an entry of the matrix names the engine ${entry.engine}, which is not run here`,
      );
    }
  }

  let apart = 0;
  for (const engine of BROWSERS) {
    const whole = await attempt({ engines: [engine] }, engine);
    if (whole === undefined) continue;
    apart += whole.tests.length;

    const own = everything.projects.filter((project) => project.endsWith(`-${engine}`));
    if (!sameNames(whole.projects, own)) {
      problems.push(
        `${engine}: the run for it holds the projects ${whole.projects.join(', ')} and the run for all engines holds ${own.join(', ')} of it`,
      );
    }
    if (whole.tests.length === 0) {
      problems.push(
        `${engine}: the configuration lists no test for it, so there is nothing to prove`,
      );
      continue;
    }
    for (const project of whole.projects) {
      if (!whole.tests.some((key) => projectOf(key) === project)) {
        problems.push(
          `${engine}: the project ${project} lists no test, so no job can be said to run it`,
        );
      }
    }
    const names = new Set(whole.tests);
    if (names.size !== whole.tests.length) {
      problems.push(
        `${engine}: two tests have one key (project, file, place and title), so their shards cannot be told apart`,
      );
      continue;
    }

    const jobs = entries.filter((entry) => entry.engine === engine);
    // An engine this kind of run must not run (Firefox and WebKit on a pull request) has no shard in it: running it is the finding.
    if (!required.includes(engine)) {
      if (jobs.length > 0) {
        problems.push(
          `${engine}: ${String(jobs.length)} of its shards run here (${jobs.map((job) => `${String(job.shard)}/${String(job.shards)}`).join(', ')}), and only ${required.join(', ')} may`,
        );
      }
      continue;
    }
    if (jobs.length === 0) {
      problems.push(
        `no job runs ${engine}: its ${String(whole.tests.length)} tests (${byProject(whole.tests)}) are run by nothing`,
      );
      continue;
    }
    const runBy = new Map<string, string[]>();
    for (const job of jobs) {
      const label = `${engine} ${String(job.shard)}/${String(job.shards)}`;
      const part = await attempt(
        { engines: [engine], shard: { current: job.shard, total: job.shards } },
        label,
      );
      if (part === undefined) continue;
      if (part.shard !== `${String(job.shard)}/${String(job.shards)}`) {
        problems.push(
          `${label}: the configuration says it ran ${part.shard ?? 'whole'}, so MELARC_BROWSER_SHARD does not reach the run`,
        );
      }
      if (part.tests.length === 0) {
        problems.push(
          `${label} holds no test: it runs nothing, and a job that runs nothing proves nothing`,
        );
      }
      for (const key of part.tests) runBy.set(key, [...(runBy.get(key) ?? []), label]);
    }

    const left = whole.tests.filter((key) => !runBy.has(key));
    const twice = [...runBy].filter(([, by]) => by.length > 1);
    const strays = [...runBy.keys()].filter((key) => !names.has(key));
    if (left.length > 0) {
      problems.push(
        `${engine}: ${String(left.length)} of ${String(whole.tests.length)} tests are run by no job (${byProject(left)}); the entries run shard ${jobs.map((job) => `${String(job.shard)}/${String(job.shards)}`).join(', ')}`,
      );
    }
    if (twice.length > 0) {
      problems.push(
        `${engine}: ${String(twice.length)} tests are run by more than one job (${byProject(twice.map(([key]) => key))}), for one by ${twice[0]?.[1].join(' and ') ?? ''}`,
      );
    }
    if (strays.length > 0) {
      problems.push(
        `${engine}: ${String(strays.length)} tests of its shards are not in the run of the whole engine (${byProject(strays)})`,
      );
    }
  }
  if (apart !== everything.tests.length) {
    problems.push(
      `the engines list ${String(apart)} tests one by one and ${String(everything.tests.length)} together: a project is run by more than one engine's jobs, or by none`,
    );
  }
  return problems;
}

/**
 * The problems of a workflow's browser jobs, their matrices and what each kind of run covers, from the listing; empty means that a pull
 * request runs every test of Chromium once and nothing of the other engines, and that a push to main, the nightly run and a manual run
 * run every test of every engine once. A problem that two kinds of run share is said once, naming them.
 */
export async function browserCoverageProblems(
  workflowText: string,
  list: TestLister,
): Promise<string[]> {
  const jobs = browserJobsOf(workflowText);
  if (jobs.length === 0) return [`no job of the workflow runs ${BROWSER_TESTS}`];
  const problems = jobs.flatMap((job) => job.faults.map((fault) => `job ${job.id}: ${fault}`));
  const kinds = new Map<string, string[]>();
  for (const [event, label] of Object.entries(RUN_EVENTS)) {
    const running = jobs.filter((job) => jobRunsOn(job.body, event) === true);
    const found = await findShardProblems(
      running.flatMap((job) => job.entries),
      list,
      requiredEngines(event),
    );
    for (const problem of found) kinds.set(problem, [...(kinds.get(problem) ?? []), label]);
  }
  for (const [problem, labels] of kinds) problems.push(`${labels.join(', ')}: ${problem}`);
  return problems;
}

/** Keeps at most `limit` of the tasks it is given running. */
function limiter(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async (task) => {
    while (running >= limit) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    running += 1;
    try {
      return await task();
    } finally {
      running -= 1;
      waiting.shift()?.();
    }
  };
}

const text = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : '';

/** Reads the JSON of `playwright test --list --reporter=json`. */
export function listingFrom(output: string): TestListing {
  const parsed: unknown = JSON.parse(output);
  if (!isRecord(parsed)) throw new Error('the listing is not a JSON object');
  const errors = Array.isArray(parsed.errors) ? parsed.errors : [];
  if (errors.length > 0) {
    throw new Error(
      `Playwright reported ${String(errors.length)} error(s): ${JSON.stringify(errors[0]).slice(0, 300)}`,
    );
  }
  const config = isRecord(parsed.config) ? parsed.config : {};
  const projects = (Array.isArray(config.projects) ? config.projects : []).flatMap((project) =>
    isRecord(project) && typeof project.name === 'string' ? [project.name] : [],
  );
  const shard = isRecord(config.shard)
    ? `${text(config.shard.current)}/${text(config.shard.total)}`
    : null;

  const tests: string[] = [];
  const visit = (suite: unknown): void => {
    if (!isRecord(suite)) return;
    for (const spec of Array.isArray(suite.specs) ? suite.specs : []) {
      if (!isRecord(spec)) continue;
      for (const test of Array.isArray(spec.tests) ? spec.tests : []) {
        if (!isRecord(test)) continue;
        tests.push(
          `${text(test.projectName)}|${text(spec.file)}:${text(spec.line)}:${text(spec.column)}|${text(spec.title)}`,
        );
      }
    }
    for (const child of Array.isArray(suite.suites) ? suite.suites : []) visit(child);
  };
  for (const suite of Array.isArray(parsed.suites) ? parsed.suites : []) visit(suite);
  return { tests, projects, shard };
}

/** What a run of the listing answered. */
export interface ListRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** The variables that change which tests a run holds, taken out of the environment before the run's own are set. */
const SELECTING = ['MELARC_BROWSERS', 'MELARC_BROWSER_SHARD', 'PWTEST_SHARD_WEIGHTS'];

/**
 * Runs `playwright test --list --reporter=json` for the Ops Portal's configuration in `root`, as CI's job does but for the browser: the
 * environment is the process's with the variables of the run set (`extra`) and none of the others that select tests.
 */
export function runListing(
  root: string,
  extra: Readonly<Record<string, string>>,
): Promise<ListRun> {
  const directory = join(root, 'apps', 'ops-web');
  const cli = createRequire(join(directory, 'package.json')).resolve('@playwright/test/cli');
  const environment: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries({ ...process.env, ...extra }).filter(
      ([name]) => name in extra || !SELECTING.includes(name),
    ),
  );
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'test', '--list', '--reporter=json'], {
      cwd: directory,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

/**
 * The real Playwright as a lister, for the configuration in `root`. Each distinct run is made once, at most `parallel` at a time, and
 * a run that fails (a configuration that refuses the value, a spec that does not load) rejects.
 */
export function playwrightLister(root: string, parallel = 4): TestLister {
  const slot = limiter(parallel);
  const made = new Map<string, Promise<TestListing>>();
  return (query) => {
    const key = JSON.stringify([query.engines, query.shard ?? null]);
    const known = made.get(key);
    if (known !== undefined) return known;
    const extra: Record<string, string> = { MELARC_BROWSERS: query.engines.join(',') };
    if (query.shard !== undefined) {
      extra.MELARC_BROWSER_SHARD = `${String(query.shard.current)}/${String(query.shard.total)}`;
    }
    const run = slot(() => runListing(root, extra)).then((answer) => {
      if (answer.status !== 0) {
        throw new Error(
          `playwright test --list ended with ${String(answer.status)}: ${answer.stderr.trim().split('\n').slice(0, 3).join(' | ')}`,
        );
      }
      return listingFrom(answer.stdout);
    });
    made.set(key, run);
    return run;
  };
}
