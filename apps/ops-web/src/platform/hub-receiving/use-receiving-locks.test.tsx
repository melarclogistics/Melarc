import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { errorResponse, installFakeApi, json, type FakeApi } from '../../test-support/fake-api';
import {
  KENTE_INTAKE_ID,
  SHEA_INTAKE_ID,
  photoVendorFixture,
} from '../../test-support/receiving-fixture';
import { renderWithProviders } from '../../test-support/render-providers';
import {
  LOCK_REFRESH_MS,
  useReceivingLocks,
  type ReceivingLocks,
  type ReceivingLocksOptions,
} from './use-receiving-locks';

/**
 * The receive locks of a run's page (S1.35c; OB-S1-108). **The lock is taken on the officer's first act on a vendor and not by opening the page**, kept every minute while the page is open and visible
 * and at once when it becomes visible again, left alone while it is hidden and once the page has gone, and **a request for it that fails says the lock cannot be checked** (a lock that is not answered is never
 * shown as the officer's), until one is answered. It is advisory: it never fails an act and never blocks one.
 */
let api: FakeApi;
let locks: ReceivingLocks | undefined;

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'],
  });
});
afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
  vi.useRealTimers();
  locks = undefined;
});

function Probe({ options }: { readonly options?: ReceivingLocksOptions }) {
  locks = useReceivingLocks(options);
  return null;
}

const lockRequests = (id = KENTE_INTAKE_ID) =>
  api.requests.filter(
    (request) => new URL(request.url).pathname === `/api/v1/hub-intakes/${id}/lock`,
  );
const tick = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const setVisibility = (state: 'visible' | 'hidden') => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
};

const answerLock = (id: string) => () =>
  json(200, { ...photoVendorFixture(2), id, count_phase: 'CHECK_IN' });

function mount(handlers: Parameters<typeof installFakeApi>[0], options?: ReceivingLocksOptions) {
  api = installFakeApi(handlers);
  return renderWithProviders(<Probe {...(options === undefined ? {} : { options })} />, {
    signedIn: true,
  });
}

describe('the lock of a run’s page', () => {
  // Break caught: a lock taken by opening the page: the officer who only looks at the run would be shown as checking it in.
  it('is not taken by opening the page', async () => {
    mount({});
    await tick(LOCK_REFRESH_MS * 3);
    expect(lockRequests()).toHaveLength(0);
  });

  // Break caught: a lock taken again at every act (a request for each tap), or not taken at the first.
  it('is taken at the first act on a vendor, once, and says it was answered', async () => {
    mount({ [`POST /hub-intakes/${KENTE_INTAKE_ID}/lock`]: answerLock(KENTE_INTAKE_ID) });
    expect(locks?.status(KENTE_INTAKE_ID)).toBeUndefined();
    await act(async () => {
      await locks?.ensure(KENTE_INTAKE_ID);
      await locks?.ensure(KENTE_INTAKE_ID);
    });
    expect(lockRequests()).toHaveLength(1);
    expect(locks?.status(KENTE_INTAKE_ID)).toBe('ok');
  });

  // Break caught: two taps at once taking the lock twice.
  it('is asked for once when two acts begin together', async () => {
    mount({ [`POST /hub-intakes/${KENTE_INTAKE_ID}/lock`]: answerLock(KENTE_INTAKE_ID) });
    await act(async () => {
      await Promise.all([locks?.ensure(KENTE_INTAKE_ID), locks?.ensure(KENTE_INTAKE_ID)]);
    });
    expect(lockRequests()).toHaveLength(1);
  });

  // Break caught: a lock kept by a timer that never starts, or that runs while the page is hidden.
  it('is refreshed every minute while the page is visible, for each vendor acted on', async () => {
    mount({
      [`POST /hub-intakes/${KENTE_INTAKE_ID}/lock`]: answerLock(KENTE_INTAKE_ID),
      [`POST /hub-intakes/${SHEA_INTAKE_ID}/lock`]: answerLock(SHEA_INTAKE_ID),
    });
    await act(async () => {
      await locks?.ensure(KENTE_INTAKE_ID);
      await locks?.ensure(SHEA_INTAKE_ID);
    });
    await tick(LOCK_REFRESH_MS);
    expect(lockRequests()).toHaveLength(2);
    expect(lockRequests(SHEA_INTAKE_ID)).toHaveLength(2);
    await tick(LOCK_REFRESH_MS);
    expect(lockRequests()).toHaveLength(3);
  });

  it('is left alone while the page is hidden and refreshed at once when it is visible again', async () => {
    mount({ [`POST /hub-intakes/${KENTE_INTAKE_ID}/lock`]: answerLock(KENTE_INTAKE_ID) });
    await act(async () => {
      await locks?.ensure(KENTE_INTAKE_ID);
    });
    setVisibility('hidden');
    await tick(LOCK_REFRESH_MS * 3);
    expect(lockRequests()).toHaveLength(1);
    setVisibility('visible');
    await tick(0);
    expect(lockRequests()).toHaveLength(2);
    await tick(LOCK_REFRESH_MS);
    expect(lockRequests()).toHaveLength(3);
  });

  // Break caught: a lock still refreshed after the page has gone.
  it('is left alone once the page has gone', async () => {
    const view = mount({
      [`POST /hub-intakes/${KENTE_INTAKE_ID}/lock`]: answerLock(KENTE_INTAKE_ID),
    });
    await act(async () => {
      await locks?.ensure(KENTE_INTAKE_ID);
    });
    view.unmount();
    await tick(LOCK_REFRESH_MS * 3);
    expect(lockRequests()).toHaveLength(1);
  });

  // Break caught (the review of Stage 6): a refresh that failed after a success leaves the page saying the lock is the officer's.
  it('says it cannot check the lock when a refresh fails after a success, and says it is checked again when one is answered', async () => {
    let fail = false;
    mount({
      [`POST /hub-intakes/${KENTE_INTAKE_ID}/lock`]: () =>
        fail ? errorResponse(503, 'SERVICE_UNAVAILABLE') : answerLock(KENTE_INTAKE_ID)(),
    });
    await act(async () => {
      await locks?.ensure(KENTE_INTAKE_ID);
    });
    expect(locks?.status(KENTE_INTAKE_ID)).toBe('ok');
    fail = true;
    await tick(LOCK_REFRESH_MS);
    expect(locks?.status(KENTE_INTAKE_ID)).toBe('cannot-check');
    fail = false;
    await tick(LOCK_REFRESH_MS);
    expect(locks?.status(KENTE_INTAKE_ID)).toBe('ok');
  });

  // Break caught: a lock that cannot be taken at the first act blocks the act, or is shown as taken.
  it('lets the act go on when the first request fails, and says the lock cannot be checked', async () => {
    mount({
      [`POST /hub-intakes/${KENTE_INTAKE_ID}/lock`]: () =>
        errorResponse(503, 'SERVICE_UNAVAILABLE'),
    });
    let finished = false;
    await act(async () => {
      await locks?.ensure(KENTE_INTAKE_ID);
      finished = true;
    });
    expect(finished).toBe(true);
    expect(locks?.status(KENTE_INTAKE_ID)).toBe('cannot-check');
  });

  // Break caught: a lock the API refuses for good (authority, a vendor that is not there) asked for every minute.
  it('stops asking for a vendor whose lock the API refuses for good, and keeps asking for one that was only too fast', async () => {
    mount({
      [`POST /hub-intakes/${KENTE_INTAKE_ID}/lock`]: () => errorResponse(403, 'PERMISSION_DENIED'),
      [`POST /hub-intakes/${SHEA_INTAKE_ID}/lock`]: () => errorResponse(429, 'RATE_LIMITED'),
    });
    await act(async () => {
      await locks?.ensure(KENTE_INTAKE_ID);
      await locks?.ensure(SHEA_INTAKE_ID);
    });
    await tick(LOCK_REFRESH_MS * 2);
    expect(lockRequests()).toHaveLength(1);
    expect(lockRequests(SHEA_INTAKE_ID)).toHaveLength(3);
    expect(locks?.status(KENTE_INTAKE_ID)).toBe('cannot-check');
  });

  it('tells the page after each refresh, so that it can read who holds the locks now', async () => {
    const onRefreshed = vi.fn();
    mount(
      { [`POST /hub-intakes/${KENTE_INTAKE_ID}/lock`]: answerLock(KENTE_INTAKE_ID) },
      { onRefreshed },
    );
    await act(async () => {
      await locks?.ensure(KENTE_INTAKE_ID);
    });
    expect(onRefreshed).not.toHaveBeenCalled();
    await tick(LOCK_REFRESH_MS);
    expect(onRefreshed).toHaveBeenCalledTimes(1);
  });
});
