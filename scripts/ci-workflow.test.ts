import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { stringify } from 'yaml';

import {
  AGGREGATE_JOB,
  REQUIRED_COMMANDS,
  findPostgresImageProblems,
  findWorkflowProblems,
} from './ci-workflow.ts';
import { readLocalActions, workflowSteps } from './composite-actions.ts';
import { isRecord } from './workflow-shapes.ts';

type Json = Record<string, unknown>;

/** The jobs of the fixture workflow, by id. */
interface Jobs {
  static: Json;
  unit: Json;
  database: Json;
  integrated: Json;
  audit: Json;
  ci: Json;
}

const SHA = '0123456789abcdef0123456789abcdef01234567';
const GITHUB_SHA = '${{ github.sha }}';

const CHECKOUT = {
  name: 'Check out',
  uses: `actions/checkout@${SHA}`,
  with: { ref: GITHUB_SHA, 'persist-credentials': false },
};
const SETUP = { name: 'Set up', uses: './.github/actions/setup' };
const run = (command: string): Json => ({ name: command, run: command });

const REHEARSAL = {
  name: 'Rehearse a failing check',
  if: "github.event_name == 'workflow_dispatch' && inputs.rehearse-failure",
  run: 'exit 1',
};
const DIAGNOSTICS = {
  name: 'Keep diagnostics',
  if: 'failure()',
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
const BROWSER_LIST = 'chromium,firefox,webkit';
const INSTALL_BROWSERS =
  'pnpm --filter @melarc/e2e exec playwright install --with-deps chromium firefox webkit';

const JOB_IDS = ['static', 'unit', 'database', 'integrated', 'audit'];

function job(steps: Json[]): Json {
  return {
    name: 'A job',
    'runs-on': 'ubuntu-24.04',
    'timeout-minutes': 10,
    steps: [CHECKOUT, SETUP, ...steps],
  };
}

function goodShared(): Json {
  return {
    name: 'CI',
    on: {
      push: { branches: ['main'] },
      pull_request: null,
      workflow_dispatch: { inputs: { 'rehearse-failure': { type: 'boolean', default: false } } },
    },
    permissions: { contents: 'read' },
    jobs: {
      static: job([
        run('pnpm run format:check'),
        run('pnpm run lint'),
        run('pnpm run typecheck'),
        run('pnpm --filter @melarc/api run db:check'),
        run('pnpm run api-client:check'),
        REHEARSAL,
      ]),
      unit: job([run('pnpm run test')]),
      database: job([run('pnpm run test:db')]),
      integrated: job([
        run('pnpm run build'),
        run('pnpm run contract:check'),
        run(INSTALL_BROWSERS),
        { ...run(BROWSER_TESTS), env: { MELARC_BROWSERS: BROWSER_LIST } },
        run('pnpm run test:e2e'),
        DIAGNOSTICS,
        run(CLEAN_SCRIPT),
        run(MANIFEST_SCRIPT),
        BUILD_UPLOAD,
      ]),
      audit: job([run('pnpm audit --audit-level high')]),
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
            env: { NEEDS: '${{ toJSON(needs) }}' },
            run: `node scripts/ci-aggregate.ts ${JOB_IDS.join(' ')}`,
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
  const step = stepsOf(target).find((candidate) => candidate.run === script);
  assert.ok(step !== undefined, `the job has no step that runs ${script}`);
  return step;
}

const allJobs = (jobs: Jobs): Json[] => [
  jobs.static,
  jobs.unit,
  jobs.database,
  jobs.integrated,
  jobs.audit,
  jobs.ci,
];

/** The one step, in whichever job, whose whole script is `script`. */
function runningStep(jobs: Jobs, script: string): Json {
  const found = allJobs(jobs).flatMap((target) =>
    stepsOf(target).filter((step) => step.run === script),
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
  return stepsOf(target).filter((step) => step.run !== script);
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

  // Break caught: a job that is not waited for, so its failure never reaches the verdict.
  it('must wait for every other job', () => {
    assert.deepEqual(
      codesWith((_, jobs) => {
        jobs.ci.needs = JOB_IDS.filter((id) => id !== 'database');
      }),
      ['AGGREGATE_NEEDS_DRIFT'],
    );
  });

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
      ['CHECKOUT_MISSING', 'COMMAND_MISSING', 'RUNNER_DRIFT'],
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
          if (timeout === undefined) Reflect.deleteProperty(jobs.unit, 'timeout-minutes');
          else jobs.unit['timeout-minutes'] = timeout;
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
          jobs.unit['timeout-minutes'] = timeout;
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

describe('mandatory commands', () => {
  // Break caught: a check deleted from the workflow (or its name changed so it runs something else), leaving a
  // pipeline that is green because it asks less.
  for (const command of REQUIRED_COMMANDS) {
    it(`requires ${command}`, () => {
      const found = codesWith((_, jobs) => {
        for (const target of allJobs(jobs)) target.steps = withoutScript(target, command);
      });
      assert.deepEqual(found, ['COMMAND_MISSING']);
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
  for (const command of REQUIRED_COMMANDS) {
    it(`requires ${command} to be the whole script of its step`, () => {
      for (const [label, script] of around) {
        assert.deepEqual(
          codesWith((_, jobs) => {
            runningStep(jobs, command).run = script(command);
          }),
          ['COMMAND_MISSING'],
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
  for (const command of REQUIRED_COMMANDS) {
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
  for (const command of REQUIRED_COMMANDS) {
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

// The browser tests run the engines MELARC_BROWSERS names, and Chromium alone when it is not set (the Ops
// Portal's CLAUDE.md says why CI runs all three: they are the engines of the supported browsers). A pipeline that
// stops setting it, or installs fewer, would keep passing while two of the three engines were never run.
describe('the browser matrix', () => {
  const codesOf = (change: (jobs: Jobs) => void): string[] =>
    codesWith((_, jobs) => {
      change(jobs);
    });

  // Break caught: the variable dropped, renamed, reordered, padded or filled with another list or a computed
  // value, so that the tests run fewer engines than CI promises (or an engine that is not installed).
  for (const value of [
    undefined,
    '',
    'chromium',
    'chromium,firefox',
    'chromium,webkit',
    'firefox,webkit',
    'chromium,firefox,webkit,msedge',
    'firefox,chromium,webkit',
    'chromium, firefox, webkit',
    ' chromium,firefox,webkit',
    'chromium,firefox,webkit ',
    'chromium,firefox,webkit,',
    'Chromium,Firefox,WebKit',
    '${{ vars.BROWSERS }}',
  ]) {
    it(`requires MELARC_BROWSERS to be ${BROWSER_LIST}, not ${JSON.stringify(value)}`, () => {
      assert.deepEqual(
        codesOf((jobs) => {
          const step = runningStep(jobs, BROWSER_TESTS);
          if (value === undefined) Reflect.deleteProperty(step, 'env');
          else step.env = { MELARC_BROWSERS: value };
        }),
        ['BROWSER_MATRIX_ENV'],
      );
    });
  }

  it('requires the variable on the step itself, not only on the job or the workflow', () => {
    assert.deepEqual(
      codesOf((jobs) => {
        Reflect.deleteProperty(runningStep(jobs, BROWSER_TESTS), 'env');
        jobs.integrated.env = { MELARC_BROWSERS: BROWSER_LIST };
      }),
      ['BROWSER_MATRIX_ENV'],
    );
  });

  it('accepts other variables beside it', () => {
    assert.deepEqual(
      codesOf((jobs) => {
        runningStep(jobs, BROWSER_TESTS).env = { CI: 'true', MELARC_BROWSERS: BROWSER_LIST };
      }),
      [],
    );
  });

  // Break caught: the engines not downloaded, or only some of them, so the run would fail for a missing browser
  // (or, with another engine installed, test one that is not in the list).
  for (const [label, script] of [
    ['only Chromium', 'pnpm --filter @melarc/e2e exec playwright install --with-deps chromium'],
    [
      'two engines',
      'pnpm --filter @melarc/e2e exec playwright install --with-deps chromium firefox',
    ],
    [
      'all three without naming them (the default set)',
      'pnpm --filter @melarc/e2e exec playwright install --with-deps',
    ],
    [
      'a fourth engine too',
      'pnpm --filter @melarc/e2e exec playwright install --with-deps chromium firefox webkit msedge',
    ],
    [
      'one engine twice, one missing',
      'pnpm --filter @melarc/e2e exec playwright install chromium chromium firefox',
    ],
    [
      'an engine named twice',
      'pnpm --filter @melarc/e2e exec playwright install chromium chromium firefox webkit',
    ],
    [
      'one named in capitals',
      'pnpm --filter @melarc/e2e exec playwright install chromium firefox WebKit',
    ],
  ] as const) {
    it(`requires the install step to install exactly the three: not ${label}`, () => {
      assert.deepEqual(
        codesOf((jobs) => {
          runningStep(jobs, INSTALL_BROWSERS).run = script;
        }),
        ['BROWSER_INSTALL_DRIFT'],
      );
    });
  }

  for (const script of [
    'pnpm --filter @melarc/e2e exec playwright install --with-deps webkit firefox chromium',
    'pnpm --filter @melarc/e2e exec playwright install chromium firefox webkit',
    'pnpm exec playwright install --with-deps chromium firefox webkit',
    'pnpm --filter @melarc/e2e exec playwright install --with-deps chromium firefox webkit\n',
    '  pnpm exec playwright install chromium firefox webkit  \n',
  ]) {
    it(`accepts the install step ${JSON.stringify(script)}`, () => {
      assert.deepEqual(
        codesOf((jobs) => {
          runningStep(jobs, INSTALL_BROWSERS).run = script;
        }),
        [],
      );
    });
  }

  // Break caught: the install step deleted, or kept in a form that does not install before the tests.
  it('requires an install step', () => {
    assert.deepEqual(
      codesOf((jobs) => {
        jobs.integrated.steps = withoutScript(jobs.integrated, INSTALL_BROWSERS);
      }),
      ['BROWSER_INSTALL_DRIFT'],
    );
  });

  it('requires the install to come before the tests that need the browsers', () => {
    assert.deepEqual(
      codesOf((jobs) => {
        const steps = stepsOf(jobs.integrated);
        const at = steps.findIndex((step) => step.run === INSTALL_BROWSERS);
        const [install] = steps.splice(at, 1);
        assert.ok(install !== undefined);
        steps.splice(steps.findIndex((step) => step.run === BROWSER_TESTS) + 1, 0, install);
      }),
      ['BROWSER_INSTALL_DRIFT'],
    );
  });

  it('requires the install to be in the job that runs the tests', () => {
    assert.deepEqual(
      codesOf((jobs) => {
        const [install] = stepsOf(jobs.integrated).splice(
          stepsOf(jobs.integrated).findIndex((step) => step.run === INSTALL_BROWSERS),
          1,
        );
        assert.ok(install !== undefined);
        stepsOf(jobs.unit).push(install);
      }),
      ['BROWSER_INSTALL_DRIFT'],
    );
  });

  // Break caught: the install command inside a longer script, where a failure or a condition could skip it
  // while the line stays in the file.
  for (const wrap of [
    (command: string) => `echo start\n${command}`,
    (command: string) => `${command} || true`,
    (command: string) => `echo ${command}`,
    (command: string) => `# ${command}`,
  ]) {
    it(`does not count an install step that is not the command alone: ${JSON.stringify(wrap('INSTALL'))}`, () => {
      const found = codesOf((jobs) => {
        const step = runningStep(jobs, INSTALL_BROWSERS);
        step.run = wrap(INSTALL_BROWSERS);
      });
      assert.ok(found.includes('BROWSER_INSTALL_DRIFT'), found.join(', '));
    });
  }

  it('rejects a condition on the install step like on any other step', () => {
    assert.deepEqual(
      codesOf((jobs) => {
        runningStep(jobs, INSTALL_BROWSERS).if = "github.event_name == 'push'";
      }),
      ['STEP_CONDITIONAL'],
    );
  });

  it('leaves a workflow without browser tests to the missing-command rule', () => {
    assert.deepEqual(
      codesOf((jobs) => {
        jobs.integrated.steps = withoutScript(jobs.integrated, BROWSER_TESTS);
      }),
      ['COMMAND_MISSING'],
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
  // build that the browser and journey tests have not yet run against (or touched).
  it('requires the clean-tree check and the manifest to come after the browser tests', () => {
    for (const test of ['pnpm run test:browser', 'pnpm run test:e2e']) {
      assert.deepEqual(
        codesWith((_, jobs) => {
          const steps = stepsOf(jobs.integrated);
          const moved = steps.findIndex((step) => step.run === test);
          const clean = steps.findIndex((step) => step.run === CLEAN_SCRIPT);
          const manifest = steps.findIndex((step) => step.run === MANIFEST_SCRIPT);
          // Put the test after the clean-tree check and the manifest, still before the upload.
          const [step] = steps.splice(moved, 1);
          assert.ok(step !== undefined && clean !== -1 && manifest !== -1);
          steps.splice(steps.findIndex((s) => s.run === MANIFEST_SCRIPT) + 1, 0, step);
        }),
        ['ARTIFACT_NOT_AFTER_TESTS'],
      );
    }
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

  // Break caught: a trigger that runs this workflow with more than a pull request's own rights, on a schedule or
  // for an event no change of the code caused. pull_request_target and workflow_run run with the repository's
  // secrets and a token that can write, on a side of the change the author controls; the others make the
  // verdict about something other than a commit that was pushed or proposed.
  for (const trigger of [
    'pull_request_target',
    'schedule',
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
          (workflow.on as Json)[trigger] = trigger === 'schedule' ? [{ cron: '0 3 * * *' }] : {};
        }),
        ['TRIGGER_FORBIDDEN'],
      );
    });
  }

  it('accepts exactly push, pull_request and workflow_dispatch', () => {
    assert.deepEqual(
      codesWith((workflow) => {
        assert.deepEqual(Object.keys(workflow.on as Json).toSorted(), [
          'pull_request',
          'push',
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

  // Break caught: a command the workflow requires being renamed in package.json, or vice versa.
  it('names only scripts that exist in the manifests', () => {
    const rootScripts = scriptsOf(read('package.json'));
    const apiScripts = scriptsOf(read('apps/api/package.json'));
    for (const command of REQUIRED_COMMANDS) {
      const filtered = /^pnpm --filter @melarc\/api run (\S+)$/.exec(command);
      const plain = /^pnpm run (\S+)$/.exec(command);
      if (filtered?.[1] !== undefined) {
        assert.ok(apiScripts.includes(filtered[1]), `${command}: no such script in apps/api`);
      } else if (plain?.[1] !== undefined) {
        assert.ok(
          rootScripts.includes(plain[1]),
          `${command}: no such script in the root package.json`,
        );
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
