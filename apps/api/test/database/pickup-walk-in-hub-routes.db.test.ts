import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TestClient, TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { insertVendorLocation } from './support/pickups.js';
import { grant, newBundle } from './support/policy-fixtures.js';
import { seedHubConfiguration } from './support/seeded.js';
import { API, HUB_A, HUB_B, OPS, codeOf, type Actor } from './support/staff-routes.js';
import {
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from './support/vendor-routes.js';

/**
 * Task P1 (`AC-SLICE-001-82`, `OB-S1-76`; permissions.md section 5): a walk-in booking is made in a hub the session's grant reaches, and
 * **names the hub when the grant reaches more than one** (`hub_id` on `createPickupRequest`). The seeded Platform Admin has no primary hub and
 * a grant of all hubs, so it books in the hub it names; an Ops Staff officer of one hub books in their own with or without naming it, and never
 * in another; a booking for a registered vendor is in the vendor organisation's hub whoever makes it. Against the real application and a real
 * PostgreSQL. The first hub is configured (its fees are the owner's); the second has no configuration, and a missing fee never blocks a
 * booking.
 */
const LIST = `${API}/pickup-requests`;
const WEDNESDAY = '2026-11-04';

let routes: VendorRoutes;
let hubless: Actor;
let officer: Actor;
let allHubs: Actor;
let vendorOne: ArrangedVendor;
let browserOne: TestClient;
let phones = 0;

beforeAll(async () => {
  routes = await startVendorRoutes();
  await seedHubConfiguration(routes.database);
  vendorOne = await routes.vendor();
  browserOne = routes.browser(vendorOne.device.credential.token);
  expect(
    (await routes.signIn(browserOne, vendorOne.row.accountIdentifier, vendorOne.secret)).status,
  ).toBe(200);
  await insertVendorLocation(routes.admin, vendorOne.row.organizationId, {
    label: 'Shop',
    address: 'Shop 4, Community 1, Tema',
    isDefault: true,
  });
  hubless = await routes.platformAdmin();
  officer = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  // A session of another bundle that reaches every hub, with a primary hub: the rule is the grant's, never the bundle's name or a hub the
  // person happens to have.
  allHubs = await routes.actor(
    await newBundle(routes.admin, [grant('pickup.request.create', 'all')]),
    HUB_A,
  );
}, 180_000);

afterAll(async () => {
  await routes.stop();
});

/** A walk-in whose sender has a phone of its own, so that no booking meets another's sender. */
function walkIn(over: Record<string, unknown> = {}): Record<string, unknown> {
  phones += 1;
  return {
    pickup_intent: 'ADHOC_SENDER',
    new_ad_hoc_sender: {
      name: 'Kwame Walk-in',
      phone: `020 555 ${String(1000 + phones)}`,
      pickup_location: { address: 'Kiosk by the Tema station' },
    },
    current_item_description: 'Phone accessories',
    scheduled_service_date: WEDNESDAY,
    declared_package_count: 2,
    default_payer_intent: 'SENDER_PAYS_FULL',
    ...over,
  };
}

const ownPackages = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  pickup_intent: 'OWN_PACKAGES',
  vendor_organization_id: vendorOne.row.organizationId,
  scheduled_service_date: WEDNESDAY,
  declared_package_count: 3,
  default_payer_intent: 'RECIPIENT_PAYS',
  primary_phone: '024 123 4567',
  ...over,
});

const book = (
  client: TestClient,
  body: Record<string, unknown>,
  idempotencyKey: string = randomUUID(),
): Promise<TestResponse> =>
  client.post(LIST, body, {
    ...(client === browserOne ? {} : { origin: OPS }),
    headers: { 'Idempotency-Key': idempotencyKey },
  });

interface Created {
  readonly id: string;
  readonly code: string;
  readonly responsible_hub_id: string;
}
const createdOf = (response: TestResponse): Created => response.json() as Created;
const violationsOf = (response: TestResponse): unknown =>
  (response.json() as { details?: { violations?: unknown } }).details?.violations;
const requestsStored = async (): Promise<number> =>
  (await routes.rows<{ n: number }>(`select count(*)::int as n from pickup_request`))[0]?.n ?? 0;

describe('a Platform Admin with no primary hub books a walk-in in the hub it names (OB-S1-76)', () => {
  // Break caught: the form offered and the submit refused 403 HUB_SCOPE_VIOLATION (the defect), or a hub chosen for the person when its grant
  // reaches every hub.
  it('is asked for the hub when it names none, and writes nothing', async () => {
    const before = await requestsStored();

    const answer = await book(hubless.client, walkIn());

    expect([answer.status, codeOf(answer)]).toEqual([400, 'VALIDATION_FAILED']);
    expect(violationsOf(answer)).toEqual([{ in: 'body', pointer: '/hub_id', rule: 'required' }]);
    expect(await requestsStored()).toBe(before);
  });

  // Break caught: the hub named taken for the actor's own (there is none), or the booking's code, estimate or events made in another hub.
  it.each([
    ['the first hub', HUB_A],
    ['the second hub', HUB_B],
  ])('books in %s when it names it', async (_name, hub) => {
    const answer = await book(hubless.client, walkIn({ hub_id: hub }));

    expect(answer.status).toBe(201);
    const created = createdOf(answer);
    expect(created.responsible_hub_id).toBe(hub);
    const events = await routes.rows<{ responsible_hub_id: string }>(
      `select responsible_hub_id from audit_event where event_code = 'pickup.request.created' and object_id = $1`,
      [created.id],
    );
    expect(events.map((row) => row.responsible_hub_id)).toEqual([hub]);
  });

  // Break caught: an id that names no hub reaching the configuration of the company (a server error) or being accepted.
  it('is refused an id that names no hub, naming the field', async () => {
    const answer = await book(hubless.client, walkIn({ hub_id: randomUUID() }));

    expect([answer.status, codeOf(answer)]).toEqual([400, 'VALIDATION_FAILED']);
    expect(violationsOf(answer)).toEqual([{ in: 'body', pointer: '/hub_id', rule: 'enum' }]);
  });

  // Break caught: the rule read from the bundle's name or from a primary hub the person has: it is the grant's reach.
  it('is the same for any session whose grant reaches every hub: it names the hub, though it has a primary hub', async () => {
    const without = await book(allHubs.client, walkIn());
    expect([without.status, codeOf(without)]).toEqual([400, 'VALIDATION_FAILED']);
    expect(violationsOf(without)).toEqual([{ in: 'body', pointer: '/hub_id', rule: 'required' }]);

    const named = await book(allHubs.client, walkIn({ hub_id: HUB_B }));
    expect(named.status).toBe(201);
    expect(createdOf(named).responsible_hub_id).toBe(HUB_B);
  });
});

describe('an Ops Staff officer of one hub books in their own, and never in another (AC-SLICE-001-82)', () => {
  // Break caught: a hub required of a person whose grant reaches one hub (every existing client would stop working), or the primary hub
  // ignored.
  it('books in their own hub without naming it, and with the hub named', async () => {
    const without = await book(officer.client, walkIn());
    const named = await book(officer.client, walkIn({ hub_id: HUB_A }));

    expect([without.status, named.status]).toEqual([201, 201]);
    expect(createdOf(without).responsible_hub_id).toBe(HUB_A);
    expect(createdOf(named).responsible_hub_id).toBe(HUB_A);
  });

  // Break caught: the hub named read as an instruction (the booking made in a hub the grant does not reach), or a refusal that wrote a request.
  it('is refused a hub outside their grant, HUB_SCOPE_VIOLATION, and nothing is written', async () => {
    const before = await requestsStored();

    const answer = await book(officer.client, walkIn({ hub_id: HUB_B }));

    expect([answer.status, codeOf(answer)]).toEqual([403, 'HUB_SCOPE_VIOLATION']);
    expect(await requestsStored()).toBe(before);
  });

  // The review of P1 (6 November 2026): the scope is judged before the hub is read, as it is for `createStaffIdentity`. Break caught: an
  // officer told "no such hub" (400) for an id that names none and "not your hub" (403) for one that does, which tells them which ids are
  // hubs they cannot reach.
  it('is refused an id that names no hub as a hub outside their grant, HUB_SCOPE_VIOLATION, and nothing is written', async () => {
    const before = await requestsStored();

    const answer = await book(officer.client, walkIn({ hub_id: randomUUID() }));

    expect([answer.status, codeOf(answer)]).toEqual([403, 'HUB_SCOPE_VIOLATION']);
    expect(await requestsStored()).toBe(before);
  });

  // Break caught: a hub outside the grant judged after the sender (an unknown sender is 400, a sender found by phone 409) so that the refusal
  // of the hub waits behind facts the caller may not learn.
  it('is refused a hub outside their grant before anything of the sender is judged', async () => {
    const before = await requestsStored();

    const answer = await book(
      officer.client,
      walkIn({ hub_id: HUB_B, new_ad_hoc_sender: undefined, ad_hoc_sender_id: randomUUID() }),
    );

    expect([answer.status, codeOf(answer)]).toEqual([403, 'HUB_SCOPE_VIOLATION']);
    expect(await requestsStored()).toBe(before);
  });
});

describe('a booking for a registered vendor is in the vendor organisation’s hub', () => {
  // Break caught: a hub named for a vendor's booking moving it to another hub than the organisation's, or refused when it is the same.
  it('accepts the organisation’s own hub and refuses another, for the office and for the vendor', async () => {
    const same = await book(hubless.client, ownPackages({ hub_id: HUB_A }));
    expect(same.status).toBe(201);
    expect(createdOf(same).responsible_hub_id).toBe(HUB_A);

    const other = await book(hubless.client, ownPackages({ hub_id: HUB_B }));
    expect([other.status, codeOf(other)]).toEqual([400, 'VALIDATION_FAILED']);
    expect(violationsOf(other)).toEqual([{ in: 'body', pointer: '/hub_id', rule: 'enum' }]);

    const mine = await book(browserOne, ownPackages({ hub_id: HUB_A }));
    expect(mine.status).toBe(201);
    const theirs = await book(browserOne, ownPackages({ hub_id: HUB_B }));
    expect([theirs.status, codeOf(theirs)]).toEqual([400, 'VALIDATION_FAILED']);
  });
});

describe('the same booking sent again (AC-SLICE-001-82)', () => {
  // Break caught: the hub left out of the fingerprint of the command, so that the same key with another hub replays the first answer.
  it('replays the first answer for the same key and body, and refuses the same key with another hub', async () => {
    const key = randomUUID();
    const body = walkIn({ hub_id: HUB_B });

    const first = await book(hubless.client, body, key);
    const again = await book(hubless.client, body, key);
    const changed = await book(hubless.client, { ...body, hub_id: HUB_A }, key);

    expect([first.status, again.status]).toEqual([201, 201]);
    expect(createdOf(again).id).toBe(createdOf(first).id);
    expect([changed.status, codeOf(changed)]).toEqual([409, 'IDEMPOTENCY_KEY_CONFLICT']);
  });
});
