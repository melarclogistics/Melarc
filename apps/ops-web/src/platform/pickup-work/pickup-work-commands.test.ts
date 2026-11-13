import { ApiError, createBrowserApiClient } from '@melarc/api-client/browser';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { errorResponse, installFakeApi, json, type FakeApi } from '../../test-support/fake-api';
import {
  WORK_EVIDENCE_ID,
  WORK_OTHER_STOP_ID,
  WORK_STOP_ID,
  exceptionFixture,
  handshakeFixture,
} from '../../test-support/pickup-work-fixture';
import {
  authoriseHandshakeOverride,
  authoriseParcelPhotoException,
  createRetrievalAuthorization,
  resolveHandshake,
} from './pickup-work-commands';

/**
 * The wire shape of the three acts of the screens of the door (S1.30) and of the one read that is a `POST`, read from the requests the real client puts on the wire: the method, the path,
 * the headers each operation declares and no other, and the body in the contract's names. What each act answers is judged: an answer for another stop, or one that is not the contract's,
 * is an answer that is not the API's, which a confirmed command reads as an outcome that is not known.
 */
const KEY = 'key-0001';
const NOTE = 'Called the vendor on a number the office holds.';

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
const calls = () => api.requests.filter((request) => request.url.includes('/pickup-stops/'));

describe('authoriseHandshakeOverride', () => {
  it('posts the note as the verification note, under a key and no version', async () => {
    api = installFakeApi({
      [`POST /pickup-stops/${WORK_STOP_ID}/handshake/ops-override`]: () =>
        json(200, handshakeFixture()),
    });

    const handshake = await authoriseHandshakeOverride(client(), WORK_STOP_ID, NOTE, KEY);

    expect(last().method).toBe('POST');
    expect(last().headers.get('Idempotency-Key')).toBe(KEY);
    expect(last().headers.get('If-Match')).toBeNull();
    expect(await bodyOf()).toEqual({ verification_note: NOTE });
    expect(handshake).toMatchObject({
      stop_id: WORK_STOP_ID,
      state: 'MANUALLY_RESOLVED',
      channel: 'OPS_OVERRIDE',
    });
  });

  // Break caught: an override taken as done when the answer is for another stop (the page would tell an officer that a stop they did not touch was settled).
  it('reads an answer for another stop as an answer that is not the API’s', async () => {
    api = installFakeApi({
      [`POST /pickup-stops/${WORK_STOP_ID}/handshake/ops-override`]: () =>
        json(200, handshakeFixture({ stop_id: WORK_OTHER_STOP_ID })),
    });

    await expect(
      authoriseHandshakeOverride(client(), WORK_STOP_ID, NOTE, KEY),
    ).rejects.toMatchObject({
      kind: 'unexpected-response',
    });
  });

  it('reads the same stop in other letters as the same stop', async () => {
    api = installFakeApi({
      [`POST /pickup-stops/${WORK_STOP_ID}/handshake/ops-override`]: () =>
        json(200, handshakeFixture({ stop_id: WORK_STOP_ID.toUpperCase() })),
    });

    await expect(
      authoriseHandshakeOverride(client(), WORK_STOP_ID, NOTE, KEY),
    ).resolves.toBeDefined();
  });

  // Break caught: an answer that is not a handshake taken as one (a proxy's page with a success status).
  it('reads a body that is not a handshake as an answer that is not the API’s', async () => {
    api = installFakeApi({
      [`POST /pickup-stops/${WORK_STOP_ID}/handshake/ops-override`]: () =>
        json(200, { stop_id: WORK_STOP_ID, state: 'LOST', direction: 'SIDEWAYS' }),
    });

    await expect(
      authoriseHandshakeOverride(client(), WORK_STOP_ID, NOTE, KEY),
    ).rejects.toMatchObject({
      kind: 'unexpected-response',
    });
  });

  it('carries a refusal as the API told it, with its code', async () => {
    api = installFakeApi({
      [`POST /pickup-stops/${WORK_STOP_ID}/handshake/ops-override`]: () =>
        errorResponse(409, 'STATE_CONFLICT', { rule: 'stop_not_arrived' }),
    });

    await expect(
      authoriseHandshakeOverride(client(), WORK_STOP_ID, NOTE, KEY),
    ).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
      rule: 'stop_not_arrived',
    });
  });
});

describe('resolveHandshake', () => {
  it('posts the note alone, under a key and no version, and sends no evidence', async () => {
    api = installFakeApi({
      [`POST /pickup-stops/${WORK_STOP_ID}/handshake/resolve`]: () =>
        json(200, handshakeFixture({ channel: null })),
    });

    const handshake = await resolveHandshake(client(), WORK_STOP_ID, NOTE, KEY);

    expect(last().headers.get('Idempotency-Key')).toBe(KEY);
    expect(last().headers.get('If-Match')).toBeNull();
    expect(await bodyOf()).toEqual({ note: NOTE });
    expect(handshake.state).toBe('MANUALLY_RESOLVED');
    expect(handshake.channel).toBeNull();
  });

  // Break caught: a resolution taken as done when it is the answer of another stop.
  it('reads an answer for another stop as an answer that is not the API’s', async () => {
    api = installFakeApi({
      [`POST /pickup-stops/${WORK_STOP_ID}/handshake/resolve`]: () =>
        json(200, handshakeFixture({ stop_id: WORK_OTHER_STOP_ID })),
    });

    await expect(resolveHandshake(client(), WORK_STOP_ID, NOTE, KEY)).rejects.toBeInstanceOf(
      ApiError,
    );
  });

  it('carries a refusal as the API told it', async () => {
    api = installFakeApi({
      [`POST /pickup-stops/${WORK_STOP_ID}/handshake/resolve`]: () =>
        errorResponse(409, 'STATE_CONFLICT', { rule: 'code_live' }),
    });

    await expect(resolveHandshake(client(), WORK_STOP_ID, NOTE, KEY)).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
      rule: 'code_live',
    });
  });
});

describe('authoriseParcelPhotoException', () => {
  it('posts the note alone, under a key and no version, and answers with the exception', async () => {
    api = installFakeApi({
      [`POST /pickup-stops/${WORK_STOP_ID}/parcel-photo-exception`]: () =>
        json(201, exceptionFixture({ note: NOTE })),
    });

    const exception = await authoriseParcelPhotoException(client(), WORK_STOP_ID, NOTE, KEY);

    expect(last().headers.get('Idempotency-Key')).toBe(KEY);
    expect(last().headers.get('If-Match')).toBeNull();
    expect(await bodyOf()).toEqual({ note: NOTE });
    expect(exception).toMatchObject({ pickup_stop_id: WORK_STOP_ID, note: NOTE });
  });

  // Break caught: an exception taken as made for the stop when the answer is the exception of another stop.
  it('reads an exception of another stop as an answer that is not the API’s', async () => {
    api = installFakeApi({
      [`POST /pickup-stops/${WORK_STOP_ID}/parcel-photo-exception`]: () =>
        json(201, exceptionFixture({ pickup_stop_id: WORK_OTHER_STOP_ID })),
    });

    await expect(
      authoriseParcelPhotoException(client(), WORK_STOP_ID, NOTE, KEY),
    ).rejects.toMatchObject({ kind: 'unexpected-response' });
  });

  it('carries a refusal that names its rule', async () => {
    api = installFakeApi({
      [`POST /pickup-stops/${WORK_STOP_ID}/parcel-photo-exception`]: () =>
        errorResponse(409, 'STATE_CONFLICT', { rule: 'collection_recorded' }),
    });

    await expect(
      authoriseParcelPhotoException(client(), WORK_STOP_ID, NOTE, KEY),
    ).rejects.toMatchObject({ code: 'STATE_CONFLICT', rule: 'collection_recorded' });
    expect(calls()).toHaveLength(1);
  });
});

describe('createRetrievalAuthorization', () => {
  const authorization = {
    method: 'GET',
    url: 'https://store.example/evidence/abc?token=t',
    expires_at: '2026-11-04T09:36:00Z',
  };

  it('posts nothing but the identifier of the photo: no body, no key, no version', async () => {
    api = installFakeApi({
      [`POST /evidence/${WORK_EVIDENCE_ID}/retrieval-authorization`]: () =>
        json(200, authorization),
    });

    const answer = await createRetrievalAuthorization(client(), WORK_EVIDENCE_ID);

    expect(last().method).toBe('POST');
    expect(last().headers.get('Idempotency-Key')).toBeNull();
    expect(last().headers.get('If-Match')).toBeNull();
    expect(await last().clone().text()).toBe('');
    expect(answer).toEqual({ url: authorization.url, expires_at: authorization.expires_at });
  });

  // Break caught: an authorization that asks for a header or another method drawn as a photo that never loads.
  it.each([
    ['a method that is not GET', { ...authorization, method: 'PUT' }],
    ['a header that is asked for', { ...authorization, headers: { Authorization: 'x' } }],
    ['an address with a space', { ...authorization, url: 'https://store.example/a b' }],
    ['a body that is not an authorization', { nope: true }],
  ])('reads %s as an answer that is not the API’s', async (_name, body) => {
    api = installFakeApi({
      [`POST /evidence/${WORK_EVIDENCE_ID}/retrieval-authorization`]: () => json(200, body),
    });

    await expect(createRetrievalAuthorization(client(), WORK_EVIDENCE_ID)).rejects.toMatchObject({
      kind: 'unexpected-response',
    });
  });

  it('carries a refusal of a photo that is not stored yet, with its code', async () => {
    api = installFakeApi({
      [`POST /evidence/${WORK_EVIDENCE_ID}/retrieval-authorization`]: () =>
        errorResponse(409, 'EVIDENCE_NOT_STORED'),
    });

    await expect(createRetrievalAuthorization(client(), WORK_EVIDENCE_ID)).rejects.toMatchObject({
      code: 'EVIDENCE_NOT_STORED',
    });
  });
});
