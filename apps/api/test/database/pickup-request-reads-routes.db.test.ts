import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TestClient, TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { arrangedFixedSession } from './support/http-sessions.js';
import { insertPickupRequest, pickupRequestRow } from './support/pickups.js';
import { grant, newBundle } from './support/policy-fixtures.js';
import { API, HUB_A, HUB_B, codeOf } from './support/staff-routes.js';
import {
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from './support/vendor-routes.js';

/**
 * S1.13, `listPickupRequests` and `getPickupRequest` against the real application and a real PostgreSQL (`AC-SLICE-001-79`, in part:
 * the cancellation half completes at S1.17): what a reader sees of the requests follows the hubs of the grant for staff and the
 * organisation for a vendor; the read of one tells a request outside the staff reader's hubs (`HUB_SCOPE_VIOLATION`) from one that does
 * not exist (`NOT_FOUND`), and **tells a vendor nothing**: another vendor's request is answered exactly as an id that matches nothing; a
 * read of another hub is audited without contents; the ETag moves with the record; and no representation carries a price.
 */
const LIST = `${API}/pickup-requests`;
const ONE = (id: string) => `${LIST}/${id}`;

let routes: VendorRoutes;
let vendorOne: ArrangedVendor;
let vendorTwo: ArrangedVendor;
let browserOne: TestClient;
let browserTwo: TestClient;
const known: Record<string, string> = {};
/** The id of an arranged request, by its name in this file: a name that was never arranged fails here and not as a request for `undefined`. */
const id = (name: string): string => {
  const found = known[name];
  if (found === undefined) throw new Error(`no request was arranged as ${name}`);
  return found;
};

beforeAll(async () => {
  routes = await startVendorRoutes();
  vendorOne = await routes.vendor();
  vendorTwo = await routes.vendor();
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
  const make = async (
    name: string,
    vendor: ArrangedVendor,
    hub: string,
    overrides: Parameters<typeof pickupRequestRow>[2] = {},
  ): Promise<void> => {
    known[name] = (
      await insertPickupRequest(
        routes.admin,
        pickupRequestRow(vendor.row.organizationId, hub, overrides),
      )
    ).id;
  };
  // In creation order: the list is ordered by it.
  await make('oneInA', vendorOne, HUB_A, { serviceDate: '2026-11-03' });
  await make('oneInB', vendorOne, HUB_B, { serviceDate: '2026-11-03' });
  await make('twoInA', vendorTwo, HUB_A, { serviceDate: '2026-11-04', state: 'CONFIRMED' });
  await make('twoInB', vendorTwo, HUB_B, { serviceDate: '2026-11-05' });
  await make('oneInA2', vendorOne, HUB_A, { serviceDate: '2026-11-04', state: 'CONFIRMED' });
  await make('oneInA3', vendorOne, HUB_A, { serviceDate: '2026-11-06', state: 'CANCELLED' });
}, 120_000);

afterAll(async () => {
  await routes.stop();
});

interface Item {
  readonly id: string;
  readonly code: string;
  readonly state: string;
  readonly responsible_hub_id: string;
  readonly indicative_estimate: unknown;
  readonly sender_name: string | null;
}
interface Page {
  readonly items: Item[];
  readonly next_page_token: string | null;
}
const pageOf = (response: TestResponse): Page => response.json() as Page;
const idsOf = (response: TestResponse): string[] => pageOf(response).items.map((item) => item.id);

/** A random identifier is hex, so one in 4,096 begins with the letters of a word such as "fee": a scan for a priced field must not read an identifier as a word. */
const IDENTIFIER = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
/** The priced words that a key or a value in the text of an answer begins with, identifiers aside. */
const pricedIn = (text: string): string[] => {
  const words = text.replace(IDENTIFIER, 'an-identifier');
  return ['"price', '"total', '"quote', '"fee', '"amount_due'].filter((priced) =>
    words.includes(priced),
  );
};

/** What two answers must share to be indistinguishable: everything but the request's own identifier and the moment. */
const shapeOf = (response: TestResponse) => ({
  status: response.status,
  body: (() => {
    const body = response.json() as Record<string, unknown>;
    return { ...body, request_id: undefined };
  })(),
  headers: response
    .headerEntries()
    .filter(([name]) => !/^(date|x-request-id|request-id)$/.test(name)),
  cookies: response.setCookies,
});

describe('listPickupRequests: what each reader sees', () => {
  // Break caught: a list that crosses hubs, or a staff list that shows a vendor's request of another hub.
  it('shows Ops Staff the requests of the hubs of the grant, in the order they were made', async () => {
    const ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const answer = await ops.client.get(LIST);
    expect(answer.status).toBe(200);
    expect(idsOf(answer)).toEqual([id('oneInA'), id('twoInA'), id('oneInA2'), id('oneInA3')]);
    expect(pageOf(answer).next_page_token).toBeNull();

    const other = await routes.actor(BUNDLE_IDS.opsStaff, HUB_B);
    expect(idsOf(await other.client.get(LIST))).toEqual([id('oneInB'), id('twoInB')]);
  });

  // Break caught: a vendor shown another organisation's request (AC-SLICE-001-79), or restricted by hub (a vendor is never scoped by hub).
  it('shows a vendor its own organisation’s requests in every hub, and no one else’s', async () => {
    expect(idsOf(await browserOne.get(LIST))).toEqual([
      id('oneInA'),
      id('oneInB'),
      id('oneInA2'),
      id('oneInA3'),
    ]);
    expect(idsOf(await browserTwo.get(LIST))).toEqual([id('twoInA'), id('twoInB')]);
  });

  // Break caught: a representation that carries something priced, or an estimate a read is not entitled to give (S1.13: a read carries none).
  it('carries a sender name and the place the rider is sent, and no estimate and no price', async () => {
    const ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const [first] = pageOf(await ops.client.get(LIST)).items;
    expect(first).toMatchObject({
      id: id('oneInA'),
      state: 'PENDING',
      sender_name: 'Fixture Sender',
      resolved_pickup_location: { address: 'Fixture shop' },
      indicative_estimate: null,
      one_package_exception: null,
      rider_assigned: false,
    });
    expect(pricedIn(JSON.stringify(pageOf(await ops.client.get(LIST))))).toEqual([]);
    // The scan itself: it sees a priced field, and it does not take an identifier that begins with the letters of a word for one
    // (this test failed once on a request whose random identifier began with "fee").
    expect(pricedIn(JSON.stringify({ items: [{ fee_amount: 1 }] }))).toEqual(['"fee']);
    expect(
      pricedIn(JSON.stringify({ items: [{ id: 'fee2baf2-0ec0-43ef-b000-000000000000' }] })),
    ).toEqual([]);
  });

  // Break caught: a page that skips or repeats a row at its edge, or a token that is not a position.
  it('pages by an opaque position, without a row skipped or repeated', async () => {
    const ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const seen: string[] = [];
    let token: string | null = null;
    let pages = 0;
    do {
      const query = `?page_size=3${token === null ? '' : `&page_token=${token}`}`;
      const answer: TestResponse = await ops.client.get(`${LIST}${query}`);
      expect(answer.status).toBe(200);
      seen.push(...idsOf(answer));
      token = pageOf(answer).next_page_token;
      pages += 1;
    } while (token !== null && pages < 5);
    expect(pages).toBe(2);
    expect(seen).toEqual([id('oneInA'), id('twoInA'), id('oneInA2'), id('oneInA3')]);
  });

  it('filters by state and by service date, and answers the pool and the exception filters with the truth', async () => {
    const ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    expect(idsOf(await ops.client.get(`${LIST}?state=CONFIRMED`))).toEqual([
      id('twoInA'),
      id('oneInA2'),
    ]);
    expect(idsOf(await ops.client.get(`${LIST}?service_date=2026-11-04`))).toEqual([
      id('twoInA'),
      id('oneInA2'),
    ]);
    expect(idsOf(await ops.client.get(`${LIST}?state=CONFIRMED&service_date=2026-11-04`))).toEqual([
      id('twoInA'),
      id('oneInA2'),
    ]);
    // The pool: confirmed and on no manifest. No manifest exists yet, so every confirmed request is in it and none is on one.
    expect(idsOf(await ops.client.get(`${LIST}?state=CONFIRMED&manifested=false`))).toEqual([
      id('twoInA'),
      id('oneInA2'),
    ]);
    expect(idsOf(await ops.client.get(`${LIST}?manifested=true`))).toEqual([]);
    expect(idsOf(await ops.client.get(`${LIST}?one_package_exception_state=REQUESTED`))).toEqual(
      [],
    );
  });

  // Break caught: a filter or a page parameter read as a statement, or taken on trust, and an answer that is not the contract's 400.
  it.each([
    ['a page size of zero', 'page_size=0'],
    ['a page size over the maximum', 'page_size=101'],
    ['a page size that is not a number', 'page_size=many'],
    ['a service date that does not exist', 'service_date=2026-02-30'],
    ['a service date that is not a date', 'service_date=tomorrow'],
    ['a position that is not one', 'page_token=not-a-position'],
    ['a manifested filter that is not a boolean', 'manifested=maybe'],
    ['an exception state that is not one', 'one_package_exception_state=PENDING'],
    ['an empty state', 'state='],
  ])('refuses %s as a validation failure', async (_label, query) => {
    const ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const answer = await ops.client.get(`${LIST}?${query}`);
    expect(answer.status).toBe(400);
    expect(codeOf(answer)).toBe('VALIDATION_FAILED');
  });

  // Break caught: a position the list did not make, refused under another name than the screen that offers "back to the first page" looks for.
  // The contract cannot judge an opaque token, so the service refuses it and names it in its own form, `/page_token`, and not the bare name the
  // contract's validation gives a parameter it refuses (the Ops Portal's queue recognises this spelling).
  it('refuses a position that is not one, naming it as /page_token', async () => {
    const ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const answer = await ops.client.get(`${LIST}?page_token=not-a-position`);
    expect([answer.status, codeOf(answer)]).toEqual([400, 'VALIDATION_FAILED']);
    const violations = (answer.json() as { details?: { violations?: unknown } }).details
      ?.violations;
    expect(violations).toEqual([{ in: 'query', pointer: '/page_token', rule: 'format' }]);
  });
});

describe('who may ask', () => {
  // Break caught: a reader without the key of the operation served, or told anything but PERMISSION_DENIED.
  it('refuses a holder of another bundle’s keys: Finance holds no pickup.read', async () => {
    const finance = await routes.actor(BUNDLE_IDS.finance, null);
    for (const path of [LIST, ONE(id('oneInA'))]) {
      const answer = await finance.client.get(path);
      expect(answer.status, path).toBe(403);
      expect(codeOf(answer), path).toBe('PERMISSION_DENIED');
    }
  });

  it('refuses a request with no session', async () => {
    const answer = await routes.browser().get(LIST);
    expect(answer.status).toBe(401);
    expect(codeOf(answer)).toBe('SESSION_INVALID');
  });

  // Break caught: a Rider reaching a request. The registry gives it no direct read of the table; its key is for the stops it is assigned.
  it('shows a Rider no request, in the list or by id', async () => {
    const rider = await arrangedFixedSession(routes.kit, routes.admin, 'RIDER');
    const client = routes.kit.client.fork().bearer(rider.token);
    const list = await client.get(LIST);
    const one = await client.get(ONE(id('oneInA')));
    // Whatever the guard answers a Rider, it is never the request and never a page that holds one.
    if (list.status === 200) expect(idsOf(list)).toEqual([]);
    else expect([401, 403]).toContain(list.status);
    expect([403, 404]).toContain(one.status);
    expect(one.text).not.toContain(id('oneInA'));
  });
});

describe('getPickupRequest: the existence rule (AC-SLICE-001-79)', () => {
  it('answers a staff reader the request of its hub, with the version it can send back', async () => {
    const ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const answer = await ops.client.get(ONE(id('oneInA')));
    expect(answer.status).toBe(200);
    expect(answer.header('etag')).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
    expect(answer.json()).toMatchObject({
      id: id('oneInA'),
      state: 'PENDING',
      responsible_hub_id: HUB_A,
      declared_package_count: 3,
      scheduled_service_date: '2026-11-03',
    });
  });

  // Break caught: a staff reader told a request of another hub does not exist (the contract says where it is not), or told it of one that
  // does not exist.
  it('tells a staff reader a request outside its hubs from one that does not exist', async () => {
    const ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const outside = await ops.client.get(ONE(id('oneInB')));
    expect(outside.status).toBe(403);
    expect(codeOf(outside)).toBe('HUB_SCOPE_VIOLATION');
    const missing = await ops.client.get(ONE(randomUUID()));
    expect(missing.status).toBe(404);
    expect(codeOf(missing)).toBe('NOT_FOUND');
  });

  // Break caught: a vendor told that another vendor's request exists. Its answer must be the answer for an id that matches nothing:
  // status, code, body shape and every header but the request's own (`AC-SLICE-001-79`).
  it('answers a vendor asking for another vendor’s request exactly as for an id that matches nothing', async () => {
    const other = await browserOne.get(ONE(id('twoInA')));
    const nothing = await browserOne.get(ONE(randomUUID()));
    expect(nothing.status).toBe(404);
    expect(codeOf(nothing)).toBe('NOT_FOUND');
    expect(shapeOf(other)).toEqual(shapeOf(nothing));
    expect(other.text).not.toContain(id('twoInA'));

    const reverse = await browserTwo.get(ONE(id('oneInA')));
    expect(shapeOf(reverse)).toEqual(shapeOf(nothing));
  });

  it('answers a vendor its own request, whatever hub it is in', async () => {
    for (const name of ['oneInA', 'oneInB']) {
      const answer = await browserOne.get(ONE(id(name)));
      expect(answer.status, name).toBe(200);
      expect(answer.header('etag'), name).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
    }
  });

  // Break caught: an id that is not a UUID looked up as one, or answered as anything but a validation failure.
  it('refuses an id that is not a UUID as a validation failure', async () => {
    const ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const answer = await ops.client.get(ONE('not-a-uuid'));
    expect(answer.status).toBe(400);
    expect(codeOf(answer)).toBe('VALIDATION_FAILED');
  });
});

describe('the ETag (AC-SLICE-001-10)', () => {
  // Break caught: a token that does not move with the record, so that two Ops users confirming from one read both succeed.
  it('is the same for the same record and moves when the record does', async () => {
    const ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const first = (await ops.client.get(ONE(id('oneInA')))).header('etag');
    expect((await ops.client.get(ONE(id('oneInA')))).header('etag')).toBe(first);

    await routes.admin.query(
      `update pickup_request set secondary_phone = '+233200000077' where id = $1`,
      [id('oneInA')],
    );
    const second = (await ops.client.get(ONE(id('oneInA')))).header('etag');
    expect(second).not.toBe(first);
    expect(second).not.toBeNull();

    // A reader of another record gets another token, and the list carries none.
    expect((await ops.client.get(ONE(id('twoInA')))).header('etag')).not.toBe(second);
    expect((await ops.client.get(LIST)).header('etag')).toBeNull();
  });
});

describe('an authorised read of another hub is audited, without contents', () => {
  // Break caught: a read of another hub that leaves no record, or a record that carries the request.
  it('writes one hub-boundary event for the request, and none for a request of the actor’s own hub', async () => {
    const bundle = await newBundle(routes.admin, [grant('pickup.read', 'all', 'any', 'A')]);
    const reader = await routes.actor(bundle, HUB_A);
    const before = async () =>
      routes.rows<{ object_type: string; object_id: string; responsible_hub_id: string }>(
        `select object_type, object_id, responsible_hub_id from audit_event
          where event_code = 'auth.hub_boundary.crossed' and actor_id = $1 order by recorded_at, id`,
        [reader.identity.id],
      );
    expect((await reader.client.get(ONE(id('oneInA')))).status).toBe(200);
    expect(await before()).toEqual([]);

    expect((await reader.client.get(ONE(id('oneInB')))).status).toBe(200);
    expect(await before()).toEqual([
      { object_type: 'PickupRequest', object_id: id('oneInB'), responsible_hub_id: HUB_B },
    ]);

    const list = await reader.client.get(LIST);
    expect(list.status).toBe(200);
    const events = await before();
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ object_type: 'HUB', object_id: HUB_B });
    expect(JSON.stringify(events)).not.toContain('Fixture');
  });
});
