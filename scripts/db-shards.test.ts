import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';

import { TIMING_SENSITIVE_TESTS } from '../apps/api/test/timing-sensitive-tests.ts';
import { databaseJobsOf } from './ci-workflow.ts';

const run = promisify(execFile);

/**
 * The database tests run as the jobs of a matrix, a shard of the files in each (task CI.2), because the whole suite is longer than a job may
 * last: the job `i` of `N` sets `MELARC_DB_SHARD=i/N`, `apps/api/vitest.config.ts` hands it to Vitest's own `shard`, and Vitest keeps the files whose
 * place in its order falls in the shard. The matrix is held to a literal list of shards 1 to N by scripts/ci-workflow.ts; this holds what the
 * shards then run: from Vitest's own list of the files of the two database projects, cut by Vitest's own sequencer for the shard that the
 * configuration resolves from the variable (`apps/api/test/database-shard-files.ts`: it runs no test and needs no database; `vitest list` cannot
 * be used, it ignores the shard), the shards together hold every file of the two projects, once, whether or not the run leaves the timing tests
 * out, and the files are the files of the two folders, so that a file nobody lists is a file nobody runs.
 */

/** What is wrong with the shards as the parts of the whole list of files: a file in no shard, in two, or one that the whole does not have. */
function shardProblems(whole: readonly string[], parts: readonly (readonly string[])[]): string[] {
  const problems: string[] = [];
  const held = new Map<string, number[]>();
  parts.forEach((part, index) => {
    for (const file of part) held.set(file, [...(held.get(file) ?? []), index + 1]);
  });
  for (const file of whole) {
    const shards = held.get(file) ?? [];
    if (shards.length === 0) problems.push(`${file} is in no shard, so no job runs it`);
    else if (shards.length > 1) {
      problems.push(`${file} is in shards ${shards.join(' and ')}, so two jobs run it`);
    }
  }
  for (const file of held.keys()) {
    if (!whole.includes(file)) problems.push(`${file} is in a shard and not in the whole list`);
  }
  for (const [index, part] of parts.entries()) {
    if (part.length === 0) problems.push(`shard ${String(index + 1)} holds no file`);
  }
  return problems;
}

describe('shardProblems, on doubles', () => {
  const WHOLE = ['a', 'b', 'c', 'd'];

  it('finds nothing wrong with shards that hold every file once', () => {
    assert.deepEqual(
      shardProblems(WHOLE, [
        ['a', 'c'],
        ['b', 'd'],
      ]),
      [],
    );
    assert.deepEqual(shardProblems(WHOLE, [['d'], ['b', 'a', 'c']]), []);
  });

  // Break caught: a shard dropped from the matrix (its files run by no job), a file in two shards (run twice), a file that the whole does not
  // have, and a shard that holds nothing (a job that passes having run no test).
  it('reports a file in no shard, in two, a stranger, and an empty shard', () => {
    assert.deepEqual(shardProblems(WHOLE, [['a', 'c']]), [
      'b is in no shard, so no job runs it',
      'd is in no shard, so no job runs it',
    ]);
    assert.deepEqual(
      shardProblems(WHOLE, [
        ['a', 'b', 'c'],
        ['c', 'd'],
      ]),
      ['c is in shards 1 and 2, so two jobs run it'],
    );
    assert.deepEqual(shardProblems(['a'], [['a'], ['z']]), [
      'z is in a shard and not in the whole list',
    ]);
    assert.deepEqual(shardProblems(WHOLE, [['a', 'b', 'c', 'd'], []]), ['shard 2 holds no file']);
  });
});

describe('this repository: the shards of the database tests', () => {
  const root = resolve(import.meta.dirname, '..');
  const api = resolve(root, 'apps/api');
  const workflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');
  const [job, ...others] = databaseJobsOf(workflow);

  /**
   * The shard Vitest resolves from the configuration and the files it keeps for it, from `apps/api/test/database-shard-files.ts` (Vitest's own
   * list of the files of the two database projects, cut by Vitest's own sequencer; no test runs and no database is needed). The environment is
   * the one given, with no shard and no switch unless it gives them.
   */
  async function list(
    environment: Record<string, string>,
  ): Promise<{ shard: { index: number; count: number } | null; files: string[] }> {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const name of ['MELARC_DB_SHARD', 'MELARC_SKIP_TIMING_TESTS', 'VITEST_MAX_WORKERS']) {
      Reflect.deleteProperty(env, name);
    }
    const { stdout } = await run(process.execPath, ['test/database-shard-files.ts'], {
      cwd: api,
      env: { ...env, ...environment },
      maxBuffer: 16 * 1024 * 1024,
    });
    const line = stdout.trim().split(/\r?\n/).at(-1) ?? '';
    return JSON.parse(line) as { shard: { index: number; count: number } | null; files: string[] };
  }

  /** The test files of the two folders, as the filesystem has them. */
  const onDisk = (): string[] =>
    ['test/database', 'test/database/alone']
      .flatMap((folder) =>
        readdirSync(resolve(api, folder))
          .filter((name) => name.endsWith('.test.ts'))
          .map((name) => `${folder}/${name}`),
      )
      .toSorted();

  it('has one job that runs the database tests, a matrix without a fault', () => {
    assert.ok(job !== undefined, 'a job runs pnpm run test:db');
    assert.equal(others.length, 0, others.map((other) => other.id).join(', '));
    assert.deepEqual(job.faults, []);
    assert.ok(job.entries.length >= 2, 'the suite is longer than a job may last: it is in shards');
  });

  const KINDS: readonly (readonly [string, Record<string, string>, readonly string[]])[] = [
    ['a push to main, the nightly run, a manual run and the gate', {}, []],
    [
      'a pull request, which leaves the timing tests out',
      { MELARC_SKIP_TIMING_TESTS: '1' },
      TIMING_SENSITIVE_TESTS,
    ],
  ];
  for (const [label, environment, left] of KINDS) {
    it(`holds every database test file in one shard and one only, for ${label}`, async () => {
      assert.ok(job !== undefined);
      const total = job.entries[0]?.shards ?? 0;
      const whole = await list(environment);
      // No shard asked for: the configuration has none, and every file of the two folders (less the ones this kind of run leaves out) is listed.
      // The listing is not read from the same place as the shards: the folders are read from the filesystem.
      assert.equal(whole.shard, null);
      assert.deepEqual(
        whole.files,
        onDisk().filter((file) => !left.includes(file)),
      );
      const parts = await Promise.all(
        Array.from({ length: total }, (_, index) =>
          list({ ...environment, MELARC_DB_SHARD: `${String(index + 1)}/${String(total)}` }),
        ),
      );
      // The variable reaches Vitest's configuration as the shard the job asks for (the wiring of vitest.config.ts), and the files kept are the
      // shard's: every file once.
      parts.forEach((part, index) => {
        assert.deepEqual(part.shard, { index: index + 1, count: total });
      });
      assert.deepEqual(
        shardProblems(
          whole.files,
          parts.map((part) => part.files),
        ),
        [],
      );
      assert.equal(parts.flatMap((part) => part.files).length, whole.files.length);
    });
  }
});
