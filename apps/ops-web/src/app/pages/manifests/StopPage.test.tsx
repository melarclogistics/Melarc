import { screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { installFakeApi, json, type FakeApi, type Handler } from '../../../test-support/fake-api';
import {
  describeInterfaceStates,
  OFFLINE_NOT_APPLICABLE,
} from '../../../test-support/interface-states';
import {
  manifestFixture,
  MANIFEST_ID,
  STOP_ONE_ID,
  stopFixture,
  summaryFixture,
} from '../../../test-support/manifest-fixture';
import { PICKUP_HUB_ID } from '../../../test-support/pickup-fixture';
import {
  evidenceItemFixture,
  evidenceListFixture,
  exceptionFixture,
} from '../../../test-support/pickup-work-fixture';
import { renderApp } from '../../../test-support/render-app';
import { etag, refusal, sessionWith, staffApi } from '../../../test-support/staff-api';

/**
 * `/manifests/{id}/stops/{stopId}` (`getPickupStop`, `listPickupStopEvidence`, `createEvidenceRetrievalAuthorization`; S1.30). The record page of one stop with **its parcel photos as they arrive**: the
 * progress as the server counts it, and a tile for each photo **with no picture**. A photo is fetched only when it is opened, with an authorization of its own that the page holds only while the photo is
 * open. The list is read a page at a time.
 */
const PATH = `/manifests/${MANIFEST_ID}/stops/${STOP_ONE_ID}`;
const STOP = `GET /pickup-stops/${STOP_ONE_ID}`;
const RUN = `GET /pickup-manifests/${MANIFEST_ID}`;
const EVIDENCE = `GET /pickup-stops/${STOP_ONE_ID}/evidence`;
const DIAGNOSTIC = /Diagnostic text that must never reach a screen\./;
const READER = ['pickup.read'];
const OFFICER = ['pickup.read', 'pickup.handshake.override'];

/** An identifier of the nth photo: a valid one, so that the guard accepts it, and one that is read as the number it is. */
const idOf = (n: number): string => `0c1d2e3f-4a5b-4c6d-8e7f-${n.toString(16).padStart(12, '0')}`;
const photo = (n: number, overrides: Record<string, unknown> = {}) =>
  evidenceItemFixture({
    id: idOf(n),
    captured_at: `2026-11-04T09:${String(10 + (n % 40)).padStart(2, '0')}:00Z`,
    ...overrides,
  });
const progress = (stored: number, pending = 0, expired = 0) => ({
  declared: stored + pending,
  stored,
  pending,
  expired,
});

const authorization = (n: number) => ({
  method: 'GET',
  url: `https://store.example/evidence/photo-${String(n)}?token=t${String(n)}`,
  expires_at: '2026-11-04T09:36:00Z',
});

let api: FakeApi;
afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
});

const stopAnswer = (overrides: Record<string, unknown> = {}): Response =>
  json(
    200,
    stopFixture({
      state: 'ARRIVED',
      arrived_at: '2026-11-04T09:00:00Z',
      pickup_summary: summaryFixture('ACC-PR-7KQ2MZ'),
      ...overrides,
    }),
    etag('v1'),
  );

function open(
  evidence: Handler = () => json(200, evidenceListFixture()),
  keys: readonly string[] = READER,
  handlers: Record<string, Handler> = {},
  stop: Handler = () => stopAnswer(),
) {
  api = installFakeApi(
    staffApi(
      sessionWith(keys, {
        authorized_hubs: [{ id: PICKUP_HUB_ID, display_name: 'Accra Central' }],
      }),
      {
        [STOP]: stop,
        [RUN]: () => json(200, manifestFixture({ state: 'IN_PROGRESS' }), etag('v1')),
        [EVIDENCE]: evidence,
        ...handlers,
      },
    ),
  );
  return renderApp(PATH);
}

const evidenceReads = () =>
  api.requests.filter(
    (request) => new URL(request.url).pathname.endsWith('/evidence') && request.method === 'GET',
  );
const authorizations = () =>
  api.requests.filter((request) =>
    new URL(request.url).pathname.endsWith('/retrieval-authorization'),
  );
const photosPanel = async (): Promise<HTMLElement> =>
  screen.findByRole('region', { name: 'Photos' });
const alertSaying = async (text: string | RegExp): Promise<HTMLElement> => {
  await waitFor(() => {
    expect(screen.getByRole('alert')).toHaveTextContent(text);
  });
  return screen.getByRole('alert');
};
async function openPhoto(user: UserEvent, n: number): Promise<HTMLElement> {
  await user.click(await screen.findByRole('button', { name: `Open Parcel photo ${String(n)}` }));
  return screen.findByRole('dialog', { name: `Parcel photo ${String(n)}` });
}

describe('the stop: what the page shows', () => {
  it('shows the stop by its place in the run, its state and the facts the manifest gave', async () => {
    open();

    expect(await screen.findByRole('heading', { level: 1, name: 'Stop 1' })).toBeVisible();
    expect(document.title).toBe('Stop 1 · Melarc Ops Portal');
    expect(await screen.findByText('Stop 1 of ACC-MF-Q92422, for ACC-PR-7KQ2MZ.')).toBeVisible();
    expect(screen.getAllByText('Rider arrived').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Demo Fabrics Ltd')).toBeVisible();
    expect(screen.getByRole('link', { name: 'ACC-PR-7KQ2MZ' })).toHaveAttribute(
      'href',
      expect.stringMatching(/^\/pickup-requests\//),
    );
  });

  // Break caught: a progress worked out by the page (a count of the tiles read so far, which is one page of the stop and not the stop) and not the server's.
  it('tells the progress as the server counted it for the whole stop, with the waiting and the never-uploaded told apart', async () => {
    open(() =>
      json(
        200,
        evidenceListFixture({
          items: [photo(1)],
          next_page_token: 'p2',
          parcel_photos: progress(10, 2, 1),
        }),
      ),
    );

    expect(
      await screen.findByText(
        '10 of 12 parcel photos uploaded. 2 photos are still waiting to upload. 1 photo never uploaded: the time to upload ran out.',
      ),
    ).toBeVisible();
  });

  it('says a stop with no parcel photo has none, and never "0 of 0 uploaded"', async () => {
    open(() => json(200, evidenceListFixture({ items: [], parcel_photos: progress(0) })));

    expect(
      await screen.findByText('No parcel photo is stored or waiting to upload.'),
    ).toBeVisible();
    expect(screen.getByText('No photos have arrived for this stop yet.')).toBeVisible();
    expect(screen.queryByText(/0 of 0/)).toBeNull();
  });

  // Break caught: a tile with a picture (no small copy of a photo is made, so a tile that fetched one would fetch every image of the stop), or an image before a photo is opened.
  it('draws a tile for each photo with no picture, and fetches no image and no authorization until one is opened', async () => {
    open(() =>
      json(
        200,
        evidenceListFixture({ items: [photo(1), photo(2), photo(3)], parcel_photos: progress(3) }),
      ),
    );

    const panel = within(await photosPanel());
    expect(await panel.findAllByRole('listitem')).toHaveLength(3);
    expect(panel.getByText('Parcel photo 1')).toBeVisible();
    expect(panel.getAllByText('The scan found it clean.')).toHaveLength(3);
    expect(panel.getAllByText('Stored')).toHaveLength(3);
    expect(document.querySelector('img.stop-photo__image')).toBeNull();
    expect(authorizations()).toHaveLength(0);
  });

  // Break caught: a stop of two hundred photos costing the page more than its list: every photo asked for, or an image fetched for a tile.
  it('costs a stop of forty photos one read of the list and nothing else', async () => {
    const forty = Array.from({ length: 40 }, (_, index) => photo(index + 1));
    open(() => json(200, evidenceListFixture({ items: forty, parcel_photos: progress(40) })));

    const panel = within(await photosPanel());
    expect(await panel.findAllByRole('listitem')).toHaveLength(40);
    expect(evidenceReads()).toHaveLength(1);
    expect(new URL(evidenceReads()[0]?.url ?? 'http://x/').searchParams.get('page_size')).toBe(
      '100',
    );
    expect(authorizations()).toHaveLength(0);
    expect(document.querySelector('img.stop-photo__image')).toBeNull();
  });

  it('shows a photo that is not stored yet as waiting, and cannot be opened', async () => {
    open(() =>
      json(
        200,
        evidenceListFixture({
          items: [
            photo(1),
            photo(2, { state: 'PENDING_UPLOAD', uploaded_at: null, scanned_clean: false }),
          ],
          parcel_photos: progress(1, 1),
        }),
      ),
    );

    const panel = within(await photosPanel());
    expect(await panel.findByText('Waiting to upload')).toBeVisible();
    expect(panel.getByRole('button', { name: 'Open Parcel photo 1' })).toBeVisible();
    expect(panel.queryByRole('button', { name: 'Open Parcel photo 2' })).toBeNull();
    expect(panel.getByText('It is scanned once its upload is complete.')).toBeVisible();
  });

  it('shows the photo of a failure or a short count beside the parcel photos, as evidence of the stop', async () => {
    open(() =>
      json(
        200,
        evidenceListFixture({
          items: [photo(1), photo(2, { purpose: 'COLLECTION_PROOF' })],
          parcel_photos: progress(1),
        }),
      ),
    );

    const panel = within(await photosPanel());
    expect(await panel.findByText('Photo of the failure or short count 1')).toBeVisible();
    expect(panel.getByText('Parcel photo 1')).toBeVisible();
    expect(panel.getByText('Evidence of a failure or a short count')).toBeVisible();
  });
});

describe('a photo opened', () => {
  // Break caught: the image fetched without an authorization of its own, the authorization kept after the photo is closed, or a second opening that reuses the first one.
  it('asks for the photo’s own authorization when it is opened, draws it only while open, and asks again when opened again', async () => {
    const { user } = open(
      () =>
        json(200, evidenceListFixture({ items: [photo(1), photo(2)], parcel_photos: progress(2) })),
      READER,
      {
        [`POST /evidence/${idOf(1)}/retrieval-authorization`]: () => json(200, authorization(1)),
      },
    );

    const dialog = within(await openPhoto(user, 1));
    const image = await dialog.findByRole('img', { name: /^Parcel photo 1, taken / });
    expect(image).toHaveAttribute('src', authorization(1).url);
    expect(image).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(authorizations()).toHaveLength(1);

    await user.click(dialog.getByRole('button', { name: 'Close the photo' }));
    await waitFor(() => {
      expect(document.querySelector('img.stop-photo__image')).toBeNull();
    });

    await openPhoto(user, 1);
    await screen.findByRole('img', { name: /^Parcel photo 1, taken / });
    expect(authorizations()).toHaveLength(2);
    expect(authorizations().every((request) => request.url.includes(`/evidence/${idOf(1)}/`))).toBe(
      true,
    );
  });

  // Break caught: a photo that is not stored told as a generic failure, so the officer retries what cannot work.
  it('tells a photo that is not stored in plain words, and draws no image', async () => {
    const { user } = open(
      () => json(200, evidenceListFixture({ items: [photo(1)], parcel_photos: progress(1) })),
      READER,
      {
        [`POST /evidence/${idOf(1)}/retrieval-authorization`]: () =>
          refusal(409, 'EVIDENCE_NOT_STORED'),
      },
    );

    const dialog = within(await openPhoto(user, 1));

    expect(
      await dialog.findByText(/This photo is not stored yet, so it cannot be opened/),
    ).toBeVisible();
    expect(dialog.queryByRole('img')).toBeNull();
    expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
  });

  it('tells an image that would not load, and what to do', async () => {
    const { user } = open(
      () => json(200, evidenceListFixture({ items: [photo(1)], parcel_photos: progress(1) })),
      READER,
      { [`POST /evidence/${idOf(1)}/retrieval-authorization`]: () => json(200, authorization(1)) },
    );

    const dialog = within(await openPhoto(user, 1));
    const image = await dialog.findByRole('img');
    image.dispatchEvent(new Event('error'));

    expect(await dialog.findByText(/The photo could not be shown/)).toBeVisible();
    expect(dialog.queryByRole('img')).toBeNull();
  });
});

describe('the photos a page at a time', () => {
  it('loads the next page by the server’s position when asked, and keeps the photos already shown', async () => {
    const { user } = open((request) =>
      new URL(request.url).searchParams.get('page_token') === 'p2'
        ? json(200, evidenceListFixture({ items: [photo(3)], parcel_photos: progress(3) }))
        : json(
            200,
            evidenceListFixture({
              items: [photo(1), photo(2)],
              next_page_token: 'p2',
              parcel_photos: progress(3),
            }),
          ),
    );

    const panel = within(await photosPanel());
    expect(await panel.findAllByRole('listitem')).toHaveLength(2);
    await user.click(panel.getByRole('button', { name: 'Load more photos' }));

    await waitFor(() => {
      expect(panel.getAllByRole('listitem')).toHaveLength(3);
    });
    expect(evidenceReads()).toHaveLength(2);
    expect(new URL(evidenceReads()[1]?.url ?? 'http://x/').searchParams.get('page_token')).toBe(
      'p2',
    );
    expect(panel.queryByRole('button', { name: 'Load more photos' })).toBeNull();
  });

  // Break caught: a page that fails to load taking the photos that were loaded away, or told as if nothing had been read.
  it('keeps the photos it has when the next page fails, and says so', async () => {
    const { user } = open((request) =>
      new URL(request.url).searchParams.get('page_token') === 'p2'
        ? refusal(500, 'INTERNAL_ERROR')
        : json(
            200,
            evidenceListFixture({
              items: [photo(1), photo(2)],
              next_page_token: 'p2',
              parcel_photos: progress(4),
            }),
          ),
    );

    const panel = within(await photosPanel());
    await user.click(await panel.findByRole('button', { name: 'Load more photos' }));

    await alertSaying(
      /The photos of this stop could not be loaded\. The photos shown are those that were loaded\./,
    );
    expect(panel.getAllByRole('listitem')).toHaveLength(2);
    expect(panel.getByRole('button', { name: 'Try to load more photos again' })).toBeVisible();
  });
});

describe('the exception that let a count through without photos', () => {
  it('says who, when and why, and offers the act no more', async () => {
    open(
      () =>
        json(
          200,
          evidenceListFixture({
            items: [],
            parcel_photos: progress(0),
            parcel_photo_exception: exceptionFixture(),
          }),
        ),
      OFFICER,
    );

    expect(await screen.findByText('Counted without parcel photos')).toBeVisible();
    expect(
      screen.getByText(
        /Another member of staff let this stop’s count through without parcel photos on /,
      ),
    ).toBeVisible();
    expect(screen.getByText('Why: The rider’s camera failed.')).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Let the count through without photos' })).toBeNull();
  });

  it('offers the act to a holder of its key for a stop the rider has arrived at, and to nobody else', async () => {
    open(undefined, OFFICER);
    const act = await screen.findByRole('link', { name: 'Let the count through without photos' });
    expect(act).toHaveAttribute('href', `${PATH}/photo-exception`);
  });

  it('offers no act to a session without the key, or for a stop that has not been arrived at', async () => {
    open(undefined, READER);
    await screen.findByRole('heading', { level: 1, name: 'Stop 1' });
    await photosPanel();
    expect(screen.queryByRole('link', { name: 'Let the count through without photos' })).toBeNull();
  });

  it('offers no act for a stop that is not arrived at', async () => {
    open(undefined, OFFICER, {}, () => stopAnswer({ state: 'PENDING', arrived_at: undefined }));
    await screen.findByRole('heading', { level: 1, name: 'Stop 1' });
    await photosPanel();

    expect(screen.queryByRole('link', { name: 'Let the count through without photos' })).toBeNull();
  });
});

describe('a stop that is not there', () => {
  it('tells a stop that does not exist as that', async () => {
    open(undefined, READER, {}, () => refusal(404, 'NOT_FOUND'));

    expect(await screen.findByRole('heading', { name: 'Stop not found' })).toBeVisible();
  });

  it('tells a stop of another hub as that', async () => {
    open(undefined, READER, {}, () => refusal(403, 'HUB_SCOPE_VIOLATION'));

    expect(await screen.findByText(/hub your account does not work in/)).toBeVisible();
  });

  it('tells a stop that belongs to another run as a stop that is not there', async () => {
    open(undefined, READER, {}, () =>
      stopAnswer({ pickup_manifest_id: '9e0f1a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b' }),
    );

    expect(await screen.findByRole('heading', { name: 'Stop not found' })).toBeVisible();
  });
});

describeInterfaceStates('the stop page', {
  loading: {
    test: async () => {
      open(() => new Promise<Response>(() => undefined));
      expect(await screen.findByText('Loading the photos…')).toBeVisible();
    },
  },
  empty: {
    test: async () => {
      open(() => json(200, evidenceListFixture({ items: [], parcel_photos: progress(0) })));
      expect(await screen.findByText('No photos have arrived for this stop yet.')).toBeVisible();
    },
  },
  'validation error': {
    inapplicable:
      'The page takes no input: the photos are read by the stop’s own identifier, which the address makes a valid one or the page refuses before asking.',
  },
  error: {
    test: async () => {
      open(() => refusal(500, 'INTERNAL_ERROR'));
      await alertSaying('The photos of this stop could not be loaded.');
      // A read that failed is never drawn as no photo, and never as zero uploaded.
      expect(screen.queryByText('No photos have arrived for this stop yet.')).toBeNull();
      expect(screen.queryByText(/0 of 0|No parcel photo/)).toBeNull();
      expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
    },
  },
  retry: {
    test: async () => {
      let attempts = 0;
      const { user } = open(() => {
        attempts += 1;
        return attempts === 1
          ? refusal(503, 'SERVICE_UNAVAILABLE')
          : json(200, evidenceListFixture());
      });
      await alertSaying(/could not be loaded/);
      await user.click(screen.getByRole('button', { name: 'Try again' }));
      expect(await screen.findByText('1 of 1 parcel photos uploaded.')).toBeVisible();
    },
  },
  offline: { inapplicable: OFFLINE_NOT_APPLICABLE },
  'stale / conflict': {
    inapplicable:
      'The page changes nothing: a photo that arrives while it is open is read with the next page, and the surface says stale is not a state of this page.',
  },
  success: {
    test: async () => {
      open();
      expect(await screen.findByText('1 of 1 parcel photos uploaded.')).toBeVisible();
    },
  },
  'permission-restricted': {
    test: async () => {
      open(undefined, READER, {}, () => refusal(403, 'PERMISSION_DENIED'));
      await alertSaying('Your account can’t see pickup runs. Ask an administrator for access.');
    },
  },
});
