import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { cannotText } from '../../../platform/problem/capability-words';
import {
  errorResponse,
  installFakeApi,
  json,
  requestsTo,
  type FakeApi,
} from '../../../test-support/fake-api';
import { renderWithProviders } from '../../../test-support/render-providers';
import { wcagViolations } from '../../../test-support/wcag';
import { PhotoPicture, type PhotoPictureProps } from './PhotoPicture';

/**
 * The picture of one stored photo, for a tile of the photo grid and for the viewer that opens on it: it draws what the platform's link hook gives (`usePhotoLink`) and says in words what the person needs when it
 * cannot. **A tile is plain**: a placeholder until the picture is wanted, the retrieved original in a box, and the same short words for a photo that cannot be shown whatever the cause, except that a picture the
 * browser's own policy stopped is told as blocked. **The viewer's picture is the content**: it opens the photo whole with the page's words as its text alternative and tells the cause in full, in the words of
 * the one table. No address, key or identifier is ever drawn as text.
 */
const PHOTO = '5f6a7b8c-9d0e-4f1a-8b2c-3d4e5f6a7b8c';
const PATH = `/evidence/${PHOTO}/retrieval-authorization`;
const ROUTE = `POST ${PATH}`;
const ONE = 'https://store.example/photos/one.jpg?sig=one';
const TWO = 'https://store.example/photos/one.jpg?sig=two';

let api: FakeApi;
afterEach(() => {
  api.restore();
});

const link = (url: string): Response =>
  json(200, {
    method: 'GET',
    url,
    expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
  });
const links = (...answers: (() => Response)[]) => {
  let asked = 0;
  return () => {
    const answer = answers[Math.min(asked, answers.length - 1)];
    asked += 1;
    if (answer === undefined) throw new Error('no answer arranged');
    return answer();
  };
};
const asked = (): number => requestsTo(api, PATH).length;
const violation = (directive: string, blocked: string): Event =>
  Object.assign(new Event('securitypolicyviolation'), {
    effectiveDirective: directive,
    blockedURI: blocked,
  });

function picture(props: Partial<PhotoPictureProps> = {}) {
  return renderWithProviders(<PhotoPicture evidenceId={PHOTO} wanted size="tile" {...props} />, {
    signedIn: true,
  });
}
const imageOf = async (container: HTMLElement): Promise<HTMLImageElement> => {
  await waitFor(() => {
    expect(container.querySelector('img')).not.toBeNull();
  });
  const image = container.querySelector('img');
  if (image === null) throw new Error('no picture');
  return image;
};

describe('PhotoPicture as the picture of a tile', () => {
  // Break caught: sixty tiles that ask the platform for sixty links the moment a page opens, whether or not anyone will ever scroll to them.
  it('asks for nothing and draws no picture while it is not wanted', () => {
    api = installFakeApi({ [ROUTE]: () => link(ONE) });

    const { container } = picture({ wanted: false });

    expect(asked()).toBe(0);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('');
  });

  // Break caught: a tile that draws a picture the page has to name (the tile is named by the grid, and a picture with words of its own is read twice), or one that sends the address on as a referrer.
  it('draws the retrieved original as a decorative picture that is loaded lazily and sends no referrer', async () => {
    api = installFakeApi({ [ROUTE]: () => link(ONE) });

    const { container } = picture();

    const image = await imageOf(container);
    expect(image).toHaveAttribute('src', ONE);
    expect(image).toHaveAttribute('alt', '');
    expect(image).toHaveAttribute('loading', 'lazy');
    expect(image).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(image).toHaveAttribute('decoding', 'async');
    expect(asked()).toBe(1);
  });

  // Break caught: an address, a key or an identifier drawn as text, in any state of the tile.
  it('draws no address, key or identifier as text, drawn or failed', async () => {
    api = installFakeApi({ [ROUTE]: () => link(ONE) });
    const { container } = picture();
    const image = await imageOf(container);
    expect(container.textContent).not.toMatch(/store\.example|sig=|jpg|5f6a7b8c/);

    fireEvent.error(image);
    const again = await waitFor(() => {
      const next = container.querySelector('img');
      expect(next).not.toBeNull();
      return next;
    });
    if (again === null) throw new Error('no picture');
    fireEvent.error(again);

    expect(await screen.findByText('Photo not available')).toBeVisible();
    expect(container.textContent).not.toMatch(/store\.example|sig=|jpg|5f6a7b8c/);
  });

  // Break caught: a tile that stays broken because its link ran out while the tablet was put down, or one that asks without end for a photo that cannot be shown.
  it('asks for a new link once when the picture will not load, and says plainly that the photo is not available when it fails again', async () => {
    api = installFakeApi({
      [ROUTE]: links(
        () => link(ONE),
        () => link(TWO),
      ),
    });
    const { container } = picture();

    fireEvent.error(await imageOf(container));
    await waitFor(() => {
      expect(container.querySelector('img')).toHaveAttribute('src', TWO);
    });
    fireEvent.error(await imageOf(container));

    expect(await screen.findByText('Photo not available')).toBeVisible();
    expect(container.querySelector('img')).toBeNull();
    expect(asked()).toBe(2);
  });

  // Break caught: a picture the browser's own policy stopped, told as a photo that is not available (the officer is left to think the photo is gone, when the portal's settings are what is wrong).
  it('tells a picture that the browser blocked as blocked, and asks for no new link', async () => {
    api = installFakeApi({ [ROUTE]: () => link(ONE) });
    const { container } = picture();
    const image = await imageOf(container);

    act(() => {
      window.dispatchEvent(violation('img-src', 'https://store.example'));
      fireEvent.error(image);
    });

    expect(await screen.findByText('Photo blocked')).toBeVisible();
    expect(screen.queryByText('Photo not available')).toBeNull();
    expect(asked()).toBe(1);
  });

  // Break caught: sixty tiles each telling a refusal in a sentence, or the key of a permission drawn on a tile: a tile that cannot be drawn says one plain thing.
  it('says only that the photo is not available when the platform would not give a link', async () => {
    api = installFakeApi({ [ROUTE]: () => errorResponse(403, 'PERMISSION_DENIED') });

    const { container } = picture();

    expect(await screen.findByText('Photo not available')).toBeVisible();
    expect(container.textContent).not.toMatch(/account|permission|administrator/i);
    expect(screen.queryByRole('button')).toBeNull();
    expect(asked()).toBe(1);
  });
});

describe('PhotoPicture as the picture of the viewer', () => {
  const full = (props: Partial<PhotoPictureProps> = {}) =>
    picture({
      size: 'full',
      alt: 'Parcel 3, taken 12 Nov 2026, 10:42',
      reading: { permission: 'pickup.read', capability: 'see pickup runs' },
      ...props,
    });

  // Break caught: a viewer that says nothing while the link is on its way, so that the officer looks at an empty box.
  it('says that it is opening the photo while the link is on its way', () => {
    api = installFakeApi({ [ROUTE]: () => new Promise<Response>(() => undefined) });

    full();

    expect(screen.getByRole('status')).toHaveTextContent('Opening the photo…');
  });

  // Break caught: a picture that is the content of the viewer drawn with no text alternative (an unnamed image), or with the address for a name.
  it('draws the photo whole, with the page’s words as its text alternative', async () => {
    api = installFakeApi({ [ROUTE]: () => link(ONE) });

    const { container } = full();

    const image = await screen.findByRole('img', { name: 'Parcel 3, taken 12 Nov 2026, 10:42' });
    expect(image).toHaveAttribute('src', ONE);
    expect(image).not.toHaveAttribute('loading', 'lazy');
    expect(image).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(await wcagViolations(container)).toEqual([]);
  });

  // Break caught: a renewal asked for again and again, or a failure that says nothing.
  it('asks for a new link once, and tells in full that the photo could not be shown when that fails too', async () => {
    api = installFakeApi({
      [ROUTE]: links(
        () => link(ONE),
        () => link(TWO),
      ),
    });
    full();

    fireEvent.error(await screen.findByRole('img'));
    await waitFor(() => {
      expect(screen.getByRole('img')).toHaveAttribute('src', TWO);
    });
    fireEvent.error(screen.getByRole('img'));

    expect(
      await screen.findByText(/The photo could not be shown, even with a new link/),
    ).toBeVisible();
    expect(screen.queryByRole('img')).toBeNull();
    expect(asked()).toBe(2);
  });

  // Break caught: a policy block told as a link that ran out, so that the officer retries what cannot work.
  it('tells a photo that the browser blocked as blocked, and blames neither the link nor the connection', async () => {
    api = installFakeApi({ [ROUTE]: () => link(ONE) });
    full();
    const image = await screen.findByRole('img');

    act(() => {
      window.dispatchEvent(violation('img-src', 'https://store.example'));
      fireEvent.error(image);
    });

    expect(await screen.findByText(/The browser blocked this photo/)).toBeVisible();
    expect(screen.queryByText(/ran out|run out|did not answer|new link/)).toBeNull();
    expect(asked()).toBe(1);
  });

  // Break caught: a refusal told in words the page wrote, or by the key of the permission: the words are the table's, by what the account holds.
  it.each([
    [
      'a stop’s photo',
      { permission: 'pickup.read', capability: 'see pickup runs' } as const,
      cannotText('pickup.read', 'see pickup runs'),
    ],
    [
      'a counted intake’s photo',
      { permission: 'hub.read', context: 'intake' } as const,
      cannotText('hub.read'),
    ],
  ])('tells a refusal to read %s in the table’s words', async (_name, reading, words) => {
    api = installFakeApi({ [ROUTE]: () => errorResponse(403, 'PERMISSION_DENIED') });

    full({ reading });

    expect(await screen.findByText(words)).toBeVisible();
    // A refusal for want of a permission is the kit's forbidden state, with its heading: told by what the account holds, and never by the key.
    expect(screen.getByText('You do not have access')).toBeVisible();
    expect(screen.queryByText(/pickup\.read|hub\.read/)).toBeNull();
  });

  // Break caught: the kind of photo (a stop's or a counted intake's) not passed on, so that a photo that is not stored yet is told in the other kind's words.
  it.each([
    [
      'a stop’s photo',
      { permission: 'pickup.read', capability: 'see pickup runs' } as const,
      'This photo is not stored yet, so it cannot be opened. It appears here once the rider’s upload is complete.',
    ],
    [
      'a counted intake’s photo',
      { permission: 'hub.read', context: 'intake' } as const,
      'This photo is not stored yet, so it cannot be opened.',
    ],
  ])(
    'tells a photo that is not stored yet in the words of the kind of photo: %s',
    async (_name, reading, words) => {
      api = installFakeApi({ [ROUTE]: () => errorResponse(409, 'EVIDENCE_NOT_STORED') });

      full({ reading });

      expect(await screen.findByText(words)).toBeVisible();
    },
  );

  // Break caught: a "Try again" that goes nowhere, or one that is not offered for a platform that was only unavailable.
  it('offers to try again when the platform was unavailable, and draws the photo when it answers', async () => {
    api = installFakeApi({
      [ROUTE]: links(
        () => errorResponse(503, 'SERVICE_UNAVAILABLE'),
        () => link(ONE),
      ),
    });
    const user = userEvent.setup();
    full();

    await user.click(await screen.findByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('img')).toHaveAttribute('src', ONE);
    expect(asked()).toBe(2);
  });

  // Break caught: a failure told in words that are not in the one table (the dialog of Part 2 says this one in these words).
  it('says that the photo could not be opened, in the words of the table, when the platform was unavailable', async () => {
    api = installFakeApi({ [ROUTE]: () => errorResponse(503, 'SERVICE_UNAVAILABLE') });

    full();

    expect(
      await screen.findByText('This photo could not be opened. Close it and try again.'),
    ).toBeVisible();
  });
});
