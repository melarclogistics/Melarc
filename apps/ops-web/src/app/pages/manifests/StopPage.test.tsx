import {
  act,
  screen,
  waitFor,
  within,
  type BoundFunctions,
  type queries,
} from '@testing-library/react';
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

/** The five minutes a link lives (`createEvidenceRetrievalAuthorization`), counted from the moment the test asks: a link with time left, and not one of a fixed day that has since gone by. */
const FIVE_MINUTES = 5 * 60_000;
const authorization = (n: number, lifeMs = FIVE_MINUTES) => ({
  method: 'GET',
  url: `https://store.example/evidence/photo-${String(n)}?token=t${String(n)}`,
  expires_at: new Date(Date.now() + lifeMs).toISOString(),
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
    expect((await photosPanel()).querySelector('img')).toBeNull();
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
    expect((await photosPanel()).querySelector('img')).toBeNull();
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

  /**
   * A link lives five minutes and the picture is a request of its own. These tests open photo 1 and make its picture fail the way the browser does (the `error` event of the image), and a
   * link the store would answer for is the one the page asked for last: each opening, and the one renewal, asks for a link of its own (`authorization(n)`: the nth link issued).
   */
  const asking = (answer: (issued: number) => Response) => {
    let issued = 0;
    return {
      issued: () => issued,
      handlers: {
        [`POST /evidence/${idOf(1)}/retrieval-authorization`]: () => {
          issued += 1;
          return answer(issued);
        },
      },
    };
  };
  const openPhotoOne = (answer: (issued: number) => Response) => {
    const links = asking(answer);
    const page = open(
      () => json(200, evidenceListFixture({ items: [photo(1)], parcel_photos: progress(1) })),
      READER,
      links.handlers,
    );
    return { ...page, links };
  };
  const pictureOf = async (
    dialog: BoundFunctions<typeof queries>,
    link: number,
  ): Promise<HTMLElement> =>
    waitFor(() => {
      const picture = dialog.getByRole('img');
      expect(picture).toHaveAttribute('src', authorization(link).url);
      return picture;
    });

  // Break caught (the review of Run B, finding 4): a picture that would not load, because its link ran out, was shown as broken and never asked for again, so the officer had to close the photo and open it again.
  it('asks for a new link once when the picture would not load, and draws the photo with it', async () => {
    const { user, links } = openPhotoOne((issued) => json(200, authorization(issued)));

    const dialog = within(await openPhoto(user, 1));
    (await pictureOf(dialog, 1)).dispatchEvent(new Event('error'));

    const again = await pictureOf(dialog, 2);
    expect(again).toBeVisible();
    expect(links.issued()).toBe(2);
    expect(authorizations()).toHaveLength(2);
    expect(dialog.queryByText(/could not be shown/)).toBeNull();
  });

  // Break caught: a renewal that is asked for again and again (a loop of requests for a photo that cannot be shown), or one that says nothing when it fails too.
  it('says plainly that the photo could not be shown when the new link fails too, and asks no third time', async () => {
    const { user, links } = openPhotoOne((issued) => json(200, authorization(issued)));

    const dialog = within(await openPhoto(user, 1));
    (await pictureOf(dialog, 1)).dispatchEvent(new Event('error'));
    (await pictureOf(dialog, 2)).dispatchEvent(new Event('error'));

    expect(
      await dialog.findByText(/The photo could not be shown, even with a new link/),
    ).toBeVisible();
    expect(dialog.queryByRole('img')).toBeNull();
    expect(links.issued()).toBe(2);
    expect(authorizations()).toHaveLength(2);
  });

  // Break caught: a link about to run out drawn as it came, so that the picture fails a moment later for a reason the page could have seen.
  it('asks for a new link before it draws one that is about to run out, and for no more than one', async () => {
    const { user, links } = openPhotoOne((issued) =>
      json(200, authorization(issued, issued === 1 ? 5_000 : FIVE_MINUTES)),
    );

    const dialog = within(await openPhoto(user, 1));

    await pictureOf(dialog, 2);
    expect(links.issued()).toBe(2);
    expect(authorizations()).toHaveLength(2);
  });

  it('draws a link with time left as it came, and asks for no other', async () => {
    const { user, links } = openPhotoOne((issued) => json(200, authorization(issued)));

    const dialog = within(await openPhoto(user, 1));

    await pictureOf(dialog, 1);
    expect(links.issued()).toBe(1);
  });

  // Break caught (the review of Run B, finding 4): a picture that the browser's own policy blocked was told as a link that may have run out or a store that did not answer, so the officer retried what cannot work.
  it('tells a photo that the browser blocked as blocked, and blames neither the link nor the connection', async () => {
    const { user, links } = openPhotoOne((issued) => json(200, authorization(issued)));

    const dialog = within(await openPhoto(user, 1));
    const picture = await pictureOf(dialog, 1);
    // The browser says so before the picture fails: a `securitypolicyviolation` of the image directive, for the address the picture was asked at.
    window.dispatchEvent(
      Object.assign(new Event('securitypolicyviolation'), {
        effectiveDirective: 'img-src',
        violatedDirective: 'img-src',
        blockedURI: 'https://store.example',
      }),
    );
    picture.dispatchEvent(new Event('error'));

    expect(await dialog.findByText(/The browser blocked this photo/)).toBeVisible();
    expect(dialog.queryByText(/ran out|run out|did not answer|new link/)).toBeNull();
    expect(dialog.queryByRole('img')).toBeNull();
    // A new link cannot get past a policy: none is asked for.
    expect(links.issued()).toBe(1);
  });

  // Break caught: a violation of another directive, or of another address, taken for the picture's own and told as a block.
  it('does not take another violation of the browser’s policy for the photo’s own', async () => {
    const { user } = openPhotoOne((issued) => json(200, authorization(issued)));

    const dialog = within(await openPhoto(user, 1));
    const picture = await pictureOf(dialog, 1);
    window.dispatchEvent(
      Object.assign(new Event('securitypolicyviolation'), {
        effectiveDirective: 'script-src',
        violatedDirective: 'script-src',
        blockedURI: 'https://store.example',
      }),
    );
    window.dispatchEvent(
      Object.assign(new Event('securitypolicyviolation'), {
        effectiveDirective: 'img-src',
        violatedDirective: 'img-src',
        blockedURI: 'https://elsewhere.example',
      }),
    );
    picture.dispatchEvent(new Event('error'));

    await pictureOf(dialog, 2);
    expect(dialog.queryByText(/blocked/)).toBeNull();
  });

  // Break caught: a renewal that failed left the broken picture on the screen, or was told as the first failure was.
  it('says so in words when a new link cannot be asked for', async () => {
    const { user } = openPhotoOne((issued) =>
      issued === 1 ? json(200, authorization(1)) : refusal(503, 'SERVICE_UNAVAILABLE'),
    );

    const dialog = within(await openPhoto(user, 1));
    (await pictureOf(dialog, 1)).dispatchEvent(new Event('error'));

    expect(
      await dialog.findByText('This photo could not be opened. Close it and try again.'),
    ).toBeVisible();
    expect(dialog.queryByRole('img')).toBeNull();
  });

  it('asks for a link again each time the photo is opened, and the one renewal is each opening’s own', async () => {
    const { user, links } = openPhotoOne((issued) => json(200, authorization(issued)));

    const first = within(await openPhoto(user, 1));
    (await pictureOf(first, 1)).dispatchEvent(new Event('error'));
    (await pictureOf(first, 2)).dispatchEvent(new Event('error'));
    await first.findByText(/even with a new link/);
    await user.click(first.getByRole('button', { name: 'Close the photo' }));

    const second = within(await openPhoto(user, 1));
    (await pictureOf(second, 3)).dispatchEvent(new Event('error'));
    await pictureOf(second, 4);
    expect(links.issued()).toBe(4);
  });
});

describe('the photos a page at a time', () => {
  it('loads the next page by the server’s position when asked, reads the pages shown again after it, and keeps the photos', async () => {
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
    // The next page by the position the server gave, and then the pages already shown once more, in order and by the positions the server gives now: the tiles of the first page are of the moment
    // of the newest (the progress is the newest page's, for the whole stop).
    await waitFor(() => {
      expect(
        evidenceReads().map((read) => new URL(read.url).searchParams.get('page_token')),
      ).toEqual([null, 'p2', null, 'p2']);
    });
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

/** The page is shown or hidden as the browser says it: the state, and the event that follows it. */
function pageBecomes(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

describe('the photos as they arrive', () => {
  const WAITING = { state: 'PENDING_UPLOAD', uploaded_at: null, scanned_clean: false };
  /** What the server answers each time the list is read, in the order of the reads: the last answer stands for every read after it. */
  const reads = (answers: readonly Record<string, unknown>[]): Handler => {
    let read = 0;
    return () => {
      const answer = answers[Math.min(read, answers.length - 1)];
      read += 1;
      return json(200, evidenceListFixture(answer));
    };
  };
  const FIRST = { items: [photo(1), photo(2, WAITING)], parcel_photos: progress(1, 1) };
  const LATER = { items: [photo(1), photo(2)], parcel_photos: progress(2) };
  const STILL_WAITING = '1 of 2 parcel photos uploaded. 1 photo is still waiting to upload.';

  afterEach(() => {
    delete (document as unknown as Record<string, unknown>).visibilityState;
  });

  // Break caught (the review of Run B, finding 5): the progress was as old as the moment the page opened, so a stop whose photos were arriving never said so.
  it('reads the list again when Refresh is pressed, and tells when it last checked', async () => {
    const { user } = open(reads([FIRST, LATER]));

    const panel = within(await photosPanel());
    expect(await panel.findByText(STILL_WAITING)).toBeVisible();
    expect(panel.getByText(/^Updated /)).toBeVisible();
    await user.click(panel.getByRole('button', { name: 'Refresh' }));

    expect(await panel.findByText('2 of 2 parcel photos uploaded.')).toBeVisible();
    expect(panel.queryByText('Waiting to upload')).toBeNull();
    expect(evidenceReads()).toHaveLength(2);
  });

  // Break caught: a tablet put down on a stop and picked up again showing what it showed when it was put down.
  it('reads the list again when the page becomes visible', async () => {
    open(reads([FIRST, LATER]));
    const panel = within(await photosPanel());
    expect(await panel.findByText(STILL_WAITING)).toBeVisible();

    pageBecomes('visible');

    expect(await panel.findByText('2 of 2 parcel photos uploaded.')).toBeVisible();
    expect(evidenceReads()).toHaveLength(2);
  });

  it('reads nothing when the page is hidden, or on a focus or a reconnection', async () => {
    open(reads([FIRST, LATER]));
    const panel = within(await photosPanel());
    expect(await panel.findByText(STILL_WAITING)).toBeVisible();

    pageBecomes('hidden');
    act(() => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('online'));
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(evidenceReads()).toHaveLength(1);
  });

  // Break caught: a read that failed taking the photos that were read away, or drawn as if the list had been read.
  it('keeps the photos it has when reading again fails, and says when it last checked', async () => {
    let read = 0;
    const { user } = open(() => {
      read += 1;
      return read === 1
        ? json(200, evidenceListFixture(FIRST))
        : refusal(503, 'SERVICE_UNAVAILABLE');
    });

    const panel = within(await photosPanel());
    expect(await panel.findByText(STILL_WAITING)).toBeVisible();
    await user.click(panel.getByRole('button', { name: 'Refresh' }));

    expect(await panel.findByText(/Refresh failed\. Last successful check: /)).toBeVisible();
    expect(panel.getAllByRole('listitem')).toHaveLength(2);
    expect(panel.getByText(STILL_WAITING)).toBeVisible();
  });

  // Break caught (the review of Run B, finding 5): after "Load more" the progress was the newest page's and the tiles of the first page were as old as the first read, so a photo could be drawn as
  // waiting under a progress that said every photo was uploaded.
  it('shows the progress and the tiles of one moment after the next page is loaded', async () => {
    let firstPage = 0;
    const { user } = open((request) => {
      if (new URL(request.url).searchParams.get('page_token') === 'p2') {
        return json(200, evidenceListFixture({ items: [photo(3)], parcel_photos: progress(3) }));
      }
      firstPage += 1;
      // First read: photo 2 is still on its way and so is photo 3 (on the next page). By the time the officer loads the next page, both are in.
      return json(
        200,
        evidenceListFixture(
          firstPage === 1
            ? {
                items: [photo(1), photo(2, WAITING)],
                next_page_token: 'p2',
                parcel_photos: progress(1, 2),
              }
            : { items: [photo(1), photo(2)], next_page_token: 'p2', parcel_photos: progress(3) },
        ),
      );
    });

    const panel = within(await photosPanel());
    expect(
      await panel.findByText(/1 of 3 parcel photos uploaded\. 2 photos are still waiting/),
    ).toBeVisible();
    await user.click(panel.getByRole('button', { name: 'Load more photos' }));

    expect(await panel.findByText('3 of 3 parcel photos uploaded.')).toBeVisible();
    await waitFor(() => {
      expect(panel.getAllByRole('listitem')).toHaveLength(3);
      expect(panel.queryByText('Waiting to upload')).toBeNull();
    });
    expect(panel.getAllByText('Stored')).toHaveLength(3);
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

  it('offers the act to a holder of its key for a stop the rider has arrived at, whose camera failed, and to nobody else', async () => {
    // The stop the exception is for: no photo made it, so nothing was counted with photos and the server would take the exception.
    open(() => json(200, evidenceListFixture({ items: [], parcel_photos: progress(0) })), OFFICER);
    const act = await screen.findByRole('link', { name: 'Let the count through without photos' });
    expect(act).toHaveAttribute('href', `${PATH}/photo-exception`);
  });

  // Break caught (the review of Run B, finding 6): the act offered, as the page's primary act, for a stop whose every photo is uploaded, when the rider has counted with them or is about to, and the
  // server refuses a stop that has a count (`collection_recorded`).
  it('offers no act once every parcel photo the rider made is uploaded: the count may be recorded already', async () => {
    open(undefined, OFFICER);

    expect(await screen.findByText('1 of 1 parcel photos uploaded.')).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Let the count through without photos' })).toBeNull();
  });

  // The progress cannot say whether a count is recorded: it offers the act where the photos did not all make it, and the server judges the rest (a stop that has a count is refused in words).
  it.each([
    ['no photo at all', progress(0)],
    ['photos that are still waiting to upload', progress(1, 1)],
    ['photos whose upload window ran out', progress(0, 0, 2)],
    ['some photos that never came, and the rest uploaded', progress(2, 0, 1)],
  ])('offers the act for a stop with %s', async (_name, counts) => {
    open(() => json(200, evidenceListFixture({ items: [], parcel_photos: counts })), OFFICER);

    expect(
      await screen.findByRole('link', { name: 'Let the count through without photos' }),
    ).toBeVisible();
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
    test: async () => {
      // The photos arrive while the page is open: what was read says when it was read, and a refresh that fails keeps the photos that were read and says so.
      let read = 0;
      const { user } = open(() => {
        read += 1;
        return read === 1 ? json(200, evidenceListFixture()) : refusal(503, 'SERVICE_UNAVAILABLE');
      });
      const panel = within(await photosPanel());
      expect(await panel.findByText(/^Updated /)).toBeVisible();
      await user.click(panel.getByRole('button', { name: 'Refresh' }));
      expect(await panel.findByText(/Refresh failed\. Last successful check: /)).toBeVisible();
      expect(panel.getByText('1 of 1 parcel photos uploaded.')).toBeVisible();
    },
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
