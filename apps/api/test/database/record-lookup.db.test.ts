import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hubLocal } from '../../src/pickup/cutoff.js';
import { TestClient, type TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { HUBS } from '../../src/tools/seed/hubs.js';
import { insertStaff, staffRow } from './support/identities.js';
import { arrangedFixedSession } from './support/http-sessions.js';
import { insertManifest, manifestRow } from './support/manifests.js';
import { ARRANGER, insertPickupRequest, pickupRequestRow } from './support/pickups.js';
import { grant, newBundle } from './support/policy-fixtures.js';
import { insertRider, insertRiderDevice, riderRow } from './support/riders.js';
import { API, HUB_A, HUB_B, OPS, codeOf, type Actor } from './support/staff-routes.js';
import { insertVendor, vendorRow } from './support/vendors.js';
import { startVendorRoutes, type VendorRoutes } from './support/vendor-routes.js';

/**
 * `lookupRecords` against the real application and a real PostgreSQL (task C2 and C2.1; `features/operations/global-lookup.md`,
 * `AC-LOOKUP-01` to `-15`): a record found by its code, a name or a phone number typed in full, and only a record the same session could open
 * through its own read. Two hubs, each with a vendor, a request, a run, a rider and a staff member whose names share a word ("Zuko") so that one
 * query meets every kind in both hubs. The call is a POST with the body `{ "q": ... }` that changes nothing (the Product Owner's decision of
 * 6 November 2026): a phone number typed in full is in no URL.
 */
const LOOKUP = `${API}/ops/lookup`;
const SHARED_PHONE = '+233241112222';

const HUBS_BY = { a: HUB_A, b: HUB_B } as const;
/** The names the fixtures give the two hubs: the seeded launch hub, and the one `startStaffRoutes` adds. */
const HUB_NAMES = { a: HUBS[0]?.name ?? '', b: 'Kumasi' } as const;
const SUFFIX = { a: 'Alpha', b: 'Beta' } as const;
type Which = 'a' | 'b';

/** Every field a result may carry (`RecordLookupResult`): the facts of a record and nothing else. */
const RESULT_FIELDS = [
  'kind',
  'id',
  'code',
  'title',
  'state',
  'hub',
  'service_date',
  'sender_name',
  'phone_hint',
];

/** The hub's day `offset` days from today, as a `YYYY-MM-DD` date: the hub's clock is `Africa/Accra`, which has no daylight saving. */
const daysFromToday = (offset: number): string => {
  const day = new Date(`${hubLocal(new Date()).date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + offset);
  return day.toISOString().slice(0, 10);
};

/** Waits out the last seconds before the hub's midnight, so that a test that arranges dates by "today" and then asks is not split by a new day. */
const stayInToday = async (): Promise<void> => {
  const now = new Date();
  const toMidnight =
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - now.getTime();
  if (toMidnight < 30_000) await new Promise((resolve) => setTimeout(resolve, toMidnight + 1_000));
};

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

/**
 * The call: a POST with the text in the body, as the Ops Portal sends it: with the session's synchronizer token (the actor's client sends it) and the
 * Ops Portal's Origin (this harness serves two browsers' origins, so a staff client names its own).
 */
const ask = (actor: Actor | TestClient, q: string): Promise<TestResponse> =>
  'client' in actor ? actor.client.post(LOOKUP, { q }, { origin: OPS }) : actor.post(LOOKUP, { q });

interface Item {
  readonly kind: string;
  readonly id: string;
  readonly code?: string;
  readonly title: string;
  readonly state?: string;
  readonly hub?: { readonly id: string; readonly display_name: string };
  readonly service_date?: string;
  readonly sender_name?: string;
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
  const violationsOf = (answer: TestResponse): { in: string; pointer: string }[] =>
    (answer.json() as { details: { violations: { in: string; pointer: string }[] } }).details
      .violations;

  it.each([
    ['a'],
    ['  a  '],
    ['x'.repeat(65)],
    // 69 characters as sent, 65 once folded: both rules refuse it.
    [`${'x'.repeat(32)}     ${'y'.repeat(32)}`],
    // A NUL character is in no name, and PostgreSQL refuses it in a text: a refused query and never a failed read (a 500).
    ['ab\u0000cd'],
  ])('is VALIDATION_FAILED for the text %j', async (q) => {
    const answer = await ask(officer, q);

    expect([answer.status, codeOf(answer)]).toEqual([400, 'VALIDATION_FAILED']);
    // The violation names the field q of the body: the contract's own check spells its place `/q` as the handler's does.
    const violations = violationsOf(answer);
    expect(violations.length).toBeGreaterThan(0);
    for (const violation of violations) {
      expect(violation.in).toBe('body');
      expect(violation.pointer).toBe('/q');
    }
  });

  // Break caught: a body the contract refuses being read as a text (no body, no q, a q that is not a string, another field), or a refusal that is
  // not a validation failure naming the place at fault: the field q, or the body as a whole where it is absent or carries a field it should not (the
  // platform spells the body itself with an empty pointer, and does not echo the name of a field it did not expect).
  it.each([
    ['no body', undefined, ''],
    ['an empty object', {}, '/q'],
    ['a q that is a number', { q: 42 }, '/q'],
    ['a q that is null', { q: null }, '/q'],
    ['a field beside q', { q: 'zuko', limit: 5 }, ''],
  ])('is VALIDATION_FAILED for %s', async (_what, body, pointer) => {
    const answer = await officer.client.post(LOOKUP, body, { origin: OPS });

    expect([answer.status, codeOf(answer)]).toEqual([400, 'VALIDATION_FAILED']);
    expect(
      violationsOf(answer).map((violation) => [violation.in, violation.pointer]),
    ).toContainEqual(['body', pointer]);
  });

  // Break caught: the text still read from the address (a phone number in a URL a proxy keeps), or a GET that still answers.
  it('reads the text from the body alone, and a GET of the path is no route', async () => {
    const inAddress = await officer.client.post(`${LOOKUP}?q=zuko`, {}, { origin: OPS });
    expect([inAddress.status, codeOf(inAddress)]).toEqual([400, 'VALIDATION_FAILED']);

    // A text in the address and another in the body: the body is the query.
    const both = await officer.client.post(
      `${LOOKUP}?q=nothing-matches-this`,
      { q: 'quarmby' },
      { origin: OPS },
    );
    expect(both.status).toBe(200);
    expect(idsOf(both)).toEqual([requests.a.id]);

    const get = await officer.client.get(`${LOOKUP}?q=quarmby`);
    expect([get.status, codeOf(get)]).toEqual([404, 'NOT_FOUND']);
    expect(get.text).not.toContain('items');
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
      expect(answer.status, answer.text).toBe(200);
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

    const asVendor = await browser.post(LOOKUP, { q: 'zuko' });
    expect([asVendor.status, codeOf(asVendor)]).toEqual([403, 'PERMISSION_DENIED']);

    const bare = await ask(anonymous, 'zuko');
    expect([bare.status, codeOf(bare)]).toEqual([401, 'SESSION_INVALID']);
  });

  // Break caught (the audit of 7 November 2026, A6): a Rider's bearer credential served, or refused with the surface gate's PERMISSION_DENIED, which would
  // tell a rider that the operation exists and is another surface's. This operation takes a browser session alone, so a bearer credential is a request with
  // no usable session: SESSION_INVALID, the same answer in every word as a request with none (the negative-access sweep holds the same for every
  // operation: negative-access-sweep.db.test.ts, SELF_SERVES). Nothing is read and nothing is written.
  it('refuses a Rider’s bearer credential with SESSION_INVALID, as it refuses a request with no session, and writes no event', async () => {
    const rider = await insertRider(routes.admin, riderRow({ hubId: HUB_A }));
    const device = await insertRiderDevice(routes.admin, rider.id);
    const session = await arrangedFixedSession(routes.kit, routes.admin, 'RIDER', {
      principalId: rider.id,
      registeredDeviceId: device.id,
    });
    const bearer = new TestClient({ baseUrl: routes.kit.app.baseUrl }).bearer(session.token);
    const crossingsBefore = await routes.rows(
      `select 1 from audit_event where event_code = 'auth.hub_boundary.crossed'`,
    );

    const asRider = await bearer.post(LOOKUP, { q: 'zuko' });
    const bare = await ask(anonymous, 'zuko');

    expect([asRider.status, codeOf(asRider)]).toEqual([401, 'SESSION_INVALID']);
    expect(asRider.text).not.toContain('items');
    // The same answer as no session at all: status, code and message, whatever the request's own identifier.
    const told = (response: TestResponse): { code?: string; message?: string } => {
      const { code, message } = response.json() as { code?: string; message?: string };
      return { code, message };
    };
    expect(told(asRider)).toEqual(told(bare));
    expect(
      (
        await routes.rows(
          `select 1 from audit_event where event_code = 'auth.hub_boundary.crossed'`,
        )
      ).length,
    ).toBe(crossingsBefore.length);
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
      sender_name: 'Zuko Quarmby-Demo Alpha',
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

  // Break caught: the sender's name left out of a request found by a code or a number (it was only in the name search's reach), a name other than the
  // one the record's own read shows, or the field drawn for a kind that has no sender.
  it('names the sender of a request however it is found, as the request’s own read does, and of no other kind', async () => {
    for (const q of ['quarmby', requests.a.code, '024 111 2222']) {
      const found = itemsOf(await ask(platformAdmin, q)).find((item) => item.id === requests.a.id);
      expect(found?.sender_name, q).toBe('Zuko Quarmby-Demo Alpha');
    }
    const own = await platformAdmin.client.get(`${API}/pickup-requests/${requests.a.id}`);
    expect((own.json() as { sender_name: string }).sender_name).toBe('Zuko Quarmby-Demo Alpha');

    for (const item of itemsOf(await ask(platformAdmin, 'zuko'))) {
      if (item.kind !== 'PICKUP_REQUEST') expect(item, item.kind).not.toHaveProperty('sender_name');
    }
    expect(itemsOf(await ask(platformAdmin, manifests.a.code))[0]).not.toHaveProperty(
      'sender_name',
    );
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
        // A cancelled request is found by a name only within the window of AC-LOOKUP-13: dated by today, so that the test holds on any day.
        serviceDate: daysFromToday(0),
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

  // Break caught: a lookup that is a POST and skips the guard of a POST (the cookie alone being enough), or one that reads before the guard has
  // judged (events for hubs crossed by a refused request).
  it.each([
    ['no synchronizer token', OPS, 'omit'],
    ['another token', OPS, 'not-the-token-of-this-session'],
    ['an Origin that is not the Ops Portal’s', 'https://evil.example', 'own'],
    ['no Origin', null, 'own'],
  ] as const)(
    'is refused with CSRF_VALIDATION_FAILED for %s, reads nothing and writes no event',
    async (_what, origin, token) => {
      const admin = await routes.platformAdmin();
      // The persona's client always echoes the token it was issued, so a refusal is asked of a client that holds the credential by value.
      const holder = routes.kit.client.fork();

      const refused = await holder.post(
        LOOKUP,
        { q: 'zuko' },
        {
          origin,
          csrf: token === 'own' ? (admin.csrf ?? 'omit') : token,
          headers: { cookie: `melarc_session=${admin.token}` },
        },
      );

      expect([refused.status, codeOf(refused)]).toEqual([403, 'CSRF_VALIDATION_FAILED']);
      expect(refused.text).not.toContain('items');
      expect(await crossings(admin.identity.id)).toEqual([]);
      // The same session, asking as the Portal does, is answered and crosses both hubs.
      expect((await ask(admin, 'zuko')).status).toBe(200);
      expect((await crossings(admin.identity.id)).length).toBe(2);
    },
  );

  // Break caught: an answer kept and served again (a cache of a lookup in the application, or a POST taken for a command whose answer is replayed under
  // a key), when the same query asked twice reads twice: a record made between the two asks is in the second answer. No key is sent or asked.
  it('reads again each time it is asked, and is answered without an Idempotency-Key', async () => {
    const asker = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);

    const first = await ask(asker, 'repeatson');
    expect(first.status).toBe(200);
    expect(itemsOf(first)).toEqual([]);

    const made = await insertPickupRequest(
      routes.admin,
      pickupRequestRow(vendors.a.organizationId, HUB_A, { senderName: 'Repeatson Later' }),
    );

    expect(idsOf(await ask(asker, 'repeatson'))).toEqual([made.id]);
    expect(idsOf(await ask(asker, 'repeatson'))).toEqual([made.id]);
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

describe('a name finds a pickup request only while it is current work (AC-LOOKUP-13)', () => {
  const NAME = 'Windowson';
  const request: Record<string, Found & { readonly phone: string }> = {};
  let rider: { id: string };
  let phones = 0;

  const arrange = async (
    label: string,
    which: Which,
    state: 'PENDING' | 'CONFIRMED' | 'DECLINED' | 'CANCELLED',
    offset: number,
    createdAt?: Date,
  ): Promise<void> => {
    phones += 1;
    const phone = `+2332455500${String(phones).padStart(2, '0')}`;
    const row = await insertPickupRequest(
      routes.admin,
      pickupRequestRow(vendors[which].organizationId, HUBS_BY[which], {
        senderName: `${NAME} ${label}`,
        state,
        serviceDate: daysFromToday(offset),
        primaryPhone: phone,
        ...(createdAt === undefined ? {} : { createdAt }),
      }),
    );
    request[label] = { id: row.id, code: row.code, phone };
  };

  beforeAll(async () => {
    // The dates are arranged by the hub's today and asked a moment later: not across the hub's midnight.
    await stayInToday();
    // A non-terminal state is current work whatever the date.
    await arrange('Confirmed200', 'a', 'CONFIRMED', -200);
    await arrange('Pending200', 'a', 'PENDING', -200);
    // A terminal one is current work from 30 days before today on: judged on the service date, not on when the request was made (this one was
    // made 300 days ago and is dated 5 days past; the 31-day one was made just now).
    await arrange('Cancelled5', 'a', 'CANCELLED', -5, new Date(Date.now() - 300 * 86_400_000));
    await arrange('Cancelled30', 'a', 'CANCELLED', -30);
    await arrange('Declined30', 'a', 'DECLINED', -30);
    await arrange('Cancelled31', 'a', 'CANCELLED', -31);
    await arrange('Declined31', 'a', 'DECLINED', -31);
    await arrange('Ahead10', 'a', 'CANCELLED', 10);
    await arrange('SecondHub5', 'b', 'CANCELLED', -5);
    await arrange('SecondHub31', 'b', 'CANCELLED', -31);
    rider = await insertRider(routes.admin, riderRow({ hubId: HUB_A, fullName: `${NAME} Rider` }));
  }, 120_000);

  const inWindowOfHubA = [
    'Confirmed200',
    'Pending200',
    'Cancelled5',
    'Cancelled30',
    'Declined30',
    'Ahead10',
  ];

  // Break caught: no window (an old terminal request found), a window on the wrong date (the creation date), a window that is a day too wide or
  // too narrow, a terminal state treated as current, a non-terminal one windowed, a future date left out, or the window put on another kind.
  it('gives an officer of the hub the requests that are current work, and the rider, and not the terminal ones dated more than 30 days ago', async () => {
    const found = await ask(officer, NAME.toLowerCase());

    expect(found.status).toBe(200);
    expect(sorted(idsOf(found))).toEqual(
      sorted([...inWindowOfHubA.map((label) => request[label]?.id ?? ''), rider.id]),
    );
  });

  // Break caught: a window that is judged for one scope only, or one that hides another hub's recent request from a session that reaches it.
  it('gives a Platform Admin the same, and the recent request of the second hub, and not its old one', async () => {
    const found = await ask(platformAdmin, NAME);

    expect(sorted(idsOf(found))).toEqual(
      sorted([
        ...inWindowOfHubA.map((label) => request[label]?.id ?? ''),
        request.SecondHub5?.id ?? '',
        rider.id,
      ]),
    );
  });

  // Break caught: the window applied to a code or a number, which would make an old request unfindable by the identifier that is meant to find it.
  it.each([['Cancelled31'], ['Declined31']])(
    'still finds %s by its code and by its contact phone typed in full, and not by its name',
    async (label) => {
      const own = request[label] ?? failure(label);

      expect(idsOf(await ask(officer, own.code))).toEqual([own.id]);
      expect(idsOf(await ask(officer, own.code.toLowerCase()))).toEqual([own.id]);
      const byPhone = await ask(officer, `0${own.phone.slice(4)}`);
      expect(idsOf(byPhone)).toEqual([own.id]);
      // Whichever word of the sender's name is typed, and in whichever case, a request outside the window is not found by it.
      for (const typed of [label, label.toLowerCase(), label.toUpperCase(), `${NAME} ${label}`]) {
        expect(idsOf(await ask(officer, typed)), typed).toEqual([]);
      }
    },
  );

  // Break caught: a window that moves with the request's creation or a day off at the edge, in either direction.
  it('draws the edge at 30 days: a terminal request dated 30 days ago is found by its name, one dated 31 days ago is not', async () => {
    expect(idsOf(await ask(officer, 'Cancelled30'))).toEqual([request.Cancelled30?.id]);
    expect(idsOf(await ask(officer, 'Declined30'))).toEqual([request.Declined30?.id]);
    expect(idsOf(await ask(officer, 'Cancelled31'))).toEqual([]);
    expect(idsOf(await ask(officer, 'Declined31'))).toEqual([]);
    expect(idsOf(await ask(officer, 'Ahead10'))).toEqual([request.Ahead10?.id]);
  });
});

/** The hub-crossing events written for an actor (the rows, in the order of the hubs' ids). */
const crossingsOf = (actorId: string) =>
  routes.rows<{ responsible_hub_id: string }>(
    `select responsible_hub_id from audit_event
      where event_code = 'auth.hub_boundary.crossed' and actor_id = $1 order by responsible_hub_id`,
    [actorId],
  );

/**
 * The lookup has no limiter of its own (the audit of 7 November 2026, A5): the authentication step counts every request of a session in its one bucket of
 * API requests (`rate_limit_authenticated_api`, settings.md section 7.7), and the lookup, which declares `RATE_LIMITED`, answers the request past the limit
 * with the documented 429, which carries a `Retry-After` (A2 of the audit, `AC-SLICE-000-131`). The sessions of the other tests of this file are not
 * used: each has its own bucket, and this test spends a whole one.
 */
describe('a lookup is counted in the session’s bucket of API requests (AC-LOOKUP-14)', () => {
  // Break caught: no limit on the lookup (a typed search that asks as fast as it likes), a limit that is not the setting's, a bucket of the lookup's own (the
  // admissions would not all be in the shared one), a refusal that is not the documented 429 (a defect 500, as an operation that does not declare it is
  // answered), a refused request that still reads or writes, or a limit that spreads to another session.
  it('refuses the request past the setting’s limit in a minute with RATE_LIMITED, reads nothing, writes no event, and limits that session alone', async () => {
    const [setting] = await routes.rows<{ value: number }>(
      `select value from setting where key = 'rate_limit_authenticated_api'`,
    );
    const limit = Number(setting?.value);
    expect(limit).toBe(120);
    const asker = await routes.platformAdmin();
    const [started] = await routes.rows<{ now: Date }>(`select clock_timestamp() as now`);
    const admitted = () =>
      routes.rows<{ bucket: string; n: number }>(
        `select bucket, count(*)::int as n from rate_limit_admission where admitted_at >= $1 group by bucket`,
        [started?.now],
      );

    // As many lookups as the setting allows, of a code that names no record (one short statement each).
    for (let index = 0; index < limit; index += 1) {
      const answer = await ask(asker, 'ACC-PR-AAAAAA');
      expect(answer.status, `lookup ${String(index + 1)} of ${String(limit)}`).toBe(200);
    }
    // Every one of them is in the one shared bucket, and in no other.
    expect(await admitted()).toEqual([{ bucket: 'rate_limit_authenticated_api', n: limit }]);

    // The next, of a text that would cross both hubs for a Platform Admin without a hub of its own, is refused and does nothing.
    const spent = await ask(asker, 'zuko');
    expect([spent.status, codeOf(spent)]).toEqual([429, 'RATE_LIMITED']);
    // It is told when to come back (AC-SLICE-000-131): whole seconds inside the limiter's 60-second window, and never nought.
    const wait = spent.header('retry-after');
    expect(wait).toMatch(/^[1-9][0-9]?$/);
    expect(Number(wait)).toBeLessThanOrEqual(60);
    expect(spent.text).not.toContain('items');
    expect(
      await routes.rows(
        `select 1 from audit_event where event_code = 'auth.hub_boundary.crossed' and actor_id = $1`,
        [asker.identity.id],
      ),
    ).toEqual([]);
    expect(await admitted()).toEqual([{ bucket: 'rate_limit_authenticated_api', n: limit }]);

    // Another session is not limited by it, and a lookup that is answered crosses the hubs as before.
    const other = await routes.platformAdmin();
    expect((await ask(other, 'zuko')).status).toBe(200);
    expect((await crossingsOf(other.identity.id)).length).toBe(2);
  }, 180_000);
});

function failure(what: string): never {
  throw new Error(`no result for ${what}`);
}
