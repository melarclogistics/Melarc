import { describe, expect, it } from 'vitest';

import { SIGNED_IN_ROUTES } from '../../app/navigation/route-registry';
import { RECORD_LOOKUP_KINDS } from './record-lookup-shape';
import { recordRoute } from './record-route';

/**
 * The page that opens a record the lookup found (`AC-LOOKUP-12`, the Product Owner's decision D1 of 6 November 2026): the Portal's own mapping
 * of a kind and an id, because the API names no page. Each route must be a page the registry has, so a rename of a page cannot leave the search
 * pointing nowhere.
 */
const ID = '6a7b8c9d-0e1f-4a2b-9c3d-4e5f6a7b8c9d';

describe('the page that opens a record the lookup found', () => {
  // Break caught: a kind sent to the page of another, or to a page this application does not have.
  it.each([
    ['PICKUP_REQUEST', `/pickup-requests/${ID}`],
    ['PICKUP_MANIFEST', `/manifests/${ID}`],
    ['VENDOR_ACCOUNT', `/admin/vendors/${ID}`],
    ['RIDER', `/admin/riders/${ID}`],
    ['STAFF_IDENTITY', `/admin/staff/${ID}`],
  ] as const)('opens %s at %s', (kind, route) => {
    expect(recordRoute(kind, ID)).toBe(route);
  });

  // Break caught: a kind added to the contract and the guard whose page nobody chose.
  it('has a route for every kind the guard recognises, and each is a page of the registry', () => {
    const patterns = new Set(SIGNED_IN_ROUTES.map((route) => route.path));
    for (const kind of RECORD_LOOKUP_KINDS) {
      const route = recordRoute(kind, ID);
      expect(route, kind).toBeDefined();
      expect(patterns, kind).toContain((route ?? '').replace(ID, ':id'));
    }
  });

  // Break caught: an id that is not an identifier becoming part of a path (a way out of the page, a query, another site).
  it.each([
    '',
    'not-an-id',
    '../admin/staff',
    `${ID}/../x`,
    `${ID}?next=//evil.example`,
    `${ID}#x`,
    '//evil.example',
    `${ID}\n`,
    ID.toUpperCase().slice(0, -1),
  ])('opens nothing for the id %j', (id) => {
    for (const kind of RECORD_LOOKUP_KINDS) expect(recordRoute(kind, id), kind).toBeUndefined();
  });
});
