import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import {
  aggregate,
  parseArguments,
  renderReport,
  runAggregate,
  type AggregateProblemCode,
} from './ci-aggregate.ts';

const JOBS = ['static', 'unit', 'database'] as const;

/** The `needs` context GitHub passes: every job that was waited for, with its result. */
function needsOf(results: Record<string, string>): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(results).map(([job, result]) => [job, { result, outputs: {} }]),
    ),
  );
}

const ALL_GREEN = needsOf({ static: 'success', unit: 'success', database: 'success' });

function codesFor(needs: string | undefined, expected: readonly string[] = JOBS): string[] {
  return aggregate(needs, expected).problems.map((problem) => problem.code);
}

describe('aggregate', () => {
  it('passes when every expected job succeeded', () => {
    const { problems, verdicts } = aggregate(ALL_GREEN, JOBS);
    assert.deepEqual(problems, []);
    assert.deepEqual(verdicts, [
      { job: 'static', result: 'success' },
      { job: 'unit', result: 'success' },
      { job: 'database', result: 'success' },
    ]);
  });

  // Break caught: the aggregate counting a job that did not succeed as acceptable. GitHub reports each of these
  // as the job's result, and a required check that is skipped counts as passed unless the aggregate refuses it.
  for (const result of ['failure', 'cancelled', 'skipped']) {
    it(`fails when a job's result is ${result}`, () => {
      const needs = needsOf({ static: 'success', unit: result, database: 'success' });
      const { problems } = aggregate(needs, JOBS);
      assert.deepEqual(
        problems.map((problem) => [problem.code, problem.job]),
        [['JOB_NOT_SUCCESSFUL', 'unit']],
      );
      assert.match(problems[0]?.message ?? '', new RegExp(`unit.*${result}`));
    });
  }

  // Break caught: a result spelled any way but "success" passing by accident (a prefix match, a case fold).
  for (const result of ['Success', 'successful', 'success ', '', 'passed']) {
    it(`fails on the result ${JSON.stringify(result)}`, () => {
      const needs = needsOf({ static: result, unit: 'success', database: 'success' });
      assert.deepEqual(codesFor(needs), ['JOB_NOT_SUCCESSFUL']);
    });
  }

  it('reports every job that did not succeed, not only the first', () => {
    const needs = needsOf({ static: 'failure', unit: 'cancelled', database: 'skipped' });
    assert.deepEqual(codesFor(needs), [
      'JOB_NOT_SUCCESSFUL',
      'JOB_NOT_SUCCESSFUL',
      'JOB_NOT_SUCCESSFUL',
    ]);
  });

  // Break caught: a job dropped from the workflow's `needs` list, which would let the aggregate pass without it.
  it('fails when an expected job is absent from needs', () => {
    const needs = needsOf({ static: 'success', unit: 'success' });
    const { problems } = aggregate(needs, JOBS);
    assert.deepEqual(
      problems.map((problem) => [problem.code, problem.job]),
      [['JOB_MISSING', 'database']],
    );
  });

  // Break caught: a job added to `needs` and never named in the expected list; the two have drifted apart.
  it('fails when needs holds a job that was not expected', () => {
    const needs = needsOf({
      static: 'success',
      unit: 'success',
      database: 'success',
      extra: 'success',
    });
    const { problems } = aggregate(needs, JOBS);
    assert.deepEqual(
      problems.map((problem) => [problem.code, problem.job]),
      [['JOB_UNEXPECTED', 'extra']],
    );
  });

  // Break caught: an entry whose result is missing or not text being read as success.
  const malformedEntries: [label: string, entry: unknown][] = [
    ['null', null],
    ['a string', 'success'],
    ['an object without a result', { outputs: {} }],
    ['a non-string result', { result: true }],
  ];
  for (const [label, entry] of malformedEntries) {
    it(`fails on a needs entry that is ${label}`, () => {
      const needs = JSON.stringify({
        static: { result: 'success' },
        unit: entry,
        database: { result: 'success' },
      });
      assert.deepEqual(codesFor(needs), ['JOB_NOT_SUCCESSFUL']);
    });
  }

  // Break caught: unreadable input passing because there was nothing to inspect.
  const unreadable: [label: string, needs: string | undefined][] = [
    ['an undefined value', undefined],
    ['an empty string', ''],
    ['text that is not JSON', 'success'],
    ['an array', '[]'],
    ['null', 'null'],
    ['a string', '"success"'],
    ['an empty object', '{}'],
  ];
  for (const [label, needs] of unreadable) {
    it(`fails closed on ${label}`, () => {
      const codes = codesFor(needs);
      assert.ok(codes.length > 0, 'an unreadable needs value must not pass');
      assert.ok(
        codes.includes('NEEDS_UNREADABLE') || codes.every((code) => code === 'JOB_MISSING'),
      );
    });
  }

  // Break caught: a pipeline that expects nothing passing for lack of anything to check.
  it('fails when no job is expected', () => {
    assert.deepEqual(codesFor(ALL_GREEN, []), [
      'NO_EXPECTED_JOBS',
      'JOB_UNEXPECTED',
      'JOB_UNEXPECTED',
      'JOB_UNEXPECTED',
    ]);
    assert.deepEqual(codesFor('{}', []), ['NO_EXPECTED_JOBS']);
  });

  it('treats a repeated expected job name as one job', () => {
    const { problems, verdicts } = aggregate(ALL_GREEN, ['static', 'unit', 'database', 'unit']);
    assert.deepEqual(problems, []);
    assert.deepEqual(
      verdicts.map(({ job }) => job),
      ['static', 'unit', 'database'],
    );
  });

  it('does not mistake an inherited property name for a job', () => {
    const needs = needsOf({ static: 'success', unit: 'success', database: 'success' });
    const codes: AggregateProblemCode[] = aggregate(needs, [
      ...JOBS,
      'constructor',
      'toString',
    ]).problems.map((problem) => problem.code);
    assert.deepEqual(codes, ['JOB_MISSING', 'JOB_MISSING']);
  });
});

describe('renderReport', () => {
  it('names each job with its result and ends with the verdict', () => {
    const failed = aggregate(
      needsOf({ static: 'success', unit: 'failure', database: 'success' }),
      JOBS,
    );
    const report = renderReport(failed);
    assert.match(report, /static\s+success/);
    assert.match(report, /unit\s+failure/);
    assert.match(report, /database\s+success/);
    assert.match(report, /CI result: FAILED/);

    const passed = renderReport(aggregate(ALL_GREEN, JOBS));
    assert.match(passed, /CI result: passed/);
    assert.doesNotMatch(passed, /FAILED/);
  });
});

describe('runAggregate', () => {
  const lines: string[] = [];
  const output = (line: string): void => void lines.push(line);

  it('returns 0 and prints no error annotation when every job succeeded', () => {
    lines.length = 0;
    assert.equal(runAggregate([...JOBS], { NEEDS: ALL_GREEN }, output), 0);
    assert.ok(!lines.join('\n').includes('::error'));
  });

  it('returns 1 and annotates each problem when a job failed', () => {
    lines.length = 0;
    const needs = needsOf({ static: 'success', unit: 'failure', database: 'success' });
    assert.equal(runAggregate([...JOBS], { NEEDS: needs }, output), 1);
    assert.match(lines.join('\n'), /::error title=CI result::.*unit/);
  });

  it('returns 1 when the NEEDS variable is not set', () => {
    lines.length = 0;
    assert.equal(runAggregate([...JOBS], {}, output), 1);
  });
});

// The command GitHub runs, started as a real process: the exit status is what turns the check red.
describe('the command line', () => {
  const script = resolve(import.meta.dirname, 'ci-aggregate.ts');

  function run(needs: string | undefined, jobs: readonly string[] = JOBS) {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.NEEDS;
    if (needs !== undefined) env.NEEDS = needs;
    return spawnSync(process.execPath, [script, ...jobs], { env, encoding: 'utf8' });
  }

  it('exits 0 when every mandatory job succeeded', () => {
    const result = run(ALL_GREEN);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /CI result: passed/);
  });

  // The runbook's validation: an intentionally failing mandatory check fails the aggregate.
  it('exits 1 when one mandatory job failed', () => {
    const result = run(needsOf({ static: 'success', unit: 'success', database: 'failure' }));
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /database\s+failure/);
    assert.match(result.stdout, /CI result: FAILED/);
  });

  it('exits 1 when a mandatory job was skipped', () => {
    const result = run(needsOf({ static: 'success', unit: 'skipped', database: 'success' }));
    assert.equal(result.status, 1, result.stdout + result.stderr);
  });

  it('exits 1 without NEEDS and with no job named', () => {
    assert.equal(run(undefined).status, 1);
    assert.equal(run(ALL_GREEN, []).status, 1);
  });
});

// The one skip a pull request may be allowed: the job of the Firefox and WebKit shards of the browser tests, which only pushes to
// main, the nightly run and a manual run make (the Product Owner's decision of 7 November 2026). The verdict is told the event, and
// the job, on its command line; everywhere else a skipped job is as much a failure as a failed one.
describe('a skip that a pull request may be allowed', () => {
  const SKIPPABLE = 'browser-firefox-webkit';
  const ALL_JOBS = [
    'static',
    'unit',
    'database',
    'integrated',
    'https',
    'browser-chromium',
    SKIPPABLE,
    'audit',
    'verifier',
  ] as const;
  const EVENTS = ['pull_request', 'push', 'schedule', 'workflow_dispatch'] as const;
  const RESULTS = ['success', 'failure', 'cancelled', 'skipped'] as const;

  const resultsWith = (job: string, result: string): Record<string, string> =>
    Object.fromEntries(ALL_JOBS.map((name) => [name, name === job ? result : 'success']));
  const judge = (needs: Record<string, string>, event: string | undefined) =>
    aggregate(needsOf(needs), ALL_JOBS, { event, skippedOnPullRequest: [SKIPPABLE] });

  // The rule written once more, apart from the code: success always, and a skip of the one job on a pull request alone.
  const accepted = (event: string, job: string, result: string): boolean =>
    result === 'success' || (result === 'skipped' && event === 'pull_request' && job === SKIPPABLE);

  // Break caught: a skip let through where it may not be (every job on every event), or a skip of the one job refused on a pull
  // request (which would make every pull request red); and a failure or a cancellation of that job treated as a skip.
  for (const event of EVENTS) {
    for (const job of ALL_JOBS) {
      for (const result of RESULTS) {
        it(`on ${event}, ${job} ${result} is ${accepted(event, job, result) ? 'accepted' : 'a failure'}`, () => {
          const { problems } = judge(resultsWith(job, result), event);
          assert.deepEqual(
            problems.map((problem) => [problem.code, problem.job]),
            accepted(event, job, result) ? [] : [['JOB_NOT_SUCCESSFUL', job]],
          );
        });
      }
    }
  }

  it('says, in its report, which skip it allowed and why', () => {
    const allowed = aggregate(needsOf(resultsWith(SKIPPABLE, 'skipped')), ALL_JOBS, {
      event: 'pull_request',
      skippedOnPullRequest: [SKIPPABLE],
    });
    assert.deepEqual(allowed.problems, []);
    assert.deepEqual(
      allowed.verdicts.filter((verdict) => verdict.allowed === true),
      [{ job: SKIPPABLE, result: 'skipped', allowed: true }],
    );
    assert.match(
      renderReport(allowed),
      /browser-firefox-webkit\s+skipped \(allowed: a pull request does not run it\)/,
    );
    assert.match(renderReport(allowed), /CI result: passed/);
  });

  // Break caught: the allowance covering a job that failed beside it, or every job being skipped on a pull request at once.
  it('reports every other job when a pull request skips them all', () => {
    const needs = Object.fromEntries(ALL_JOBS.map((job) => [job, 'skipped']));
    const { problems } = judge(needs, 'pull_request');
    assert.deepEqual(
      problems.map((problem) => problem.job),
      ALL_JOBS.filter((job) => job !== SKIPPABLE),
    );
  });

  it('still reports a job that failed when the allowed skip is the only other thing that happened', () => {
    const needs = { ...resultsWith(SKIPPABLE, 'skipped'), unit: 'failure' };
    assert.deepEqual(
      judge(needs, 'pull_request').problems.map((problem) => [problem.code, problem.job]),
      [['JOB_NOT_SUCCESSFUL', 'unit']],
    );
  });

  // Break caught: a run that cannot say what it is (the variable dropped from the workflow, or written wrong) allowing a skip, or
  // staying silent about it: the event is read exactly, and its absence is a problem of its own.
  for (const event of [undefined, '', '   ']) {
    it(`fails, naming the missing event, when the event is ${JSON.stringify(event)}, and allows no skip`, () => {
      const { problems } = judge(resultsWith(SKIPPABLE, 'skipped'), event);
      assert.deepEqual(
        problems.map((problem) => problem.code),
        ['EVENT_UNREADABLE', 'JOB_NOT_SUCCESSFUL'],
      );
    });
  }

  for (const event of [
    'Pull_Request',
    ' pull_request',
    'pull_request ',
    'pull_request_target',
    'pr',
    'push',
  ]) {
    it(`allows no skip on the event ${JSON.stringify(event)}`, () => {
      const { problems } = judge(resultsWith(SKIPPABLE, 'skipped'), event);
      assert.deepEqual(
        problems.map((problem) => problem.code),
        ['JOB_NOT_SUCCESSFUL'],
      );
    });
  }

  // Break caught: a job that is not a mandatory job named in the allowance (a typo), which would allow nothing and say nothing.
  it('reports an allowance that names a job that is not mandatory', () => {
    const { problems } = aggregate(needsOf(resultsWith(SKIPPABLE, 'success')), ALL_JOBS, {
      event: 'pull_request',
      skippedOnPullRequest: [SKIPPABLE, 'browser-firefox-webkt'],
    });
    assert.deepEqual(
      problems.map((problem) => [problem.code, problem.job]),
      [['SKIP_JOB_UNKNOWN', 'browser-firefox-webkt']],
    );
  });

  // Break caught: a pull request skipping a job nobody allowed (the allowance dropped from the command, or never given).
  it('allows no skip without an allowance, whatever the event', () => {
    for (const event of EVENTS) {
      const { problems } = aggregate(needsOf(resultsWith(SKIPPABLE, 'skipped')), ALL_JOBS, {
        event,
      });
      assert.deepEqual(
        problems.map((problem) => [problem.code, problem.job]),
        [['JOB_NOT_SUCCESSFUL', SKIPPABLE]],
        event,
      );
    }
  });

  it('needs no event when no job is allowed to be skipped', () => {
    assert.deepEqual(aggregate(ALL_GREEN, JOBS, {}).problems, []);
  });
});

describe('the arguments of the command', () => {
  it('reads job ids, and the one option that names the jobs a pull request may skip', () => {
    assert.deepEqual(parseArguments(['--skipped-on-pull-request=a,b', 'static', 'a', 'b']), {
      jobs: ['static', 'a', 'b'],
      skippedOnPullRequest: ['a', 'b'],
      runsAlways: [],
      plan: undefined,
      unreadable: [],
    });
    assert.deepEqual(
      parseArguments(['--skipped-on-pull-request=a', '--skipped-on-pull-request=b']),
      {
        jobs: [],
        skippedOnPullRequest: ['a', 'b'],
        runsAlways: [],
        plan: undefined,
        unreadable: [],
      },
    );
  });

  // Break caught: an option that is misspelt or empty read as "no allowance" and passing, or a flag passed as a job id.
  for (const argument of [
    '--skip-on-pull-request=a',
    '--skipped-on-pull-request',
    '--skipped-on-pull-request=',
    '--skipped-on-pull-request=a,',
    '--skipped-on-pull-request=,a',
    '--unknown',
    '--',
  ]) {
    it(`finds ${argument} unreadable, and names it as no job`, () => {
      assert.deepEqual(parseArguments([argument, 'static']), {
        jobs: ['static'],
        skippedOnPullRequest: [],
        runsAlways: [],
        plan: undefined,
        unreadable: [argument],
      });
    });
  }

  it('reads the one option that names the plan', () => {
    assert.deepEqual(parseArguments(['--plan=plan', 'plan', 'static']), {
      jobs: ['plan', 'static'],
      skippedOnPullRequest: [],
      runsAlways: [],
      plan: 'plan',
      unreadable: [],
    });
  });

  // Break caught: a plan named twice, or with no name or several, believed in part: the verdict would trust whichever it met last.
  for (const args of [
    ['--plan='],
    ['--plan=a,b'],
    ['--plan=a', '--plan=b'],
    ['--plan=a', '--plan=a'],
  ]) {
    it(`finds ${args.join(' ')} unreadable`, () => {
      const parsed = parseArguments([...args, 'static']);
      assert.deepEqual(parsed.jobs, ['static']);
      assert.ok(parsed.unreadable.length >= 1, 'an unreadable argument is reported');
    });
  }
});

describe('the jobs the plan does not decide (run 4, Stage 1, item 4: the dependency audit)', () => {
  it('reads the option that names them, and finds an empty name unreadable', () => {
    assert.deepEqual(parseArguments(['--runs-always=audit', 'audit', 'static']).runsAlways, [
      'audit',
    ]);
    assert.deepEqual(parseArguments(['--runs-always=a,b', 'static']).runsAlways, ['a', 'b']);
    for (const argument of ['--runs-always=', '--runs-always=a,']) {
      const parsed = parseArguments([argument, 'static']);
      assert.deepEqual(parsed.unreadable, [argument]);
      assert.deepEqual(parsed.runsAlways, []);
    }
  });

  const JOBS = ['plan', 'static', 'audit'] as const;
  const night = (results: Record<string, string>, run: string): string =>
    JSON.stringify(
      Object.fromEntries(
        JOBS.map((job) => [
          job,
          { result: results[job] ?? 'success', outputs: job === 'plan' ? { run } : {} },
        ]),
      ),
    );
  const judge = (needs: string, runsAlways: readonly string[]) =>
    aggregate(needs, JOBS, { event: 'schedule', plan: 'plan', runsAlways });

  // Break caught: the audit skipped with the rest on a night that stands down, which is the finding: an advisory is published with no commit, and the night
  // that finds the code unchanged would have passed without looking for one.
  it('does not accept a skip of the audit on a night that stands down, though it accepts the skip of every other job', () => {
    const needs = night({ static: 'skipped', audit: 'skipped' }, 'false');

    const named = judge(needs, ['audit']);
    assert.deepEqual(
      named.problems.map((problem) => [problem.code, problem.job]),
      [['JOB_NOT_SUCCESSFUL', 'audit']],
    );
    assert.deepEqual(
      named.verdicts.find((verdict) => verdict.job === 'static'),
      {
        job: 'static',
        result: 'skipped',
        allowed: true,
        skippedBy: 'plan',
      },
    );

    // The control: with nothing named, the plan's word allows the skip of the audit too, which is what the workflow no longer says.
    assert.deepEqual(judge(needs, []).problems, []);
  });

  it('is satisfied when the audit ran on the night that stood down', () => {
    assert.deepEqual(judge(night({ static: 'skipped' }, 'false'), ['audit']).problems, []);
  });

  // Break caught: a failed audit absorbed by the plan's allowance, or a job named as always-running that the check was not told to expect.
  it('fails an audit that failed, and refuses an always-running job that is not a mandatory one', () => {
    assert.deepEqual(
      judge(night({ audit: 'failure', static: 'skipped' }, 'false'), ['audit']).problems.map(
        (problem) => problem.code,
      ),
      ['JOB_NOT_SUCCESSFUL'],
    );
    assert.deepEqual(
      judge(night({ static: 'skipped' }, 'false'), ['audit', 'elsewhere']).problems.map(
        (problem) => problem.code,
      ),
      ['ALWAYS_JOB_UNKNOWN'],
    );
  });
});

describe('the plan of the nightly run (task CI.2)', () => {
  const PLAN = 'plan';
  const SKIPPABLE = 'browser-firefox-webkit';
  const PLANNED = [PLAN, 'static', 'unit', 'browser-chromium', SKIPPABLE] as const;
  const OTHERS = PLANNED.filter((job) => job !== PLAN);
  const EVENTS = ['pull_request', 'push', 'schedule', 'workflow_dispatch'] as const;

  /** The needs of a planned run: the plan with the answer it gave, and every other job with its result (success unless given). */
  function planned(run: string | undefined, results: Record<string, string> = {}): string {
    return JSON.stringify(
      Object.fromEntries(
        PLANNED.map((job) => [
          job,
          {
            result: results[job] ?? 'success',
            outputs: job === PLAN && run !== undefined ? { run } : {},
          },
        ]),
      ),
    );
  }
  const allSkipped = Object.fromEntries(OTHERS.map((job) => [job, 'skipped']));
  const judge = (needs: string, event: string | undefined) =>
    aggregate(needs, PLANNED, { event, plan: PLAN, skippedOnPullRequest: [SKIPPABLE] });
  const codes = (needs: string, event: string | undefined): string[][] =>
    judge(needs, event).problems.map((problem) => [problem.code, problem.job ?? '']);

  // Break caught: the night that finds nothing changed turning red (every job skipped is a failure of "CI result" by the ordinary rule), or the
  // plan's word allowing the skip anywhere else.
  it('accepts the nightly run in which a plan that succeeded said run=false and every other job was skipped', () => {
    const { problems, verdicts } = judge(planned('false', allSkipped), 'schedule');
    assert.deepEqual(problems, []);
    assert.deepEqual(verdicts[0], { job: PLAN, result: 'success' });
    assert.deepEqual(
      verdicts.slice(1),
      OTHERS.map((job) => ({ job, result: 'skipped', allowed: true, skippedBy: 'plan' })),
    );
  });

  it('says in the report that it was the plan that allowed the skips', () => {
    const report = renderReport(judge(planned('false', allSkipped), 'schedule'));
    assert.match(
      report,
      /unit\s+skipped \(allowed: the plan found nothing changed since the last successful nightly run\)/,
    );
    assert.match(report, /CI result: passed/);
  });

  // Break caught: a push, a pull request or a manual run standing down on the plan's word, so that a commit is left with a green check and no test.
  for (const event of EVENTS.filter((name) => name !== 'schedule')) {
    it(`refuses run=false on ${event}: only the nightly run may stand down, and the skipped jobs are failures there`, () => {
      const problems = codes(planned('false', allSkipped), event);
      assert.deepEqual(problems[0], ['PLAN_SKIP_NOT_ALLOWED', PLAN]);
      for (const job of OTHERS) {
        const expected = event === 'pull_request' && job === SKIPPABLE;
        assert.equal(
          problems.some(([code, name]) => code === 'JOB_NOT_SUCCESSFUL' && name === job),
          !expected,
          `${event}: ${job}`,
        );
      }
    });
  }

  // Break caught: the skip allowed when the plan said to run, so that a night in which a job was skipped for another reason passes.
  it('allows no skip on the nightly run when the plan said run=true', () => {
    assert.deepEqual(codes(planned('true', { unit: 'skipped' }), 'schedule'), [
      ['JOB_NOT_SUCCESSFUL', 'unit'],
    ]);
    assert.deepEqual(codes(planned('true'), 'schedule'), []);
  });

  // Break caught: the plan's allowance covering a job that failed or was cancelled beside the skipped ones.
  for (const result of ['failure', 'cancelled']) {
    it(`still fails a job that is ${result} when the plan said run=false`, () => {
      const needs = planned('false', { ...allSkipped, unit: result });
      assert.deepEqual(codes(needs, 'schedule'), [['JOB_NOT_SUCCESSFUL', 'unit']]);
    });
  }

  // Break caught: a plan that did not succeed (failed, cancelled, skipped) still lending its answer to the skips.
  for (const result of ['failure', 'cancelled', 'skipped']) {
    it(`allows no skip when the plan itself is ${result}, whatever it output`, () => {
      const problems = codes(planned('false', { ...allSkipped, [PLAN]: result }), 'schedule');
      assert.deepEqual(problems[0], ['JOB_NOT_SUCCESSFUL', PLAN]);
      assert.equal(problems.length, PLANNED.length, 'the plan and every skipped job are reported');
    });
  }

  // Break caught: an answer read loosely (a case fold, a number, a missing output) as "run" or as "stand down".
  for (const run of ['maybe', 'False', 'TRUE', '0', '', ' false', undefined]) {
    it(`cannot read the plan's answer ${JSON.stringify(run)}, and fails the run`, () => {
      const problems = codes(planned(run, allSkipped), 'schedule');
      assert.deepEqual(problems[0], ['PLAN_UNREADABLE', PLAN]);
      assert.ok(problems.some(([code, job]) => code === 'JOB_NOT_SUCCESSFUL' && job === 'unit'));
    });
  }

  it('fails when the plan is not in the needs, and when it is named but not among the mandatory jobs', () => {
    const without = JSON.parse(planned('true')) as Record<string, unknown>;
    Reflect.deleteProperty(without, PLAN);
    assert.deepEqual(codes(JSON.stringify(without), 'schedule'), [['JOB_MISSING', PLAN]]);
    const named = aggregate(planned('true'), OTHERS, { event: 'schedule', plan: PLAN });
    assert.deepEqual(
      named.problems.map((problem) => [problem.code, problem.job]),
      [
        ['PLAN_UNKNOWN', PLAN],
        ['JOB_UNEXPECTED', PLAN],
      ],
    );
  });

  it('needs the event as soon as a plan is named, and allows no skip without it', () => {
    for (const event of [undefined, '', '  ']) {
      const problems = codes(planned('false', allSkipped), event).map(([code]) => code);
      assert.equal(problems[0], 'EVENT_UNREADABLE', String(event));
      assert.ok(problems.includes('JOB_NOT_SUCCESSFUL'), String(event));
    }
  });

  it('passes a pull request that ran, with the plan, and skipped only the job it is allowed to', () => {
    assert.deepEqual(codes(planned('true', { [SKIPPABLE]: 'skipped' }), 'pull_request'), []);
  });

  it('does not change a run that names no plan', () => {
    const { problems } = aggregate(planned('false', allSkipped), PLANNED, { event: 'schedule' });
    assert.equal(
      problems.length,
      OTHERS.length,
      'each skipped job is reported, as before the plan existed',
    );
  });

  it('is the verdict of the command: 0 for the night that stood down, 1 for a push that said so', () => {
    const lines: string[] = [];
    const print = (line: string): void => void lines.push(line);
    const args = [`--plan=${PLAN}`, `--skipped-on-pull-request=${SKIPPABLE}`, ...PLANNED];
    assert.equal(
      runAggregate(args, { NEEDS: planned('false', allSkipped), EVENT: 'schedule' }, print),
      0,
    );
    assert.equal(
      runAggregate(args, { NEEDS: planned('false', allSkipped), EVENT: 'push' }, print),
      1,
    );
    assert.match(
      lines.join('\n'),
      /::error title=CI result::The plan "plan" says nothing is to run/,
    );
  });
});

describe('the command, with the event and the allowance', () => {
  const SKIPPABLE = 'browser-firefox-webkit';
  const NAMES = ['static', 'browser-chromium', SKIPPABLE];
  const needs = (skipped: string): string =>
    needsOf({ static: 'success', 'browser-chromium': 'success', [SKIPPABLE]: skipped });
  const lines: string[] = [];
  const output = (line: string): void => void lines.push(line);
  const OPTION = `--skipped-on-pull-request=${SKIPPABLE}`;

  it('passes a pull request that skipped the allowed job, and says so', () => {
    lines.length = 0;
    assert.equal(
      runAggregate([OPTION, ...NAMES], { NEEDS: needs('skipped'), EVENT: 'pull_request' }, output),
      0,
    );
    assert.match(lines.join('\n'), /skipped \(allowed: a pull request does not run it\)/);
    assert.ok(!lines.join('\n').includes('::error'));
  });

  for (const event of ['push', 'schedule', 'workflow_dispatch']) {
    it(`fails a ${event} run that skipped the job, and annotates it`, () => {
      lines.length = 0;
      assert.equal(
        runAggregate([OPTION, ...NAMES], { NEEDS: needs('skipped'), EVENT: event }, output),
        1,
      );
      assert.match(lines.join('\n'), /::error title=CI result::.*browser-firefox-webkit.*skipped/);
    });
  }

  it('fails without the event, and fails an argument it does not read', () => {
    lines.length = 0;
    assert.equal(runAggregate([OPTION, ...NAMES], { NEEDS: needs('success') }, output), 1);
    assert.match(lines.join('\n'), /::error title=CI result::The event of the run is missing/);
    lines.length = 0;
    assert.equal(
      runAggregate(
        ['--skipped-on-pull-request=', ...NAMES],
        { NEEDS: needs('success'), EVENT: 'push' },
        output,
      ),
      1,
    );
    assert.match(
      lines.join('\n'),
      /::error title=CI result::The argument --skipped-on-pull-request= is not one/,
    );
  });

  // The command GitHub runs, started as a real process: the exit status is what turns the check red.
  it('exits 0 for a pull request that skipped the job and 1 for a push that did', () => {
    const script = resolve(import.meta.dirname, 'ci-aggregate.ts');
    const start = (skipped: string, event: string | undefined) => {
      const env: NodeJS.ProcessEnv = { ...process.env, NEEDS: needs(skipped) };
      delete env.EVENT;
      if (event !== undefined) env.EVENT = event;
      return spawnSync(process.execPath, [script, OPTION, ...NAMES], { env, encoding: 'utf8' });
    };
    const onPullRequest = start('skipped', 'pull_request');
    assert.equal(onPullRequest.status, 0, onPullRequest.stdout + onPullRequest.stderr);
    assert.match(onPullRequest.stdout, /CI result: passed/);
    assert.equal(start('skipped', 'push').status, 1);
    assert.equal(start('skipped', undefined).status, 1);
    assert.equal(start('failure', 'pull_request').status, 1);
    assert.equal(start('cancelled', 'pull_request').status, 1);
    assert.equal(start('success', 'push').status, 0);
  });
});
