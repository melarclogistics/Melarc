import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import {
  aggregate,
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
