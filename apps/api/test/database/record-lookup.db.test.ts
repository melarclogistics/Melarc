import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TestClient, type TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { HUBS } from '../../src/tools/seed/hubs.js';
import { insertStaff, staffRow } from './support/identities.js';
import { insertManifest, manifestRow } from './support/manifests.js';
import { ARRANGER, insertPickupRequest, pickupRequestRow } from './support/pickups.js';
import { grant, newBundle } from './support/policy-fixtures.js';
import { insertRider, riderRow } from './support/riders.js';
import { API, HUB_A, HUB_B, codeOf, type Actor } from './support/staff-routes.js';
import { insertVendor, vendorRow } from './support/vendors.js';
import { startVendorRoutes, type VendorRoutes } from './support/vendor-routes.js';

/**
 * `lookupRecords` against the real application and a real PostgreSQL (task C2; `features/operations/global-lookup.md`, `AC-LOOKUP-01` to
 * `-11`): a record found by its code, a name or a phone number typed in full, and only a record the same session could open through its own
 * read. Two hubs, each with a vendor, a request, a run, a rider and a staff member whose names share a word ("Zuko") so that one query meets
 * every kind in both hubs.
 */
const LOOKUP = `${API}/ops/lookup`;
const SHARED_PHONE = '+233241112222';

const HUBS_BY = { a: HUB_A, b: HUB_B } as const;
/** The names the fixtures give the two hubs: the seeded launch hub, and the one `startStaffRoutes` adds. */
const HUB_NAMES = { a: HUBS[0]?.name ?? '', b: 'Kumasi' } as const;
const SUFFIX = { a: 'Alpha', b: 'Beta' } as const;
type Which = 'a' | 'b';

/** Every field a result may carry (`RecordLookupResult`): the facts of a record and nothing else. */
const RESULT_FIELDS = ['kind', 'id', 'code', 'title', 'state', 'hub', 'service_date', 'phone_hint'];

interface Found {
  readonly id: string;
  readonly code: string;
}

let routes: VendorRoutes;
let platformAdmin: Actor;
let officer: Actor;
let senior: Actor;
let anonymous: TestClient;
const vendors = {} as Record<Which, Found & { organizationId: string }>;
const requests = {} as Record<Which, Found>;
const manifests = {} as Record<Which, Found>;
const riders = {} as Record<Which, { id: string }>;
const staff = {} as Record<Which, { id: string }>;
let senderlessRequest: Found;
let floating: { id: string };

beforeAll(async () => {
  routes = await startVendorRoutes();
  for (const which of ['a', 'b'] as const) {
    const hub = HUBS_BY[which];
    const vendor = await insertVendor(
      routes.admin,
      vendorRow({ hubId: hub, legalName: `Zuko Fabrics ${SUFFIX[which]} Ltd` }),
    );
    vendors[which] = {
      id: vendor.accountId,
      code: vendor.accountIdentifier,
      organizationId: vendor.organizationId,
    };
    const request = await insertPickupRequest(
      routes.admin,
      pickupRequestRow(vendor.organizationId, hub, {
        senderName: `Zuko Quarmby-Demo ${SUFFIX[which]}`,
        primaryPhone: SHARED_PHONE,
      }),
    );
    requests[which] = { id: request.id, code: request.code };
    const manifest = await insertManifest(routes.admin, manifestRow(hub));
    manifests[which] = { id: manifest.id, code: manifest.code };
    riders[which] = {
      id: (
        await insertRider(
          routes.admin,
          riderRow({
            hubId: hub,
            fullName: `Zuko Boateng ${SUFFIX[which]}`,
            phone: which === 'a' ? SHARED_PHONE : '+233241114444',
          }),
        )
      ).id,
    };
    staff[which] = {
      id: (
        await insertStaff(
          routes.admin,
          staffRow({ fullName: `Zuko Kwarteng ${SUFFIX[which]}`, primaryHubId: hub }),
        )
      ).id,
    };
  }
  // An ad-hoc sender whose phone is searched, and a request of it whose own contact phone is another: a number matched through the sender
  // would find this request, and it must not (an ad-hoc sender is global to staff: its phone would tell which hub a sender is booked in).
  const sender = await routes.admin.query<{ id: string }>(
    `insert into ad_hoc_sender (id, name, phone, phone_as_entered, pickup_location, created_by)
     values (gen_random_uuid(), 'Zuko Sender', '+233241115555', '024 111 5555', '{"address":"Kiosk"}'::jsonb, $1) returning id`,
    [ARRANGER],
  );
  const orphan = await insertPickupRequest(
    routes.admin,
    pickupRequestRow(vendors.a.organizationId, HUB_A, {
      intent: 'ADHOC_SENDER',
      vendorOrganizationId: null,
      adHocSenderId: sender.rows[0]?.id ?? null,
      senderName: 'Zuko Kiosk',
    }),
  );
  senderlessRequest = { id: orphan.id, code: orphan.code };
  // A staff profile with no primary hub: a grant of all hubs reaches it, a grant of one hub does not, and its result names no hub.
  floating = {
    id: (
      await insertStaff(routes.admin, staffRow({ fullName: 'Yara Floating', primaryHubId: null }))
    ).id,
  };

  platformAdmin = await routes.platformAdmin();
  officer = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  senior = await routes.actor(BUNDLE_IDS.seniorOps, HUB_A);
  anonymous = new TestClient({ baseUrl: routes.kit.app.baseUrl });
}, 240_000);

afterAll(async () => {
  await routes.stop();
});

const ask = (actor: Actor | TestClient, q: string): Promise<TestResponse> =>
  ('client' in actor ? actor.client : actor).get(`${LOOKUP}?q=${encodeURIComponent(q)}`);

interface Item {
  readonly kind: string;
  readonly id: string;
  readonly code?: string;
  readonly title: string;
  readonly state?: string;
  readonly hub?: { readonly id: string; readonly display_name: string };
  readonly service_date?: string;
  readonly phone_hint?: string;
}
const itemsOf = (response: TestResponse): Item[] => (response.json() as { items: Item[] }).items;
const idsOf = (response: TestResponse): string[] => itemsOf(response).map((item) => item.id);
const sorted = (ids: readonly string[]): string[] => [...ids].toSorted();

/** The path of the record's own read, by which a result is proven openable. */
const OWN_READ: Record<string, (id: string) => string> = {
  PICKUP_REQUEST: (id) => `${API}/pickup-requests/${id}`,
  PICKUP_MANIFEST: (id) => `${API}/pickup-manifests/${id}`,
  VENDOR_ACCOUNT: (id) => `${API}/ops/vendors/${id}`,
  RIDER: (id) => `${API}/ops/riders/${id}`,
  STAFF_IDENTITY: (id) => `${API}/staff-identities/${id}`,
};

describe('the text asked (AC-LOOKUP-01)', () => {
  // Break caught: a text the contract refuses being searched, spaces counted as characters, or a refusal that is not a validation failure.
  it.each([
    ['nothing'],
    ['a'],
    ['  a  '],
    ['x'.repeat(65)],
    // 69 characters as sent, 65 once folded: both rules refuse it.
    [`${'x'.repeat(32)}     ${'y'.repeat(32)}`],
    // A NUL character is in no name, and PostgreSQL refuses it in a text: a refused query and never a failed read (a 500).
    ['ab\u0000cd'],
  ])('is VALIDATION_FAILED for %j', async (q) => {
    const answer = q === 'nothing' ? await officer.client.get(LOOKUP) : await ask(officer, q);

    expect([answer.status, codeOf(answer)]).toEqual([400, 'VALIDATION_FAILED']);
    // The violation names the parameter q: the contract's own check spells its place `q` and the handler's `/q` (the platform spells the two differently).
    const { violations } = (
      answer.json() as { details: { violations: { in: string; pointer: string }[] } }
    ).details;
    expect(violations.length).toBeGreaterThan(0);
    for (const violation of violations) {
      expect(violation.in).toBe('query');
      expect(violation.pointer).toMatch(/^\/?q$/);
    }
  });

  // Break caught: the 64 counted on the folded text in the handler while the contract counts the text as sent (a text the feature says is
  // searched refused with a 400, or the reverse), or a text of one character once trimmed reaching the search.
  it('counts the text as sent for the 64 and as trimmed for the 2', async () => {
    const around = (inner: string, spaces: number): string =>
      `${' '.repeat(spaces)}${inner}${' '.repeat(spaces)}`;

    // 64 as sent (two spaces each side of sixty characters): searched, on the trimmed text.
    expect((await ask(officer, around('x'.repeat(60), 2))).status).toBe(200);
    expect((await ask(officer, 'x'.repeat(64))).status).toBe(200);
    // 66 as sent, sixty-two once trimmed: the contract counts the text as sent.
    const sentTooLong = await ask(officer, around('x'.repeat(62), 2));
    expect([sentTooLong.status, codeOf(sentTooLong)]).toEqual([400, 'VALIDATION_FAILED']);
    // 3 as sent, one once trimmed: past the contract's count of what was sent, refused by the handler's count of what is searched.
    const trimmedTooShort = await ask(officer, around('x', 1));
    expect([trimmedTooShort.status, codeOf(trimmedTooShort)]).toEqual([400, 'VALIDATION_FAILED']);
  });

  it('searches a text of two characters, and a text whose spaces are only what trimming takes away', async () => {
    expect((await ask(officer, 'zu')).status).toBe(200);
    expect(sorted(idsOf(await ask(officer, '  zuko   quar  ')))).toEqual(sorted([requests.a.id]));
  });
});

describe('a code finds at most the record that carries it (AC-LOOKUP-02)', () => {
  // Break caught: a code that also finds the records it begins, a code that is case-sensitive, or one that finds another hub's record.
  it.each([
    ['a request', () => requests.a.code, () => requests.a.id],
    ['a run', () => manifests.a.code, () => manifests.a.id],
  ])('finds %s alone, in any case and with spaces around it', async (_name, code, id) => {
    for (const typed of [code(), code().toLowerCase(), `  ${code().toLowerCase()}  `]) {
      const answer = await ask(platformAdmin, typed);
      expect(answer.status).toBe(200);
      expect(idsOf(answer)).toEqual([id()]);
    }
  });

  it('is an empty answer, with status 200, for a code that names no record, a record of another hub and a type with no page here', async () => {
    for (const q of ['ACC-PR-AAAAAA', requests.b.code, 'ACC-IN-AAAAAA', 'ACC-OR-AAAAAA']) {
      const answer = await ask(officer, q);
      expect([answer.status, itemsOf(answer)]).toEqual([200, []]);
    }
    expect(idsOf(await ask(platformAdmin, requests.b.code))).toEqual([requests.b.id]);
  });

  // Break caught (AC-LOOKUP-02, -06): a run searched without the scope or the key of pickup.read (a wrong readKey or policy on the run's source
  // would otherwise pass the file: a run is found by its code alone, and no name query meets one).
  it('finds a run of the session’s own hub and never the run of another hub, or any run without pickup.read', async () => {
    for (const actor of [officer, senior]) {
      expect(idsOf(await ask(actor, manifests.a.code))).toEqual([manifests.a.id]);
      expect(idsOf(await ask(actor, manifests.b.code.toLowerCase()))).toEqual([]);
      expect(idsOf(await ask(actor, requests.b.code))).toEqual([]);
    }
    expect(sorted(idsOf(await ask(platformAdmin, manifests.b.code)))).toEqual([manifests.b.id]);

    const withoutPickup = await routes.actor(
      await newBundle(routes.admin, [grant('vendor.read'), grant('staff.read', 'all')]),
      HUB_A,
    );
    for (const code of [manifests.a.code, manifests.b.code]) {
      const answer = await ask(withoutPickup, code);
      expect([answer.status, itemsOf(answer)]).toEqual([200, []]);
    }
    // ... and a bundle that holds pickup.read at a hub, with other keys at every hub, still finds the runs of that hub alone.
    const mixed = await routes.actor(
      await newBundle(routes.admin, [grant('pickup.read', 'own'), grant('staff.read', 'all')]),
      HUB_A,
    );
    expect(idsOf(await ask(mixed, manifests.a.code))).toEqual([manifests.a.id]);
    expect(idsOf(await ask(mixed, manifests.b.code))).toEqual([]);
  });

  it('is an empty answer for a session without pickup.read, and a vendor account is found by its identifier', async () => {
    const withoutPickup = await routes.actor(
      await newBundle(routes.admin, [grant('vendor.read')]),
      HUB_A,
    );
    expect(itemsOf(await ask(withoutPickup, requests.a.code))).toEqual([]);

    const found = await ask(officer, vendors.a.code.toLowerCase());
    expect(itemsOf(found).map((item) => [item.kind, item.id, item.code])).toEqual([
      ['VENDOR_ACCOUNT', vendors.a.id, vendors.a.code],
    ]);
    expect(itemsOf(await ask(officer, vendors.b.code))).toEqual([]);
  });
});

describe('a phone number counts only when typed in full (AC-LOOKUP-03)', () => {
  // Break caught: a number read in one spelling only, a part of a number read as a whole, or a number matched through the ad-hoc sender.
  it.each(['024 111 2222', '0241112222', '233241112222', '+233 24 111 2222'])(
    'finds the requests and the rider that carry %j, and nothing else',
    async (typed) => {
      const answer = await ask(platformAdmin, typed);

      expect(answer.status).toBe(200);
      expect(sorted(idsOf(answer))).toEqual(sorted([requests.a.id, requests.b.id, riders.a.id]));
      expect(sorted(idsOf(await ask(officer, typed)))).toEqual(
        sorted([requests.a.id, riders.a.id]),
      );
    },
  );

  it.each(['024 111', '0241112', '024111222', '+233 24', '0241112222x'])(
    'finds nothing by phone for the part of a number %j',
    async (typed) => {
      expect(itemsOf(await ask(platformAdmin, typed))).toEqual([]);
    },
  );

  // Break caught: a phone column without its index, which would make the commonest search of the desk a scan of every request.
  it('has an index on each contact phone of a request, so that a number is found by an index and not by a scan', async () => {
    const indexes = await routes.rows<{ indexname: string; indexdef: string }>(
      `select indexname, indexdef from pg_indexes
        where tablename = 'pickup_request' and indexname like 'pickup_request_%_phone_idx' order by indexname`,
    );

    expect(indexes.map((index) => index.indexname)).toEqual([
      'pickup_request_primary_phone_idx',
      'pickup_request_secondary_phone_idx',
    ]);
    expect(indexes[0]?.indexdef).toContain('(primary_phone)');
    expect(indexes[1]?.indexdef).toMatch(/\(secondary_phone\).*WHERE/);
  });

  // Break caught: the second contact phone of a request left out of the search ("primary or secondary"), or found for a request of another hub.
  it('finds a request by its second contact phone as by its first, masked, and in the scope of the session', async () => {
    const vendor = await insertVendor(routes.admin, vendorRow({ hubId: HUB_A }));
    const second = await insertPickupRequest(
      routes.admin,
      pickupRequestRow(vendor.organizationId, HUB_A, {
        senderName: 'Nana Secondphone',
        primaryPhone: '+233241119999',
        secondaryPhone: '+233241113333',
      }),
    );
    const otherHub = await insertVendor(routes.admin, vendorRow({ hubId: HUB_B }));
    const elsewhere = await insertPickupRequest(
      routes.admin,
      pickupRequestRow(otherHub.organizationId, HUB_B, {
        senderName: 'Nana Elsewhere',
        primaryPhone: '+233241118888',
        secondaryPhone: '+233241113333',
      }),
    );

    const bySecond = await ask(officer, '024 111 3333');
    expect(idsOf(bySecond)).toEqual([second.id]);
    expect(itemsOf(bySecond)[0]?.phone_hint).toBe('+233******333');
    expect(bySecond.text).not.toContain('241113333');
    expect(idsOf(await ask(officer, '0241119999'))).toEqual([second.id]);
    expect(sorted(idsOf(await ask(platformAdmin, '0241113333')))).toEqual(
      sorted([second.id, elsewhere.id]),
    );
  });

  it('never matches the phone of an ad-hoc sender', async () => {
    expect(itemsOf(await ask(platformAdmin, '024 111 5555'))).toEqual([]);
    // ... though the request of that sender exists and is found by its own name.
    expect(idsOf(await ask(platformAdmin, 'zuko kiosk'))).toEqual([senderlessRequest.id]);
  });
});

describe('a name matches at the start of any word (AC-LOOKUP-04)', () => {
  // Break caught: the inside of a word matching, a search that depends on case, or a "%" or "_" acting as a pattern.
  it.each([
    ['quar', ['PICKUP_REQUEST']],
    ['QUARMBY', ['PICKUP_REQUEST']],
    ['zuko qua', ['PICKUP_REQUEST']],
    ['ZUKO QUA', ['PICKUP_REQUEST']],
    ['fabrics', ['VENDOR_ACCOUNT']],
    ['boat', ['RIDER']],
    ['kwart', ['STAFF_IDENTITY']],
  ])('finds %j as %j for a session that may search every kind', async (typed, kinds) => {
    const answer = await ask(platformAdmin, typed);
    expect([...new Set(itemsOf(answer).map((item) => item.kind))]).toEqual(kinds);
    expect(itemsOf(answer).length).toBeGreaterThan(0);
  });

  it.each(['uarmby', 'emo', 'brics', 'oateng', 'zu%', '%%', 'zuko_', 'z_ko', 'zuko\\'])(
    'finds nothing for %j, which is inside a word or a pattern that is not a name',
    async (typed) => {
      expect(itemsOf(await ask(platformAdmin, typed))).toEqual([]);
    },
  );

  it('finds a word after a hyphen only by the word it is in', async () => {
    // "Quarmby-Demo" is one word: "demo" is not the start of a word of it.
    expect(itemsOf(await ask(platformAdmin, 'demo'))).toEqual([]);
    expect(itemsOf(await ask(platformAdmin, 'quarmby-d')).length).toBeGreaterThan(0);
  });
});

describe('a kind is searched only if the session holds its key (AC-LOOKUP-05)', () => {
  // Break caught: a kind searched without its key, or under another key's grant.
  it('gives an Ops Staff officer the kinds of the keys the bundle holds, and no staff member', async () => {
    const kinds = new Set(itemsOf(await ask(officer, 'zuko')).map((item) => item.kind));
    expect([...kinds].toSorted()).toEqual(['PICKUP_REQUEST', 'RIDER', 'VENDOR_ACCOUNT']);
  });

  it('gives a bundle of pickup.read and staff.read those two kinds, and the keyless bundle an empty answer', async () => {
    const some = await routes.actor(
      await newBundle(routes.admin, [grant('pickup.read'), grant('staff.read')]),
      HUB_A,
    );
    const kinds = new Set(itemsOf(await ask(some, 'zuko')).map((item) => item.kind));
    expect([...kinds].toSorted()).toEqual(['PICKUP_REQUEST', 'STAFF_IDENTITY']);

    const none = await routes.actor(
      await newBundle(routes.admin, [grant('notification.read')]),
      HUB_A,
    );
    const answer = await ask(none, 'zuko');
    expect([answer.status, itemsOf(answer)]).toEqual([200, []]);
  });
});

describe('a result is one the session could open (AC-LOOKUP-06)', () => {
  // Break caught: a record of another hub returned, a kind searched under a wider grant of the same bundle, or an id its own read refuses.
  it('gives the officer and the Senior Ops user the first hub’s records alone, and the Platform Admin both hubs’', async () => {
    const asOfficer = await ask(officer, 'zuko');
    expect(sorted(idsOf(asOfficer))).toEqual(
      sorted([requests.a.id, vendors.a.id, riders.a.id, senderlessRequest.id]),
    );
    const asSenior = await ask(senior, 'zuko');
    expect(sorted(idsOf(asSenior))).toEqual(
      sorted([requests.a.id, vendors.a.id, riders.a.id, staff.a.id, senderlessRequest.id]),
    );
    const asAdmin = await ask(platformAdmin, 'zuko');
    expect(sorted(idsOf(asAdmin))).toEqual(
      sorted([
        requests.a.id,
        requests.b.id,
        vendors.a.id,
        vendors.b.id,
        riders.a.id,
        riders.b.id,
        staff.a.id,
        staff.b.id,
        senderlessRequest.id,
      ]),
    );
  });

  // Break caught: a Platform Admin's reach narrowed to its primary hub, which would make the one with a hub see less than the one without.
  it('gives a Platform Admin with a primary hub the records of every hub, as the one without', async () => {
    const withHub = await routes.actor(BUNDLE_IDS.platformAdmin, HUB_A);

    const answer = await ask(withHub, 'zuko');

    expect(sorted(idsOf(answer))).toEqual(sorted(idsOf(await ask(platformAdmin, 'zuko'))));
    expect(idsOf(answer)).toEqual(expect.arrayContaining([requests.b.id, riders.b.id, staff.b.id]));
  });

  it('searches each kind in the scope of its own key: pickup.read at a hub and staff.read at all hubs', async () => {
    const mixed = await routes.actor(
      await newBundle(routes.admin, [grant('pickup.read', 'own'), grant('staff.read', 'all')]),
      HUB_A,
    );

    const answer = await ask(mixed, 'zuko');

    expect(sorted(idsOf(answer))).toEqual(
      sorted([requests.a.id, senderlessRequest.id, staff.a.id, staff.b.id]),
    );
  });

  it('opens every id it returns through the record’s own read, for the session that was given it, whatever was asked', async () => {
    // A name that meets every kind but the runs, and the code of a run, of a request and of a vendor account, and a phone number.
    const queries = [
      'zuko',
      manifests.a.code,
      manifests.b.code,
      requests.a.code,
      requests.b.code,
      vendors.a.code,
      vendors.b.code,
      '024 111 2222',
    ];
    const opened = new Set<string>();
    for (const actor of [officer, senior, platformAdmin]) {
      for (const q of queries) {
        for (const item of itemsOf(await ask(actor, q))) {
          const own = await actor.client.get(OWN_READ[item.kind]?.(item.id) ?? '/unknown');
          expect(own.status, `${item.kind} ${item.id}`).toBe(200);
          opened.add(item.kind);
        }
      }
    }
    expect([...opened].toSorted()).toEqual([
      'PICKUP_MANIFEST',
      'PICKUP_REQUEST',
      'RIDER',
      'STAFF_IDENTITY',
      'VENDOR_ACCOUNT',
    ]);
  });
});

describe('only an Ops staff session may ask (AC-LOOKUP-07)', () => {
  // Break caught: the lookup served to a vendor, which would let a vendor learn that another party's records exist.
  it('refuses a Vendor session and a request with no session', async () => {
    const vendor = await routes.vendor();
    const browser = routes.browser(vendor.device.credential.token);
    expect((await routes.signIn(browser, vendor.row.accountIdentifier, vendor.secret)).status).toBe(
      200,
    );

    const asVendor = await browser.get(`${LOOKUP}?q=zuko`);
    expect([asVendor.status, codeOf(asVendor)]).toEqual([403, 'PERMISSION_DENIED']);

    const bare = await ask(anonymous, 'zuko');
    expect([bare.status, codeOf(bare)]).toEqual([401, 'SESSION_INVALID']);
  });
});

describe('at most eight a kind and twenty in all, in a fixed order (AC-LOOKUP-08)', () => {
  const names = (index: number): string => String(index).padStart(2, '0');

  // Break caught: more than eight of a kind or twenty in all, a kind out of order, requests not newest first, or an order that moves.
  it('keeps eight requests, eight vendors and four riders, and reads no staff member', async () => {
    const created: string[] = [];
    for (let index = 1; index <= 12; index += 1) {
      const vendor = await insertVendor(
        routes.admin,
        vendorRow({ hubId: HUB_A, legalName: `Quincy Vendor ${names(index)} Ltd` }),
      );
      const request = await insertPickupRequest(
        routes.admin,
        pickupRequestRow(vendor.organizationId, HUB_A, {
          senderName: `Quincy Sender ${names(index)}`,
          createdAt: new Date(Date.UTC(2026, 10, 1, 8, 0, index)),
        }),
      );
      created.push(request.id);
      await insertRider(
        routes.admin,
        riderRow({ hubId: HUB_A, fullName: `Quincy Rider ${names(index)}` }),
      );
    }
    for (let index = 1; index <= 12; index += 1) {
      await insertStaff(
        routes.admin,
        staffRow({ fullName: `Quincy Staff ${names(index)}`, primaryHubId: HUB_A }),
      );
    }

    const first = itemsOf(await ask(platformAdmin, 'quincy'));
    const again = itemsOf(await ask(platformAdmin, 'quincy'));

    const kinds = first.map((item) => item.kind);
    expect(kinds).toEqual([
      ...Array<string>(8).fill('PICKUP_REQUEST'),
      ...Array<string>(8).fill('VENDOR_ACCOUNT'),
      ...Array<string>(4).fill('RIDER'),
    ]);
    // The requests are the eight newest, newest first.
    expect(first.slice(0, 8).map((item) => item.id)).toEqual(created.slice(4).toReversed());
    // The others by name.
    expect(first.slice(8, 16).map((item) => item.title)).toEqual(
      Array.from({ length: 8 }, (_, index) => `Quincy Vendor ${names(index + 1)} Ltd`),
    );
    expect(first.slice(16).map((item) => item.title)).toEqual(
      Array.from({ length: 4 }, (_, index) => `Quincy Rider ${names(index + 1)}`),
    );
    expect(again).toEqual(first);
  });
});

describe('a phone is shown only when searched by, and only masked (AC-LOOKUP-09)', () => {
  // Break caught: a number in clear, a number shown in a result found by name or code, or any other personal field in a result.
  it('carries the masked number as phone_hint in a result found by the number, and none in one found by name or code', async () => {
    const byPhone = await ask(platformAdmin, '024 111 2222');
    const found = itemsOf(byPhone);
    expect(sorted(found.map((item) => item.id))).toEqual(
      sorted([requests.a.id, requests.b.id, riders.a.id]),
    );
    for (const item of found) expect(item.phone_hint, item.kind).toBe('+233******222');
    // Everything but the identifiers is searched for the digits: an identifier is random hexadecimal, which can hold any four digits by chance.
    const withoutIds = JSON.stringify(
      found.map((item) => Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'id'))),
    );
    expect(withoutIds).not.toContain('2411');
    expect(byPhone.text).not.toContain(SHARED_PHONE);

    for (const q of ['zuko', requests.a.code, 'quarmby']) {
      const other = await ask(platformAdmin, q);
      for (const item of itemsOf(other))
        expect(item.phone_hint, `${q} ${item.kind}`).toBeUndefined();
      expect(other.text, q).not.toContain('+233');
      expect(other.text, q).not.toContain('@');
    }
  });
});

describe('a result carries the record’s facts, not a route and not wording (AC-LOOKUP-10)', () => {
  const hubOf = (which: Which) => ({ id: HUBS_BY[which], display_name: HUB_NAMES[which] });

  // Break caught: a route or a sentence in an answer, a state reworded, a hub without its name, a service date on a kind that has none, a
  // field beyond the facts, or the organisation's id where the account's is wanted.
  it('carries the kind, the id, the code, the title and the facts of each kind, and nothing else', async () => {
    const items = itemsOf(await ask(platformAdmin, 'zuko'));
    const one = (id: string): Item => items.find((item) => item.id === id) ?? failure(id);

    for (const item of items) {
      expect(item, item.kind).not.toHaveProperty('route');
      expect(item, item.kind).not.toHaveProperty('subtitle');
      for (const key of Object.keys(item)) {
        expect(RESULT_FIELDS, `${item.kind}: ${key}`).toContain(key);
      }
    }
    expect(one(requests.a.id)).toEqual({
      kind: 'PICKUP_REQUEST',
      id: requests.a.id,
      code: requests.a.code,
      title: requests.a.code,
      state: 'PENDING',
      hub: hubOf('a'),
      service_date: '2026-11-03',
    });
    expect(one(requests.b.id)).toMatchObject({ state: 'PENDING', hub: hubOf('b') });
    expect(one(vendors.a.id)).toEqual({
      kind: 'VENDOR_ACCOUNT',
      id: vendors.a.id,
      code: vendors.a.code,
      title: 'Zuko Fabrics Alpha Ltd',
      state: 'ACTIVE',
      hub: hubOf('a'),
    });
    expect(one(riders.b.id)).toEqual({
      kind: 'RIDER',
      id: riders.b.id,
      title: 'Zuko Boateng Beta',
      state: 'ACTIVE',
      hub: hubOf('b'),
    });
    expect(one(staff.a.id)).toEqual({
      kind: 'STAFF_IDENTITY',
      id: staff.a.id,
      title: 'Zuko Kwarteng Alpha',
      state: 'ACTIVE',
      hub: hubOf('a'),
    });
    const run = itemsOf(await ask(platformAdmin, manifests.b.code));
    expect(run).toEqual([
      {
        kind: 'PICKUP_MANIFEST',
        id: manifests.b.id,
        code: manifests.b.code,
        title: manifests.b.code,
        state: 'DRAFT',
        hub: hubOf('b'),
        service_date: '2026-11-03',
      },
    ]);
  });

  // Break caught: a state turned into words, or one kind's value given another kind's name for it.
  it('gives a state as the value of the record’s own enumeration, whatever it is', async () => {
    const vendor = await insertVendor(
      routes.admin,
      vendorRow({ hubId: HUB_A, legalName: 'Mabel Suspended Ltd', accountStatus: 'SUSPENDED' }),
    );
    const rider = await insertRider(
      routes.admin,
      riderRow({ hubId: HUB_A, fullName: 'Mabel Suspended', status: 'TEMPORARILY_UNAVAILABLE' }),
    );
    const request = await insertPickupRequest(
      routes.admin,
      pickupRequestRow(vendor.organizationId, HUB_A, {
        senderName: 'Mabel Suspended',
        state: 'CANCELLED',
      }),
    );
    const run = await insertManifest(
      routes.admin,
      manifestRow(HUB_A, { state: 'IN_PROGRESS', assignedRiderId: rider.id }),
    );

    const states = new Map(
      itemsOf(await ask(platformAdmin, 'mabel suspended')).map((item) => [item.id, item.state]),
    );

    expect(states.get(vendor.accountId)).toBe('SUSPENDED');
    expect(states.get(rider.id)).toBe('TEMPORARILY_UNAVAILABLE');
    expect(states.get(request.id)).toBe('CANCELLED');
    expect(itemsOf(await ask(platformAdmin, run.code))[0]?.state).toBe('IN_PROGRESS');
  });

  // Break caught: a hub invented for a profile that has none, or a service date drawn for a kind that has none.
  it('has no hub for a staff profile with no primary hub, and no service date for any kind but a request and a run', async () => {
    const answer = itemsOf(await ask(platformAdmin, 'yara floating'));

    expect(answer).toEqual([
      {
        kind: 'STAFF_IDENTITY',
        id: floating.id,
        title: 'Yara Floating',
        state: 'ACTIVE',
      },
    ]);
    // ... which a grant of one hub does not reach.
    expect(itemsOf(await ask(senior, 'yara floating'))).toEqual([]);
    for (const item of itemsOf(await ask(platformAdmin, 'zuko'))) {
      if (item.kind !== 'PICKUP_REQUEST' && item.kind !== 'PICKUP_MANIFEST') {
        expect(item, item.kind).not.toHaveProperty('service_date');
      }
    }
  });
});

describe('a lookup is the person’s act, written down when it crosses a hub, and never cached (AC-LOOKUP-11)', () => {
  const crossings = (actorId: string) =>
    routes.rows<{ responsible_hub_id: string; related_ids: Record<string, string> }>(
      `select responsible_hub_id, related_ids from audit_event
        where event_code = 'auth.hub_boundary.crossed' and actor_id = $1 order by responsible_hub_id`,
      [actorId],
    );

  // Break caught: the actor's own hub audited as foreign, a foreign hub not audited, or one audited once for each record.
  it('writes one event for the second hub for a staff member of the first, and none for the first', async () => {
    const wide = await routes.actor(
      await newBundle(routes.admin, [grant('pickup.read', 'all'), grant('vendor.read', 'all')]),
      HUB_A,
    );

    const answer = await ask(wide, 'zuko');

    expect(sorted(idsOf(answer))).toEqual(
      sorted([requests.a.id, requests.b.id, vendors.a.id, vendors.b.id, senderlessRequest.id]),
    );
    expect(await crossings(wide.identity.id)).toEqual([
      { responsible_hub_id: HUB_B, related_ids: { operation_id: 'lookupRecords' } },
    ]);
  });

  it('writes one event for each hub the results represent for a staff member with no primary hub', async () => {
    const admin = await routes.platformAdmin();

    await ask(admin, 'zuko');

    expect((await crossings(admin.identity.id)).map((row) => row.responsible_hub_id)).toEqual([
      HUB_A,
      HUB_B,
    ]);
  });

  // Break caught: the primary hub of a Platform Admin ignored (every hub audited as foreign, as for one with no hub) or its reach narrowed to it.
  it('writes one event, for the second hub alone, for a Platform Admin whose primary hub is the first', async () => {
    const admin = await routes.actor(BUNDLE_IDS.platformAdmin, HUB_A);

    const answer = await ask(admin, 'zuko');

    expect(answer.status).toBe(200);
    expect(await crossings(admin.identity.id)).toEqual([
      { responsible_hub_id: HUB_B, related_ids: { operation_id: 'lookupRecords' } },
    ]);
  });

  it('writes no event for an answer with no result, and none for an officer who reads only their own hub', async () => {
    const fresh = await routes.platformAdmin();
    await ask(fresh, 'nothing-matches-this');
    expect(await crossings(fresh.identity.id)).toEqual([]);

    const own = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    await ask(own, 'zuko');
    expect(await crossings(own.identity.id)).toEqual([]);
  });

  it('is no-store, and moves the idle clock of the session that asks, as a read of a list does', async () => {
    const actor = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const activityOf = async (): Promise<Date> => {
      const [row] = await routes.rows<{ at: Date }>(
        `select last_activity_at as at from session where id = $1`,
        [actor.sessionId],
      );
      if (row === undefined) throw new Error('no such session');
      return row.at;
    };
    // Lets five minutes pass for the session, by changing the data: the guard trigger forbids it to the application, and rightly.
    await routes.admin.query('alter table session disable trigger session_guard');
    try {
      await routes.admin.query(
        `update session set issued_at = issued_at - interval '5 minutes',
                            last_activity_at = last_activity_at - interval '5 minutes',
                            expires_at = expires_at - interval '5 minutes' where id = $1`,
        [actor.sessionId],
      );
    } finally {
      await routes.admin.query('alter table session enable trigger session_guard');
    }
    const before = await activityOf();

    const answer = await ask(actor, 'zuko');

    expect(answer.status).toBe(200);
    expect(answer.header('cache-control')).toBe('no-store');
    expect((await activityOf()).getTime()).toBeGreaterThan(before.getTime());
  });
});

function failure(what: string): never {
  throw new Error(`no result for ${what}`);
}
