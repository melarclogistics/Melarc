import { focusManager } from '@tanstack/react-query';
import { act, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { errorResponse, installFakeApi, json, type FakeApi } from '../../test-support/fake-api';
import {
  INTAKE_ID,
  INTAKE_RECEIVER_ID,
  OTHER_INTAKE_ID,
  PLANTED_DECLARATION,
  intakePage,
  postCountFixture,
  preCountFixture,
} from '../../test-support/hub-intake-fixture';
import { renderWithProviders } from '../../test-support/render-providers';
import {
  LOCK_REFRESH_MS,
  useHubIntake,
  useHubIntakes,
  useIntakeLock,
  type IntakeLock,
} from './use-hub-intake-queries';

/**
 * The reads of the receiving screens are the one place a request for each is made, so they are where a filter is kept off the wire unless it was given, where nothing is read again on focus
 * (every accepted request is activity), where nothing is kept once the screen lets go, and where the receiver's lock is kept for as long as its page is open and visible: taken when the page opens,
 * refreshed every minute while it is visible, refreshed at once when it becomes visible again, left alone while hidden and once the page has gone, and given up for good only when the API refuses it for good.
 */
let api: FakeApi;

afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
  vi.useRealTimers();
});

function Probe<Result>({
  use,
  into,
}: {
  readonly use: () => Result;
  readonly into: (result: Result) => void;
}) {
  into(use());
  return null;
}

/** Time moves, and what React was told in the meantime is drawn. */
const tick = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

const listRequests = () =>
  api.requests.filter((request) => new URL(request.url).pathname === '/api/v1/hub-intakes');

describe('the list of intakes', () => {
  const ask = async (params: Parameters<typeof useHubIntakes>[0]) => {
    api = installFakeApi({ 'GET /hub-intakes': () => json(200, intakePage([preCountFixture()])) });
    const view = renderWithProviders(
      <Probe use={() => useHubIntakes(params)} into={() => undefined} />,
      { signedIn: true },
    );
    await waitFor(() => {
      expect(listRequests()).toHaveLength(1);
    });
    return view;
  };

  it('asks for no filter when none is given', async () => {
    await ask({});
    expect([...new URL(listRequests()[0]?.url ?? 'http://x/').searchParams.keys()]).toEqual([]);
  });

  // Break caught: a filter that is not sent, or sent twice, or a hub filter the operation does not have: the page filters nothing, so a dropped parameter would pass for the whole queue.
  it('asks for the state and the page it is given, each as the contract names it, and no hub', async () => {
    await ask({ state: 'AWAITING_COUNT', pageToken: 'next-1' });
    const query = new URL(listRequests()[0]?.url ?? 'http://x/').searchParams;
    expect(query.get('state')).toBe('AWAITING_COUNT');
    expect(query.get('page_token')).toBe('next-1');
    expect(query.getAll('state')).toHaveLength(1);
    expect(query.has('hub_id')).toBe(false);
  });

  it('asks nothing while it is not enabled', async () => {
    api = installFakeApi({});
    renderWithProviders(
      <Probe use={() => useHubIntakes({ enabled: false })} into={() => undefined} />,
      { signedIn: true },
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(listRequests()).toHaveLength(0);
  });

  // Break caught: a queue read again when the window gets focus: every accepted request is activity, so a page that read on its own would hold a session open.
  it('is not read again when the window gets focus again, and keeps nothing once the screen lets go', async () => {
    const view = await ask({});
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(listRequests()).toHaveLength(1);

    view.unmount();
    await waitFor(() => {
      expect(view.queryClient.getQueryCache().findAll({ queryKey: ['hub-intake'] })).toHaveLength(
        0,
      );
    });
  });

  // Break caught: an answer with a declaration in a pre-count item read as a list: the shape refuses it whole, so the page shows a failure and not the number.
  it('fails as an answer that is not the API’s when an item that was not counted carries the declaration', async () => {
    api = installFakeApi({
      'GET /hub-intakes': () =>
        json(
          200,
          intakePage([{ ...preCountFixture(), rider_declared_count: PLANTED_DECLARATION }]),
        ),
    });
    let result: ReturnType<typeof useHubIntakes> | undefined;
    renderWithProviders(
      <Probe use={() => useHubIntakes({})} into={(value) => (result = value)} />,
      { signedIn: true },
    );
    await waitFor(() => {
      expect(result?.status).toBe('error');
    });
    expect(result?.data).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(String(PLANTED_DECLARATION));
  });
});

describe('one intake', () => {
  it('is read with its version, exactly as sent, and an intake of another id is refused', async () => {
    api = installFakeApi({
      [`GET /hub-intakes/${INTAKE_ID}`]: () => json(200, preCountFixture(), { ETag: '"v3"' }),
    });
    let result: ReturnType<typeof useHubIntake> | undefined;
    renderWithProviders(
      <Probe use={() => useHubIntake(INTAKE_ID)} into={(value) => (result = value)} />,
      { signedIn: true },
    );
    await waitFor(() => {
      expect(result?.data?.etag).toBe('"v3"');
    });
    expect(result?.data?.intake.count_phase).toBe('PRE_COUNT');
    api.restore();

    api = installFakeApi({
      [`GET /hub-intakes/${INTAKE_ID}`]: () =>
        json(200, preCountFixture({ id: OTHER_INTAKE_ID }), { ETag: '"v3"' }),
    });
    renderWithProviders(
      <Probe use={() => useHubIntake(INTAKE_ID)} into={(value) => (result = value)} />,
      { signedIn: true },
    );
    await waitFor(() => {
      expect(result?.status).toBe('error');
    });
  });

  // Break caught: an intake read with no version to act on, which a count would then send blind.
  it('is refused when the answer carries no version', async () => {
    api = installFakeApi({ [`GET /hub-intakes/${INTAKE_ID}`]: () => json(200, preCountFixture()) });
    let result: ReturnType<typeof useHubIntake> | undefined;
    renderWithProviders(
      <Probe use={() => useHubIntake(INTAKE_ID)} into={(value) => (result = value)} />,
      { signedIn: true },
    );
    await waitFor(() => {
      expect(result?.status).toBe('error');
    });
  });

  it('is not read again on focus', async () => {
    api = installFakeApi({
      [`GET /hub-intakes/${INTAKE_ID}`]: () => json(200, preCountFixture(), { ETag: '"v3"' }),
    });
    renderWithProviders(<Probe use={() => useHubIntake(INTAKE_ID)} into={() => undefined} />, {
      signedIn: true,
    });
    await waitFor(() => {
      expect(
        api.requests.filter((request) => request.url.includes(`/hub-intakes/${INTAKE_ID}`)),
      ).toHaveLength(1);
    });
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(
      api.requests.filter((request) => request.url.includes(`/hub-intakes/${INTAKE_ID}`)),
    ).toHaveLength(1);
  });
});

describe('the receiver’s lock', () => {
  const LOCK = `POST /hub-intakes/${INTAKE_ID}/lock`;
  const locks = () => api.requests.filter((request) => request.url.includes('/lock'));
  let lock: IntakeLock | undefined;

  const setVisibility = (state: 'visible' | 'hidden') => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    document.dispatchEvent(new Event('visibilitychange'));
  };
  const mount = (enabled = true) =>
    renderWithProviders(
      <Probe use={() => useIntakeLock(INTAKE_ID, enabled)} into={(value) => (lock = value)} />,
      { signedIn: true },
    );

  beforeEach(() => {
    lock = undefined;
    document.cookie = 'melarc_csrf=csrf-token; path=/';
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
  });
  afterEach(() => {
    delete (document as unknown as Record<string, unknown>).visibilityState;
    document.cookie = 'melarc_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
  });

  it('is taken when the page opens, and the intake it answers is what the page is told', async () => {
    api = installFakeApi({
      [LOCK]: () =>
        json(
          200,
          preCountFixture({
            active_receiver_id: INTAKE_RECEIVER_ID,
            lock_acquired_at: '2026-11-14T09:10:00Z',
          }),
        ),
    });
    mount();

    await waitFor(() => {
      expect(lock?.intake?.active_receiver_id).toBe(INTAKE_RECEIVER_ID);
    });
    expect(locks()).toHaveLength(1);
    expect(lock?.failure).toBeUndefined();
  });

  it('is not taken while the page is not enabled', async () => {
    api = installFakeApi({});
    mount(false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(locks()).toHaveLength(0);
  });

  // Break caught: a lock that is never refreshed (another receiver may then take it over while this one is still counting), or one refreshed too often (a request every few seconds is a keep-alive in disguise).
  it('is refreshed every minute while the page is open and visible, and no oftener', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api = installFakeApi({ [LOCK]: () => json(200, preCountFixture()) });
    mount();
    await tick(10);
    expect(locks()).toHaveLength(1);

    await tick(LOCK_REFRESH_MS - 1000);
    expect(locks()).toHaveLength(1);
    await tick(1000);
    expect(locks()).toHaveLength(2);
    await tick(LOCK_REFRESH_MS);
    expect(locks()).toHaveLength(3);
    expect(LOCK_REFRESH_MS).toBeLessThanOrEqual(5 * 60_000);
  });

  // Break caught: a lock kept from a tab nobody is looking at, which keeps an intake held for a receiver who has gone to lunch; and one not taken again when the person returns.
  it('is not refreshed while the page is hidden, and is taken again at once when it is visible again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api = installFakeApi({ [LOCK]: () => json(200, preCountFixture()) });
    mount();
    await tick(10);
    expect(locks()).toHaveLength(1);

    act(() => {
      setVisibility('hidden');
    });
    await tick(LOCK_REFRESH_MS * 3);
    expect(locks()).toHaveLength(1);

    act(() => {
      setVisibility('visible');
    });
    await tick(10);
    expect(locks()).toHaveLength(2);
    await tick(LOCK_REFRESH_MS);
    expect(locks()).toHaveLength(3);
  });

  // Break caught: a lock still refreshed after the page has gone: the receiver who left would hold the intake for as long as the browser lives.
  it('is left alone once the page has gone', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api = installFakeApi({ [LOCK]: () => json(200, preCountFixture()) });
    const view = mount();
    await tick(10);
    view.unmount();

    await tick(LOCK_REFRESH_MS * 3);
    expect(locks()).toHaveLength(1);
  });

  // Break caught: two requests for the lock at once (an impatient "ask again" while the last one is on its way), so that one receiver is told two things about one moment.
  it('does not ask while it is asking', async () => {
    let release: (() => void) | undefined;
    api = installFakeApi({
      [LOCK]: () =>
        new Promise<Response>((resolve) => {
          release = () => {
            resolve(json(200, preCountFixture()));
          };
        }),
    });
    mount();
    await waitFor(() => {
      expect(locks()).toHaveLength(1);
    });
    await act(async () => {
      await lock?.askAgain();
      void lock?.askAgain();
    });
    expect(locks()).toHaveLength(1);
    release?.();
  });

  it('asks again when the person asks, and is told what the server says now', async () => {
    let held = true;
    api = installFakeApi({
      [LOCK]: () =>
        json(
          200,
          held
            ? preCountFixture({
                active_receiver_id: INTAKE_RECEIVER_ID,
                lock_acquired_at: '2026-11-14T09:10:00Z',
              })
            : preCountFixture(),
        ),
    });
    mount();
    await waitFor(() => {
      expect(lock?.intake?.active_receiver_id).toBe(INTAKE_RECEIVER_ID);
    });

    held = false;
    await act(async () => {
      await lock?.askAgain();
    });
    expect(lock?.intake?.active_receiver_id).toBeNull();
    expect(locks()).toHaveLength(2);
  });

  // Break caught: a lock still kept for an intake that has been counted: whoever counted it, the page that was counting has nothing to hold.
  it('stops being kept once the intake has been counted, and says so', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api = installFakeApi({ [LOCK]: () => json(200, postCountFixture()) });
    mount();
    await tick(10);
    expect(lock?.intake?.count_phase).toBe('POST_COUNT');

    await tick(LOCK_REFRESH_MS * 2);
    expect(locks()).toHaveLength(1);
  });

  // Break caught: a refusal of the API for good (authority, an intake that is not there) tried again every minute, or a failure that may pass given up on.
  it('is given up for good on a refusal that will not pass, and tried again after one that may', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api = installFakeApi({ [LOCK]: () => errorResponse(403, 'PERMISSION_DENIED') });
    mount();
    await tick(10);
    expect(lock?.failure).toBeDefined();
    await tick(LOCK_REFRESH_MS * 3);
    expect(locks()).toHaveLength(1);
    api.restore();

    api = installFakeApi({ [LOCK]: () => errorResponse(503, 'SERVICE_UNAVAILABLE') });
    mount();
    await tick(10);
    expect(lock?.failure).toBeDefined();
    await tick(LOCK_REFRESH_MS);
    expect(locks().length).toBeGreaterThanOrEqual(2);
  });

  it('is not an unhandled failure when the request cannot be made at all', async () => {
    api = installFakeApi({});
    mount();
    await waitFor(() => {
      expect(lock?.failure).toBeDefined();
    });
    expect(api.unhandled).toEqual([`POST /hub-intakes/${INTAKE_ID}/lock`]);
    api.unhandled.length = 0;
  });

  it('never carries the declaration of an intake that has not been counted', async () => {
    api = installFakeApi({
      [LOCK]: () => json(200, { ...preCountFixture(), rider_declared_count: PLANTED_DECLARATION }),
    });
    mount();
    await waitFor(() => {
      expect(lock?.failure).toBeDefined();
    });
    expect(lock?.intake).toBeUndefined();
    expect(JSON.stringify(lock)).not.toContain(String(PLANTED_DECLARATION));
  });
});
