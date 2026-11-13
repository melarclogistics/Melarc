import 'reflect-metadata';

import { describe, expect, it } from 'vitest';

import { NotificationLogController } from './notifications/notification-log.controller.js';
import type { NotificationLogService } from './notifications/notification-log.service.js';
import { OpsWorkListsController } from './pickup/ops-work-lists.controller.js';
import type { PickupOpsWorkLists } from './pickup/ops-work-lists.service.js';
import { PickupManifestsController } from './pickup/pickup-manifests.controller.js';
import type { PickupManifestsService } from './pickup/pickup-manifests.service.js';
import { PickupRequestsController } from './pickup/pickup-requests.controller.js';
import type { PickupRequestsService } from './pickup/pickup-requests.service.js';
import type { AuthorizedRequest } from './platform/authorization/authorized-request.js';
import { ApiException } from './platform/http/api-exception.js';

/**
 * What the three lists that take a hub hand their service from the query (task C3; `AC-HUBF-01` to `-03`, `-07`): the hub as the filter, one string or
 * none, exactly as it was sent. The contract's validation answers a value that is not a UUID, and a repeated one, before the handler is reached (the
 * database tests prove the answer a client sees); each controller states the second again because it is the place that knows the query reaches it as
 * `string | string[]`, and a read that trusted the contract to have refused a repeat would hand an array to a statement, or the first of two hubs as
 * though it were the one asked for. Those two lines are not reachable through the HTTP layer, so this is the only test that sees the second one. The
 * summary's controller has its own test beside it (`queue-summary.controller.test.ts`).
 */
const AUTHORIZED = { session: { principalType: 'STAFF' } } as unknown as AuthorizedRequest;
const HUB = '0191a4f8-6c2e-7a3e-8f10-5d6c7b8a9e01';
const OTHER_HUB = '0191a4f8-6c2e-7a3e-8f10-5d6c7b8a9e02';
const PAGE = { items: [], next_page_token: null };

interface Built {
  /** Asks the list with this query. A refusal made while the query is read is a rejection here, as it is to a client. */
  readonly list: (query: Record<string, unknown>) => Promise<unknown>;
  /** The filter of each time the service was asked. */
  readonly asked: unknown[];
  /** The authorization of each time the service was asked, in the order it was handed. */
  readonly received: AuthorizedRequest[];
}

/** A service that notes the authorization and the filter of each read and answers an empty page. */
function noting(): {
  readonly service: { list: unknown };
  readonly asked: unknown[];
  readonly received: AuthorizedRequest[];
} {
  const asked: unknown[] = [];
  const received: AuthorizedRequest[] = [];
  return {
    asked,
    received,
    service: {
      list: (authorized: AuthorizedRequest, _correlationId: string, filter: unknown) => {
        received.push(authorized);
        asked.push(filter);
        return Promise.resolve(PAGE);
      },
    },
  };
}

/**
 * The service of the four Ops work lists (D-A3, OB-S1-70): one object with a method for each list, every one noting what it was asked, so that the same
 * controller test holds the four to the same account of the hub.
 */
function notingWorkLists(): {
  readonly service: Record<string, unknown>;
  readonly asked: unknown[];
  readonly received: AuthorizedRequest[];
} {
  const { service, asked, received } = noting();
  const note = (service as { list: (...given: unknown[]) => Promise<unknown> }).list;
  return {
    asked,
    received,
    service: {
      listCollectionDisputes: note,
      listHandshakesForOps: note,
      listCollectionShortfalls: note,
      listPickupFailures: note,
    },
  };
}

/** The subject of one of the four Ops work lists: the same four filters (`open`, `hub_id`, `page_size`, `page_token`), each handed on in its own place. */
function workList(
  operation: string,
  method: 'listDisputes' | 'listHandshakes' | 'listShortfalls' | 'listFailures',
): Subject {
  return {
    operation,
    build: () => {
      const { service, asked, received } = notingWorkLists();
      const controller = new OpsWorkListsController(service as unknown as PickupOpsWorkLists);
      return {
        asked,
        received,
        list: (query) =>
          Promise.resolve().then((): Promise<unknown> => controller[method](AUTHORIZED, query)),
      };
    },
    everything: {
      query: { open: 'true', hub_id: HUB, page_size: '7', page_token: 'a-position' },
      filter: { open: 'true', hubId: HUB, pageSize: 7, pageToken: 'a-position' },
    },
  };
}

/** The record without one of its keys. */
const without = (record: Record<string, unknown>, key: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));

interface Subject {
  readonly operation: string;
  readonly build: () => Built;
  /** A query that holds every filter of the list, and the filter the service is given for it, written out. */
  readonly everything: {
    readonly query: Record<string, string>;
    readonly filter: Record<string, unknown>;
  };
}

const SUBJECTS: readonly Subject[] = [
  {
    operation: 'listPickupRequests',
    build: () => {
      const { service, asked, received } = noting();
      const controller = new PickupRequestsController(service as unknown as PickupRequestsService);
      return {
        asked,
        received,
        list: (query) => Promise.resolve().then(() => controller.list(AUTHORIZED, query)),
      };
    },
    everything: {
      query: {
        state: 'CONFIRMED',
        service_date: '2026-11-03',
        manifested: 'false',
        one_package_exception_state: 'REQUESTED',
        cutoff_exception_state: 'PENDING_OPS_REVIEW',
        hub_id: HUB,
        page_size: '7',
        page_token: 'a-position',
      },
      filter: {
        state: 'CONFIRMED',
        serviceDate: '2026-11-03',
        manifested: 'false',
        exceptionState: 'REQUESTED',
        cutoffExceptionState: 'PENDING_OPS_REVIEW',
        hubId: HUB,
        pageSize: 7,
        pageToken: 'a-position',
      },
    },
  },
  {
    operation: 'listPickupManifests',
    build: () => {
      const { service, asked, received } = noting();
      const controller = new PickupManifestsController(
        undefined,
        service as unknown as PickupManifestsService,
      );
      return {
        asked,
        received,
        list: (query) => Promise.resolve().then(() => controller.list(AUTHORIZED, query)),
      };
    },
    everything: {
      query: {
        state: 'DISPATCHED',
        service_date: '2026-11-03',
        hub_id: HUB,
        page_size: '7',
        page_token: 'a-position',
      },
      filter: {
        state: 'DISPATCHED',
        serviceDate: '2026-11-03',
        hubId: HUB,
        pageSize: 7,
        pageToken: 'a-position',
      },
    },
  },
  {
    operation: 'listNotifications',
    build: () => {
      const { service, asked, received } = noting();
      const controller = new NotificationLogController(
        service as unknown as NotificationLogService,
      );
      return {
        asked,
        received,
        list: (query) => Promise.resolve().then(() => controller.list(AUTHORIZED, query)),
      };
    },
    everything: {
      query: {
        state: 'SUPPRESSED',
        audience: 'AD_HOC_SENDER',
        channel: 'SMS',
        subject_id: OTHER_HUB,
        hub_id: HUB,
        page_size: '7',
        page_token: 'a-position',
      },
      filter: {
        state: 'SUPPRESSED',
        audience: 'AD_HOC_SENDER',
        channel: 'SMS',
        subjectId: OTHER_HUB,
        hubId: HUB,
        pageSize: 7,
        pageToken: 'a-position',
      },
    },
  },
  workList('listCollectionDisputes', 'listDisputes'),
  workList('listHandshakesForOps', 'listHandshakes'),
  workList('listCollectionShortfalls', 'listShortfalls'),
  workList('listPickupFailures', 'listFailures'),
];

describe.each(SUBJECTS.map((subject) => [subject.operation, subject] as const))(
  'the hub of the query of %s',
  (_operation, subject) => {
    // Break caught: the hub read from another parameter of the query (`hub`, `hubId`), not handed on at all, or handed as another filter's value
    // (the subject of the log is an identifier as well, and is the likeliest to be taken for it).
    it('is handed the service as the filter `hubId`, among the others, each in its own place', async () => {
      const { list, asked } = subject.build();

      await expect(list(subject.everything.query)).resolves.toBe(PAGE);

      expect(asked).toEqual([subject.everything.filter]);
    });

    // Break caught: a controller that builds another authorization from the query and hands that to the service (a scope narrowed to the hub named,
    // which gives the same pages, or widened to every hub, which gives the wrong ones for a hub outside the grant): the hub is a part of the filter
    // and never of the authorization, so the service is handed the very object the guard decided (identity, not equality), whatever the query says.
    it.each([
      ['no hub', {}],
      ['a hub', { hub_id: HUB }],
      ['another hub', { hub_id: OTHER_HUB }],
      ['text that is not a hub', { hub_id: 'not-a-uuid' }],
    ])('hands the service the very authorization it was given, for %s', async (_which, query) => {
      const { list, received } = subject.build();

      await list(query);

      expect(received).toHaveLength(1);
      expect(received[0]).toBe(AUTHORIZED);
    });

    // Break caught: a hub that is changed on its way (lower-cased, upper-cased, trimmed, decoded): the contract's validation and the service judge
    // exactly what the client sent, and a hub the controller cleaned would turn a value they refuse (spaces around it) into a hub they accept.
    it.each([
      ['a hub in lower case', HUB],
      ['a hub in capitals', HUB.toUpperCase()],
      ['a hub with spaces around it', ` ${HUB} `],
      ['a hub written as a urn', `urn:uuid:${HUB}`],
      ['text that is not a hub', 'not-a-uuid'],
      ['an empty hub', ''],
    ])('hands the service %s as it was sent, to be judged there', async (_what, hubId) => {
      const { list, asked } = subject.build();

      await expect(list({ hub_id: hubId })).resolves.toBe(PAGE);

      expect(asked).toEqual([{ hubId }]);
    });

    // Break caught: a hub invented when none was sent (a default of the controller's own, the empty string, the actor's hub), which would filter
    // every read that names no hub (`AC-HUBF-11`: leaving the filter out changes nothing).
    it('hands the service no hub at all when the query has none', async () => {
      const { list, asked } = subject.build();
      const withoutHub = without(subject.everything.query, 'hub_id');
      const otherFilters = without(subject.everything.filter, 'hubId');

      await list(withoutHub);
      await list({});
      // Neither is the hub another parameter's to be: a query that names a hub in another way names none.
      await list({ hub: HUB, hubId: HUB, hub_ids: HUB });

      expect(asked).toEqual([otherFilters, {}, {}]);
      for (const filter of asked) expect(Object.keys(filter as object)).not.toContain('hubId');
    });

    // Break caught: a repeated hub (`hub_id=A&hub_id=B`, which the query parser gives as a list) handed on as it is, or read as its first value
    // (which would answer for one hub a client asked two of), or let through as no hub: it is not one string, and it is refused as the lists
    // refuse every filter that is not one, naming the parameter, before the service is asked anything.
    it.each([
      ['two hubs', [HUB, OTHER_HUB]],
      ['the same hub twice', [HUB, HUB]],
      ['a list of one', [HUB]],
      ['an empty list', []],
      ['a value that is not a string', 7],
      ['an object', { hub: HUB }],
    ])('refuses %s, naming the parameter, before the service is asked', async (_what, hub) => {
      const { list, asked } = subject.build();

      const error = await list({ hub_id: hub }).then(
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
    });
  },
);
