import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { parcelPhotosOf, photoOf } from './support/evidence-photo.js';
import { manifestDays, type ManifestDays } from './support/manifest-days.js';
import { arrangeRun, arrangedRider, type ArrangedRider, type ArrangedRun } from './support/runs.js';
import { seedHubConfiguration } from './support/seeded.js';
import { API, HUB_A, HUB_B, OPS, codeOf, type Actor } from './support/staff-routes.js';
import {
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from './support/vendor-routes.js';

/**
 * D-A10 (the Product Owner's decision of 12 November 2026; pickup-collection.md section 5.5; `AC-SLICE-001-86`, `-87` and `-88`; migration `0088`): **the photo of every parcel at the
 * door**, against a real PostgreSQL and the real application, with the photos made by the real operations of the evidence store.
 *
 * - **The photos make the count**: `recordCollection` takes exactly `collected_count` stored photos of this rider and this stop, each attached once, and refuses any other number
 *   (none included) and a photo named twice; the refusals of the count come before the photos.
 * - **Only a photo that can be counted is counted**, and the refusal is one answer (`EVIDENCE_NOT_STORED`): pending, expired, another rider's, another stop's, another purpose's, already attached.
 * - **Ops lets a stop through without photos** (`authoriseParcelPhotoException`, `pickup.handshake.override`): once, before the count, with a note, as an enhanced event; the count then
 *   takes none and refuses any; and the refusals of the operation (a blank note, another hub, no key, a stop not arrived at or already counted, a second exception).
 * - **The database holds the number for every writer**, at the end of the transaction: a record with another number of photos, a photo added to a count later, a photo attached twice,
 *   a photo of another kind or another rider's, an exception changed or removed: each is refused, whoever writes it.
 */
let routes: VendorRoutes;
let days: ManifestDays;
let vendorA: ArrangedVendor;
let ops: Actor;
let opsB: Actor;
let finance: Actor;

beforeAll(async () => {
  routes = await startVendorRoutes();
  await seedHubConfiguration(routes.database);
  days = await manifestDays(routes.admin);
  vendorA = await routes.vendor();
  ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  opsB = await routes.actor(BUNDLE_IDS.opsStaff, HUB_B);
  finance = await routes.actor(BUNDLE_IDS.finance, HUB_A);
}, 180_000);

afterAll(async () => {
  await routes.stop();
});

const STOP = (id: string) => `${API}/pickup-stops/${id}`;
const COLLECT = (id: string) => `${STOP(id)}/collect`;
const EXCEPTION = (id: string) => `${STOP(id)}/parcel-photo-exception`;
const EXCEPTION_EVENT = 'pickup.collection.photo_exception_authorised';
const SHORT = { collected_count: 2, variance_reason_code: 'SOME_PARCELS_NOT_READY' } as const;

const outcome = (response: TestResponse): [number, string | undefined] => [
  response.status,
  codeOf(response),
];
const ruleOf = (response: TestResponse): string | undefined =>
  (response.json() as { details?: { rule?: string } }).details?.rule;
const violationsOf = (response: TestResponse): { in: string; pointer: string; rule: string }[] =>
  (
    response.json() as {
      details?: { violations?: { in: string; pointer: string; rule: string }[] };
    }
  ).details?.violations ?? [];

/** A run in progress with two stops the rider has arrived at; each declares three packages. */
const run = (): Promise<ArrangedRun> =>
  arrangeRun(routes.kit, routes.admin, {
    vendorOrganizationId: vendorA.row.organizationId,
    serviceDate: days.today,
    state: 'IN_PROGRESS',
    stops: 2,
    stopStates: ['ARRIVED', 'ARRIVED'],
  });
const stopAt = (arranged: ArrangedRun, index = 0): ArrangedRun['stops'][number] => {
  const stop = arranged.stops[index];
  if (stop === undefined) throw new Error('stop');
  return stop;
};

/** The count of a stop, as the rider makes it, with whatever the test names. */
async function collect(
  rider: ArrangedRider,
  stopId: string,
  body: Record<string, unknown>,
  key: string = randomUUID(),
): Promise<TestResponse> {
  const etag = (await rider.client.get(STOP(stopId))).header('etag') ?? '';
  return rider.client.post(COLLECT(stopId), body, {
    headers: { 'If-Match': etag, 'Idempotency-Key': key },
  });
}

const authorise = (
  who: Actor,
  stopId: string,
  body: Record<string, unknown> = { note: 'The camera does not work' },
  key: string = randomUUID(),
): Promise<TestResponse> =>
  who.client.post(EXCEPTION(stopId), body, { origin: OPS, headers: { 'Idempotency-Key': key } });

const recordsOf = (stopId: string) =>
  routes.rows<{ id: string; collected_count: number; variance: string }>(
    `select id, collected_count, variance from collection_record where pickup_stop_id = $1`,
    [stopId],
  );
const linksOf = (stopId: string) =>
  routes.rows<{
    evidence_id: string;
    collection_record_id: string;
    pickup_stop_id: string;
    responsible_hub_id: string;
    attached_by_rider: string;
    attached_at: Date;
  }>(`select * from collection_parcel_photo where pickup_stop_id = $1 order by evidence_id`, [
    stopId,
  ]);
const exceptionsOf = (stopId: string) =>
  routes.rows<{
    id: string;
    responsible_hub_id: string;
    authorised_by: string;
    authorised_at: Date;
    note: string;
  }>(`select * from parcel_photo_exception where pickup_stop_id = $1`, [stopId]);
const eventsOf = (stopId: string) =>
  routes.rows<{
    actor_type: string;
    actor_id: string | null;
    enhanced: boolean;
    outcome: string;
    object_type: string;
    responsible_hub_id: string | null;
    previous_state: string | null;
    resulting_state: string | null;
    note: string | null;
    before_after: Record<string, unknown> | null;
    related_ids: Record<string, string> | null;
    detail: Record<string, unknown> | null;
  }>(
    `select actor_type, actor_id, enhanced, outcome, object_type, responsible_hub_id, previous_state, resulting_state, note, before_after, related_ids, detail
       from audit_event where event_code = $1 and object_id = $2 order by recorded_at, id`,
    [EXCEPTION_EVENT, stopId],
  );

/** Changes a stored fact of an evidence record, which the record's guard forbids to every writer: the guard and the version trigger are put aside for the one statement. */
async function arrangeEvidence(id: string, assignments: string): Promise<void> {
  await routes.admin.query('alter table evidence disable trigger evidence_guard');
  await routes.admin.query('alter table evidence disable trigger evidence_version');
  try {
    await routes.admin.query(`update evidence set ${assignments} where id = $1`, [id]);
  } finally {
    await routes.admin.query('alter table evidence enable trigger evidence_version');
    await routes.admin.query('alter table evidence enable trigger evidence_guard');
  }
}

describe('recordCollection: the photos make the count (AC-SLICE-001-86)', () => {
  // Break caught: a count that does not attach its photos, attaches one twice or to the wrong count, or lets the writer choose the stop, the hub, the rider or the moment.
  it('records the count with one stored photo for each parcel, attaches each once, and derives the facts of every link', async () => {
    const arranged = await run();
    const stop = stopAt(arranged);
    const photos = await parcelPhotosOf(routes, arranged.rider, stop.id, 3);

    const sentAt = Date.now();
    const response = await collect(arranged.rider, stop.id, {
      collected_count: 3,
      parcel_photo_ids: photos,
    });
    expect(response.status, response.text).toBe(200);
    const answeredAt = Date.now();
    const [record, ...more] = await recordsOf(stop.id);
    expect(more).toEqual([]);
    expect(record).toMatchObject({ collected_count: 3, variance: 'MATCH' });
    // The answer states the photos it attached, in the order they were named, as the contract's CollectionRecord declares (Run B, Part 1, item 5: it left them out on 809817b, and this
    // test held their absence). It states the members of that schema and no other.
    expect(response.json()).toMatchObject({
      id: record?.id,
      pickup_stop_id: stop.id,
      collected_count: 3,
      parcel_photo_ids: photos,
    });
    expect(Object.keys(response.json() as object).toSorted()).toEqual(
      [
        'collected_count',
        'declared_count',
        'id',
        'office_notified_at',
        'parcel_photo_ids',
        'pickup_stop_id',
        'variance',
      ].toSorted(),
    );

    const links = await linksOf(stop.id);
    expect(links.map((link) => link.evidence_id).toSorted()).toEqual([...photos].toSorted());
    for (const link of links) {
      expect(link).toMatchObject({
        collection_record_id: record?.id,
        pickup_stop_id: stop.id,
        responsible_hub_id: HUB_A,
        attached_by_rider: arranged.rider.id,
      });
      // The moment is the database's own, taken during the call.
      expect(link.attached_at.getTime()).toBeGreaterThanOrEqual(sentAt - 2000);
      expect(link.attached_at.getTime()).toBeLessThanOrEqual(answeredAt + 2000);
    }
    // The photos themselves are untouched by being counted.
    const states = await routes.rows<{ state: string }>(
      `select state from evidence where id = any($1::uuid[])`,
      [photos],
    );
    expect(states.map((each) => each.state)).toEqual(['STORED', 'STORED', 'STORED']);
  });

  // Break caught: a short count that takes the photos of the declared number, or none: it takes one photo for each parcel actually counted.
  it('takes one photo for each parcel counted when the count is short', async () => {
    const arranged = await run();
    const stop = stopAt(arranged);
    const photos = await parcelPhotosOf(routes, arranged.rider, stop.id, 2);
    const response = await collect(arranged.rider, stop.id, { ...SHORT, parcel_photo_ids: photos });
    expect(response.status, response.text).toBe(200);
    expect((response.json() as { parcel_photo_ids?: string[] }).parcel_photo_ids).toEqual(photos);
    expect(await linksOf(stop.id)).toHaveLength(2);
    expect(await recordsOf(stop.id)).toMatchObject([{ collected_count: 2, variance: 'SHORT' }]);
  });

  // Break caught: the number left to the application or to the client (a count with fewer photos, more photos or none accepted), or a refusal that still makes the record.
  it.each([
    ['two photos for three parcels', 3, { collected_count: 3 }, 2],
    ['four photos for three parcels', 4, { collected_count: 3 }, 4],
    ['no photos for three parcels', 0, { collected_count: 3 }, 0],
    ['three photos for two parcels', 3, { ...SHORT }, 3],
  ])(
    'refuses %s, with the rule parcel_photo_count, and records nothing',
    async (_name, made, body, named) => {
      const arranged = await run();
      const stop = stopAt(arranged);
      const photos = await parcelPhotosOf(routes, arranged.rider, stop.id, made);

      const response = await collect(arranged.rider, stop.id, {
        ...body,
        ...(named === 0 && made === 0 ? {} : { parcel_photo_ids: photos.slice(0, named) }),
      });

      expect(outcome(response)).toEqual([400, 'VALIDATION_FAILED']);
      expect(violationsOf(response)).toEqual([
        { in: 'body', pointer: '/parcel_photo_ids', rule: 'parcel_photo_count' },
      ]);
      expect(await recordsOf(stop.id)).toEqual([]);
      expect(await linksOf(stop.id)).toEqual([]);
    },
  );

  it('refuses an empty list of photos the same as none', async () => {
    const arranged = await run();
    const stop = stopAt(arranged);
    const response = await collect(arranged.rider, stop.id, {
      collected_count: 3,
      parcel_photo_ids: [],
    });
    expect(outcome(response)).toEqual([400, 'VALIDATION_FAILED']);
    expect(violationsOf(response)[0]?.rule).toBe('parcel_photo_count');
  });

  // Break caught: the same photo counted for two parcels (three ids, two photos), which would make the number right with one photo too few.
  it('refuses a photo named twice, with the rule duplicate', async () => {
    const arranged = await run();
    const stop = stopAt(arranged);
    const [one, two] = await parcelPhotosOf(routes, arranged.rider, stop.id, 2);
    const response = await collect(arranged.rider, stop.id, {
      collected_count: 3,
      parcel_photo_ids: [one, two, one],
    });
    expect(outcome(response)).toEqual([400, 'VALIDATION_FAILED']);
    expect(violationsOf(response)).toEqual([
      { in: 'body', pointer: '/parcel_photo_ids', rule: 'duplicate' },
    ]);
    expect(await recordsOf(stop.id)).toEqual([]);
  });

  // Break caught: the photos judged before the count's other rules, so that a count refused for another reason is told it lacks photos.
  it('judges the count before its photos: a count above the declared one is told so, photos or none', async () => {
    const arranged = await run();
    const stop = stopAt(arranged);
    const response = await collect(arranged.rider, stop.id, { collected_count: 5 });
    expect(outcome(response)).toEqual([400, 'VALIDATION_FAILED']);
    expect(violationsOf(response)).toEqual([
      { in: 'body', pointer: '/collected_count', rule: 'above_declared' },
    ]);
  });

  // The body that names two hundred photos is admitted by the transport, and the schema sets no cap: `collection-parcel-photos.test.ts` holds the reading.
});

describe('recordCollection: only a stored photo of this rider and this stop counts, and once (AC-SLICE-001-87)', () => {
  type Bad = (arranged: ArrangedRun, stopId: string) => Promise<string>;
  const cases: readonly (readonly [string, Bad])[] = [
    [
      'a photo still pending its upload',
      async (arranged, stopId) =>
        (
          await photoOf(routes, arranged.rider, stopId, {
            purpose: 'PARCEL_PHOTO',
            complete: false,
          })
        ).id,
    ],
    [
      'a photo whose window ran out',
      async (arranged, stopId) => {
        const id = (await photoOf(routes, arranged.rider, stopId, { purpose: 'PARCEL_PHOTO' })).id;
        await arrangeEvidence(
          id,
          `state = 'EXPIRED', uploaded_at = null, validated_signature = null, scanner = null, scanner_signature_version = null, scanned_at = null`,
        );
        return id;
      },
    ],
    [
      "another rider's photo",
      async (arranged, stopId) => {
        const id = (await photoOf(routes, arranged.rider, stopId, { purpose: 'PARCEL_PHOTO' })).id;
        const other = await arrangedRider(routes.kit, routes.admin);
        await arrangeEvidence(id, `captured_by_actor = '${other.id}'`);
        return id;
      },
    ],
    [
      "another stop's photo",
      async (arranged) =>
        (
          await photoOf(routes, arranged.rider, stopAt(arranged, 1).id, {
            purpose: 'PARCEL_PHOTO',
          })
        ).id,
    ],
    [
      'the proof of a collection, which is not a parcel',
      async (arranged, stopId) => (await photoOf(routes, arranged.rider, stopId)).id,
    ],
    ['a record that does not exist', () => Promise.resolve(randomUUID())],
    [
      'a photo already attached to a count',
      async (arranged, stopId) => {
        const id = (await photoOf(routes, arranged.rider, stopId, { purpose: 'PARCEL_PHOTO' })).id;
        // Attached elsewhere: the count of the run's other stop (let through without photos so that it can be made), then the link made with the guards off.
        const other = stopAt(arranged, 1);
        await routes.admin.query(
          `insert into parcel_photo_exception (id, pickup_stop_id, responsible_hub_id, authorised_by, authorised_at, note)
           select gen_random_uuid(), s.id, s.responsible_hub_id, (select id from staff_identity limit 1), clock_timestamp(), 'arranged'
             from pickup_stop s where s.id = $1`,
          [other.id],
        );
        const counted = await collect(arranged.rider, other.id, { collected_count: 3 });
        expect(counted.status, counted.text).toBe(200);
        const [record] = await recordsOf(other.id);
        await routes.admin.query('begin');
        try {
          await routes.admin.query('set local session_replication_role = replica');
          await routes.admin.query(
            `insert into collection_parcel_photo (evidence_id, collection_record_id, pickup_stop_id, responsible_hub_id, attached_by_rider, attached_at)
             values ($1, $2, $3, $4, $5, now())`,
            [id, record?.id, other.id, HUB_A, arranged.rider.id],
          );
          await routes.admin.query('commit');
        } catch (error) {
          await routes.admin.query('rollback').catch(() => undefined);
          throw error;
        }
        return id;
      },
    ],
  ];

  // Break caught: a photo that cannot be counted taken (a pending one, an expired one, a stranger's, another stop's, the proof of a failure, one counted already), or refused with a
  // different answer that tells a rider about a record that is not its own.
  it.each(cases)(
    'refuses %s, with the one answer EVIDENCE_NOT_STORED, and attaches none of the photos',
    async (_name, bad) => {
      const arranged = await run();
      const stop = stopAt(arranged);
      const good = await parcelPhotosOf(routes, arranged.rider, stop.id, 2);
      const unusable = await bad(arranged, stop.id);

      const response = await collect(arranged.rider, stop.id, {
        collected_count: 3,
        parcel_photo_ids: [...good, unusable],
      });

      expect(outcome(response)).toEqual([422, 'EVIDENCE_NOT_STORED']);
      expect((response.json() as { message: string }).message).toBe(
        'A referenced evidence record is not stored',
      );
      expect(await recordsOf(stop.id)).toEqual([]);
      expect((await linksOf(stop.id)).filter((link) => good.includes(link.evidence_id))).toEqual(
        [],
      );
    },
  );
});

describe('authoriseParcelPhotoException: Ops lets a stop through without photos (AC-SLICE-001-88)', () => {
  // Break caught: an exception not written, written with the request's officer or hub or moment, or without the enhanced event that records the note.
  it('records one exception for the stop, as the officer, with the database’s moment and an enhanced event, and the count then takes no photos', async () => {
    const arranged = await run();
    const stop = stopAt(arranged);
    const sentAt = Date.now();

    const response = await authorise(ops, stop.id, { note: '  The camera does not work  ' });

    expect(response.status, response.text).toBe(200);
    const answeredAt = Date.now();
    const view = response.json() as Record<string, string>;
    expect(Object.keys(view).toSorted()).toEqual(
      ['authorised_at', 'authorised_by', 'id', 'note', 'pickup_stop_id'].toSorted(),
    );
    expect(view).toMatchObject({
      pickup_stop_id: stop.id,
      authorised_by: ops.identity.id,
      note: 'The camera does not work',
    });
    const [kept, ...more] = await exceptionsOf(stop.id);
    expect(more).toEqual([]);
    expect(kept).toMatchObject({
      id: view.id,
      responsible_hub_id: HUB_A,
      authorised_by: ops.identity.id,
      note: 'The camera does not work',
    });
    expect(kept?.authorised_at.getTime()).toBeGreaterThanOrEqual(sentAt - 2000);
    expect(kept?.authorised_at.getTime()).toBeLessThanOrEqual(answeredAt + 2000);
    expect(new Date(view.authorised_at ?? '').getTime()).toBe(kept?.authorised_at.getTime());

    const events = await eventsOf(stop.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor_type: 'STAFF',
      actor_id: ops.identity.id,
      enhanced: true,
      outcome: 'SUCCEEDED',
      object_type: 'PickupStop',
      responsible_hub_id: HUB_A,
      previous_state: 'ARRIVED',
      resulting_state: 'ARRIVED',
      note: 'The camera does not work',
      before_after: { parcel_photos: { before: 'REQUIRED', after: 'EXCUSED' } },
      detail: { parcel_photos: 'EXCUSED' },
    });
    expect(events[0]?.related_ids).toMatchObject({
      parcel_photo_exception_id: view.id,
      pickup_request_id: stop.requestId,
    });

    // The stop's count takes no photos now.
    const counted = await collect(arranged.rider, stop.id, { collected_count: 3 });
    expect(counted.status, counted.text).toBe(200);
    expect(await recordsOf(stop.id)).toHaveLength(1);
    expect(await linksOf(stop.id)).toEqual([]);
    // The answer for such a stop states no photos: the member is absent, and is not an empty list.
    expect(Object.keys(counted.json() as object)).not.toContain('parcel_photo_ids');
  });

  // Break caught: an exception that lets the count take photos as well (a count that names some accepted), which would hide a count whose photos were not the exception's business.
  it('refuses a count that names photos for a stop that was let through without them', async () => {
    const arranged = await run();
    const stop = stopAt(arranged);
    const photos = await parcelPhotosOf(routes, arranged.rider, stop.id, 3);
    expect((await authorise(ops, stop.id)).status).toBe(200);

    const response = await collect(arranged.rider, stop.id, {
      collected_count: 3,
      parcel_photo_ids: photos,
    });

    expect(outcome(response)).toEqual([400, 'VALIDATION_FAILED']);
    expect(violationsOf(response)[0]?.rule).toBe('parcel_photo_count');
    expect(await recordsOf(stop.id)).toEqual([]);
  });

  // Break caught: an exception for the stop that is not the stop's own (the other stop of the run lets through without photos), or one that outlives its stop's need.
  it('lets through the stop it names and no other', async () => {
    const arranged = await run();
    const first = stopAt(arranged);
    const second = stopAt(arranged, 1);
    expect((await authorise(ops, first.id)).status).toBe(200);
    const response = await collect(arranged.rider, second.id, { collected_count: 3 });
    expect(outcome(response)).toEqual([400, 'VALIDATION_FAILED']);
    expect(violationsOf(response)[0]?.rule).toBe('parcel_photo_count');
  });

  // Break caught: a note that is not required, an officer of another hub or without the key let through, or the states of the stop not held.
  it('refuses a blank note, an officer of another hub, a caller without the key and a rider, each with its own answer', async () => {
    const arranged = await run();
    const stop = stopAt(arranged);
    expect(outcome(await authorise(ops, stop.id, { note: '   ' }))).toEqual([
      422,
      'REASON_REQUIRED',
    ]);
    expect(outcome(await authorise(opsB, stop.id))).toEqual([403, 'HUB_SCOPE_VIOLATION']);
    expect(outcome(await authorise(finance, stop.id))).toEqual([403, 'PERMISSION_DENIED']);
    const asRider = await arranged.rider.client.post(
      EXCEPTION(stop.id),
      { note: 'x' },
      { headers: { 'Idempotency-Key': randomUUID() } },
    );
    expect(asRider.status).toBeGreaterThanOrEqual(401);
    expect(outcome(await authorise(ops, randomUUID()))).toEqual([404, 'NOT_FOUND']);
    expect(await exceptionsOf(stop.id)).toEqual([]);
    expect(await eventsOf(stop.id)).toEqual([]);
  });

  it('refuses a stop not yet arrived at, a stop already counted and a second exception, as STATE_CONFLICT', async () => {
    const pending = await arrangeRun(routes.kit, routes.admin, {
      vendorOrganizationId: vendorA.row.organizationId,
      serviceDate: days.today,
      state: 'IN_PROGRESS',
      stops: 1,
      stopStates: ['PENDING'],
    });
    const notArrived = await authorise(ops, stopAt(pending).id);
    expect(outcome(notArrived)).toEqual([409, 'STATE_CONFLICT']);
    expect(ruleOf(notArrived)).toBe('stop_not_arrived');

    const arranged = await run();
    const stop = stopAt(arranged);
    const photos = await parcelPhotosOf(routes, arranged.rider, stop.id, 3);
    expect(
      (await collect(arranged.rider, stop.id, { collected_count: 3, parcel_photo_ids: photos }))
        .status,
    ).toBe(200);
    const counted = await authorise(ops, stop.id);
    expect(outcome(counted)).toEqual([409, 'STATE_CONFLICT']);
    expect(ruleOf(counted)).toBe('collection_recorded');

    const other = stopAt(arranged, 1);
    expect((await authorise(ops, other.id)).status).toBe(200);
    const twice = await authorise(ops, other.id);
    expect(outcome(twice)).toEqual([409, 'STATE_CONFLICT']);
    expect(ruleOf(twice)).toBe('exception_exists');
    expect(await exceptionsOf(other.id)).toHaveLength(1);
    expect(await eventsOf(other.id)).toHaveLength(1);
  });

  // Break caught: a retry that makes a second exception or a second event, or another body under the same key accepted.
  it('is idempotent: the same key replays the answer, and another body under it is a conflict', async () => {
    const arranged = await run();
    const stop = stopAt(arranged);
    const key = randomUUID();
    const first = await authorise(ops, stop.id, { note: 'The camera does not work' }, key);
    const again = await authorise(ops, stop.id, { note: 'The camera does not work' }, key);
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(again.json()).toEqual(first.json());
    expect(await exceptionsOf(stop.id)).toHaveLength(1);
    expect(await eventsOf(stop.id)).toHaveLength(1);
    const other = await authorise(ops, stop.id, { note: 'Another reason' }, key);
    expect(outcome(other)).toEqual([409, 'IDEMPOTENCY_KEY_CONFLICT']);
  });

  // Break caught: an exception that a writer can change or remove (to un-excuse a counted stop, or to change who let it through), or that the runtime login can make itself.
  it('is kept as it was made: no writer changes or removes it, and the runtime login cannot make one', async () => {
    const arranged = await run();
    const stop = stopAt(arranged);
    expect((await authorise(ops, stop.id)).status).toBe(200);
    await expect(
      routes.admin.query(`update parcel_photo_exception set note = 'x' where pickup_stop_id = $1`, [
        stop.id,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      routes.admin.query(`delete from parcel_photo_exception where pickup_stop_id = $1`, [stop.id]),
    ).rejects.toMatchObject({ code: '23514' });
    expect(await exceptionsOf(stop.id)).toHaveLength(1);
  });
});

describe('the database holds the number of photos for every writer (AC-SLICE-001-86, -87)', () => {
  /** A count by SQL, as the administrator writes it: `collected` parcels counted of the stop, in a transaction the test commits itself. */
  async function insertCount(
    rider: ArrangedRider,
    stopId: string,
    collected: number,
    links: readonly string[],
  ): Promise<string> {
    const id = randomUUID();
    await routes.admin.query(
      `insert into collection_record (id, pickup_stop_id, responsible_hub_id, declared_count, collected_count, variance, variance_reason_snapshot,
                                      office_notified_at, handshake_type, recorded_by)
       values ($1, $2, $3, 3, $4, $5, $6::jsonb, $7, 'VENDOR_ENTERED_RIDER_DISPLAYED', $8)`,
      [
        id,
        stopId,
        HUB_A,
        collected,
        collected < 3 ? 'SHORT' : 'MATCH',
        collected < 3
          ? JSON.stringify({
              reason_code: 'SOME_PARCELS_NOT_READY',
              label: 'Some parcels not ready',
              attribution: 'CUSTOMER',
            })
          : null,
        collected < 3 ? new Date().toISOString() : null,
        rider.id,
      ],
    );
    for (const evidenceId of links) {
      await routes.admin.query(
        `insert into collection_parcel_photo (evidence_id, collection_record_id) values ($1, $2)`,
        [evidenceId, id],
      );
    }
    return id;
  }

  /** Runs `work` in a transaction and commits it: the rule is checked at the commit, so a refusal is the commit's. */
  async function inTransaction(work: () => Promise<void>): Promise<void> {
    await routes.admin.query('begin');
    try {
      await work();
      await routes.admin.query('commit');
    } catch (error) {
      await routes.admin.query('rollback').catch(() => undefined);
      throw error;
    }
  }

  // Break caught: the number held by the application alone, so that any other writer (a script, a later operation) could make a count with no photos at all.
  it('refuses at the end of the transaction a count whose photos are not its number', async () => {
    const arranged = await run();
    const stop = stopAt(arranged);
    const photos = await parcelPhotosOf(routes, arranged.rider, stop.id, 4);

    for (const named of [0, 2, 4]) {
      await expect(
        inTransaction(async () => {
          await insertCount(arranged.rider, stop.id, 3, photos.slice(0, named));
        }),
        `${String(named)} photos for 3 parcels`,
      ).rejects.toMatchObject({ code: '23514' });
    }
    expect(await recordsOf(stop.id)).toEqual([]);
    expect(await linksOf(stop.id)).toEqual([]);

    // Exactly its number is kept, with the record and its photos made in the one transaction.
    await inTransaction(async () => {
      await insertCount(arranged.rider, stop.id, 3, photos.slice(0, 3));
    });
    expect(await recordsOf(stop.id)).toHaveLength(1);
    expect(await linksOf(stop.id)).toHaveLength(3);
  });

  // Break caught: a photo added to a count after the fact (the count read as complete, then one more), which the count's own check would never see.
  it('refuses a photo added to a count later', async () => {
    const arranged = await run();
    const stop = stopAt(arranged);
    const photos = await parcelPhotosOf(routes, arranged.rider, stop.id, 4);
    const record = await (async () => {
      let id = '';
      await inTransaction(async () => {
        id = await insertCount(arranged.rider, stop.id, 3, photos.slice(0, 3));
      });
      return id;
    })();

    await expect(
      inTransaction(async () => {
        await routes.admin.query(
          `insert into collection_parcel_photo (evidence_id, collection_record_id) values ($1, $2)`,
          [photos[3], record],
        );
      }),
    ).rejects.toMatchObject({ code: '23514' });
    expect(await linksOf(stop.id)).toHaveLength(3);
  });

  // Break caught: a stop let through without photos that takes some all the same, or one that was not let through taking none because an exception of another stop was read.
  it('holds the count to the exception of its own stop: none for an excused stop, the number for the others', async () => {
    const arranged = await run();
    const excused = stopAt(arranged);
    const other = stopAt(arranged, 1);
    expect((await authorise(ops, excused.id)).status).toBe(200);
    const photos = await parcelPhotosOf(routes, arranged.rider, excused.id, 1);
    const photosOther = await parcelPhotosOf(routes, arranged.rider, other.id, 3);

    await expect(
      inTransaction(async () => {
        await insertCount(arranged.rider, excused.id, 3, photos);
      }),
    ).rejects.toMatchObject({ code: '23514' });
    await inTransaction(async () => {
      await insertCount(arranged.rider, excused.id, 3, []);
    });
    expect(await recordsOf(excused.id)).toHaveLength(1);

    await expect(
      inTransaction(async () => {
        await insertCount(arranged.rider, other.id, 3, []);
      }),
    ).rejects.toMatchObject({ code: '23514' });
    await inTransaction(async () => {
      await insertCount(arranged.rider, other.id, 3, photosOther);
    });
    expect(await linksOf(other.id)).toHaveLength(3);
  });

  // Break caught: a photo attached to two counts, whoever writes it.
  it('attaches a photo once: a second link for the same photo is a duplicate key', async () => {
    const arranged = await run();
    const stop = stopAt(arranged);
    const photos = await parcelPhotosOf(routes, arranged.rider, stop.id, 3);
    const record = await (async () => {
      let id = '';
      await inTransaction(async () => {
        id = await insertCount(arranged.rider, stop.id, 3, photos);
      });
      return id;
    })();
    await expect(
      routes.admin.query(
        `insert into collection_parcel_photo (evidence_id, collection_record_id) values ($1, $2)`,
        [photos[0], record],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  // Break caught: a link that names a photo that is not a parcel's (a failure's proof), another stop's, still pending or another rider's; a parcel photo attached to a failure.
  it('attaches only a stored parcel photo of this very stop captured by the rider who counted, and no parcel photo to a failure', async () => {
    const arranged = await run();
    const stop = stopAt(arranged);
    const other = stopAt(arranged, 1);
    const good = await parcelPhotosOf(routes, arranged.rider, stop.id, 3);
    const proof = (await photoOf(routes, arranged.rider, stop.id)).id;
    const elsewhere = (await parcelPhotosOf(routes, arranged.rider, other.id, 1))[0] ?? '';
    const pending = (
      await photoOf(routes, arranged.rider, stop.id, { purpose: 'PARCEL_PHOTO', complete: false })
    ).id;
    const strangers = (await parcelPhotosOf(routes, arranged.rider, stop.id, 1))[0] ?? '';
    await arrangeEvidence(strangers, `captured_by_actor = '${randomUUID()}'`);

    for (const [name, bad] of [
      ["a failure's proof", proof],
      ["another stop's photo", elsewhere],
      ['a photo still pending', pending],
      ["another rider's photo", strangers],
    ] as const) {
      await expect(
        inTransaction(async () => {
          await insertCount(arranged.rider, stop.id, 3, [good[0] ?? '', good[1] ?? '', bad]);
        }),
        name,
      ).rejects.toMatchObject({ code: '23514' });
    }
    expect(await recordsOf(stop.id)).toEqual([]);

    // And the other way: the photo of a parcel is not the proof of a failure.
    await expect(
      routes.admin.query(
        `insert into pickup_stop_evidence (evidence_id, pickup_stop_id) values ($1, $2)`,
        [good[0], stop.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  // Break caught: a link changed or removed after it was made (a photo detached from its count, or moved to another).
  it('keeps a link as it was made: never changed and never removed', async () => {
    const arranged = await run();
    const stop = stopAt(arranged);
    const photos = await parcelPhotosOf(routes, arranged.rider, stop.id, 3);
    await inTransaction(async () => {
      await insertCount(arranged.rider, stop.id, 3, photos);
    });
    await expect(
      routes.admin.query(`delete from collection_parcel_photo where evidence_id = $1`, [photos[0]]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      routes.admin.query(
        `update collection_parcel_photo set attached_at = now() where evidence_id = $1`,
        [photos[0]],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    expect(await linksOf(stop.id)).toHaveLength(3);
  });
});
