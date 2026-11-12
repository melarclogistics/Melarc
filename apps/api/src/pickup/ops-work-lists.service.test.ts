import { describe, expect, it } from 'vitest';

import type { AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import { ApiException } from '../platform/http/api-exception.js';
import { PickupOpsWorkLists, type WorkListFilter } from './ops-work-lists.service.js';

/**
 * What the four Ops work lists refuse, and what they answer without a statement, before they read anything (D-A3, OB-S1-70). The contract's validation answers
 * most of these first, on the route; the service states them again because it is the one place that knows what a filter may hold, and a read that trusted its
 * caller to have checked would hand a bad value to a statement. The route test proves what a client sees; this proves the refusal and that nothing was asked.
 */
const AUDIT = {} as AuditWriter;
const HUB = '0191a4f8-6c2e-7a3e-8f10-5d6c7b8a9e01';
const OTHER_HUB = '0191a4f8-6c2e-7a3e-8f10-5d6c7b8a9e02';

const staff = (scope: object): AuthorizedRequest =>
  ({
    session: { principalType: 'STAFF', principalId: '11111111-1111-4111-8111-111111111111' },
    scope,
  }) as unknown as AuthorizedRequest;
/** A staff session whose grant reaches the one hub, `HUB`. */
const ONE_HUB = staff({ hubScopeMode: 'SET', authorizedHubIds: [HUB] });
/** A staff session whose grant reaches every hub. */
const EVERY_HUB = staff({ hubScopeMode: 'ALL', authorizedHubIds: [] });
const principal = (principalType: string): AuthorizedRequest =>
  ({
    session: { principalType, principalId: '22222222-2222-4222-8222-222222222222' },
    scope: { hubScopeMode: 'SET', authorizedHubIds: [HUB] },
  }) as unknown as AuthorizedRequest;

const LISTS = [
  'listCollectionDisputes',
  'listHandshakesForOps',
  'listCollectionShortfalls',
  'listPickupFailures',
] as const;
type ListName = (typeof LISTS)[number];

/** A runner that notes each read it is asked for and answers an empty page. */
function lists(): { readonly under: PickupOpsWorkLists; readonly reads: () => number } {
  let reads = 0;
  const runner = {
    read: () => {
      reads += 1;
      return Promise.resolve({ items: [], next_page_token: null });
    },
  } as unknown as Pick<OperationRunner, 'read'>;
  return { under: new PickupOpsWorkLists({ runner, audit: AUDIT }), reads: () => reads };
}

const ask = (
  under: PickupOpsWorkLists,
  name: ListName,
  authorized: AuthorizedRequest,
  filter: WorkListFilter,
): Promise<unknown> => under[name](authorized, 'correlation', filter);

const refusal = async (
  name: ListName,
  filter: WorkListFilter,
  authorized: AuthorizedRequest = ONE_HUB,
): Promise<{ readonly error: unknown; readonly reads: number }> => {
  const { under, reads } = lists();
  const error = await ask(under, name, authorized, filter).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  return { error, reads: reads() };
};

describe.each(LISTS)('%s refuses what no filter may hold, before it reads', (name) => {
  // Break caught: a page size, a filter or a position taken on trust and handed to a statement.
  it.each([
    ['a page size of zero', { pageSize: 0 }, '/page_size', 'range'],
    ['a negative page size', { pageSize: -1 }, '/page_size', 'range'],
    ['a page size over the maximum', { pageSize: 101 }, '/page_size', 'range'],
    ['a page size that is not whole', { pageSize: 1.5 }, '/page_size', 'range'],
    ['a page size that is not a number', { pageSize: Number.NaN }, '/page_size', 'range'],
    ['an open that is not a boolean', { open: 'yes' }, '/open', 'type'],
    ['an open in capitals', { open: 'TRUE' }, '/open', 'type'],
    ['an open of one', { open: '1' }, '/open', 'type'],
    ['an empty open', { open: '' }, '/open', 'type'],
    ['a position that is not one', { pageToken: 'not-a-position' }, '/page_token', 'format'],
    ['text that is not a hub', { hubId: 'not-a-uuid' }, '/hub_id', 'format'],
    ['an empty hub', { hubId: '' }, '/hub_id', 'format'],
    ['a hub with a space after it', { hubId: `${HUB} ` }, '/hub_id', 'format'],
    ['a hub written as a urn', { hubId: `urn:uuid:${HUB}` }, '/hub_id', 'format'],
  ] as const)('refuses %s, naming the parameter', async (_what, filter, pointer, rule) => {
    const { error, reads } = await refusal(name, filter);

    expect(error).toBeInstanceOf(ApiException);
    const refused = error as ApiException;
    expect(refused.code).toBe('VALIDATION_FAILED');
    expect(refused.getStatus()).toBe(400);
    expect(refused.details).toEqual({ violations: [{ in: 'query', pointer, rule }] });
    expect(reads, 'no statement was attempted').toBe(0);
  });

  // Break caught: a hub judged only when it stands alone, so that a bad one beside filters that are good is read on.
  it('refuses a hub that is not one beside filters that are, and names it', async () => {
    const { error, reads } = await refusal(name, { open: 'true', hubId: 'nope', pageSize: 5 });

    expect((error as ApiException).details).toEqual({
      violations: [{ in: 'query', pointer: '/hub_id', rule: 'format' }],
    });
    expect(reads).toBe(0);
  });

  // Break caught: the principal judged after the filters (a caller who may not read learns what a filter may hold) or not judged by the service at all.
  it.each([
    ['a vendor', 'VENDOR'],
    ['a rider', 'RIDER'],
  ] as const)(
    'refuses %s with a 403 before it judges anything, even a filter that is not valid',
    async (_who, principalType) => {
      const { error, reads } = await refusal(
        name,
        { pageSize: 0, open: 'maybe', hubId: 'nope' },
        principal(principalType),
      );

      expect(error).toBeInstanceOf(ApiException);
      const refused = error as ApiException;
      expect(refused.code).toBe('PERMISSION_DENIED');
      expect(refused.getStatus()).toBe(403);
      expect(reads).toBe(0);
    },
  );

  // Break caught (AC-HUBF-05): a hub outside the grant that is still read, so that the time of the answer tells a caller whether the hub exists.
  it('answers a hub outside the grant, and a hub that is none, with an empty page and no statement', async () => {
    for (const hubId of [OTHER_HUB, '00000000-0000-0000-0000-000000000000']) {
      const { under, reads } = lists();

      await expect(ask(under, name, ONE_HUB, { hubId })).resolves.toEqual({
        items: [],
        next_page_token: null,
      });
      expect(reads(), hubId).toBe(0);
    }
  });

  // Break caught: the shortcut taken for every hub (a session that reads its own hub, or every hub, answered empty without a statement).
  it('reads when the hub is inside the grant, when no hub is named, and when the grant reaches every hub', async () => {
    const own = lists();
    await ask(own.under, name, ONE_HUB, { hubId: HUB, open: 'false', pageSize: 100 });
    const none = lists();
    await ask(none.under, name, ONE_HUB, { open: 'true' });
    const every = lists();
    await ask(every.under, name, EVERY_HUB, { hubId: OTHER_HUB });

    expect([own.reads(), none.reads(), every.reads()]).toEqual([1, 1, 1]);
  });
});
