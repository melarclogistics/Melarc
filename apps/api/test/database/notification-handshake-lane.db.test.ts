import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SystemClock } from '../../src/platform/auth/clock/system.clock.adapter.js';
import { WORKER_RUNTIME_ROLE } from '../../src/platform/database/technical-roles.js';
import {
  CaptureTextMessageSender,
  type TextCaptureEntry,
} from '../../src/platform/notifications/capture.text-message-sender.adapter.js';
import { createLanePolicy } from '../../src/platform/notifications/lane-policy.js';
import {
  NotificationLane,
  OPEN_POLICY,
  destinationHint,
} from '../../src/platform/notifications/notification-lane.js';
import { NotificationStore } from '../../src/platform/notifications/notification-store.js';
import { OPEN_SETTINGS } from '../../src/platform/notifications/lane-policy.js';
import { templateOf, type Template } from '../../src/platform/notifications/templates.js';
import type { TestResponse } from '../../src/test-support/test-client.js';
import { manifestDays, type ManifestDays } from './support/manifest-days.js';
import { insertManifest, insertStop, manifestRow, stopRow } from './support/manifests.js';
import { insertAdHocSender, insertPickupRequest, pickupRequestRow } from './support/pickups.js';
import { arrangeRun, arrangedRider, type ArrangedRider } from './support/runs.js';
import { seedHubConfiguration } from './support/seeded.js';
import { buildService } from './support/service.js';
import { API, HUB_A, codeOf } from './support/staff-routes.js';
import {
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from './support/vendor-routes.js';

/**
 * S1.27, the notification lane's part of the collection handshake (`AC-SLICE-001-23`, `-73`): the text that carries a code, against a real PostgreSQL, the
 * real application (which writes the request for the text in the act that makes the code) and the real lane (which relays it, makes the code in memory
 * and hands the text to a sender that reaches nobody). Each claim is what a person would meet or what could leak:
 *
 * - **An individual sender is texted the code** the rider will ask for, to the sender's number alone, in the words of the draft; the rider then enters
 *   what the text said and the stop closes. A vendor's pickup has no such text at the start.
 * - **The SMS fallback texts a new code to the registered number of the vendor**, which the vendor reads out to the rider.
 * - **The code is nowhere at rest**: not in the notification, the envelope, the events or the stored answers; the text and the number exist in memory
 *   for the send only. The handshake is told that the text was accepted (`CODE_DELIVERED`, one event of the system).
 * - **A text that events overtook is not sent**: a code that has run out, or a code a later one superseded.
 * - **A lane that cannot make the code sends nothing**, and says so.
 * - **A real provider is put behind the wording gate**: words that are a draft are held back until the owner approves them (OB-S1-06); the two texts of the code were approved
 *   on 12 November 2026 (D-A5), and go to a real provider exactly as approved.
 */
let routes: VendorRoutes;
let days: ManifestDays;
let vendorA: ArrangedVendor;
let work: ReturnType<typeof buildService>;
const clock = new SystemClock();
const NEVER = new AbortController().signal;
const REGISTERED_NUMBER = '+233201112222';

beforeAll(async () => {
  routes = await startVendorRoutes();
  await seedHubConfiguration(routes.database);
  days = await manifestDays(routes.admin);
  vendorA = await routes.vendor();
  // The registered number is the phone of the vendor's credential where its channel is PHONE (F-23, migration 0073); the business contact is another number the lane never texts.
  await routes.admin.query(
    `update vendor_credential set recovery_phone = $2, delivery_channel = 'PHONE' where vendor_account_id = $1`,
    [vendorA.row.accountId, REGISTERED_NUMBER],
  );
  await routes.admin.query(`update vendor_organization set contact_phone = $2 where id = $1`, [
    vendorA.row.organizationId,
    '+233209990000',
  ]);
  work = buildService(routes.database, { poolMax: 3, login: WORKER_RUNTIME_ROLE });
}, 180_000);

afterAll(async () => {
  await work.close();
  await routes.stop();
});

const STOP = (id: string) => `${API}/pickup-stops/${id}`;
const outcome = (response: TestResponse): [number, string | undefined] => [
  response.status,
  codeOf(response),
];

/** The wording the lane reads, with the approval taken off: what the words were before the owner approved them. */
const asDrafts = (kind: string, version: number): Template | undefined => {
  const found = templateOf(kind, version);
  return found === undefined
    ? undefined
    : { ...found, approvedBy: null, approvedOn: null, approvedDigest: null };
};

function laneOf(
  entries: TextCaptureEntry[],
  over: {
    withCodes?: boolean;
    policy?: ReturnType<typeof createLanePolicy>;
    templates?: (kind: string, version: number) => Template | undefined;
  } = {},
): NotificationLane {
  const store = new NotificationStore({
    database: work.service,
    clock,
    workerId: 'test-handshake-lane',
  });
  return new NotificationLane({
    store,
    sender: new CaptureTextMessageSender({
      sink: { record: (entry) => Promise.resolve(void entries.push(entry)) },
      clock,
    }),
    policy: over.policy ?? OPEN_POLICY,
    logger: work.logs.logger,
    leaseMs: 30_000,
    firstReceiptCheckMs: 60_000,
    receiptHoldMs: 60_000,
    random: () => 0.5,
    ...(over.withCodes === false ? {} : { handshakeCodes: routes.handshakeCodes }),
    ...(over.templates === undefined ? {} : { templates: over.templates }),
  });
}

const tokenOf = async (rider: ArrangedRider, stopId: string): Promise<string> =>
  (await rider.client.get(STOP(stopId))).header('etag') ?? '';
const count = async (rider: ArrangedRider, stopId: string): Promise<TestResponse> =>
  rider.client.post(
    `${STOP(stopId)}/collect`,
    { collected_count: 3 },
    { headers: { 'If-Match': await tokenOf(rider, stopId), 'Idempotency-Key': randomUUID() } },
  );
const initiate = (rider: ArrangedRider, stopId: string): Promise<TestResponse> =>
  rider.client.post(`${STOP(stopId)}/handshake`, undefined, {
    headers: { 'Idempotency-Key': randomUUID() },
  });

/** A counted individual sender's pickup, and the sender's number. */
async function countedSender() {
  const rider = await arrangedRider(routes.kit, routes.admin);
  const sender = await insertAdHocSender(routes.admin, { state: 'PROVISIONAL' });
  const manifest = await insertManifest(
    routes.admin,
    manifestRow(HUB_A, {
      state: 'IN_PROGRESS',
      serviceDate: days.today,
      assignedRiderId: rider.id,
    }),
  );
  const request = await insertPickupRequest(
    routes.admin,
    pickupRequestRow(vendorA.row.organizationId, HUB_A, {
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
  const stop = await insertStop(
    routes.admin,
    stopRow(manifest, request.id, 1, {
      state: 'ARRIVED',
      pickupSummary: {
        reference: request.code,
        sender_display_name: 'Ama Walk-in',
        declared_package_count: 3,
        resolved_pickup_location: { address: 'Fixture stall' },
        location_note: null,
        contact_phone: null,
      },
    }),
  );
  expect((await count(rider, stop.id)).status).toBe(200);
  return { rider, stop, request, phone: sender.phone };
}

/** A counted vendor's pickup. */
async function countedVendorStop() {
  const arranged = await arrangeRun(routes.kit, routes.admin, {
    vendorOrganizationId: vendorA.row.organizationId,
    serviceDate: days.today,
    state: 'IN_PROGRESS',
    stops: 1,
    stopStates: ['ARRIVED'],
  });
  const stop = arranged.stops[0];
  if (stop === undefined) throw new Error('stop');
  expect((await count(arranged.rider, stop.id)).status).toBe(200);
  return { rider: arranged.rider, stop };
}

const notificationsOf = (requestId: string) =>
  routes.rows<{
    message_kind: string;
    audience: string;
    state: string;
    suppression_reason: string | null;
    outcome_class: string | null;
    destination_hint: string | null;
  }>(
    `select message_kind, audience, state, suppression_reason, outcome_class, destination_hint
       from notification where subject_id = $1 order by created_at, message_kind`,
    [requestId],
  );
const handshakeState = async (stopId: string) =>
  (
    await routes.rows<{ state: string; code_generation: number }>(
      `select state, code_generation from collection_handshake where pickup_stop_id = $1`,
      [stopId],
    )
  )[0];
const textCode = (text: string): string =>
  /code is (\d{4,8})|is (\d{4,8})\./.exec(text)?.slice(1).find(Boolean) ?? '';
/** Sets the platform's length of a code, as an administrator would between the issue of a code and the send of its text. */
const setLength = (digits: number) =>
  routes.admin.query(`update setting set value = $1::jsonb where key = 'handshake_code_length'`, [
    String(digits),
  ]);

describe('the code of an individual sender, by SMS', () => {
  // Break caught: the chain not working: no text asked, none sent, the code not the one the rider is asked for, the text sent to the wrong number or kept in a
  // column, the handshake not told, the stop not closed by the code from the text.
  it('texts the sender the code the rider will ask for, tells the handshake, and the rider closes the stop with what the text said', async () => {
    const { rider, stop, request, phone } = await countedSender();
    expect((await initiate(rider, stop.id)).status).toBe(201);
    const entries: TextCaptureEntry[] = [];

    const report = await laneOf(entries).runOnce(NEVER);

    expect(report).toMatchObject({
      relayed: 1,
      notificationsWritten: 1,
      sent: 1,
      errors: 0,
      suppressed: 0,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.destination).toBe(phone);
    const code = textCode(entries[0]?.text ?? '');
    expect(code).toBe(
      routes.handshakeCodes.codeFor(stop.id, 1, routes.handshakeCodes.activeVersion, 4),
    );
    expect(entries[0]?.text).toBe(
      `Melarc: your pickup code is ${code}. Give it to the rider only when the rider asks, to complete pickup ${request.code}.`,
    );
    expect(await notificationsOf(request.id)).toEqual([
      expect.objectContaining({
        message_kind: 'HANDSHAKE_CODE_SENDER',
        audience: 'AD_HOC_SENDER',
        state: 'SENT',
        destination_hint: destinationHint(phone),
      }),
    ]);
    // The provider took the text: the handshake stands as delivered, by the system, once.
    expect(await handshakeState(stop.id)).toEqual({ state: 'CODE_DELIVERED', code_generation: 1 });
    const delivered = await routes.rows<{
      actor_type: string;
      previous_state: string;
      resulting_state: string;
    }>(
      `select actor_type, previous_state, resulting_state from audit_event where event_code = 'pickup.handshake.delivered' and object_type = 'CollectionHandshake'
          and related_ids ->> 'pickup_stop_id' = $1`,
      [stop.id],
    );
    expect(delivered).toEqual([
      { actor_type: 'SYSTEM', previous_state: 'CODE_GENERATED', resulting_state: 'CODE_DELIVERED' },
    ]);

    // Nothing at rest holds the code, the text or the number: the notification, the envelope, the events.
    const kept = await routes.rows<{ everything: string }>(
      `select (select coalesce(string_agg(n::text, ' '), '') from notification n where n.subject_id = $1)
           || (select coalesce(string_agg(o::text, ' '), '') from outbox o where o.aggregate_id = $1)
           || (select coalesce(string_agg(a::text, ' '), '') from audit_event a where a.related_ids ->> 'pickup_stop_id' = $2) as everything`,
      [request.id, stop.id],
    );
    expect(kept[0]?.everything).not.toContain(`"${code}"`);
    expect(kept[0]?.everything).not.toContain(phone);
    expect(kept[0]?.everything).not.toContain('pickup code is');

    // The rider enters what the text said.
    const entered = await rider.client.post(`${STOP(stop.id)}/handshake/verify`, { code });
    expect(entered.status).toBe(200);
    expect(entered.json()).toMatchObject({ state: 'VERIFIED', channel: 'PORTAL' });
    expect(
      (
        await routes.rows<{ state: string }>(`select state from pickup_stop where id = $1`, [
          stop.id,
        ])
      )[0]?.state,
    ).toBe('COLLECTED');
  });

  // Break caught (the review of 5 November 2026): the lane reading the platform's length again when it makes the code it texts, so that a setting changed between the
  // issue and the send texts a code of another length than the digest was made from, and the sender can never complete the pickup. The length is kept with the code.
  it('texts the code at the length it was made with, though the platform’s length changed between the request and the send', async () => {
    const { rider, stop, request } = await countedSender();
    expect((await initiate(rider, stop.id)).status).toBe(201);
    const entries: TextCaptureEntry[] = [];
    try {
      await setLength(7);

      await laneOf(entries).runOnce(NEVER);
    } finally {
      await setLength(4);
    }

    expect(entries).toHaveLength(1);
    const code = textCode(entries[0]?.text ?? '');
    expect(code).toHaveLength(4);
    expect(code).toBe(
      routes.handshakeCodes.codeFor(stop.id, 1, routes.handshakeCodes.activeVersion, 4),
    );
    expect((await notificationsOf(request.id))[0]).toMatchObject({ state: 'SENT' });
    // The code the sender received is the code the database holds the digest of: the rider enters it and the stop closes.
    const entered = await rider.client.post(`${STOP(stop.id)}/handshake/verify`, { code });
    expect(entered.status).toBe(200);
    expect(entered.json()).toMatchObject({ state: 'VERIFIED' });
  });

  // Break caught: a text for a code that has run out, which says what is no longer so, and a handshake told that a text was delivered that never went.
  it('does not send a code that has run out before the lane got to it', async () => {
    const { rider, stop, request } = await countedSender();
    expect((await initiate(rider, stop.id)).status).toBe(201);
    await routes.admin.query(
      `update collection_handshake set expires_at = clock_timestamp() - interval '1 second' where pickup_stop_id = $1`,
      [stop.id],
    );
    const entries: TextCaptureEntry[] = [];

    const report = await laneOf(entries).runOnce(NEVER);

    expect(report).toMatchObject({ relayed: 1, sent: 0, suppressed: 1 });
    expect(entries).toEqual([]);
    expect(await notificationsOf(request.id)).toEqual([
      expect.objectContaining({
        message_kind: 'HANDSHAKE_CODE_SENDER',
        state: 'SUPPRESSED',
        suppression_reason: 'OVERTAKEN',
      }),
    ]);
    expect(await handshakeState(stop.id)).toEqual({ state: 'CODE_GENERATED', code_generation: 1 });
  });

  // Break caught: a lane without the key sending a text with no code, or a code that is the wrong one, or leaving the notification to be retried for ever.
  it('sends nothing when the lane cannot make the code, and says so', async () => {
    const { rider, stop, request } = await countedSender();
    expect((await initiate(rider, stop.id)).status).toBe(201);
    const entries: TextCaptureEntry[] = [];

    const report = await laneOf(entries, { withCodes: false }).runOnce(NEVER);

    expect(report).toMatchObject({ relayed: 1, sent: 0, failed: 1 });
    expect(entries).toEqual([]);
    expect(await notificationsOf(request.id)).toEqual([
      expect.objectContaining({
        message_kind: 'HANDSHAKE_CODE_SENDER',
        state: 'FAILED',
        outcome_class: 'REJECTED',
      }),
    ]);
    expect(await handshakeState(stop.id)).toEqual({ state: 'CODE_GENERATED', code_generation: 1 });
  });

  // Break caught (OB-S1-06): a real provider sent words nobody approved. Words that are a draft are held back until the owner approves them.
  it('holds the text back, for a real provider, while its words are a draft', async () => {
    const { rider, stop, request } = await countedSender();
    expect((await initiate(rider, stop.id)).status).toBe(201);
    const entries: TextCaptureEntry[] = [];

    const report = await laneOf(entries, {
      policy: createLanePolicy({ realProvider: true, settings: OPEN_SETTINGS }),
      templates: asDrafts,
    }).runOnce(NEVER);

    expect(report).toMatchObject({ sent: 0, suppressed: 1 });
    expect(entries).toEqual([]);
    expect(await notificationsOf(request.id)).toEqual([
      expect.objectContaining({
        message_kind: 'HANDSHAKE_CODE_SENDER',
        state: 'SUPPRESSED',
        suppression_reason: 'WORDING_NOT_APPROVED',
      }),
    ]);
  });

  // Break caught (D-A5; fails on ac9f613, where the words were a draft): the owner's approval of 12 November 2026 not honoured, so that a real provider is never given the code's words,
  // or given other words than the ones approved.
  it('gives a real provider the words the owner approved, exactly as approved, with the code in them', async () => {
    const { rider, stop, request } = await countedSender();
    expect((await initiate(rider, stop.id)).status).toBe(201);
    const entries: TextCaptureEntry[] = [];

    const report = await laneOf(entries, {
      policy: createLanePolicy({ realProvider: true, settings: OPEN_SETTINGS }),
    }).runOnce(NEVER);

    expect(report).toMatchObject({ sent: 1, suppressed: 0 });
    expect(entries).toHaveLength(1);
    const code = textCode(entries[0]?.text ?? '');
    expect(entries[0]?.text).toBe(
      `Melarc: your pickup code is ${code}. Give it to the rider only when the rider asks, to complete pickup ${request.code}.`,
    );
    expect(await notificationsOf(request.id)).toEqual([
      expect.objectContaining({ message_kind: 'HANDSHAKE_CODE_SENDER', state: 'SENT' }),
    ]);
  });
});

describe('the code of the SMS fallback, to the vendor’s registered number', () => {
  // Break caught: the new code texted to a number the rider supplied or to the sender's, the text carrying the old code, no text at the start for a vendor's pickup.
  it('texts the new code to the registered number only, and no text goes at the start of a vendor’s handshake', async () => {
    const { rider, stop } = await countedVendorStop();
    expect((await initiate(rider, stop.id)).status).toBe(201);
    const none: TextCaptureEntry[] = [];
    expect(await laneOf(none).runOnce(NEVER)).toMatchObject({ relayed: 0, sent: 0 });
    expect(none).toEqual([]);

    const fallback = await rider.client.post(
      `${STOP(stop.id)}/handshake/sms-fallback`,
      { trigger: 'NO_DATA' },
      { headers: { 'Idempotency-Key': randomUUID() } },
    );
    expect(fallback.status).toBe(202);
    const entries: TextCaptureEntry[] = [];

    const report = await laneOf(entries).runOnce(NEVER);

    expect(report).toMatchObject({ relayed: 1, notificationsWritten: 1, sent: 1, errors: 0 });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.destination).toBe(REGISTERED_NUMBER);
    const code = textCode(entries[0]?.text ?? '');
    expect(code).toBe(
      routes.handshakeCodes.codeFor(stop.id, 2, routes.handshakeCodes.activeVersion, 4),
    );
    expect(entries[0]?.text).toContain('Read it to the Melarc rider only');
    expect(await handshakeState(stop.id)).toEqual({ state: 'CODE_DELIVERED', code_generation: 2 });
    // The message log shows nothing of the registered number: it is the recovery channel of a credential, which no member of staff is shown any part of (the review of
    // 5 November 2026). There is no hint at all (the Ops Portal accepts a masked number or none), while the individual sender's text keeps its masked one.
    const logged = (await notificationsOf(stop.requestId)).filter(
      (row) => row.audience === 'VENDOR_NUMBER',
    );
    expect(logged).toHaveLength(1);
    expect(logged[0]?.destination_hint).toBeNull();

    // The vendor reads it out; the rider enters it.
    const entered = await rider.client.post(`${STOP(stop.id)}/handshake/verify`, { code });
    expect(entered.status).toBe(200);
    expect(entered.json()).toMatchObject({ state: 'VERIFIED', channel: 'SMS_FALLBACK' });
    // The handshake has ended: the same code again is a conflict, not a second closing.
    expect(outcome(await rider.client.post(`${STOP(stop.id)}/handshake/verify`, { code }))).toEqual(
      [409, 'STATE_CONFLICT'],
    );
  });

  // Break caught (the review of 5 November 2026): a fallback code texted at the length the platform holds at the send and not at the length it was made with. The first code is made
  // at four digits, the fallback at six, the setting moves again before the lane runs, and the text carries the six digits that the database holds the digest of.
  it('texts a fallback code at the length it was made with, whatever the setting says when the lane runs', async () => {
    const { rider, stop } = await countedVendorStop();
    expect((await initiate(rider, stop.id)).status).toBe(201);
    const entries: TextCaptureEntry[] = [];
    try {
      await setLength(6);
      expect(
        (
          await rider.client.post(
            `${STOP(stop.id)}/handshake/sms-fallback`,
            { trigger: 'NO_DATA' },
            { headers: { 'Idempotency-Key': randomUUID() } },
          )
        ).status,
      ).toBe(202);
      await setLength(5);

      await laneOf(entries).runOnce(NEVER);
    } finally {
      await setLength(4);
    }

    expect(entries).toHaveLength(1);
    expect(entries[0]?.destination).toBe(REGISTERED_NUMBER);
    const code = textCode(entries[0]?.text ?? '');
    expect(code).toHaveLength(6);
    expect(code).toBe(
      routes.handshakeCodes.codeFor(stop.id, 2, routes.handshakeCodes.activeVersion, 6),
    );
    expect(
      await routes.rows<{ code_length: number }>(
        `select code_length from collection_handshake where pickup_stop_id = $1`,
        [stop.id],
      ),
    ).toEqual([{ code_length: 6 }]);
    const entered = await rider.client.post(`${STOP(stop.id)}/handshake/verify`, { code });
    expect(entered.status).toBe(200);
    expect(entered.json()).toMatchObject({ state: 'VERIFIED', channel: 'SMS_FALLBACK' });
  });

  // Break caught (F-23): the fallback texted to the business contact of the organisation, or to a credential whose channel is not the phone.
  it('texts the number of the vendor’s credential and never the business contact', async () => {
    const { rider, stop } = await countedVendorStop();
    expect((await initiate(rider, stop.id)).status).toBe(201);
    expect(
      (
        await rider.client.post(
          `${STOP(stop.id)}/handshake/sms-fallback`,
          { trigger: 'PORTAL_DOWN' },
          { headers: { 'Idempotency-Key': randomUUID() } },
        )
      ).status,
    ).toBe(202);
    const entries: TextCaptureEntry[] = [];

    await laneOf(entries).runOnce(NEVER);

    expect(entries.map((entry) => entry.destination)).toEqual([REGISTERED_NUMBER]);
    expect(entries[0]?.destination).not.toBe('+233209990000');
  });

  // Break caught: a text for a code a later one superseded, which would give the vendor a code that no longer works.
  it('does not send a code that a later one superseded', async () => {
    const { rider, stop } = await countedVendorStop();
    expect((await initiate(rider, stop.id)).status).toBe(201);
    expect(
      (
        await rider.client.post(
          `${STOP(stop.id)}/handshake/sms-fallback`,
          { trigger: 'NO_DATA' },
          { headers: { 'Idempotency-Key': randomUUID() } },
        )
      ).status,
    ).toBe(202);
    // The second send, past the cooldown, supersedes the first before the lane has relayed either.
    await routes.admin.query(
      `update collection_handshake set last_fallback_at = clock_timestamp() - interval '61 seconds' where pickup_stop_id = $1`,
      [stop.id],
    );
    expect(
      (
        await rider.client.post(
          `${STOP(stop.id)}/handshake/sms-fallback`,
          { trigger: 'PORTAL_DOWN' },
          { headers: { 'Idempotency-Key': randomUUID() } },
        )
      ).status,
    ).toBe(202);
    const entries: TextCaptureEntry[] = [];

    await laneOf(entries).runOnce(NEVER);

    // Two requests, one live code: one text, of the live generation; the other was overtaken.
    expect(entries).toHaveLength(1);
    expect(textCode(entries[0]?.text ?? '')).toBe(
      routes.handshakeCodes.codeFor(stop.id, 3, routes.handshakeCodes.activeVersion, 4),
    );
    expect(await handshakeState(stop.id)).toEqual({ state: 'CODE_DELIVERED', code_generation: 3 });
  });
});
