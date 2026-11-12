import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SystemClock } from '../../src/platform/auth/clock/system.clock.adapter.js';
import { guardReasonIn, serverErrorIn } from '../../src/platform/database/database-failures.js';
import { WORKER_RUNTIME_ROLE } from '../../src/platform/database/technical-roles.js';
import type { SecurityContext } from '../../src/platform/database/transaction-context.js';
import {
  CaptureTextMessageSender,
  type TextCaptureEntry,
} from '../../src/platform/notifications/capture.text-message-sender.adapter.js';
import { OPEN_SETTINGS, createLanePolicy } from '../../src/platform/notifications/lane-policy.js';
import {
  NotificationLane,
  OPEN_POLICY,
  type LanePolicy,
} from '../../src/platform/notifications/notification-lane.js';
import { NotificationStore } from '../../src/platform/notifications/notification-store.js';
import { templateOf, type Template } from '../../src/platform/notifications/templates.js';
import type { TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { manifestDays, type ManifestDays } from './support/manifest-days.js';
import { insertManifest, insertStop, manifestRow, stopRow } from './support/manifests.js';
import { insertAdHocSender, insertPickupRequest, pickupRequestRow } from './support/pickups.js';
import { liftProviderCeiling } from './support/provider-ceiling.js';
import { arrangeRun, arrangedRider, type ArrangedRider, type ArrangedRun } from './support/runs.js';
import { seedHubConfiguration } from './support/seeded.js';
import { buildService } from './support/service.js';
import { API, HUB_A, HUB_B, type Actor } from './support/staff-routes.js';
import {
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from './support/vendor-routes.js';

/**
 * S1.28 (the messages of a failure) and OB-S1-51 (the office told of a short count): the two rider acts that write an envelope for the notification lane, against a real
 * PostgreSQL, the real application and the real lane. Each claim:
 *
 * - **The envelope is the act's own**: written in the transaction of `reportPickupFailure` and `recordCollection`, kept or undone with it, once, and written by the database from
 *   the stop the rider has just failed or counted short, so that it says nothing the act chose (the request, the hub and the vendor are the request's; the payload is the stop and
 *   closed tokens, never the note). A refused act, a count that matches and a retry write none, and a failure undone at its last step leaves none.
 * - **Only the rider's own act, and only that act, can write it**: the two functions refuse every other caller, key, rider, stop and moment, and the runtime login cannot insert
 *   either envelope itself.
 * - **The lane makes the messages the list says**, for the audience the request has: the text to an individual sender (with no reason and no note), the registered
 *   vendor's feed entry and the Ops entry of the hub for a failure, and the Ops entry for a short count; the closed tokens are the only things a notification copies; the limits
 *   and the kill switches hold the text back as for every message, and a real provider is never asked to send words that are a draft (the owner approved these on 12 November
 *   2026, D-A5, and a real provider is given them exactly as approved).
 * - **The staff of the hub read the Ops entries** under `notification.read`, and the staff of another hub do not.
 */
let routes: VendorRoutes;
let days: ManifestDays;
let vendorA: ArrangedVendor;
let ops: Actor;
let opsB: Actor;

beforeAll(async () => {
  routes = await startVendorRoutes();
  await seedHubConfiguration(routes.database);
  // This file makes many failures and counts from riders of its own inside a minute; the ceiling of the operations that write an envelope is proven elsewhere.
  await liftProviderCeiling(routes.admin);
  days = await manifestDays(routes.admin);
  vendorA = await routes.vendor();
  ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  opsB = await routes.actor(BUNDLE_IDS.opsStaff, HUB_B);
}, 180_000);

afterAll(async () => {
  await routes.stop();
});

const clock = new SystemClock();
const NEVER = new AbortController().signal;

const STOP = (id: string) => `${API}/pickup-stops/${id}`;
const NOTE = 'The parcels were not packed when the rider came';
const ORDINARY = {
  category: 'PARCEL_NOT_READY',
  reason_code: 'PARCELS_NOT_PACKED',
  note: NOTE,
} as const;
const SHORT = { collected_count: 2, variance_reason_code: 'SOME_PARCELS_NOT_READY' } as const;

/** What a rider is shown for a stop (the contract's `PickupStopSummary`): a closed fixture that satisfies the stop's check, three packages declared. */
const summaryOf = (code: string): Record<string, unknown> => ({
  reference: code,
  sender_display_name: 'Fixture Sender',
  declared_package_count: 3,
  resolved_pickup_location: { address: 'Fixture shop, Osu' },
  location_note: null,
  contact_phone: '+233200000001',
});

/** A run in progress for a registered vendor, whose first stop the rider has arrived at, and a second still to be worked. */
const run = (over: Partial<Parameters<typeof arrangeRun>[2]> = {}): Promise<ArrangedRun> =>
  arrangeRun(routes.kit, routes.admin, {
    vendorOrganizationId: vendorA.row.organizationId,
    serviceDate: days.today,
    state: 'IN_PROGRESS',
    stops: 2,
    stopStates: ['ARRIVED', 'PENDING'],
    ...over,
  });

interface Arranged {
  readonly rider: ArrangedRider;
  readonly stopId: string;
  readonly requestId: string;
  readonly requestCode: string;
  readonly manifestId: string;
  readonly phone: string | null;
}

const vendorStop = async (
  over: Partial<Parameters<typeof arrangeRun>[2]> = {},
): Promise<Arranged> => {
  const arranged = await run(over);
  const stop = arranged.stops[0];
  if (stop === undefined) throw new Error('stop');
  return {
    rider: arranged.rider,
    stopId: stop.id,
    requestId: stop.requestId,
    requestCode: stop.requestCode,
    manifestId: arranged.manifest.id,
    phone: null,
  };
};

/** A run in progress for an individual (ad-hoc) sender with a number, whose one stop the rider has arrived at. */
async function adHocStop(over: { hubId?: string } = {}): Promise<Arranged> {
  const hubId = over.hubId ?? HUB_A;
  const sender = await insertAdHocSender(routes.admin);
  const request = await insertPickupRequest(
    routes.admin,
    pickupRequestRow(vendorA.row.organizationId, hubId, {
      vendorOrganizationId: null,
      adHocSenderId: sender.id,
      intent: 'ADHOC_SENDER',
      state: 'CONFIRMED',
      serviceDate: days.today,
    }),
  );
  await routes.admin.query(`update pickup_request set rider_assigned = true where id = $1`, [
    request.id,
  ]);
  const rider = await arrangedRider(routes.kit, routes.admin, hubId);
  const manifest = await insertManifest(
    routes.admin,
    manifestRow(hubId, {
      state: 'IN_PROGRESS',
      serviceDate: days.today,
      assignedRiderId: rider.id,
    }),
  );
  const stop = await insertStop(
    routes.admin,
    stopRow(manifest, request.id, 1, { state: 'ARRIVED', pickupSummary: summaryOf(request.code) }),
  );
  return {
    rider,
    stopId: stop.id,
    requestId: request.id,
    requestCode: request.code,
    manifestId: manifest.id,
    phone: sender.phone,
  };
}

/** The token the report and the count take as `If-Match`: the stop as the rider reads it. */
const tokenOf = async (rider: ArrangedRider, stopId: string): Promise<string> =>
  (await rider.client.get(STOP(stopId))).header('etag') ?? '';

async function fail(
  arranged: Arranged,
  body: Record<string, unknown> = { ...ORDINARY },
  key: string = randomUUID(),
): Promise<TestResponse> {
  return arranged.rider.client.post(`${STOP(arranged.stopId)}/fail`, body, {
    headers: {
      'If-Match': await tokenOf(arranged.rider, arranged.stopId),
      'Idempotency-Key': key,
    },
  });
}

async function collect(
  arranged: Arranged,
  body: Record<string, unknown> = { ...SHORT },
  key: string = randomUUID(),
): Promise<TestResponse> {
  return arranged.rider.client.post(`${STOP(arranged.stopId)}/collect`, body, {
    headers: {
      'If-Match': await tokenOf(arranged.rider, arranged.stopId),
      'Idempotency-Key': key,
    },
  });
}

interface EnvelopeRow {
  readonly event_type: string;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly responsible_hub_id: string;
  readonly vendor_organization_id: string | null;
  readonly rider_id: string | null;
  readonly originating_principal_type: string;
  readonly originating_principal_id: string;
  readonly operation_id: string;
  readonly payload: Record<string, unknown>;
  readonly relay_state: string;
  readonly last_outcome: string | null;
}
const envelopesOf = (requestId: string) =>
  routes.rows<EnvelopeRow>(
    `select event_type, aggregate_type, aggregate_id, responsible_hub_id, vendor_organization_id, rider_id, originating_principal_type, originating_principal_id,
            operation_id, payload, relay_state, last_outcome
       from outbox where aggregate_id = $1 order by created_at, id`,
    [requestId],
  );

interface NoticeRow {
  readonly message_kind: string;
  readonly audience: string;
  readonly channel: string;
  readonly state: string;
  readonly suppression_reason: string | null;
  readonly vendor_organization_id: string | null;
  readonly responsible_hub_id: string;
  readonly parameters: Record<string, string>;
  readonly destination_hint: string | null;
}
const noticesOf = (requestId: string) =>
  routes.rows<NoticeRow>(
    `select message_kind, audience, channel, state, suppression_reason, vendor_organization_id, responsible_hub_id, parameters, destination_hint
       from notification where subject_id = $1 order by message_kind`,
    [requestId],
  );

/** One run of the notification lane (three ticks), as the delivery worker runs it, over the same database; the texts it sends are returned for the test to read. */
/** The wording the lane reads, with the approval taken off: what the words were before the owner approved them. */
const asDrafts = (kind: string, version: number): Template | undefined => {
  const found = templateOf(kind, version);
  return found === undefined
    ? undefined
    : { ...found, approvedBy: null, approvedOn: null, approvedDigest: null };
};

async function relay(
  policy: LanePolicy = OPEN_POLICY,
  templates?: (kind: string, version: number) => Template | undefined,
): Promise<TextCaptureEntry[]> {
  const sent: TextCaptureEntry[] = [];
  const work = buildService(routes.database, { poolMax: 3, login: WORKER_RUNTIME_ROLE });
  try {
    const lane = new NotificationLane({
      store: new NotificationStore({ database: work.service, clock, workerId: 'messages-lane' }),
      sender: new CaptureTextMessageSender({
        sink: {
          record: (entry) => {
            sent.push(entry);
            return Promise.resolve();
          },
        },
        clock,
      }),
      policy,
      logger: work.logs.logger,
      leaseMs: 30_000,
      firstReceiptCheckMs: 0,
      receiptHoldMs: 60_000,
      random: () => 0.5,
      ...(templates === undefined ? {} : { templates }),
    });
    for (let tick = 0; tick < 3; tick += 1) await lane.runOnce(NEVER);
  } finally {
    await work.close();
  }
  return sent;
}

const stopState = (stopId: string) =>
  routes
    .rows<{ state: string }>(`select state from pickup_stop where id = $1`, [stopId])
    .then((rows) => rows[0]?.state);

describe('reportPickupFailure writes the envelope of the failure’s messages, in its own transaction', () => {
  // Break caught: an envelope that says what the caller chose (the note, a count, another stop), one that names the wrong scope or the wrong origin, one written for a report that was
  // refused, or a second for a retry.
  it('writes one envelope from the stop just failed: the request’s scope, the rider as the origin, the stop and closed tokens, and none for a refused report or a retry', async () => {
    const arranged = await vendorStop();
    // A report the catalogue refuses makes nothing.
    const refused = await fail(arranged, { ...ORDINARY, reason_code: 'NOT_A_REASON' });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(await envelopesOf(arranged.requestId)).toEqual([]);

    const key = randomUUID();
    const failed = await fail(arranged, { ...ORDINARY }, key);
    expect(failed.status, failed.text).toBe(200);
    const [envelope, ...rest] = await envelopesOf(arranged.requestId);
    expect(rest).toEqual([]);
    expect(envelope).toEqual({
      event_type: 'pickup.failure.reported',
      aggregate_type: 'PICKUP_REQUEST',
      aggregate_id: arranged.requestId,
      responsible_hub_id: HUB_A,
      vendor_organization_id: vendorA.row.organizationId,
      rider_id: null,
      originating_principal_type: 'RIDER',
      originating_principal_id: arranged.rider.id,
      operation_id: 'reportPickupFailure',
      payload: {
        stop: arranged.stopId,
        category: 'PARCEL_NOT_READY',
        reason: 'PARCELS_NOT_PACKED',
      },
      relay_state: 'PENDING',
      last_outcome: null,
    });
    expect(JSON.stringify(envelope)).not.toContain('parcels were not packed');

    // The same key replays the answer and writes nothing more.
    expect((await fail(arranged, { ...ORDINARY }, key)).status).toBe(200);
    expect(await envelopesOf(arranged.requestId)).toHaveLength(1);
  });

  // Break caught: an envelope written outside the transaction of the act, which would tell the sender of a failure that was undone.
  it('is undone with the failure: an act that fails at its last step leaves no stop failed and no envelope, and the same key then makes both', async () => {
    const arranged = await vendorStop();
    await routes.admin.query(
      `create function public.fixture_refuse_failure_completion() returns trigger language plpgsql as $$
         begin raise exception 'fixture: the record of the failure cannot be completed'; end $$`,
    );
    await routes.admin.query(
      `create trigger fixture_refuse_failure_completion before update on idempotency_record for each row
         when (new.state = 'COMPLETED' and new.operation_id = 'reportPickupFailure')
         execute function public.fixture_refuse_failure_completion()`,
    );
    const key = randomUUID();
    try {
      const broken = await fail(arranged, { ...ORDINARY }, key);
      expect(broken.status).toBe(500);
      expect(await stopState(arranged.stopId)).toBe('ARRIVED');
      expect(await envelopesOf(arranged.requestId)).toEqual([]);
    } finally {
      await routes.admin.query(
        `drop trigger fixture_refuse_failure_completion on idempotency_record`,
      );
      await routes.admin.query(`drop function public.fixture_refuse_failure_completion()`);
    }
    expect((await fail(arranged, { ...ORDINARY }, key)).status).toBe(200);
    expect(await stopState(arranged.stopId)).toBe('FAILED');
    expect(await envelopesOf(arranged.requestId)).toHaveLength(1);
  });

  // Break caught: an envelope written after the run was completed, which the rider's own reads would no longer reach, so that the last failure of a run lost its messages (or
  // failed the act).
  it('is written for the last stop of a run too, which the act then completes', async () => {
    const arranged = await vendorStop({ stops: 1, stopStates: ['ARRIVED'] });
    expect((await fail(arranged)).status).toBe(200);
    const manifest = await routes.rows<{ state: string }>(
      `select state from pickup_manifest where id = $1`,
      [arranged.manifestId],
    );
    expect(manifest[0]?.state).toBe('COMPLETED');
    expect(await envelopesOf(arranged.requestId)).toHaveLength(1);
  });
});

describe('the lane makes the messages of a failure for the audience the request has', () => {
  // Break caught: a text to a registered vendor's request, a feed entry for a walk-in, no Ops entry, parameters that carry more than the two tokens, or any word of the note
  // in a notification.
  it('writes the vendor’s feed entry and the Ops entry for a registered vendor’s request, with the category and the reason as tokens, and sends no text', async () => {
    const arranged = await vendorStop();
    expect((await fail(arranged)).status).toBe(200);
    const sent = await relay();
    expect(sent.filter((entry) => entry.text.includes(arranged.requestCode))).toEqual([]);
    const notices = await noticesOf(arranged.requestId);
    expect(notices).toEqual([
      {
        message_kind: 'PICKUP_FAILED_OPS_FEED',
        audience: 'OPS_FEED',
        channel: 'FEED',
        state: 'DELIVERED',
        suppression_reason: null,
        vendor_organization_id: vendorA.row.organizationId,
        responsible_hub_id: HUB_A,
        parameters: { category: 'PARCEL_NOT_READY', reason: 'PARCELS_NOT_PACKED' },
        destination_hint: null,
      },
      {
        message_kind: 'PICKUP_FAILED_VENDOR_FEED',
        audience: 'VENDOR_FEED',
        channel: 'FEED',
        state: 'DELIVERED',
        suppression_reason: null,
        vendor_organization_id: vendorA.row.organizationId,
        responsible_hub_id: HUB_A,
        parameters: { category: 'PARCEL_NOT_READY', reason: 'PARCELS_NOT_PACKED' },
        destination_hint: null,
      },
    ]);
    expect(JSON.stringify(notices)).not.toContain('parcels were not packed');
    expect(await envelopesOf(arranged.requestId)).toMatchObject([
      { relay_state: 'RELAYED', last_outcome: 'MATERIALISED' },
    ]);
  });

  // Break caught: no text to the individual sender, a text to another number, a reason or a note in it, or an Ops entry missing for a walk-in.
  it('texts an individual sender once, with no reason and no note, to the number the sender gave, and tells the Ops feed as well', async () => {
    const arranged = await adHocStop();
    expect((await fail(arranged)).status).toBe(200);
    const sent = (await relay()).filter((entry) => entry.destination === arranged.phone);
    expect(sent).toHaveLength(1);
    const day = (
      await routes.rows<{ day: string }>(
        `select scheduled_service_date::text as day from pickup_request where id = $1`,
        [arranged.requestId],
      )
    )[0]?.day;
    expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(sent[0]?.text).toMatch(
      new RegExp(
        `^Melarc: we could not complete your pickup ${arranged.requestCode} planned for [A-Z][a-z]+ \\d{1,2} [A-Z][a-z]+\\. We will be in touch about the next step\\.$`,
      ),
    );
    expect(sent[0]?.text).not.toMatch(/PARCEL|NOT_READY|packed|reason|category/i);
    const notices = await noticesOf(arranged.requestId);
    expect(notices.map((each) => `${each.message_kind}:${each.audience}:${each.state}`)).toEqual([
      'PICKUP_FAILED_OPS_FEED:OPS_FEED:DELIVERED',
      expect.stringMatching(/^PICKUP_FAILED_SENDER:AD_HOC_SENDER:(SENT|DELIVERED)$/),
    ]);
    const text = notices.find((each) => each.message_kind === 'PICKUP_FAILED_SENDER');
    expect(text).toMatchObject({ channel: 'SMS', parameters: {}, vendor_organization_id: null });
    expect(text?.destination_hint).not.toBeNull();
    expect(JSON.stringify(notices)).not.toContain(arranged.phone ?? 'x');
    expect(JSON.stringify(notices)).not.toContain('parcels were not packed');
  });

  // Break caught: a real provider asked to send words the owner has not approved (words are the owner's to approve, OQ-037), or a feed entry held back with them.
  it('holds the text back from a real provider while its words are a draft, and still writes the feed entries', async () => {
    const arranged = await adHocStop();
    expect((await fail(arranged)).status).toBe(200);
    const sent = await relay(
      createLanePolicy({ realProvider: true, settings: OPEN_SETTINGS }),
      asDrafts,
    );
    expect(sent.filter((entry) => entry.destination === arranged.phone)).toEqual([]);
    const notices = await noticesOf(arranged.requestId);
    expect(
      notices.map(
        (each) => `${each.message_kind}:${each.state}:${each.suppression_reason ?? 'none'}`,
      ),
    ).toEqual([
      'PICKUP_FAILED_OPS_FEED:DELIVERED:none',
      'PICKUP_FAILED_SENDER:SUPPRESSED:WORDING_NOT_APPROVED',
    ]);
  });

  // Break caught (D-A5; fails on ac9f613, where the words were a draft): the owner's approval of 12 November 2026 not honoured, so that a real provider is never given the words of a
  // failure, or given other words than the ones approved.
  it('gives a real provider the words the owner approved for a failure, exactly as approved', async () => {
    const arranged = await adHocStop();
    expect((await fail(arranged)).status).toBe(200);
    const sent = (
      await relay(createLanePolicy({ realProvider: true, settings: OPEN_SETTINGS }))
    ).filter((entry) => entry.destination === arranged.phone);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toMatch(
      new RegExp(
        `^Melarc: we could not complete your pickup ${arranged.requestCode} planned for [A-Z][a-z]+ \\d{1,2} [A-Z][a-z]+\\. We will be in touch about the next step\\.$`,
      ),
    );
    const text = (await noticesOf(arranged.requestId)).find(
      (each) => each.message_kind === 'PICKUP_FAILED_SENDER',
    );
    expect(text?.state).toMatch(/^(SENT|DELIVERED)$/);
    expect(text?.suppression_reason).toBeNull();
  });

  // Break caught: a message that is not under the kill switches and the day's limits of every other text.
  it('is held back by the kind’s kill switch and by the number’s daily limit, as every text is', async () => {
    const switchedOff = await adHocStop();
    expect((await fail(switchedOff)).status).toBe(200);
    await relay(
      createLanePolicy({
        realProvider: false,
        settings: {
          ...OPEN_SETTINGS,
          disabledKinds: () => Promise.resolve(new Set(['PICKUP_FAILED_SENDER'])),
        },
      }),
    );
    expect(
      (await noticesOf(switchedOff.requestId)).find(
        (each) => each.message_kind === 'PICKUP_FAILED_SENDER',
      ),
    ).toMatchObject({ state: 'SUPPRESSED', suppression_reason: 'KILL_SWITCH' });

    const limited = await adHocStop();
    expect((await fail(limited)).status).toBe(200);
    const sent = await relay({
      withhold: () => Promise.resolve(null),
      limits: () => Promise.resolve({ perNumberPerDay: 0, perDay: null }),
    });
    expect(sent.filter((entry) => entry.destination === limited.phone)).toEqual([]);
    expect(
      (await noticesOf(limited.requestId)).find(
        (each) => each.message_kind === 'PICKUP_FAILED_SENDER',
      ),
    ).toMatchObject({ state: 'SUPPRESSED', suppression_reason: 'NUMBER_LIMIT' });
  });
});

describe('recordCollection tells the office in the system of a short count', () => {
  // Break caught: no envelope for a short count (the office told by a timestamp only), one for a count that matches, an envelope that carries a count or the note, or one that
  // outlives a refused act.
  it('writes one envelope for a short count, from the record just made, and none for a count that matches or a refused count', async () => {
    const matching = await vendorStop();
    expect((await collect(matching, { collected_count: 3 })).status).toBe(200);
    expect(await envelopesOf(matching.requestId)).toEqual([]);

    const refused = await vendorStop();
    // A short count with no reason is refused, and nothing is made.
    expect((await collect(refused, { collected_count: 2 })).status).toBeGreaterThanOrEqual(400);
    expect(await envelopesOf(refused.requestId)).toEqual([]);

    const arranged = await vendorStop();
    const key = randomUUID();
    const counted = await collect(
      arranged,
      { ...SHORT, variance_note: 'Two are still packing' },
      key,
    );
    expect(counted.status, counted.text).toBe(200);
    const [envelope, ...rest] = await envelopesOf(arranged.requestId);
    expect(rest).toEqual([]);
    expect(envelope).toEqual({
      event_type: 'pickup.collection.shortfall_flagged',
      aggregate_type: 'PICKUP_REQUEST',
      aggregate_id: arranged.requestId,
      responsible_hub_id: HUB_A,
      vendor_organization_id: vendorA.row.organizationId,
      rider_id: null,
      originating_principal_type: 'RIDER',
      originating_principal_id: arranged.rider.id,
      operation_id: 'recordCollection',
      payload: { stop: arranged.stopId, reason: 'SOME_PARCELS_NOT_READY' },
      relay_state: 'PENDING',
      last_outcome: null,
    });
    expect(JSON.stringify(envelope)).not.toContain('still packing');
    // The retry writes nothing more.
    expect(
      (await collect(arranged, { ...SHORT, variance_note: 'Two are still packing' }, key)).status,
    ).toBe(200);
    expect(await envelopesOf(arranged.requestId)).toHaveLength(1);
  });

  // Break caught: an entry missing for a walk-in's request, a text for the office, a count or a note in the entry, or an entry for the vendor (it is the office's).
  it('becomes one Ops feed entry for the hub, for a vendor’s request and for an individual sender’s alike, with the reason as a token and no text sent', async () => {
    const vendor = await vendorStop();
    expect((await collect(vendor)).status).toBe(200);
    const walkIn = await adHocStop();
    expect((await collect(walkIn)).status).toBe(200);
    const sent = await relay();
    expect(
      sent.filter(
        (entry) =>
          entry.text.includes(vendor.requestCode) || entry.text.includes(walkIn.requestCode),
      ),
    ).toEqual([]);
    for (const [arranged, vendorOrganizationId] of [
      [vendor, vendorA.row.organizationId],
      [walkIn, null],
    ] as const) {
      expect(await noticesOf(arranged.requestId)).toEqual([
        {
          message_kind: 'COLLECTION_SHORT_OPS_FEED',
          audience: 'OPS_FEED',
          channel: 'FEED',
          state: 'DELIVERED',
          suppression_reason: null,
          vendor_organization_id: vendorOrganizationId,
          responsible_hub_id: HUB_A,
          parameters: { reason: 'SOME_PARCELS_NOT_READY' },
          destination_hint: null,
        },
      ]);
    }
  });

  // Break caught: an entry the office cannot find where it works (the Ops feed of the log), one the staff of another hub can read, or one that shows more than the entry.
  it('is found by the staff of the hub in the Ops feed under notification.read, and not by the staff of another hub', async () => {
    const arranged = await vendorStop();
    expect((await collect(arranged)).status).toBe(200);
    expect((await fail(await vendorStop())).status).toBe(200);
    await relay();
    const feed = `${API}/notifications?channel=FEED&audience=OPS_FEED&subject_id=${arranged.requestId}`;
    const own = await ops.client.get(feed);
    expect(own.status, own.text).toBe(200);
    const items = (
      own.json() as {
        items: {
          message_kind: string;
          audience: string;
          channel: string;
          state: string;
          subject: { id: string };
          responsible_hub_id: string;
        }[];
      }
    ).items;
    expect(items).toEqual([
      expect.objectContaining({
        message_kind: 'COLLECTION_SHORT_OPS_FEED',
        audience: 'OPS_FEED',
        channel: 'FEED',
        state: 'DELIVERED',
        subject: { type: 'PICKUP_REQUEST', id: arranged.requestId },
        responsible_hub_id: HUB_A,
      }),
    ]);
    // The log shows no parameters: the entry says only what kind it is, for which request.
    expect(JSON.stringify(items)).not.toContain('SOME_PARCELS_NOT_READY');
    const other = await opsB.client.get(feed);
    expect(other.status, other.text).toBe(200);
    expect((other.json() as { items: unknown[] }).items).toEqual([]);
  });
});

/**
 * Several statements in one transaction under a context, as a statement of the runtime login would run them: the rows of the last, or the SQLSTATE of the first that fails and the
 * reason its guard states.
 */
interface Result {
  readonly rows?: unknown[];
  readonly code?: string;
  readonly reason?: string;
}
async function attemptAll(context: SecurityContext, texts: readonly string[]): Promise<Result> {
  try {
    const rows = await routes.built.service.transactionWithContext(context, async (tx) => {
      let last: unknown[] = [];
      for (const text of texts) last = (await tx.execute(sql.raw(text))).rows;
      return last;
    });
    return { rows };
  } catch (error) {
    const reason = guardReasonIn(error);
    return {
      code: serverErrorIn(error)?.code ?? 'other',
      ...(reason === undefined ? {} : { reason }),
    };
  }
}

const FAILURE = 'pickup.failure.report';
const COUNTING = 'pickup.collection.confirm';
/** The SQLSTATEs that refuse an insert into the outbox: the table's guard (23514) and the policy's check (42501). */
const REFUSED_INSERT: readonly (string | undefined)[] = ['42501', '23514'];
const rider = (riderId: string, key: string): SecurityContext => ({
  principalType: 'RIDER',
  principalId: riderId,
  sessionId: randomUUID(),
  surface: 'RIDER_ANDROID',
  riderId,
  authorizationKey: key,
  hubScopeMode: 'SET',
  authorizedHubIds: [],
  correlationId: randomUUID(),
});
const staff = (key: string): SecurityContext => ({
  principalType: 'STAFF',
  principalId: randomUUID(),
  sessionId: randomUUID(),
  surface: 'OPS_PORTAL',
  authorizationKey: key,
  hubScopeMode: 'ALL',
  authorizedHubIds: [],
  correlationId: randomUUID(),
});
const vendor = (key: string): SecurityContext => ({
  principalType: 'VENDOR',
  principalId: vendorA.row.accountId,
  sessionId: randomUUID(),
  surface: 'VENDOR_PWA',
  authorizationKey: key,
  vendorOrganizationId: vendorA.row.organizationId,
  hubScopeMode: 'SET',
  authorizedHubIds: [],
  correlationId: randomUUID(),
});

const failSql = (stopId: string): string =>
  `update pickup_stop set state = 'FAILED', failure_category = 'PARCEL_NOT_READY',
          failure_reason_snapshot = '${JSON.stringify({
            reason_code: 'PARCELS_NOT_PACKED',
            label: 'Parcels not packed',
            attribution: 'CUSTOMER',
            note: 'The parcels were not packed',
          })}'::jsonb
    where id = '${stopId}' returning id`;
const failureEnvelopeSql = (stopId: string): string =>
  `select melarc.failure_envelope('${stopId}'::uuid)`;
const countSql = (arranged: Arranged, over: { collected?: number } = {}): string => {
  const collected = over.collected ?? 2;
  const short = collected < 3;
  return `insert into collection_record (id, pickup_stop_id, responsible_hub_id, declared_count, collected_count, variance, variance_reason_snapshot, handshake_type, recorded_by)
          values ('${randomUUID()}', '${arranged.stopId}', '${HUB_A}', 3, ${String(collected)}, '${short ? 'SHORT' : 'MATCH'}',
                  ${
                    short
                      ? `'${JSON.stringify({ reason_code: 'SOME_PARCELS_NOT_READY', label: 'Some parcels not ready', attribution: 'CUSTOMER' })}'::jsonb`
                      : 'null'
                  },
                  'VENDOR_ENTERED_RIDER_DISPLAYED', '${arranged.rider.id}') returning id`;
};
const shortfallEnvelopeSql = (stopId: string): string =>
  `select melarc.shortfall_envelope('${stopId}'::uuid)`;

describe('melarc.failure_envelope: the one operation that writes the envelope of a failure', () => {
  // Break caught: a caller that cannot write the envelope of its own failure, or one that writes it for a stop it did not just fail.
  it('writes the envelope for the rider that has just failed the stop, in that transaction', async () => {
    const arranged = await vendorStop();
    const done = await attemptAll(rider(arranged.rider.id, FAILURE), [
      failSql(arranged.stopId),
      failureEnvelopeSql(arranged.stopId),
    ]);
    expect(done.code, JSON.stringify(done)).toBeUndefined();
    expect(await envelopesOf(arranged.requestId)).toMatchObject([
      {
        event_type: 'pickup.failure.reported',
        operation_id: 'reportPickupFailure',
        payload: {
          stop: arranged.stopId,
          category: 'PARCEL_NOT_READY',
          reason: 'PARCELS_NOT_PACKED',
        },
      },
    ]);
  });

  // Break caught: a stop whose failure was reported in an earlier transaction, so that a rider (or a compromised service) could say the same failure again and spend texts.
  it('refuses a stop that was failed in an earlier transaction, a stop that is not failed, and a second call in the transaction', async () => {
    const arranged = await vendorStop();
    const context = rider(arranged.rider.id, FAILURE);
    // Not failed at all.
    expect((await attemptAll(context, [failureEnvelopeSql(arranged.stopId)])).code).toBe('42501');
    // A second call in the transaction that failed it meets the key of the table (event, aggregate, correlation).
    const twice = await attemptAll(context, [
      failSql(arranged.stopId),
      failureEnvelopeSql(arranged.stopId),
      failureEnvelopeSql(arranged.stopId),
    ]);
    expect(twice.code).toBe('23505');
    expect(await envelopesOf(arranged.requestId)).toEqual([]);
    // Failed in an earlier transaction.
    expect((await attemptAll(context, [failSql(arranged.stopId)])).code).toBeUndefined();
    expect((await attemptAll(context, [failureEnvelopeSql(arranged.stopId)])).code).toBe('42501');
    expect(await envelopesOf(arranged.requestId)).toEqual([]);
  });

  // Break caught: the envelope written by a rider for a run that is not its own, under a key that is not the act's, or by a principal that is not a rider.
  it('refuses another rider, another key, staff and a vendor', async () => {
    const arranged = await vendorStop();
    const other = await vendorStop();
    // The other rider's report of this stop changes no row (it is not its run), so there is no failure to tell.
    expect(
      (
        await attemptAll(rider(other.rider.id, FAILURE), [
          failSql(arranged.stopId),
          failureEnvelopeSql(arranged.stopId),
        ])
      ).code,
    ).toBe('42501');
    for (const context of [
      rider(arranged.rider.id, COUNTING),
      rider(arranged.rider.id, 'pickup.run.execute'),
      staff(FAILURE),
      vendor(FAILURE),
    ]) {
      const refused = await attemptAll(context, [failureEnvelopeSql(arranged.stopId)]);
      expect(refused.code, context.principalType + ' ' + (context.authorizationKey ?? '')).toBe(
        '42501',
      );
    }
    expect(
      (
        await attemptAll(rider(arranged.rider.id, FAILURE), [
          `select melarc.failure_envelope(null)`,
        ])
      ).code,
    ).toBe('22023');
    expect(await envelopesOf(arranged.requestId)).toEqual([]);
    expect(await envelopesOf(other.requestId)).toEqual([]);
  });

  // Break caught: a policy that lets the runtime login insert the envelope itself, with the words of its choice, for any request.
  it('cannot be gone round: the login’s own insert of the envelope is refused, for the right rider and for staff', async () => {
    const arranged = await vendorStop();
    const insert = `insert into outbox (id, event_type, aggregate_type, aggregate_id, responsible_hub_id, vendor_organization_id, originating_principal_type,
                                          originating_principal_id, operation_id, correlation_id, payload)
                    values ('${randomUUID()}', 'pickup.failure.reported', 'PICKUP_REQUEST', '${arranged.requestId}', '${HUB_A}', '${vendorA.row.organizationId}', 'RIDER',
                            '${arranged.rider.id}', 'reportPickupFailure', 'x', '{}'::jsonb)`;
    const context = rider(arranged.rider.id, FAILURE);
    // The guard of the outbox (a BEFORE trigger, 23514: the login cannot read the request the envelope names) answers before the policy's check (42501): either refuses.
    expect(REFUSED_INSERT).toContain(
      (await attemptAll(context, [failSql(arranged.stopId), insert])).code,
    );
    const staffInsert = insert
      .replace("'RIDER',", "'STAFF',")
      .replace(arranged.rider.id, randomUUID());
    expect((await attemptAll(staff(FAILURE), [staffInsert])).code).toBeDefined();
    expect(await envelopesOf(arranged.requestId)).toEqual([]);
  });
});

describe('melarc.shortfall_envelope: the one operation that writes the envelope of a short count', () => {
  it('writes the envelope for the rider that has just counted the stop short, in that transaction', async () => {
    const arranged = await vendorStop();
    const done = await attemptAll(rider(arranged.rider.id, COUNTING), [
      countSql(arranged),
      shortfallEnvelopeSql(arranged.stopId),
    ]);
    expect(done.code, JSON.stringify(done)).toBeUndefined();
    expect(await envelopesOf(arranged.requestId)).toMatchObject([
      {
        event_type: 'pickup.collection.shortfall_flagged',
        operation_id: 'recordCollection',
        payload: { stop: arranged.stopId, reason: 'SOME_PARCELS_NOT_READY' },
      },
    ]);
  });

  // Break caught: the envelope of a count that matches (nothing to tell the office), of a count made earlier, or a second in the transaction.
  it('refuses a stop with no count, a count that matches, a count of an earlier transaction and a second call', async () => {
    const none = await vendorStop();
    expect(
      (await attemptAll(rider(none.rider.id, COUNTING), [shortfallEnvelopeSql(none.stopId)])).code,
    ).toBe('42501');

    const matching = await vendorStop();
    expect(
      (
        await attemptAll(rider(matching.rider.id, COUNTING), [
          countSql(matching, { collected: 3 }),
          shortfallEnvelopeSql(matching.stopId),
        ])
      ).code,
    ).toBe('42501');

    const arranged = await vendorStop();
    const context = rider(arranged.rider.id, COUNTING);
    const twice = await attemptAll(context, [
      countSql(arranged),
      shortfallEnvelopeSql(arranged.stopId),
      shortfallEnvelopeSql(arranged.stopId),
    ]);
    expect(twice.code).toBe('23505');
    expect(await envelopesOf(arranged.requestId)).toEqual([]);

    const earlier = await vendorStop();
    expect(
      (await attemptAll(rider(earlier.rider.id, COUNTING), [countSql(earlier)])).code,
    ).toBeUndefined();
    expect(
      (await attemptAll(rider(earlier.rider.id, COUNTING), [shortfallEnvelopeSql(earlier.stopId)]))
        .code,
    ).toBe('42501');
    expect(await envelopesOf(earlier.requestId)).toEqual([]);
  });

  // Break caught: the envelope of a count written by another rider, under another key, or by staff or a vendor; or one the login inserts itself.
  it('refuses another rider, another key, staff and a vendor, and the login’s own insert', async () => {
    const arranged = await vendorStop();
    const other = await vendorStop();
    const count = countSql(arranged);
    // The other rider's count of this stop is refused by the record's own policy (it is not its run), so there is no count to tell.
    expect(
      (
        await attemptAll(rider(other.rider.id, COUNTING), [
          count,
          shortfallEnvelopeSql(arranged.stopId),
        ])
      ).code,
    ).toBeDefined();
    for (const context of [
      rider(arranged.rider.id, FAILURE),
      rider(arranged.rider.id, 'pickup.run.execute'),
      staff(COUNTING),
      vendor(COUNTING),
    ]) {
      expect(
        (await attemptAll(context, [shortfallEnvelopeSql(arranged.stopId)])).code,
        context.principalType + ' ' + (context.authorizationKey ?? ''),
      ).toBe('42501');
    }
    const insert = `insert into outbox (id, event_type, aggregate_type, aggregate_id, responsible_hub_id, vendor_organization_id, originating_principal_type,
                                          originating_principal_id, operation_id, correlation_id, payload)
                    values ('${randomUUID()}', 'pickup.collection.shortfall_flagged', 'PICKUP_REQUEST', '${arranged.requestId}', '${HUB_A}', '${vendorA.row.organizationId}', 'RIDER',
                            '${arranged.rider.id}', 'recordCollection', 'x', '{}'::jsonb)`;
    expect(REFUSED_INSERT).toContain(
      (await attemptAll(rider(arranged.rider.id, COUNTING), [count, insert])).code,
    );
    expect(await envelopesOf(arranged.requestId)).toEqual([]);
    expect(await envelopesOf(other.requestId)).toEqual([]);
  });
});
