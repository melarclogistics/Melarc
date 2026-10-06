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
        run('pnpm run test:browser'),
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
  // mandatory command missing when it changes the line that runs it.
  const swallowed: [script: string, codes: string[]][] = [
    ['pnpm run test || true', ['COMMAND_MISSING', 'FAILURE_SWALLOWED']],
    ['pnpm run test || :', ['COMMAND_MISSING', 'FAILURE_SWALLOWED']],
    ['pnpm run test || exit 0', ['COMMAND_MISSING', 'FAILURE_SWALLOWED']],
    ['set +e\npnpm run test', ['FAILURE_SWALLOWED']],
    ['pnpm run test\nexit 0', ['FAILURE_SWALLOWED']],
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

  it('counts a command inside a multi-line script', () => {
    assert.deepEqual(
      codesWith((_, jobs) => {
        stepAt(jobs.unit, 2).run = 'echo start\npnpm run test\necho done';
      }),
      [],
    );
  });

  // Break caught: a command that is still run, with spaces around it, being reported as dropped.
  it('counts a command indented or followed by spaces in its line', () => {
    assert.deepEqual(
      codesWith((_, jobs) => {
        stepAt(jobs.unit, 2).run = 'echo start\n    pnpm run test   \necho done';
      }),
      [],
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
