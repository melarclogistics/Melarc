import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { parse, stringify } from 'yaml';

import { aggregate, parseArguments } from './ci-aggregate.ts';
import {
  AGGREGATE_JOB,
  BROWSERS,
  DATABASE_SHARD_VARIABLE,
  DISPLAY_INSTALL,
  DISPLAY_WRAPPER,
  HEADED_VARIABLE,
  PLAN_JOB,
  UNPLANNED_JOBS,
  stepLimitFor,
  FAILURE_UPLOAD_CONDITION,
  MATRIX_BROWSERS,
  MATRIX_ENGINE,
  MATRIX_SHARD,
  MIGRATION_BASE_COMMAND,
  MIGRATION_BASE_STEP_ENV,
  MIGRATION_GUARD_COMMAND,
  PLAN_COMMAND,
  PLANNED_RUN,
  PULL_REQUEST_SKIP,
  REQUIRED_COMMANDS,
  TIMED_COMMANDS,
  TIMING_SKIP_VALUE,
  TIMING_SKIP_VARIABLE,
  browserMatrix,
  databaseMatrix,
  findPostgresImageProblems,
  findWorkflowProblems,
  httpsMatrix,
} from './ci-workflow.ts';
import { readLocalActions, workflowSteps } from './composite-actions.ts';
import { isRecord } from './workflow-shapes.ts';

type Json = Record<string, unknown>;

/** The jobs of the fixture workflow, by id. */
interface Jobs {
  plan: Json;
  static: Json;
  unit: Json;
  database: Json;
  integrated: Json;
  https: Json;
  'browser-chromium': Json;
  'browser-firefox-webkit': Json;
  audit: Json;
  verifier: Json;
  ci: Json;
}

const SHA = '0123456789abcdef0123456789abcdef01234567';
const GITHUB_SHA = '${{ github.sha }}';
const EVENT_NAME = '${{ github.event_name }}';

const CHECKOUT = {
  name: 'Check out',
  uses: `actions/checkout@${SHA}`,
  with: { ref: GITHUB_SHA, 'persist-credentials': false },
};
const SETUP = { name: 'Set up', uses: './.github/actions/setup' };
/** The limit of a test step's own: `stepLimitFor` the 10 of the fixture's jobs, which is the most the rule allows. */
const STEP_LIMIT = stepLimitFor(10);
/** A step that runs a command; a step that runs tests has a timeout of its own, as the rules require. */
const run = (command: string): Json => ({
  name: command,
  run: command,
  ...(TIMED_COMMANDS.includes(command) ? { 'timeout-minutes': STEP_LIMIT } : {}),
});
/** The cache of the browsers an install step downloads, keyed as the rules require: the system, the lockfile and the browsers. */
const cacheOf = (browsers: string): Json => ({
  name: 'Cache the browsers',
  uses: `actions/cache@${SHA}`,
  with: {
    path: '~/.cache/ms-playwright',
    key: `playwright-\${{ runner.os }}-${browsers}-\${{ hashFiles('pnpm-lock.yaml') }}`,
  },
});

const REHEARSAL = {
  name: 'Rehearse a failing check',
  if: "github.event_name == 'workflow_dispatch' && inputs.rehearse-failure",
  run: 'exit 1',
};
const DIAGNOSTICS = {
  name: 'Keep diagnostics',
  if: FAILURE_UPLOAD_CONDITION,
  uses: `actions/upload-artifact@${SHA}`,
  with: {
    name: `melarc-diagnostics-${GITHUB_SHA}`,
    path: 'e2e/test-results',
    'if-no-files-found': 'ignore',
  },
};
const BUILD_UPLOAD = {
  name: 'Keep the build',
  uses: `actions/upload-artifact@${SHA}`,
  with: {
    name: `melarc-build-${GITHUB_SHA}`,
    path: 'apps/api/dist\napps/ops-web/dist\ncontracts/openapi.yaml\nbuild-manifest.json',
    'if-no-files-found': 'error',
    'include-hidden-files': true,
  },
};
const MANIFEST_SCRIPT =
  'node scripts/ci-revision.ts manifest build-manifest.json apps/api/dist apps/ops-web/dist contracts/openapi.yaml';
const CLEAN_SCRIPT = 'node scripts/ci-revision.ts clean';
const BROWSER_TESTS = 'pnpm run test:browser';
const HTTPS_TESTS = 'pnpm run test:e2e:https';
/** The test step of a job that holds WebKit's runs runs under the virtual display (D-B4): the one prefix a mandatory command may have. */
const underDisplay = (command: string): string => `${DISPLAY_WRAPPER}${command}`;
/** The command a step runs, less that prefix: the steps these tests look for and take away are found by the command, wrapped or not. */
const commandOf = (step: Json): unknown =>
  typeof step.run === 'string' && step.run.startsWith(DISPLAY_WRAPPER)
    ? step.run.slice(DISPLAY_WRAPPER.length)
    : step.run;
/**
 * What the step of a job's tests keeps beside the variables a test sets on it: the value that turns WebKit headed, in a job that holds WebKit's runs (the Firefox and WebKit shards, the
 * HTTPS journeys; D-B4). A test that proves what the shard variables must be replaces the step's whole `env`, and the step must stay one the display rule accepts.
 */
const headedEnv = (jobId: string): Json =>
  jobId === 'browser-firefox-webkit' || jobId === 'https' ? { [HEADED_VARIABLE]: '1' } : {};
/** The commands that one step runs: the browser tests are run by two jobs (the Chromium shards, and the Firefox and WebKit shards). */
const SINGLE_STEP_COMMANDS = REQUIRED_COMMANDS.filter((command) => command !== BROWSER_TESTS);
/** A job of the HTTPS matrix installs the browsers its entry's runs need (e2e/harness/https-shards.ts), whatever they are. */
const INSTALL_BROWSERS = `pnpm --filter @melarc/e2e exec playwright install --with-deps ${MATRIX_BROWSERS}`;
/** The HTTPS shards, as the harness cuts them: the browsers of each shard's runs. */
const HTTPS_ENTRIES: Json[] = [
  { shard: 1, shards: 3, browsers: 'chromium' },
  { shard: 2, shards: 3, browsers: 'firefox' },
  { shard: 3, shards: 3, browsers: 'webkit' },
];
/** The database shards: a literal matrix of the shard and the number of shards, in the one job that runs the database tests. */
const DATABASE_ENTRIES: Json[] = [
  { shard: 1, shards: 3 },
  { shard: 2, shards: 3 },
  { shard: 3, shards: 3 },
];
/** The HTTPS job keeps its own artifact for each shard. */
const HTTPS_DIAGNOSTICS = {
  name: 'Keep the failure diagnostics',
  if: FAILURE_UPLOAD_CONDITION,
  uses: `actions/upload-artifact@${SHA}`,
  with: {
    name: `melarc-https-diagnostics-${GITHUB_SHA}-\${{ matrix.shard }}`,
    path: 'e2e/test-results',
    'if-no-files-found': 'ignore',
  },
};
/** A job of the browser matrix installs the engine of its entry and no other. */
const INSTALL_ENGINE = `pnpm --filter @melarc/e2e exec playwright install --with-deps ${MATRIX_ENGINE}`;
const INSTALL_CHROMIUM = 'pnpm --filter @melarc/e2e exec playwright install --with-deps chromium';
/** Every job of the browser matrix has its own artifact name, or two failed shards would upload under one. */
const SHARD_DIAGNOSTICS = {
  name: 'Keep the browser diagnostics',
  if: FAILURE_UPLOAD_CONDITION,
  uses: `actions/upload-artifact@${SHA}`,
  with: {
    name: `melarc-browser-diagnostics-${GITHUB_SHA}-${MATRIX_ENGINE}-\${{ matrix.shard }}`,
    path: 'apps/ops-web/test-results',
    'if-no-files-found': 'ignore',
  },
};
/** Different numbers of shards for the engines (the slowest has the most), as the real workflow has. */
const SHARD_COUNTS: Readonly<Record<string, number>> = { chromium: 2, firefox: 3, webkit: 2 };

/** The matrix entries of the fixture: every shard of the engines (all three unless told). */
function shardEntries(
  counts: Readonly<Record<string, number>> = SHARD_COUNTS,
  engines: readonly string[] = BROWSERS,
): Json[] {
  return engines.flatMap((engine) =>
    Array.from({ length: counts[engine] ?? 0 }, (_, index) => ({
      engine,
      shard: index + 1,
      shards: counts[engine],
    })),
  );
}

/** The one job a pull request does not run: the Firefox and WebKit shards of the browser tests. */
const OTHER_ENGINES = 'browser-firefox-webkit';
const JOB_IDS = [
  'plan',
  'static',
  'unit',
  'database',
  'integrated',
  'https',
  'browser-chromium',
  OTHER_ENGINES,
  'audit',
  'verifier',
];
/** The command of the verdict, with the one allowance and every job named. */
const AGGREGATE_COMMAND = `node scripts/ci-aggregate.ts --plan=plan --runs-always=audit --skipped-on-pull-request=${OTHER_ENGINES} ${JOB_IDS.join(' ')}`;

/** A job that waits for the plan and runs when it says so, as every job but the plan and the verdict does. */
function job(steps: Json[]): Json {
  return {
    name: 'A job',
    needs: 'plan',
    if: PLANNED_RUN,
    'runs-on': 'ubuntu-24.04',
    'timeout-minutes': 10,
    steps: [CHECKOUT, SETUP, ...steps],
  };
}

/** A job the plan does not decide (the dependency audit): no need and no condition, so it runs on every run, the nightly run that stands down included. */
function unplannedJob(steps: Json[]): Json {
  const made = job(steps);
  Reflect.deleteProperty(made, 'needs');
  Reflect.deleteProperty(made, 'if');
  return made;
}

/** The job that decides whether the run is to run. */
function planJob(): Json {
  return {
    name: 'Plan the run',
    'runs-on': 'ubuntu-24.04',
    'timeout-minutes': 5,
    permissions: { contents: 'read', actions: 'read' },
    outputs: { run: '${{ steps.plan.outputs.run }}' },
    steps: [
      CHECKOUT,
      { name: 'Decide', id: 'plan', env: { GH_TOKEN: '${{ github.token }}' }, run: PLAN_COMMAND },
    ],
  };
}

/**
 * A job of a browser matrix: its engine installed, its shard run, its own diagnostics. A job that holds WebKit's shards also has the display installed and runs the
 * tests under it, with the one value that turns WebKit headed (D-B4).
 */
function browserJob(entries: Json[]): Json {
  const webkit = entries.some((entry) => entry.engine === 'webkit');
  return {
    ...job([
      cacheOf(MATRIX_ENGINE),
      run(INSTALL_ENGINE),
      ...(webkit ? [run(DISPLAY_INSTALL)] : []),
      {
        ...run(BROWSER_TESTS),
        ...(webkit ? { run: underDisplay(BROWSER_TESTS) } : {}),
        env: {
          MELARC_BROWSERS: MATRIX_ENGINE,
          MELARC_BROWSER_SHARD: MATRIX_SHARD,
          ...(webkit ? { [HEADED_VARIABLE]: '1' } : {}),
        },
      },
      SHARD_DIAGNOSTICS,
    ]),
    strategy: { 'fail-fast': false, matrix: { include: entries } },
  };
}

function goodShared(): Json {
  return {
    name: 'CI',
    on: {
      push: { branches: ['main'] },
      pull_request: null,
      schedule: [{ cron: '17 2 * * 1-5' }],
      workflow_dispatch: { inputs: { 'rehearse-failure': { type: 'boolean', default: false } } },
    },
    permissions: { contents: 'read' },
    jobs: {
      plan: planJob(),
      static: job([
        run('pnpm run format:check'),
        run('pnpm run lint'),
        run('pnpm run typecheck'),
        run('pnpm --filter @melarc/api run db:check'),
        // The step that names the revision a push is held to, before the guard (run 6, Stage 1.3).
        { name: 'Name the base', env: { ...MIGRATION_BASE_STEP_ENV }, run: MIGRATION_BASE_COMMAND },
        run(MIGRATION_GUARD_COMMAND),
        run('pnpm run api-client:check'),
        REHEARSAL,
      ]),
      unit: job([run('pnpm run test')]),
      database: {
        ...job([
          {
            ...run('pnpm run test:db'),
            env: {
              [TIMING_SKIP_VARIABLE]: TIMING_SKIP_VALUE,
              [DATABASE_SHARD_VARIABLE]: MATRIX_SHARD,
            },
          },
        ]),
        strategy: { 'fail-fast': false, matrix: { include: DATABASE_ENTRIES } },
      },
      integrated: job([
        run('pnpm run build'),
        run('pnpm run contract:check'),
        cacheOf('chromium'),
        run(INSTALL_CHROMIUM),
        run('pnpm run test:e2e'),
        DIAGNOSTICS,
        run(CLEAN_SCRIPT),
        run(MANIFEST_SCRIPT),
        BUILD_UPLOAD,
      ]),
      https: {
        ...job([
          cacheOf(MATRIX_BROWSERS),
          run(INSTALL_BROWSERS),
          run('sudo apt-get install --no-install-recommends --yes libnss3-tools'),
          run(DISPLAY_INSTALL),
          {
            ...run(HTTPS_TESTS),
            run: underDisplay(HTTPS_TESTS),
            env: { MELARC_HTTPS_SHARD: MATRIX_SHARD, [HEADED_VARIABLE]: '1' },
          },
          HTTPS_DIAGNOSTICS,
        ]),
        strategy: { 'fail-fast': false, matrix: { include: HTTPS_ENTRIES } },
      },
      'browser-chromium': browserJob(shardEntries(SHARD_COUNTS, ['chromium'])),
      [OTHER_ENGINES]: {
        ...browserJob(shardEntries(SHARD_COUNTS, ['firefox', 'webkit'])),
        if: PULL_REQUEST_SKIP,
      },
      audit: unplannedJob([run('pnpm audit --audit-level high')]),
      verifier: job([run('pnpm run verifier:test')]),
      [AGGREGATE_JOB]: {
        name: 'CI result',
        if: 'always()',
        needs: JOB_IDS,
        'runs-on': 'ubuntu-24.04',
        'timeout-minutes': 5,
        steps: [
          CHECKOUT,
          {
            name: 'Judge',
            env: { NEEDS: '${{ toJSON(needs) }}', EVENT: '${{ github.event_name }}' },
            run: AGGREGATE_COMMAND,
          },
        ],
      },
    },
  };
}

/**
 * A workflow that keeps every rule. Built through JSON so that no step object is shared between jobs: a test
 * that changes one job's step must not change the others (and YAML would write the sharing as anchors).
 */
function good(): Json {
  return JSON.parse(JSON.stringify(goodShared())) as Json;
}

/** The workflow as YAML text, after `change` has edited a copy of the good one. */
function workflowWith(change: (workflow: Json, jobs: Jobs) => void): string {
  const workflow = good();
  change(workflow, workflow.jobs as Jobs);
  return stringify(workflow);
}

function codes(text: string): string[] {
  return findWorkflowProblems(text).map((problem) => problem.code);
}

function codesWith(change: (workflow: Json, jobs: Jobs) => void): string[] {
  return codes(workflowWith(change));
}

/**
 * The codes without the cache rule's: a test that alters an install step (to prove the install rule) leaves the key of the cache before it
 * naming other browsers than the step installs, which the cache rule reports on its own; its tests are in "the cache of the browsers" below.
 */
const withoutCache = (found: string[]): string[] =>
  found.filter((code) => code !== 'BROWSER_CACHE');

const stepsOf = (target: Json): Json[] => target.steps as Json[];

function stepAt(target: Json, index: number): Json {
  const step = stepsOf(target)[index];
  assert.ok(step !== undefined, `the job has no step ${String(index)}`);
  return step;
}

function stepNamed(target: Json, name: string): Json {
  const step = stepsOf(target).find((candidate) => candidate.name === name);
  assert.ok(step !== undefined, `the job has no step named ${name}`);
  return step;
}

function stepRunning(target: Json, script: string): Json {
  const step = stepsOf(target).find((candidate) => commandOf(candidate) === script);
  assert.ok(step !== undefined, `the job has no step that runs ${script}`);
  return step;
}

const allJobs = (jobs: Jobs): Json[] => [
  jobs.plan,
  jobs.static,
  jobs.unit,
  jobs.database,
  jobs.integrated,
  jobs.https,
  jobs['browser-chromium'],
  jobs['browser-firefox-webkit'],
  jobs.audit,
  jobs.verifier,
  jobs.ci,
];

/** The one step, in whichever job, whose whole script is `script`. */
function runningStep(jobs: Jobs, script: string): Json {
  const found = allJobs(jobs).flatMap((target) =>
    stepsOf(target).filter((step) => commandOf(step) === script),
  );
  assert.equal(
    found.length,
    1,
    `expected one step that runs ${script}, found ${String(found.length)}`,
  );
  const [step] = found;
  assert.ok(step !== undefined);
  return step;
}

/** The steps of a job without those that run `script`. */
function withoutScript(target: Json, script: string): Json[] {
  return stepsOf(target).filter((step) => commandOf(step) !== script);
}

describe('a consistent workflow', () => {
  it('is accepted', () => {
    assert.deepEqual(findWorkflowProblems(stringify(good())), []);
  });

  it('is accepted when the aggregate lists the jobs in another order', () => {
    assert.deepEqual(
      codesWith((_, jobs) => {
        jobs.ci.needs = [...JOB_IDS].reverse();
      }),
      [],
    );
  });

  it('names the aggregate job ci, as these tests assume', () => {
    assert.equal(AGGREGATE_JOB, 'ci');
  });
});

describe('the aggregate job', () => {
  // Break caught: no single verdict, so a branch rule has nothing to require.
  it('must exist', () => {
    assert.deepEqual(
      codesWith((_, jobs) => {
        Reflect.deleteProperty(jobs, 'ci');
      }),
      ['AGGREGATE_MISSING'],
    );
  });

  // Break caught: the verdict job skipped when a job it waits for fails; a skipped required check counts as
  // passed, so the failure would not block the merge.
  for (const condition of [
    undefined,
    'success()',
    '!cancelled()',
    'failure()',
    "always() && github.ref == 'x'",
  ]) {
    it(`must run whatever the others did, not with if: ${String(condition)}`, () => {
      assert.deepEqual(
        codesWith((_, jobs) => {
          if (condition === undefined) Reflect.deleteProperty(jobs.ci, 'if');
          else jobs.ci.if = condition;
        }),
        ['AGGREGATE_NOT_ALWAYS'],
      );
    });
  }

  // Break caught: a job that is not waited for, so its failure never reaches the verdict. The browser job is a matrix of
  // many jobs, and one entry in `needs` stands for all of them: the verdict's result for it is `success` only when every
  // shard succeeded, and `failure`, `cancelled` or `skipped` otherwise (scripts/ci-aggregate.test.ts holds the judging).
  for (const missing of JOB_IDS) {
    it(`must wait for the job ${missing}`, () => {
      assert.deepEqual(
        codesWith((_, jobs) => {
          jobs.ci.needs = JOB_IDS.filter((id) => id !== missing);
        }),
        ['AGGREGATE_NEEDS_DRIFT'],
      );
    });
  }

  it('must not wait for a job that does not exist', () => {
    assert.deepEqual(
      codesWith((_, jobs) => {
        jobs.ci.needs = [...JOB_IDS, 'ghost'];
      }),
      ['AGGREGATE_NEEDS_DRIFT'],
    );
  });

  it('must not list a job twice', () => {
    assert.deepEqual(
      codesWith((_, jobs) => {
        jobs.ci.needs = [...JOB_IDS, 'unit'];
      }),
      ['AGGREGATE_NEEDS_DRIFT'],
    );
  });

  it('must give needs as a list of job ids', () => {
    assert.deepEqual(
      codesWith((_, jobs) => {
        Reflect.deleteProperty(jobs.ci, 'needs');
      }),
      ['AGGREGATE_NEEDS_DRIFT'],
    );
  });

  // Break caught: a new job added to the workflow and to `needs` but not to the command, so the runtime check
  // would call the workflow drifted (or, worse, nobody would notice they disagree).
  it('must pass the command the same jobs as the workflow has', () => {
    assert.deepEqual(
      codesWith((_, jobs) => {
        stepAt(jobs.ci, 1).run = 'node scripts/ci-aggregate.ts static unit database integrated';
      }),
      ['AGGREGATE_COMMAND_DRIFT'],
    );
  });

  it('must run the aggregate command exactly once', () => {
    assert.deepEqual(
      codesWith((_, jobs) => {
        stepsOf(jobs.ci).pop();
      }),
      ['AGGREGATE_COMMAND_DRIFT'],
    );
  });

  // Break caught: a second run of the command that is not the one judged (one with another list of jobs, or
  // without the needs context), which would make the first one's verdict meaningless.
  it('must not run the aggregate command twice', () => {
    assert.deepEqual(
      codesWith((_, jobs) => {
        stepsOf(jobs.ci).push({ name: 'Judge again', run: 'node scripts/ci-aggregate.ts static' });
      }),
      ['AGGREGATE_COMMAND_DRIFT'],
    );
  });

  // Break caught: the command run without the needs context, so it would judge nothing.
  it('must hand the command the needs context', () => {
    assert.deepEqual(
      codesWith((_, jobs) => {
        stepAt(jobs.ci, 1).env = { NEEDS: '[]' };
      }),
      ['AGGREGATE_ENV'],
    );
    assert.deepEqual(
      codesWith((_, jobs) => {
        Reflect.deleteProperty(stepAt(jobs.ci, 1), 'env');
      }),
      ['AGGREGATE_ENV'],
    );
  });

  // Break caught: the verdict not told what the run is (the event dropped, or another expression), so that it cannot tell a pull request,
  // which may skip the Firefox and WebKit shards, from the runs that must not.
  for (const event of [undefined, '', 'push', '${{ github.ref }}', '${{ github.event_name }} ']) {
    it(`must hand the command the event as ${EVENT_NAME}, not ${JSON.stringify(event)}`, () => {
      assert.deepEqual(
        codesWith((_, jobs) => {
          stepAt(jobs.ci, 1).env = {
            NEEDS: '${{ toJSON(needs) }}',
            ...(event === undefined ? {} : { EVENT: event }),
          };
        }),
        ['AGGREGATE_ENV'],
      );
    });
  }

  // Break caught: the allowance of the verdict drifting from the jobs the workflow does not run on a pull request. A job accepted as skipped
  // that nothing skips would let a failure of its own be taken for a skip; a job skipped that the verdict does not allow turns every pull
  // request red. The allowance is one option, naming exactly the jobs that carry the one condition.
  const allowances: [label: string, command: string][] = [
    [
      'no allowance',
      `node scripts/ci-aggregate.ts --plan=plan --runs-always=audit ${JOB_IDS.join(' ')}`,
    ],
    [
      'another job allowed',
      `node scripts/ci-aggregate.ts --plan=plan --runs-always=audit --skipped-on-pull-request=unit ${JOB_IDS.join(' ')}`,
    ],
    [
      'the job and another allowed',
      `node scripts/ci-aggregate.ts --plan=plan --runs-always=audit --skipped-on-pull-request=${OTHER_ENGINES},browser-chromium ${JOB_IDS.join(' ')}`,
    ],
    [
      'the allowance given twice',
      `node scripts/ci-aggregate.ts --plan=plan --runs-always=audit --skipped-on-pull-request=${OTHER_ENGINES} --skipped-on-pull-request=${OTHER_ENGINES} ${JOB_IDS.join(' ')}`,
    ],
    [
      'a job that does not exist allowed',
      `node scripts/ci-aggregate.ts --plan=plan --runs-always=audit --skipped-on-pull-request=${OTHER_ENGINES},ghost ${JOB_IDS.join(' ')}`,
    ],
  ];
  for (const [label, command] of allowances) {
    it(`must allow to be skipped exactly the job a pull request does not run: not ${label}`, () => {
      assert.deepEqual(
        codesWith((_, jobs) => {
          stepAt(jobs.ci, 1).run = command;
        }),
        ['AGGREGATE_SKIP_DRIFT'],
      );
    });
  }

  it('must allow the skip of the job a pull request does not run, and say which job that is', () => {
    const problems = findWorkflowProblems(
      workflowWith((_, jobs) => {
        Reflect.deleteProperty(jobs[OTHER_ENGINES], 'if');
        stepAt(jobs.ci, 1).run = `node scripts/ci-aggregate.ts ${JOB_IDS.join(' ')}`;
      }),
    ).filter((problem) => problem.code === 'AGGREGATE_SKIP_DRIFT');
    assert.deepEqual(problems, []);
    const drift = findWorkflowProblems(
      workflowWith((_, jobs) => {
        stepAt(jobs.ci, 1).run = `node scripts/ci-aggregate.ts ${JOB_IDS.join(' ')}`;
      }),
    ).find((problem) => problem.code === 'AGGREGATE_SKIP_DRIFT');
    assert.match(
      drift?.message ?? '',
      /exactly the jobs that a pull request does not run \(browser-firefox-webkit\)/,
    );
  });

  // Break caught: an option that is misspelt or unknown read as no allowance and passing in the checks, or a flag counted as a job.
  for (const option of ['--skip-on-pull-request=unit', '--unknown', '--skipped-on-pull-request']) {
    it(`must give the command no option but the allowance: not ${option}`, () => {
      const found = codesWith((_, jobs) => {
        stepAt(jobs.ci, 1).run =
          `node scripts/ci-aggregate.ts ${option} --skipped-on-pull-request=${OTHER_ENGINES} ${JOB_IDS.join(' ')}`;
      });
      assert.deepEqual(found, ['AGGREGATE_COMMAND_DRIFT']);
    });
  }

  it('must not make its own step conditional', () => {
    assert.deepEqual(
      codesWith((_, jobs) => {
        stepAt(jobs.ci, 1).if = "github.event_name == 'push'";
      }),
      ['STEP_CONDITIONAL'],
    );
  });

  // Break caught: the verdict published under another name, which a branch rule that requires "CI result" would
  // never see: it would wait for a check that no job reports (or, worse, count another job as the verdict).
  for (const name of [undefined, 'CI', 'Result', 'CI Result', 'CI result ', 'ci result']) {
    it(`must be named "CI result", not ${JSON.stringify(name)}`, () => {
      assert.deepEqual(
        codesWith((_, jobs) => {
          if (name === undefined) Reflect.deleteProperty(jobs.ci, 'name');
          else jobs.ci.name = name;
        }),
        ['AGGREGATE_NAME'],
      );
    });
  }

  // Break caught: a second check that reports under the verdict's name, so a branch rule would be satisfied by
  // a job that judges nothing. Whatever the case or spacing, no other job or step may be named like it.
  for (const name of ['CI result', 'ci result', 'CI RESULT', ' CI result ']) {
    it(`must be the only job named like it: ${JSON.stringify(name)}`, () => {
      assert.deepEqual(
        codesWith((_, jobs) => {
          jobs.unit.name = name;
        }),
        ['AGGREGATE_NAME'],
      );
    });

    it(`must be the only step named like it: ${JSON.stringify(name)}`, () => {
      assert.deepEqual(
        codesWith((_, jobs) => {
          stepAt(jobs.unit, 2).name = name;
        }),
        ['AGGREGATE_NAME'],
      );
    });
  }

  it('must not have a step of its own named like it either', () => {
    assert.deepEqual(
      codesWith((_, jobs) => {
        stepAt(jobs.ci, 1).name = 'CI result';
      }),
      ['AGGREGATE_NAME'],
    );
  });

  it('reports a job named like the verdict even when the aggregate job is missing', () => {
    assert.deepEqual(
      codesWith((_, jobs) => {
        jobs.unit.name = 'CI result';
        Reflect.deleteProperty(jobs, 'ci');
      }).toSorted(),
      ['AGGREGATE_MISSING', 'AGGREGATE_NAME'],
    );
  });
});

describe('the runners', () => {
  // Break caught: a job moved to a runner image that is not the one the lockfile and the toolchain were tried
  // on (a moving label such as ubuntu-latest, an older image, a self-hosted machine, a computed value).
  const others = [
    'ubuntu-latest',
    'ubuntu-22.04',
    'ubuntu-24.04-arm',
    'windows-latest',
    'self-hosted',
    ['ubuntu-24.04'],
    '${{ matrix.os }}',
    undefined,
  ];
  for (const runner of others) {
    for (const id of ['unit', 'ci'] as const) {
      it(`rejects runs-on ${JSON.stringify(runner)} on the job ${id}`, () => {
        assert.deepEqual(
          codesWith((_, jobs) => {
            if (runner === undefined) Reflect.deleteProperty(jobs[id], 'runs-on');
            else jobs[id]['runs-on'] = runner;
          }),
          ['RUNNER_DRIFT'],
        );
      });
    }
  }

  // Break caught: a job that calls another workflow, whose steps this file's rules never see.
  it('rejects a job that calls a reusable workflow', () => {
    assert.deepEqual(
      codesWith((_, jobs) => {
        jobs.unit = { uses: './.github/workflows/other.yml', 'timeout-minutes': 5 };
      }).toSorted(),
      ['CHECKOUT_MISSING', 'COMMAND_MISSING', 'JOB_CONDITIONAL', 'JOB_NOT_PLANNED', 'RUNNER_DRIFT'],
    );
  });

  it('accepts every job on ubuntu-24.04', () => {
    assert.deepEqual(
      codesWith(() => undefined),
      [],
    );
  });
});

describe('mandatory failures propagate', () => {
  // Break caught: a failing step that lets the job go on and pass.
  for (const value of [true, 'true', '${{ always() }}']) {
    it(`rejects continue-on-error: ${JSON.stringify(value)} on a step`, () => {
      assert.deepEqual(
        codesWith((_, jobs) => {
          stepAt(jobs.unit, 2)['continue-on-error'] = value;
        }),
        ['CONTINUE_ON_ERROR'],
      );
    });
  }

  it('rejects continue-on-error on a job', () => {
    assert.deepEqual(
      codesWith((_, jobs) => {
        jobs.database['continue-on-error'] = true;
      }),
      ['CONTINUE_ON_ERROR'],
    );
  });

  it('accepts continue-on-error: false, which changes nothing', () => {
    assert.deepEqual(
      codesWith((_, jobs) => {
        stepAt(jobs.unit, 2)['continue-on-error'] = false;
      }),
      [],
    );
  });

  // Break caught: a command written so that its failure does not fail the step. Each is also reported as the
  // mandatory command missing, because the script of its step is no longer that command alone.
  const swallowed: [script: string, codes: string[]][] = [
    ['pnpm run test || true', ['COMMAND_MISSING', 'FAILURE_SWALLOWED']],
    ['pnpm run test || :', ['COMMAND_MISSING', 'FAILURE_SWALLOWED']],
    ['pnpm run test || exit 0', ['COMMAND_MISSING', 'FAILURE_SWALLOWED']],
    ['set +e\npnpm run test', ['COMMAND_MISSING', 'FAILURE_SWALLOWED']],
    ['pnpm run test\nexit 0', ['COMMAND_MISSING', 'FAILURE_SWALLOWED']],
  ];
  for (const [script, expected] of swallowed) {
    it(`rejects ${JSON.stringify(script)}`, () => {
      const found = codesWith((_, jobs) => {
        stepAt(jobs.unit, 2).run = script;
      });
      assert.deepEqual(found.toSorted(), expected);
    });
  }

  // Break caught: a mandatory job that may be skipped. The aggregate would refuse a skip, but the job should
  // not be skippable at all.
  it('rejects a condition on a job', () => {
    assert.deepEqual(
      codesWith((_, jobs) => {
        jobs.database.if = "github.event_name == 'push'";
      }),
      ['JOB_CONDITIONAL'],
    );
  });

  // Break caught: a check that does not run on some events.
  it('rejects a condition on a step that runs a check', () => {
    assert.deepEqual(
      codesWith((_, jobs) => {
        stepAt(jobs.unit, 2).if = "github.event_name == 'push'";
      }),
      ['STEP_CONDITIONAL'],
    );
  });

  // Break caught: a job that can hang for the runner's limit of six hours.
  for (const timeout of [undefined, 0, -1, 31, '10']) {
    it(`rejects timeout-minutes ${JSON.stringify(timeout)}`, () => {
      assert.deepEqual(
        codesWith((_, jobs) => {
          if (timeout === undefined) Reflect.deleteProperty(jobs.audit, 'timeout-minutes');
          else jobs.audit['timeout-minutes'] = timeout;
        }),
        ['JOB_NO_TIMEOUT'],
      );
    });
  }

  // Break caught: the limit moved by one at either end of the range, so that the longest allowed job (30) or
  // the shortest (1) is refused, or one minute beyond the longest is let through. The refusals above hold the
  // outside of the range; these hold its edges.
  for (const timeout of [1, 30]) {
    it(`accepts timeout-minutes ${String(timeout)}, an edge of the allowed range`, () => {
      assert.deepEqual(
        codesWith((_, jobs) => {
          jobs.audit['timeout-minutes'] = timeout;
        }),
        [],
      );
    });
  }
});

// The jobs share one composite action for the toolchain and the install. Its steps are held to the same rules
// on failures as the workflow's own, or a failing install could be absorbed there.
describe('the composite actions the jobs use', () => {
  const SETUP_ACTION = './.github/actions/setup';
  const composite = (...steps: Json[]): string =>
    stringify({ runs: { using: 'composite', steps } });
  const INSTALL: Json = { name: 'Install', run: 'pnpm install --frozen-lockfile', shell: 'bash' };

  /** The distinct problem codes when the setup action is `action` (the five jobs that use it repeat each one). */
  function codesWithSetup(action: string): string[] {
    const found = findWorkflowProblems(stringify(good()), { [SETUP_ACTION]: action });
    return [...new Set(found.map((problem) => problem.code))];
  }

  it('accepts an action whose steps keep the rules', () => {
    assert.deepEqual(codesWithSetup(composite(INSTALL)), []);
  });

  // Break caught: the install (or the toolchain) failing without failing the job, because the action says so.
  const breaks: [label: string, step: Json, code: string][] = [
    ['continue-on-error', { ...INSTALL, 'continue-on-error': true }, 'CONTINUE_ON_ERROR'],
    [
      'a swallowed failure',
      { ...INSTALL, run: 'pnpm install --frozen-lockfile || true' },
      'FAILURE_SWALLOWED',
    ],
    ['a condition', { ...INSTALL, if: "github.event_name == 'push'" }, 'STEP_CONDITIONAL'],
    [
      'an unguarded failing step',
      { name: 'Fail', run: 'exit 1', shell: 'bash' },
      'REHEARSAL_UNGUARDED',
    ],
  ];
  for (const [label, step, code] of breaks) {
    it(`rejects ${label} in a step of the action`, () => {
      assert.deepEqual(codesWithSetup(composite(INSTALL, step)), [code]);
    });
  }

  it('does not read an action the workflow does not use', () => {
    const unused = composite({ ...INSTALL, 'continue-on-error': true });
    const found = findWorkflowProblems(stringify(good()), { './.github/actions/other': unused });
    assert.deepEqual(found, []);
  });
});

/**
 * What else is reported when the step of one command is altered, because another rule holds the same step: the plan's step is the plan
 * (checkPlan), and the database step is the one that carries the variables of its shard and of the timing tests, which a step that no
 * longer is the command alone may not set.
 */
const ALSO_WHEN_ALTERED: Readonly<Record<string, readonly string[]>> = {
  [PLAN_COMMAND]: ['PLAN_DRIFT'],
  'pnpm run test:db': ['TIMING_SKIP_DRIFT', 'DATABASE_SHARD_ENV'],
};
/** And when the step is taken out: the plan job then has no step that runs the plan. */
const ALSO_WHEN_REMOVED: Readonly<Record<string, readonly string[]>> = {
  [PLAN_COMMAND]: ['PLAN_DRIFT'],
};

describe('mandatory commands', () => {
  // Break caught: a check deleted from the workflow (or its name changed so it runs something else), leaving a
  // pipeline that is green because it asks less.
  for (const command of SINGLE_STEP_COMMANDS) {
    it(`requires ${command}`, () => {
      const found = codesWith((_, jobs) => {
        for (const target of allJobs(jobs)) target.steps = withoutScript(target, command);
      });
      assert.deepEqual(found, ['COMMAND_MISSING', ...(ALSO_WHEN_REMOVED[command] ?? [])]);
    });
  }

  it('does not count a command that only appears in a comment or another command', () => {
    assert.deepEqual(
      codesWith((_, jobs) => {
        stepAt(jobs.unit, 2).run = '# pnpm run test\necho pnpm run test';
      }),
      ['COMMAND_MISSING'],
    );
  });

  // Break caught: a command that is still run, with spaces or line breaks around it, being reported as dropped.
  // A block scalar (`run: |`) ends with a line break, so a whole script is compared without its edges.
  for (const run of ['pnpm run test\n', '  pnpm run test   ', '\n\n    pnpm run test   \n\n']) {
    it(`counts a command that is the whole script of its step, as ${JSON.stringify(run)}`, () => {
      assert.deepEqual(
        codesWith((_, jobs) => {
          stepAt(jobs.unit, 2).run = run;
        }),
        [],
      );
    });
  }

  // Break caught: the command still named in a script that does more than run it, so that the step passes while
  // the check does not run (after another command or a condition, behind an echo, in a comment, in text that is
  // never run). The step must be the command and nothing else.
  const around: [label: string, script: (command: string) => string][] = [
    ['after another line', (command) => `echo start\n${command}\necho done`],
    ['before another line', (command) => `${command}\necho done`],
    ['indented among others', (command) => `echo start\n    ${command}   \necho done`],
    ['after &&', (command) => `true && ${command}`],
    ['before &&', (command) => `${command} && echo ok`],
    ['before ;', (command) => `${command}; echo ok`],
    ['after ;', (command) => `echo ok; ${command}`],
    ['behind echo', (command) => `echo ${command}`],
    ['inside quotes', (command) => `echo "${command}"`],
    ['behind a colon', (command) => `: ${command}`],
    ['in a comment', (command) => `# ${command}`],
    ['with a trailing comment', (command) => `${command} # ok`],
    ['in a condition', (command) => `if false; then\n${command}\nfi`],
    ['in a heredoc', (command) => `cat <<'EOF'\n${command}\nEOF`],
  ];
  for (const command of SINGLE_STEP_COMMANDS) {
    it(`requires ${command} to be the whole script of its step`, () => {
      for (const [label, script] of around) {
        assert.deepEqual(
          codesWith((_, jobs) => {
            runningStep(jobs, command).run = script(command);
          }),
          ['COMMAND_MISSING', ...(ALSO_WHEN_ALTERED[command] ?? [])],
          label,
        );
      }
    });
  }

  // Break caught: a failure absorbed by a command written after the check; both the command being no longer
  // alone (and so missing) and the swallowed failure are reported.
  it('still reports a failure swallowed after the command', () => {
    assert.deepEqual(
      codesWith((_, jobs) => {
        stepAt(jobs.unit, 2).run = 'pnpm run test || true';
      }).toSorted(),
      ['COMMAND_MISSING', 'FAILURE_SWALLOWED'],
    );
  });

  // Break caught: the same command run by a step that changes where or how it runs: another shell (a `python`
  // shell would not run it at all, `bash {0}` runs it without the usual stop on error) or another folder (where
  // the command is a different script or none).
  for (const command of SINGLE_STEP_COMMANDS) {
    for (const [key, value] of [
      ['shell', 'bash'],
      ['shell', 'bash {0}'],
      ['shell', 'python'],
      ['working-directory', 'apps/api'],
      ['working-directory', '/tmp'],
    ] as const) {
      it(`rejects ${key}: ${value} on the step that runs ${command}`, () => {
        assert.deepEqual(
          codesWith((_, jobs) => {
            runningStep(jobs, command)[key] = value;
          }),
          ['COMMAND_STEP_ALTERED'],
        );
      });
    }
  }

  // Break caught: a mandatory step made to run in another shell or folder from a default that sits far from it.
  it('rejects defaults.run on the workflow', () => {
    assert.deepEqual(
      codesWith((workflow) => {
        workflow.defaults = { run: { shell: 'bash {0}', 'working-directory': 'apps/api' } };
      }),
      ['DEFAULTS_RUN'],
    );
  });

  for (const defaults of [
    { run: { shell: 'bash {0}' } },
    { run: { 'working-directory': 'apps' } },
  ]) {
    it(`rejects defaults.run on a job: ${JSON.stringify(defaults)}`, () => {
      assert.deepEqual(
        codesWith((_, jobs) => {
          jobs.integrated.defaults = defaults;
        }),
        ['DEFAULTS_RUN'],
      );
    });
  }

  it('accepts defaults that name no run settings', () => {
    assert.deepEqual(
      codesWith((workflow, jobs) => {
        workflow.defaults = {};
        jobs.unit.defaults = {};
      }),
      [],
    );
  });

  // Break caught: every mandatory command made skippable or absorbable one step at a time, none by name.
  for (const command of SINGLE_STEP_COMMANDS) {
    it(`rejects a condition on the step that runs ${command}`, () => {
      for (const condition of [
        "github.event_name == 'push'",
        'always()',
        'failure()',
        'success()',
      ]) {
        assert.deepEqual(
          codesWith((_, jobs) => {
            runningStep(jobs, command).if = condition;
          }),
          ['STEP_CONDITIONAL'],
          condition,
        );
      }
    });

    it(`rejects continue-on-error on the step that runs ${command}`, () => {
      for (const value of [true, 'true', '${{ always() }}']) {
        assert.deepEqual(
          codesWith((_, jobs) => {
            runningStep(jobs, command)['continue-on-error'] = value;
          }),
          ['CONTINUE_ON_ERROR'],
        );
      }
    });
  }
});

// The browser tests of the Ops Portal run as the jobs of two matrices, one job for each shard of each engine, because one engine's whole run is
// longer than a job may last: the Chromium shards in one job, which every event runs, and the Firefox and WebKit shards in another, which a pull
// request does not (the Product Owner's decision of 7 November 2026). Each job is handed its engine (MELARC_BROWSERS) and its shard
// (MELARC_BROWSER_SHARD, which the Ops Portal's Playwright configuration reads as `--shard`) and installs that engine alone. Chromium alone is what
// the tests run when MELARC_BROWSERS is not set, which is why CI names the engine for every job. A pipeline that stops handing either variable,
// installs the wrong browser or lists a matrix with an engine or a shard missing stays green while tests are never run. That the shards together hold
// every test of the configuration, on each kind of run, is not read from this text: scripts/browser-shards.test.ts lists the tests of every shard.
const BROWSER_JOBS = ['browser-chromium', OTHER_ENGINES] as const;
type BrowserJobId = (typeof BROWSER_JOBS)[number];
const ENGINES_OF: Readonly<Record<BrowserJobId, readonly string[]>> = {
  'browser-chromium': ['chromium'],
  [OTHER_ENGINES]: ['firefox', 'webkit'],
};

describe('the browser tests, which two jobs run', () => {
  const codesOf = (change: (jobs: Jobs) => void): string[] =>
    codesWith((_, jobs) => {
      change(jobs);
    });
  const browserStep = (jobs: Jobs, id: BrowserJobId): Json => stepRunning(jobs[id], BROWSER_TESTS);

  // Break caught: the command removed from the jobs, or the job that holds the Firefox and WebKit shards left with a condition
  // once it no longer runs the browser tests (which would be a mandatory job that can be skipped for nothing).
  it('requires the command, and a job that holds shards to run it', () => {
    assert.deepEqual(
      codesOf((jobs) => {
        for (const id of BROWSER_JOBS) jobs[id].steps = withoutScript(jobs[id], BROWSER_TESTS);
      }).toSorted(),
      ['AGGREGATE_SKIP_DRIFT', 'COMMAND_MISSING', 'JOB_CONDITIONAL'],
    );
  });

  for (const id of BROWSER_JOBS) {
    // Break caught: the command still named in a script that does more than run it (after an echo, a condition, in a comment): the job
    // has stopped running the browser tests, and the engines it holds are run on no event.
    for (const [label, script] of [
      ['behind echo', (command: string) => `echo ${command}`],
      ['followed by || true', (command: string) => `${command} || true`],
      ['before ;', (command: string) => `${command}; echo ok`],
      ['in a comment', (command: string) => `# ${command}`],
      ['after another line', (command: string) => `echo start\n${command}`],
    ] as const) {
      it(`does not count the step of ${id} when it is not the command alone: ${label}`, () => {
        const found = codesOf((jobs) => {
          browserStep(jobs, id).run = script(BROWSER_TESTS);
        });
        assert.ok(found.includes('BROWSER_ENGINES_DRIFT'), found.join(', '));
      });
    }

    // Break caught: the step run in another shell or folder, where the command is another script or none, or made skippable or absorbable.
    for (const [key, value] of [
      ['shell', 'bash {0}'],
      ['shell', 'python'],
      ['working-directory', 'apps/api'],
    ] as const) {
      it(`rejects ${key}: ${value} on the step of ${id}`, () => {
        assert.deepEqual(
          codesOf((jobs) => {
            browserStep(jobs, id)[key] = value;
          }),
          ['COMMAND_STEP_ALTERED'],
        );
      });
    }

    it(`rejects a condition and continue-on-error on the step of ${id}`, () => {
      assert.deepEqual(
        codesOf((jobs) => {
          browserStep(jobs, id).if = "github.event_name == 'push'";
        }),
        ['STEP_CONDITIONAL'],
      );
      assert.deepEqual(
        codesOf((jobs) => {
          browserStep(jobs, id)['continue-on-error'] = true;
        }),
        ['CONTINUE_ON_ERROR'],
      );
    });
  }
});

// WebKit is launched headed under a virtual display in CI (the Product Owner's decision D-B4, 13 November 2026): the test steps of the jobs that hold WebKit's runs (the Firefox and WebKit shards
// of the browser tests, and the HTTPS journeys) are `xvfb-run ... <command>`, with the display installed before them and the one value that both Playwright configurations read set on them.
// A pipeline that dropped the wrapper, the value or the install would stay green while WebKit ran headless again (the stall the decision meets) or failed to open a window for want of a
// display; the same wrapper on a job that holds no WebKit would only hide where the display is wanted. The wrapper is the one prefix a mandatory command may have: `xvfb-run` returns the
// status of what it runs, so it hides no failure.
describe('WebKit under a virtual display', () => {
  const codesOf = (change: (jobs: Jobs) => void): string[] =>
    codesWith((_, jobs) => {
      change(jobs);
    });
  /** The jobs that hold WebKit's runs, and the command each runs. */
  const WEBKIT_JOBS = [
    [OTHER_ENGINES, BROWSER_TESTS],
    ['https', HTTPS_TESTS],
  ] as const;
  const jobOf = (jobs: Jobs, id: (typeof WEBKIT_JOBS)[number][0]): Json =>
    id === 'https' ? jobs.https : jobs[OTHER_ENGINES];

  it('is accepted as the fixture has it: the two jobs that hold WebKit run under the display, and the Chromium shards do not', () => {
    const jobs = good().jobs as Jobs;
    for (const [id, command] of WEBKIT_JOBS) {
      const step = stepRunning(jobOf(jobs, id), command);
      assert.equal(step.run, underDisplay(command), id);
      assert.equal((step.env as Json)[HEADED_VARIABLE], '1', id);
    }
    const chromium = stepRunning(jobs['browser-chromium'], BROWSER_TESTS);
    assert.equal(chromium.run, BROWSER_TESTS);
    assert.equal(HEADED_VARIABLE in (chromium.env as Json), false);
    assert.deepEqual(findWorkflowProblems(stringify(good())), []);
  });

  for (const [id, command] of WEBKIT_JOBS) {
    // Break caught: WebKit's tests run without the display: headless again (the stall of the hosted runs), or headed with no display to open a window on.
    it(`rejects the test step of ${id} without the wrapper`, () => {
      assert.deepEqual(
        codesOf((jobs) => {
          stepRunning(jobOf(jobs, id), command).run = command;
        }),
        ['DISPLAY_DRIFT'],
      );
    });

    // Break caught: the value that turns WebKit headed not set, empty or set to another value: both configurations launch WebKit headless, under a display that nobody uses.
    for (const value of [undefined, '', '0', 'true']) {
      it(`rejects the step of ${id} when ${HEADED_VARIABLE} is ${JSON.stringify(value)}`, () => {
        assert.deepEqual(
          codesOf((jobs) => {
            const env = stepRunning(jobOf(jobs, id), command).env as Json;
            if (value === undefined) Reflect.deleteProperty(env, HEADED_VARIABLE);
            else env[HEADED_VARIABLE] = value;
          }),
          ['DISPLAY_DRIFT'],
        );
      });
    }

    // Break caught: no install of the display (the runner image carries Xvfb today and another image may not; `xvfb-run` also needs `xauth`, which `--no-install-recommends` leaves out),
    // or one that comes after the tests.
    it(`rejects ${id} without the install of the display before the tests`, () => {
      assert.deepEqual(
        codesOf((jobs) => {
          jobOf(jobs, id).steps = withoutScript(jobOf(jobs, id), DISPLAY_INSTALL);
        }),
        ['DISPLAY_DRIFT'],
      );
      assert.deepEqual(
        codesOf((jobs) => {
          const steps = stepsOf(jobOf(jobs, id));
          const [install] = steps.splice(
            steps.findIndex((step) => step.run === DISPLAY_INSTALL),
            1,
          );
          assert.ok(install !== undefined);
          steps.splice(steps.findIndex((step) => commandOf(step) === command) + 1, 0, install);
        }),
        ['DISPLAY_DRIFT'],
      );
    });

    // Break caught: another wrapper (another way to start the display, a screen of 640 by 480 and 8 bits that the viewports do not fit, no automatic server number, a space more), which the
    // guard no longer reads as the command it wraps: the step would then be held to none of the rules of the browser tests.
    for (const wrapper of [
      'xvfb-run -a ',
      'xvfb-run --auto-servernum ',
      'xvfb-run --auto-servernum --server-args="-screen 0 640x480x8" ',
      DISPLAY_WRAPPER.replace('xvfb-run ', 'xvfb-run  '),
    ]) {
      it(`rejects ${JSON.stringify(wrapper)} on the test step of ${id}`, () => {
        const found = codesOf((jobs) => {
          stepRunning(jobOf(jobs, id), command).run = `${wrapper}${command}`;
        });
        assert.ok(found.includes('DISPLAY_DRIFT'), found.join(', '));
        // And the step is not read as the command it wraps: the job no longer runs the tests, which the rules about the command and about the engines of the run report.
        assert.ok(
          found.includes(id === 'https' ? 'COMMAND_MISSING' : 'BROWSER_ENGINES_DRIFT'),
          found.join(', '),
        );
      });
    }
  }

  // Break caught: the display on the Chromium shards, or the value on them, which would hide where the display is wanted: only a job that holds WebKit's runs has either.
  it('rejects the wrapper and the value on the Chromium shards', () => {
    assert.deepEqual(
      codesOf((jobs) => {
        stepRunning(jobs['browser-chromium'], BROWSER_TESTS).run = underDisplay(BROWSER_TESTS);
      }),
      ['DISPLAY_DRIFT'],
    );
    assert.deepEqual(
      codesOf((jobs) => {
        (stepRunning(jobs['browser-chromium'], BROWSER_TESTS).env as Json)[HEADED_VARIABLE] = '1';
      }),
      ['DISPLAY_DRIFT'],
    );
  });

  // Break caught: the wrapper spread to a command that is no test of the browsers, or `xvfb-run` written in a script of its own, where it would change what a mandatory command runs under.
  it('rejects the wrapper on any other command, and xvfb-run anywhere else', () => {
    assert.deepEqual(
      codesOf((jobs) => {
        stepRunning(jobs.static, 'pnpm run format:check').run =
          underDisplay('pnpm run format:check');
      }),
      ['DISPLAY_DRIFT'],
    );
    assert.deepEqual(
      codesOf((jobs) => {
        stepsOf(jobs.unit).push({ name: 'A display', run: 'xvfb-run --auto-servernum true' });
      }),
      ['DISPLAY_DRIFT'],
    );
  });
});

describe('the browser matrix', () => {
  const codesOf = (change: (jobs: Jobs) => void): string[] =>
    codesWith((_, jobs) => {
      change(jobs);
    });
  const browserStep = (jobs: Jobs, id: BrowserJobId): Json => stepRunning(jobs[id], BROWSER_TESTS);
  const installStep = (jobs: Jobs, id: BrowserJobId): Json => stepRunning(jobs[id], INSTALL_ENGINE);
  const strategyOf = (jobs: Jobs, id: BrowserJobId): Json => jobs[id].strategy as Json;
  const matrixOf = (jobs: Jobs, id: BrowserJobId): Json => strategyOf(jobs, id).matrix as Json;
  const entriesOf = (jobs: Jobs, id: BrowserJobId): Json[] => matrixOf(jobs, id).include as Json[];
  const faultsAfter = (id: BrowserJobId, change: (jobs: Jobs) => void): string[] => {
    const jobs = good().jobs as Jobs;
    change(jobs);
    return browserMatrix(jobs[id]).faults;
  };

  it('is accepted as the fixture has it: every shard of each engine, a different number of shards for each', () => {
    const jobs = good().jobs as Jobs;
    for (const id of BROWSER_JOBS) {
      const matrix = browserMatrix(jobs[id]);
      assert.deepEqual(matrix.faults, [], id);
      assert.deepEqual(
        [...new Set(matrix.shards.map((entry) => entry.engine))].toSorted(),
        [...ENGINES_OF[id]].toSorted(),
      );
    }
    assert.notEqual(new Set(Object.values(SHARD_COUNTS)).size, 1);
  });

  for (const id of BROWSER_JOBS) {
    // Break caught: the engine of the job not handed to the tests, or handed as a fixed list: every job runs Chromium alone, or all three
    // engines whole (and the run is as long as before it was split), or an engine that was not installed.
    for (const value of [
      undefined,
      '',
      'chromium',
      'chromium,firefox,webkit',
      '${{ matrix.shard }}',
      ' ${{ matrix.engine }}',
      '${{ matrix.engine }},firefox',
      '${{ vars.BROWSERS }}',
    ]) {
      it(`requires MELARC_BROWSERS to be ${MATRIX_ENGINE} in ${id}, not ${JSON.stringify(value)}`, () => {
        assert.deepEqual(
          codesOf((jobs) => {
            browserStep(jobs, id).env = {
              MELARC_BROWSER_SHARD: MATRIX_SHARD,
              ...headedEnv(id),
              ...(value === undefined ? {} : { MELARC_BROWSERS: value }),
            };
          }),
          ['BROWSER_MATRIX_ENV'],
        );
      });
    }

    // Break caught: the shard of the job not handed to the tests, or handed wrongly: every job runs the whole of its engine, or the same part
    // of it, and the rest of the tests are never run.
    for (const value of [
      undefined,
      '',
      '1/2',
      '${{ matrix.shard }}',
      '${{ matrix.shards }}',
      '${{ matrix.shards }}/${{ matrix.shard }}',
      '${{ matrix.shard }}/2',
      '${{ matrix.shard }} / ${{ matrix.shards }}',
    ]) {
      it(`requires MELARC_BROWSER_SHARD to be ${MATRIX_SHARD} in ${id}, not ${JSON.stringify(value)}`, () => {
        assert.deepEqual(
          codesOf((jobs) => {
            browserStep(jobs, id).env = {
              MELARC_BROWSERS: MATRIX_ENGINE,
              ...headedEnv(id),
              ...(value === undefined ? {} : { MELARC_BROWSER_SHARD: value }),
            };
          }),
          ['BROWSER_SHARD_ENV'],
        );
      });
    }

    it(`requires both variables on the step of ${id} itself, not only on the job`, () => {
      assert.deepEqual(
        codesOf((jobs) => {
          browserStep(jobs, id).env = { ...headedEnv(id) };
          jobs[id].env = { MELARC_BROWSERS: MATRIX_ENGINE, MELARC_BROWSER_SHARD: MATRIX_SHARD };
        }).toSorted(),
        ['BROWSER_MATRIX_ENV', 'BROWSER_SHARD_ENV'],
      );
    });

    it(`accepts other variables beside them in ${id}`, () => {
      assert.deepEqual(
        codesOf((jobs) => {
          browserStep(jobs, id).env = {
            CI: 'true',
            MELARC_BROWSERS: MATRIX_ENGINE,
            MELARC_BROWSER_SHARD: MATRIX_SHARD,
            ...headedEnv(id),
          };
        }),
        [],
      );
    });

    // Break caught: the install of a job naming the wrong browsers: all three (every job downloads the two it does not run), a fixed one
    // (the job of another engine fails for a missing browser, or, with Chromium installed, runs it), the engine and another, the engine
    // twice, or none (the default set).
    for (const [label, script] of [
      [
        'all three engines',
        'pnpm --filter @melarc/e2e exec playwright install --with-deps chromium firefox webkit',
      ],
      ['a fixed engine', 'pnpm --filter @melarc/e2e exec playwright install --with-deps chromium'],
      [
        'the engine and another',
        `pnpm --filter @melarc/e2e exec playwright install --with-deps ${MATRIX_ENGINE} firefox`,
      ],
      [
        'the engine twice',
        `pnpm --filter @melarc/e2e exec playwright install --with-deps ${MATRIX_ENGINE} ${MATRIX_ENGINE}`,
      ],
      ['none (the default set)', 'pnpm --filter @melarc/e2e exec playwright install --with-deps'],
      [
        'the shard',
        'pnpm --filter @melarc/e2e exec playwright install --with-deps ${{ matrix.shard }}',
      ],
      ['the browsers of the HTTPS matrix', `pnpm exec playwright install ${MATRIX_BROWSERS}`],
    ] as const) {
      it(`requires the install step of ${id} to install the engine of the entry alone: not ${label}`, () => {
        assert.deepEqual(
          withoutCache(
            codesOf((jobs) => {
              installStep(jobs, id).run = script;
            }),
          ),
          ['BROWSER_INSTALL_DRIFT'],
        );
      });
    }

    for (const script of [
      `pnpm --filter @melarc/e2e exec playwright install ${MATRIX_ENGINE}`,
      `pnpm exec playwright install --with-deps ${MATRIX_ENGINE}`,
      `pnpm --filter @melarc/e2e exec playwright install --with-deps ${MATRIX_ENGINE}\n`,
      `  pnpm exec playwright install ${MATRIX_ENGINE}  \n`,
    ]) {
      it(`accepts the install step ${JSON.stringify(script)} in ${id}`, () => {
        assert.deepEqual(
          codesOf((jobs) => {
            installStep(jobs, id).run = script;
          }),
          [],
        );
      });
    }

    // Break caught: the install step deleted, or kept in a form that does not install before the tests, or in another job.
    it(`requires an install step in ${id}, before the tests, in the job that runs them`, () => {
      assert.deepEqual(
        codesOf((jobs) => {
          jobs[id].steps = withoutScript(jobs[id], INSTALL_ENGINE);
        }),
        ['BROWSER_INSTALL_DRIFT'],
      );
      assert.deepEqual(
        codesOf((jobs) => {
          const steps = stepsOf(jobs[id]);
          const [install] = steps.splice(
            steps.findIndex((step) => step.run === INSTALL_ENGINE),
            1,
          );
          assert.ok(install !== undefined);
          steps.splice(
            steps.findIndex((step) => commandOf(step) === BROWSER_TESTS) + 1,
            0,
            install,
          );
        }),
        ['BROWSER_INSTALL_DRIFT'],
      );
      assert.deepEqual(
        withoutCache(
          codesOf((jobs) => {
            const [install] = stepsOf(jobs[id]).splice(
              stepsOf(jobs[id]).findIndex((step) => step.run === INSTALL_ENGINE),
              1,
            );
            assert.ok(install !== undefined);
            stepsOf(jobs.unit).push(install);
          }),
        ),
        ['BROWSER_INSTALL_DRIFT'],
      );
    });

    // Break caught: the install command inside a longer script, where a failure or a condition could skip it while the line stays in the file.
    for (const wrap of [
      (command: string) => `echo start\n${command}`,
      (command: string) => `${command} || true`,
      (command: string) => `echo ${command}`,
      (command: string) => `# ${command}`,
    ]) {
      it(`does not count an install step of ${id} that is not the command alone: ${JSON.stringify(wrap('INSTALL'))}`, () => {
        const found = codesOf((jobs) => {
          installStep(jobs, id).run = wrap(INSTALL_ENGINE);
        });
        assert.ok(found.includes('BROWSER_INSTALL_DRIFT'), found.join(', '));
      });
    }

    it(`rejects a condition on the install step of ${id} like on any other step`, () => {
      assert.deepEqual(
        codesOf((jobs) => {
          installStep(jobs, id).if = "github.event_name == 'push'";
        }),
        ['STEP_CONDITIONAL'],
      );
    });

    // Break caught: two shards that fail uploading under one name, of which the second upload is refused, so that the second shard's
    // evidence is lost; or a name that says nothing of which shard it came from.
    for (const [label, name] of [
      ['neither', `melarc-browser-diagnostics-${GITHUB_SHA}`],
      ['only the engine', `melarc-browser-diagnostics-${GITHUB_SHA}-${MATRIX_ENGINE}`],
      ['only the shard', `melarc-browser-diagnostics-${GITHUB_SHA}-\${{ matrix.shard }}`],
      [
        'only the number of shards',
        `melarc-browser-diagnostics-${GITHUB_SHA}-${MATRIX_ENGINE}-\${{ matrix.shards }}`,
      ],
    ] as const) {
      it(`rejects an artifact name in ${id} with ${label}`, () => {
        assert.deepEqual(
          codesOf((jobs) => {
            const upload = stepNamed(jobs[id], 'Keep the browser diagnostics');
            upload.with = { ...(upload.with as Json), name };
          }),
          ['ARTIFACT_NOT_PER_SHARD'],
        );
      });
    }

    // Break caught: a matrix that does not list the shards as the check reads them, so that the jobs that run are not the jobs this file
    // (and the test that lists the tests) can read.
    const shapes: [label: string, change: (jobs: Jobs) => void][] = [
      [
        'a job without a strategy',
        (jobs) => {
          Reflect.deleteProperty(jobs[id], 'strategy');
        },
      ],
      [
        'a matrix computed by an expression',
        (jobs) => {
          strategyOf(jobs, id).matrix = '${{ fromJSON(needs.plan.outputs.matrix) }}';
        },
      ],
      [
        'fail-fast left to its default',
        (jobs) => {
          Reflect.deleteProperty(strategyOf(jobs, id), 'fail-fast');
        },
      ],
      [
        'fail-fast true',
        (jobs) => {
          strategyOf(jobs, id)['fail-fast'] = true;
        },
      ],
      [
        'an exclude beside the list',
        (jobs) => {
          matrixOf(jobs, id).exclude = [{ engine: 'webkit', shard: 2 }];
        },
      ],
      [
        'a key that multiplies the list',
        (jobs) => {
          matrixOf(jobs, id).engine = BROWSERS;
        },
      ],
      [
        'an empty list',
        (jobs) => {
          matrixOf(jobs, id).include = [];
        },
      ],
      [
        'a list that is not a list',
        (jobs) => {
          matrixOf(jobs, id).include = '${{ fromJSON(x) }}';
        },
      ],
    ];
    for (const [label, change] of shapes) {
      it(`rejects ${label} in ${id}`, () => {
        const found = codesOf((jobs) => {
          change(jobs);
        });
        assert.ok(found.includes('BROWSER_SHARDS_DRIFT'), found.join(', '));
        // The only other findings are the engines an unreadable matrix leaves unrun, and a skip nothing makes any more.
        for (const code of found) {
          assert.ok(
            [
              'BROWSER_SHARDS_DRIFT',
              'BROWSER_ENGINES_DRIFT',
              'JOB_CONDITIONAL',
              'AGGREGATE_SKIP_DRIFT',
            ].includes(code),
            code,
          );
        }
      });
    }

    // Each of these entries is faulted and, not being counted, leaves its place in the engine's shards empty: two faults.
    const entries: [label: string, change: (entry: Json) => void][] = [
      ['an entry with a key of its own', (entry) => void (entry.os = 'ubuntu-24.04')],
      [
        'an entry without its number of shards',
        (entry) => void Reflect.deleteProperty(entry, 'shards'),
      ],
      ['a shard written as text', (entry) => void (entry.shard = '1')],
      ['shard 0', (entry) => void (entry.shard = 0)],
      ['a shard that is not whole', (entry) => void (entry.shard = 1.5)],
      ['a shard beyond its number of shards', (entry) => void (entry.shard = 9)],
      ['zero shards', (entry) => void (entry.shards = 0)],
      ['an engine written in capitals', (entry) => void (entry.engine = 'Chromium')],
    ];
    for (const [label, change] of entries) {
      it(`rejects ${label} in ${id}, and the place it leaves empty`, () => {
        const found = codesOf((jobs) => {
          const entry = entriesOf(jobs, id)[0];
          assert.ok(entry !== undefined);
          // An engine written in capitals is no engine of the job, so the job is faulted for it and for the shard it no longer holds.
          change(entry);
        });
        assert.deepEqual(
          found.filter((code) => code === 'BROWSER_SHARDS_DRIFT'),
          ['BROWSER_SHARDS_DRIFT', 'BROWSER_SHARDS_DRIFT'],
          found.join(', '),
        );
      });
    }
  }

  it('rejects an engine that is not one of the three', () => {
    const faults = faultsAfter('browser-chromium', (jobs) => {
      entriesOf(jobs, 'browser-chromium').push({ engine: 'msedge', shard: 1, shards: 1 });
    });
    assert.equal(faults.length, 1);
    assert.match(faults[0] ?? '', /engine "msedge"/);
  });

  // Break caught (the failure to show): a shard dropped from the list leaves the tests that Playwright puts in it to no job.
  it('rejects a dropped shard, and says which', () => {
    const faults = faultsAfter(OTHER_ENGINES, (jobs) => {
      matrixOf(jobs, OTHER_ENGINES).include = entriesOf(jobs, OTHER_ENGINES).filter(
        (entry) => !(entry.engine === 'firefox' && entry.shard === 2),
      );
    });
    assert.equal(faults.length, 1);
    assert.match(faults[0] ?? '', /firefox has no entry for shard 2 of 3/);
    const last = faultsAfter('browser-chromium', (jobs) => {
      matrixOf(jobs, 'browser-chromium').include = entriesOf(jobs, 'browser-chromium').filter(
        (entry) => entry.shard !== 2,
      );
    });
    assert.match(last[0] ?? '', /chromium has no entry for shard 2 of 2/);
  });

  it('rejects a shard listed twice', () => {
    const faults = faultsAfter(OTHER_ENGINES, (jobs) => {
      entriesOf(jobs, OTHER_ENGINES).push({ engine: 'webkit', shard: 1, shards: 2 });
    });
    assert.equal(faults.length, 1);
    assert.match(faults[0] ?? '', /webkit lists shard 1 of 2 more than once/);
  });

  // Break caught: entries of one engine that cut it into different numbers of shards: their parts overlap and leave tests out.
  it('rejects entries of one engine that disagree on the number of shards', () => {
    const faults = faultsAfter(OTHER_ENGINES, (jobs) => {
      const entry = entriesOf(jobs, OTHER_ENGINES).find(
        (candidate) => candidate.engine === 'firefox',
      );
      assert.ok(entry !== undefined);
      entry.shards = 4;
    });
    assert.equal(faults.length, 1);
    assert.match(faults[0] ?? '', /firefox disagree on the number of shards \(3, 4\)/);
  });

  it('accepts the entries in another order, and another number of shards for each engine', () => {
    assert.deepEqual(
      codesOf((jobs) => {
        matrixOf(jobs, OTHER_ENGINES).include = entriesOf(jobs, OTHER_ENGINES).toReversed();
      }),
      [],
    );
    assert.deepEqual(
      codesOf((jobs) => {
        matrixOf(jobs, OTHER_ENGINES).include = shardEntries({ firefox: 1, webkit: 4 }, [
          'firefox',
          'webkit',
        ]);
        matrixOf(jobs, 'browser-chromium').include = shardEntries({ chromium: 5 }, ['chromium']);
      }),
      [],
    );
  });
});

// What each kind of run runs of the browser tests (the Product Owner's decision of 7 November 2026): a pull request the Chromium shards, and
// a push to main, the nightly run and a manual run the shards of every engine, each engine in one job. The Firefox and WebKit shards are in a job
// of their own, `if: github.event_name != 'pull_request'`, because the matrix context is not available in a job-level condition.
describe('what each kind of run runs of the browser tests', () => {
  const matrixOf = (jobs: Jobs, id: BrowserJobId = 'browser-chromium'): Json =>
    (jobs[id].strategy as Json).matrix as Json;
  const entriesOf = (jobs: Jobs, id: BrowserJobId = 'browser-chromium'): Json[] =>
    matrixOf(jobs, id).include as Json[];
  const found = (change: (jobs: Jobs) => void) =>
    findWorkflowProblems(
      workflowWith((_, jobs) => {
        change(jobs);
      }),
    );
  const messagesOf = (problems: ReturnType<typeof findWorkflowProblems>, code: string): string[] =>
    problems.filter((problem) => problem.code === code).map((problem) => problem.message);

  it('is as the Product Owner decided in the fixture', () => {
    assert.deepEqual(
      found(() => undefined),
      [],
    );
  });

  // Break caught: the condition taken off the job of the Firefox and WebKit shards, so that a pull request runs them (17 more jobs, and a
  // verdict that waits for them): the engines run on a pull request must be Chromium alone.
  it('rejects the Firefox and WebKit shards without the condition, which would run them on a pull request', () => {
    const problems = found((jobs) => {
      jobs[OTHER_ENGINES].if = PLANNED_RUN;
    });
    assert.deepEqual(problems.map((problem) => problem.code).toSorted(), [
      'AGGREGATE_SKIP_DRIFT',
      'BROWSER_ENGINES_DRIFT',
    ]);
    assert.match(
      messagesOf(problems, 'BROWSER_ENGINES_DRIFT')[0] ?? '',
      /^On a pull request, the browser jobs also run firefox and webkit, and only chromium may/,
    );
  });

  it('rejects the same when the allowance is taken off the verdict as well, and says which run', () => {
    const problems = found((jobs) => {
      jobs[OTHER_ENGINES].if = PLANNED_RUN;
      stepAt(jobs.ci, 1).run =
        `node scripts/ci-aggregate.ts --plan=plan --runs-always=audit ${JOB_IDS.join(' ')}`;
    });
    assert.deepEqual(
      problems.map((problem) => problem.code),
      ['BROWSER_ENGINES_DRIFT'],
    );
  });

  // Break caught: any other condition on that job, which could skip it on main or at night, or on a pull request but not as decided.
  for (const condition of [
    "github.event_name == 'push'",
    "github.event_name != 'pull_request' && github.ref == 'refs/heads/main'",
    'github.event_name != "pull_request"',
    "github.event_name!='pull_request'",
    "github.event_name == 'schedule'",
    'always()',
    'success()',
    'false',
  ]) {
    it(`rejects the condition ${condition} on the Firefox and WebKit job, which never runs on main or at night as it should`, () => {
      const problems = found((jobs) => {
        jobs[OTHER_ENGINES].if = condition;
      });
      assert.deepEqual(
        problems.map((problem) => problem.code).toSorted(),
        [
          'AGGREGATE_SKIP_DRIFT',
          'BROWSER_ENGINES_DRIFT',
          'BROWSER_ENGINES_DRIFT',
          'BROWSER_ENGINES_DRIFT',
          'JOB_CONDITIONAL',
        ],
        condition,
      );
      for (const message of messagesOf(problems, 'BROWSER_ENGINES_DRIFT')) {
        assert.match(
          message,
          /^(On a push to main|In the nightly run|In a manual run), no browser job runs firefox or webkit/,
        );
      }
    });
  }

  // Break caught: the condition on a job that runs Chromium shards, or on a job that is not the browser tests: Chromium would be skipped on a
  // pull request, or a check skipped there that must run.
  it('rejects the condition on a job that holds Chromium shards, and on any other job', () => {
    const chromiumSkipped = found((jobs) => {
      jobs['browser-chromium'].if = PULL_REQUEST_SKIP;
    });
    assert.ok(chromiumSkipped.some((problem) => problem.code === 'JOB_CONDITIONAL'));
    assert.ok(
      messagesOf(chromiumSkipped, 'BROWSER_ENGINES_DRIFT')[0]?.startsWith(
        'On a pull request, no browser job runs chromium',
      ),
    );
    for (const id of [
      'static',
      'unit',
      'database',
      'integrated',
      'https',
      'audit',
      'verifier',
    ] as const) {
      const problems = found((jobs) => {
        jobs[id].if = PULL_REQUEST_SKIP;
      });
      assert.ok(
        problems.some((problem) => problem.code === 'JOB_CONDITIONAL'),
        id,
      );
    }
    const mixed = found((jobs) => {
      entriesOf(jobs, OTHER_ENGINES).push({ engine: 'chromium', shard: 1, shards: 1 });
    });
    assert.ok(mixed.some((problem) => problem.code === 'JOB_CONDITIONAL'));
  });

  // Break caught: an engine's shards listed in both jobs, which an event that runs both would run twice, and a pull request would then
  // run the engine that only the main branch may.
  it('rejects the shards of an engine listed in both jobs', () => {
    const problems = found((jobs) => {
      entriesOf(jobs).push({ engine: 'firefox', shard: 1, shards: 1 });
    });
    assert.ok(
      messagesOf(problems, 'BROWSER_ENGINES_DRIFT').some((message) =>
        message.startsWith(
          'The shards of firefox are listed in more than one job (browser-chromium, browser-firefox-webkit)',
        ),
      ),
    );
    assert.ok(
      messagesOf(problems, 'BROWSER_ENGINES_DRIFT').some((message) =>
        message.startsWith('On a pull request, the browser jobs also run firefox'),
      ),
    );
  });

  // Break caught (the failure to show): the Firefox or WebKit shards taken out of the workflow, so that main and the nightly run never run
  // them, though every pull request is as green as before.
  for (const engine of ['firefox', 'webkit']) {
    it(`reports ${engine} missing on main, at night and in a manual run, and not on a pull request`, () => {
      const problems = found((jobs) => {
        matrixOf(jobs, OTHER_ENGINES).include = entriesOf(jobs, OTHER_ENGINES).filter(
          (entry) => entry.engine !== engine,
        );
        // A job with no WebKit shard has no virtual display either (D-B4, the display rule): taking WebKit out takes the display with it, so that the engines are all this reports.
        if (engine === 'webkit') {
          const step = stepRunning(jobs[OTHER_ENGINES], BROWSER_TESTS);
          step.run = BROWSER_TESTS;
          Reflect.deleteProperty(step.env as Json, HEADED_VARIABLE);
        }
      });
      assert.deepEqual(
        problems.map((problem) => problem.code),
        ['BROWSER_ENGINES_DRIFT', 'BROWSER_ENGINES_DRIFT', 'BROWSER_ENGINES_DRIFT'],
      );
      assert.deepEqual(
        messagesOf(problems, 'BROWSER_ENGINES_DRIFT').map((message) => message.split(',')[0]),
        ['On a push to main', 'In the nightly run', 'In a manual run'],
      );
    });
  }

  it('reports Chromium missing on every kind of run', () => {
    const problems = found((jobs) => {
      matrixOf(jobs).include = [];
    });
    assert.equal(messagesOf(problems, 'BROWSER_ENGINES_DRIFT').length, 4);
  });

  // Break caught: every browser job taken out of the workflow, or one run that cannot be told apart from another.
  it('reports no engine on any kind of run when no job holds a shard', () => {
    const problems = found((jobs) => {
      for (const id of BROWSER_JOBS) {
        jobs[id].steps = withoutScript(jobs[id], BROWSER_TESTS);
      }
    });
    assert.ok(problems.some((problem) => problem.code === 'COMMAND_MISSING'));
  });
});

// The journeys over the trusted HTTPS origin run as the matrix of a job of their own, a shard of the run in each job (the shards of
// e2e/harness/https-shards.ts), because with the journeys over plain HTTP they were longer than a job may last. A job is handed its shard
// (MELARC_HTTPS_SHARD) and installs the browsers its runs need, which the harness's table says and scripts/https-shards.test.ts holds the matrix to.
describe('the HTTPS journeys', () => {
  const codesOf = (change: (jobs: Jobs) => void): string[] =>
    codesWith((_, jobs) => {
      change(jobs);
    });
  const httpsStep = (jobs: Jobs): Json => stepRunning(jobs.https, HTTPS_TESTS);
  const strategyOf = (jobs: Jobs): Json => jobs.https.strategy as Json;
  const matrixOf = (jobs: Jobs): Json => strategyOf(jobs).matrix as Json;
  const entriesOf = (jobs: Jobs): Json[] => matrixOf(jobs).include as Json[];
  const faultsAfter = (change: (jobs: Jobs) => void): string[] => {
    const jobs = good().jobs as Jobs;
    change(jobs);
    return httpsMatrix(jobs.https).faults;
  };

  it('is accepted as the fixture has it: all three shards, each with the browsers of its runs', () => {
    const jobs = good().jobs as Jobs;
    const matrix = httpsMatrix(jobs.https);
    assert.deepEqual(matrix.faults, []);
    assert.deepEqual(matrix.shards, [
      { shard: 1, shards: 3, browsers: ['chromium'] },
      { shard: 2, shards: 3, browsers: ['firefox'] },
      { shard: 3, shards: 3, browsers: ['webkit'] },
    ]);
  });

  // Break caught: the shard not handed to the run, or handed wrongly: every job makes every run of the journeys (the job is as long as it
  // was before it was split), or the same one.
  for (const value of [
    undefined,
    '',
    '1/2',
    '${{ matrix.shard }}',
    '${{ matrix.shards }}/${{ matrix.shard }}',
    '${{ matrix.shard }}/2',
    '${{ vars.SHARD }}',
  ]) {
    it(`requires MELARC_HTTPS_SHARD to be ${MATRIX_SHARD}, not ${JSON.stringify(value)}`, () => {
      assert.deepEqual(
        codesOf((jobs) => {
          httpsStep(jobs).env = {
            ...headedEnv('https'),
            ...(value === undefined ? {} : { MELARC_HTTPS_SHARD: value }),
          };
        }),
        ['HTTPS_SHARD_ENV'],
      );
    });
  }

  it('accepts other variables beside the shard, and requires it on the step itself', () => {
    assert.deepEqual(
      codesOf((jobs) => {
        httpsStep(jobs).env = {
          CI: 'true',
          MELARC_HTTPS_SHARD: MATRIX_SHARD,
          ...headedEnv('https'),
        };
      }),
      [],
    );
    assert.deepEqual(
      codesOf((jobs) => {
        httpsStep(jobs).env = { ...headedEnv('https') };
        jobs.https.env = { MELARC_HTTPS_SHARD: MATRIX_SHARD };
      }),
      ['HTTPS_SHARD_ENV'],
    );
  });

  // Break caught: the browsers of a shard not the ones its runs need: all three engines in each job (a download of two browsers for
  // nothing), the engines of the matrix of the browser tests, a fixed list (the Firefox shard without Firefox fails for a missing browser),
  // or the default set.
  for (const [label, script] of [
    [
      'all three engines',
      'pnpm --filter @melarc/e2e exec playwright install --with-deps chromium firefox webkit',
    ],
    ['a fixed engine', 'pnpm --filter @melarc/e2e exec playwright install --with-deps chromium'],
    ['the engine of the browser matrix', `pnpm exec playwright install ${MATRIX_ENGINE}`],
    [
      'the browsers and another',
      `pnpm exec playwright install --with-deps ${MATRIX_BROWSERS} webkit`,
    ],
    ['none (the default set)', 'pnpm --filter @melarc/e2e exec playwright install --with-deps'],
  ] as const) {
    it(`requires the install step to install the browsers of the entry alone: not ${label}`, () => {
      assert.deepEqual(
        withoutCache(
          codesOf((jobs) => {
            stepRunning(jobs.https, INSTALL_BROWSERS).run = script;
          }),
        ),
        ['BROWSER_INSTALL_DRIFT'],
      );
    });
  }

  for (const script of [
    `pnpm --filter @melarc/e2e exec playwright install ${MATRIX_BROWSERS}`,
    `pnpm exec playwright install --with-deps ${MATRIX_BROWSERS}`,
    `pnpm exec playwright install --with-deps ${MATRIX_BROWSERS}\n`,
  ]) {
    it(`accepts the install step ${JSON.stringify(script)}`, () => {
      assert.deepEqual(
        codesOf((jobs) => {
          stepRunning(jobs.https, INSTALL_BROWSERS).run = script;
        }),
        [],
      );
    });
  }

  // Break caught: the install step deleted, kept in a form that does not install before the journeys, or moved to another job.
  it('requires the install before the journeys, in the job that runs them', () => {
    assert.deepEqual(
      codesOf((jobs) => {
        jobs.https.steps = withoutScript(jobs.https, INSTALL_BROWSERS);
      }),
      ['BROWSER_INSTALL_DRIFT'],
    );
    assert.deepEqual(
      codesOf((jobs) => {
        const steps = stepsOf(jobs.https);
        const [install] = steps.splice(
          steps.findIndex((step) => step.run === INSTALL_BROWSERS),
          1,
        );
        assert.ok(install !== undefined);
        steps.splice(steps.findIndex((step) => commandOf(step) === HTTPS_TESTS) + 1, 0, install);
      }),
      ['BROWSER_INSTALL_DRIFT'],
    );
    assert.deepEqual(
      codesOf((jobs) => {
        stepRunning(jobs.https, INSTALL_BROWSERS).run = `echo ${INSTALL_BROWSERS}`;
      }),
      ['BROWSER_INSTALL_DRIFT'],
    );
  });

  it('rejects a condition on the install step like on any other step', () => {
    assert.deepEqual(
      codesOf((jobs) => {
        stepRunning(jobs.https, INSTALL_BROWSERS).if = "github.event_name == 'push'";
      }),
      ['STEP_CONDITIONAL'],
    );
  });

  // Break caught: two shards that fail uploading under one name, of which the second upload is refused.
  it('rejects an artifact name that does not carry the shard', () => {
    assert.deepEqual(
      codesOf((jobs) => {
        const upload = stepNamed(jobs.https, 'Keep the failure diagnostics');
        upload.with = { ...(upload.with as Json), name: `melarc-https-diagnostics-${GITHUB_SHA}` };
      }),
      ['ARTIFACT_NOT_PER_SHARD'],
    );
  });

  // Break caught: the job made one job again (a whole run, longer than a job may last), or a matrix the check cannot read.
  for (const [label, change] of [
    [
      'a job that is not a matrix',
      (jobs: Jobs) => void Reflect.deleteProperty(jobs.https, 'strategy'),
    ],
    [
      'a matrix computed by an expression',
      (jobs: Jobs) => void (strategyOf(jobs).matrix = '${{ fromJSON(x) }}'),
    ],
    ['fail-fast left true', (jobs: Jobs) => void (strategyOf(jobs)['fail-fast'] = true)],
    ['an exclude beside the list', (jobs: Jobs) => void (matrixOf(jobs).exclude = [{ shard: 2 }])],
    ['an empty list', (jobs: Jobs) => void (matrixOf(jobs).include = [])],
  ] as const) {
    it(`rejects ${label}`, () => {
      assert.deepEqual(
        codesOf((jobs) => {
          change(jobs);
        }),
        ['HTTPS_SHARDS_DRIFT'],
      );
    });
  }

  // Each of these entries is faulted and, not being counted, leaves its place empty: two faults.
  for (const [label, change] of [
    ['an entry with a key of its own', (entry: Json) => void (entry.os = 'ubuntu-24.04')],
    [
      'an entry without its browsers',
      (entry: Json) => void Reflect.deleteProperty(entry, 'browsers'),
    ],
    ['browsers that are not engines', (entry: Json) => void (entry.browsers = 'chrome')],
    ['an engine twice', (entry: Json) => void (entry.browsers = 'chromium chromium')],
    [
      'browsers separated by two spaces',
      (entry: Json) => void (entry.browsers = 'chromium  webkit'),
    ],
    ['no browser', (entry: Json) => void (entry.browsers = '')],
    ['a shard that is text', (entry: Json) => void (entry.shard = '1')],
    ['a shard beyond its number', (entry: Json) => void (entry.shard = 4)],
    ['shard 0', (entry: Json) => void (entry.shard = 0)],
  ] as const) {
    it(`rejects ${label}, and the place it leaves empty`, () => {
      const faults = faultsAfter((jobs) => {
        const entry = entriesOf(jobs)[0];
        assert.ok(entry !== undefined);
        change(entry);
      });
      assert.equal(faults.length, 2, faults.join(' | '));
    });
  }

  // Break caught (the failure to show): a shard dropped from the matrix leaves the runs it makes to no job.
  it('rejects a dropped shard, and says which', () => {
    const faults = faultsAfter((jobs) => {
      matrixOf(jobs).include = entriesOf(jobs).filter((entry) => entry.shard !== 2);
    });
    assert.deepEqual(faults, [
      'the HTTPS run has no entry for shard 2 of 3, so the tests of that shard are never run',
    ]);
  });

  it('rejects a shard listed twice, and shards that disagree on the total', () => {
    assert.match(
      faultsAfter((jobs) => {
        entriesOf(jobs).push({ shard: 2, shards: 3, browsers: 'firefox' });
      })[0] ?? '',
      /lists shard 2 of 3 more than once/,
    );
    assert.match(
      faultsAfter((jobs) => {
        const entry = entriesOf(jobs)[1];
        assert.ok(entry !== undefined);
        entry.shards = 4;
      })[0] ?? '',
      /disagree on the number of shards \(3, 4\)/,
    );
  });
});

describe('the revision under test', () => {
  // Break caught: a job that tests whatever ref the event resolves to later, so jobs of one run can test
  // different commits when a pull request's merge ref moves.
  for (const ref of [undefined, 'main', '${{ github.ref }}']) {
    it(`rejects a checkout with ref ${String(ref)}`, () => {
      assert.deepEqual(
        codesWith((_, jobs) => {
          stepAt(jobs.unit, 0).with = {
            'persist-credentials': false,
            ...(ref === undefined ? {} : { ref }),
          };
        }),
        ['CHECKOUT_NOT_REVISION'],
      );
    });
  }

  it('rejects a checkout that leaves the token in the repository', () => {
    assert.deepEqual(
      codesWith((_, jobs) => {
        stepAt(jobs.unit, 0).with = { ref: GITHUB_SHA };
      }),
      ['CHECKOUT_PERSISTS_CREDENTIALS'],
    );
  });

  it('rejects a job that does not check out the repository', () => {
    assert.deepEqual(
      codesWith((_, jobs) => {
        jobs.unit.steps = stepsOf(jobs.unit).slice(1);
      }),
      ['CHECKOUT_MISSING'],
    );
  });
});

describe('artifacts', () => {
  // Break caught: a build published under a name that does not say which commit it came from.
  it('names the revision in every artifact', () => {
    assert.deepEqual(
      codesWith((_, jobs) => {
        const upload = stepNamed(jobs.integrated, 'Keep the build');
        upload.with = { ...(upload.with as Json), name: 'melarc-build' };
      }),
      ['ARTIFACT_NOT_REVISIONED'],
    );
  });

  // Break caught: an upload that finds nothing and still succeeds, publishing an empty artifact.
  for (const policy of [undefined, 'warn', 'ignore']) {
    it(`requires the build artifact to fail when files are missing, not ${String(policy)}`, () => {
      assert.deepEqual(
        codesWith((_, jobs) => {
          const upload = stepNamed(jobs.integrated, 'Keep the build');
          const inputs = { ...(upload.with as Json) };
          if (policy === undefined) Reflect.deleteProperty(inputs, 'if-no-files-found');
          else inputs['if-no-files-found'] = policy;
          upload.with = inputs;
        }),
        ['ARTIFACT_POLICY'],
      );
    });
  }

  it('requires diagnostics to say what happens without files', () => {
    assert.deepEqual(
      codesWith((_, jobs) => {
        const upload = stepNamed(jobs.integrated, 'Keep diagnostics');
        upload.with = { name: `diagnostics-${GITHUB_SHA}`, path: 'e2e/test-results' };
      }),
      ['ARTIFACT_POLICY'],
    );
  });

  // Break caught: a build published with nothing tying it to the commit, or from a tree that was changed.
  it('requires the manifest and the clean-tree check before the build is published', () => {
    assert.deepEqual(
      codesWith((_, jobs) => {
        jobs.integrated.steps = withoutScript(jobs.integrated, MANIFEST_SCRIPT);
      }),
      ['ARTIFACT_WITHOUT_MANIFEST'],
    );
    assert.deepEqual(
      codesWith((_, jobs) => {
        jobs.integrated.steps = withoutScript(jobs.integrated, CLEAN_SCRIPT);
      }),
      ['ARTIFACT_WITHOUT_MANIFEST'],
    );
  });

  it('requires the clean-tree check to come before the manifest', () => {
    assert.deepEqual(
      codesWith((_, jobs) => {
        const clean = stepRunning(jobs.integrated, CLEAN_SCRIPT);
        const manifest = stepRunning(jobs.integrated, MANIFEST_SCRIPT);
        clean.run = MANIFEST_SCRIPT;
        manifest.run = CLEAN_SCRIPT;
      }),
      ['ARTIFACT_WITHOUT_MANIFEST'],
    );
  });

  it('requires the manifest file to be part of the artifact', () => {
    assert.deepEqual(
      codesWith((_, jobs) => {
        const upload = stepNamed(jobs.integrated, 'Keep the build');
        upload.with = { ...(upload.with as Json), path: 'apps/api/dist' };
      }),
      ['ARTIFACT_WITHOUT_MANIFEST'],
    );
  });

  // Break caught: the clean-tree check and the manifest run before the tests, so they describe a tree and a
  // build that the journey tests of the job have not yet run against (or touched). The browser tests and the HTTPS
  // journeys run in jobs of their own now, which keep nothing; the rule still names them, and the second case
  // puts one of them into this job to show it.
  it('requires the clean-tree check and the manifest to come after the journey tests', () => {
    assert.deepEqual(
      codesWith((_, jobs) => {
        const steps = stepsOf(jobs.integrated);
        const moved = steps.findIndex((step) => step.run === 'pnpm run test:e2e');
        const clean = steps.findIndex((step) => step.run === CLEAN_SCRIPT);
        const manifest = steps.findIndex((step) => step.run === MANIFEST_SCRIPT);
        // Put the test after the clean-tree check and the manifest, still before the upload.
        const [step] = steps.splice(moved, 1);
        assert.ok(step !== undefined && clean !== -1 && manifest !== -1);
        steps.splice(steps.findIndex((s) => s.run === MANIFEST_SCRIPT) + 1, 0, step);
      }),
      ['ARTIFACT_NOT_AFTER_TESTS'],
    );
    // The HTTPS journeys run in a job of their own, which keeps nothing, and the rule still names them: one put into this job after the
    // manifest is found late (besides what the HTTPS rules find of a job that is no matrix of the HTTPS shards).
    const late = codesWith((_, jobs) => {
      const steps = stepsOf(jobs.integrated);
      steps.splice(steps.findIndex((s) => s.run === MANIFEST_SCRIPT) + 1, 0, {
        name: 'Run the HTTPS journeys late',
        run: HTTPS_TESTS,
      });
    });
    assert.ok(late.includes('ARTIFACT_NOT_AFTER_TESTS'), late.join(', '));
  });

  // Break caught: a file uploaded that the manifest does not list (so `verify` cannot flag it), or listed
  // under a name the upload does not carry.
  const driftedRoots: [label: string, uploadPath: string, manifestRoots: string][] = [
    [
      'an uploaded path the manifest omits',
      'apps/api/dist\napps/ops-web/dist\ncontracts/openapi.yaml\napps/extra/dist\nbuild-manifest.json',
      'apps/api/dist apps/ops-web/dist contracts/openapi.yaml',
    ],
    [
      'a manifest root that is not uploaded',
      'apps/api/dist\ncontracts/openapi.yaml\nbuild-manifest.json',
      'apps/api/dist apps/ops-web/dist contracts/openapi.yaml',
    ],
  ];
  for (const [label, uploadPath, roots] of driftedRoots) {
    it(`requires the manifest to list what is uploaded: ${label}`, () => {
      assert.deepEqual(
        codesWith((_, jobs) => {
          const upload = stepNamed(jobs.integrated, 'Keep the build');
          upload.with = { ...(upload.with as Json), path: uploadPath };
          stepRunning(jobs.integrated, MANIFEST_SCRIPT).run =
            `node scripts/ci-revision.ts manifest build-manifest.json ${roots}`;
        }),
        ['ARTIFACT_ROOTS_DRIFT'],
      );
    });
  }

  it('requires the manifest to be written to the file that is uploaded', () => {
    assert.deepEqual(
      codesWith((_, jobs) => {
        stepRunning(jobs.integrated, MANIFEST_SCRIPT).run = MANIFEST_SCRIPT.replace(
          'build-manifest.json',
          'other.json',
        );
      }),
      ['ARTIFACT_ROOTS_DRIFT'],
    );
  });

  // Break caught: an upload that skips dotfiles while the manifest lists them, so the kept build fails its own
  // verification.
  for (const value of [undefined, false, 'true']) {
    it(`requires include-hidden-files: true, not ${String(value)}`, () => {
      assert.deepEqual(
        codesWith((_, jobs) => {
          const upload = stepNamed(jobs.integrated, 'Keep the build');
          const inputs = { ...(upload.with as Json) };
          if (value === undefined) Reflect.deleteProperty(inputs, 'include-hidden-files');
          else inputs['include-hidden-files'] = value;
          upload.with = inputs;
        }),
        ['ARTIFACT_HIDDEN_FILES'],
      );
    });
  }

  it('allows only a failure condition on an upload', () => {
    assert.deepEqual(
      codesWith((_, jobs) => {
        stepNamed(jobs.integrated, 'Keep the build').if = "github.ref == 'x'";
      }),
      ['STEP_CONDITIONAL'],
    );
  });
});

describe('the rehearsal of a failing check', () => {
  // Break caught: a step that fails on purpose and is not limited to a manual run that asked for it, so every
  // push would be red.
  for (const condition of [
    undefined,
    'inputs.rehearse-failure',
    "github.event_name == 'workflow_dispatch'",
    'always()',
  ]) {
    it(`must be guarded, not if: ${String(condition)}`, () => {
      const found = codesWith((_, jobs) => {
        const step = stepRunning(jobs.static, 'exit 1');
        if (condition === undefined) Reflect.deleteProperty(step, 'if');
        else step.if = condition;
      });
      // Reported for the step itself; and with it unguarded, no guarded rehearsal is left.
      assert.deepEqual(found.toSorted(), ['REHEARSAL_MISSING', 'REHEARSAL_UNGUARDED']);
    });
  }

  // Break caught: the live proof of the pipeline's validation disappearing without a test noticing: the step
  // deleted, or the input renamed so that `inputs.rehearse-failure` is always empty and the step never runs.
  it('is required: without the step there is nothing to rehearse', () => {
    assert.deepEqual(
      codesWith((_, jobs) => {
        jobs.static.steps = withoutScript(jobs.static, 'exit 1');
      }),
      ['REHEARSAL_MISSING'],
    );
  });

  const brokenInputs: [label: string, change: (workflow: Json) => void][] = [
    [
      'is missing',
      (workflow) => {
        Reflect.deleteProperty(workflow.on as Json, 'workflow_dispatch');
      },
    ],
    [
      'is renamed',
      (workflow) => {
        const dispatch = (workflow.on as Json).workflow_dispatch as Json;
        dispatch.inputs = { 'rehearse-fail': { type: 'boolean', default: false } };
      },
    ],
    [
      'is not a boolean',
      (workflow) => {
        const dispatch = (workflow.on as Json).workflow_dispatch as Json;
        dispatch.inputs = { 'rehearse-failure': { type: 'string' } };
      },
    ],
  ];
  for (const [label, change] of brokenInputs) {
    it(`needs its input: ${label}`, () => {
      assert.deepEqual(
        codesWith((workflow) => {
          change(workflow);
        }),
        ['REHEARSAL_MISSING'],
      );
    });
  }

  it('is not satisfied by a failing step that is not guarded by the input', () => {
    assert.deepEqual(
      codesWith((_, jobs) => {
        stepRunning(jobs.static, 'exit 1').if = "github.event_name == 'workflow_dispatch'";
      }).toSorted(),
      ['REHEARSAL_MISSING', 'REHEARSAL_UNGUARDED'],
    );
  });

  it('is found wherever a step exits non-zero, in any job', () => {
    assert.deepEqual(
      codesWith((_, jobs) => {
        stepsOf(jobs.unit).push({ name: 'Fail', run: 'echo bad\nexit 2' });
      }),
      ['REHEARSAL_UNGUARDED'],
    );
  });
});

describe('triggers and permissions', () => {
  // Break caught: CI that does not run for pull requests, or for the integration branch.
  it('requires pull requests', () => {
    assert.deepEqual(
      codesWith((workflow) => {
        Reflect.deleteProperty(workflow.on as Json, 'pull_request');
      }),
      ['TRIGGER_MISSING'],
    );
  });

  it('requires pushes to main', () => {
    assert.deepEqual(
      codesWith((workflow) => {
        (workflow.on as Json).push = { branches: ['develop'] };
      }),
      ['TRIGGER_MISSING'],
    );
    assert.deepEqual(
      codesWith((workflow) => {
        Reflect.deleteProperty(workflow.on as Json, 'push');
      }),
      ['TRIGGER_MISSING'],
    );
  });

  // Break caught: the nightly run taken out. A pull request does not run the Firefox and WebKit shards of the browser tests, so the
  // nightly run and the pushes to main are what run them; without a cron entry nothing runs at night.
  it('requires the nightly run, a schedule with a cron', () => {
    assert.deepEqual(
      codesWith((workflow) => {
        Reflect.deleteProperty(workflow.on as Json, 'schedule');
      }),
      ['TRIGGER_MISSING'],
    );
    for (const schedule of [[], [{}], [{ cron: '' }], [{ cron: 3 }], [null], '17 2 * * *', {}]) {
      assert.deepEqual(
        codesWith((workflow) => {
          (workflow.on as Json).schedule = schedule;
        }),
        ['TRIGGER_MISSING'],
        JSON.stringify(schedule),
      );
    }
  });

  it('accepts a schedule of several entries, so long as one is a cron', () => {
    assert.deepEqual(
      codesWith((workflow) => {
        (workflow.on as Json).schedule = [{ cron: '17 2 * * 1-5' }, { cron: '17 14 * * MON-FRI' }];
      }),
      [],
    );
  });

  // Break caught: a trigger that runs this workflow with more than a pull request's own rights, or for an event no change of the code
  // caused. pull_request_target and workflow_run run with the repository's secrets and a token that can write, on a side of the change
  // the author controls; the others make the verdict about something other than a commit that was pushed or proposed. (The schedule is
  // allowed since 7 November 2026: the nightly run tests the head of the default branch, a commit that was pushed, with a token that reads.)
  for (const trigger of [
    'pull_request_target',
    'workflow_run',
    'repository_dispatch',
    'issue_comment',
    'issues',
    'pull_request_review',
    'pull_request_review_comment',
    'release',
    'workflow_call',
    'check_run',
    'create',
    'fork',
    'watch',
  ]) {
    it(`rejects the trigger ${trigger}`, () => {
      assert.deepEqual(
        codesWith((workflow) => {
          (workflow.on as Json)[trigger] = {};
        }),
        ['TRIGGER_FORBIDDEN'],
      );
    });
  }

  it('accepts exactly push, pull_request, schedule and workflow_dispatch', () => {
    assert.deepEqual(
      codesWith((workflow) => {
        assert.deepEqual(Object.keys(workflow.on as Json).toSorted(), [
          'pull_request',
          'push',
          'schedule',
          'workflow_dispatch',
        ]);
      }),
      [],
    );
  });

  it('reads the trigger written as a name or a list of names', () => {
    for (const on of ['pull_request_target', ['push', 'pull_request_target', 'pull_request']]) {
      assert.ok(
        codesWith((workflow) => {
          workflow.on = on;
        }).includes('TRIGGER_FORBIDDEN'),
        JSON.stringify(on),
      );
    }
  });

  it('reports a forbidden trigger and a missing one together', () => {
    assert.deepEqual(
      codesWith((workflow) => {
        Reflect.deleteProperty(workflow.on as Json, 'pull_request');
        (workflow.on as Json).pull_request_target = {};
      }).toSorted(),
      ['TRIGGER_FORBIDDEN', 'TRIGGER_MISSING'],
    );
  });

  // Break caught: a token that can write to the repository in a workflow that runs pull-request code.
  for (const permissions of [
    undefined,
    { contents: 'write' },
    'write-all',
    { contents: 'read', packages: 'write' },
  ]) {
    it(`rejects workflow permissions ${JSON.stringify(permissions)}`, () => {
      assert.deepEqual(
        codesWith((workflow) => {
          if (permissions === undefined) Reflect.deleteProperty(workflow, 'permissions');
          else workflow.permissions = permissions;
        }),
        ['PERMISSIONS_BROAD'],
      );
    });
  }

  it('rejects a job that asks for more', () => {
    assert.deepEqual(
      codesWith((_, jobs) => {
        jobs.unit.permissions = { contents: 'write' };
      }),
      ['PERMISSIONS_BROAD'],
    );
  });

  it('accepts permissions that only read or are none', () => {
    assert.deepEqual(
      codesWith((workflow, jobs) => {
        workflow.permissions = { contents: 'read', actions: 'read' };
        jobs.unit.permissions = { contents: 'none' };
      }),
      [],
    );
  });
});

describe('unreadable workflows', () => {
  // Break caught: an emptied or broken file crashing the check, or passing.
  for (const text of ['', 'jobs: []', 'jobs: 3', 'just text', '[]']) {
    it(`reports ${JSON.stringify(text)} without throwing`, () => {
      assert.ok(codes(text).includes('AGGREGATE_MISSING'));
    });
  }
});

describe('the database image', () => {
  const compose = stringify({ services: { postgres: { image: 'postgres:18.6-bookworm' } } });
  const workflowWithImage = (image: string): string =>
    stringify({
      jobs: {
        database: { services: { postgres: { image } } },
        integrated: { services: { postgres: { image: 'postgres:18.6-bookworm' } } },
        unit: { steps: [] },
      },
    });

  it('accepts services that use the image of the local service', () => {
    assert.deepEqual(
      findPostgresImageProblems(workflowWithImage('postgres:18.6-bookworm'), compose),
      [],
    );
  });

  // Break caught: CI testing against another PostgreSQL than the one developers run.
  it('reports a job whose image differs, by job', () => {
    const problems = findPostgresImageProblems(workflowWithImage('postgres:17'), compose);
    assert.equal(problems.length, 1);
    assert.match(problems[0]?.message ?? '', /database/);
  });

  it('reports a workflow with no database service at all', () => {
    const none = stringify({ jobs: { unit: { steps: [] } } });
    assert.equal(findPostgresImageProblems(none, compose).length, 1);
  });

  it('reports a local service without an image', () => {
    const noImage = stringify({ services: { postgres: {} } });
    assert.equal(
      findPostgresImageProblems(workflowWithImage('postgres:18.6-bookworm'), noImage).length,
      1,
    );
  });
});

describe('this repository', () => {
  const root = resolve(import.meta.dirname, '..');
  const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');

  // Break caught: the CI workflow losing a check, a verdict or a guard in a real commit.
  it('keeps its CI workflow within the rules', () => {
    const workflow = read('.github/workflows/ci.yml');
    const localActions = readLocalActions(root, workflowSteps(workflow));
    assert.ok(Object.keys(localActions).length > 0, 'the workflow should use a local action');
    assert.deepEqual(findWorkflowProblems(workflow, localActions), []);
  });

  it('runs its database tests against the image of the local service', () => {
    assert.deepEqual(
      findPostgresImageProblems(
        read('.github/workflows/ci.yml'),
        read('infrastructure/postgres/compose.yaml'),
      ),
      [],
    );
  });

  // Break caught: a verdict that passes while one job of the real workflow did not succeed, the browser matrices included, or one that
  // lets a skip through where the workflow runs the job. A matrix is one job here: GitHub gives the verdict one result for all of its
  // jobs, `success` only when every one succeeded, and otherwise `failure`, `cancelled` or `skipped`. The verdict is judged here as the
  // workflow runs it: its real command line, for each event, each job and each result; a skip is accepted for the one job a pull request
  // does not run, on a pull request, and nowhere else.
  it('has a verdict that fails when any one of its jobs did not succeed, and allows only the skip a pull request makes', () => {
    const text = read('.github/workflows/ci.yml');
    const workflow: unknown = parse(text);
    const jobs = isRecord(workflow) && isRecord(workflow.jobs) ? workflow.jobs : {};
    const ids = Object.keys(jobs).filter((id) => id !== AGGREGATE_JOB);
    for (const id of ['https', 'integrated', 'browser-chromium', 'browser-firefox-webkit']) {
      assert.ok(ids.includes(id), id);
    }
    const jobRecord = (id: string): Json => {
      const record = jobs[id];
      assert.ok(isRecord(record), id);
      return record;
    };
    const judge = stepsOf(jobRecord(AGGREGATE_JOB)).find(
      (step) => typeof step.run === 'string' && step.run.includes('ci-aggregate.ts'),
    );
    assert.ok(judge !== undefined && typeof judge.run === 'string');
    const command = parseArguments(judge.run.trim().split(/\s+/).slice(2));
    assert.deepEqual(command.unreadable, []);
    assert.deepEqual(command.jobs.toSorted(), ids.toSorted());
    // The job a pull request does not run, by what the workflow says of it (its condition), and the allowance the command gives.
    const notOnPullRequest = ids.filter((id) => jobRecord(id).if === PULL_REQUEST_SKIP);
    assert.deepEqual(notOnPullRequest, ['browser-firefox-webkit']);
    assert.deepEqual(command.skippedOnPullRequest, notOnPullRequest);
    // The plan the verdict reads is the job that decides, and every job but the plan waits for it and has its condition.
    assert.equal(command.plan, PLAN_JOB);
    for (const id of ids.filter((name) => name !== PLAN_JOB && !UNPLANNED_JOBS.includes(name))) {
      assert.ok(
        [PLANNED_RUN, PULL_REQUEST_SKIP].includes(String(jobRecord(id).if)),
        `${id} has the plan's condition`,
      );
      assert.equal(jobRecord(id).needs, PLAN_JOB, id);
    }
    // The jobs the plan does not decide (the audit) have no condition and no need, and the verdict is told so.
    assert.deepEqual(command.runsAlways, [...UNPLANNED_JOBS]);
    for (const id of UNPLANNED_JOBS) {
      assert.ok(!('if' in jobRecord(id)) && !('needs' in jobRecord(id)), `${id} is not planned`);
    }

    for (const event of ['pull_request', 'push', 'schedule', 'workflow_dispatch']) {
      const judged = (result: (id: string) => string) =>
        aggregate(
          JSON.stringify(
            Object.fromEntries(
              ids.map((id) => [
                id,
                { result: result(id), outputs: id === command.plan ? { run: 'true' } : {} },
              ]),
            ),
          ),
          command.jobs,
          {
            event,
            skippedOnPullRequest: command.skippedOnPullRequest,
            runsAlways: command.runsAlways,
            plan: command.plan,
          },
        ).problems.map((problem) => `${problem.code} ${problem.job ?? ''}`);
      assert.deepEqual(
        judged(() => 'success'),
        [],
        event,
      );
      for (const id of ids) {
        for (const result of ['failure', 'cancelled', 'skipped']) {
          const accepted =
            event === 'pull_request' && result === 'skipped' && notOnPullRequest.includes(id);
          assert.deepEqual(
            judged((other) => (other === id ? result : 'success')),
            accepted ? [] : [`JOB_NOT_SUCCESSFUL ${id}`],
            `${event}: ${id} ${result}`,
          );
        }
      }
    }
  });

  // Break caught: a command the workflow requires being renamed in package.json, or vice versa.
  it('names only scripts that exist in the manifests', () => {
    const rootScripts = scriptsOf(read('package.json'));
    const apiScripts = scriptsOf(read('apps/api/package.json'));
    for (const command of REQUIRED_COMMANDS) {
      const filtered = /^pnpm --filter @melarc\/api run (\S+)$/.exec(command);
      const plain = /^pnpm run (\S+)$/.exec(command);
      const script = /^node (scripts\/\S+\.ts)$/.exec(command);
      if (filtered?.[1] !== undefined) {
        assert.ok(apiScripts.includes(filtered[1]), `${command}: no such script in apps/api`);
      } else if (plain?.[1] !== undefined) {
        assert.ok(
          rootScripts.includes(plain[1]),
          `${command}: no such script in the root package.json`,
        );
      } else if (script?.[1] !== undefined) {
        assert.ok(existsSync(resolve(root, script[1])), `${command}: no such file in scripts/`);
      } else {
        assert.match(command, /^pnpm audit /);
      }
    }
  });
});

function scriptsOf(packageJson: string): string[] {
  const parsed: unknown = JSON.parse(packageJson);
  const scripts = isRecord(parsed) ? parsed.scripts : undefined;
  return isRecord(scripts) ? Object.keys(scripts) : [];
}

// Task CI.2 (the Product Owner's decisions of 7 November 2026): the plan of the run, a timeout on every test step, the diagnostics kept on a
// cancellation, the browsers cached, the timing tests left out of a pull request, the database tests in shards, and a weekday nightly run.
describe('the plan of the run', () => {
  const OTHERS = JOB_IDS.filter((id) => id !== PLAN_JOB && !UNPLANNED_JOBS.includes(id));
  const PLANNED_ONLY = OTHERS.filter((id) => id !== OTHER_ENGINES);
  const planStep = (jobs: Jobs): Json => stepRunning(jobs.plan, PLAN_COMMAND);

  it('is a mandatory command of the workflow', () => {
    assert.ok(REQUIRED_COMMANDS.includes(PLAN_COMMAND));
  });

  // Break caught: the plan taken out, leaving the verdict with a job that does not exist, and every other job with an answer nobody gives.
  it('requires the plan job', () => {
    const found = codesWith((_, jobs) => {
      Reflect.deleteProperty(jobs, 'plan');
    });
    assert.ok(found.includes('PLAN_MISSING'), found.join(', '));
  });

  // Break caught: the plan changed so that it cannot ask GitHub (no `actions: read`: the question is refused, every night runs, and nothing
  // says so), or that its answer is not the job's output, or that it holds more than it needs.
  for (const [label, change] of [
    ['a need of its own', (jobs: Jobs) => void (jobs.plan.needs = 'static')],
    ['no output', (jobs: Jobs) => void Reflect.deleteProperty(jobs.plan, 'outputs')],
    [
      'an output that is another expression',
      (jobs: Jobs) => void (jobs.plan.outputs = { run: 'true' }),
    ],
    [
      'an output of another step',
      (jobs: Jobs) => void (jobs.plan.outputs = { run: '${{ steps.other.outputs.run }}' }),
    ],
    [
      'no permission of its own',
      (jobs: Jobs) => void Reflect.deleteProperty(jobs.plan, 'permissions'),
    ],
    ['no actions: read', (jobs: Jobs) => void (jobs.plan.permissions = { contents: 'read' })],
    [
      'a permission beyond the two',
      (jobs: Jobs) =>
        void (jobs.plan.permissions = { contents: 'read', actions: 'read', checks: 'read' }),
    ],
    ['a step that is not id: plan', (jobs: Jobs) => void (planStep(jobs).id = 'decide')],
    ['no token', (jobs: Jobs) => void Reflect.deleteProperty(planStep(jobs), 'env')],
    [
      'another token',
      (jobs: Jobs) => void (planStep(jobs).env = { GH_TOKEN: '${{ secrets.TOKEN }}' }),
    ],
  ] as const) {
    it(`rejects a plan with ${label}`, () => {
      assert.deepEqual(
        codesWith((_, jobs) => {
          change(jobs);
        }),
        ['PLAN_DRIFT'],
      );
    });
  }

  // Break caught: the plan that can be skipped (it would skip the answer too: every job would be skipped for nothing).
  it('does not allow a condition on the plan', () => {
    for (const condition of [PLANNED_RUN, "github.event_name == 'schedule'", 'always()']) {
      assert.deepEqual(
        codesWith((_, jobs) => {
          jobs.plan.if = condition;
        }),
        ['JOB_CONDITIONAL'],
        condition,
      );
    }
  });

  for (const id of OTHERS) {
    // Break caught: a job that does not wait for the plan (it starts at once and never reads the answer, so a night that stands down still runs
    // it), or one that waits for others besides (it is delayed by them for nothing).
    it(`requires ${id} to wait for the plan alone`, () => {
      for (const needs of [undefined, 'static', ['plan', 'static'], [], ['static']]) {
        assert.deepEqual(
          codesWith((_, jobs) => {
            const target = (jobs as unknown as Record<string, Json>)[id];
            assert.ok(target !== undefined);
            if (needs === undefined) Reflect.deleteProperty(target, 'needs');
            else target.needs = needs;
          }),
          ['JOB_NOT_PLANNED'],
          JSON.stringify(needs),
        );
      }
    });
  }

  for (const id of PLANNED_ONLY) {
    // Break caught: a job that ignores the plan's answer, or reads it wrongly (`!= 'false'` is true when the answer is missing).
    it(`requires exactly the plan's condition on ${id}`, () => {
      // A condition that is not the plan's leaves the job's engines run by no kind of run, which the browser rules report too: that is not what
      // this proves, so those reports are set aside for the Chromium job.
      for (const condition of [
        undefined,
        "needs.plan.outputs.run != 'false'",
        'needs.plan.outputs.run',
        "needs.plan.outputs.run == 'true' || always()",
        'always()',
        "needs.plan.outputs.run == 'true' && github.event_name != 'pull_request'",
        "github.event_name != 'pull_request'",
      ]) {
        const found = codesWith((_, jobs) => {
          const target = (jobs as unknown as Record<string, Json>)[id];
          assert.ok(target !== undefined);
          if (condition === undefined) Reflect.deleteProperty(target, 'if');
          else target.if = condition;
        });
        assert.deepEqual(
          found.filter((code) => id !== 'browser-chromium' || code !== 'BROWSER_ENGINES_DRIFT'),
          ['JOB_CONDITIONAL'],
          String(condition),
        );
      }
    });
  }

  // Break caught (run 4, Stage 1, item 4): the audit skipped with the rest on a night that stands down. It is the one job the plan does not decide: an
  // advisory is published with no commit, so a night that audited only when the code had changed would never see one. It has no condition and waits for nothing.
  for (const id of UNPLANNED_JOBS) {
    it(`requires ${id} to have no condition: the plan does not decide it`, () => {
      for (const condition of [PLANNED_RUN, 'always()', "github.event_name != 'pull_request'"]) {
        assert.deepEqual(
          codesWith((_, jobs) => {
            const target = (jobs as unknown as Record<string, Json>)[id];
            assert.ok(target !== undefined);
            target.if = condition;
          }),
          ['JOB_CONDITIONAL'],
          condition,
        );
      }
    });

    it(`requires ${id} to wait for nothing: a plan that failed does not take it down with it`, () => {
      for (const needs of ['plan', ['plan'], ['static'], []]) {
        assert.deepEqual(
          codesWith((_, jobs) => {
            const target = (jobs as unknown as Record<string, Json>)[id];
            assert.ok(target !== undefined);
            target.needs = needs;
          }),
          ['UNPLANNED_JOB_DRIFT'],
          JSON.stringify(needs),
        );
      }
    });
  }

  // Break caught: the verdict not told that the audit runs on every run, so that a skip of it on a night that stands down is accepted as the plan's.
  for (const [label, command] of [
    [
      'no option',
      `node scripts/ci-aggregate.ts --plan=plan --skipped-on-pull-request=${OTHER_ENGINES} ${JOB_IDS.join(' ')}`,
    ],
    [
      'another job',
      `node scripts/ci-aggregate.ts --plan=plan --runs-always=unit --skipped-on-pull-request=${OTHER_ENGINES} ${JOB_IDS.join(' ')}`,
    ],
    [
      'the audit and another',
      `node scripts/ci-aggregate.ts --plan=plan --runs-always=audit,unit --skipped-on-pull-request=${OTHER_ENGINES} ${JOB_IDS.join(' ')}`,
    ],
    [
      'the option twice',
      `node scripts/ci-aggregate.ts --plan=plan --runs-always=audit --runs-always=audit --skipped-on-pull-request=${OTHER_ENGINES} ${JOB_IDS.join(' ')}`,
    ],
  ] as const) {
    it(`requires the verdict to name the jobs the plan does not decide, once: not ${label}`, () => {
      assert.deepEqual(
        codesWith((_, jobs) => {
          stepAt(jobs.ci, 1).run = command;
        }),
        ['AGGREGATE_ALWAYS_DRIFT'],
      );
    });
  }

  // Break caught: the verdict not told which job is the plan, so that a night that stands down is red; or told another job, whose output
  // would then decide whether the skips are allowed.
  for (const [label, command] of [
    [
      'no plan',
      `node scripts/ci-aggregate.ts --runs-always=audit --skipped-on-pull-request=${OTHER_ENGINES} ${JOB_IDS.join(' ')}`,
    ],
    [
      'another job as the plan',
      `node scripts/ci-aggregate.ts --plan=static --runs-always=audit --skipped-on-pull-request=${OTHER_ENGINES} ${JOB_IDS.join(' ')}`,
    ],
    [
      'an empty plan',
      `node scripts/ci-aggregate.ts --plan= --runs-always=audit --skipped-on-pull-request=${OTHER_ENGINES} ${JOB_IDS.join(' ')}`,
    ],
    [
      'the plan twice',
      `node scripts/ci-aggregate.ts --plan=plan --runs-always=audit --plan=plan --skipped-on-pull-request=${OTHER_ENGINES} ${JOB_IDS.join(' ')}`,
    ],
  ] as const) {
    it(`requires the verdict to name the plan once, as --plan=plan: not ${label}`, () => {
      assert.deepEqual(
        codesWith((_, jobs) => {
          stepAt(jobs.ci, 1).run = command;
        }),
        ['AGGREGATE_PLAN_DRIFT'],
      );
    });
  }

  it('accepts the verdict with the options in the other order', () => {
    assert.deepEqual(
      codesWith((_, jobs) => {
        stepAt(jobs.ci, 1).run =
          `node scripts/ci-aggregate.ts --skipped-on-pull-request=${OTHER_ENGINES} --runs-always=audit --plan=plan ${JOB_IDS.join(' ')}`;
      }),
      [],
    );
  });
});

describe('the weekday nightly run', () => {
  // Break caught: the nightly run on every day, or on days another than Monday to Friday (the Product Owner's decision of 7 November 2026).
  for (const cron of [
    '17 2 * * *',
    '17 2 * * 0-6',
    '17 2 * * 1,2,3,4,5',
    '17 2 * * 6',
    '17 2 * * 1-6',
    '17 2 * *',
  ]) {
    it(`rejects the cron ${JSON.stringify(cron)}`, () => {
      assert.deepEqual(
        codesWith((workflow) => {
          (workflow.on as Json).schedule = [{ cron }];
        }),
        ['NIGHTLY_WEEKDAYS'],
      );
    });
  }

  it('rejects a second cron that runs on other days, beside the right one', () => {
    assert.deepEqual(
      codesWith((workflow) => {
        (workflow.on as Json).schedule = [{ cron: '17 2 * * 1-5' }, { cron: '17 3 * * *' }];
      }),
      ['NIGHTLY_WEEKDAYS'],
    );
  });

  for (const cron of ['17 2 * * 1-5', '0 0 * * mon-fri', '5 4 * 1-6 MON-FRI']) {
    it(`accepts the cron ${JSON.stringify(cron)}`, () => {
      assert.deepEqual(
        codesWith((workflow) => {
          (workflow.on as Json).schedule = [{ cron }];
        }),
        [],
      );
    });
  }

  it('keeps the manual trigger: a run by hand is there for the other days', () => {
    assert.deepEqual(
      codesWith((workflow) => {
        Reflect.deleteProperty(workflow.on as Json, 'workflow_dispatch');
      }).toSorted(),
      ['REHEARSAL_MISSING'],
    );
  });
});

describe('the timeout of a test step', () => {
  /** The jobs that have a step running tests, with the step and the limit of the job. */
  const timed = (jobs: Jobs): { id: string; step: Json; limit: number }[] =>
    Object.entries(jobs as unknown as Record<string, Json>).flatMap(([id, target]) =>
      stepsOf(target)
        .filter((step) => {
          const command = commandOf(step);
          return typeof command === 'string' && TIMED_COMMANDS.includes(command);
        })
        .map((step) => ({ id, step, limit: Number(target['timeout-minutes']) })),
    );

  it('is held by every command that runs tests, and by the ones the fixture has', () => {
    const jobs = good().jobs as Jobs;
    const commands = new Set(timed(jobs).map(({ step }) => commandOf(step)));
    assert.deepEqual([...commands].toSorted(), [...TIMED_COMMANDS].toSorted());
    assert.ok(
      timed(jobs).every(({ step, limit }) => step['timeout-minutes'] === stepLimitFor(limit)),
      'every step is given the limit of its job less the measured set-up and the margin',
    );
  });

  // Break caught: a step with no limit of its own, so that a hung suite is cut by the job's limit, which cancels the job and the steps that
  // would keep the evidence with it; or a limit that is not below the job's by the margin.
  for (const command of TIMED_COMMANDS) {
    for (const [label, value] of [
      ['no timeout', undefined],
      ['0', 0],
      ['a negative one', -1],
      ['text', '8'],
      ['true', true],
      ['the job limit less one', 9],
      ['the job limit less three, which the set-up leaves no room for', 7],
      ['the job limit', 10],
      ['more than the job limit', 30],
    ] as const) {
      it(`rejects ${label} on the step that runs ${command}`, () => {
        const found = codesWith((_, jobs) => {
          const holders = timed(jobs).filter(({ step }) => commandOf(step) === command);
          assert.ok(holders.length > 0, command);
          for (const { step } of holders) {
            if (value === undefined) Reflect.deleteProperty(step, 'timeout-minutes');
            else step['timeout-minutes'] = value;
          }
        });
        assert.ok(
          found.length > 0 && found.every((code) => code === 'STEP_TIMEOUT'),
          found.join(', '),
        );
      });
    }

    it(`accepts the edges, 1 and the job limit less four, on the step that runs ${command}`, () => {
      for (const value of [1, stepLimitFor(10)]) {
        assert.deepEqual(
          codesWith((_, jobs) => {
            for (const { step } of timed(jobs).filter(
              (holder) => commandOf(holder.step) === command,
            )) {
              step['timeout-minutes'] = value;
            }
          }),
          [],
          String(value),
        );
      }
    });
  }

  it('is measured against the limit of its own job', () => {
    assert.deepEqual(
      codesWith((_, jobs) => {
        for (const { step } of timed(jobs).filter(
          (holder) => commandOf(holder.step) === 'pnpm run test',
        )) {
          step['timeout-minutes'] = stepLimitFor(20);
        }
        jobs.unit['timeout-minutes'] = 20;
      }),
      [],
    );
  });
});

describe('the diagnostics a failed or cancelled job keeps', () => {
  // Break caught: the upload that waits for `failure()` alone, which a job that is cancelled (its limit reached, a run cancelled by a newer
  // push) never reaches: the diagnostics of exactly the run that hung are lost.
  for (const condition of [
    'failure()',
    'cancelled()',
    'always()',
    'success()',
    'cancelled() || failure()',
    'failure() || cancelled() ',
  ]) {
    it(`rejects the upload condition ${JSON.stringify(condition)}`, () => {
      assert.deepEqual(
        codesWith((_, jobs) => {
          stepNamed(jobs.integrated, 'Keep diagnostics').if = condition;
        }),
        ['STEP_CONDITIONAL'],
      );
    });
  }

  it('is as the workflow states it', () => {
    assert.equal(FAILURE_UPLOAD_CONDITION, 'failure() || cancelled()');
  });
});

describe('the cache of the browsers', () => {
  const CACHED = [
    ['integrated', 'chromium'],
    ['https', MATRIX_BROWSERS],
    ['browser-chromium', MATRIX_ENGINE],
    [OTHER_ENGINES, MATRIX_ENGINE],
  ] as const;
  const cacheStep = (jobs: Jobs, id: string): Json =>
    stepNamed((jobs as unknown as Record<string, Json>)[id] ?? {}, 'Cache the browsers');
  const withOf = (step: Json): Json => step.with as Json;

  for (const [id, browsers] of CACHED) {
    // Break caught: the cache taken out (every run downloads the browsers again), made after the install (it restores what was just
    // downloaded), or put on another path (it keeps nothing the install uses).
    it(`requires the cache before the install in ${id}`, () => {
      assert.deepEqual(
        codesWith((_, jobs) => {
          const target = (jobs as unknown as Record<string, Json>)[id];
          assert.ok(target !== undefined);
          target.steps = stepsOf(target).filter((step) => step.name !== 'Cache the browsers');
        }),
        ['BROWSER_CACHE'],
      );
      assert.deepEqual(
        codesWith((_, jobs) => {
          const target = (jobs as unknown as Record<string, Json>)[id];
          assert.ok(target !== undefined);
          const steps = stepsOf(target);
          const [cache] = steps.splice(
            steps.findIndex((step) => step.name === 'Cache the browsers'),
            1,
          );
          assert.ok(cache !== undefined);
          steps.push(cache);
        }),
        ['BROWSER_CACHE'],
      );
      assert.deepEqual(
        codesWith((_, jobs) => {
          withOf(cacheStep(jobs, id)).path = '~/.cache/other';
        }),
        ['BROWSER_CACHE'],
      );
    });

    // Break caught: a key that does not say what the cache holds: no system (a cache of one runner image restored on another), no lockfile
    // (a new Playwright version restores the old browsers for good), or not the browsers (two engines under one key: the second finds a
    // cache without its browser, and saves nothing).
    for (const part of ['${{ runner.os }}', "hashFiles('pnpm-lock.yaml')", browsers]) {
      it(`requires ${part} in the key of the cache of ${id}`, () => {
        assert.deepEqual(
          codesWith((_, jobs) => {
            const cache = withOf(cacheStep(jobs, id));
            cache.key = String(cache.key).replace(part, 'x');
          }),
          ['BROWSER_CACHE'],
        );
      });
    }

    it(`accepts a restore key beside the key in ${id}`, () => {
      assert.deepEqual(
        codesWith((_, jobs) => {
          withOf(cacheStep(jobs, id))['restore-keys'] = 'playwright-';
        }),
        [],
      );
    });
  }
});

describe('the timing tests a pull request leaves out', () => {
  const databaseStep = (jobs: Jobs): Json => stepRunning(jobs.database, 'pnpm run test:db');

  it('is as the fixture has it, and its variable is the one the API reads', () => {
    assert.equal(TIMING_SKIP_VARIABLE, 'MELARC_SKIP_TIMING_TESTS');
    assert.equal(
      (databaseStep(good().jobs as Jobs).env as Json)[TIMING_SKIP_VARIABLE],
      TIMING_SKIP_VALUE,
    );
  });

  // Break caught: the switch not set (a pull request runs the tests that a loaded runner fails for a reason that is not the code's), set to
  // something else (always on, or only on one event), or set for the pull request by the wrong test.
  for (const value of [
    undefined,
    '',
    '1',
    "${{ github.event_name == 'push' && '1' || '' }}",
    "${{ github.event_name != 'pull_request' && '1' || '' }}",
    "${{ github.event_name == 'pull_request' && 'true' || '' }}",
  ]) {
    it(`requires the switch to be ${TIMING_SKIP_VALUE}, not ${JSON.stringify(value)}`, () => {
      assert.deepEqual(
        codesWith((_, jobs) => {
          const env = databaseStep(jobs).env as Json;
          if (value === undefined) Reflect.deleteProperty(env, TIMING_SKIP_VARIABLE);
          else env[TIMING_SKIP_VARIABLE] = value;
        }),
        ['TIMING_SKIP_DRIFT'],
      );
    });
  }

  // Break caught: the switch set where it holds for more than the database tests, or for every run, so that a push to main and the nightly
  // run leave the timing tests out too and nothing ever runs them.
  it('is set by that step alone: not by the workflow, a job or another step', () => {
    for (const change of [
      (workflow: Json) => void (workflow.env = { [TIMING_SKIP_VARIABLE]: '1' }),
      (_: Json, jobs: Jobs) => void (jobs.database.env = { [TIMING_SKIP_VARIABLE]: '1' }),
      (_: Json, jobs: Jobs) => void (jobs.unit.env = { [TIMING_SKIP_VARIABLE]: '1' }),
      (_: Json, jobs: Jobs) => void (stepAt(jobs.unit, 2).env = { [TIMING_SKIP_VARIABLE]: '1' }),
    ]) {
      const found = codesWith((workflow, jobs) => {
        change(workflow, jobs);
      });
      assert.deepEqual(found, ['TIMING_SKIP_DRIFT']);
    }
  });
});

describe('the CI variable and the revision the migrations are held to (run 5, Stage 1.4)', () => {
  /** Puts `holder.env.CI = value` at one of the three places an `env` can be: the workflow, a job, a step. */
  const placed: [string, (value: unknown) => (workflow: Json, jobs: Jobs) => void][] = [
    ['the workflow', (value) => (workflow) => void (workflow.env = { CI: value })],
    ['a job', (value) => (_, jobs) => void (jobs.unit.env = { CI: value })],
    ['a step', (value) => (_, jobs) => void (stepAt(jobs.unit, 2).env = { CI: value })],
  ];

  // Break caught: a step that sets CI to something else than true (`false`, a blank, an expression that can come out as either), so that the scripts that read CI to tell a
  // developer's shell from CI (the migration guard once did) treat a CI run as a developer's. Only the string `true`, or the YAML true that GitHub turns into it, is CI.
  for (const [where, set] of placed) {
    for (const value of [
      'false',
      false,
      '',
      0,
      null,
      'TRUE',
      '1',
      "${{ github.event_name == 'push' }}",
    ]) {
      it(`refuses CI set to ${JSON.stringify(value)} by ${where}`, () => {
        assert.deepEqual(codesWith(set(value)), ['CI_NOT_TRUE']);
      });
    }
    for (const value of ['true', true]) {
      it(`accepts CI set to ${JSON.stringify(value)} by ${where}`, () => {
        assert.deepEqual(codesWith(set(value)), []);
      });
    }
  }

  // Break caught: the same thing done in a script, which the `env` check does not see: an assignment before a command, an export, a line written to the file that sets
  // the environment of the steps after it. Another variable that ends in CI is not this one.
  for (const [script, refused] of [
    ['CI=false pnpm run lint', true],
    ['export CI=0', true],
    ['CI= node scripts/x.ts', true],
    ['echo "CI=false" >> "$GITHUB_ENV"', true],
    ["env CI='no' node scripts/x.ts", true],
    ['CI=true pnpm run lint', false],
    ['echo "CI=true" >> "$GITHUB_ENV"', false],
    ['MELARC_CI=false node scripts/x.ts', false],
    ['echo "the CI result" # CI is a word here', false],
  ] as const) {
    it(`${refused ? 'refuses' : 'accepts'} a script that says ${JSON.stringify(script)}`, () => {
      const found = codesWith((_, jobs) => {
        stepsOf(jobs.unit).push({ name: 'Anything else', run: script });
      });
      assert.deepEqual(found, refused ? ['CI_NOT_TRUE'] : []);
    });
  }

  // Break caught: the base of the migration guard named by an `env` expression that comes out empty on a pull request (the guard refuses an empty base, so every pull request
  // would fail), or by a workflow-wide value that holds one revision for every run. A push names it by writing it to the environment of the steps after it, in a step that
  // knows the event.
  for (const [where, set] of [
    ['the workflow', (workflow: Json) => void (workflow.env = { MELARC_MIGRATION_BASE: '' })],
    [
      'a job',
      (_: Json, jobs: Jobs) =>
        void (jobs.static.env = { MELARC_MIGRATION_BASE: "${{ github.event.before || '' }}" }),
    ],
    [
      'a step',
      (_: Json, jobs: Jobs) =>
        void (stepAt(jobs.static, 2).env = { MELARC_MIGRATION_BASE: '${{ github.event.before }}' }),
    ],
  ] as const) {
    it(`refuses MELARC_MIGRATION_BASE in the env of ${where}`, () => {
      assert.deepEqual(codesWith(set), ['MIGRATION_BASE_ENV']);
    });
  }

  it('accepts the base written to the environment by a script', () => {
    assert.deepEqual(
      codesWith((_, jobs) => {
        stepsOf(jobs.static).push({
          name: 'Name the base',
          run: 'echo "MELARC_MIGRATION_BASE=$BEFORE" >> "$GITHUB_ENV"',
        });
      }),
      [],
    );
  });

  // Break caught (run 6, Stage 1.3): `CI` taken away by a script (`unset CI`, `env -u CI`), which the `env` check and the assignments do not see: the step then runs as a developer's
  // shell would, though GitHub sets CI to `true`. The names are read whole, and an argument never reads across a separator.
  for (const [script, refused] of [
    ['unset CI', true],
    ['unset -v CI', true],
    ['unset FOO CI', true],
    ['env -u CI node scripts/x.ts', true],
    ['env -uCI node scripts/x.ts', true],
    ['env --unset=CI node scripts/x.ts', true],
    ['env --unset CI node scripts/x.ts', true],
    ['env FOO=1 -u CI node scripts/x.ts', true],
    ['echo ok && unset CI', true],
    ['(unset CI; node scripts/x.ts)', true],
    ['if true; then\n  unset CI\nfi', true],
    // Run 7, Stage 3.6: the forms that took CI away and were not read: a quoted name, `export -n`, `declare +x` and the whole environment emptied with `env -i`.
    ['unset "CI"', true],
    ["unset 'CI'", true],
    ['unset -v "CI"', true],
    ['unset FOO "CI"', true],
    ['env -u "CI" node scripts/x.ts', true],
    ["env -u 'CI' node scripts/x.ts", true],
    ['env --unset="CI" node scripts/x.ts', true],
    ['export -n CI', true],
    ['export -n FOO CI', true],
    ['export -n "CI"', true],
    ['export -fn CI', true],
    ['declare +x CI', true],
    ['declare -g +x CI', true],
    ['typeset +x CI', true],
    ['env -i node scripts/x.ts', true],
    ['env -i PATH=/usr/bin node scripts/x.ts', true],
    ['env --ignore-environment node scripts/x.ts', true],
    ['env FOO=1 -i node scripts/x.ts', true],
    ['echo ok && env -i bash -c "node scripts/x.ts"', true],
    ['unset CIRCLE', false],
    ['unset MELARC_CI', false],
    ['unset "CIRCLE"', false],
    ['unset FOO; echo CI', false],
    ['env -u CIRCLE node scripts/x.ts', false],
    ['env -u MELARC_CI node scripts/x.ts', false],
    ['env -u "MELARC_CI" node scripts/x.ts', false],
    ['env FOO=1 node scripts/x.ts', false],
    ['unset DEBUG', false],
    ['export CI', false],
    ['export -n FOO', false],
    ['export FOO=1 && echo CI', false],
    ['declare -x CI', false],
    ['declare +x FOO', false],
    ['env -C scripts node x.ts', false],
  ] as const) {
    it(`${refused ? 'refuses' : 'accepts'} a script that says ${JSON.stringify(script)}`, () => {
      const found = codesWith((_, jobs) => {
        stepsOf(jobs.unit).push({ name: 'Anything else', run: script });
      });
      assert.deepEqual(found, refused ? ['CI_NOT_TRUE'] : []);
    });
  }
});

describe('the step that names the revision a push is held to (run 6, Stage 1.3)', () => {
  const problemsWith = (change: (workflow: Json, jobs: Jobs) => void) =>
    findWorkflowProblems(workflowWith(change));
  const baseStepOf = (jobs: Jobs): Json => stepRunning(jobs.static, MIGRATION_BASE_COMMAND);
  const withoutBaseStep = (jobs: Jobs): Json[] =>
    stepsOf(jobs.static).filter((step) => step.run !== MIGRATION_BASE_COMMAND);
  const indexOfRunning = (jobs: Jobs, script: string): number =>
    stepsOf(jobs.static).findIndex((step) => step.run === script);

  it('is in the workflow of the fixture: the step before the guard, handed the event', () => {
    const jobs = good().jobs as Jobs;

    assert.ok(
      indexOfRunning(jobs, MIGRATION_BASE_COMMAND) < indexOfRunning(jobs, MIGRATION_GUARD_COMMAND),
    );
    assert.deepEqual(baseStepOf(jobs).env, { ...MIGRATION_BASE_STEP_ENV });
    assert.deepEqual(
      codesWith(() => undefined),
      [],
    );
  });

  // Break caught: the step deleted. A push to main is then held to nothing: the guard compares the revision with itself and passes whatever the push changed.
  it('refuses a workflow with no step that names the base, and says what then happens', () => {
    const found = problemsWith((_, jobs) => {
      jobs.static.steps = withoutBaseStep(jobs);
    });

    assert.deepEqual(
      found.map((problem) => problem.code),
      ['MIGRATION_BASE_STEP'],
    );
    assert.match(found[0]?.message ?? '', /no step runs "node scripts\/ci-migration-base\.ts"/);
    assert.match(found[0]?.message ?? '', /compare the revision with itself/);
  });

  // Break caught: the step moved after the guard, where it names a base that nothing reads.
  it('refuses the step after the guard, and says it is too late', () => {
    const found = problemsWith((_, jobs) => {
      const step = baseStepOf(jobs);
      jobs.static.steps = withoutBaseStep(jobs);
      const guardAt = indexOfRunning(jobs, MIGRATION_GUARD_COMMAND);
      stepsOf(jobs.static).splice(guardAt + 1, 0, step);
    });

    assert.deepEqual(
      found.map((problem) => problem.code),
      ['MIGRATION_BASE_STEP'],
    );
    assert.match(found[0]?.message ?? '', /after "node scripts\/migration-immutability\.ts"/);
  });

  // Break caught: the step in another job, which the guard's job does not share an environment with.
  it('refuses the step in another job than the guard’s', () => {
    assert.deepEqual(
      codesWith((_, jobs) => {
        const step = baseStepOf(jobs);
        jobs.static.steps = withoutBaseStep(jobs);
        stepsOf(jobs.unit).push(step);
      }),
      ['MIGRATION_BASE_STEP'],
    );
  });

  // Break caught: a copy after the guard standing in for the step that was removed from before it.
  it('does not take a copy after the guard for the step before it', () => {
    assert.deepEqual(
      codesWith((_, jobs) => {
        const step = baseStepOf(jobs);
        jobs.static.steps = withoutBaseStep(jobs);
        stepsOf(jobs.static).push({ ...step });
      }),
      ['MIGRATION_BASE_STEP'],
    );
  });

  it('accepts a copy after the guard beside the step before it', () => {
    assert.deepEqual(
      codesWith((_, jobs) => {
        stepsOf(jobs.static).push({ ...baseStepOf(jobs) });
      }),
      [],
    );
  });

  // Break caught (run 7, Stage 3.6): the step run from another folder or in another shell. The workflow check held that for the required commands and not for this step, so
  // `working-directory` could make `node scripts/ci-migration-base.ts` another file, or a `shell` make it another command, and no base would be named.
  for (const key of ['shell', 'working-directory']) {
    it(`refuses the step with a ${key} of its own`, () => {
      const found = problemsWith((_, jobs) => {
        baseStepOf(jobs)[key] = key === 'shell' ? 'bash {0}' : 'apps/api';
      });

      assert.deepEqual(
        found.map((problem) => problem.code),
        ['MIGRATION_BASE_STEP'],
      );
      assert.match(found[0]?.message ?? '', new RegExp(`sets ${key}`));
    });
  }

  // Break caught: a step between the one that names the base and the guard that writes MELARC_MIGRATION_BASE (or the file that sets the environment) again: the later write wins, and the
  // guard is held to whatever it says.
  for (const script of [
    'echo "MELARC_MIGRATION_BASE=$GITHUB_SHA" >> "$GITHUB_ENV"',
    'export MELARC_MIGRATION_BASE=HEAD',
    'echo "$NAME=$VALUE" >> "$GITHUB_ENV"',
    'echo "MELARC_MIGRATION_BASE=" >> $GITHUB_ENV',
  ]) {
    it(`refuses a step between the base step and the guard that says ${JSON.stringify(script)}`, () => {
      const found = problemsWith((_, jobs) => {
        const guardAt = indexOfRunning(jobs, MIGRATION_GUARD_COMMAND);
        stepsOf(jobs.static).splice(guardAt, 0, { name: 'Name the base again', run: script });
      });

      assert.deepEqual(
        found.map((problem) => problem.code),
        ['MIGRATION_BASE_STEP'],
      );
      assert.match(found[0]?.message ?? '', /between/);
    });
  }

  it('accepts a step between the base step and the guard that writes neither', () => {
    assert.deepEqual(
      codesWith((_, jobs) => {
        const guardAt = indexOfRunning(jobs, MIGRATION_GUARD_COMMAND);
        stepsOf(jobs.static).splice(guardAt, 0, { name: 'Say something', run: 'echo hello' });
      }),
      [],
    );
  });

  // Break caught: the step handed no event, no previous revision or no word on a force push, or handed another expression: it then names no base, or the wrong one.
  for (const name of Object.keys(MIGRATION_BASE_STEP_ENV)) {
    it(`requires ${name} to be handed to it, exactly`, () => {
      for (const change of [
        (env: Json) => void Reflect.deleteProperty(env, name),
        (env: Json) => void (env[name] = ''),
        (env: Json) => void (env[name] = 'true'),
        (env: Json) => void (env[name] = '${{ github.sha }}'),
      ]) {
        assert.deepEqual(
          codesWith((_, jobs) => {
            change(baseStepOf(jobs).env as Json);
          }),
          ['MIGRATION_BASE_STEP'],
        );
      }
    });
  }

  // Break caught: the step changed so that it is no longer the whole of its script, or its failure is absorbed: it may then not name a base and still pass.
  it('refuses the step run behind another command, or with its failure absorbed', () => {
    for (const script of [
      `${MIGRATION_BASE_COMMAND} || true`,
      `echo naming; ${MIGRATION_BASE_COMMAND}`,
      `${MIGRATION_BASE_COMMAND} --dry-run`,
    ]) {
      const found = codesWith((_, jobs) => {
        baseStepOf(jobs).run = script;
      });
      assert.ok(found.includes('MIGRATION_BASE_STEP'), `${script}: ${found.join(', ')}`);
    }
  });
});

describe('the database tests, in shards', () => {
  const databaseStep = (jobs: Jobs): Json => stepRunning(jobs.database, 'pnpm run test:db');
  const strategyOf = (jobs: Jobs): Json => jobs.database.strategy as Json;
  const matrixOf = (jobs: Jobs): Json => strategyOf(jobs).matrix as Json;
  const entriesOf = (jobs: Jobs): Json[] => matrixOf(jobs).include as Json[];
  const faultsAfter = (change: (jobs: Jobs) => void): string[] => {
    const jobs = good().jobs as Jobs;
    change(jobs);
    return databaseMatrix(jobs.database).faults;
  };

  it('is accepted as the fixture has it: three shards, each once', () => {
    const matrix = databaseMatrix((good().jobs as Jobs).database);
    assert.deepEqual(matrix.faults, []);
    assert.deepEqual(matrix.shards, [
      { shard: 1, shards: 3 },
      { shard: 2, shards: 3 },
      { shard: 3, shards: 3 },
    ]);
  });

  // Break caught: the shard not handed to the tests, or handed wrongly: every job runs every database test (about 45 minutes, far beyond the
  // job's limit), or the same part of them.
  for (const value of [
    undefined,
    '',
    '1/3',
    '${{ matrix.shard }}',
    '${{ matrix.shards }}/${{ matrix.shard }}',
    '${{ vars.SHARD }}',
  ]) {
    it(`requires ${DATABASE_SHARD_VARIABLE} to be ${MATRIX_SHARD}, not ${JSON.stringify(value)}`, () => {
      assert.deepEqual(
        codesWith((_, jobs) => {
          const env = databaseStep(jobs).env as Json;
          if (value === undefined) Reflect.deleteProperty(env, DATABASE_SHARD_VARIABLE);
          else env[DATABASE_SHARD_VARIABLE] = value;
        }),
        ['DATABASE_SHARD_ENV'],
      );
    });
  }

  // Break caught: the variable set where another command reads it: the unit job would run a part of its tests and be green.
  it('is set by the database step alone', () => {
    for (const change of [
      (workflow: Json) => void (workflow.env = { [DATABASE_SHARD_VARIABLE]: '1/3' }),
      (_: Json, jobs: Jobs) => void (jobs.unit.env = { [DATABASE_SHARD_VARIABLE]: '1/3' }),
      (_: Json, jobs: Jobs) =>
        void (stepAt(jobs.unit, 2).env = { [DATABASE_SHARD_VARIABLE]: '1/3' }),
    ]) {
      assert.deepEqual(
        codesWith((workflow, jobs) => {
          change(workflow, jobs);
        }),
        ['DATABASE_SHARD_ENV'],
      );
    }
  });

  // Break caught: the job made one job again (the whole suite, longer than a job may last), or a matrix the check cannot read.
  for (const [label, change] of [
    [
      'a job that is not a matrix',
      (jobs: Jobs) => void Reflect.deleteProperty(jobs.database, 'strategy'),
    ],
    [
      'a matrix computed by an expression',
      (jobs: Jobs) => void (strategyOf(jobs).matrix = '${{ fromJSON(x) }}'),
    ],
    ['fail-fast left true', (jobs: Jobs) => void (strategyOf(jobs)['fail-fast'] = true)],
    ['an exclude beside the list', (jobs: Jobs) => void (matrixOf(jobs).exclude = [{ shard: 2 }])],
    ['an empty list', (jobs: Jobs) => void (matrixOf(jobs).include = [])],
  ] as const) {
    it(`rejects ${label}`, () => {
      assert.deepEqual(
        codesWith((_, jobs) => {
          change(jobs);
        }),
        ['DATABASE_SHARDS_DRIFT'],
      );
    });
  }

  // Each of these entries is faulted and, not being counted, leaves its place empty: two faults.
  for (const [label, change] of [
    ['an entry with a key of its own', (entry: Json) => void (entry.os = 'ubuntu-24.04')],
    [
      'an entry with the browsers of the HTTPS matrix',
      (entry: Json) => void (entry.browsers = 'webkit'),
    ],
    ['a shard that is text', (entry: Json) => void (entry.shard = '1')],
    ['a shard beyond its number', (entry: Json) => void (entry.shard = 4)],
    ['shard 0', (entry: Json) => void (entry.shard = 0)],
    ['a number of shards that is text', (entry: Json) => void (entry.shards = '3')],
  ] as const) {
    it(`rejects ${label}, and the place it leaves empty`, () => {
      const faults = faultsAfter((jobs) => {
        const entry = entriesOf(jobs)[0];
        assert.ok(entry !== undefined);
        change(entry);
      });
      assert.ok(faults.length >= 2, faults.join(' | '));
    });
  }

  // Break caught (the failure to show): a shard dropped from the matrix leaves the files it holds to no job.
  it('rejects a dropped shard, and says which', () => {
    const faults = faultsAfter((jobs) => {
      matrixOf(jobs).include = entriesOf(jobs).filter((entry) => entry.shard !== 2);
    });
    assert.deepEqual(faults, [
      'the database tests has no entry for shard 2 of 3, so the tests of that shard are never run',
    ]);
  });

  it('rejects a shard listed twice, and shards that disagree on the total', () => {
    assert.match(
      faultsAfter((jobs) => {
        entriesOf(jobs).push({ shard: 2, shards: 3 });
      })[0] ?? '',
      /lists shard 2 of 3 more than once/,
    );
    assert.match(
      faultsAfter((jobs) => {
        const entry = entriesOf(jobs)[1];
        assert.ok(entry !== undefined);
        entry.shards = 4;
      })[0] ?? '',
      /disagree on the number of shards \(3, 4\)/,
    );
  });
});
