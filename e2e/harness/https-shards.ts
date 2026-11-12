/**
 * The shards of the run over the trusted HTTPS origin (`pnpm run test:e2e:https`, `https-run.ts`): which of its runs (its phases) one job
 * of CI makes. The run is long (four runs, one stack each, and the 15 staff journeys in every engine), so CI makes it as the jobs of a
 * matrix, each handed its shard in `MELARC_HTTPS_SHARD` as `current/total` counted from 1, as the browser tests are handed theirs in
 * `MELARC_BROWSER_SHARD` (the Product Owner's decision of 7 November 2026). Without the variable the whole run is made, which is what a
 * machine cleared for key material does.
 *
 * **A run is the finest piece.** Its journeys are one story that begins from the two bootstrap administrators, whose one-time bundles the
 * first reading consumes (audit G01 of 26 October 2026), so a run is never cut. And **WebKit's refusal and WebKit's other proofs are in one
 * shard, in that order**: the refusal is a control only while the CA is not in the system store, and the proofs need it there, so "refused
 * before, trusted after" is made on one machine (the owner's decision of 12 October 2026). The refusal is a run of its own, in front of WebKit's
 * proofs (task CI.2, 7 November 2026), so the third shard holds both, in that order, and the first holds Chromium's run and the second Firefox's:
 * of runs of about 8 minutes (Chromium), 9 to 10 (Firefox), 1 to 2 (WebKit's refusal) and 10 (WebKit's proofs), plus 3 to 3.5 of set-up in each job,
 * no job is estimated above 20 minutes (it was 21 of 30 with two shards). (`https-run.test.ts` holds both rules to the phases.)
 *
 * This file holds data and the reading of one value, and imports nothing, so that the CI rules (`scripts/https-shards.test.ts`) can read it:
 * the workflow's matrix must list exactly these shards, each with the browsers its runs need installed.
 */

export interface HttpsShard {
  /** Said in the log. */
  readonly name: string;
  /** The runs of the shard, by `HttpsPhase.id`: they are made in the order of the phases, whatever the order here. */
  readonly phases: readonly string[];
  /** The browsers those runs need, by the name of Playwright's engine: what the job installs. */
  readonly browsers: readonly string[];
}

export const HTTPS_SHARDS: readonly HttpsShard[] = [
  {
    name: 'Chromium',
    phases: ['chromium'],
    browsers: ['chromium'],
  },
  {
    name: 'Firefox',
    phases: ['firefox'],
    browsers: ['firefox'],
  },
  {
    name: 'WebKit, its refusal first and then its proofs with the CA in the system store',
    phases: ['webkit-refusal', 'webkit'],
    browsers: ['webkit'],
  },
];

/** The variable that carries a job's shard. */
export const HTTPS_SHARD_VARIABLE = 'MELARC_HTTPS_SHARD';

/** What the variable says: the whole run, one shard of it, or a value that is not a shard of this harness. */
export type ShardChoice =
  | { readonly kind: 'whole' }
  | {
      readonly kind: 'shard';
      readonly current: number;
      readonly total: number;
      readonly shard: HttpsShard;
    }
  | { readonly kind: 'refused'; readonly why: string };

/**
 * Reads the value of `MELARC_HTTPS_SHARD`. Unset or blank is the whole run; anything else must be `current/total` counted from 1 with
 * the total the number of shards this harness has, or it is refused: a value that is not a shard is never read as "no shard", for a typo
 * in the workflow would then run the whole in every job and the job would no longer fit its limit.
 */
export function chooseHttpsShard(value: string | undefined): ShardChoice {
  if (value === undefined || value.trim() === '') return { kind: 'whole' };
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(value.trim());
  const current = Number(match?.[1]);
  const total = Number(match?.[2]);
  if (match === null || current > total) {
    return {
      kind: 'refused',
      why: `${HTTPS_SHARD_VARIABLE} is "${value}", which is not a shard. Use current/total counted from 1, for example 1/${String(HTTPS_SHARDS.length)}.`,
    };
  }
  const shard = HTTPS_SHARDS[current - 1];
  if (total !== HTTPS_SHARDS.length || shard === undefined) {
    return {
      kind: 'refused',
      why: `${HTTPS_SHARD_VARIABLE} is "${value}", but this harness cuts the run into ${String(HTTPS_SHARDS.length)} shards (e2e/harness/https-shards.ts): the workflow and the harness disagree.`,
    };
  }
  return { kind: 'shard', current, total, shard };
}
