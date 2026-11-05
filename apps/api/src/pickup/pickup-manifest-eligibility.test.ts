import { describe, expect, it } from 'vitest';

import {
  assessRequests,
  dateViolationsOf,
  type RequestFacts,
} from './pickup-manifest-eligibility.js';

const HUB = '5eed0100-0000-4000-8000-000000000001';
const OTHER_HUB = '5eed0100-0000-4000-8000-000000000002';
/** Today on the hub's clock, a Tuesday; and the manifest's day, the Wednesday after. */
const TODAY = '2026-11-03';
const DAY = '2026-11-04';

const ids = (count: number): string[] =>
  Array.from({ length: count }, (_, at) => `5eed0200-0000-4000-8000-00000000000${String(at + 1)}`);

const facts = (id: string, overrides: Partial<RequestFacts> = {}): RequestFacts => ({
  id,
  state: 'CONFIRMED',
  responsible_hub_id: HUB,
  scheduled_service_date: DAY,
  cutoff_exception_state: null,
  ...overrides,
});

const seen = (...rows: RequestFacts[]): ReadonlyMap<string, RequestFacts> =>
  new Map(rows.map((row) => [row.id.toLowerCase(), row] as const));

const rulesOf = (assessment: ReturnType<typeof assessRequests>): [string, string][] =>
  assessment.violations.map((each) => [each.pointer, each.rule]);

const assess = (
  requestIds: readonly string[],
  found: ReadonlyMap<string, RequestFacts>,
  serviceDate: string = DAY,
) => assessRequests({ ids: requestIds, serviceDate, today: TODAY, found });

describe('the day of a manifest', () => {
  // Break caught: a manifest built for a Sunday (Monday to Saturday only, MSC-DEC-149).
  it('is refused on a Sunday and accepted on every other day that has not passed', () => {
    expect(dateViolationsOf('2026-11-08', TODAY)).toEqual([
      { in: 'body', pointer: '/service_date', rule: 'operating_day' },
    ]);
    for (const day of [
      '2026-11-03',
      '2026-11-04',
      '2026-11-05',
      '2026-11-06',
      '2026-11-07',
      '2026-11-09',
    ]) {
      expect(dateViolationsOf(day, TODAY), day).toEqual([]);
    }
  });

  // Break caught: a manifest planned for a day that has gone (the Product Owner, 1 November 2026, on the reviewer's recommendation: a manifest is the plan of a run, so its day
  // is the day the run is worked, and that day is not behind the hub's clock).
  it('is refused when it has passed on the hub’s clock, and accepted today and after', () => {
    expect(dateViolationsOf('2026-11-02', TODAY)).toEqual([
      { in: 'body', pointer: '/service_date', rule: 'past_day' },
    ]);
    expect(dateViolationsOf('2026-10-31', TODAY)).toEqual([
      { in: 'body', pointer: '/service_date', rule: 'past_day' },
    ]);
    expect(dateViolationsOf(TODAY, TODAY)).toEqual([]);
    expect(dateViolationsOf(DAY, TODAY)).toEqual([]);
  });

  // Break caught: a Sunday that has passed reported as one fault only, so that mending the first leaves the second to be found later.
  it('reports a Sunday that has passed as both faults, the Sunday first', () => {
    expect(dateViolationsOf('2026-11-01', TODAY)).toEqual([
      { in: 'body', pointer: '/service_date', rule: 'operating_day' },
      { in: 'body', pointer: '/service_date', rule: 'past_day' },
    ]);
  });

  // Break caught: a day that does not exist read as some other day, or an error that escapes as a server failure.
  it.each(['2026-02-30', '2026-13-01', 'tomorrow', ''])('refuses %j as a date', (day) => {
    expect(dateViolationsOf(day, TODAY)).toEqual([
      { in: 'body', pointer: '/service_date', rule: 'format' },
    ]);
  });
});

describe('which requests a manifest may be built from', () => {
  const [a, b, c] = ids(3) as [string, string, string];

  it('accepts confirmed requests of one hub, promised for the manifest’s day, and names the hub', () => {
    const assessment = assess([a, b], seen(facts(a), facts(b)));
    expect(assessment.violations).toEqual([]);
    expect(assessment.hubId).toBe(HUB);
    expect(assessment.carriedOver).toEqual([]);
  });

  // Break caught: a request the caller was not shown judged by what it is (claimed, cancelled, in another hub), which would tell the
  // caller that it exists. An id that is not among the rows seen is one answer, whatever it is.
  it('answers an id it was not shown with one rule, whatever that request is', () => {
    const assessment = assess([a, b, c], seen(facts(a)));
    expect(rulesOf(assessment)).toEqual([
      [`/pickup_request_ids/1`, 'not_available'],
      [`/pickup_request_ids/2`, 'not_available'],
    ]);
    expect(assessment.hubId).toBeUndefined();
  });

  // Break caught: a manifest that spans two hubs because the caller's grant reaches both.
  it('refuses a request of another hub than the first, wherever it stands in the list', () => {
    const assessment = assess(
      [a, b, c],
      seen(facts(a), facts(b, { responsible_hub_id: OTHER_HUB }), facts(c)),
    );
    expect(rulesOf(assessment)).toEqual([[`/pickup_request_ids/1`, 'hub_mismatch']]);
  });

  // Break caught: a request that is not confirmed (pending, declined, cancelled) built into a run.
  it.each(['PENDING', 'DECLINED', 'CANCELLED'])('refuses a %s request', (state) => {
    const assessment = assess([a], seen(facts(a, { state })));
    expect(rulesOf(assessment)).toEqual([[`/pickup_request_ids/0`, 'not_confirmed']]);
  });

  // Break caught: a late booking claimed before Ops decides it (the owner's decision of 29 to 30 October 2026).
  it('refuses a confirmed request that is awaiting the review of its cutoff', () => {
    const assessment = assess(
      [a],
      seen(facts(a, { cutoff_exception_state: 'PENDING_OPS_REVIEW' })),
    );
    expect(rulesOf(assessment)).toEqual([[`/pickup_request_ids/0`, 'awaiting_cutoff_review']]);
  });

  // Break caught: a request decided by the review (approved the same day, or rescheduled) shut out with the one still awaiting it.
  it.each(['SAME_DAY_APPROVED', 'RESCHEDULED'])(
    'accepts a request whose review ended as %s',
    (decision) => {
      const assessment = assess([a], seen(facts(a, { cutoff_exception_state: decision })));
      expect(assessment.violations).toEqual([]);
    },
  );

  // Break caught: a request promised for an earlier day refused, which would force a cancellation and a rebooking (a new promise) as the
  // answer to Melarc's own delay (the Product Owner, 1 November 2026).
  it('carries over a request promised for an earlier day, and says which', () => {
    const assessment = assess(
      [a, b, c],
      seen(
        facts(a, { scheduled_service_date: '2026-11-02' }),
        facts(b),
        facts(c, { scheduled_service_date: '2026-10-30' }),
      ),
    );
    expect(assessment.violations).toEqual([]);
    expect(assessment.carriedOver).toEqual([a, c]);
    expect(assessment.hubId).toBe(HUB);
  });

  // Break caught: a manifest that collects ahead of the promise (the vendor was told a later day), or one that rewrites it.
  it('refuses a request promised for a later day than the manifest’s', () => {
    const assessment = assess(
      [a, b],
      seen(facts(a), facts(b, { scheduled_service_date: '2026-11-05' })),
    );
    expect(rulesOf(assessment)).toEqual([[`/pickup_request_ids/1`, 'before_scheduled_day']]);
    expect(assessment.carriedOver).toEqual([]);
  });

  // Break caught: a carry-over reported for a manifest that is refused, which would tell a caller about work that was not done.
  it('reports no carry-over where anything is refused', () => {
    const assessment = assess(
      [a, b],
      seen(facts(a, { scheduled_service_date: '2026-11-02' }), facts(b, { state: 'PENDING' })),
    );
    expect(rulesOf(assessment)).toEqual([[`/pickup_request_ids/1`, 'not_confirmed']]);
    expect(assessment.carriedOver).toEqual([]);
  });

  // Break caught: the same request twice, which would make one claim two stops (or an error from the database's index).
  it('refuses a request named twice at its second place, in either spelling of the id', () => {
    const assessment = assess([a, a.toUpperCase()], seen(facts(a)));
    expect(rulesOf(assessment)).toEqual([[`/pickup_request_ids/1`, 'duplicate']]);
  });

  // Break caught: a refusal that stops at the first fault, so that Ops mends the list one fault at a time.
  it('reports every fault together, the day first, then the places in the order they were named', () => {
    const assessment = assess(
      [a, b, c],
      seen(facts(a, { state: 'PENDING' }), facts(b, { scheduled_service_date: '2026-11-09' })),
      '2026-11-08',
    );
    expect(rulesOf(assessment)).toEqual([
      ['/service_date', 'operating_day'],
      ['/pickup_request_ids/0', 'not_confirmed'],
      ['/pickup_request_ids/1', 'before_scheduled_day'],
      ['/pickup_request_ids/2', 'not_available'],
    ]);
  });

  // Break caught: the first rule an id breaks not being the one stated first, so that the answer for a request that breaks several
  // depends on which test happened to run first.
  it('names one rule for a request that breaks several: the earliest in the order of the rules', () => {
    const assessment = assess(
      [a, b],
      seen(
        facts(a),
        facts(b, {
          responsible_hub_id: OTHER_HUB,
          state: 'CANCELLED',
          cutoff_exception_state: 'PENDING_OPS_REVIEW',
          scheduled_service_date: '2026-11-06',
        }),
      ),
    );
    expect(rulesOf(assessment)).toEqual([['/pickup_request_ids/1', 'hub_mismatch']]);
  });

  // Break caught: a hub taken from some request other than the first named, or kept when something is wrong.
  it('names no hub when anything is refused', () => {
    const assessment = assess([a], seen(facts(a)), '2026-11-08');
    expect(assessment.hubId).toBeUndefined();
  });

  // Break caught: a lookup by the spelling of the id, so that an upper-case id the database returned in lower case is "not available".
  it('finds a request however the id was spelled', () => {
    const assessment = assess([a.toUpperCase()], seen(facts(a)));
    expect(assessment.violations).toEqual([]);
    expect(assessment.hubId).toBe(HUB);
  });
});
