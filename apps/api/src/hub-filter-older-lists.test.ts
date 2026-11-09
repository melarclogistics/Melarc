import { describe, expect, it } from 'vitest';

import { RidersService } from './dispatch/riders.service.js';
import { StaffIdentitiesService } from './staff/staff-identities.service.js';
import type { AuditWriter } from './platform/auth/ports/audit-writer.port.js';
import type { AuthorizedRequest } from './platform/authorization/authorized-request.js';
import type { OperationRunner } from './platform/authorization/operation-runner.js';
import { ApiException } from './platform/http/api-exception.js';
import { VendorAccountsService } from './vendor/vendor-accounts.service.js';

/**
 * The three older lists that take `hub_id` (`listStaffIdentities`, `listRiders`, `listVendorAccounts`) answer a hub outside a staff session's grant as the four
 * reads of task C3 do (task F of the Ops Portal redesign, the Product Owner's decision of 7 November 2026, afternoon: every hub filter behaves the same;
 * `AC-HUBF-13`; features/operations/hub-filters.md section 5): **an empty page, with no transaction and no statement**, so that a hub that exists outside the
 * grant and a hub that does not exist take the same time. On fakes, what the database tests cannot see from the outside: that the runner is not asked, that the
 * validations still come first, and that a hub inside the grant, a grant of every hub and no hub at all still read. The answers themselves, from a real
 * database, are `hub-filters.db.test.ts` and the lists' own route tests.
 */
const AUDIT = {} as AuditWriter;
const EMPTY = { items: [], next_page_token: null };

/** A hub as the contract writes one, with letters in it so that its capitals are another text. */
const HUB = '0191a4f8-6c2e-7a3e-8f10-5d6c7b8a9e01';
const OUTSIDE = '0191a4f8-6c2e-7a3e-8f10-5d6c7b8a9e0b';
const NOBODY = '0191a4f8-6c2e-7a3e-8f10-5d6c7b8a9e0f';

/** Values that are not a hub, in the forms a client could send them: each is refused, naming the parameter, before anything is read or answered. */
const NOT_A_HUB = [
  ['text that is not an identifier', 'not-a-uuid'],
  ['an empty hub', ''],
  ['a hub of spaces alone', '   '],
  ['a hub with a space before it', ` ${HUB}`],
  ['a hub with a line break after it', `${HUB}\n`],
  ['a hub written as a urn', `urn:uuid:${HUB}`],
  ['a hub in braces', `{${HUB}}`],
  ['a hub without its hyphens', HUB.replaceAll('-', '')],
] as const;

interface Filter {
  readonly status?: string;
  readonly hubId?: string;
  readonly q?: string;
  readonly pageSize?: number;
  readonly pageToken?: string;
}

interface List {
  list(authorized: AuthorizedRequest, correlationId: string, filter: Filter): Promise<unknown>;
}

/**
 * What the guard decided for a staff session, in the little these tests need: who asks, the scope of the grant of the list's key, and the hubs the session
 * itself was issued with (a staff member's primary hub: `session.authority.authorizedHubIds`).
 */
const staffWith = (
  scope: AuthorizedRequest['scope'],
  ownHubs: readonly string[] = [],
): AuthorizedRequest =>
  ({
    session: {
      principalType: 'STAFF',
      principalId: '11111111-1111-4111-8111-111111111111',
      authority: { authorizedHubIds: ownHubs },
    },
    scope,
  }) as unknown as AuthorizedRequest;

const ONE_HUB = staffWith({ hubScopeMode: 'SET', authorizedHubIds: [HUB] }, [HUB]);
const EVERY_HUB = staffWith({ hubScopeMode: 'ALL', authorizedHubIds: [] });
const NO_HUB = staffWith({ hubScopeMode: 'SET', authorizedHubIds: [] });
/** A session with a hub of its own whose grant of the list's key reaches no hub at all (no seeded bundle is one; the table of profiles still shows it its own row). */
const HOME_ONLY = staffWith({ hubScopeMode: 'SET', authorizedHubIds: [] }, [HUB]);
/**
 * A session that holds two hubs, `HUB` and `OUTSIDE`: what an effective assignment (`HubAssignment`) adds to the one hub a staff session is issued with today, its primary
 * membership. Its grant of the list's key reaches no hub. The list of hubs is in ascending order, so the session cannot tell which of the two is its primary hub.
 */
const HOME_AND_ASSIGNED = staffWith({ hubScopeMode: 'SET', authorizedHubIds: [] }, [HUB, OUTSIDE]);

/** A runner that notes each authorization it is handed and answers an empty page, so that a read that went ahead is told from one that was not made. */
function runnerOf(): {
  readonly runner: Pick<OperationRunner, 'read'>;
  readonly received: AuthorizedRequest[];
} {
  const received: AuthorizedRequest[] = [];
  const runner = {
    read: (authorized: AuthorizedRequest) => {
      received.push(authorized);
      return Promise.resolve(EMPTY);
    },
  } as unknown as Pick<OperationRunner, 'read'>;
  return { runner, received };
}

const SERVICES: readonly (readonly [string, (runner: Pick<OperationRunner, 'read'>) => List])[] = [
  ['listStaffIdentities', (runner) => new StaffIdentitiesService({ runner, audit: AUDIT })],
  ['listRiders', (runner) => new RidersService({ runner, audit: AUDIT })],
  ['listVendorAccounts', (runner) => new VendorAccountsService({ runner, audit: AUDIT })],
];

describe.each(SERVICES)('%s, with a hub (AC-HUBF-13)', (_operation, make) => {
  // Break caught (task F, `AC-HUBF-13`, `GBT-GS14`): the hub filter run as a statement for a hub the staff session's grant does not reach, so that the
  // database walks that hub's index before row-level security discards every row and the time tells a caller whether the hub exists and how much it holds;
  // or the shortcut judged on the text of the identifier (a hub in capitals is the same hub). The runner is not asked: no transaction, no statement, no event.
  it.each([
    ['a hub outside the session’s hubs', OUTSIDE],
    ['a hub outside the session’s hubs, in capitals', OUTSIDE.toUpperCase()],
    ['the identifier of no hub', NOBODY],
  ])('answers %s with the empty page and does not ask the runner', async (_which, hubId) => {
    const { runner, received } = runnerOf();

    await expect(make(runner).list(ONE_HUB, 'correlation', { hubId })).resolves.toEqual(EMPTY);

    expect(received, 'the runner was not asked').toEqual([]);
  });

  // Break caught: a session whose grant reaches no hub treated as one that reaches every hub (an empty set read as "all", `GBT-B5`), or answered by a read.
  it('answers a session whose grant reaches no hub with the empty page, for every hub, without a read', async () => {
    const { runner, received } = runnerOf();

    for (const hubId of [HUB, OUTSIDE, NOBODY]) {
      await expect(make(runner).list(NO_HUB, 'correlation', { hubId })).resolves.toEqual(EMPTY);
    }

    expect(received).toEqual([]);
  });

  // Break caught: the shortcut taken where it does not belong: the session's own hub answered empty (the list of its own hub lost), a grant of every hub
  // answered empty for a hub it may read, or a read with no hub skipped. Each of these is asked of the runner, with the very authorization it was given.
  it.each([
    ['a hub inside the session’s hubs', ONE_HUB, { hubId: HUB }],
    ['a hub inside the session’s hubs, in capitals', ONE_HUB, { hubId: HUB.toUpperCase() }],
    ['no hub, for a session of one hub', ONE_HUB, {}],
    ['a hub no set holds, for a grant of every hub', EVERY_HUB, { hubId: OUTSIDE }],
    ['the identifier of no hub, for a grant of every hub', EVERY_HUB, { hubId: NOBODY }],
    ['no hub, for a grant of every hub', EVERY_HUB, {}],
    ['no hub, for a session whose grant reaches no hub', NO_HUB, {}],
  ])('goes on to read for %s', async (_which, authorized, filter) => {
    const { runner, received } = runnerOf();

    await expect(make(runner).list(authorized, 'correlation', filter)).resolves.toEqual(EMPTY);

    expect(received).toHaveLength(1);
    expect(received[0]).toBe(authorized);
  });

  // Break caught: a hub taken on trust (an identifier that is not one handed to a statement, where `::uuid` fails as a defect and not as a validation
  // failure), or judged after the shortcut, so that a value that is not a hub is answered `200` with an empty page when it happens to be compared with
  // the set. The refusal names the parameter, as it does on the other lists (the contract's validation answers it first, on the route).
  it.each(NOT_A_HUB)(
    'refuses %s as a hub, before it reads and before it answers',
    async (_what, hubId) => {
      for (const authorized of [ONE_HUB, EVERY_HUB, NO_HUB]) {
        const { runner, received } = runnerOf();

        const error = await make(runner)
          .list(authorized, 'correlation', { hubId })
          .then(
            () => undefined,
            (thrown: unknown) => thrown,
          );

        expect(error).toBeInstanceOf(ApiException);
        const refused = error as ApiException;
        expect(refused.code).toBe('VALIDATION_FAILED');
        expect(refused.getStatus()).toBe(400);
        expect(refused.details).toEqual({
          violations: [{ in: 'query', pointer: '/hub_id', rule: 'format' }],
        });
        expect(received).toEqual([]);
      }
    },
  );

  // Break caught: a shortcut that answers a hub outside the set before the other filters are judged, so that a request the contract refuses is answered
  // `200` when its hub happens to be outside the grant, and the same request is a `400` for a hub inside it.
  it.each([
    ['a position that is not one', { hubId: OUTSIDE, pageToken: 'not-a-position' }, '/page_token'],
    ['a page size of zero', { hubId: OUTSIDE, pageSize: 0 }, '/page_size'],
    ['a search that is too long', { hubId: OUTSIDE, q: 'x'.repeat(500) }, '/q'],
  ])('still refuses %s beside a hub outside the session’s hubs', async (_what, filter, pointer) => {
    const { runner, received } = runnerOf();

    const error = await make(runner)
      .list(ONE_HUB, 'correlation', filter)
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      );

    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).details).toMatchObject({ violations: [{ pointer }] });
    expect(received).toEqual([]);
  });
});

const STAFF_LIST = SERVICES.filter(([operation]) => operation === 'listStaffIdentities');
const SCOPED_BY_OWNERSHIP = SERVICES.filter(([operation]) => operation !== 'listStaffIdentities');

/**
 * Task A3.5 (`AC-HUBF-14`): the table of staff profiles shows a profile's own row to its holder whatever the grant, so the staff list is the one list whose
 * answer for a hub outside the grant is not always empty. Without a filter, a session whose grant of `staff.read` reaches no hub is shown its own profile; with
 * `hub_id` naming its own hub it must be shown that profile too, because the filter only ever narrows. The own hub is told from the session, with no statement
 * (`hubOfTheSession`), so every other hub, and a hub that does not exist, is still the short answer.
 */
describe.each(STAFF_LIST)('%s, naming the caller’s own hub (AC-HUBF-14)', (_operation, make) => {
  // Break caught: the own hub answered empty before the database is asked (the filter widening nothing and narrowing too much: A1.1 had this, and the profile
  // of the session that asked disappeared from its own hub's list), or the session's hub compared on the text of its identifier.
  it.each([
    ['its own hub', HUB],
    ['its own hub, in capitals', HUB.toUpperCase()],
  ])('goes on to read for %s, outside the grant of the key', async (_which, hubId) => {
    const { runner, received } = runnerOf();

    await expect(make(runner).list(HOME_ONLY, 'correlation', { hubId })).resolves.toEqual(EMPTY);

    expect(received).toHaveLength(1);
    expect(received[0]).toBe(HOME_ONLY);
  });

  // Break caught (run 4, Stage 1, item 8): the own hub told from every hub the session holds and not from its primary hub. Once an effective assignment adds a hub to the
  // session, a hub the profile does not belong to would be read for as if it were its own, and the rule of the table (a profile's own row is shown to its holder) is about
  // the profile's primary hub alone. The list of hubs is in ascending order and does not say which is primary, so a session that holds several answers none of them as its
  // own (the empty page, no read) until the primary hub is carried on the session: not read for every hub it holds.
  it.each([
    ['the hub of a session that holds two (an assignment beside its primary)', OUTSIDE],
    ['the primary hub of a session that holds two, which it cannot tell from the other', HUB],
  ])('answers %s with the empty page and no read', async (_which, hubId) => {
    const { runner, received } = runnerOf();

    await expect(make(runner).list(HOME_AND_ASSIGNED, 'correlation', { hubId })).resolves.toEqual(
      EMPTY,
    );

    expect(received, 'the runner was not asked').toEqual([]);
  });

  // Break caught: the exception widened to every hub (the short answer lost for all of them, so the time tells whether a hub exists), or to a hub the session
  // does not belong to.
  it.each([
    ['another hub that exists', OUTSIDE],
    ['the identifier of no hub', NOBODY],
  ])('still answers %s with the empty page and no read', async (_which, hubId) => {
    const { runner, received } = runnerOf();

    await expect(make(runner).list(HOME_ONLY, 'correlation', { hubId })).resolves.toEqual(EMPTY);

    expect(received).toEqual([]);
  });
});

describe.each(SCOPED_BY_OWNERSHIP)(
  '%s, naming the session’s own hub outside its grant (AC-HUBF-14)',
  (_operation, make) => {
    // Break caught: the exception copied to the lists whose tables have no own-row rule: a rider's and a vendor's rows are scoped by their own predicates, so for
    // them a hub outside the grant is the short answer even when it is the hub of the session that asks.
    it('is still the empty page and no read: only the staff list has an own-row rule', async () => {
      const { runner, received } = runnerOf();

      await expect(make(runner).list(HOME_ONLY, 'correlation', { hubId: HUB })).resolves.toEqual(
        EMPTY,
      );

      expect(received).toEqual([]);
    });
  },
);
