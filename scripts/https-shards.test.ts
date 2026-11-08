import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { HTTPS_SHARDS } from '../e2e/harness/https-shards.ts';
import { httpsJobsOf, type HttpsShardEntry } from './ci-workflow.ts';

/**
 * The journeys over the trusted HTTPS origin run as the matrix of a job, a shard of the run in each job (the Product Owner's decision of
 * 7 November 2026): which runs a shard makes, and the browsers they need, are the harness's (`e2e/harness/https-shards.ts`); the workflow's
 * matrix must list exactly those shards, each with those browsers installed. This holds the two together, from the text of the workflow and
 * the table of the harness, since the run itself can be made only in CI (it makes a CA and puts it in a system store). The rules on the
 * matrix as a workflow (`httpsMatrix`, scripts/ci-workflow.ts) are held by scripts/ci-workflow.test.ts; the harness's own behaviour by
 * e2e/harness/https-run.test.ts and https-shards.test.ts.
 */

/** What is wrong with the entries of the workflow's matrix as the list of the harness's shards; empty means they are exactly that. */
function httpsShardProblems(
  entries: readonly HttpsShardEntry[],
  shards: readonly { readonly browsers: readonly string[] }[],
): string[] {
  const problems: string[] = [];
  if (entries.length !== shards.length) {
    problems.push(
      `the matrix lists ${String(entries.length)} shards and the harness has ${String(shards.length)}`,
    );
  }
  for (const [index, shard] of shards.entries()) {
    const label = `shard ${String(index + 1)} of ${String(shards.length)}`;
    const entry = entries.find((candidate) => candidate.shard === index + 1);
    if (entry === undefined) {
      problems.push(`no entry makes ${label}, so the runs it holds are made by no job`);
      continue;
    }
    if (entry.shards !== shards.length) {
      problems.push(
        `the entry of ${label} says ${String(entry.shards)} shards, and the harness has ${String(shards.length)}`,
      );
    }
    if (entry.browsers.toSorted().join(' ') !== shard.browsers.toSorted().join(' ')) {
      problems.push(
        `${label} installs ${entry.browsers.join(' ')} and its runs need ${shard.browsers.join(' ')}`,
      );
    }
  }
  return problems;
}

const entry = (shard: number, shards: number, browsers: string): HttpsShardEntry => ({
  shard,
  shards,
  browsers: browsers.split(' '),
});

describe('the workflow’s HTTPS matrix, held to the shards of the harness, on a double of the workflow', () => {
  const GOOD = HTTPS_SHARDS.map((shard, index) =>
    entry(index + 1, HTTPS_SHARDS.length, shard.browsers.join(' ')),
  );

  it('finds nothing wrong with a matrix that lists the shards of the harness, with their browsers', () => {
    assert.deepEqual(httpsShardProblems(GOOD, HTTPS_SHARDS), []);
    assert.deepEqual(
      httpsShardProblems(
        GOOD.map((each) => ({ ...each, browsers: each.browsers.toReversed() })),
        HTTPS_SHARDS,
      ),
      [],
      'the order of the browsers is not a difference',
    );
  });

  // Break caught: a shard taken out of the matrix, so that the runs it holds are made by no job, while every other job is as green as before.
  it('reports a shard taken out of the matrix, and one added to it', () => {
    assert.deepEqual(httpsShardProblems(GOOD.slice(1), HTTPS_SHARDS), [
      'the matrix lists 1 shards and the harness has 2',
      'no entry makes shard 1 of 2, so the runs it holds are made by no job',
    ]);
    assert.ok(
      httpsShardProblems(GOOD.slice(0, 1), HTTPS_SHARDS).includes(
        'no entry makes shard 2 of 2, so the runs it holds are made by no job',
      ),
    );
    assert.deepEqual(httpsShardProblems([...GOOD, entry(3, 3, 'webkit')], HTTPS_SHARDS), [
      'the matrix lists 3 shards and the harness has 2',
    ]);
  });

  // Break caught: a shard that installs other browsers than its runs need: a missing one fails the job in CI, and the harness refuses a
  // total that is not its own.
  it('reports browsers that are not the ones a shard’s runs need, and a total that is not the harness’s', () => {
    assert.deepEqual(
      httpsShardProblems(
        [entry(1, 2, 'chromium'), GOOD[1] ?? entry(2, 2, 'firefox')],
        HTTPS_SHARDS,
      ),
      ['shard 1 of 2 installs chromium and its runs need chromium webkit'],
    );
    assert.deepEqual(
      httpsShardProblems(
        [GOOD[0] ?? entry(1, 2, ''), entry(2, 2, 'chromium firefox webkit')],
        HTTPS_SHARDS,
      ),
      ['shard 2 of 2 installs chromium firefox webkit and its runs need firefox'],
    );
    assert.deepEqual(
      httpsShardProblems([entry(1, 3, 'chromium webkit'), entry(2, 3, 'firefox')], HTTPS_SHARDS),
      [
        'the entry of shard 1 of 2 says 3 shards, and the harness has 2',
        'the entry of shard 2 of 2 says 3 shards, and the harness has 2',
      ],
    );
  });
});

describe('this repository: the workflow’s HTTPS matrix lists the shards of the harness', () => {
  const root = resolve(import.meta.dirname, '..');
  const workflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');
  const jobs = httpsJobsOf(workflow);

  it('has one job that runs the HTTPS journeys, a matrix without a fault', () => {
    assert.equal(jobs.length, 1, jobs.map((job) => job.id).join(', '));
    assert.deepEqual(jobs[0]?.faults, []);
  });

  it('lists exactly the shards of the harness, each with the browsers its runs need', () => {
    assert.deepEqual(httpsShardProblems(jobs[0]?.entries ?? [], HTTPS_SHARDS), []);
  });

  // The failures to show, on the real workflow changed by one line: a shard out of the matrix, and a shard that installs the wrong browser.
  it('fails when a shard is taken out of the workflow’s matrix', (context) => {
    const line = "          - { shard: 2, shards: 2, browsers: 'firefox' }\n";
    assert.ok(workflow.includes(line));
    const [job] = httpsJobsOf(workflow.replace(line, ''));
    assert.ok(job !== undefined);
    const problems = [...job.faults, ...httpsShardProblems(job.entries, HTTPS_SHARDS)];
    assert.deepEqual(problems, [
      'the HTTPS run has no entry for shard 2 of 2, so the tests of that shard are never run',
      'the matrix lists 1 shards and the harness has 2',
      'no entry makes shard 2 of 2, so the runs it holds are made by no job',
    ]);
    context.diagnostic(problems.join(' | '));
  });

  it('fails when a shard installs other browsers than its runs need', (context) => {
    const line = "browsers: 'firefox' }";
    assert.ok(workflow.includes(line));
    const [job] = httpsJobsOf(workflow.replace(line, "browsers: 'chromium' }"));
    assert.ok(job !== undefined);
    const problems = [...job.faults, ...httpsShardProblems(job.entries, HTTPS_SHARDS)];
    assert.deepEqual(problems, ['shard 2 of 2 installs chromium and its runs need firefox']);
    context.diagnostic(problems.join(' | '));
  });
});
