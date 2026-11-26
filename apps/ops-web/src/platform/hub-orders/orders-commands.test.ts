import { createBrowserApiClient } from '@melarc/api-client/browser';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { installFakeApi, json, type FakeApi } from '../../test-support/fake-api';
import { captured, capturedRefusal, correctionOf } from '../../test-support/orders-fixture';
import {
  amendOrder,
  closeIntake,
  decidePayerCorrection,
  itemizeOrder,
  previewOrder,
  previewOrderAmendment,
  readDestinationZones,
  requestPayerCorrection,
  reverseOrderArrival,
  setParcelWaiting,
  type AmendSaveBody,
  type OrderPreviewBody,
  type OrderSaveBody,
} from './orders-commands';

/**
 * The wire shape of the acts of the order screens (S1.40), read from the requests the real client puts on the wire: the method, the path, the headers each operation declares **and no other**, and the body in the
 * contract's names. A preview carries no key and no version (it changes nothing); a save carries both; and **two refusals are the answer the screen was built to meet**, so they come back as results: the terms
 * that are not the ones the officer read, and the assessment that is not the one the senior read. Every answer is judged: one for another vendor or order, or one that is not what the act answers with, is an answer
 * that is not the API's, which a confirmed command reads as an outcome that is not known (the act may have been done). The answers are the ones the real API gave (`test/fixtures/orders`).
 */
const KEY = 'key-0001';
const VERSION = '"v-3"';

let api: FakeApi;
const client = () => createBrowserApiClient();

beforeEach(() => {
  document.cookie = 'melarc_csrf=csrf-token; path=/';
});
afterEach(() => {
  api.restore();
  document.cookie = 'melarc_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
});

const last = () => {
  const request = api.requests.at(-1);
  if (request === undefined) throw new Error('nothing was sent');
  return request;
};
const bodyOf = async (): Promise<unknown> => last().clone().json();
const refusalOf = (name: string) => {
  const { status, body } = capturedRefusal(name);
  return json(status, body);
};

const PREVIEW = captured('preview');
const INTAKE = PREVIEW.intake_id as string;
const OTHER_ID = '99999999-9999-4999-8999-999999999999';
const PREVIEW_BODY: OrderPreviewBody = {
  recipient: {
    name: 'Ama Mensah',
    phone: '024 123 4567',
    location: { address: '12 Madina Estate' },
  },
  size_class: 'SMALL',
  lane: 'DOORSTEP',
  is_high_value: false,
  is_serialized_goods: false,
};
const BODY: OrderSaveBody = { ...PREVIEW_BODY, reviewed_terms: 'a'.repeat(64) };

describe('previewOrder', () => {
  it('posts the body to the preview with no key and no version, and answers the terms', async () => {
    api = installFakeApi({
      [`POST /hub-intakes/${INTAKE}/orders/preview`]: () => json(200, PREVIEW),
    });
    const outcome = await previewOrder(client(), INTAKE, PREVIEW_BODY);
    expect(last().method).toBe('POST');
    expect(last().headers.get('Idempotency-Key')).toBeNull();
    expect(last().headers.get('If-Match')).toBeNull();
    expect(await bodyOf()).toEqual(PREVIEW_BODY);
    expect(outcome.kind).toBe('terms');
    if (outcome.kind === 'terms') expect(outcome.terms.terms_token).toBe(PREVIEW.terms_token);
  });

  // Break caught: the terms of another vendor shown as this vendor's (the officer would confirm a price that is not for this order).
  it('reads terms for another vendor as an answer that is not the API’s', async () => {
    api = installFakeApi({
      [`POST /hub-intakes/${OTHER_ID}/orders/preview`]: () => json(200, PREVIEW),
    });
    await expect(previewOrder(client(), OTHER_ID, PREVIEW_BODY)).rejects.toMatchObject({
      kind: 'unexpected-response',
    });
  });

  // Break caught: an address that matches several zones told as a failure with nothing to choose from, or the zones of the refusal not read.
  it('answers the zones to choose from when the address matches more than one', async () => {
    api = installFakeApi({
      [`POST /hub-intakes/${INTAKE}/orders/preview`]: () => refusalOf('preview-zone-choice'),
    });
    const outcome = await previewOrder(client(), INTAKE, PREVIEW_BODY);
    expect(outcome.kind).toBe('zone-choice');
    if (outcome.kind === 'zone-choice') {
      expect(outcome.candidates.map((zone) => zone.name)).toEqual(['Accra Central', 'Tema']);
      expect(outcome.candidates.every((zone) => /^[0-9a-f-]{36}$/.test(zone.zone_id))).toBe(true);
    }
  });

  // Break caught: a refusal that names the ambiguity but gives no zones taken as a choice of none.
  it('refuses, as a failure, an ambiguous address that names no zone, or zones that are not zones', async () => {
    const { status, body } = capturedRefusal('preview-zone-choice');
    const details = (body.details ?? {}) as Record<string, unknown>;
    for (const candidates of [
      undefined,
      [],
      [{ zone_id: 'not-an-id', name: 'Tema' }],
      [{ zone_id: OTHER_ID }],
      'Tema',
    ]) {
      api = installFakeApi({
        [`POST /hub-intakes/${INTAKE}/orders/preview`]: () =>
          json(status, { ...body, details: { ...details, candidates } }),
      });
      await expect(
        previewOrder(client(), INTAKE, PREVIEW_BODY),
        JSON.stringify(candidates),
      ).rejects.toMatchObject({
        status: 400,
      });
      api.restore();
    }
  });

  // Break caught: an address the hub has no zone for told as a failure the officer can only answer by rewording the address (the officer who knows the zone cannot say it), or any other missing setting
  // taken for it.
  it('answers that no zone matches, as a result, when the address matches none, and refuses any other missing setting as a failure', async () => {
    api = installFakeApi({
      [`POST /hub-intakes/${INTAKE}/orders/preview`]: () => refusalOf('preview-zone-unresolved'),
    });
    // The refusal itself comes with it, so that a screen that cannot offer the zones tells it as it always did.
    expect(await previewOrder(client(), INTAKE, PREVIEW_BODY)).toMatchObject({
      kind: 'zone-unresolved',
      refusal: { status: 422, code: 'SETTING_MISSING', rule: 'destination_zone_unresolved' },
    });
    api.restore();
    const { status, body } = capturedRefusal('preview-zone-unresolved');
    api = installFakeApi({
      [`POST /hub-intakes/${INTAKE}/orders/preview`]: () =>
        json(status, { ...body, details: { rule: 'price_not_set' } }),
    });
    await expect(previewOrder(client(), INTAKE, PREVIEW_BODY)).rejects.toMatchObject({
      status: 422,
      code: 'SETTING_MISSING',
      rule: 'price_not_set',
    });
  });
});

describe('readDestinationZones (Run G1, D-S7-5)', () => {
  const ZONES = `GET /hub-intakes/${INTAKE}/destination-zones`;

  // Break caught: a read that sends a key, a version or a body (it changes nothing), or one that gives the zones as the API named them with more or less than their identifier and name.
  it('reads the hub’s zones by identifier and name, with no key, no version and no body', async () => {
    api = installFakeApi({ [ZONES]: () => json(200, captured('destination-zones')) });
    const zones = await readDestinationZones(client(), INTAKE);
    expect(last().method).toBe('GET');
    expect(last().headers.get('Idempotency-Key')).toBeNull();
    expect(last().headers.get('If-Match')).toBeNull();
    expect(zones.map((zone) => zone.name)).toEqual([
      'Accra Central',
      'Amasaman & Environs',
      'Dansoman',
      'Kasoa Corridor',
      'Lapaz/Sowutuom',
      'Madina/Adenta',
      'Tema',
    ]);
    for (const zone of zones) expect(Object.keys(zone).toSorted()).toEqual(['name', 'zone_id']);
  });

  // Break caught: an answer that is not the list (a body of another shape, a zone with no name) read as a hub with no zones, or as zones to choose from.
  it.each([
    ['a list that is not one', { items: 'Tema' }],
    ['no list', {}],
    ['a zone with no name', { items: [{ zone_id: '5eed0101-0000-4000-8000-000000000001' }] }],
    ['a zone that is not an identifier', { items: [{ zone_id: 'tema', name: 'Tema' }] }],
    [
      'the same zone twice',
      {
        items: [
          { zone_id: '5eed0101-0000-4000-8000-000000000001', name: 'Tema' },
          { zone_id: '5eed0101-0000-4000-8000-000000000001', name: 'Tema again' },
        ],
      },
    ],
  ])('reads %s as an answer that is not the API’s', async (_name, answer) => {
    api = installFakeApi({ [ZONES]: () => json(200, answer) });
    await expect(readDestinationZones(client(), INTAKE)).rejects.toMatchObject({
      kind: 'unexpected-response',
    });
  });

  // Break caught: a hub with no zone told as an unreadable answer, so that the officer is told nothing is wrong with the zones.
  it('reads a hub with no zone as an empty list', async () => {
    api = installFakeApi({ [ZONES]: () => json(200, { items: [] }) });
    expect(await readDestinationZones(client(), INTAKE)).toEqual([]);
  });

  // Break caught: a refusal of the read (no key, another hub) answered as zones, or as an empty list.
  it('fails with the refusal when the read is refused', async () => {
    api = installFakeApi({
      [ZONES]: () =>
        json(403, { code: 'PERMISSION_DENIED', message: 'x', request_id: 'r1', details: {} }),
    });
    await expect(readDestinationZones(client(), INTAKE)).rejects.toMatchObject({
      status: 403,
      code: 'PERMISSION_DENIED',
    });
  });
});

describe('itemizeOrder', () => {
  const saved = captured('order-saved');
  const savedIntake = (saved.pickup_intake_id ?? INTAKE) as string;

  it('posts under a key and the version of the vendor, on the digest of the terms read, and answers the order and its version', async () => {
    api = installFakeApi({
      [`POST /hub-intakes/${savedIntake}/orders`]: () => json(201, saved, { ETag: '"o-1"' }),
    });
    const outcome = await itemizeOrder(client(), savedIntake, BODY, VERSION, KEY);
    expect(last().method).toBe('POST');
    expect(last().headers.get('Idempotency-Key')).toBe(KEY);
    expect(last().headers.get('If-Match')).toBe(VERSION);
    expect(await bodyOf()).toEqual(BODY);
    expect(outcome.kind).toBe('saved');
    if (outcome.kind === 'saved') {
      expect(outcome.order.code).toBe(saved.code);
      expect(outcome.version).toBe('"o-1"');
    }
  });

  // Break caught: a save whose terms changed told as a failure that loses the officer's work, or a price confirmed that was not the one read.
  it('answers the terms as they are now, as a result, when they are not the terms that were read', async () => {
    api = installFakeApi({
      [`POST /hub-intakes/${savedIntake}/orders`]: () => refusalOf('save-terms-changed'),
    });
    const outcome = await itemizeOrder(client(), savedIntake, BODY, VERSION, KEY);
    expect(outcome.kind).toBe('terms-changed');
    if (outcome.kind === 'terms-changed') expect(outcome.current.total.amount_minor).toBe(3500);
  });

  // Break caught: a save that meets an address no zone matches now (the hub's aliases moved since the check) told as a failure that loses the officer's work, instead of the offer of the zones.
  it('answers that no zone matches, as a result, when the save meets an address that matches none', async () => {
    const { status, body } = capturedRefusal('preview-zone-unresolved');
    api = installFakeApi({
      [`POST /hub-intakes/${savedIntake}/orders`]: () => json(status, body),
    });
    expect(await itemizeOrder(client(), savedIntake, BODY, VERSION, KEY)).toMatchObject({
      kind: 'zone-unresolved',
      refusal: { rule: 'destination_zone_unresolved' },
    });
  });

  // Break caught: a refusal that says the terms changed and does not give them taken as a result with nothing to read.
  it('refuses, as a failure, a changed-terms answer that does not give the terms', async () => {
    const { status, body } = capturedRefusal('save-terms-changed');
    api = installFakeApi({
      [`POST /hub-intakes/${savedIntake}/orders`]: () =>
        json(status, { ...body, details: { rule: 'terms_changed' } }),
    });
    await expect(itemizeOrder(client(), savedIntake, BODY, VERSION, KEY)).rejects.toMatchObject({
      status: 409,
      rule: 'terms_changed',
    });
  });

  it('refuses any other conflict, with its rule and nothing else of its details', async () => {
    api = installFakeApi({
      [`POST /hub-intakes/${savedIntake}/orders`]: () =>
        json(409, {
          code: 'STATE_CONFLICT',
          message: 'Diagnostic text',
          request_id: 'r1',
          details: { rule: 'stale', secret: 'must not be read' },
        }),
    });
    const failure = await itemizeOrder(client(), savedIntake, BODY, VERSION, KEY).catch(
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ status: 409, rule: 'stale' });
    expect(JSON.stringify(failure)).not.toContain('must not be read');
  });

  // Break caught: a success with a body that is not an order read as the order made (the officer would be told it was saved).
  it('reads a success that is not an order as an answer that is not the API’s', async () => {
    api = installFakeApi({
      [`POST /hub-intakes/${savedIntake}/orders`]: () => json(201, { id: 'x' }),
    });
    await expect(itemizeOrder(client(), savedIntake, BODY, VERSION, KEY)).rejects.toMatchObject({
      kind: 'unexpected-response',
    });
  });
});

describe('previewOrderAmendment and amendOrder', () => {
  const amendPreview = captured('amend-preview');
  const amendSaved = captured('amend-saved');
  const orderId = amendSaved.id as string;
  const intakeId = amendPreview.intake_id as string;
  const PATCH: AmendSaveBody = {
    size_class: 'MEDIUM',
    note: 'Bigger than it looked',
    reviewed_terms: 'b'.repeat(64),
  };

  it('posts the patch to the preview with no key, no version and no reason', async () => {
    api = installFakeApi({
      [`POST /orders/${orderId}/amendment-preview`]: () => json(200, amendPreview),
    });
    const outcome = await previewOrderAmendment(client(), orderId, intakeId, {
      size_class: 'MEDIUM',
    });
    expect(last().headers.get('Idempotency-Key')).toBeNull();
    expect(last().headers.get('If-Match')).toBeNull();
    expect(await bodyOf()).toEqual({ size_class: 'MEDIUM' });
    expect(outcome.kind).toBe('terms');
  });

  it('patches under a key and the version of the order, with the reason and the digest of the terms read', async () => {
    api = installFakeApi({
      [`PATCH /orders/${orderId}`]: () => json(200, amendSaved, { ETag: '"o-2"' }),
    });
    const outcome = await amendOrder(client(), orderId, PATCH, VERSION, KEY);
    expect(last().method).toBe('PATCH');
    expect(last().headers.get('Idempotency-Key')).toBe(KEY);
    expect(last().headers.get('If-Match')).toBe(VERSION);
    expect(await bodyOf()).toEqual(PATCH);
    expect(outcome).toMatchObject({ kind: 'saved', version: '"o-2"' });
  });

  it('answers the terms as they are now when they are not the terms that were read', async () => {
    api = installFakeApi({ [`PATCH /orders/${orderId}`]: () => refusalOf('save-terms-changed') });
    const outcome = await amendOrder(client(), orderId, PATCH, VERSION, KEY);
    expect(outcome.kind).toBe('terms-changed');
  });

  // Break caught: the change of an address to one no zone matches told as a failure the officer can only answer by rewording it, on the preview or on the save.
  it('answers that no zone matches, as a result, for a change of address, on the preview and on the save', async () => {
    api = installFakeApi({
      [`POST /orders/${orderId}/amendment-preview`]: () => refusalOf('preview-zone-unresolved'),
      [`PATCH /orders/${orderId}`]: () => refusalOf('preview-zone-unresolved'),
    });
    expect(
      await previewOrderAmendment(client(), orderId, intakeId, { size_class: 'MEDIUM' }),
    ).toMatchObject({ kind: 'zone-unresolved', refusal: { rule: 'destination_zone_unresolved' } });
    expect(await amendOrder(client(), orderId, PATCH, VERSION, KEY)).toMatchObject({
      kind: 'zone-unresolved',
      refusal: { rule: 'destination_zone_unresolved' },
    });
  });
});

describe('reverseOrderArrival', () => {
  const reversal = captured('reversal');
  const orderId = reversal.order_id as string;

  it('posts the reason under a key and the version of the order, and answers what the reversal did', async () => {
    api = installFakeApi({
      [`POST /orders/${orderId}/arrival-reversal`]: () => json(200, reversal),
    });
    const done = await reverseOrderArrival(client(), orderId, 'Not on the table', VERSION, KEY);
    expect(last().headers.get('Idempotency-Key')).toBe(KEY);
    expect(last().headers.get('If-Match')).toBe(VERSION);
    expect(await bodyOf()).toEqual({ note: 'Not on the table' });
    expect(done.received_before).toBe(3);
    expect(done.received_after).toBe(2);
    expect(done.parcel_state).toBe('MISSING');
  });

  // Break caught: the reversal of another order read as this one's (the page would say it took back an arrival it did not).
  it('reads the reversal of another order as an answer that is not the API’s', async () => {
    api = installFakeApi({
      [`POST /orders/${OTHER_ID}/arrival-reversal`]: () => json(200, reversal),
    });
    await expect(reverseOrderArrival(client(), OTHER_ID, 'x', VERSION, KEY)).rejects.toMatchObject({
      kind: 'unexpected-response',
    });
  });
});

describe('setParcelWaiting (Run G1, D-S7-12)', () => {
  const PARCEL = 'a1a1a1a1-2222-4333-8444-555555555555';
  const AT = '2026-11-24T10:30:00.000Z';
  const route = `PUT /intake-parcels/${PARCEL}/waiting-for-vendor`;

  // Break caught: a mark that sends a key (it is idempotent by nature and takes none), or no version (the vendor's token is the one it takes), a note that is sent when there is none, a body that is not the
  // desired state, or the unmark that sends a note.
  it('puts the desired state on the vendor’s version, with the note only when there is one, and no key', async () => {
    api = installFakeApi({
      [route]: () =>
        json(200, { parcel_id: PARCEL, waiting: true, since: AT, note: 'Called the vendor' }),
    });
    const marked = await setParcelWaiting(client(), PARCEL, true, 'Called the vendor', VERSION);
    expect(last().method).toBe('PUT');
    expect(last().headers.get('If-Match')).toBe(VERSION);
    expect(last().headers.get('Idempotency-Key')).toBeNull();
    expect(await bodyOf()).toEqual({ waiting: true, note: 'Called the vendor' });
    expect(marked).toEqual({
      parcel_id: PARCEL,
      waiting: true,
      since: AT,
      note: 'Called the vendor',
    });

    api.restore();
    api = installFakeApi({
      [route]: () => json(200, { parcel_id: PARCEL, waiting: true, since: AT, note: null }),
    });
    await setParcelWaiting(client(), PARCEL, true, undefined, VERSION);
    expect(await bodyOf()).toEqual({ waiting: true });

    api.restore();
    api = installFakeApi({
      [route]: () => json(200, { parcel_id: PARCEL, waiting: false, since: null, note: null }),
    });
    const off = await setParcelWaiting(client(), PARCEL, false, 'ignored', VERSION);
    expect(await bodyOf()).toEqual({ waiting: false });
    expect(off.waiting).toBe(false);
  });

  // Break caught: an answer for another parcel, one that says the opposite of what was asked, or one that is not a mark, read as the act done.
  it.each([
    ['another parcel', { parcel_id: OTHER_ID, waiting: true, since: AT, note: null }],
    ['the opposite state', { parcel_id: PARCEL, waiting: false, since: null, note: null }],
    ['a mark with no moment', { parcel_id: PARCEL, waiting: true, since: null, note: null }],
    ['a note that is not text', { parcel_id: PARCEL, waiting: true, since: AT, note: 5 }],
    ['nothing of a mark', { ok: true }],
  ])('reads %s as an answer that is not the API’s', async (_name, body) => {
    api = installFakeApi({ [route]: () => json(200, body) });
    await expect(
      setParcelWaiting(client(), PARCEL, true, undefined, VERSION),
    ).rejects.toMatchObject({
      kind: 'unexpected-response',
    });
  });
});

describe('closeIntake', () => {
  const parity = captured('close-parity');
  const exception = captured('close-exception');
  const TOKEN = 'c'.repeat(64);

  it('posts the assessment that was read, and nothing else, for a close that has parity', async () => {
    const id = parity.id as string;
    api = installFakeApi({
      [`POST /hub-intakes/${id}/close`]: () => json(200, parity, { ETag: '"v-4"' }),
    });
    const outcome = await closeIntake(client(), id, { reviewedAssessment: TOKEN }, VERSION, KEY);
    expect(last().headers.get('Idempotency-Key')).toBe(KEY);
    expect(last().headers.get('If-Match')).toBe(VERSION);
    expect(await bodyOf()).toEqual({ reviewed_assessment: TOKEN });
    expect(outcome).toEqual({ kind: 'closed' });
  });

  // Break caught: an exception sent without the assessment it is written for, or with a reason that is not the officer's.
  it('posts the reason with the assessment it is written for, for the approved exception', async () => {
    const id = exception.id as string;
    api = installFakeApi({
      [`POST /hub-intakes/${id}/close`]: () => json(200, exception, { ETag: '"v-4"' }),
    });
    await closeIntake(
      client(),
      id,
      { reviewedAssessment: TOKEN, exceptionNote: 'One parcel is on the rider’s bike' },
      VERSION,
      KEY,
    );
    expect(await bodyOf()).toEqual({
      reviewed_assessment: TOKEN,
      parity_exception: { note: 'One parcel is on the rider’s bike' },
    });
  });

  // Break caught: a close whose assessment changed told as a failure (the senior would write the reason again for nothing) or closed on a finding the senior did not read.
  it('answers the assessment as it is now, and closes nothing, when it is not the one that was read', async () => {
    const changed = capturedRefusal('close-assessment-changed');
    const current = (
      changed.body.details as {
        current_assessment: { intake_id: string; assessment_token: string };
      }
    ).current_assessment;
    api = installFakeApi({
      [`POST /hub-intakes/${current.intake_id}/close`]: () => json(changed.status, changed.body),
    });
    const outcome = await closeIntake(
      client(),
      current.intake_id,
      { reviewedAssessment: TOKEN },
      VERSION,
      KEY,
    );
    expect(outcome.kind).toBe('assessment-changed');
    // The senior reads the assessment as it is now: its digest is the one the API gave, and the next close is written for it.
    if (outcome.kind === 'assessment-changed')
      expect(outcome.current.assessment_token).toBe(current.assessment_token);
  });

  it('refuses an assessment that is for another vendor, as a failure', async () => {
    const changed = capturedRefusal('close-assessment-changed');
    api = installFakeApi({
      [`POST /hub-intakes/${OTHER_ID}/close`]: () => json(changed.status, changed.body),
    });
    await expect(
      closeIntake(client(), OTHER_ID, { reviewedAssessment: TOKEN }, VERSION, KEY),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('reads a close of another vendor as an answer that is not the API’s', async () => {
    api = installFakeApi({
      [`POST /hub-intakes/${OTHER_ID}/close`]: () => json(200, parity, { ETag: '"v-4"' }),
    });
    await expect(
      closeIntake(client(), OTHER_ID, { reviewedAssessment: TOKEN }, VERSION, KEY),
    ).rejects.toMatchObject({ kind: 'unexpected-response' });
  });
});

describe('requestPayerCorrection and decidePayerCorrection', () => {
  const requested = correctionOf() as { id: string; order_id: string };

  it('posts the proposal, never a portion, and the reason, under a key and the version of the order', async () => {
    api = installFakeApi({
      [`POST /orders/${requested.order_id}/payer-correction`]: () =>
        json(201, requested, { ETag: '"c-1"' }),
    });
    const made = await requestPayerCorrection(
      client(),
      requested.order_id,
      { payer_intent: 'SENDER_PAYS_FULL' },
      'The vendor will pay',
      VERSION,
      KEY,
    );
    expect(last().headers.get('Idempotency-Key')).toBe(KEY);
    expect(last().headers.get('If-Match')).toBe(VERSION);
    expect(await bodyOf()).toEqual({
      proposed: { payer_intent: 'SENDER_PAYS_FULL' },
      note: 'The vendor will pay',
    });
    expect(made.version).toBe('"c-1"');
    expect(made.correction.id).toBe(requested.id);
  });

  // Break caught: a request made without the version of the correction in the answer (the decision that follows could not be made on it), or one for another order.
  it('reads a correction with no version, or for another order, as an answer that is not the API’s', async () => {
    api = installFakeApi({
      [`POST /orders/${requested.order_id}/payer-correction`]: () => json(201, requested),
    });
    await expect(
      requestPayerCorrection(
        client(),
        requested.order_id,
        { payer_intent: 'SENDER_PAYS_FULL' },
        'x',
        VERSION,
        KEY,
      ),
    ).rejects.toMatchObject({
      kind: 'unexpected-response',
    });
    api.restore();
    api = installFakeApi({
      [`POST /orders/${OTHER_ID}/payer-correction`]: () => json(201, requested, { ETag: '"c-1"' }),
    });
    await expect(
      requestPayerCorrection(
        client(),
        OTHER_ID,
        { payer_intent: 'SENDER_PAYS_FULL' },
        'x',
        VERSION,
        KEY,
      ),
    ).rejects.toMatchObject({
      kind: 'unexpected-response',
    });
  });

  it('posts the decision, with a note only when one was written, on the version of the correction', async () => {
    api = installFakeApi({
      [`POST /payer-corrections/${requested.id}/decision`]: () =>
        json(200, requested, { ETag: '"c-2"' }),
    });
    await decidePayerCorrection(client(), requested.id, 'REJECT', undefined, '"c-1"', KEY);
    expect(last().headers.get('If-Match')).toBe('"c-1"');
    expect(last().headers.get('Idempotency-Key')).toBe(KEY);
    expect(await bodyOf()).toEqual({ decision: 'REJECT' });
    await decidePayerCorrection(client(), requested.id, 'APPROVE', 'Agreed', '"c-1"', KEY);
    expect(await bodyOf()).toEqual({ decision: 'APPROVE', note: 'Agreed' });
  });

  it('reads the decision of another correction as an answer that is not the API’s', async () => {
    api = installFakeApi({
      [`POST /payer-corrections/${OTHER_ID}/decision`]: () =>
        json(200, requested, { ETag: '"c-2"' }),
    });
    await expect(
      decidePayerCorrection(client(), OTHER_ID, 'APPROVE', undefined, '"c-1"', KEY),
    ).rejects.toMatchObject({ kind: 'unexpected-response' });
  });
});
