/**
 * Rules the CI workflow must keep, checked from its text. They guard against a pipeline that is green because it
 * asks less, not because the code is right:
 *
 *   - every mandatory command is still run;
 *   - no failure can be absorbed (continue-on-error, `|| true`, `exit 0`) or skipped (a conditional job or step);
 *   - one aggregate job, which runs whatever happened, waits for every other job and judges them with
 *     scripts/ci-aggregate.ts, so a branch rule can require that single check (GitHub counts a skipped required
 *     check as passed, which is why the aggregate must run even when a job it needs failed);
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

/** What the pipeline must run, each as a whole line of some step's script. */
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
  | 'PERMISSIONS_BROAD'
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
  | 'AGGREGATE_MISSING'
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

function checkTriggers(workflow: unknown): WorkflowProblem[] {
  const triggers = isRecord(workflow) ? workflow.on : undefined;
  const push = isRecord(triggers) ? triggers.push : undefined;
  const branches = isRecord(push) ? push.branches : undefined;
  const pushesToMain = Array.isArray(branches) && branches.includes('main');
  const pullRequests = isRecord(triggers) && Object.hasOwn(triggers, 'pull_request');
  if (pushesToMain && pullRequests) return [];
  return [
    {
      code: 'TRIGGER_MISSING',
      message:
        'CI must run on pushes to main (on.push.branches) and on pull requests (on.pull_request).',
    },
  ];
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

function checkCommands(jobs: readonly Job[]): WorkflowProblem[] {
  const lines = new Set(
    jobs.flatMap(({ steps }) => steps.flatMap((step) => linesOf(scriptOf(step)))),
  );
  return REQUIRED_COMMANDS.filter((command) => !lines.has(command)).map((command) => ({
    code: 'COMMAND_MISSING',
    message: `No step runs "${command}" as a line of its script.`,
  }));
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
    ...checkCommands(jobs),
    ...checkAggregate(jobs),
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
