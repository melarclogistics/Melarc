/**
 * Rules the CI workflow must keep, checked from its text. They guard against a pipeline that is green because it
 * asks less, not because the code is right:
 *
 *   - every mandatory command is still run, as the whole script of a step of its own: not after another command,
 *     not behind an echo, not in a longer script, and not in another shell or folder;
 *   - no failure can be absorbed (continue-on-error, `|| true`, `exit 0`) or skipped (a conditional job or step);
 *   - one aggregate job, which runs whatever happened, waits for every other job and judges them with
 *     scripts/ci-aggregate.ts, so a branch rule can require that single check (GitHub counts a skipped required
 *     check as passed, which is why the aggregate must run even when a job it needs failed). It alone is named
 *     "CI result", the name the branch rule requires;
 *   - the browser tests run all three engines: the step sets MELARC_BROWSERS to chromium,firefox,webkit and an
 *     earlier step of the job installs exactly those three;
 *   - every job runs on the one runner image the toolchain was tried on;
 *   - the workflow runs only on pushes, pull requests and by hand: not on events that give it a token that can
 *     write or secrets, and not on a schedule;
 *   - every job tests the commit the run is about, and what is published is described by a manifest of that
 *     commit (scripts/ci-revision.ts);
 *   - a step that fails on purpose to rehearse the pipeline runs only when someone asked for it by hand;
 *   - the token can only read.
 *
 * The workflow's pins (Node.js, pnpm, frozen install, action SHAs) are held by workspace-pins.ts.
 */

import { parse } from 'yaml';

import { expandSteps, type LocalActions } from './composite-actions.ts';
import { isAction, inputsOf, isRecord, stepsOf, type Step } from './workflow-shapes.ts';

export const AGGREGATE_JOB = 'ci';

/** What the pipeline must run, each as the whole script of a step of its own. */
export const REQUIRED_COMMANDS: readonly string[] = [
  'pnpm run format:check',
  'pnpm run lint',
  'pnpm run typecheck',
  'pnpm run test',
  'pnpm run build',
  'pnpm run contract:check',
  'pnpm --filter @melarc/api run db:check',
  'pnpm run api-client:check',
  'pnpm run test:db',
  'pnpm run test:browser',
  'pnpm run test:e2e',
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
  | 'BROWSER_INSTALL_DRIFT'
  | 'AGGREGATE_MISSING'
  | 'AGGREGATE_NAME'
  | 'AGGREGATE_NOT_ALWAYS'
  | 'AGGREGATE_NEEDS_DRIFT'
  | 'AGGREGATE_COMMAND_DRIFT'
  | 'AGGREGATE_ENV'
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
export const ALLOWED_TRIGGERS: readonly string[] = ['push', 'pull_request', 'workflow_dispatch'];
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
  const forbidden = triggerNames(triggers).filter((name) => !ALLOWED_TRIGGERS.includes(name));
  if (forbidden.length > 0) {
    problems.push({
      code: 'TRIGGER_FORBIDDEN',
      message: `CI may start only on ${ALLOWED_TRIGGERS.join(', ')}; remove ${forbidden.join(', ')}. Events such as pull_request_target and workflow_run run pull-request code with secrets and a token that can write.`,
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

function checkFailuresPropagate(jobs: readonly Job[]): WorkflowProblem[] {
  const problems: WorkflowProblem[] = [];
  for (const { id, body, expanded } of jobs) {
    if (id !== AGGREGATE_JOB && 'if' in body) {
      problems.push({
        code: 'JOB_CONDITIONAL',
        message: `Job ${id} has a condition, so it can be skipped. Mandatory jobs always run.`,
      });
    }
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
          message: `Step "${label}" has a condition, so it can be skipped. Only a failure-time artifact upload may.`,
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
const isFailureUpload = (step: Step): boolean => isUpload(step) && step.if === 'failure()';

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

/** The engines of the supported browsers (surfaces/ops-portal.md section 11), all of which CI must run. */
const BROWSERS: readonly string[] = ['chromium', 'firefox', 'webkit'];
const BROWSER_LIST = BROWSERS.join(',');
const BROWSER_TESTS = 'pnpm run test:browser';
/** The whole script of a step that downloads browsers: the options (`--with-deps`), then the engines. */
const BROWSER_INSTALL = /^pnpm (?:--filter \S+ )?exec playwright install((?: [^\s&|;<>]+)*)$/;

/** Whether the list is each of the three engines once (in any order). */
const namesEachEngineOnce = (engines: readonly string[]): boolean =>
  engines.toSorted().join(',') === BROWSERS.toSorted().join(',');

/** The engines a script installs when it is exactly an install command, or undefined when it is not one. */
function installedEngines(script: string): string[] | undefined {
  const match = BROWSER_INSTALL.exec(script.trim());
  if (match === null) return undefined;
  return (match[1] ?? '').split(' ').filter((word) => word !== '' && !word.startsWith('-'));
}

/**
 * The browser tests run the engines MELARC_BROWSERS names (Chromium alone when it is not set). CI runs all
 * three, so the step that runs them must set the variable to exactly that list, and a step before it, in the same
 * job, must install exactly those three engines: a pipeline that stops setting the variable or installs fewer
 * stays green while an engine is never run.
 */
function checkBrowsers(jobs: readonly Job[]): WorkflowProblem[] {
  const problems: WorkflowProblem[] = [];
  for (const { id, steps } of jobs) {
    steps.forEach((step, index) => {
      if (scriptOf(step).trim() !== BROWSER_TESTS) return;
      const env = isRecord(step.env) ? step.env : {};
      if (env.MELARC_BROWSERS !== BROWSER_LIST) {
        problems.push({
          code: 'BROWSER_MATRIX_ENV',
          message: `Job ${id}: the step that runs ${BROWSER_TESTS} must set env MELARC_BROWSERS to exactly ${BROWSER_LIST}, or the tests run Chromium alone.`,
        });
      }
      const installs = steps
        .slice(0, index)
        .map((earlier) => installedEngines(scriptOf(earlier)))
        .filter((engines) => engines !== undefined);
      if (!installs.some(namesEachEngineOnce)) {
        problems.push({
          code: 'BROWSER_INSTALL_DRIFT',
          message: `Job ${id}: a step before ${BROWSER_TESTS} must be exactly "pnpm --filter @melarc/e2e exec playwright install [--with-deps] ${BROWSERS.join(' ')}", naming each engine once.`,
        });
      }
    });
  }
  return problems;
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
  const namedJobs = new Set((named?.[1] ?? '').split(/\s+/).filter((id) => id !== ''));
  if (command === undefined || named === null || !same(namedJobs, others)) {
    problems.push({
      code: 'AGGREGATE_COMMAND_DRIFT',
      message: `Job ${AGGREGATE_JOB} must run "node scripts/ci-aggregate.ts" once, naming exactly every other job.`,
    });
  } else if (!isRecord(command.env) || command.env.NEEDS !== '${{ toJSON(needs) }}') {
    problems.push({
      code: 'AGGREGATE_ENV',
      message: `The aggregate step must set NEEDS to \${{ toJSON(needs) }}, or it judges nothing.`,
    });
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

const TEST_COMMANDS = ['pnpm run test:browser', 'pnpm run test:e2e'];
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
