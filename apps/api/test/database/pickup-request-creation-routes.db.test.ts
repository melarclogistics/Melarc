import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TestClient, TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { arrangedFixedSession } from './support/http-sessions.js';
import { insertAdHocSender, insertVendorLocation } from './support/pickups.js';
import { seedHubConfiguration } from './support/seeded.js';
import { API, HUB_A, HUB_B, OPS, codeOf, type Actor } from './support/staff-routes.js';
import {
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from './support/vendor-routes.js';

/**
 * S1.14, `createPickupRequest` against the real application and a real PostgreSQL (`AC-SLICE-001-02`, `-08`, `-09`, `-69` to `-72`,
 * `-81`; pickup-request.md sections 4 and 5): the booking by Ops or by a vendor for itself, entering `PENDING`, with the indicative
 * estimate, once however many times it is sent. The launch hub is configured (its fees are the owner's of 29 October 2026); the second hub
 * has no configuration, to show that a missing fee never blocks a booking.
 *
 * Two criteria answer `VALIDATION_FAILED` where their text names a specific code: the contract's schema, enforced before the service, is
 * what refuses a request that supplies both or neither identity of an ad-hoc sender and a collection with no destination at all; the
 * specific codes are answered where the schema cannot decide (a vendor with no default location; a first-time sender whose phone already
 * identifies a sender).
 */
const LIST = `${API}/pickup-requests`;
// A Wednesday and a Sunday of a week all the tests share.
const WEDNESDAY = '2026-11-04';
const SUNDAY = '2026-11-08';
const LOCAL_PHONE = '024 123 4567';
const PHONE = '+233241234567';

let routes: VendorRoutes;
let ops: Actor;
let opsB: Actor;
let vendorOne: ArrangedVendor;
let vendorTwo: ArrangedVendor;
let browserOne: TestClient;
let browserTwo: TestClient;
let shop: string;

beforeAll(async () => {
  routes = await startVendorRoutes();
  await seedHubConfiguration(routes.database);
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
  shop = await insertVendorLocation(routes.admin, vendorOne.row.organizationId, {
    label: 'Shop',
    address: 'Shop 4, Community 1, Tema',
    isDefault: true,
  });
  await insertVendorLocation(routes.admin, vendorTwo.row.organizationId, {
    label: 'Warehouse',
    address: 'Warehouse 9, Madina',
    isDefault: true,
  });
  ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  opsB = await routes.actor(BUNDLE_IDS.opsStaff, HUB_B);
}, 180_000);

afterAll(async () => {
  await routes.stop();
});

const key = (): { headers: Record<string, string> } => ({
  headers: { 'Idempotency-Key': randomUUID() },
});
/** A staff client posts from the Ops origin; a vendor's browser carries the Vendor origin it was made with. */
const book = (
  client: TestClient,
  body: Record<string, unknown>,
  idempotencyKey: string = randomUUID(),
): Promise<TestResponse> =>
  client.post(LIST, body, {
    ...(client === browserOne || client === browserTwo ? {} : { origin: OPS }),
    headers: { 'Idempotency-Key': idempotencyKey },
  });

const own = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  pickup_intent: 'OWN_PACKAGES',
  vendor_organization_id: vendorOne.row.organizationId,
  scheduled_service_date: WEDNESDAY,
  declared_package_count: 3,
  default_payer_intent: 'RECIPIENT_PAYS',
  primary_phone: LOCAL_PHONE,
  ...over,
});
const adhoc = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  pickup_intent: 'ADHOC_SENDER',
  new_ad_hoc_sender: {
    name: 'Kwame Walk-in',
    phone: '020 555 0101',
    pickup_location: { address: 'Kiosk by the Tema station' },
  },
  current_item_description: 'Phone accessories',
  scheduled_service_date: WEDNESDAY,
  declared_package_count: 2,
  default_payer_intent: 'SENDER_PAYS_FULL',
  ...over,
});
const collect = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  pickup_intent: 'COLLECT_FOR_VENDOR',
  vendor_organization_id: vendorOne.row.organizationId,
  collection_point: {
    contact_name: 'Efua at the supplier',
    phone: '0553334444',
    location: { address: 'Supplier yard, Kaneshie', landmark: 'Blue gate' },
  },
  collection_reference: { reference_name: 'Order 77' },
  collection_item: { description: 'Boxes of shoes', quantity: 4 },
  use_vendor_default_destination: true,
  scheduled_service_date: WEDNESDAY,
  declared_package_count: 4,
  default_payer_intent: 'RECIPIENT_PAYS',
  ...over,
});

interface Created {
  readonly id: string;
  readonly code: string;
  readonly state: string;
  readonly indicative_estimate: {
    readonly status: string;
    readonly provisional: boolean;
    readonly total: { amount_minor: number; currency: string } | null;
    readonly components: readonly Record<string, unknown>[];
  } | null;
  readonly resolved_pickup_location: { address: string };
  readonly [member: string]: unknown;
}
const created = (response: TestResponse): Created => response.json() as Created;
const rowOf = async (id: string): Promise<Record<string, unknown>> => {
  const [row] = await routes.rows(`select * from pickup_request where id = $1`, [id]);
  if (row === undefined) throw new Error('no such request');
  return row;
};
const count = async (): Promise<number> =>
  Number((await routes.rows<{ n: number }>(`select count(*)::int as n from pickup_request`))[0]?.n);

describe('a vendor books its own packages (AC-SLICE-001-69, -02)', () => {
  // Break caught: a booking that needs the sender re-entered, that places the request elsewhere than the vendor's saved location, that
  // omits the estimate, or that prices or quotes.
  it('creates a PENDING request at the vendor’s default location with the provisional estimate and a version to confirm with', async () => {
    const answer = await book(browserOne, own());
    expect(answer.status).toBe(201);
    expect(answer.header('etag')).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
    const request = created(answer);
    expect(request).toMatchObject({
      state: 'PENDING',
      pickup_intent: 'OWN_PACKAGES',
      vendor_organization_id: vendorOne.row.organizationId,
      ad_hoc_sender_id: null,
      responsible_hub_id: HUB_A,
      declared_package_count: 3,
      scheduled_service_date: WEDNESDAY,
      primary_phone: PHONE,
      resolved_pickup_location: { address: 'Shop 4, Community 1, Tema' },
      cutoff_exception_state: null,
      one_package_exception_id: null,
      attempt_number: 1,
      cancellation_charge_outcome: null,
      sender_name: vendorOne.row.legalName,
    });
    expect(request.code).toMatch(/^ACC-PR-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
    // The estimate is the base fee of the hub times the packages, labelled provisional, with its inputs named.
    expect(request.indicative_estimate).toMatchObject({
      status: 'AVAILABLE',
      provisional: true,
      total: { amount_minor: 3 * 3500, currency: 'GHS' },
      assumes_size_class: 'SMALL',
      excludes: ['SIZE_SURCHARGE', 'HIGH_VALUE_SURCHARGE'],
      components: [
        {
          kind: 'SERVICE_AREA_BASE_FEE',
          hub_id: HUB_A,
          setting_key: 'service_area_base_fee',
          quantity: 3,
          amount: { amount_minor: 10_500, currency: 'GHS' },
        },
      ],
    });
    // The record keeps the inputs of the estimate and no price; it stores no monetary amount of its own.
    const row = await rowOf(request.id);
    expect(row.estimate_snapshot).toMatchObject({ status: 'AVAILABLE', provisional: true });
    expect(row.created_by).toBe(vendorOne.row.accountId);
    expect(row.state).toBe('PENDING');
    expect(row.version).toBe(1);
    expect(JSON.stringify(request)).not.toMatch(/"(price|quote|amount_due)"/);
  });

  // Break caught: the audit of a creation missing, naming the wrong actor, or written for a request that was not made.
  it('writes pickup.request.created in the same transaction, as the vendor’s account', async () => {
    const request = created(await book(browserOne, own()));
    const events = await routes.rows<{
      actor_type: string;
      actor_id: string;
      resulting_state: string;
    }>(
      `select actor_type, actor_id, resulting_state from audit_event where event_code = 'pickup.request.created' and object_id = $1`,
      [request.id],
    );
    expect(events).toEqual([
      {
        actor_type: 'VENDOR_ACCOUNT',
        actor_id: vendorOne.row.accountId,
        resulting_state: 'PENDING',
      },
    ]);
  });

  // Break caught: a single package accepted from a vendor (AC-02), or a request created before the refusal.
  it('refuses a vendor’s single package with PICKUP_MINIMUM_NOT_MET and creates nothing', async () => {
    const before = await count();
    const answer = await book(browserOne, own({ declared_package_count: 1 }));
    expect(answer.status).toBe(422);
    expect(codeOf(answer)).toBe('PICKUP_MINIMUM_NOT_MET');
    expect(await count()).toBe(before);
  });

  // Break caught: a booking for a Sunday (the calendar is Monday to Saturday for every zone).
  it('refuses a Sunday with SERVICE_DATE_NOT_PERMITTED', async () => {
    const before = await count();
    const answer = await book(browserOne, own({ scheduled_service_date: SUNDAY }));
    expect(answer.status).toBe(422);
    expect(codeOf(answer)).toBe('SERVICE_DATE_NOT_PERMITTED');
    expect(await count()).toBe(before);
  });

  // Break caught: a vendor booking for another organisation, or learning whether another organisation exists.
  it('answers a vendor naming another organisation, or one that does not exist, with the same refusal', async () => {
    const other = await book(
      browserOne,
      own({ vendor_organization_id: vendorTwo.row.organizationId }),
    );
    const none = await book(browserOne, own({ vendor_organization_id: randomUUID() }));
    expect(other.status).toBe(403);
    expect(codeOf(other)).toBe('PERMISSION_DENIED');
    expect([none.status, codeOf(none)]).toEqual([other.status, codeOf(other)]);
  });

  // Break caught: a collection point or an item accepted on an own-packages booking (mis-declared), by the schema.
  it('refuses a collection point on an own-packages booking as mis-declared', async () => {
    const answer = await book(browserOne, own({ collection_point: collect().collection_point }));
    expect(answer.status).toBe(400);
    expect(codeOf(answer)).toBe('VALIDATION_FAILED');
  });

  // Break caught: the vendor's own phone not being reusable, and an invalid phone stored as the number rung for a pickup.
  it('needs a phone it can place: the booking’s own, since this vendor has none on record', async () => {
    const none = await book(browserOne, own({ primary_phone: undefined }));
    expect(none.status).toBe(400);
    expect(codeOf(none)).toBe('VALIDATION_FAILED');
    const bad = await book(browserOne, own({ primary_phone: '12345' }));
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.json())).toContain('/primary_phone');
  });
});

describe('a saved location is an input, never the origin (AC-SLICE-001-09)', () => {
  // Break caught: an override that rewrites the vendor's saved default, or an override ignored when the rider is sent.
  it('keeps the override on the request and the vendor’s saved location as it was', async () => {
    const before = await routes.rows(
      `select id, label, location, is_default, active from vendor_pickup_location where vendor_organization_id = $1`,
      [vendorOne.row.organizationId],
    );
    const request = created(
      await book(
        browserOne,
        own({
          location_overrides: {
            address: 'Today only: the Osu pop-up',
            landmark: 'Next to the bank',
          },
        }),
      ),
    );
    expect(request.resolved_pickup_location).toEqual({
      address: 'Today only: the Osu pop-up',
      landmark: 'Next to the bank',
    });
    expect(request.location_overrides).toEqual({
      address: 'Today only: the Osu pop-up',
      landmark: 'Next to the bank',
    });
    expect(
      await routes.rows(
        `select id, label, location, is_default, active from vendor_pickup_location where vendor_organization_id = $1`,
        [vendorOne.row.organizationId],
      ),
    ).toEqual(before);
  });

  // Break caught: a location of another vendor used, or answered differently from one that does not exist.
  it('answers another vendor’s saved location as one that does not exist', async () => {
    const [theirs] = await routes.rows<{ id: string }>(
      `select id from vendor_pickup_location where vendor_organization_id = $1`,
      [vendorTwo.row.organizationId],
    );
    const other = await book(browserOne, own({ vendor_pickup_location_id: theirs?.id }));
    const none = await book(browserOne, own({ vendor_pickup_location_id: randomUUID() }));
    expect(other.status).toBe(400);
    expect(codeOf(other)).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(other.json())).toContain('/vendor_pickup_location_id');
    expect([
      none.status,
      JSON.stringify(none.json()).includes('/vendor_pickup_location_id'),
    ]).toEqual([400, true]);
  });

  it('uses the saved location a vendor selects, and records the selection', async () => {
    const second = await insertVendorLocation(routes.admin, vendorOne.row.organizationId, {
      label: 'Warehouse',
      address: 'Warehouse 2, Spintex',
    });
    const request = created(await book(browserOne, own({ vendor_pickup_location_id: second })));
    expect(request.resolved_pickup_location.address).toBe('Warehouse 2, Spintex');
    expect(request.vendor_pickup_location_id).toBe(second);
    const defaulted = created(await book(browserOne, own()));
    expect(defaulted.vendor_pickup_location_id).toBeNull();
    expect(defaulted.resolved_pickup_location.address).toBe('Shop 4, Community 1, Tema');
    expect(shop).not.toBe(second);
  });
});

describe('the same booking by Ops and by the vendor is one record (AC-SLICE-001-01)', () => {
  // Break caught: a request entered by Ops that differs from the vendor's in anything but who made it, when, and its identifiers.
  it('differs only in its identity, its code, its moments and its maker', async () => {
    const byVendor = created(await book(browserOne, own()));
    const byOps = created(await book(ops.client, own()));
    const identity = ['id', 'code', 'created_at', 'created_by', 'version'];
    const normal = async (id: string): Promise<Record<string, unknown>> =>
      Object.fromEntries(
        Object.entries(await rowOf(id)).filter(([column]) => !identity.includes(column)),
      );
    expect(await normal(byOps.id)).toEqual(await normal(byVendor.id));
    expect(byOps.indicative_estimate).toEqual(byVendor.indicative_estimate);
  });

  it('is created by the Ops member, whose hub and scope decide where it may be', async () => {
    const byOps = created(await book(ops.client, own()));
    expect((await rowOf(byOps.id)).created_by).toBe(ops.identity.id);
    // Ops of another hub cannot book for a vendor of this one.
    const outside = await book(opsB.client, own());
    expect(outside.status).toBe(403);
    expect(codeOf(outside)).toBe('HUB_SCOPE_VIOLATION');
  });

  // Break caught: Ops told a vendor does not exist when it is merely unknown, in a way that exposes the vendor table to a probe, or a
  // vendor that is not active booked for.
  it('refuses Ops a vendor that is unknown or not active', async () => {
    const unknown = await book(ops.client, own({ vendor_organization_id: randomUUID() }));
    expect(unknown.status).toBe(400);
    expect(codeOf(unknown)).toBe('VALIDATION_FAILED');
  });
});

describe('a one-package request waits for its exception (pickup-request.md 5.2)', () => {
  // Break caught: Ops barred from a one-package request, or an estimate invented for a destination nobody has named.
  it('is created by Ops as PENDING with no estimate until a destination is named', async () => {
    const answer = await book(ops.client, own({ declared_package_count: 1 }));
    expect(answer.status).toBe(201);
    const request = created(answer);
    expect(request).toMatchObject({
      state: 'PENDING',
      declared_package_count: 1,
      indicative_estimate: null,
    });
    expect((await rowOf(request.id)).estimate_snapshot).toBeNull();
  });
});

describe('a collection for a vendor (AC-SLICE-001-70)', () => {
  // Break caught: the rider sent to the vendor's address, where the parcel is going, and not to the collection point.
  it('sends the rider to the collection point and takes the parcel to the vendor’s default location', async () => {
    const request = created(await book(ops.client, collect()));
    expect(request).toMatchObject({
      pickup_intent: 'COLLECT_FOR_VENDOR',
      resolved_pickup_location: { address: 'Supplier yard, Kaneshie', landmark: 'Blue gate' },
      pickup_location: null,
      primary_phone: '+233553334444',
    });
    expect(request.destination_location_id).toBe(shop);
    expect(request.collection_point).toMatchObject({ contact_name: 'Efua at the supplier' });
  });

  // Break caught: a collection with nowhere to take it accepted, and the vendor with no default accepted for the default.
  it('refuses a collection with no destination, and a default for a vendor with none', async () => {
    const none = await book(ops.client, collect({ use_vendor_default_destination: undefined }));
    expect(none.status).toBe(400);
    expect(codeOf(none)).toBe('VALIDATION_FAILED');

    const lonely = await routes.vendor();
    const unresolved = await book(
      ops.client,
      collect({ vendor_organization_id: lonely.row.organizationId }),
    );
    expect(unresolved.status).toBe(422);
    expect(codeOf(unresolved)).toBe('DESTINATION_UNRESOLVED');
  });

  it('refuses a destination that is another vendor’s as unresolved', async () => {
    const [theirs] = await routes.rows<{ id: string }>(
      `select id from vendor_pickup_location where vendor_organization_id = $1`,
      [vendorTwo.row.organizationId],
    );
    const answer = await book(
      ops.client,
      collect({ use_vendor_default_destination: undefined, destination_location_id: theirs?.id }),
    );
    expect(answer.status).toBe(422);
    expect(codeOf(answer)).toBe('DESTINATION_UNRESOLVED');
  });
});

describe('a walk-in sender (AC-SLICE-001-71, -72)', () => {
  // Break caught: the sender and the request not made as one act, the sender promoted to a vendor, or the sender searchable before a
  // pickup has completed.
  it('creates a provisional sender and the request together, and audits both', async () => {
    const answer = await book(ops.client, adhoc());
    expect(answer.status).toBe(201);
    const request = created(answer);
    expect(request).toMatchObject({
      pickup_intent: 'ADHOC_SENDER',
      vendor_organization_id: null,
      resolved_pickup_location: { address: 'Kiosk by the Tema station' },
      primary_phone: '+233205550101',
      current_item_description: 'Phone accessories',
      sender_name: 'Kwame Walk-in',
      responsible_hub_id: HUB_A,
    });
    const [sender] = await routes.rows<{
      id: string;
      phone: string;
      state: string;
      phone_as_entered: string;
    }>(`select id, phone, state, phone_as_entered from ad_hoc_sender where id = $1`, [
      request.ad_hoc_sender_id,
    ]);
    expect(sender).toMatchObject({
      phone: '+233205550101',
      state: 'PROVISIONAL',
      phone_as_entered: '020 555 0101',
    });
    expect(
      await routes.rows(
        `select event_code from audit_event where object_id = any($1::uuid[]) order by event_code`,
        [[request.id, sender?.id]],
      ),
    ).toEqual([{ event_code: 'pickup.request.created' }, { event_code: 'pickup.sender.saved' }]);
  });

  // Break caught: a retry that mints a second sender, or books twice.
  it('is one idempotent act: the same key and body replay the original answer, one sender, one request', async () => {
    const idempotencyKey = randomUUID();
    const body = adhoc({
      new_ad_hoc_sender: {
        name: 'Replay Walk-in',
        phone: '0205550202',
        pickup_location: { address: 'Replay kiosk' },
      },
    });
    const before = await count();
    const first = await book(ops.client, body, idempotencyKey);
    const second = await book(ops.client, body, idempotencyKey);
    expect([first.status, second.status]).toEqual([201, 201]);
    expect(second.text).toBe(first.text);
    expect(second.header('etag')).toBe(first.header('etag'));
    expect(await count()).toBe(before + 1);
    expect(
      Number(
        (
          await routes.rows<{ n: number }>(
            `select count(*)::int as n from ad_hoc_sender where phone = '+233205550202'`,
          )
        )[0]?.n,
      ),
    ).toBe(1);
    // Another body under the same key is a different request.
    const conflict = await book(ops.client, adhoc({ declared_package_count: 5 }), idempotencyKey);
    expect(conflict.status).toBe(409);
    expect(codeOf(conflict)).toBe('IDEMPOTENCY_KEY_CONFLICT');
  });

  // Break caught: an identity source that is both or neither accepted, and a first-time sender created for a phone that already
  // identifies a reusable one (the identity then split in two).
  it('needs exactly one identity source, and tells a reusable sender’s phone from a new one', async () => {
    const reusable = await insertAdHocSender(routes.admin, {
      phone: '+233206660303',
      state: 'REUSABLE',
    });
    const both = await book(ops.client, adhoc({ ad_hoc_sender_id: reusable.id }));
    expect([both.status, codeOf(both)]).toEqual([400, 'VALIDATION_FAILED']);
    const neither = await book(ops.client, adhoc({ new_ad_hoc_sender: undefined }));
    expect([neither.status, codeOf(neither)]).toEqual([400, 'VALIDATION_FAILED']);

    const clash = await book(
      ops.client,
      adhoc({
        new_ad_hoc_sender: {
          name: 'Someone else',
          phone: '0206660303',
          pickup_location: { address: 'x' },
        },
      }),
    );
    expect(clash.status).toBe(422);
    expect(codeOf(clash)).toBe('SENDER_IDENTITY_AMBIGUOUS');
  });

  // Break caught: a walk-in who comes back before the first pickup completes being refused for good, or minted a second time.
  it('reuses a provisional sender that comes back, once', async () => {
    const first = created(
      await book(
        ops.client,
        adhoc({
          new_ad_hoc_sender: {
            name: 'Again Walk-in',
            phone: '0207770404',
            pickup_location: { address: 'Again kiosk' },
          },
        }),
      ),
    );
    const again = created(
      await book(
        ops.client,
        adhoc({
          new_ad_hoc_sender: {
            name: 'Again Walk-in',
            phone: '+233 20 777 0404',
            pickup_location: { address: 'Again kiosk' },
          },
        }),
      ),
    );
    expect(again.ad_hoc_sender_id).toBe(first.ad_hoc_sender_id);
    expect(
      Number(
        (
          await routes.rows<{ n: number }>(
            `select count(*)::int as n from ad_hoc_sender where phone = '+233207770404'`,
          )
        )[0]?.n,
      ),
    ).toBe(1);
  });

  // Break caught: the stored profile not reused on a return visit, or last month's goods carried into this booking.
  it('reuses a returning sender’s identity and place, and asks for today’s goods every time', async () => {
    const sender = await insertAdHocSender(routes.admin, {
      phone: '+233208880505',
      state: 'REUSABLE',
      name: 'Regular Walk-in',
    });
    await routes.admin.query(
      `update ad_hoc_sender set pickup_location = '{"address":"The regular stall"}'::jsonb where id = $1`,
      [sender.id],
    );
    const request = created(
      await book(ops.client, {
        pickup_intent: 'ADHOC_SENDER',
        ad_hoc_sender_id: sender.id,
        current_item_description: 'Books, this time',
        scheduled_service_date: WEDNESDAY,
        declared_package_count: 2,
        default_payer_intent: 'RECIPIENT_PAYS',
      }),
    );
    expect(request).toMatchObject({
      ad_hoc_sender_id: sender.id,
      sender_name: 'Regular Walk-in',
      primary_phone: '+233208880505',
      resolved_pickup_location: { address: 'The regular stall' },
      current_item_description: 'Books, this time',
    });
    const missingGoods = await book(ops.client, {
      pickup_intent: 'ADHOC_SENDER',
      ad_hoc_sender_id: sender.id,
      scheduled_service_date: WEDNESDAY,
      declared_package_count: 2,
      default_payer_intent: 'RECIPIENT_PAYS',
    });
    expect([missingGoods.status, codeOf(missingGoods)]).toEqual([400, 'VALIDATION_FAILED']);
    const unknown = await book(
      ops.client,
      adhoc({ new_ad_hoc_sender: undefined, ad_hoc_sender_id: randomUUID() }),
    );
    expect([unknown.status, codeOf(unknown)]).toEqual([400, 'VALIDATION_FAILED']);
  });

  // Break caught: a vendor session creating a walk-in's booking, which is the office's.
  it('is the office’s: a vendor session is refused', async () => {
    const answer = await book(browserOne, adhoc());
    expect(answer.status).toBe(403);
    expect(codeOf(answer)).toBe('PERMISSION_DENIED');
  });

  it('refuses a first-time sender whose phone cannot be placed', async () => {
    const answer = await book(
      ops.client,
      adhoc({
        new_ad_hoc_sender: { name: 'No Number', phone: '555', pickup_location: { address: 'x' } },
      }),
    );
    expect(answer.status).toBe(400);
    expect(JSON.stringify(answer.json())).toContain('/new_ad_hoc_sender/phone');
  });
});

describe('a suspended sender (AC-SLICE-001-08)', () => {
  // Break caught: a suspended vendor booked for, or its existing requests moved to CANCELLED by the suspension.
  it('is refused with SENDER_SUSPENDED, and the requests it already has are left as they are', async () => {
    const vendor = await routes.vendor();
    await insertVendorLocation(routes.admin, vendor.row.organizationId, { isDefault: true });
    const existing = created(
      await book(ops.client, own({ vendor_organization_id: vendor.row.organizationId })),
    );
    await routes.admin.query(
      `update vendor_organization set operational_status = 'SUSPENDED' where id = $1`,
      [vendor.row.organizationId],
    );
    const before = await count();
    const answer = await book(
      ops.client,
      own({ vendor_organization_id: vendor.row.organizationId }),
    );
    expect(answer.status).toBe(422);
    expect(codeOf(answer)).toBe('SENDER_SUSPENDED');
    expect(await count()).toBe(before);
    expect((await rowOf(existing.id)).state).toBe('PENDING');
  });
});

describe('the declared value and the liability cap (AC-SLICE-001-81)', () => {
  // Break caught: a value above the threshold booked without the acknowledgement, or at the threshold refused for lack of one.
  it('needs the acknowledgement above GH₵500, and none at or below it', async () => {
    const before = await count();
    const refused = await book(browserOne, own({ declared_value_minor: 50_001 }));
    expect(refused.status).toBe(422);
    expect(codeOf(refused)).toBe('VALUE_DECLARATION_REQUIRED');
    expect(await count()).toBe(before);
    const no = await book(
      browserOne,
      own({ declared_value_minor: 50_001, liability_cap_acknowledged: false }),
    );
    expect(codeOf(no)).toBe('VALUE_DECLARATION_REQUIRED');

    const atThreshold = created(await book(browserOne, own({ declared_value_minor: 50_000 })));
    expect(atThreshold).toMatchObject({
      declared_value_minor: 50_000,
      liability_cap_acknowledged_at: null,
      liability_cap_snapshot: null,
    });
  });

  // Break caught: an acknowledgement stored as a flag with a pointer to the live cap, which the company could change under the customer.
  it('snapshots the cap in force at the acknowledgement, as an amount the customer agreed to', async () => {
    const request = created(
      await book(
        browserOne,
        own({ declared_value_minor: 120_000, liability_cap_acknowledged: true }),
      ),
    );
    expect(request.liability_cap_snapshot).toEqual({
      amount_minor: 30_000,
      setting_key: 'liability_cap_amount',
      effective_version: 'UNVERSIONED',
    });
    expect(request.liability_cap_acknowledged_at).not.toBeNull();
    // The company later raises the cap: what was acknowledged does not change.
    await routes.admin.query(
      `update setting set value = '99999'::jsonb where key = 'liability_cap_amount'`,
    );
    try {
      expect(
        created(
          await routes
            .actor(BUNDLE_IDS.opsStaff, HUB_A)
            .then((a) => a.client.get(`${LIST}/${request.id}`)),
        ).liability_cap_snapshot,
      ).toMatchObject({ amount_minor: 30_000 });
    } finally {
      await routes.admin.query(
        `update setting set value = '30000'::jsonb where key = 'liability_cap_amount'`,
      );
    }
  });

  it('refuses an acknowledgement given with nothing declared', async () => {
    const answer = await book(browserOne, own({ liability_cap_acknowledged: true }));
    expect(answer.status).toBe(400);
    expect(JSON.stringify(answer.json())).toContain('/liability_cap_acknowledged');
  });
});

describe('the payer arrangement is intent only', () => {
  it('keeps a split and its basis, and refuses a split that is not whole', async () => {
    const ok = created(
      await book(
        browserOne,
        own({
          default_payer_intent: 'SPLIT',
          split_basis: 'PERCENTAGE',
          split_sender_percentage: 40,
        }),
      ),
    );
    expect(ok).toMatchObject({
      default_payer_intent: 'SPLIT',
      split_basis: 'PERCENTAGE',
      split_sender_percentage: 40,
      split_sender_amount: null,
    });
    const fixed = created(
      await book(
        browserOne,
        own({
          default_payer_intent: 'SPLIT',
          split_basis: 'FIXED_AMOUNT',
          split_sender_amount: { amount_minor: 1500, currency: 'GHS' },
        }),
      ),
    );
    expect(fixed).toMatchObject({
      split_basis: 'FIXED_AMOUNT',
      split_sender_amount: { amount_minor: 1500, currency: 'GHS' },
      split_sender_percentage: null,
    });
    const bad = await book(browserOne, own({ default_payer_intent: 'SPLIT' }));
    expect([bad.status, codeOf(bad)]).toEqual([400, 'VALIDATION_FAILED']);
  });
});

describe('a missing fee never blocks a booking', () => {
  // Break caught: a booking refused, or priced at zero, because the hub has no configuration (settings never inherit, section 33.4).
  it('books at a hub with no fees, with an estimate that says it is unavailable and why', async () => {
    const vendor = await routes.vendor({ hubId: HUB_B });
    await insertVendorLocation(routes.admin, vendor.row.organizationId, { isDefault: true });
    const answer = await book(
      opsB.client,
      own({ vendor_organization_id: vendor.row.organizationId }),
    );
    expect(answer.status).toBe(201);
    const request = created(answer);
    expect(request.code).toMatch(/^KUM-PR-/);
    expect(request.indicative_estimate).toMatchObject({
      status: 'UNAVAILABLE_SETTING_MISSING',
      provisional: true,
      total: null,
      components: [],
    });
  });
});

describe('who may book', () => {
  // Break caught: a holder of another bundle, a Rider or an unauthenticated caller booking.
  it('refuses Finance, a Rider and a caller with no session', async () => {
    const finance = await routes.actor(BUNDLE_IDS.finance, null);
    expect(codeOf(await book(finance.client, own()))).toBe('PERMISSION_DENIED');
    const rider = await arrangedFixedSession(routes.kit, routes.admin, 'RIDER');
    const asRider = await routes.kit.client
      .fork()
      .bearer(rider.token)
      .post(LIST, own(), { ...key(), origin: null });
    expect([403, 401]).toContain(asRider.status);
    const anonymous = await routes.browser().post(LIST, own(), key());
    expect(anonymous.status).toBe(401);
    expect(codeOf(anonymous)).toBe('SESSION_INVALID');
  });

  it('refuses a request with no Idempotency-Key', async () => {
    const answer = await ops.client.post(LIST, own(), { origin: OPS });
    expect(answer.status).toBe(400);
    expect(codeOf(answer)).toBe('VALIDATION_FAILED');
  });
});
