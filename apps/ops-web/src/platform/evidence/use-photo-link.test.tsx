import { act, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  errorResponse,
  installFakeApi,
  json,
  requestsTo,
  type FakeApi,
} from '../../test-support/fake-api';
import { renderWithProviders } from '../../test-support/render-providers';
import { usePhotoLink, type PhotoLinkView } from './use-photo-link';

/**
 * The link to the picture of one stored photo, which the tile of a grid and the viewer both draw from: **asked for only when it is wanted** (a tile near the screen), once for a photo that two things
 * draw at the same time, **renewed once** when the picture would not load (a link lives five minutes: a tablet that was put down with the page open), **replaced before it is used** when it arrives with
 * seconds left, **told as blocked** when the browser's own policy stopped the picture (a new link can never get past a policy), and **told as the read's own failure** when the platform would not give a
 * link. No address is drawn by the hook and none outlives the photo.
 */
const PHOTO = '5f6a7b8c-9d0e-4f1a-8b2c-3d4e5f6a7b8c';
const PATH = `/evidence/${PHOTO}/retrieval-authorization`;
const ROUTE = `POST ${PATH}`;
const ONE = 'https://store.example/photos/one.jpg?sig=one';
const TWO = 'https://store.example/photos/one.jpg?sig=two';

let api: FakeApi;
afterEach(() => {
  api.restore();
  vi.useRealTimers();
});

const link = (url: string, secondsLeft = 300): Response =>
  json(200, {
    method: 'GET',
    url,
    expires_at: new Date(Date.now() + secondsLeft * 1000).toISOString(),
  });
/** Answers the links in the order they are given, and the last for ever after. */
const links = (...answers: (() => Response)[]) => {
  let asked = 0;
  return () => {
    const answer = answers[Math.min(asked, answers.length - 1)];
    asked += 1;
    if (answer === undefined) throw new Error('no answer arranged');
    return answer();
  };
};
const asked = () => requestsTo(api, PATH).length;

interface Held {
  current: PhotoLinkView | undefined;
  readonly seen: PhotoLinkView['link'][];
}
const held = (): Held => ({ current: undefined, seen: [] });
function Probe({
  into,
  id = PHOTO,
  enabled = true,
}: {
  readonly into: Held;
  readonly id?: string;
  readonly enabled?: boolean;
}) {
  const view = usePhotoLink(id, enabled);
  into.current = view;
  into.seen.push(view.link);
  return null;
}
const violation = (directive: string, blocked: string): Event =>
  Object.assign(new Event('securitypolicyviolation'), {
    effectiveDirective: directive,
    blockedURI: blocked,
  });

describe('usePhotoLink', () => {
  // Break caught: sixty tiles that ask the platform for sixty links the moment a page opens, whether or not anyone will ever scroll to them.
  it('asks for nothing until it is asked to, and then once', async () => {
    api = installFakeApi({ [ROUTE]: () => link(ONE) });
    const into = held();
    const view = renderWithProviders(<Probe into={into} enabled={false} />, { signedIn: true });

    expect(into.current?.link).toEqual({ status: 'idle' });
    expect(asked()).toBe(0);

    view.rerenderUi(<Probe into={into} enabled />);
    await waitFor(() => {
      expect(into.current?.link).toEqual({ status: 'ready', url: ONE });
    });
    expect(asked()).toBe(1);
  });

  // Break caught: a link asked for by the tile and asked for again by the viewer that opens on the same photo, so that one photo costs two requests of the session.
  it('asks once for a photo that two things draw at the same time', async () => {
    api = installFakeApi({ [ROUTE]: () => link(ONE) });
    const tile = held();
    const viewer = held();
    renderWithProviders(
      <>
        <Probe into={tile} />
        <Probe into={viewer} />
      </>,
      { signedIn: true },
    );

    await waitFor(() => {
      expect(tile.current?.link).toEqual({ status: 'ready', url: ONE });
      expect(viewer.current?.link).toEqual({ status: 'ready', url: ONE });
    });
    expect(asked()).toBe(1);
  });

  // Break caught: a picture that fails once and is shown broken for ever (the link ran out while the tablet was put down), or one that asks for new links without end.
  it('asks for a new link once when the picture will not load, and is ready with it', async () => {
    api = installFakeApi({
      [ROUTE]: links(
        () => link(ONE),
        () => link(TWO),
      ),
    });
    const into = held();
    renderWithProviders(<Probe into={into} />, { signedIn: true });
    await waitFor(() => {
      expect(into.current?.link).toEqual({ status: 'ready', url: ONE });
    });

    act(() => {
      into.current?.onImageError();
    });

    await waitFor(() => {
      expect(into.current?.link).toEqual({ status: 'ready', url: TWO });
    });
    expect(asked()).toBe(2);
  });

  // Break caught: the link that has just failed drawn again while its replacement is on its way (the picture fails again at once, and the one renewal is spent on nothing).
  it('draws nothing while the new link is on its way, and not the one that failed', async () => {
    let answer: (response: Response) => void = () => undefined;
    let calls = 0;
    api = installFakeApi({
      [ROUTE]: () => {
        calls += 1;
        return calls === 1
          ? link(ONE)
          : new Promise<Response>((resolve) => {
              answer = resolve;
            });
      },
    });
    const into = held();
    renderWithProviders(<Probe into={into} />, { signedIn: true });
    await waitFor(() => {
      expect(into.current?.link).toEqual({ status: 'ready', url: ONE });
    });

    act(() => {
      into.current?.onImageError();
    });
    await waitFor(() => {
      expect(into.current?.link).toEqual({ status: 'loading' });
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(into.current?.link).toEqual({ status: 'loading' });

    act(() => {
      answer(link(TWO));
    });
    await waitFor(() => {
      expect(into.current?.link).toEqual({ status: 'ready', url: TWO });
    });
  });

  it('is told unreachable when the picture fails again with a new link, and asks for no third', async () => {
    api = installFakeApi({
      [ROUTE]: links(
        () => link(ONE),
        () => link(TWO),
      ),
    });
    const into = held();
    renderWithProviders(<Probe into={into} />, { signedIn: true });
    await waitFor(() => {
      expect(into.current?.link).toEqual({ status: 'ready', url: ONE });
    });
    act(() => {
      into.current?.onImageError();
    });
    await waitFor(() => {
      expect(into.current?.link).toEqual({ status: 'ready', url: TWO });
    });

    act(() => {
      into.current?.onImageError();
    });
    // And again: the one renewal is spent, whatever the picture does.
    act(() => {
      into.current?.onImageError();
    });

    await waitFor(() => {
      expect(into.current?.link).toEqual({ status: 'unreachable' });
    });
    expect(asked()).toBe(2);
  });

  // Break caught: a link that comes with seconds to live drawn at once, so that the picture is asked for after the store has stopped taking the link.
  it('replaces a link that arrives with seconds left before the picture is ever asked for', async () => {
    api = installFakeApi({
      [ROUTE]: links(
        () => link(ONE, 5),
        () => link(TWO),
      ),
    });
    const into = held();
    renderWithProviders(<Probe into={into} />, { signedIn: true });

    await waitFor(() => {
      expect(into.current?.link).toEqual({ status: 'ready', url: TWO });
    });

    expect(asked()).toBe(2);
    // The first link was never offered to a picture.
    expect(into.seen.some((seen) => seen.status === 'ready' && seen.url === ONE)).toBe(false);
  });

  // Break caught: a link judged by the clock at every render, so that an officer who is looking at a photo that loaded long ago sees it replaced by a spinner.
  it('judges a link once, when it arrives, and never again by the clock', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    api = installFakeApi({ [ROUTE]: () => link(ONE, 60) });
    const into = held();
    const view = renderWithProviders(<Probe into={into} />, { signedIn: true });
    await waitFor(() => {
      expect(into.current?.link).toEqual({ status: 'ready', url: ONE });
    });

    vi.setSystemTime(Date.now() + 4 * 60_000);
    view.rerenderUi(<Probe into={into} />);

    expect(into.current?.link).toEqual({ status: 'ready', url: ONE });
    expect(asked()).toBe(1);
  });

  // Break caught: a picture the browser's policy stopped, told as a link that ran out (a new link cannot get past a policy: the officer is sent to a button that can never help).
  it('tells a picture the browser blocked as blocked, and asks for no new link', async () => {
    api = installFakeApi({ [ROUTE]: () => link(ONE) });
    const into = held();
    renderWithProviders(<Probe into={into} />, { signedIn: true });
    await waitFor(() => {
      expect(into.current?.link).toEqual({ status: 'ready', url: ONE });
    });

    act(() => {
      window.dispatchEvent(violation('img-src', 'https://store.example'));
      into.current?.onImageError();
    });

    await waitFor(() => {
      expect(into.current?.link).toEqual({ status: 'blocked' });
    });
    expect(asked()).toBe(1);
  });

  // Break caught: any violation of the page taken for this picture's.
  it.each([
    ['another directive', violation('connect-src', 'https://store.example')],
    ['another address', violation('img-src', 'https://elsewhere.example')],
  ])('does not take a violation of %s for this picture’s own', async (_name, event) => {
    api = installFakeApi({
      [ROUTE]: links(
        () => link(ONE),
        () => link(TWO),
      ),
    });
    const into = held();
    renderWithProviders(<Probe into={into} />, { signedIn: true });
    await waitFor(() => {
      expect(into.current?.link).toEqual({ status: 'ready', url: ONE });
    });

    act(() => {
      window.dispatchEvent(event);
      into.current?.onImageError();
    });

    await waitFor(() => {
      expect(into.current?.link).toEqual({ status: 'ready', url: TWO });
    });
  });

  // Break caught: a link that the platform would not give told as a picture that would not load, or tried again in a loop.
  it('tells the platform’s own refusal as the read’s failure, and does not ask again by itself', async () => {
    api = installFakeApi({ [ROUTE]: () => errorResponse(403, 'PERMISSION_DENIED') });
    const into = held();
    renderWithProviders(<Probe into={into} />, { signedIn: true });

    await waitFor(() => {
      expect(into.current?.link.status).toBe('failed');
    });
    expect(into.current?.link).toMatchObject({ status: 'failed' });
    expect(asked()).toBe(1);
  });

  it('tells a new link that could not be had as the read’s failure, with no picture', async () => {
    api = installFakeApi({
      [ROUTE]: links(
        () => link(ONE),
        () => errorResponse(503, 'SERVICE_UNAVAILABLE'),
      ),
    });
    const into = held();
    renderWithProviders(<Probe into={into} />, { signedIn: true });
    await waitFor(() => {
      expect(into.current?.link).toEqual({ status: 'ready', url: ONE });
    });

    act(() => {
      into.current?.onImageError();
    });

    await waitFor(() => {
      expect(into.current?.link.status).toBe('failed');
    });
    expect(asked()).toBe(2);
  });

  // Break caught: a link kept after its photo is gone (a bearer capability that outlives the screen that asked for it): the next drawing of the photo, in the same session, asks again.
  it('keeps no link once nothing draws the photo, and asks again when it is drawn again', async () => {
    api = installFakeApi({ [ROUTE]: () => link(ONE) });
    const into = held();
    const view = renderWithProviders(<Probe into={into} />, { signedIn: true });
    await waitFor(() => {
      expect(into.current?.link).toEqual({ status: 'ready', url: ONE });
    });
    view.rerenderUi(<></>);
    // The query is dropped as soon as nothing observes it (the next turn of the event loop), and not before.
    await act(async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    });

    const again = held();
    view.rerenderUi(<Probe into={again} />);
    await waitFor(() => {
      expect(again.current?.link).toEqual({ status: 'ready', url: ONE });
    });
    expect(asked()).toBe(2);
  });

  // Break caught: the viewer that opens on a photo whose tile already holds a link, asking for a second one (two requests of the session for one photo).
  it('draws a photo from the link another already holds while it is fresh', async () => {
    api = installFakeApi({ [ROUTE]: () => link(ONE) });
    const tile = held();
    const view = renderWithProviders(<Probe into={tile} />, { signedIn: true });
    await waitFor(() => {
      expect(tile.current?.link).toEqual({ status: 'ready', url: ONE });
    });

    const viewer = held();
    view.rerenderUi(
      <>
        <Probe into={tile} />
        <Probe into={viewer} />
      </>,
    );

    await waitFor(() => {
      expect(viewer.current?.link).toEqual({ status: 'ready', url: ONE });
    });
    expect(asked()).toBe(1);
  });

  // Break caught: sixty tiles that ask at once (the limit of the session spent by a page that was only opened).
  it('asks for no more than four links at a time, and the rest as those are answered', async () => {
    const ids = Array.from(
      { length: 8 },
      (_, index) => `5f6a7b8c-9d0e-4f1a-8b2c-3d4e5f6a7b0${String(index)}`,
    );
    const open: (() => void)[] = [];
    let inFlight = 0;
    let peak = 0;
    api = installFakeApi(
      Object.fromEntries(
        ids.map((id) => [
          `POST /evidence/${id}/retrieval-authorization`,
          () =>
            new Promise<Response>((resolve) => {
              inFlight += 1;
              peak = Math.max(peak, inFlight);
              open.push(() => {
                inFlight -= 1;
                resolve(link(ONE));
              });
            }),
        ]),
      ),
    );
    const views = ids.map(() => held());
    renderWithProviders(
      <>
        {ids.map((id, index) => (
          <Probe key={id} id={id} into={views[index] ?? held()} />
        ))}
      </>,
      { signedIn: true },
    );

    await waitFor(() => {
      expect(inFlight).toBe(4);
    });
    // Each answer lets the next be asked, never more than four at once.
    while (open.length > 0) {
      const next = open.shift();
      act(() => {
        next?.();
      });
      await act(async () => {
        await Promise.resolve();
      });
    }
    await waitFor(() => {
      expect(views.every((one) => one.current?.link.status === 'ready')).toBe(true);
    });
    expect(peak).toBe(4);
  });
});
