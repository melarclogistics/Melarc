/**
 * Rules the CI workflow must keep, checked from its text. They guard against a pipeline that is green because it
 * asks less, not because the code is right:
 *
 *   - every mandatory command is still run, as the whole script of a step of its own: not after another command,
 *     not behind an echo, not in a longer script, and not in another shell or folder;
 *   - no failure can be absorbed (continue-on-error, `|| true`, `exit 0`) or skipped (a conditional job or step), with
 *     two exceptions. The first is the plan of the nightly run (task CI.2, scripts/ci-plan.ts): a job `plan` runs first and
 *     answers whether the run is to run at all (it stands down only on the nightly run, when a successful nightly run already
 *     tested the head of main), every other job needs it and has exactly `if: needs.plan.outputs.run == 'true'`, and the
 *     verdict accepts the skips only on that answer; the one job the plan does not decide is the dependency audit (run 4, Stage 1, item 4: an
 *     advisory is published with no commit, so a night that stands down still audits): it has no need and no condition, and the verdict is
 *     told, by `--runs-always=audit`, that a skip of it is never accepted. The second is the Product Owner's decision of 7 November 2026: the job
 *     of the Firefox and WebKit shards of the browser tests does not run on a pull request (the same condition and `&&
 *     github.event_name != 'pull_request'`, and no other), which runs the Chromium shards and every other job;
 *   - one aggregate job, which runs whatever happened, waits for every other job and judges them with
 *     scripts/ci-aggregate.ts, so a branch rule can require that single check (GitHub counts a skipped required
 *     check as passed, which is why the aggregate must run even when a job it needs failed). It alone is named
 *     "CI result", the name the branch rule requires. It is given the event of the run, the plan and the jobs a pull request
 *     may skip, which must be exactly the jobs the workflow does not run on one: a skip is a failure everywhere else;
 *   - the browser tests of the Ops Portal run as matrices of jobs, so that no job holds them all (one engine's run alone
 *     is longer than a job's limit): each matrix lists its shards 1 to N of an engine once, hands each job its engine
 *     (MELARC_BROWSERS) and its shard (MELARC_BROWSER_SHARD) and installs that engine alone. A pull request runs the
 *     Chromium shards; a push to main, the nightly run and a manual run run the shards of every engine, each engine in
 *     one job. That the shards together hold every test of the configuration, on each kind of run, is proved by
 *     scripts/browser-shards.test.ts, from Playwright's own listing;
 *   - the HTTPS journeys run as the matrix of a job too (the shards of e2e/harness/https-shards.ts: MELARC_HTTPS_SHARD,
 *     and the browsers its runs need), every shard once; scripts/https-shards.test.ts holds the matrix to the harness;
 *   - so do the database tests (the whole suite is longer than a job may last): the matrix of the database job lists its shards of
 *     MELARC_DB_SHARD, every shard once, and scripts/db-shards.test.ts proves, from Vitest's own listing, that they hold every test file once;
 *   - every job runs on the one runner image the toolchain was tried on;
 *   - the workflow runs only on pushes to main, pull requests, a nightly schedule and by hand: not on events that give it a
 *     token that can write or secrets. A scheduled run tests the head of the default branch, a commit that was pushed;
 *   - every job tests the commit the run is about, and what is published is described by a manifest of that
 *     commit (scripts/ci-revision.ts);
 *   - a step that fails on purpose to rehearse the pipeline runs only when someone asked for it by hand;
 *   - every step that runs tests has a timeout of its own, at most the job's limit less the measured set-up and a margin (`stepLimitFor`, four minutes): a hung suite then fails
 *     as a step, with the minutes left for the diagnostics to be kept, and does not take the job down with it, cancelled, with nothing kept;
 *   - the diagnostics are uploaded when a job failed or was cancelled (`failure() || cancelled()`), and the browsers Playwright
 *     downloads are cached (`~/.cache/ms-playwright`, keyed by the lockfile and the browsers), so a run does not fetch them again;
 *   - the database job leaves the tests whose bounds are wall-clock time (apps/api/test/timing-sensitive-tests.ts) out of a pull
 *     request and runs them everywhere else, by one variable set in one place;
 *   - the nightly run happens on weekdays only (the Product Owner's decision of 7 November 2026);
 *   - the token can only read (the plan's job also reads the workflow's runs).
 *
 * The workflow's pins (Node.js, pnpm, frozen install, action SHAs) are held by workspace-pins.ts.
 */

import { parse } from 'yaml';

import { expandSteps, type LocalActions } from './composite-actions.ts';
import { isAction, inputsOf, isRecord, stepsOf, type Step } from './workflow-shapes.ts';

export const AGGREGATE_JOB = 'ci';
/** The job that plans the run, and the command it runs (scripts/ci-plan.ts). */
export const PLAN_JOB = 'plan';
export const PLAN_COMMAND = 'node scripts/ci-plan.ts';

/** What the pipeline must run, each as the whole script of a step of its own. */
export const REQUIRED_COMMANDS: readonly string[] = [
  'pnpm run format:check',
  'pnpm run lint',
  'pnpm run typecheck',
  'pnpm run test',
  'pnpm run build',
  'pnpm run contract:check',
  'pnpm --filter @melarc/api run db:check',
  'node scripts/migration-immutability.ts',
  PLAN_COMMAND,
  'pnpm run api-client:check',
  'pnpm run test:db',
  'pnpm run test:browser',
  'pnpm run test:e2e',
  'pnpm run test:e2e:https',
  'pnpm run verifier:test',
  'pnpm audit --audit-level high',
];

export type WorkflowProblemCode =
  | 'TRIGGER_MISSING'
  | 'TRIGGER_FORBIDDEN'
  | 'PERMISSIONS_BROAD'
  | 'RUNNER_DRIFT'
  | 'JOB_NO_TIMEOUT'
  | 'JOB_CONDITIONAL'
  | 'CONTINUE_ON_ERROR'
  | 'FAILURE_SWALLOWED'
  | 'STEP_CONDITIONAL'
  | 'REHEARSAL_UNGUARDED'
  | 'CHECKOUT_MISSING'
  | 'CHECKOUT_NOT_REVISION'
  | 'CHECKOUT_PERSISTS_CREDENTIALS'
  | 'COMMAND_MISSING'
  | 'COMMAND_STEP_ALTERED'
  | 'DEFAULTS_RUN'
  | 'BROWSER_MATRIX_ENV'
  | 'BROWSER_SHARD_ENV'
  | 'BROWSER_SHARDS_DRIFT'
  | 'BROWSER_ENGINES_DRIFT'
  | 'BROWSER_INSTALL_DRIFT'
  | 'HTTPS_SHARD_ENV'
  | 'HTTPS_SHARDS_DRIFT'
  | 'ARTIFACT_NOT_PER_SHARD'
  | 'AGGREGATE_MISSING'
  | 'AGGREGATE_NAME'
  | 'AGGREGATE_NOT_ALWAYS'
  | 'AGGREGATE_NEEDS_DRIFT'
  | 'AGGREGATE_COMMAND_DRIFT'
  | 'AGGREGATE_SKIP_DRIFT'
  | 'AGGREGATE_ENV'
  | 'AGGREGATE_PLAN_DRIFT'
  | 'PLAN_MISSING'
  | 'PLAN_DRIFT'
  | 'JOB_NOT_PLANNED'
  | 'UNPLANNED_JOB_DRIFT'
  | 'AGGREGATE_ALWAYS_DRIFT'
  | 'STEP_TIMEOUT'
  | 'BROWSER_CACHE'
  | 'TIMING_SKIP_DRIFT'
  | 'DATABASE_SHARD_ENV'
  | 'DATABASE_SHARDS_DRIFT'
  | 'NIGHTLY_WEEKDAYS'
  | 'ARTIFACT_POLICY'
  | 'ARTIFACT_NOT_REVISIONED'
  | 'ARTIFACT_WITHOUT_MANIFEST'
  | 'ARTIFACT_NOT_AFTER_TESTS'
  | 'ARTIFACT_ROOTS_DRIFT'
  | 'ARTIFACT_HIDDEN_FILES'
  | 'REHEARSAL_MISSING'
  | 'POSTGRES_IMAGE_DRIFT';

export interface WorkflowProblem {
  code: WorkflowProblemCode;
  message: string;
}

const REVISION = '${{ github.sha }}';
const MAX_TIMEOUT_MINUTES = 30;
/** The one runner image of every job: a moving label such as ubuntu-latest changes what a green run proves. */
const RUNNER = 'ubuntu-24.04';
/** The name of the aggregate job's check, which the branch rule for main requires. */
export const VERDICT_NAME = 'CI result';
/** The only events that start the workflow. */
export const ALLOWED_TRIGGERS: readonly string[] = [
  'push',
  'pull_request',
  'schedule',
  'workflow_dispatch',
];
/**
 * The events a run is of, as `github.event_name` names them, and how a message says it. A schedule, a push to main and a manual run
 * make the same jobs; a pull request makes all but the Firefox and WebKit shards.
 */
export const RUN_EVENTS: Readonly<Record<string, string>> = {
  pull_request: 'on a pull request',
  push: 'on a push to main',
  schedule: 'in the nightly run',
  workflow_dispatch: 'in a manual run',
};
/** The condition of every job but the plan and the verdict: it runs when the plan says so (which is always, except on a night that stands down). */
export const PLANNED_RUN = "needs.plan.outputs.run == 'true'";
/**
 * The one condition a job may have besides `PLANNED_RUN` (the Product Owner's decision of 7 November 2026), and only the job that runs
 * no Chromium shard: a pull request does not run the Firefox and WebKit shards of the browser tests.
 */
export const PULL_REQUEST_SKIP = `${PLANNED_RUN} && github.event_name != 'pull_request'`;
/**
 * The jobs the plan does not decide (run 4, Stage 1, item 4): they run on every run, the nightly one that stands down included, because what they check can
 * change with no commit. A new advisory is published overnight; a night that skipped the audit because the code did not change would never see it.
 */
export const UNPLANNED_JOBS: readonly string[] = ['audit'];
/** The option of the aggregate command that names the jobs a pull request may skip (scripts/ci-aggregate.ts). */
const SKIP_OPTION = '--skipped-on-pull-request=';
/** The option that names the plan, whose answer allows the skips of a night on which nothing changed (scripts/ci-aggregate.ts). */
const PLAN_OPTION = '--plan=';
/** The option that names the jobs the plan does not decide: a skip of one is never accepted (scripts/ci-aggregate.ts). */
const ALWAYS_OPTION = '--runs-always=';
/** `github.event_name`, which the aggregate step hands to the verdict. */
const EVENT_NAME = '${{ github.event_name }}';
const REHEARSAL_INPUT = 'rehearse-failure';
const REHEARSAL_GUARDS = ["github.event_name == 'workflow_dispatch'", `inputs.${REHEARSAL_INPUT}`];

/** A script line that ends the step with success whatever came before, or stops failures from counting. */
const SWALLOWED_FAILURE = [
  /\|\|\s*(?:true\b|:(?:\s|$)|exit\s+0\b)/,
  /\bset\s+\+e\b/,
  /\bexit\s+0\b/,
];
const EXITS_NON_ZERO = /\bexit\s+[1-9]\d*\b/;

interface Job {
  id: string;
  body: Record<string, unknown>;
  /** The steps written in the job. */
  steps: Step[];
  /** Those, each followed by the steps of the local action it uses. The rules on failures cover all of them. */
  expanded: Step[];
}

function jobsOf(workflow: unknown, localActions: LocalActions = {}): Job[] {
  const jobs = isRecord(workflow) ? workflow.jobs : undefined;
  if (!isRecord(jobs)) return [];
  return Object.entries(jobs).flatMap(([id, body]) =>
    isRecord(body) ? [jobFrom(id, body, localActions)] : [],
  );
}

function jobFrom(id: string, body: Record<string, unknown>, localActions: LocalActions): Job {
  const steps = stepsOf(body);
  return { id, body, steps, expanded: expandSteps(steps, localActions, new Set()) };
}

const scriptOf = (step: Step): string => (typeof step.run === 'string' ? step.run : '');
const linesOf = (script: string): string[] => script.split('\n').map((line) => line.trim());
const same = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean =>
  a.size === b.size && [...a].every((item) => b.has(item));

/** The events a workflow's `on` names, whether it is written as one name, a list of names or a map. */
function triggerNames(triggers: unknown): string[] {
  if (typeof triggers === 'string') return [triggers];
  if (Array.isArray(triggers)) return triggers.filter((name) => typeof name === 'string');
  return isRecord(triggers) ? Object.keys(triggers) : [];
}

function checkTriggers(workflow: unknown): WorkflowProblem[] {
  const triggers = isRecord(workflow) ? workflow.on : undefined;
  const push = isRecord(triggers) ? triggers.push : undefined;
  const branches = isRecord(push) ? push.branches : undefined;
  const pushesToMain = Array.isArray(branches) && branches.includes('main');
  const pullRequests = isRecord(triggers) && Object.hasOwn(triggers, 'pull_request');
  const problems: WorkflowProblem[] = [];
  if (!pushesToMain || !pullRequests) {
    problems.push({
      code: 'TRIGGER_MISSING',
      message:
        'CI must run on pushes to main (on.push.branches) and on pull requests (on.pull_request).',
    });
  }
  // The nightly run: with the pushes to main, the only time the Firefox and WebKit shards of the browser tests run besides a manual run.
  const schedule = isRecord(triggers) ? triggers.schedule : undefined;
  const nightly =
    Array.isArray(schedule) &&
    schedule.some(
      (entry) => isRecord(entry) && typeof entry.cron === 'string' && entry.cron.trim() !== '',
    );
  if (!nightly) {
    problems.push({
      code: 'TRIGGER_MISSING',
      message:
        'CI must also run every night (on.schedule with a cron): a pull request does not run the Firefox and WebKit shards of the browser tests, so a push to main and the nightly run are what do.',
    });
  }
  // The nightly run is a weekday run (the Product Owner's decision of 7 November 2026): the fifth field of every cron is Monday to Friday.
  const crons = Array.isArray(schedule)
    ? schedule.flatMap((entry) =>
        isRecord(entry) && typeof entry.cron === 'string' && entry.cron.trim() !== ''
          ? [entry.cron.trim()]
          : [],
      )
    : [];
  for (const cron of crons) {
    const weekday = cron.split(/\s+/)[4]?.toUpperCase();
    if (cron.split(/\s+/).length !== 5 || (weekday !== '1-5' && weekday !== 'MON-FRI')) {
      problems.push({
        code: 'NIGHTLY_WEEKDAYS',
        message: `The nightly cron "${cron}" must run on weekdays only: its fifth field is 1-5 (the Product Owner's decision of 7 November 2026).`,
      });
    }
  }
  const forbidden = triggerNames(triggers).filter((name) => !ALLOWED_TRIGGERS.includes(name));
  if (forbidden.length > 0) {
    problems.push({
      code: 'TRIGGER_FORBIDDEN',
      message: `CI may start only on ${ALLOWED_TRIGGERS.join(', ')}; remove ${forbidden.join(', ')}. Events such as pull_request_target and workflow_run run pull-request code with secrets and a token that can write; the others make the verdict about something other than a commit that was pushed or proposed.`,
    });
  }
  return problems;
}

function checkRunners(jobs: readonly Job[]): WorkflowProblem[] {
  return jobs
    .filter(({ body }) => body['runs-on'] !== RUNNER)
    .map(({ id }) => ({
      code: 'RUNNER_DRIFT',
      message: `Job ${id} must have runs-on: ${RUNNER}, the image the toolchain was tried on (and a job that only calls another workflow has steps nobody checks here).`,
    }));
}

function readOnly(permissions: unknown): boolean {
  return (
    isRecord(permissions) &&
    Object.values(permissions).every((level) => level === 'read' || level === 'none')
  );
}

function checkPermissions(workflow: unknown, jobs: readonly Job[]): WorkflowProblem[] {
  const declared = isRecord(workflow) ? workflow.permissions : undefined;
  const broad = [
    ...(readOnly(declared) ? [] : ['the workflow']),
    ...jobs
      .filter(({ body }) => 'permissions' in body && !readOnly(body.permissions))
      .map(({ id }) => `job ${id}`),
  ];
  if (broad.length === 0) return [];
  return [
    {
      code: 'PERMISSIONS_BROAD',
      message: `Declare read-only permissions (contents: read) for ${broad.join(', ')}; pull-request code runs here.`,
    },
  ];
}

const continuesOnError = (value: unknown): boolean => value !== undefined && value !== false;

/** A step that fails on purpose, as the rehearsal does. */
const failsOnPurpose = (step: Step): boolean => EXITS_NON_ZERO.test(scriptOf(step));

function isGuardedRehearsal(step: Step): boolean {
  const condition = typeof step.if === 'string' ? step.if : '';
  return REHEARSAL_GUARDS.every((guard) => condition.includes(guard));
}

/**
 * The condition of a job. The plan has none (it decides, and always runs), nor does the verdict (`always()`, checked apart); every
 * other job has exactly `PLANNED_RUN`, and the job that runs only Firefox and WebKit shards `PULL_REQUEST_SKIP`, which adds the pull request.
 */
function checkCondition(job: Job): WorkflowProblem[] {
  const { id, body } = job;
  if (id === AGGREGATE_JOB) return [];
  if (id === PLAN_JOB) {
    return 'if' in body
      ? [
          {
            code: 'JOB_CONDITIONAL',
            message: `Job ${PLAN_JOB} has a condition, so it can be skipped. It decides whether the others run, and always runs.`,
          },
        ]
      : [];
  }
  if (UNPLANNED_JOBS.includes(id)) {
    return 'if' in body
      ? [
          {
            code: 'JOB_CONDITIONAL',
            message: `Job ${id} has a condition, so it can be skipped. What it checks changes with no commit, so it runs on every run, the nightly run that stands down included.`,
          },
        ]
      : [];
  }
  const condition = typeof body.if === 'string' ? body.if.trim() : undefined;
  if (condition === PLANNED_RUN) return [];
  if (condition === PULL_REQUEST_SKIP && skippedOnPullRequest(job)) return [];
  return [
    {
      code: 'JOB_CONDITIONAL',
      message: `Job ${id} must have exactly "if: ${PLANNED_RUN}", so that it runs whenever the plan says the run is to run; the one other condition is "if: ${PULL_REQUEST_SKIP}", of the job that runs only the Firefox and WebKit shards of the browser tests.`,
    },
  ];
}

function checkFailuresPropagate(jobs: readonly Job[]): WorkflowProblem[] {
  const problems: WorkflowProblem[] = [];
  for (const job of jobs) {
    const { id, body, expanded } = job;
    problems.push(...checkCondition(job));
    const timeout = body['timeout-minutes'];
    if (typeof timeout !== 'number' || timeout < 1 || timeout > MAX_TIMEOUT_MINUTES) {
      problems.push({
        code: 'JOB_NO_TIMEOUT',
        message: `Job ${id} needs timeout-minutes between 1 and ${String(MAX_TIMEOUT_MINUTES)}, so a hung job cannot hold the run.`,
      });
    }
    if (continuesOnError(body['continue-on-error'])) {
      problems.push({
        code: 'CONTINUE_ON_ERROR',
        message: `Job ${id} sets continue-on-error, so its failure would not fail the run.`,
      });
    }
    for (const step of expanded) {
      const label = `${id}: ${typeof step.name === 'string' ? step.name : '(unnamed step)'}`;
      if (continuesOnError(step['continue-on-error'])) {
        problems.push({
          code: 'CONTINUE_ON_ERROR',
          message: `Step "${label}" sets continue-on-error, so its failure would not fail the job.`,
        });
      }
      if (SWALLOWED_FAILURE.some((pattern) => pattern.test(scriptOf(step)))) {
        problems.push({
          code: 'FAILURE_SWALLOWED',
          message: `Step "${label}" runs a script that can hide a failure (|| true, set +e, exit 0).`,
        });
      }
      if (failsOnPurpose(step)) {
        if (!isGuardedRehearsal(step)) {
          problems.push({
            code: 'REHEARSAL_UNGUARDED',
            message: `Step "${label}" fails on purpose and is not limited to a manual run (${REHEARSAL_GUARDS.join(' && ')}).`,
          });
        }
      } else if ('if' in step && !isFailureUpload(step)) {
        problems.push({
          code: 'STEP_CONDITIONAL',
          message: `Step "${label}" has a condition, so it can be skipped. Only a failure-time artifact upload may, with exactly "if: ${FAILURE_UPLOAD_CONDITION}".`,
        });
      }
    }
  }
  return problems;
}

/**
 * The rehearsal is how the pipeline's validation is shown on GitHub: a manual run with the input ticked fails a
 * job on purpose. It needs the input and a step guarded by it; without either, the proof silently disappears.
 */
function checkRehearsal(workflow: unknown, jobs: readonly Job[]): WorkflowProblem[] {
  const triggers = isRecord(workflow) ? workflow.on : undefined;
  const dispatch = isRecord(triggers) ? triggers.workflow_dispatch : undefined;
  const inputs = isRecord(dispatch) ? dispatch.inputs : undefined;
  const input = isRecord(inputs) ? inputs[REHEARSAL_INPUT] : undefined;
  const declared = isRecord(input) && input.type === 'boolean';
  const guarded = jobs.some(({ expanded }) =>
    expanded.some((step) => failsOnPurpose(step) && isGuardedRehearsal(step)),
  );
  if (declared && guarded) return [];
  return [
    {
      code: 'REHEARSAL_MISSING',
      message: `Declare the boolean workflow_dispatch input ${REHEARSAL_INPUT} and keep a step that fails on purpose when it is ticked (${REHEARSAL_GUARDS.join(' && ')}).`,
    },
  ];
}

const isUpload = (step: Step): boolean => isAction(step, 'actions/upload-artifact');
/** When the diagnostics are kept: a failed job, and a cancelled one (a job that ran into its limit is cancelled). */
export const FAILURE_UPLOAD_CONDITION = 'failure() || cancelled()';
const isFailureUpload = (step: Step): boolean =>
  isUpload(step) && step.if === FAILURE_UPLOAD_CONDITION;

function checkCheckouts(jobs: readonly Job[]): WorkflowProblem[] {
  const problems: WorkflowProblem[] = [];
  for (const { id, steps } of jobs) {
    const checkouts = steps.filter((step) => isAction(step, 'actions/checkout'));
    if (checkouts.length === 0) {
      problems.push({
        code: 'CHECKOUT_MISSING',
        message: `Job ${id} does not check out the repository.`,
      });
    }
    for (const checkout of checkouts) {
      const inputs = inputsOf(checkout);
      if (inputs.ref !== REVISION) {
        problems.push({
          code: 'CHECKOUT_NOT_REVISION',
          message: `Job ${id}: check out with ref: ${REVISION}, so every job tests the commit the run is about.`,
        });
      }
      if (inputs['persist-credentials'] !== false) {
        problems.push({
          code: 'CHECKOUT_PERSISTS_CREDENTIALS',
          message: `Job ${id}: check out with persist-credentials: false, so no step can push with the token.`,
        });
      }
    }
  }
  return problems;
}

const isMandatoryStep = (step: Step): boolean => REQUIRED_COMMANDS.includes(scriptOf(step).trim());

/**
 * Each mandatory command must be the whole script of a step: a command that is only one line of a longer script
 * can be preceded by `exit`, a condition or an echo, be followed by `|| true`, or sit in a comment or a heredoc,
 * and a reader of the workflow would still see its name. Such a step must also run in the default shell and
 * folder (a `shell:` or `working-directory:` changes what the command is or where), and no default may do it
 * from afar (`defaults.run`).
 */
function checkCommands(workflow: unknown, jobs: readonly Job[]): WorkflowProblem[] {
  const whole = new Set(jobs.flatMap(({ steps }) => steps.map((step) => scriptOf(step).trim())));
  const problems: WorkflowProblem[] = REQUIRED_COMMANDS.filter(
    (command) => !whole.has(command),
  ).map((command) => ({
    code: 'COMMAND_MISSING',
    message: `No step has "${command}" as the whole of its script (the command may not share a script with others).`,
  }));

  for (const { id, steps } of jobs) {
    for (const step of steps.filter(isMandatoryStep)) {
      const altered = ['shell', 'working-directory'].filter((key) => key in step);
      if (altered.length > 0) {
        problems.push({
          code: 'COMMAND_STEP_ALTERED',
          message: `Step "${id}: ${scriptOf(step).trim()}" sets ${altered.join(' and ')}, so the mandatory command may not run as written.`,
        });
      }
    }
  }

  const holders = [
    ...(hasDefaultRun(workflow) ? ['the workflow'] : []),
    ...jobs.filter(({ body }) => hasDefaultRun(body)).map(({ id }) => `job ${id}`),
  ];
  if (holders.length > 0) {
    problems.push({
      code: 'DEFAULTS_RUN',
      message: `Remove defaults.run from ${holders.join(', ')}: it changes the shell or folder of every command without a mark on the step.`,
    });
  }
  return problems;
}

function hasDefaultRun(holder: unknown): boolean {
  const defaults = isRecord(holder) ? holder.defaults : undefined;
  return isRecord(defaults) && 'run' in defaults;
}

/** The engines of the supported browsers (surfaces/ops-portal.md section 11), all of which CI runs on a push to main, every night and by hand. */
export const BROWSERS: readonly string[] = ['chromium', 'firefox', 'webkit'];
/** The engines a pull request runs: Chromium alone (the Product Owner's decision of 7 November 2026). */
const PULL_REQUEST_ENGINES: readonly string[] = ['chromium'];
const BROWSER_TESTS = 'pnpm run test:browser';
export const HTTPS_TESTS = 'pnpm run test:e2e:https';
/** What a browser job's matrix hands each job: its engine, and its shard of that engine (Playwright's `current/total`). */
export const MATRIX_ENGINE = '${{ matrix.engine }}';
export const MATRIX_SHARD = '${{ matrix.shard }}/${{ matrix.shards }}';
/** What the HTTPS job's matrix hands each job: the browsers its runs need, as the arguments of the install (e2e/harness/https-shards.ts). */
export const MATRIX_BROWSERS = '${{ matrix.browsers }}';
/** Stand for the matrix values where an install script is read, so that the expressions' spaces do not split it. */
const ENGINE_WORD = '@engine@';
const BROWSERS_WORD = '@browsers@';
/** The whole script of a step that downloads browsers: the options (`--with-deps`), then the engines. */
const BROWSER_INSTALL = /^pnpm (?:--filter \S+ )?exec playwright install((?: [^\s&|;<>]+)*)$/;

/** The engines a run of this event must run: Chromium alone on a pull request, every engine on any other event. */
export const requiredEngines = (event: string): readonly string[] =>
  event === 'pull_request' ? PULL_REQUEST_ENGINES : BROWSERS;

/** Whether the list is the one word of a matrix value (`${{ matrix.engine }}`, `${{ matrix.browsers }}`), and nothing else. */
const namesOnly = (engines: readonly string[], word: string): boolean =>
  engines.length === 1 && engines[0] === word;

/** The engines a script installs when it is exactly an install command, or undefined when it is not one. */
function installedEngines(script: string): string[] | undefined {
  const written = script
    .trim()
    .replaceAll(MATRIX_ENGINE, ENGINE_WORD)
    .replaceAll(MATRIX_BROWSERS, BROWSERS_WORD);
  const match = BROWSER_INSTALL.exec(written);
  if (match === null) return undefined;
  return (match[1] ?? '').split(' ').filter((word) => word !== '' && !word.startsWith('-'));
}

/** One job of a browser matrix: the engine it runs and which shard of it, counted from 1, out of how many. */
export interface BrowserShard {
  engine: string;
  shard: number;
  shards: number;
}

/** The shards a browser job's matrix lists, read as written, and everything wrong with how it lists them. */
export interface BrowserMatrix {
  shards: BrowserShard[];
  faults: string[];
}

/** One job of the HTTPS matrix: its shard of the run, out of how many, and the browsers its runs need installed. */
export interface HttpsShardEntry {
  shard: number;
  shards: number;
  browsers: string[];
}

export interface HttpsMatrix {
  shards: HttpsShardEntry[];
  faults: string[];
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1;
const listed = (numbers: Iterable<number>): string =>
  [...numbers].toSorted((a, b) => a - b).join(', ');

/**
 * The entries of a job's matrix when it is written the one way this file can read: `fail-fast: false` (every shard runs to its
 * end, so that one failure does not hide the others) and a literal `include` list, nothing else. A matrix computed by an
 * expression, or one with keys that add and remove jobs, cannot be checked for what it runs.
 */
function literalMatrix(job: Record<string, unknown>): { entries: unknown[]; faults: string[] } {
  const faults: string[] = [];
  const strategy = job.strategy;
  if (!isRecord(strategy)) {
    return { entries: [], faults: ['the job has no strategy.matrix that lists the shards'] };
  }
  if (strategy['fail-fast'] !== false) {
    faults.push(
      'strategy.fail-fast must be false, or the first failed shard cancels the others and their failures are never seen',
    );
  }
  const matrix = strategy.matrix;
  if (!isRecord(matrix)) {
    faults.push(
      'strategy.matrix must be a literal mapping with an include list; a computed matrix cannot be checked',
    );
    return { entries: [], faults };
  }
  const other = Object.keys(matrix).filter((key) => key !== 'include');
  if (other.length > 0) {
    faults.push(
      `strategy.matrix may hold only include, not ${other.join(', ')}: those keys add and remove jobs in ways this check does not follow`,
    );
  }
  const include = matrix.include;
  if (!Array.isArray(include) || include.length === 0) {
    faults.push('strategy.matrix.include must list the shards, one entry for each job');
    return { entries: [], faults };
  }
  return { entries: include, faults };
}

/** The keys an entry holds, sorted, or none when it is not a mapping. */
const keysOf = (entry: unknown): string[] => (isRecord(entry) ? Object.keys(entry).toSorted() : []);

/** What is wrong with the shards 1 to N of one group, which must each be listed once with the same N. */
function groupFaults(label: string, own: readonly { shard: number; shards: number }[]): string[] {
  const faults: string[] = [];
  const totals = new Set(own.map((entry) => entry.shards));
  if (totals.size > 1) {
    return [
      `the entries of ${label} disagree on the number of shards (${listed(totals)}), so their shards overlap or leave tests out`,
    ];
  }
  const total = own[0]?.shards ?? 0;
  const counts = new Map<number, number>();
  for (const entry of own) counts.set(entry.shard, (counts.get(entry.shard) ?? 0) + 1);
  const missing = Array.from({ length: total }, (_, index) => index + 1).filter(
    (shard) => !counts.has(shard),
  );
  const repeated = [...counts].filter(([, count]) => count > 1).map(([shard]) => shard);
  if (missing.length > 0) {
    faults.push(
      `${label} has no entry for shard ${listed(missing)} of ${String(total)}, so the tests of that shard are never run`,
    );
  }
  if (repeated.length > 0) {
    faults.push(`${label} lists shard ${listed(repeated)} of ${String(total)} more than once`);
  }
  return faults;
}

const SHARD_KEYS = ['engine', 'shard', 'shards'];

/**
 * The matrix of a browser job: a literal list of the shards (`include`, each entry an engine, a shard and the number of shards of
 * that engine), so that this check, and the one that lists the tests, can read every job that will run. For each engine the job
 * lists, the shards are 1 to N, each once, with the same N in each entry: whatever Playwright cuts for the shard `current/total`
 * then belongs to one job, and one job only. Which engines the jobs of the workflow hold between them, and which of them an
 * event runs, is the check of `checkBrowserEvents`.
 */
export function browserMatrix(job: Record<string, unknown>): BrowserMatrix {
  const { entries, faults } = literalMatrix(job);
  const found: BrowserShard[] = [];
  for (const entry of entries) {
    const keys = keysOf(entry);
    if (!isRecord(entry) || keys.join() !== SHARD_KEYS.join()) {
      faults.push(
        `an include entry must hold ${SHARD_KEYS.join(', ')} and nothing else, not ${keys.length === 0 ? JSON.stringify(entry) : keys.join(', ')}`,
      );
      continue;
    }
    const { engine, shard, shards } = entry;
    if (typeof engine !== 'string' || !BROWSERS.includes(engine)) {
      faults.push(
        `an include entry names the engine ${JSON.stringify(engine)}; the engines are ${BROWSERS.join(', ')}`,
      );
    } else if (!isCount(shard) || !isCount(shards) || shard > shards) {
      faults.push(
        `the entry of ${engine} has shard ${JSON.stringify(shard)} of ${JSON.stringify(shards)}; both are whole numbers from 1 and the shard is at most the number of shards`,
      );
    } else {
      found.push({ engine, shard, shards });
    }
  }
  for (const engine of BROWSERS) {
    const own = found.filter((entry) => entry.engine === engine);
    if (own.length > 0) faults.push(...groupFaults(engine, own));
  }
  return { shards: found, faults };
}

const HTTPS_KEYS = ['browsers', 'shard', 'shards'];

/**
 * The matrix of the HTTPS job: a literal list of the shards of the run (`include`, each entry a shard, the number of shards and the
 * browsers that shard's runs need), with the shards 1 to N each once and the same N in each entry. Which runs a shard makes, and
 * the browsers they need, are the harness's (e2e/harness/https-shards.ts); scripts/https-shards.test.ts holds the two together.
 */
export function httpsMatrix(job: Record<string, unknown>): HttpsMatrix {
  const { entries, faults } = literalMatrix(job);
  const found: HttpsShardEntry[] = [];
  for (const entry of entries) {
    const keys = keysOf(entry);
    if (!isRecord(entry) || keys.join() !== HTTPS_KEYS.join()) {
      faults.push(
        `an include entry must hold ${HTTPS_KEYS.join(', ')} and nothing else, not ${keys.length === 0 ? JSON.stringify(entry) : keys.join(', ')}`,
      );
      continue;
    }
    const { browsers, shard, shards } = entry;
    const named = typeof browsers === 'string' ? browsers.split(' ') : [];
    if (
      named.length === 0 ||
      named.some((name) => !BROWSERS.includes(name)) ||
      new Set(named).size !== named.length
    ) {
      faults.push(
        `the browsers of an include entry (${JSON.stringify(browsers)}) must be engines (${BROWSERS.join(', ')}), each once, separated by single spaces`,
      );
    } else if (!isCount(shard) || !isCount(shards) || shard > shards) {
      faults.push(
        `the entry of shard ${JSON.stringify(shard)} of ${JSON.stringify(shards)} is not one: both are whole numbers from 1 and the shard is at most the number of shards`,
      );
    } else {
      found.push({ shard, shards, browsers: named });
    }
  }
  if (found.length > 0) faults.push(...groupFaults('the HTTPS run', found));
  return { shards: found, faults };
}

/** Whether the job runs the browser tests of the Ops Portal. */
const runsBrowserTests = (job: Job): boolean =>
  job.steps.some((step) => scriptOf(step).trim() === BROWSER_TESTS);

/** A job that runs the browser tests of the Ops Portal, with the shards its matrix lists. */
export interface BrowserJob {
  id: string;
  body: Record<string, unknown>;
  entries: BrowserShard[];
  faults: string[];
}

function browserJobsFrom(jobs: readonly Job[]): BrowserJob[] {
  return jobs.filter(runsBrowserTests).map(({ id, body }) => {
    const matrix = browserMatrix(body);
    return { id, body, entries: matrix.shards, faults: matrix.faults };
  });
}

/** Every job of a workflow that runs the browser tests of the Ops Portal. */
export const browserJobsOf = (workflowText: string): BrowserJob[] =>
  browserJobsFrom(jobsOf(parse(workflowText)));

/** A job that runs the HTTPS journeys, with the shards its matrix lists. */
export interface HttpsJob {
  id: string;
  entries: HttpsShardEntry[];
  faults: string[];
}

/** Every job of a workflow that runs the journeys over the trusted HTTPS origin. */
export const httpsJobsOf = (workflowText: string): HttpsJob[] =>
  jobsOf(parse(workflowText))
    .filter((job) => job.steps.some((step) => scriptOf(step).trim() === HTTPS_TESTS))
    .map(({ id, body }) => {
      const matrix = httpsMatrix(body);
      return { id, entries: matrix.shards, faults: matrix.faults };
    });

/**
 * Whether a job runs on an event, when the plan says the run is to run (it does on every event but a nightly run that stands down, and
 * then nothing runs): `PLANNED_RUN` is true on every event, `PULL_REQUEST_SKIP` is false on a pull request and true on any other, and a
 * job with no condition runs on all of them. A condition of any other form says nothing here (undefined: it is not counted as running,
 * and `checkFailuresPropagate` reports it).
 */
export function jobRunsOn(body: Record<string, unknown>, event: string): boolean | undefined {
  if (!('if' in body)) return true;
  const condition = typeof body.if === 'string' ? body.if.trim() : undefined;
  if (condition === PLANNED_RUN) return true;
  return condition === PULL_REQUEST_SKIP ? event !== 'pull_request' : undefined;
}

/** Whether the job is the one a pull request may skip: it runs the browser tests, only of engines other than Chromium, and has exactly the one condition. */
function skippedOnPullRequest(job: Job): boolean {
  if (typeof job.body.if !== 'string' || job.body.if.trim() !== PULL_REQUEST_SKIP) return false;
  if (!runsBrowserTests(job)) return false;
  const { shards } = browserMatrix(job.body);
  return shards.length > 0 && shards.every((entry) => !PULL_REQUEST_ENGINES.includes(entry.engine));
}

const capitalised = (text: string): string => `${text.slice(0, 1).toUpperCase()}${text.slice(1)}`;

/**
 * What each kind of run runs of the browser tests, from the jobs that run on it: every engine in one job only, a pull request the
 * engines of `requiredEngines('pull_request')` and no other, and a push to main, the nightly run and a manual run all three. A job
 * that holds Firefox and WebKit shards and no condition would run them on a pull request; one that is skipped everywhere, or whose
 * shards were taken out, would leave an engine unrun on main.
 */
function checkBrowserEvents(jobs: readonly Job[]): WorkflowProblem[] {
  const browserJobs = browserJobsFrom(jobs);
  if (browserJobs.length === 0) return [];
  const problems: WorkflowProblem[] = [];
  for (const engine of BROWSERS) {
    const holding = browserJobs
      .filter((job) => job.entries.some((entry) => entry.engine === engine))
      .map((job) => job.id);
    if (holding.length > 1) {
      problems.push({
        code: 'BROWSER_ENGINES_DRIFT',
        message: `The shards of ${engine} are listed in more than one job (${holding.join(', ')}): each engine's shards belong to one job, or an event that runs them all would run some twice.`,
      });
    }
  }
  for (const [event, label] of Object.entries(RUN_EVENTS)) {
    const running = browserJobs.filter((job) => jobRunsOn(job.body, event) === true);
    const engines = new Set(running.flatMap((job) => job.entries.map((entry) => entry.engine)));
    const required = requiredEngines(event);
    const missing = required.filter((engine) => !engines.has(engine));
    const extra = [...engines].filter((engine) => !required.includes(engine));
    if (missing.length > 0) {
      problems.push({
        code: 'BROWSER_ENGINES_DRIFT',
        message: `${capitalised(label)}, no browser job runs ${missing.join(' or ')}, so its tests are never run there (${required.join(', ')} must run).`,
      });
    }
    if (extra.length > 0) {
      problems.push({
        code: 'BROWSER_ENGINES_DRIFT',
        message: `${capitalised(label)}, the browser jobs also run ${extra.join(' and ')}, and only ${required.join(', ')} may: a job that holds those shards needs "if: ${PULL_REQUEST_SKIP}" (the Product Owner's decision of 7 November 2026).`,
      });
    }
  }
  return problems;
}

/** The uploads of a job, each of which must carry a value of the job's matrix in its name, or two entries that fail would upload under one name. */
function checkUploadNames(
  id: string,
  steps: readonly Step[],
  must: readonly string[],
  what: string,
): WorkflowProblem[] {
  return steps.filter(isUpload).flatMap((upload): WorkflowProblem[] => {
    const name = inputsOf(upload).name;
    if (typeof name === 'string' && must.every((part) => name.includes(part))) return [];
    return [
      {
        code: 'ARTIFACT_NOT_PER_SHARD',
        message: `Job ${id}: artifact "${typeof upload.name === 'string' ? upload.name : '(unnamed upload)'}" must carry ${what} in its name: two shards that fail would upload under one name.`,
      },
    ];
  });
}

/**
 * The browser tests of the Ops Portal run as the jobs of matrices, one for each shard of each engine: the step that runs them
 * sets MELARC_BROWSERS to the entry's engine and MELARC_BROWSER_SHARD to its shard, a step before it installs that engine and no
 * other, the matrix lists its shards without a fault (see `browserMatrix`), what the jobs run on each kind of run is what that run
 * must (`checkBrowserEvents`) and an artifact of the job is named for its entry. The HTTPS journeys run as the matrix of a job in
 * the same way: MELARC_HTTPS_SHARD is the entry's shard, the install is the entry's browsers, and the artifact is named for the
 * shard. A pipeline that stops setting a variable, installs the wrong browser or drops an entry stays green while tests are never run.
 */
function checkBrowsers(jobs: readonly Job[]): WorkflowProblem[] {
  const problems: WorkflowProblem[] = [];
  for (const { id, body, steps } of jobs) {
    steps.forEach((step, index) => {
      const script = scriptOf(step).trim();
      if (script !== BROWSER_TESTS && script !== HTTPS_TESTS) return;
      const installs = steps
        .slice(0, index)
        .map((earlier) => installedEngines(scriptOf(earlier)))
        .filter((engines) => engines !== undefined);
      const env = isRecord(step.env) ? step.env : {};

      if (script === HTTPS_TESTS) {
        if (env.MELARC_HTTPS_SHARD !== MATRIX_SHARD) {
          problems.push({
            code: 'HTTPS_SHARD_ENV',
            message: `Job ${id}: the step that runs ${HTTPS_TESTS} must set env MELARC_HTTPS_SHARD to exactly ${MATRIX_SHARD}, or every job makes every run of the HTTPS journeys, or the same ones.`,
          });
        }
        if (!installs.some((engines) => namesOnly(engines, BROWSERS_WORD))) {
          problems.push({
            code: 'BROWSER_INSTALL_DRIFT',
            message: `Job ${id}: a step before ${HTTPS_TESTS} must be exactly "pnpm --filter @melarc/e2e exec playwright install [--with-deps] ${MATRIX_BROWSERS}": the browsers of the entry, which are the ones its runs need.`,
          });
        }
        for (const fault of httpsMatrix(body).faults) {
          problems.push({ code: 'HTTPS_SHARDS_DRIFT', message: `Job ${id}: ${fault}.` });
        }
        problems.push(
          ...checkUploadNames(id, steps, ['${{ matrix.shard }}'], '${{ matrix.shard }}'),
        );
        return;
      }

      if (env.MELARC_BROWSERS !== MATRIX_ENGINE) {
        problems.push({
          code: 'BROWSER_MATRIX_ENV',
          message: `Job ${id}: the step that runs ${BROWSER_TESTS} must set env MELARC_BROWSERS to exactly ${MATRIX_ENGINE}, or the tests run Chromium alone, or one engine in every job.`,
        });
      }
      if (env.MELARC_BROWSER_SHARD !== MATRIX_SHARD) {
        problems.push({
          code: 'BROWSER_SHARD_ENV',
          message: `Job ${id}: the step that runs ${BROWSER_TESTS} must set env MELARC_BROWSER_SHARD to exactly ${MATRIX_SHARD}, or every job runs the whole of its engine, or the same part of it.`,
        });
      }
      if (!installs.some((engines) => namesOnly(engines, ENGINE_WORD))) {
        problems.push({
          code: 'BROWSER_INSTALL_DRIFT',
          message: `Job ${id}: a step before ${BROWSER_TESTS} must be exactly "pnpm --filter @melarc/e2e exec playwright install [--with-deps] ${MATRIX_ENGINE}": the engine of the entry, and no other.`,
        });
      }
      for (const fault of browserMatrix(body).faults) {
        problems.push({ code: 'BROWSER_SHARDS_DRIFT', message: `Job ${id}: ${fault}.` });
      }
      problems.push(
        ...checkUploadNames(
          id,
          steps,
          [MATRIX_ENGINE, '${{ matrix.shard }}'],
          `${MATRIX_ENGINE} and \${{ matrix.shard }}`,
        ),
      );
    });
  }
  return [...problems, ...checkBrowserEvents(jobs)];
}

const sameName = (value: unknown, name: string): boolean =>
  typeof value === 'string' && value.trim().toLowerCase() === name.toLowerCase();

/**
 * The verdict is the check a branch rule requires by name, so the aggregate job must carry exactly that name and
 * no other job or step may (whatever its case or spacing), or a job that judges nothing could stand in for it.
 */
function checkVerdictName(jobs: readonly Job[]): WorkflowProblem[] {
  const problems: WorkflowProblem[] = [];
  const aggregate = jobs.find(({ id }) => id === AGGREGATE_JOB);
  if (aggregate !== undefined && aggregate.body.name !== VERDICT_NAME) {
    problems.push({
      code: 'AGGREGATE_NAME',
      message: `Job ${AGGREGATE_JOB} must have name: ${VERDICT_NAME}, the check the branch rule for main requires.`,
    });
  }
  for (const { id, body, expanded } of jobs) {
    if (id !== AGGREGATE_JOB && sameName(body.name, VERDICT_NAME)) {
      problems.push({
        code: 'AGGREGATE_NAME',
        message: `Job ${id} is named like the verdict (${VERDICT_NAME}); only job ${AGGREGATE_JOB} may be.`,
      });
    }
    for (const step of expanded.filter((candidate) => sameName(candidate.name, VERDICT_NAME))) {
      problems.push({
        code: 'AGGREGATE_NAME',
        message: `A step of job ${id} is named like the verdict (${String(step.name)}); only job ${AGGREGATE_JOB} may be.`,
      });
    }
  }
  return problems;
}

function checkAggregate(jobs: readonly Job[]): WorkflowProblem[] {
  const aggregate = jobs.find(({ id }) => id === AGGREGATE_JOB);
  if (aggregate === undefined) {
    return [
      {
        code: 'AGGREGATE_MISSING',
        message: `The workflow needs one job with the id ${AGGREGATE_JOB} that waits for all the others and judges them.`,
      },
    ];
  }

  const problems: WorkflowProblem[] = [];
  const others = new Set(jobs.filter(({ id }) => id !== AGGREGATE_JOB).map(({ id }) => id));

  if (aggregate.body.if !== 'always()') {
    problems.push({
      code: 'AGGREGATE_NOT_ALWAYS',
      message: `Job ${AGGREGATE_JOB} must have "if: always()": skipped when a job it needs fails, it would count as passed.`,
    });
  }

  const needs = aggregate.body.needs;
  const needed = new Set(Array.isArray(needs) ? needs.filter((id) => typeof id === 'string') : []);
  if (!Array.isArray(needs) || needs.length !== needed.size || !same(needed, others)) {
    problems.push({
      code: 'AGGREGATE_NEEDS_DRIFT',
      message: `Job ${AGGREGATE_JOB} must need exactly every other job (${[...others].join(', ')}), each once.`,
    });
  }

  const commands = aggregate.steps.filter((step) => scriptOf(step).includes('ci-aggregate.ts'));
  const command = commands.length === 1 ? commands[0] : undefined;
  const named =
    command === undefined
      ? undefined
      : /^node scripts\/ci-aggregate\.ts((?:\s+\S+)+)\s*$/.exec(scriptOf(command).trim());
  const words = (named?.[1] ?? '').split(/\s+/).filter((word) => word !== '');
  const namedJobs = new Set(words.filter((word) => !word.startsWith('--')));
  const options = words.filter((word) => word.startsWith('--'));
  const skipOptions = options.filter((word) => word.startsWith(SKIP_OPTION));
  const planOptions = options.filter((word) => word.startsWith(PLAN_OPTION));
  const alwaysOptions = options.filter((word) => word.startsWith(ALWAYS_OPTION));
  const allowedToSkip = new Set(
    skipOptions.flatMap((word) => word.slice(SKIP_OPTION.length).split(',')),
  );
  if (
    command === undefined ||
    named === null ||
    !same(namedJobs, others) ||
    options.length !== skipOptions.length + planOptions.length + alwaysOptions.length
  ) {
    problems.push({
      code: 'AGGREGATE_COMMAND_DRIFT',
      message: `Job ${AGGREGATE_JOB} must run "node scripts/ci-aggregate.ts" once, naming exactly every other job, with no option but ${PLAN_OPTION}${PLAN_JOB}, ${ALWAYS_OPTION}<job id>[,<job id>...] and ${SKIP_OPTION}<job id>[,<job id>...].`,
    });
    return problems;
  }
  // The plan's answer is what lets the verdict accept the skips of a night that stood down, so the verdict must be told which job is the plan.
  if (planOptions.length !== 1 || planOptions[0] !== `${PLAN_OPTION}${PLAN_JOB}`) {
    problems.push({
      code: 'AGGREGATE_PLAN_DRIFT',
      message: `Job ${AGGREGATE_JOB} must name the plan once, as ${PLAN_OPTION}${PLAN_JOB}: without it a night that stands down is a failure, and with another job named a job's output decides.`,
    });
  }
  // The jobs the plan does not decide are the jobs whose skip the verdict never accepts: a night that stands down must still have audited.
  const alwaysNamed = alwaysOptions.flatMap((word) => word.slice(ALWAYS_OPTION.length).split(','));
  if (alwaysOptions.length !== 1 || !same(new Set(alwaysNamed), new Set(UNPLANNED_JOBS))) {
    problems.push({
      code: 'AGGREGATE_ALWAYS_DRIFT',
      message: `Job ${AGGREGATE_JOB} must name, once, in ${ALWAYS_OPTION}<job id>[,<job id>...], exactly the jobs the plan does not decide (${UNPLANNED_JOBS.join(', ')}): without it a night that stands down accepts a skip of them.`,
    });
  }
  const env = isRecord(command.env) ? command.env : {};
  if (env.NEEDS !== '${{ toJSON(needs) }}' || env.EVENT !== EVENT_NAME) {
    problems.push({
      code: 'AGGREGATE_ENV',
      message: `The aggregate step must set NEEDS to \${{ toJSON(needs) }} and EVENT to ${EVENT_NAME}, or it judges nothing, or cannot tell a pull request from the other runs.`,
    });
  }
  // The skip a pull request may be allowed is the skip the workflow makes there, and no other: a job the verdict accepts as skipped
  // that nothing skips would let a failure of its own pass as a skip, and a job that is skipped that the verdict does not allow
  // would turn every pull request red.
  const skippedThere = new Set(jobs.filter(skippedOnPullRequest).map(({ id }) => id));
  if (skipOptions.length > 1 || !same(allowedToSkip, skippedThere)) {
    problems.push({
      code: 'AGGREGATE_SKIP_DRIFT',
      message: `Job ${AGGREGATE_JOB} must allow to be skipped exactly the jobs that a pull request does not run (${[...skippedThere].join(', ') || 'none'}), in one ${SKIP_OPTION}<job id> option; it allows ${[...allowedToSkip].join(', ') || 'none'}.`,
    });
  }
  return problems;
}

/**
 * The plan (task CI.2, scripts/ci-plan.ts): a job `plan` that needs nothing, reads the workflow's runs (`actions: read`; without it the
 * question is refused, every night then runs, and nothing says so), runs the one command in a step with the id `plan` and hands its answer
 * on as the job's output; every other job needs it, and only it.
 */
function checkPlan(jobs: readonly Job[]): WorkflowProblem[] {
  const plan = jobs.find(({ id }) => id === PLAN_JOB);
  if (plan === undefined) {
    return [
      {
        code: 'PLAN_MISSING',
        message: `The workflow needs a job with the id ${PLAN_JOB} that runs "${PLAN_COMMAND}" first and answers whether the run is to run (outputs.run).`,
      },
    ];
  }
  const problems: WorkflowProblem[] = [];
  const drift = (message: string): void => {
    problems.push({ code: 'PLAN_DRIFT', message: `Job ${PLAN_JOB}: ${message}.` });
  };
  if ('needs' in plan.body)
    drift('it needs no job: it runs first, and every other job waits for it');
  const outputs = isRecord(plan.body.outputs) ? plan.body.outputs : {};
  if (outputs.run !== '${{ steps.plan.outputs.run }}') {
    drift('outputs.run must be exactly ${{ steps.plan.outputs.run }}, the answer of its step');
  }
  const permissions = plan.body.permissions;
  if (
    !isRecord(permissions) ||
    permissions.contents !== 'read' ||
    permissions.actions !== 'read' ||
    Object.keys(permissions).length !== 2
  ) {
    drift(
      'permissions must be contents: read and actions: read, and nothing else: the plan lists the runs of the workflow',
    );
  }
  const steps = plan.steps.filter((step) => scriptOf(step).trim() === PLAN_COMMAND);
  const step = steps.length === 1 ? steps[0] : undefined;
  if (step === undefined) {
    drift(`exactly one step must run "${PLAN_COMMAND}" as the whole of its script`);
  } else {
    if (step.id !== 'plan') drift('the step that runs the command must have id: plan');
    const env = isRecord(step.env) ? step.env : {};
    if (env.GH_TOKEN !== '${{ github.token }}') {
      drift(
        'the step must set env GH_TOKEN to exactly ${{ github.token }}, the read-only token of the run',
      );
    }
  }
  for (const { id, body } of jobs) {
    if (id === PLAN_JOB || id === AGGREGATE_JOB) continue;
    if (UNPLANNED_JOBS.includes(id)) {
      if ('needs' in body) {
        problems.push({
          code: 'UNPLANNED_JOB_DRIFT',
          message: `Job ${id} must have no "needs": the plan does not decide it, so it starts with the plan and runs whatever the plan says, and a plan that failed does not take it down with it.`,
        });
      }
      continue;
    }
    const needs = body.needs;
    const waitsForPlanOnly =
      needs === PLAN_JOB || (Array.isArray(needs) && needs.length === 1 && needs[0] === PLAN_JOB);
    if (!waitsForPlanOnly) {
      problems.push({
        code: 'JOB_NOT_PLANNED',
        message: `Job ${id} must have "needs: ${PLAN_JOB}" and no other need: it waits for the plan, whose answer its condition reads, and runs in parallel with the other jobs.`,
      });
    }
  }
  return problems;
}

/** The commands that run tests: each such step has a timeout of its own, below its job's. */
export const TIMED_COMMANDS: readonly string[] = [
  'pnpm run test',
  'pnpm run test:db',
  'pnpm run test:browser',
  'pnpm run test:e2e',
  'pnpm run test:e2e:https',
  'pnpm run verifier:test',
];
/**
 * What a job spends before its test step starts: the checkout, the toolchain, the JDK or the browsers, the build. **Measured** in the hosted run of the last green push to
 * main (d600057, 8 November 2026, the 33 jobs of the run, read from GitHub's own record of each step): 0.3 to 1.5 minutes before the test step in every job, the longest the
 * WebKit shard that restores its browser; rounded up to 2. A job that needs more says so here and the figure is measured again.
 */
export const SETUP_MINUTES = 2;
/**
 * What follows the test step in the worst case, and a runner that is slow to start or to finish: the diagnostics upload, the post steps of the job (the saves of the caches)
 * and the teardown.
 */
export const STEP_TIMEOUT_MARGIN_MINUTES = 2;
/**
 * The longest a test step may be given in a job of `jobMinutes` (run 4, Stage 1, item 7): the job's limit less what the job spends before the step and what it needs after it.
 * The step starts when the set-up is done, so a limit of the job's less only the margin would end after the job's own and the job would be cancelled, with the diagnostics
 * of exactly the run that hung lost; at this limit the step fails first, as a step, and the diagnostics are kept in the minutes that are left.
 */
export const stepLimitFor = (jobMinutes: number): number =>
  jobMinutes - SETUP_MINUTES - STEP_TIMEOUT_MARGIN_MINUTES;

/**
 * A hung test run is cut by the job's limit, which cancels the job: whatever the steps after it would keep goes with it. A step that has a
 * timeout of its own, below the job's, fails first, as a failure, and the diagnostics are uploaded in the minutes that are left.
 */
function checkStepTimeouts(jobs: readonly Job[]): WorkflowProblem[] {
  const problems: WorkflowProblem[] = [];
  for (const { id, body, steps } of jobs) {
    const jobLimit = body['timeout-minutes'];
    for (const step of steps.filter((candidate) =>
      TIMED_COMMANDS.includes(scriptOf(candidate).trim()),
    )) {
      const timeout = step['timeout-minutes'];
      const label = `${id}: ${scriptOf(step).trim()}`;
      if (typeof timeout !== 'number' || timeout < 1) {
        problems.push({
          code: 'STEP_TIMEOUT',
          message: `Step "${label}" needs a timeout-minutes of its own, a whole number from 1 and below its job's limit, so a hung run fails as a step and the diagnostics are kept.`,
        });
      } else if (typeof jobLimit === 'number' && timeout > stepLimitFor(jobLimit)) {
        problems.push({
          code: 'STEP_TIMEOUT',
          message: `Step "${label}" has timeout-minutes ${String(timeout)}, in a job of ${String(jobLimit)}: at most ${String(stepLimitFor(jobLimit))} (the job's limit less ${String(SETUP_MINUTES)} minutes of set-up, measured, and ${String(STEP_TIMEOUT_MARGIN_MINUTES)} of margin), or the job's limit cancels everything before the step's own does.`,
        });
      }
    }
  }
  return problems;
}

/** Where Playwright keeps the browsers it downloads on the runner. */
export const PLAYWRIGHT_CACHE_PATH = '~/.cache/ms-playwright';
/** The parts of the key of that cache: the runner's system, the lockfile (which pins the Playwright version) and the browsers. */
const CACHE_KEY_PARTS = ['${{ runner.os }}', "hashFiles('pnpm-lock.yaml')"];

/**
 * The browsers Playwright downloads are cached, so a run does not fetch them again: a cache step before every step that installs
 * them, on the path they go to, with a key that holds the runner's system, the lockfile and the browsers of the install (two engines
 * under one key would make the second a cache that lacks its browser, saved by nobody).
 */
function checkBrowserCaches(jobs: readonly Job[]): WorkflowProblem[] {
  const problems: WorkflowProblem[] = [];
  for (const { id, steps } of jobs) {
    steps.forEach((step, index) => {
      const written = scriptOf(step).trim();
      const engines = installedEngines(written);
      if (engines === undefined) return;
      const browsers = engines.map((word) =>
        word === ENGINE_WORD ? MATRIX_ENGINE : word === BROWSERS_WORD ? MATRIX_BROWSERS : word,
      );
      const caches = steps
        .slice(0, index)
        .filter((earlier) => isAction(earlier, 'actions/cache'))
        .filter((earlier) => inputsOf(earlier).path === PLAYWRIGHT_CACHE_PATH);
      const keys = caches.map((cache) => inputsOf(cache).key);
      const keyed = keys.some(
        (key) =>
          typeof key === 'string' &&
          [...CACHE_KEY_PARTS, ...browsers].every((part) => key.includes(part)),
      );
      if (!keyed) {
        problems.push({
          code: 'BROWSER_CACHE',
          message: `Job ${id}: a step before "${written}" must be an actions/cache of ${PLAYWRIGHT_CACHE_PATH} whose key holds ${[...CACHE_KEY_PARTS, ...browsers].join(', ')}, so the browsers are not downloaded in every run.`,
        });
      }
    });
  }
  return problems;
}

/** The variable that leaves the timing tests out (apps/api/test/timing-sensitive-tests.ts), and the one value it may be given in the workflow. */
export const TIMING_SKIP_VARIABLE = 'MELARC_SKIP_TIMING_TESTS';
export const TIMING_SKIP_VALUE =
  "${{ (github.event_name == 'pull_request' || github.event_name == 'push') && '1' || '' }}";
/** The variable that cuts the database tests into shards (apps/api/test/database-shard.ts). */
export const DATABASE_SHARD_VARIABLE = 'MELARC_DB_SHARD';
export const DATABASE_TESTS = 'pnpm run test:db';

/**
 * Who sets a variable of the database tests other than the step that runs them: the workflow, a job, or another step. A variable of
 * `apps/api/vitest.config.ts` set in the unit job would change what that job runs without a mark on the step that runs the tests.
 */
function variableStrays(workflow: unknown, jobs: readonly Job[], variable: string): string[] {
  const sets = (holder: unknown): boolean =>
    isRecord(holder) && isRecord(holder.env) && variable in holder.env;
  return [
    ...(sets(workflow) ? ['the workflow'] : []),
    ...jobs.filter(({ body }) => sets(body)).map(({ id }) => `job ${id}`),
    ...jobs.flatMap(({ id, steps }) =>
      steps
        .filter((step) => sets(step) && scriptOf(step).trim() !== DATABASE_TESTS)
        .map(
          (step) =>
            `a step of job ${id} (${typeof step.name === 'string' ? step.name : 'unnamed'})`,
        ),
    ),
  ];
}

const DATABASE_KEYS = ['shard', 'shards'];

/** One job of the database matrix: its shard of the database tests, counted from 1, out of how many. */
export interface DatabaseShardEntry {
  shard: number;
  shards: number;
}

export interface DatabaseMatrix {
  shards: DatabaseShardEntry[];
  faults: string[];
}

/**
 * The matrix of the database job: a literal list of the shards (`include`, each entry a shard and the number of shards), the shards 1 to N
 * each once with the same N in each entry, so that what Vitest cuts for the shard `current/total` belongs to one job and one only.
 */
export function databaseMatrix(job: Record<string, unknown>): DatabaseMatrix {
  const { entries, faults } = literalMatrix(job);
  const found: DatabaseShardEntry[] = [];
  for (const entry of entries) {
    const keys = keysOf(entry);
    if (!isRecord(entry) || keys.join() !== DATABASE_KEYS.join()) {
      faults.push(
        `an include entry must hold ${DATABASE_KEYS.join(', ')} and nothing else, not ${keys.length === 0 ? JSON.stringify(entry) : keys.join(', ')}`,
      );
      continue;
    }
    const { shard, shards } = entry;
    if (!isCount(shard) || !isCount(shards) || shard > shards) {
      faults.push(
        `the entry of shard ${JSON.stringify(shard)} of ${JSON.stringify(shards)} is not one: both are whole numbers from 1 and the shard is at most the number of shards`,
      );
    } else {
      found.push({ shard, shards });
    }
  }
  if (found.length > 0) faults.push(...groupFaults('the database tests', found));
  return { shards: found, faults };
}

/** Every job of a workflow that runs the database tests, with the shards its matrix lists. */
export const databaseJobsOf = (
  workflowText: string,
): { id: string; entries: DatabaseShardEntry[]; faults: string[] }[] =>
  jobsOf(parse(workflowText))
    .filter((job) => job.steps.some((step) => scriptOf(step).trim() === DATABASE_TESTS))
    .map(({ id, body }) => {
      const matrix = databaseMatrix(body);
      return { id, entries: matrix.shards, faults: matrix.faults };
    });

/**
 * The database tests run as the jobs of a matrix (the whole suite is longer than a job may last): the step that runs them sets
 * MELARC_DB_SHARD to the entry's shard, the matrix lists its shards without a fault, and nothing else sets the variable. A pipeline that
 * stops setting it runs the whole suite in every job (and runs out of time), and one that drops an entry never runs that part.
 */
function checkDatabaseShards(workflow: unknown, jobs: readonly Job[]): WorkflowProblem[] {
  const problems: WorkflowProblem[] = [];
  const strays = variableStrays(workflow, jobs, DATABASE_SHARD_VARIABLE);
  if (strays.length > 0) {
    problems.push({
      code: 'DATABASE_SHARD_ENV',
      message: `${DATABASE_SHARD_VARIABLE} is set by ${strays.join(', ')}: only the step that runs "${DATABASE_TESTS}" may set it, or the tests of another step run in part.`,
    });
  }
  for (const { id, body, steps } of jobs) {
    for (const step of steps.filter((candidate) => scriptOf(candidate).trim() === DATABASE_TESTS)) {
      const env = isRecord(step.env) ? step.env : {};
      if (env[DATABASE_SHARD_VARIABLE] !== MATRIX_SHARD) {
        problems.push({
          code: 'DATABASE_SHARD_ENV',
          message: `Job ${id}: the step that runs ${DATABASE_TESTS} must set env ${DATABASE_SHARD_VARIABLE} to exactly ${MATRIX_SHARD}, or every job runs every database test, or the same part of them.`,
        });
      }
      for (const fault of databaseMatrix(body).faults) {
        problems.push({ code: 'DATABASE_SHARDS_DRIFT', message: `Job ${id}: ${fault}.` });
      }
    }
  }
  return problems;
}

/**
 * The database tests whose assertions are wall-clock time run everywhere but on a pull request (task CI.2): the step that runs the
 * database tests sets the variable to one value, which is 1 on a pull request and empty otherwise, and nothing else in the workflow
 * sets it (not the workflow, not a job, not another step), so a run on a push to main, at night or by hand cannot leave them out.
 */
function checkTimingSkip(workflow: unknown, jobs: readonly Job[]): WorkflowProblem[] {
  const problems: WorkflowProblem[] = [];
  const strays = variableStrays(workflow, jobs, TIMING_SKIP_VARIABLE);
  if (strays.length > 0) {
    problems.push({
      code: 'TIMING_SKIP_DRIFT',
      message: `${TIMING_SKIP_VARIABLE} is set by ${strays.join(', ')}: only the step that runs "${DATABASE_TESTS}" may set it, or a run that must run the timing tests leaves them out.`,
    });
  }
  const steps = jobs.flatMap(({ steps: own }) =>
    own.filter((step) => scriptOf(step).trim() === DATABASE_TESTS),
  );
  for (const step of steps) {
    const env = isRecord(step.env) ? step.env : {};
    if (env[TIMING_SKIP_VARIABLE] !== TIMING_SKIP_VALUE) {
      problems.push({
        code: 'TIMING_SKIP_DRIFT',
        message: `The step that runs "${DATABASE_TESTS}" must set env ${TIMING_SKIP_VARIABLE} to exactly ${TIMING_SKIP_VALUE}: 1 on a pull request and on a push to main, which leave the timing tests out, and empty on the nightly and manual runs, which run them.`,
      });
    }
  }
  return problems;
}

function pathsOf(step: Step): string[] {
  const path = inputsOf(step).path;
  return typeof path === 'string' ? linesOf(path).filter((line) => line !== '') : [];
}

function checkArtifacts(jobs: readonly Job[]): WorkflowProblem[] {
  const problems: WorkflowProblem[] = [];
  for (const { id, steps } of jobs) {
    steps.forEach((step, index) => {
      if (!isUpload(step)) return;
      const inputs = inputsOf(step);
      const label = `${id}: ${typeof step.name === 'string' ? step.name : '(unnamed upload)'}`;
      const conditional = 'if' in step;

      if (typeof inputs.name !== 'string' || !inputs.name.includes(REVISION)) {
        problems.push({
          code: 'ARTIFACT_NOT_REVISIONED',
          message: `Artifact "${label}" must have ${REVISION} in its name, so it says which commit it came from.`,
        });
      }

      const policy = inputs['if-no-files-found'];
      const allowed = conditional ? ['error', 'ignore'] : ['error'];
      if (typeof policy !== 'string' || !allowed.includes(policy)) {
        problems.push({
          code: 'ARTIFACT_POLICY',
          message: `Artifact "${label}" must set if-no-files-found to ${allowed.join(' or ')}; the default only warns.`,
        });
      }

      if (!conditional) {
        problems.push(...checkKeptBuild(id, label, steps, index));
        if (inputs['include-hidden-files'] !== true) {
          problems.push({
            code: 'ARTIFACT_HIDDEN_FILES',
            message: `Artifact "${label}" must set include-hidden-files: true; an upload that skips a dotfile would not match the manifest.`,
          });
        }
      }
    });
  }
  return problems;
}

const TEST_COMMANDS = ['pnpm run test:browser', 'pnpm run test:e2e', 'pnpm run test:e2e:https'];
const MANIFEST_FILE = 'build-manifest.json';

/**
 * What a published build must come with: the clean-tree check and then the manifest, both after the tests that
 * ran against the build, a manifest that lists exactly what is uploaded, and the manifest itself in the upload.
 */
function checkKeptBuild(
  id: string,
  label: string,
  steps: readonly Step[],
  uploadAt: number,
): WorkflowProblem[] {
  const scripts = steps.map(scriptOf);
  const before = scripts.slice(0, uploadAt);
  const cleanAt = before.findIndex((script) =>
    linesOf(script).includes('node scripts/ci-revision.ts clean'),
  );
  const manifestAt = before.findIndex((script) =>
    /^node scripts\/ci-revision\.ts manifest\s/m.test(script),
  );
  const uploaded = pathsOf(steps[uploadAt] ?? {});

  const problems: WorkflowProblem[] = [];
  if (
    cleanAt === -1 ||
    manifestAt === -1 ||
    cleanAt > manifestAt ||
    !uploaded.includes(MANIFEST_FILE)
  ) {
    problems.push({
      code: 'ARTIFACT_WITHOUT_MANIFEST',
      message: `Artifact "${label}" must follow "ci-revision.ts clean" then "ci-revision.ts manifest", and include ${MANIFEST_FILE}.`,
    });
    return problems;
  }

  const lastTestAt = scripts.findLastIndex((script) =>
    linesOf(script).some((line) => TEST_COMMANDS.includes(line)),
  );
  if (cleanAt < lastTestAt) {
    problems.push({
      code: 'ARTIFACT_NOT_AFTER_TESTS',
      message: `Job ${id}: run "ci-revision.ts clean" and the manifest after the tests, or they describe a tree and a build that the tests have not yet run against.`,
    });
  }

  const manifestLine = linesOf(scripts[manifestAt] ?? '').find((line) =>
    line.startsWith('node scripts/ci-revision.ts manifest '),
  );
  const [, output, ...roots] = (manifestLine ?? '').split(/\s+/).slice(2);
  const kept = uploaded.filter((path) => path !== MANIFEST_FILE);
  if (output !== MANIFEST_FILE || !same(new Set(roots), new Set(kept))) {
    problems.push({
      code: 'ARTIFACT_ROOTS_DRIFT',
      message: `Job ${id}: the manifest must be written to ${MANIFEST_FILE} and list exactly the paths the artifact uploads (${kept.join(', ')}), or a kept file is unverifiable.`,
    });
  }
  return problems;
}

/**
 * Every rule the workflow must keep; empty means it keeps them all. `localActions` holds the files of the local
 * composite actions the workflow uses, whose steps are held to the rules on failures like the workflow's own.
 */
export function findWorkflowProblems(
  workflowText: string,
  localActions: LocalActions = {},
): WorkflowProblem[] {
  const workflow: unknown = parse(workflowText);
  const jobs = jobsOf(workflow, localActions);
  return [
    ...checkTriggers(workflow),
    ...checkPermissions(workflow, jobs),
    ...checkFailuresPropagate(jobs),
    ...checkRehearsal(workflow, jobs),
    ...checkCheckouts(jobs),
    ...checkRunners(jobs),
    ...checkCommands(workflow, jobs),
    ...checkBrowsers(jobs),
    ...checkBrowserCaches(jobs),
    ...checkPlan(jobs),
    ...checkStepTimeouts(jobs),
    ...checkTimingSkip(workflow, jobs),
    ...checkDatabaseShards(workflow, jobs),
    ...checkAggregate(jobs),
    ...checkVerdictName(jobs),
    ...checkArtifacts(jobs),
  ];
}

/** The jobs that start a PostgreSQL service must use the image of the local service (compose.yaml). */
export function findPostgresImageProblems(
  workflowText: string,
  composeText: string,
): WorkflowProblem[] {
  const compose: unknown = parse(composeText);
  const services = isRecord(compose) ? compose.services : undefined;
  const local =
    isRecord(services) && isRecord(services.postgres) ? services.postgres.image : undefined;
  if (typeof local !== 'string' || local === '') {
    return [
      {
        code: 'POSTGRES_IMAGE_DRIFT',
        message: 'The local compose service has no postgres image to compare with.',
      },
    ];
  }

  const using = jobsOf(parse(workflowText)).flatMap(({ id, body }) => {
    const jobServices = isRecord(body.services) ? body.services : undefined;
    const postgres =
      jobServices !== undefined && isRecord(jobServices.postgres)
        ? jobServices.postgres
        : undefined;
    return postgres === undefined ? [] : [{ id, image: postgres.image }];
  });
  if (using.length === 0) {
    return [
      {
        code: 'POSTGRES_IMAGE_DRIFT',
        message: 'No job starts a PostgreSQL service, so the database tests have none.',
      },
    ];
  }
  return using
    .filter(({ image }) => image !== local)
    .map(({ id, image }) => ({
      code: 'POSTGRES_IMAGE_DRIFT',
      message: `Job ${id} tests against ${String(image)}, not ${local}, the local service's image.`,
    }));
}
