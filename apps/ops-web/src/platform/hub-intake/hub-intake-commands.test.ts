import { createBrowserApiClient } from '@melarc/api-client/browser';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { installFakeApi, json, type FakeApi } from '../../test-support/fake-api';
import {
  DECLARED,
  PLANTED_DECLARATION,
  INTAKE_EVIDENCE_ONE,
  INTAKE_ID,
  OTHER_INTAKE_ID,
  findingFixture,
  postCountFixture,
  preCountFixture,
  shortCountFixture,
} from '../../test-support/hub-intake-fixture';
import {
  acquireIntakeLock,
  adjudicateDiscrepancy,
  recordIntakeCondition,
  submitBlindCount,
} from './hub-intake-commands';

/**
 * The wire shape of the four acts of the receiving screens (S1.35), read from the requests the real client puts on the wire: the method, the path, the headers each operation declares and no other,
 * and the body in the contract's names. **The body of the count is the physical count and nothing else.** What each act answers is judged: an answer for another intake, one that is not counted, or one
 * that counts another number, is an answer that is not the API's, which a confirmed command reads as an outcome that is not known.
 */
const KEY = 'key-0001';
const VERSION = '"v3"';
const NEW_VERSION = '"v4"';

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
const withVersion = (body: unknown): Response => json(200, body, { ETag: NEW_VERSION });

describe('acquireIntakeLock', () => {
  it('posts to the lock with no body, no key and no version, and answers the intake as the server shows it', async () => {
    api = installFakeApi({
      [`POST /hub-intakes/${INTAKE_ID}/lock`]: () =>
        json(
          200,
          preCountFixture({
            active_receiver_id: OTHER_INTAKE_ID,
            lock_acquired_at: '2026-11-14T09:10:00Z',
          }),
        ),
    });

    const intake = await acquireIntakeLock(client(), INTAKE_ID);

    expect(last().method).toBe('POST');
    expect(new URL(last().url).pathname).toBe(`/api/v1/hub-intakes/${INTAKE_ID}/lock`);
    expect(last().headers.get('Idempotency-Key')).toBeNull();
    expect(last().headers.get('If-Match')).toBeNull();
    expect(await last().clone().text()).toBe('');
    expect(intake).toMatchObject({ count_phase: 'PRE_COUNT', active_receiver_id: OTHER_INTAKE_ID });
  });

  // Break caught: the lock of one intake taken as the lock of the one asked about, so that the page says who holds an intake it is not counting.
  it('reads an answer for another intake as an answer that is not the API’s', async () => {
    api = installFakeApi({
      [`POST /hub-intakes/${INTAKE_ID}/lock`]: () =>
        json(200, preCountFixture({ id: OTHER_INTAKE_ID })),
    });
    await expect(acquireIntakeLock(client(), INTAKE_ID)).rejects.toMatchObject({
      kind: 'unexpected-response',
    });
  });

  // Break caught: the declaration let through on the answer of the lock, the one write whose answer is an intake that may be counted or not.
  it('refuses an answer that has not been counted and carries the declaration', async () => {
    api = installFakeApi({
      [`POST /hub-intakes/${INTAKE_ID}/lock`]: () =>
        json(200, { ...preCountFixture(), rider_declared_count: PLANTED_DECLARATION }),
    });
    await expect(acquireIntakeLock(client(), INTAKE_ID)).rejects.toMatchObject({
      kind: 'unexpected-response',
    });
  });

  it('answers an intake that has been counted as it is', async () => {
    api = installFakeApi({
      [`POST /hub-intakes/${INTAKE_ID}/lock`]: () => json(200, postCountFixture()),
    });
    await expect(acquireIntakeLock(client(), INTAKE_ID)).resolves.toMatchObject({
      count_phase: 'POST_COUNT',
    });
  });
});

describe('submitBlindCount', () => {
  it('posts the physical count and nothing else, under a key and the version read', async () => {
    api = installFakeApi({
      [`POST /hub-intakes/${INTAKE_ID}/count`]: () =>
        withVersion(shortCountFixture({ physical_count: 5, count_difference: -2 })),
    });

    const counted = await submitBlindCount(client(), INTAKE_ID, 5, VERSION, KEY);

    expect(last().headers.get('Idempotency-Key')).toBe(KEY);
    expect(last().headers.get('If-Match')).toBe(VERSION);
    // Break caught: anything but the count in the body: the contract's schema is closed and a declaration in it is refused, and a page has none to send.
    expect(await bodyOf()).toEqual({ physical_count: 5 });
    expect(Object.keys((await bodyOf()) as object)).toEqual(['physical_count']);
    expect(counted.version).toBe(NEW_VERSION);
    expect(counted.intake).toMatchObject({
      rider_declared_count: DECLARED,
      physical_count: 5,
      count_variance: 'SHORT',
    });
  });

  it('sends a count of zero as zero', async () => {
    api = installFakeApi({
      [`POST /hub-intakes/${INTAKE_ID}/count`]: () =>
        withVersion(
          postCountFixture({
            rider_declared_count: 0,
            physical_count: 0,
            count_difference: 0,
            state: 'RECONCILIATION_REQUIRED',
          }),
        ),
    });
    await submitBlindCount(client(), INTAKE_ID, 0, VERSION, KEY);
    expect(await bodyOf()).toEqual({ physical_count: 0 });
  });

  // Break caught: an act taken as done when the answer counts another number or another intake, or carries no version to act on next.
  it.each([
    [
      'another intake',
      () =>
        withVersion(
          shortCountFixture({ id: OTHER_INTAKE_ID, physical_count: 5, count_difference: -2 }),
        ),
    ],
    [
      'another number',
      () => withVersion(shortCountFixture({ physical_count: 4, count_difference: -3 })),
    ],
    ['an intake that was not counted', () => withVersion(preCountFixture())],
    ['no version', () => json(200, shortCountFixture({ physical_count: 5, count_difference: -2 }))],
    ['a body that is not an intake', () => withVersion({ ok: true })],
  ])('reads an answer with %s as an answer that is not the API’s', async (_name, answer) => {
    api = installFakeApi({ [`POST /hub-intakes/${INTAKE_ID}/count`]: answer });
    await expect(submitBlindCount(client(), INTAKE_ID, 5, VERSION, KEY)).rejects.toMatchObject({
      kind: 'unexpected-response',
    });
  });
});

describe('recordIntakeCondition', () => {
  const answer = (condition: 'OK' | 'DAMAGED' | 'TAMPERED' | 'OTHER') =>
    withVersion(
      postCountFixture({
        condition,
        state: 'RECONCILIATION_REQUIRED',
        condition_findings: [findingFixture({ condition })],
      }),
    );

  it('posts the condition, the note and the evidence under a key and the version read', async () => {
    api = installFakeApi({ [`POST /hub-intakes/${INTAKE_ID}/condition`]: () => answer('DAMAGED') });

    const recorded = await recordIntakeCondition(
      client(),
      INTAKE_ID,
      { condition: 'DAMAGED', note: 'Crushed.', evidenceIds: [INTAKE_EVIDENCE_ONE] },
      VERSION,
      KEY,
    );

    expect(last().headers.get('Idempotency-Key')).toBe(KEY);
    expect(last().headers.get('If-Match')).toBe(VERSION);
    expect(await bodyOf()).toEqual({
      condition: 'DAMAGED',
      note: 'Crushed.',
      evidence_ids: [INTAKE_EVIDENCE_ONE],
    });
    expect(recorded.intake.condition).toBe('DAMAGED');
    expect(recorded.version).toBe(NEW_VERSION);
  });

  it('leaves out a note and evidence that were not given, and an empty list of evidence', async () => {
    api = installFakeApi({ [`POST /hub-intakes/${INTAKE_ID}/condition`]: () => answer('OK') });
    await recordIntakeCondition(
      client(),
      INTAKE_ID,
      { condition: 'OK', evidenceIds: [] },
      VERSION,
      KEY,
    );
    expect(await bodyOf()).toEqual({ condition: 'OK' });
  });

  // Break caught: a condition taken as recorded when the answer says the intake has another: the page would tell an officer that damage was recorded that the server did not keep.
  it('reads an answer with another condition than the one recorded as an answer that is not the API’s', async () => {
    api = installFakeApi({ [`POST /hub-intakes/${INTAKE_ID}/condition`]: () => answer('OTHER') });
    await expect(
      recordIntakeCondition(
        client(),
        INTAKE_ID,
        { condition: 'DAMAGED', evidenceIds: [INTAKE_EVIDENCE_ONE] },
        VERSION,
        KEY,
      ),
    ).rejects.toMatchObject({ kind: 'unexpected-response' });
  });

  it('takes an OK recording that changes nothing, whatever the condition of the intake was', async () => {
    api = installFakeApi({ [`POST /hub-intakes/${INTAKE_ID}/condition`]: () => answer('DAMAGED') });
    await expect(
      recordIntakeCondition(client(), INTAKE_ID, { condition: 'OK' }, VERSION, KEY),
    ).resolves.toBeDefined();
  });

  it('reads an answer for another intake, or without a version, as an answer that is not the API’s', async () => {
    api = installFakeApi({
      [`POST /hub-intakes/${INTAKE_ID}/condition`]: () =>
        withVersion(
          postCountFixture({
            id: OTHER_INTAKE_ID,
            condition: 'DAMAGED',
            state: 'RECONCILIATION_REQUIRED',
          }),
        ),
    });
    await expect(
      recordIntakeCondition(
        client(),
        INTAKE_ID,
        { condition: 'DAMAGED', evidenceIds: [INTAKE_EVIDENCE_ONE] },
        VERSION,
        KEY,
      ),
    ).rejects.toMatchObject({ kind: 'unexpected-response' });
    api.restore();

    api = installFakeApi({
      [`POST /hub-intakes/${INTAKE_ID}/condition`]: () =>
        json(200, postCountFixture({ condition: 'DAMAGED', state: 'RECONCILIATION_REQUIRED' })),
    });
    await expect(
      recordIntakeCondition(
        client(),
        INTAKE_ID,
        { condition: 'DAMAGED', evidenceIds: [INTAKE_EVIDENCE_ONE] },
        VERSION,
        KEY,
      ),
    ).rejects.toMatchObject({ kind: 'unexpected-response' });
  });
});

describe('adjudicateDiscrepancy', () => {
  it('posts the outcome and the reason under the version read and no key', async () => {
    api = installFakeApi({
      [`POST /hub-intakes/${INTAKE_ID}/discrepancy`]: () =>
        withVersion(shortCountFixture({ state: 'READY_FOR_ITEMIZATION' })),
    });

    const adjudicated = await adjudicateDiscrepancy(
      client(),
      INTAKE_ID,
      { outcome: 'WRITTEN_OFF', note: 'Two parcels lost at the door.' },
      VERSION,
    );

    expect(last().headers.get('If-Match')).toBe(VERSION);
    // Break caught: a key sent where the operation declares none, or a version left off the one that needs it.
    expect(last().headers.get('Idempotency-Key')).toBeNull();
    expect(await bodyOf()).toEqual({
      outcome: 'WRITTEN_OFF',
      note: 'Two parcels lost at the door.',
    });
    expect(adjudicated.version).toBe(NEW_VERSION);
  });

  it('sends the condition and the evidence when the adjudicator found one', async () => {
    api = installFakeApi({
      [`POST /hub-intakes/${INTAKE_ID}/discrepancy`]: () =>
        withVersion(shortCountFixture({ condition: 'TAMPERED', state: 'RECONCILIATION_REQUIRED' })),
    });
    await adjudicateDiscrepancy(
      client(),
      INTAKE_ID,
      {
        outcome: 'ESCALATED',
        note: 'Seal broken.',
        condition: 'TAMPERED',
        evidenceIds: [INTAKE_EVIDENCE_ONE],
      },
      VERSION,
    );
    expect(await bodyOf()).toEqual({
      outcome: 'ESCALATED',
      note: 'Seal broken.',
      condition: 'TAMPERED',
      evidence_ids: [INTAKE_EVIDENCE_ONE],
    });
  });

  // Break caught: an adjudication taken as done when the answer says the intake has another condition than the one the adjudicator set, or is not the intake acted on.
  it.each([
    ['another condition', () => withVersion(shortCountFixture({ condition: 'OK' }))],
    [
      'another intake',
      () => withVersion(shortCountFixture({ id: OTHER_INTAKE_ID, condition: 'TAMPERED' })),
    ],
    ['an intake that was not counted', () => withVersion(preCountFixture())],
    ['no version', () => json(200, shortCountFixture({ condition: 'TAMPERED' }))],
  ])('reads an answer with %s as an answer that is not the API’s', async (_name, answer) => {
    api = installFakeApi({ [`POST /hub-intakes/${INTAKE_ID}/discrepancy`]: answer });
    await expect(
      adjudicateDiscrepancy(
        client(),
        INTAKE_ID,
        {
          outcome: 'ESCALATED',
          note: 'Seal broken.',
          condition: 'TAMPERED',
          evidenceIds: [INTAKE_EVIDENCE_ONE],
        },
        VERSION,
      ),
    ).rejects.toMatchObject({ kind: 'unexpected-response' });
  });
});
