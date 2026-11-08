import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TestClient, TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { insertAdHocSender, insertVendorLocation } from './support/pickups.js';
import { API, HUB_A, HUB_B, codeOf } from './support/staff-routes.js';
import {
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from './support/vendor-routes.js';

/**
 * S1.14, the two reads that make a booking easy to enter (D-07 of 29 October 2026): `findAdHocSender` (a returning walk-in, by phone) and
 * `listVendorPickupLocations` (a vendor's saved places), against the real application and a real PostgreSQL (`AC-SLICE-001-69`, `-72`,
 * `-79`). Each has the existence rule of the registry: a sender is found by the office alone, and an organisation's places are read by
 * that vendor or by Ops at its hub, and by nobody else.
 */
const SENDERS = `${API}/ad-hoc-senders`;
const LOCATIONS = (organisation: string) =>
  `${API}/vendor-organizations/${organisation}/pickup-locations`;

let routes: VendorRoutes;
let vendorOne: ArrangedVendor;
let vendorTwo: ArrangedVendor;
let vendorInB: ArrangedVendor;
let browserOne: TestClient;
let browserTwo: TestClient;

beforeAll(async () => {
  routes = await startVendorRoutes();
  vendorOne = await routes.vendor();
  vendorTwo = await routes.vendor();
  vendorInB = await routes.vendor({ hubId: HUB_B });
  browserOne = routes.browser(vendorOne.device.credential.token);
  browserTwo = routes.browser(vendorTwo.device.credential.token);
  for (const [browser, vendor] of [
    [browserOne, vendorOne],
    [browserTwo, vendorTwo],
  ] as const) {
    expect((await routes.signIn(browser, vendor.row.accountIdentifier, vendor.secret)).status).toBe(
      200,
    );
  }
  await insertVendorLocation(routes.admin, vendorOne.row.organizationId, {
    label: 'Shop',
    address: 'Shop 4, Community 1',
    isDefault: true,
  });
  await insertVendorLocation(routes.admin, vendorOne.row.organizationId, {
    label: 'Warehouse',
    address: 'Warehouse 2, Spintex',
  });
  await insertVendorLocation(routes.admin, vendorOne.row.organizationId, {
    label: 'Old stall',
    address: 'The old stall',
    active: false,
  });
  await insertVendorLocation(routes.admin, vendorTwo.row.organizationId, {
    label: 'Theirs',
    address: 'Somewhere else',
    isDefault: true,
  });
  await insertVendorLocation(routes.admin, vendorInB.row.organizationId, {
    label: 'Kumasi shop',
    address: 'Adum, Kumasi',
    isDefault: true,
  });
}, 180_000);

afterAll(async () => {
  await routes.stop();
});

const shapeOf = (response: TestResponse) => ({
  status: response.status,
  body: { ...(response.json() as Record<string, unknown>), request_id: undefined },
  headers: response
    .headerEntries()
    .filter(([name]) => !/^(date|x-request-id|request-id)$/.test(name)),
});

describe('findAdHocSender (AC-SLICE-001-72)', () => {
  // Break caught: a returning walk-in not found by the number as the office types it, or found with more than it was asked for.
  it('finds a reusable sender by the phone as entered, in any spelling', async () => {
    const sender = await insertAdHocSender(routes.admin, {
      phone: '+233246660101',
      state: 'REUSABLE',
      name: 'Regular Walk-in',
    });
    const ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    for (const entered of ['+233246660101', '0246660101', '024 666 0101', '233246660101']) {
      const answer = await ops.client.get(`${SENDERS}?phone=${encodeURIComponent(entered)}`);
      expect(answer.status, entered).toBe(200);
      expect(answer.json(), entered).toEqual({
        items: [
          {
            id: sender.id,
            display_name: 'Regular Walk-in',
            phone: '+233246660101',
            state: 'REUSABLE',
          },
        ],
      });
    }
  });

  // Break caught: a lookup that says which numbers belong to senders (a 404), or that offers a sender whose first pickup has not completed.
  it('answers an unknown phone and a provisional sender with an empty list, not an error', async () => {
    await insertAdHocSender(routes.admin, { phone: '+233247770202', state: 'PROVISIONAL' });
    const ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    for (const phone of ['+233245550000', '0247770202']) {
      const answer = await ops.client.get(`${SENDERS}?phone=${encodeURIComponent(phone)}`);
      expect(answer.status, phone).toBe(200);
      expect(answer.json(), phone).toEqual({ items: [] });
    }
  });

  it.each([
    ['a number that is not one', 'abc'],
    ['a short number', '12345'],
    ['no number at all', ''],
  ])('refuses %s as a validation failure naming the phone', async (_label, phone) => {
    const ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const answer = await ops.client.get(`${SENDERS}?phone=${encodeURIComponent(phone)}`);
    expect(answer.status).toBe(400);
    expect(codeOf(answer)).toBe('VALIDATION_FAILED');
  });

  it('refuses a request with no phone parameter at all', async () => {
    const ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const answer = await ops.client.get(SENDERS);
    expect(answer.status).toBe(400);
    expect(codeOf(answer)).toBe('VALIDATION_FAILED');
  });

  // Break caught: a sender readable by a vendor or by a caller with no session (the registry denies a vendor and a rider any read).
  it('is the office’s: a vendor and a caller with no session are refused', async () => {
    const asVendor = await browserOne.get(
      `${SENDERS}?phone=${encodeURIComponent('+233246660101')}`,
    );
    expect([403, 401]).toContain(asVendor.status);
    expect(asVendor.text).not.toContain('Regular Walk-in');
    const anonymous = await routes
      .browser()
      .get(`${SENDERS}?phone=${encodeURIComponent('+233246660101')}`);
    expect(anonymous.status).toBe(401);
    expect(codeOf(anonymous)).toBe('SESSION_INVALID');
  });
});

describe('listVendorPickupLocations (AC-SLICE-001-69, -79)', () => {
  interface Listed {
    readonly items: readonly {
      label: string;
      is_default: boolean;
      active: boolean;
      vendor_organization_id: string;
    }[];
  }

  // Break caught: the default not first, a retired place hidden from the office that manages it, or another organisation's place listed.
  it('lists a vendor’s places for that vendor, the default first, the retired included', async () => {
    const answer = await browserOne.get(LOCATIONS(vendorOne.row.organizationId));
    expect(answer.status).toBe(200);
    const listed = answer.json() as Listed;
    expect(listed.items.map((item) => item.label)).toEqual(['Shop', 'Warehouse', 'Old stall']);
    expect(listed.items.map((item) => [item.is_default, item.active])).toEqual([
      [true, true],
      [false, true],
      [false, false],
    ]);
    expect(
      listed.items.every((item) => item.vendor_organization_id === vendorOne.row.organizationId),
    ).toBe(true);
    expect(listed.items[0]).toMatchObject({ location: { address: 'Shop 4, Community 1' } });
  });

  it('lists the same places for Ops at the vendor’s hub', async () => {
    const ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const answer = await ops.client.get(LOCATIONS(vendorOne.row.organizationId));
    expect(answer.status).toBe(200);
    expect((answer.json() as Listed).items).toHaveLength(3);
  });

  // Break caught: Ops reading the places of a vendor of another hub, or told it does not exist when it does.
  it('tells Ops a vendor outside its hubs from one that does not exist', async () => {
    const ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const outside = await ops.client.get(LOCATIONS(vendorInB.row.organizationId));
    expect(outside.status).toBe(403);
    expect(codeOf(outside)).toBe('HUB_SCOPE_VIOLATION');
    const none = await ops.client.get(LOCATIONS(randomUUID()));
    expect(none.status).toBe(404);
    expect(codeOf(none)).toBe('NOT_FOUND');
  });

  // Break caught: a vendor told that another vendor exists (AC-SLICE-001-79): the answer must be the one for an id that matches nothing.
  it('answers a vendor asking for another’s places exactly as for an id that matches nothing', async () => {
    const other = await browserOne.get(LOCATIONS(vendorTwo.row.organizationId));
    const none = await browserOne.get(LOCATIONS(randomUUID()));
    expect(none.status).toBe(404);
    expect(codeOf(none)).toBe('NOT_FOUND');
    expect(shapeOf(other)).toEqual(shapeOf(none));
    expect(other.text).not.toContain('Theirs');
    expect(shapeOf(await browserTwo.get(LOCATIONS(vendorOne.row.organizationId)))).toEqual(
      shapeOf(none),
    );
  });

  it('refuses a holder of another bundle’s keys and a caller with no session', async () => {
    const finance = await routes.actor(BUNDLE_IDS.finance, null);
    const refused = await finance.client.get(LOCATIONS(vendorOne.row.organizationId));
    expect(refused.status).toBe(403);
    expect(codeOf(refused)).toBe('PERMISSION_DENIED');
    expect((await routes.browser().get(LOCATIONS(vendorOne.row.organizationId))).status).toBe(401);
  });

  it('refuses an id that is not a UUID as a validation failure', async () => {
    const ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const answer = await ops.client.get(LOCATIONS('not-a-uuid'));
    expect(answer.status).toBe(400);
    expect(codeOf(answer)).toBe('VALIDATION_FAILED');
  });
});
