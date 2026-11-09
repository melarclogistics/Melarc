import { ApiError } from '@melarc/api-client/browser';
import { describe, expect, it } from 'vitest';

import { OperationFailure } from '../api/api-response';
import { MANIFEST_COPY } from './manifest-copy';
import { PICKUP_COPY } from './pickup-copy';
import { problemOf, PROBLEM_COPY } from './problem-copy';

/**
 * The words of the manifest screens (S1.25), in the one table the Ops Portal keeps, keyed by operation, context and code (COMPONENT_PATTERNS
 * section 33). Proposed for the Product Owner to review with the composed screens. The tests pin that each refused act names its own permission
 * key and no role, that a refusal which declares a rule is worded by the rule, and that no wording states an amount or a count of the hub's.
 */
const refused = (code: string | undefined, status: number): ApiError =>
  new ApiError({ kind: 'http', status, ...(code === undefined ? {} : { code }) });

const conflict = (rule: string | undefined, stops: readonly string[] = []): OperationFailure =>
  new OperationFailure(refused('STATE_CONFLICT', 409), [], {
    ...(rule === undefined ? {} : { rule }),
    ...(stops.length === 0 ? {} : { stops }),
  });

const OPERATIONS = [
  'listPickupManifests',
  'getPickupManifest',
  'getPickupStop',
  'getPickupRequest',
  'listPickupRequests',
  'listReasonDefinitions',
  'listRiders',
  'getRider',
  'listRunCustodyHandovers',
  'getRunCustodyHandover',
  'createPickupManifest',
  'setManifestStopOrder',
  'assignRider',
  'dispatchManifest',
  'cancelPickupManifest',
  'skipPickupStop',
  'initiateRunCustodyHandover',
  'acceptRunCustodyHandover',
  'failRunCustodyHandover',
];

describe('the words of the table', () => {
  it('are in the table the screens read', () => {
    for (const rule of MANIFEST_COPY) expect(PROBLEM_COPY).toContain(rule);
  });

  // Break caught: a rule written for a place nothing asks for, which is words nobody will ever read.
  it('has no rule for an operation the manifest screens do not call', () => {
    for (const rule of MANIFEST_COPY) expect(OPERATIONS, rule.text).toContain(rule.operation);
  });

  it('has no two rules for the same place, here or in the rest of the table', () => {
    const place = (rule: { operation?: string; context?: string; code?: string }) =>
      `${rule.operation ?? ''}|${rule.context ?? ''}|${rule.code ?? ''}`;
    const mine = MANIFEST_COPY.map(place);
    expect(new Set(mine).size).toBe(mine.length);
    const others = new Set(PROBLEM_COPY.filter((rule) => !MANIFEST_COPY.includes(rule)).map(place));
    for (const each of mine) expect(others.has(each), each).toBe(false);
    expect(MANIFEST_COPY.some((rule) => PICKUP_COPY.includes(rule))).toBe(false);
  });
});

describe('the words of the refusals of authority', () => {
  // Break caught (ops-portal.md section 7, PRODUCT_DESIGN_DIRECTION section 6.5): a refusal that names a key (the review of 5edada2), or the wrong act, so that an administrator
  // is asked to grant the wrong access.
  it.each([
    ['createPickupManifest', 'pickup.manifest.create'],
    ['setManifestStopOrder', 'pickup.manifest.create'],
    ['assignRider', 'pickup.manifest.assign'],
    ['dispatchManifest', 'pickup.manifest.dispatch'],
    ['cancelPickupManifest', 'pickup.manifest.create'],
    ['skipPickupStop', 'pickup.stop.skip'],
    ['initiateRunCustodyHandover', 'fleet.custody.initiate'],
    ['acceptRunCustodyHandover', 'fleet.custody.accept'],
    ['failRunCustodyHandover', 'fleet.custody.initiate'],
  ])(
    'tells a refusal of %s as what the account cannot do, without the key %s',
    (operation, key) => {
      const problem = problemOf(refused('PERMISSION_DENIED', 403), { operation });

      expect(problem.kind).toBe('forbidden');
      expect(problem.message).toMatch(/Ask an administrator for access\.$|handover to a rider/);
      expect(problem.message).not.toContain(key);
    },
  );

  // Break caught: Ops told that a handover to a rider is theirs to accept by a message that names the wrong rule.
  it('tells Ops that a handover to a rider is the rider’s to accept', () => {
    expect(
      problemOf(refused('PERMISSION_DENIED', 403), { operation: 'acceptRunCustodyHandover' })
        .message,
    ).toMatch(/handover to a rider is the rider’s/);
  });

  it('tells a manifest of another hub as that, for each operation that names one', () => {
    for (const operation of [
      'getPickupManifest',
      'setManifestStopOrder',
      'assignRider',
      'dispatchManifest',
      'cancelPickupManifest',
      'initiateRunCustodyHandover',
      'acceptRunCustodyHandover',
      'failRunCustodyHandover',
    ]) {
      const problem = problemOf(refused('HUB_SCOPE_VIOLATION', 403), { operation });
      expect(problem.forbidden, operation).toBe('outside-hubs');
      expect(problem.message, operation).toMatch(/hub your session does not act in/);
    }
  });
});

describe('a refusal that declares its rule is worded by the rule', () => {
  const STOP = '6b7c8d9e-0f1a-4b2c-8d3e-4f5a6b7c8d9e';

  // Break caught: the day of a run having passed told as "this changed, reload", which would send the officer to reload what cannot work.
  it('tells a dispatch refused for the day as a day that has passed, and what to do next', () => {
    const problem = problemOf(conflict('service_date_passed'), { operation: 'dispatchManifest' });

    expect(problem.kind).toBe('conflict');
    expect(problem.rule).toBe('service_date_passed');
    expect(problem.message).toMatch(/day of this run has passed/);
    expect(problem.message).toMatch(/Cancel the manifest/);
  });

  it('tells a dispatch refused for a pickup that is no longer confirmed, and names the stops', () => {
    const problem = problemOf(conflict('request_not_confirmed', [STOP]), {
      operation: 'dispatchManifest',
    });

    expect(problem.message).toMatch(/no longer confirmed/);
    expect(problem.message).toMatch(/nothing was sent/i);
    expect(problem.stops).toEqual([STOP]);
  });

  // Break caught: a rule the table has no words for hiding the conflict's general words, or showing the rule itself.
  it('tells a rule it has no words for as the operation’s own conflict, and never shows the rule', () => {
    const problem = problemOf(conflict('some_new_rule'), { operation: 'dispatchManifest' });

    expect(problem.message).toBe(
      problemOf(refused('STATE_CONFLICT', 409), { operation: 'dispatchManifest' }).message,
    );
    expect(problem.message).not.toContain('some_new_rule');
  });

  it('lets a page that gives its own context keep it', () => {
    const problem = problemOf(conflict('service_date_passed'), {
      operation: 'dispatchManifest',
      context: 'unknown-outcome',
    });

    expect(problem.message).not.toMatch(/day of this run has passed/);
  });

  it('does not word the conflict of another operation by a rule it has no words for', () => {
    expect(problemOf(conflict('service_date_passed'), { operation: 'assignRider' }).message).toBe(
      problemOf(refused('STATE_CONFLICT', 409), { operation: 'assignRider' }).message,
    );
  });
});

describe('a refusal for a stop whose parcels were counted is worded by its rule (S1.26)', () => {
  // Break caught: the skip or the cancellation of a counted stop told as "this changed, reload", which sends the officer back to what cannot change.
  it.each([
    ['skipPickupStop', /already counted the parcels at this stop/],
    ['cancelPickupRequest', /already counted the parcels for this pickup/],
  ])('tells %s refused by collection_recorded as that', (operation, words) => {
    const problem = problemOf(conflict('collection_recorded'), { operation });

    expect(problem.kind).toBe('conflict');
    expect(problem.rule).toBe('collection_recorded');
    expect(problem.message).toMatch(words);
    expect(problem.message).not.toContain('collection_recorded');
    expect(problem.message).not.toBe(problemOf(conflict(undefined), { operation }).message);
  });

  it('does not word another operation’s conflict by a rule it has no words for', () => {
    expect(problemOf(conflict('collection_recorded'), { operation: 'assignRider' }).message).toBe(
      problemOf(conflict(undefined), { operation: 'assignRider' }).message,
    );
  });
});

describe('a custody refusal that declares its rule is worded by the rule', () => {
  // Break caught: four different reasons for a refused handover all told as "this changed, reload", so the officer reloads what cannot work.
  it.each([
    ['initiateRunCustodyHandover', 'run_not_in_progress', /run is not in progress/],
    ['initiateRunCustodyHandover', 'custody_handover_pending', /already waiting/],
    ['initiateRunCustodyHandover', 'custody_with_hub', /hub already holds custody/],
    ['acceptRunCustodyHandover', 'run_not_in_progress', /run is not in progress/],
    ['acceptRunCustodyHandover', 'no_custody_handover_pending', /No handover is waiting/],
    ['failRunCustodyHandover', 'run_not_in_progress', /run is not in progress/],
    ['failRunCustodyHandover', 'no_custody_handover_pending', /No handover is waiting/],
  ])('tells %s refused by %s as that', (operation, rule, words) => {
    const problem = problemOf(conflict(rule), { operation });

    expect(problem.kind).toBe('conflict');
    expect(problem.rule).toBe(rule);
    expect(problem.message).toMatch(words);
    expect(problem.message).not.toContain(rule);
    // Not the operation's general conflict: the rule is what says what to do next.
    expect(problem.message).not.toBe(problemOf(conflict(undefined), { operation }).message);
  });

  it('tells a stale version of a handover, which declares no rule, in the operation’s own words', () => {
    expect(
      problemOf(conflict(undefined), { operation: 'acceptRunCustodyHandover' }).message,
    ).toMatch(/no longer waiting/);
  });

  it('tells a destination that was not exactly one, and a hub that is not the run’s, at the place the server named', () => {
    const failure = new OperationFailure(refused('VALIDATION_FAILED', 400), [
      { in: 'body', pointer: '/to_rider_id', rule: 'exactly_one_destination' },
    ]);

    expect(problemOf(failure, { operation: 'initiateRunCustodyHandover' }).violations).toEqual([
      { in: 'body', pointer: '/to_rider_id', rule: 'exactly_one_destination' },
    ]);
    expect(problemOf(failure, { operation: 'initiateRunCustodyHandover' }).message).toMatch(
      /Name one other rider, or this hub, and not both/,
    );
  });
});

describe('the words of the list that is filtered', () => {
  const refusedParameter = (pointer: string) =>
    new OperationFailure(refused('VALIDATION_FAILED', 400), [
      { in: 'query', pointer, rule: 'enum' },
    ]);

  // Break caught: a refused filter worded as a refused page (or the other way round), so the way on offered is the wrong one.
  it('tells a filter the server refused as a filter, and a page it refused as a page', () => {
    const filter = problemOf(refusedParameter('/state'), { operation: 'listPickupManifests' });
    const page = problemOf(refusedParameter('/page_token'), {
      operation: 'listPickupManifests',
      context: 'cursor',
    });

    expect(filter.message).toBe(
      'That filter was not accepted. Choose a state from the list and a whole date.',
    );
    expect(page.message).toMatch(/That page of the manifests could not be opened/);
    expect(page.message).toMatch(/Go back to the first page/);
    expect(page.message).not.toBe(filter.message);
  });

  it('names the parameter the server refused, and no value', () => {
    const problem = problemOf(refusedParameter('/service_date'), {
      operation: 'listPickupManifests',
    });

    expect(problem.violations).toEqual([{ in: 'query', pointer: '/service_date', rule: 'enum' }]);
  });
});

describe('the words of the rules', () => {
  it('tells a start that came too late as the run having started, and the way out', () => {
    const problem = problemOf(refused('RUN_ALREADY_STARTED', 422), {
      operation: 'cancelPickupManifest',
    });

    expect(problem.message).toMatch(/skip a stop/);
    expect(problem.message).toMatch(/hand custody over/);
  });

  it('tells a creation that clashed as the requests being marked on the page', () => {
    const problem = problemOf(refused('ALREADY_MANIFESTED', 409), {
      operation: 'createPickupManifest',
    });

    expect(problem.message).toMatch(/already on a manifest/);
    expect(problem.message).toMatch(/nothing was created/);
  });

  it('says what a lost creation may mean, and that a retry makes nothing twice', () => {
    const problem = problemOf(new TypeError('Failed to fetch'), {
      operation: 'createPickupManifest',
      context: 'unknown-outcome',
    });

    expect(problem.message).toMatch(/not made twice/);
  });
});

describe('what no wording of these screens may be', () => {
  it('has rules for these screens', () => {
    expect(MANIFEST_COPY.length).toBeGreaterThan(60);
  });

  // Break caught: a role named where the permission key belongs: roles are not the authority.
  it('names no role', () => {
    for (const rule of MANIFEST_COPY) {
      expect(rule.text, `${rule.operation ?? ''} ${rule.code ?? ''}`).not.toMatch(
        /Ops Staff|Senior Ops|Platform Admin|Finance/,
      );
    }
  });

  // Break caught: wording that states an amount, a price or a count of the hub's, which the screen never computes and the table cannot know.
  it('states no amount, and calls the count of a handover nothing the hub is given', () => {
    for (const rule of MANIFEST_COPY) {
      expect(rule.text, `${rule.operation ?? ''} ${rule.code ?? ''}`).not.toMatch(
        /GH₵|cedi|\btotal\b|\bprice\b|\d+\.\d\d|blind count|hub count/i,
      );
    }
  });

  it('does not apologise or blame', () => {
    for (const rule of MANIFEST_COPY) {
      expect(rule.text).not.toMatch(
        /sorry|oops|unfortunately|you failed|your fault|invalid input/i,
      );
    }
  });
});
