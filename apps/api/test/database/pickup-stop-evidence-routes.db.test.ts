import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { fileContractSource } from '../../src/platform/contract/contract-source.js';
import type { TestClient, TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { parcelPhotosOf, photoOf } from './support/evidence-photo.js';
import { manifestDays, type ManifestDays } from './support/manifest-days.js';
import { grant, newBundle } from './support/policy-fixtures.js';
import { arrangeRun, type ArrangedRun } from './support/runs.js';
import { seedHubConfiguration } from './support/seeded.js';
import { API, HUB_A, HUB_B, OPS, codeOf, type Actor } from './support/staff-routes.js';
import {
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from './support/vendor-routes.js';

/**
 * `listPickupStopEvidence` (S1.30; the Product Owner's decision D-A10, `AC-SLICE-001-86` to `-88`, `OB-S1-80`), against a real PostgreSQL and the real application, with the photos made by the
 * real operations of the evidence store:
 *
 * - **What it lists**: the evidence of one stop, oldest first, a closed projection of the members the contract names, **with no object key, no address and no signed operation**.
 * - **The progress is the server's, for the whole stop**: stored, still waiting and expired parcel photos, and what was declared; the `purpose` filter narrows the items and never the counts.
 * - **A page is a position**: paging by two reaches the same items as one page, none twice, and a photo that arrives while the officer reads comes on a later page.
 * - **The exception** that let a count through without photos is on the answer, with who, when and why, and is `null` for a stop that was not let through.
 * - **Whose**: the staff of the hub of the stop under `pickup.read`, and nobody else (the existence rule of `getPickupStop`: another hub's stop is `HUB_SCOPE_VIOLATION`, one that does
 *   not exist `NOT_FOUND`); a vendor, a rider and a caller with no session are refused; a read across hubs is audited without contents.
 */
let routes: VendorRoutes;
let days: ManifestDays;
let vendorA: ArrangedVendor;
let vendorB: ArrangedVendor;
let browser: TestClient;
let ops: Actor;
let opsB: Actor;
let platformAdmin: Actor;
let run: ArrangedRun;
let runB: ArrangedRun;

interface Item {
  readonly id: string;
  readonly purpose: string;
  readonly state: string;
  readonly captured_at: string;
  readonly uploaded_at: string | null;
  readonly content_type: string;
  readonly scanned_clean: boolean;
}
interface Page {
  readonly items: Item[];
  readonly next_page_token: string | null;
  readonly parcel_photos: { declared: number; stored: number; pending: number; expired: number };
  readonly parcel_photo_exception: null | {
    id: string;
    pickup_stop_id: string;
    authorised_by: string;
    authorised_at: string;
    note: string;
  };
}

const EVIDENCE = (stopId: string, query = ''): string =>
  `${API}/pickup-stops/${stopId}/evidence${query}`;
const bodyOf = (response: TestResponse): Page => response.json() as Page;
const outcome = (response: TestResponse): [number, string | undefined] => [
  response.status,
  codeOf(response),
];

/** A stop of the first run (the one the photos are made for) and of the second (a hub of its own). */
const stopOf = (arranged: ArrangedRun, at = 0): string => {
  const stop = arranged.stops[at];
  if (stop === undefined) throw new Error('stop');
  return stop.id;
};

/** A record whose upload window ran out with nothing stored, as the sweep leaves it: the guards are off for the one statement, as the tests age a row. */
async function expire(id: string): Promise<void> {
  await routes.admin.query('begin');
  try {
    await routes.admin.query('set local session_replication_role = replica');
    await routes.admin.query(`update evidence set state = 'EXPIRED' where id = $1`, [id]);
    await routes.admin.query('commit');
  } catch (error) {
    await routes.admin.query('rollback').catch(() => undefined);
    throw error;
  }
}

beforeAll(async () => {
  routes = await startVendorRoutes();
  await seedHubConfiguration(routes.database);
  days = await manifestDays(routes.admin);
  vendorA = await routes.vendor();
  vendorB = await routes.vendor();
  browser = routes.browser(vendorA.device.credential.token);
  expect((await routes.signIn(browser, vendorA.row.accountIdentifier, vendorA.secret)).status).toBe(
    200,
  );
  ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  opsB = await routes.actor(BUNDLE_IDS.opsStaff, HUB_B);
  platformAdmin = await routes.platformAdmin();
  run = await arrangeRun(routes.kit, routes.admin, {
    vendorOrganizationId: vendorA.row.organizationId,
    serviceDate: days.today,
    state: 'IN_PROGRESS',
    stops: 2,
    stopStates: ['ARRIVED', 'ARRIVED'],
  });
  runB = await arrangeRun(routes.kit, routes.admin, {
    vendorOrganizationId: vendorB.row.organizationId,
    serviceDate: days.today,
    state: 'IN_PROGRESS',
    stops: 1,
    stopStates: ['ARRIVED'],
    hubId: HUB_B,
  });
}, 600_000);

afterAll(async () => {
  await routes.stop();
});

describe('what the evidence of a stop lists', () => {
  // Break caught: items out of the order the platform made them in, a count that is the page's and not the stop's, an expired record counted as uploaded, a member the contract does not
  // name, or any trace of an object key, an address or a signed operation on the wire.
  it('lists the records of the stop oldest first, counts the parcel photos by state for the whole stop, and carries no key and no address', async () => {
    const stop = stopOf(run);
    const stored = await parcelPhotosOf(routes, run.rider, stop, 3);
    const waiting = (
      await photoOf(routes, run.rider, stop, { purpose: 'PARCEL_PHOTO', complete: false })
    ).id;
    const waitingToo = (
      await photoOf(routes, run.rider, stop, { purpose: 'PARCEL_PHOTO', complete: false })
    ).id;
    const gone = (
      await photoOf(routes, run.rider, stop, { purpose: 'PARCEL_PHOTO', complete: false })
    ).id;
    await expire(gone);
    const proof = (await photoOf(routes, run.rider, stop)).id;

    const response = await ops.client.get(EVIDENCE(stop));
    expect(response.status, response.text).toBe(200);
    const page = bodyOf(response);

    // The order is the moment the platform made the record (to the second), then its identifier: read from the table, because records made within one second are told apart by their
    // identifiers alone, and the test's clock makes those identifiers arbitrary within it.
    const order = (
      await routes.rows<{ id: string }>(
        `select id from evidence where owner_id = $1 order by created_at, id`,
        [stop],
      )
    ).map((row) => row.id);
    expect(page.items.map((item) => item.id)).toEqual(order);
    expect([...order].toSorted()).toEqual([...stored, waiting, waitingToo, gone, proof].toSorted());
    expect(page.next_page_token).toBeNull();
    // Whatever the page holds, the progress is the stop's: 3 stored and 2 waiting are what was declared, and the one that expired is told apart (the counts differ, so a count read for another state shows).
    expect(page.parcel_photos).toEqual({ declared: 5, stored: 3, pending: 2, expired: 1 });
    expect(page.parcel_photo_exception).toBeNull();

    const byId = (id: string): Item | undefined => page.items.find((item) => item.id === id);
    const first = byId(stored[0] ?? '');
    expect(first).toMatchObject({
      purpose: 'PARCEL_PHOTO',
      state: 'STORED',
      content_type: 'image/jpeg',
      scanned_clean: true,
    });
    expect(typeof first?.uploaded_at).toBe('string');
    expect(new Date(first?.captured_at ?? '').toString()).not.toBe('Invalid Date');
    expect(byId(waiting)).toMatchObject({
      state: 'PENDING_UPLOAD',
      uploaded_at: null,
      scanned_clean: false,
    });
    expect(byId(gone)).toMatchObject({ state: 'EXPIRED', uploaded_at: null, scanned_clean: false });
    expect(byId(proof)).toMatchObject({ purpose: 'COLLECTION_PROOF', state: 'STORED' });

    // The closed list of members is the contract's, and nothing that is a key, an address or a signature is on the wire.
    const contract = fileContractSource.load() as {
      components: { schemas: Record<string, { properties: Record<string, unknown> }> };
    };
    const members = Object.keys(contract.components.schemas.StopEvidenceItem?.properties ?? {});
    for (const item of page.items) expect(Object.keys(item).toSorted()).toEqual(members.toSorted());
    expect(Object.keys(page).toSorted()).toEqual(
      ['items', 'next_page_token', 'parcel_photo_exception', 'parcel_photos'].toSorted(),
    );
    const written = response.text;
    for (const secret of ['ev/', 'http', 'signature', 'storage', 'checksum', 'X-Amz']) {
      expect(written.toLowerCase()).not.toContain(secret.toLowerCase());
    }
  });

  // Break caught: the filter narrowing the counts as well (the officer then reads "1 of 1 uploaded" for a stop with twelve), or a purpose that is not one accepted.
  it('narrows the items by purpose and never the counts, and refuses a purpose that is not one', async () => {
    const stop = stopOf(run);
    const all = bodyOf(await ops.client.get(EVIDENCE(stop)));
    const parcel = bodyOf(await ops.client.get(EVIDENCE(stop, '?purpose=PARCEL_PHOTO')));
    const proof = bodyOf(await ops.client.get(EVIDENCE(stop, '?purpose=COLLECTION_PROOF')));

    expect(parcel.items.every((item) => item.purpose === 'PARCEL_PHOTO')).toBe(true);
    expect(proof.items.map((item) => item.purpose)).toEqual(['COLLECTION_PROOF']);
    expect(parcel.items.length + proof.items.length).toBe(all.items.length);
    expect(proof.parcel_photos).toEqual(all.parcel_photos);
    expect(parcel.parcel_photos).toEqual(all.parcel_photos);
    expect(outcome(await ops.client.get(EVIDENCE(stop, '?purpose=CONDITION')))).toEqual([
      400,
      'VALIDATION_FAILED',
    ]);
  });

  // Break caught: a stop that has no evidence answered with an error, or with a count that is not zero.
  it('answers a stop with no evidence with nothing and zero, and no exception', async () => {
    const empty = bodyOf(await ops.client.get(EVIDENCE(stopOf(run, 1))));
    expect(empty).toMatchObject({
      items: [],
      next_page_token: null,
      parcel_photos: { declared: 0, stored: 0, pending: 0, expired: 0 },
      parcel_photo_exception: null,
    });
  });
});

describe('a page is a position', () => {
  // Break caught: a page that repeats an item or skips one, a position that moves with a record that arrives while the officer is paging, or a next page that is offered at the end.
  it('pages by two to the same items as one page, none twice, and a photo that arrives meanwhile comes last', async () => {
    const stop = stopOf(run);
    const whole = bodyOf(await ops.client.get(EVIDENCE(stop, '?page_size=100'))).items.map(
      (item) => item.id,
    );
    expect(whole.length).toBe(7);

    const first = bodyOf(await ops.client.get(EVIDENCE(stop, '?page_size=2')));
    expect(first.items.map((item) => item.id)).toEqual(whole.slice(0, 2));
    expect(first.next_page_token).not.toBeNull();

    // A photo arrives while the officer reads. The moment a record is made is kept to the second, and records of one second are told apart by their identifiers (time-ordered in
    // production, arbitrary under this test's clock), so the photo is made a second later: it is then the last record, whatever its identifier, and no page that was read moves.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const arrived = (await photoOf(routes, run.rider, stop, { purpose: 'PARCEL_PHOTO' })).id;

    const seen = [...first.items.map((item) => item.id)];
    let token = first.next_page_token;
    let pages = 1;
    while (token !== null) {
      const next = bodyOf(
        await ops.client.get(
          EVIDENCE(stop, `?page_size=2&page_token=${encodeURIComponent(token)}`),
        ),
      );
      seen.push(...next.items.map((item) => item.id));
      token = next.next_page_token;
      pages += 1;
    }
    expect(seen).toEqual([...whole, arrived]);
    expect(new Set(seen).size).toBe(seen.length);
    expect(pages).toBe(4);
    // The count of the stop moved with it, as the server's: one more stored photo.
    expect(bodyOf(await ops.client.get(EVIDENCE(stop))).parcel_photos.stored).toBe(4);
  });

  // Break caught: a page size or a token that is not one served as the first page, which would hide the mistake of a client.
  it.each([['page_size=0'], ['page_size=101'], ['page_size=x'], ['page_token=not-a-position']])(
    'refuses %s',
    async (query) => {
      expect(outcome(await ops.client.get(EVIDENCE(stopOf(run), `?${query}`)))).toEqual([
        400,
        'VALIDATION_FAILED',
      ]);
    },
  );
});

describe('the exception that let a count through without photos', () => {
  // Break caught: the exception missing from the answer, shown for a stop it was not made for, or without who, when and why.
  it('is on the answer of the stop it was made for, with who, when and why, and on no other', async () => {
    const stop = stopOf(run, 1);
    const made = await ops.client.post(
      `${API}/pickup-stops/${stop}/parcel-photo-exception`,
      { note: 'The camera does not work' },
      { origin: OPS, headers: { 'Idempotency-Key': randomUUID() } },
    );
    expect(made.status, made.text).toBe(200);

    const page = bodyOf(await ops.client.get(EVIDENCE(stop)));
    expect(page.parcel_photo_exception).toMatchObject({
      pickup_stop_id: stop,
      authorised_by: ops.identity.id,
      note: 'The camera does not work',
    });
    expect(
      new Date(page.parcel_photo_exception?.authorised_at ?? '').getTime(),
    ).toBeLessThanOrEqual(Date.now() + 2000);
    expect(bodyOf(await ops.client.get(EVIDENCE(stopOf(run)))).parcel_photo_exception).toBeNull();
  });
});

describe('whose, and what is audited', () => {
  const crossings = (stopId: string) =>
    routes.rows<{ responsible_hub_id: string }>(
      `select responsible_hub_id from audit_event
        where event_code = 'auth.hub_boundary.crossed' and object_id = $1 and related_ids ->> 'operation_id' = 'listPickupStopEvidence'`,
      [stopId],
    );

  // Break caught (the existence rule of `getPickupStop`): another hub's stop answered as a list (or as `NOT_FOUND`, which says it is not there), an id that matches nothing answered as another hub's.
  it('tells a stop of another hub from one that does not exist, as getPickupStop does', async () => {
    expect(outcome(await opsB.client.get(EVIDENCE(stopOf(run))))).toEqual([
      403,
      'HUB_SCOPE_VIOLATION',
    ]);
    expect(outcome(await ops.client.get(EVIDENCE(stopOf(runB))))).toEqual([
      403,
      'HUB_SCOPE_VIOLATION',
    ]);
    expect(outcome(await ops.client.get(EVIDENCE(randomUUID())))).toEqual([404, 'NOT_FOUND']);
    expect(outcome(await ops.client.get(EVIDENCE('not-an-id')))).toEqual([
      400,
      'VALIDATION_FAILED',
    ]);
  });

  // Break caught: the read of a stop in another hub that is not audited, or one that is written for the actor's own hub.
  it('audits a read across hubs and not a read of the own hub', async () => {
    const own = stopOf(run);
    const foreign = stopOf(runB);
    expect((await ops.client.get(EVIDENCE(own))).status).toBe(200);
    expect(await crossings(own)).toEqual([]);

    expect((await platformAdmin.client.get(EVIDENCE(foreign))).status).toBe(200);
    expect((await crossings(foreign)).map((event) => event.responsible_hub_id)).toEqual([HUB_B]);
  });

  // Break caught: the read opened by a key it does not name, or by none.
  it('is read with pickup.read and with no other key', async () => {
    const reads = async (keys: string[]): Promise<number> => {
      const bundle = await newBundle(
        routes.admin,
        keys.map((key) => grant(key, 'own')),
      );
      const actor = await routes.actor(bundle, HUB_A);
      return (await actor.client.get(EVIDENCE(stopOf(run)))).status;
    };
    expect(await reads(['pickup.read'])).toBe(200);
    for (const key of [
      'pickup.handshake.override',
      'pickup.failure.resolve',
      'dispatch.read',
      'notification.read',
    ]) {
      expect(await reads([key]), key).toBe(403);
    }
    expect(await reads([])).toBe(403);
  });

  // Break caught: the list served to a vendor, to a rider, or to no session.
  it('refuses a vendor, a rider and a caller with no session', async () => {
    const stop = stopOf(run);
    expect(outcome(await browser.get(EVIDENCE(stop)))).toEqual([403, 'PERMISSION_DENIED']);
    expect(outcome(await run.rider.client.get(EVIDENCE(stop)))).toEqual([401, 'SESSION_INVALID']);
    expect(outcome(await routes.kit.client.fork().get(EVIDENCE(stop)))).toEqual([
      401,
      'SESSION_INVALID',
    ]);
  });
});
