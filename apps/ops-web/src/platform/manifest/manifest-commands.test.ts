import { createBrowserApiClient } from '@melarc/api-client/browser';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { installFakeApi, json, type FakeApi } from '../../test-support/fake-api';
import {
  handoverFixture,
  HANDOVER_ID,
  manifestFixture,
  MANIFEST_HUB_ID,
  MANIFEST_ID,
  REQUEST_ONE_ID,
  REQUEST_TWO_ID,
  STOP_ONE_ID,
  STOP_THREE_ID,
  STOP_TWO_ID,
  stopFixture,
} from '../../test-support/manifest-fixture';
import { ApiError } from '@melarc/api-client/browser';
import {
  acceptRunCustodyHandover,
  assignRider,
  cancelPickupManifest,
  createPickupManifest,
  dispatchManifest,
  failRunCustodyHandover,
  initiateRunCustodyHandover,
  setManifestStopOrder,
  skipPickupStop,
} from './manifest-commands';

/**
 * The wire shape of the nine acts of the manifest screens (S1.25), read from the requests the real client puts on the wire: the method, the
 * path, the headers each operation declares and no other, and the body in the contract's names. The custody acts are written from the contract
 * (S1.24) and answered here by a stand-in, so they are held to what the contract says and not to the server (the screens are not yet proved against the real API).
 */
const RIDER_ID = '4d5e6f7a-8b9c-4d0e-8f1a-2b3c4d5e6f7a';
const VERSION = '"v7"';
const KEY = 'key-0001';

let api: FakeApi;
const client = () => createBrowserApiClient();

beforeEach(() => {
  document.cookie = 'melarc_csrf=csrf-token; path=/';
});
afterEach(() => {
  api.restore();
  document.cookie = 'melarc_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
});

const etag = (version: string): Record<string, string> => ({ ETag: version });
const last = () => {
  const request = api.requests.at(-1);
  if (request === undefined) throw new Error('nothing was sent');
  return request;
};
const bodyOf = async (): Promise<unknown> => last().clone().json();

describe('createPickupManifest', () => {
  it('posts the chosen requests, the day and the reason of each carried-over one, under a key and no version', async () => {
    api = installFakeApi({
      'POST /pickup-manifests': () =>
        json(
          201,
          manifestFixture({
            stops: [
              stopFixture(),
              stopFixture({ id: STOP_TWO_ID, pickup_request_id: REQUEST_TWO_ID, sequence: 2 }),
            ],
          }),
          etag('"v1"'),
        ),
    });

    const record = await createPickupManifest(
      client(),
      {
        pickup_request_ids: [REQUEST_ONE_ID, REQUEST_TWO_ID],
        service_date: '2026-11-04',
        carryover: [{ pickup_request_id: REQUEST_TWO_ID, reason_code: 'DEMO_LATE', note: 'Gate' }],
      },
      KEY,
    );

    expect(last().headers.get('Idempotency-Key')).toBe(KEY);
    expect(last().headers.get('If-Match')).toBeNull();
    expect(await bodyOf()).toEqual({
      pickup_request_ids: [REQUEST_ONE_ID, REQUEST_TWO_ID],
      service_date: '2026-11-04',
      carryover: [{ pickup_request_id: REQUEST_TWO_ID, reason_code: 'DEMO_LATE', note: 'Gate' }],
    });
    expect(record.etag).toBe('"v1"');
    expect(record.manifest.stops).toHaveLength(2);
  });

  // Break caught: a creation taken as done when the answer is not a draft of the stops that were asked for.
  it('reads an answer that is not a draft with a stop for each request as an answer that is not the API’s', async () => {
    api = installFakeApi({
      'POST /pickup-manifests': () =>
        json(201, manifestFixture({ state: 'DISPATCHED' }), etag('"v1"')),
    });

    await expect(
      createPickupManifest(
        client(),
        {
          pickup_request_ids: [REQUEST_ONE_ID, REQUEST_TWO_ID, STOP_THREE_ID],
          service_date: '2026-11-04',
        },
        KEY,
      ),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

describe('setManifestStopOrder', () => {
  it('puts the complete sequence under a key and the version', async () => {
    const reversed = [STOP_THREE_ID, STOP_TWO_ID, STOP_ONE_ID];
    api = installFakeApi({
      [`PUT /pickup-manifests/${MANIFEST_ID}/stops`]: () =>
        json(
          200,
          manifestFixture({
            stops: [
              stopFixture({ id: STOP_THREE_ID, sequence: 1 }),
              stopFixture({ id: STOP_TWO_ID, sequence: 2 }),
              stopFixture({ id: STOP_ONE_ID, sequence: 3 }),
            ],
          }),
          etag('"v8"'),
        ),
    });

    const record = await setManifestStopOrder(client(), MANIFEST_ID, VERSION, reversed, KEY);

    expect(last().method).toBe('PUT');
    expect(last().headers.get('If-Match')).toBe(VERSION);
    expect(last().headers.get('Idempotency-Key')).toBe(KEY);
    expect(await bodyOf()).toEqual({ ordered_stop_ids: reversed });
    expect(record.manifest.stops.map((stop) => stop.id)).toEqual(reversed);
  });

  // Break caught: an order taken as set when the answer holds the stops in another order than was sent.
  it('reads an answer in another order than was sent as an answer that is not the API’s', async () => {
    api = installFakeApi({
      [`PUT /pickup-manifests/${MANIFEST_ID}/stops`]: () =>
        json(200, manifestFixture(), etag('"v8"')),
    });

    await expect(
      setManifestStopOrder(
        client(),
        MANIFEST_ID,
        VERSION,
        [STOP_THREE_ID, STOP_TWO_ID, STOP_ONE_ID],
        KEY,
      ),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

describe('assignRider and dispatchManifest', () => {
  it('assigns on the version, with no key, and names the rider in the body', async () => {
    api = installFakeApi({
      [`POST /pickup-manifests/${MANIFEST_ID}/assign-rider`]: () =>
        json(
          200,
          manifestFixture({ assigned_rider_id: RIDER_ID, assigned_at: '2026-11-03T08:00:00Z' }),
          etag('"v2"'),
        ),
    });

    const record = await assignRider(client(), MANIFEST_ID, VERSION, RIDER_ID);

    expect(last().headers.get('If-Match')).toBe(VERSION);
    expect(last().headers.get('Idempotency-Key')).toBeNull();
    expect(await bodyOf()).toEqual({ rider_id: RIDER_ID });
    expect(record.manifest.assigned_rider_id).toBe(RIDER_ID);
  });

  // Break caught: an assignment taken as done when the answer names nobody, or somebody else.
  it('reads an answer that names another rider as an answer that is not the API’s', async () => {
    api = installFakeApi({
      [`POST /pickup-manifests/${MANIFEST_ID}/assign-rider`]: () =>
        json(200, manifestFixture({ assigned_rider_id: STOP_ONE_ID }), etag('"v2"')),
    });

    await expect(assignRider(client(), MANIFEST_ID, VERSION, RIDER_ID)).rejects.toBeInstanceOf(
      ApiError,
    );
  });

  it('dispatches on the version, with no key and no body', async () => {
    api = installFakeApi({
      [`POST /pickup-manifests/${MANIFEST_ID}/dispatch`]: () =>
        json(
          200,
          manifestFixture({ state: 'DISPATCHED', assigned_rider_id: RIDER_ID }),
          etag('"v3"'),
        ),
    });

    const record = await dispatchManifest(client(), MANIFEST_ID, VERSION);

    expect(last().headers.get('If-Match')).toBe(VERSION);
    expect(last().headers.get('Idempotency-Key')).toBeNull();
    expect(await last().clone().text()).toBe('');
    expect(record.manifest.state).toBe('DISPATCHED');
  });

  // Break caught: a dispatch taken as done when the manifest came back a draft, or already started.
  it.each(['DRAFT', 'IN_PROGRESS'] as const)('refuses an answer that is %s', async (state) => {
    api = installFakeApi({
      [`POST /pickup-manifests/${MANIFEST_ID}/dispatch`]: () =>
        json(200, manifestFixture({ state }), etag('"v3"')),
    });

    await expect(dispatchManifest(client(), MANIFEST_ID, VERSION)).rejects.toBeInstanceOf(ApiError);
  });
});

describe('cancelPickupManifest', () => {
  it('posts the note under a key and the version', async () => {
    api = installFakeApi({
      [`POST /pickup-manifests/${MANIFEST_ID}/cancel`]: () =>
        json(200, manifestFixture({ state: 'CANCELLED' }), etag('"v4"')),
    });

    const record = await cancelPickupManifest(client(), MANIFEST_ID, VERSION, 'Rider unwell', KEY);

    expect(last().headers.get('If-Match')).toBe(VERSION);
    expect(last().headers.get('Idempotency-Key')).toBe(KEY);
    expect(await bodyOf()).toEqual({ note: 'Rider unwell' });
    expect(record.manifest.state).toBe('CANCELLED');
  });
});

describe('skipPickupStop', () => {
  it('posts the reason code and the note under a key and the version of the stop', async () => {
    api = installFakeApi({
      [`POST /pickup-stops/${STOP_ONE_ID}/skip`]: () =>
        json(
          200,
          stopFixture({
            state: 'SKIPPED',
            skipped: {
              reason_code: 'LOCATION_INACCESSIBLE',
              note: 'Gate locked',
              skipped_at: '2026-11-04T09:00:00Z',
            },
          }),
          etag('"s2"'),
        ),
    });

    const stop = await skipPickupStop(
      client(),
      STOP_ONE_ID,
      '"s1"',
      { reasonCode: 'LOCATION_INACCESSIBLE', note: 'Gate locked' },
      KEY,
    );

    expect(last().headers.get('If-Match')).toBe('"s1"');
    expect(last().headers.get('Idempotency-Key')).toBe(KEY);
    expect(await bodyOf()).toEqual({ reason_code: 'LOCATION_INACCESSIBLE', note: 'Gate locked' });
    expect(stop.state).toBe('SKIPPED');
  });

  it('sends no note when there is none', async () => {
    api = installFakeApi({
      [`POST /pickup-stops/${STOP_ONE_ID}/skip`]: () =>
        json(
          200,
          stopFixture({
            state: 'SKIPPED',
            skipped: { reason_code: 'RUN_CUT_SHORT', skipped_at: '2026-11-04T09:00:00Z' },
          }),
          etag('"s2"'),
        ),
    });

    await skipPickupStop(client(), STOP_ONE_ID, '"s1"', { reasonCode: 'RUN_CUT_SHORT' }, KEY);

    expect(await bodyOf()).toEqual({ reason_code: 'RUN_CUT_SHORT' });
  });

  // Break caught: a skip taken as done when the stop came back as it was, or skipped for another reason than the one chosen.
  it('refuses an answer that is not the stop, skipped, with the code that was sent', async () => {
    api = installFakeApi({
      [`POST /pickup-stops/${STOP_ONE_ID}/skip`]: () => json(200, stopFixture(), etag('"s2"')),
    });

    await expect(
      skipPickupStop(client(), STOP_ONE_ID, '"s1"', { reasonCode: 'RUN_CUT_SHORT' }, KEY),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

describe('the custody acts', () => {
  it('opens a handover to another rider on the version of the manifest, with no key', async () => {
    api = installFakeApi({
      [`POST /pickup-manifests/${MANIFEST_ID}/custody-handover`]: () =>
        json(200, handoverFixture({ to_hub_id: null, to_rider_id: RIDER_ID }), etag('"h1"')),
    });

    const record = await initiateRunCustodyHandover(
      client(),
      MANIFEST_ID,
      VERSION,
      { riderId: RIDER_ID },
      'Handset destroyed',
    );

    expect(last().headers.get('If-Match')).toBe(VERSION);
    expect(last().headers.get('Idempotency-Key')).toBeNull();
    expect(await bodyOf()).toEqual({ to_rider_id: RIDER_ID, note: 'Handset destroyed' });
    expect(record.etag).toBe('"h1"');
    expect(record.handover.state).toBe('PENDING');
  });

  it('opens a handover to the hub with the hub and no rider', async () => {
    api = installFakeApi({
      [`POST /pickup-manifests/${MANIFEST_ID}/custody-handover`]: () =>
        json(200, handoverFixture(), etag('"h1"')),
    });

    await initiateRunCustodyHandover(
      client(),
      MANIFEST_ID,
      VERSION,
      { hubId: MANIFEST_HUB_ID },
      'Unsafe',
    );

    expect(await bodyOf()).toEqual({ to_hub_id: MANIFEST_HUB_ID, note: 'Unsafe' });
  });

  // Break caught: a handover taken as opened to where it was asked to go when the answer says custody goes elsewhere, or has no version.
  it('refuses an answer that goes elsewhere, is not pending, or has no version', async () => {
    api = installFakeApi({
      [`POST /pickup-manifests/${MANIFEST_ID}/custody-handover`]: () =>
        json(200, handoverFixture({ to_hub_id: null, to_rider_id: STOP_ONE_ID }), etag('"h1"')),
    });
    await expect(
      initiateRunCustodyHandover(client(), MANIFEST_ID, VERSION, { riderId: RIDER_ID }, 'n'),
    ).rejects.toBeInstanceOf(ApiError);

    api.restore();
    api = installFakeApi({
      [`POST /pickup-manifests/${MANIFEST_ID}/custody-handover`]: () =>
        json(200, handoverFixture()),
    });
    await expect(
      initiateRunCustodyHandover(client(), MANIFEST_ID, VERSION, { hubId: MANIFEST_HUB_ID }, 'n'),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it('accepts a handover to the hub with what was taken, under a key and the version of the handover', async () => {
    api = installFakeApi({
      [`POST /pickup-manifests/${MANIFEST_ID}/custody-handover/accept`]: () =>
        json(
          200,
          handoverFixture({
            state: 'COMPLETED',
            parcel_count_taken: 7,
            resolved_at: '2026-11-04T10:30:00Z',
          }),
          etag('"h2"'),
        ),
    });

    const handover = await acceptRunCustodyHandover(client(), MANIFEST_ID, '"h1"', 7, KEY);

    expect(last().headers.get('If-Match')).toBe('"h1"');
    expect(last().headers.get('Idempotency-Key')).toBe(KEY);
    expect(await bodyOf()).toEqual({ parcel_count_taken: 7 });
    expect(handover.parcel_count_taken).toBe(7);
  });

  // Break caught: an acceptance taken as done when the answer records another count than the one sent (the count is a custody record).
  it('refuses an acceptance whose answer records another count', async () => {
    api = installFakeApi({
      [`POST /pickup-manifests/${MANIFEST_ID}/custody-handover/accept`]: () =>
        json(
          200,
          handoverFixture({
            state: 'COMPLETED',
            parcel_count_taken: 9,
            resolved_at: '2026-11-04T10:30:00Z',
          }),
          etag('"h2"'),
        ),
    });

    await expect(
      acceptRunCustodyHandover(client(), MANIFEST_ID, '"h1"', 7, KEY),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it('fails a handover with a note, under a key and the version of the handover', async () => {
    api = installFakeApi({
      [`POST /pickup-manifests/${MANIFEST_ID}/custody-handover/fail`]: () =>
        json(
          200,
          handoverFixture({ state: 'FAILED', resolved_at: '2026-11-04T10:30:00Z' }),
          etag('"h2"'),
        ),
    });

    const handover = await failRunCustodyHandover(
      client(),
      MANIFEST_ID,
      '"h1"',
      'Did not arrive',
      KEY,
    );

    expect(last().headers.get('If-Match')).toBe('"h1"');
    expect(last().headers.get('Idempotency-Key')).toBe(KEY);
    expect(await bodyOf()).toEqual({ note: 'Did not arrive' });
    expect(handover.state).toBe('FAILED');
    expect(handover.id).toBe(HANDOVER_ID);
  });
});
