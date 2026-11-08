import { describe, expect, it } from 'vitest';

import { HTTPS_SHARDS, HTTPS_SHARD_VARIABLE, chooseHttpsShard } from './https-shards.ts';

/**
 * The reading of `MELARC_HTTPS_SHARD` (the Product Owner's decision of 7 November 2026): the whole run without it, one shard with it, and
 * a refusal, never "the whole run", for a value that is not a shard of this harness. `https-run.test.ts` holds what the run does with each
 * shard; the CI rules (`scripts/https-shards.test.ts`) hold the workflow's matrix to the table.
 */
describe('the variable that carries the shard', () => {
  it('is called MELARC_HTTPS_SHARD, as the browser tests’ is MELARC_BROWSER_SHARD', () => {
    expect(HTTPS_SHARD_VARIABLE).toBe('MELARC_HTTPS_SHARD');
  });

  // Break caught: an unset or blank value read as a shard, which would make a developer's whole run a part of it.
  it.each([undefined, '', ' ', '\t'])('reads %j as the whole run', (value) => {
    expect(chooseHttpsShard(value)).toEqual({ kind: 'whole' });
  });

  it('reads each shard of the table, spaces around it allowed', () => {
    for (const [index, shard] of HTTPS_SHARDS.entries()) {
      const value = `${String(index + 1)}/${String(HTTPS_SHARDS.length)}`;
      const expected = {
        kind: 'shard',
        current: index + 1,
        total: HTTPS_SHARDS.length,
        shard,
      };
      expect(chooseHttpsShard(value)).toEqual(expected);
      expect(chooseHttpsShard(` ${value}\n`)).toEqual(expected);
    }
  });

  // Break caught: a malformed value accepted as some shard, or as none: each is refused and says what to use.
  it.each([
    '0/2',
    '3/2',
    '2',
    'a/b',
    '1/0',
    '1/2/3',
    '-1/2',
    '1.5/2',
    '01/2',
    '1/',
    '/2',
    '1 / 2',
    '1/2x',
  ])('refuses %j as not a shard', (value) => {
    const choice = chooseHttpsShard(value);
    expect(choice.kind).toBe('refused');
    expect('why' in choice ? choice.why : '').toMatch(
      /^MELARC_HTTPS_SHARD is ".*", which is not a shard\. Use current\/total counted from 1, for example 1\/2\.$/,
    );
  });

  // Break caught: a total that is not the shards this harness has, so that a workflow with another number of jobs leaves a run to no job
  // or makes a job that makes nothing: refused, and the harness's number said.
  it.each(['1/1', '1/3', '2/3', '3/3', '1/20'])(
    'refuses %j as not the shards of this harness',
    (value) => {
      const choice = chooseHttpsShard(value);
      expect(choice.kind).toBe('refused');
      expect('why' in choice ? choice.why : '').toMatch(
        /but this harness cuts the run into 2 shards \(e2e\/harness\/https-shards\.ts\): the workflow and the harness disagree\.$/,
      );
    },
  );
});
