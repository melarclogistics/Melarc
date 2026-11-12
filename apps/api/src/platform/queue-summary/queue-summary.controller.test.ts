import 'reflect-metadata';

import { describe, expect, it } from 'vitest';

import type { AuthorizedRequest } from '../authorization/authorized-request.js';
import { ANY_HUB, type QueueFilter } from '../domain-ports/queue-counter.port.js';
import { ApiException } from '../http/api-exception.js';
import { QueueSummaryController } from './queue-summary.controller.js';
import type { QueueSummaryService, QueueSummaryView } from './queue-summary.service.js';

/**
 * What the controller of `getQueueSummary` hands the service from the query (task C3; `AC-HUBF-04`, `-07`): the hub as the filter, one string or
 * none. The contract's validation answers a value that is not a UUID, and a repeated one, before the handler is reached (the database tests prove
 * the answer a client sees); the controller states the second again because it is the place that knows the query reaches it as `string | string[]`,
 * and a read that trusted the contract to have refused a repeat would hand an array to a statement. This proves the hand-over and the refusal, on a
 * service that notes what it was asked.
 */
const AUTHORIZED = { session: { principalType: 'STAFF' } } as unknown as AuthorizedRequest;
const HUB = '0191a4f8-6c2e-7a3e-8f10-5d6c7b8a9e01';
const OTHER_HUB = '0191a4f8-6c2e-7a3e-8f10-5d6c7b8a9e02';
const ANSWER: QueueSummaryView = { queues: [{ queue: 'PICKUP_AWAITING_CONFIRMATION', count: 1 }] };

/** A service that notes the filter of each read and answers the same summary. */
function service(): {
  readonly controller: QueueSummaryController;
  readonly asked: { readonly authorized: AuthorizedRequest; readonly filter: QueueFilter }[];
} {
  const asked: { authorized: AuthorizedRequest; filter: QueueFilter }[] = [];
  const read = (authorized: AuthorizedRequest, _correlationId: string, filter: QueueFilter) => {
    asked.push({ authorized, filter });
    return Promise.resolve(ANSWER);
  };
  return {
    controller: new QueueSummaryController({ read } as unknown as QueueSummaryService),
    asked,
  };
}

describe('the hub of the query of the queue summary', () => {
  // Break caught: a read with no hub that is asked for a hub nobody named (a default of the controller's own, an empty string for none), or a
  // service that is given the query and not the filter: no `hub_id` is the filter that names no hub, and the answer is the service's.
  it('hands the service the filter that names no hub when the query has none', async () => {
    const { controller, asked } = service();

    await expect(controller.getQueueSummary(AUTHORIZED, {})).resolves.toBe(ANSWER);
    // Another parameter of the query is not the hub's: the summary has no other filter, and nothing else is read from it.
    await expect(controller.getQueueSummary(AUTHORIZED, { state: 'PENDING' })).resolves.toBe(
      ANSWER,
    );

    expect(asked.map((each) => each.filter)).toEqual([ANY_HUB, ANY_HUB]);
    // The very authorization the guard decided (identity, not equality): the hub is a part of the filter and never of the authorization.
    expect(asked).toHaveLength(2);
    for (const each of asked) expect(each.authorized).toBe(AUTHORIZED);
  });

  // Break caught: the hub read from another parameter of the query, trimmed, lower-cased or otherwise changed on its way (the contract's validation
  // has judged exactly what the client sent, and the service judges it again, so a hub the controller cleaned would turn a value they refuse into one
  // they accept), an empty value read as "no hub" (a check on truthiness: the summary would then count every hub for a value that names none), or
  // not handed to the service at all.
  it.each([
    ['a hub', HUB],
    ['a hub in capitals', HUB.toUpperCase()],
    ['another hub', OTHER_HUB],
    ['a hub with spaces around it', ` ${HUB} `],
    ['a hub written as a urn', `urn:uuid:${HUB}`],
    ['text that is not a hub', 'not-a-uuid'],
    ['an empty hub', ''],
  ])('hands the service %s as the filter, as it was sent', async (_what, hubId) => {
    const { controller, asked } = service();

    await expect(controller.getQueueSummary(AUTHORIZED, { hub_id: hubId })).resolves.toBe(ANSWER);

    expect(asked).toHaveLength(1);
    expect(asked[0]?.filter).toEqual({ hubId });
    expect(asked[0]?.authorized).toBe(AUTHORIZED);
  });

  // Break caught: a repeated hub (`hub_id=A&hub_id=B`, which the query parser gives as a list) handed to the service as it is, or read as its first
  // value (which would answer for one hub a client asked two of), or answered with the counts of every hub: it is not one string, and it is refused
  // as the lists refuse it, naming the parameter, before the service is asked anything.
  it.each([
    ['two hubs', [HUB, OTHER_HUB]],
    ['the same hub twice', [HUB, HUB]],
    ['a list of one', [HUB]],
    ['an empty list', []],
    ['a value that is not a string', 7],
    ['an object', { hub: HUB }],
  ])(
    'refuses %s as a hub, naming the parameter, before the service is asked',
    async (_what, hub) => {
      const { controller, asked } = service();

      // (Whether the refusal is thrown or returned as a rejected promise is the handler's own business: both are the same refusal to a client.)
      const error = await Promise.resolve()
        .then(() => controller.getQueueSummary(AUTHORIZED, { hub_id: hub }))
        .then(
          () => undefined,
          (thrown: unknown) => thrown,
        );

      expect(error).toBeInstanceOf(ApiException);
      const refused = error as ApiException;
      expect(refused.code).toBe('VALIDATION_FAILED');
      expect(refused.getStatus()).toBe(400);
      expect(refused.details).toEqual({
        violations: [{ in: 'query', pointer: '/hub_id', rule: 'type' }],
      });
      expect(asked).toEqual([]);
    },
  );
});
