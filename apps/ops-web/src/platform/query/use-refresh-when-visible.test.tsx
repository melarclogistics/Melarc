import { act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '../../test-support/render-providers';
import { holdOf } from './read-hold';
import { useRefreshWhenVisible } from './use-refresh-when-visible';

/**
 * The one automatic re-read of a page of work in progress, made when the page becomes visible again (the stop's photos arrive while the officer is elsewhere). It reads nothing on a focus, a reconnection or a
 * timer, goes through the hold of the API's `429`, and is dropped with the page.
 */
function Probe({
  read,
  enabled = true,
}: {
  readonly read: () => void;
  readonly enabled?: boolean;
}) {
  useRefreshWhenVisible('probe', read, enabled);
  return <p>A page</p>;
}

/** The page is shown or hidden as the browser says it: the state, and the event that follows it. */
function becomes(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

afterEach(() => {
  delete (document as unknown as Record<string, unknown>).visibilityState;
  vi.useRealTimers();
});

describe('reading again when the page becomes visible', () => {
  // Break caught: a page that is shown again with what it showed when it was put down.
  it('reads again each time the page becomes visible', () => {
    const read = vi.fn();
    renderWithProviders(<Probe read={read} />, { signedIn: true });

    becomes('visible');
    becomes('visible');

    expect(read).toHaveBeenCalledTimes(2);
  });

  // Break caught: a read made when the page is put down, which keeps working for a person who has walked away.
  it('reads nothing when the page is hidden', () => {
    const read = vi.fn();
    renderWithProviders(<Probe read={read} />, { signedIn: true });

    becomes('hidden');

    expect(read).not.toHaveBeenCalled();
  });

  // Break caught: a re-read on a focus, a reconnection or a timer, which the portal never makes (a session kept alive by a page nobody looks at).
  it('reads nothing on a focus, a reconnection or a timer', async () => {
    const read = vi.fn();
    renderWithProviders(<Probe read={read} />, { signedIn: true });

    vi.useFakeTimers();
    act(() => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('online'));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    });

    expect(read).not.toHaveBeenCalled();
  });

  // Break caught: an automatic read sent while the API has asked the page to wait, or sent many times when the wait ends.
  it('waits out a hold the API asked for, and reads once when it ends', () => {
    const read = vi.fn();
    const view = renderWithProviders(<Probe read={read} />, { signedIn: true });
    const hold = holdOf(view.queryClient);
    act(() => {
      hold.hold(30);
    });

    becomes('visible');
    becomes('visible');
    expect(read).not.toHaveBeenCalled();
    act(() => {
      hold.release();
    });

    expect(read).toHaveBeenCalledTimes(1);
  });

  // Break caught: a page that has gone, still read for by a listener that was left behind, or a read that was waiting for a hold sent after the page was left.
  it('stops with the page, and sends nothing that waited for it', () => {
    const read = vi.fn();
    const view = renderWithProviders(<Probe read={read} />, { signedIn: true });
    const hold = holdOf(view.queryClient);
    act(() => {
      hold.hold(30);
    });
    becomes('visible');

    view.unmount();
    act(() => {
      hold.release();
    });
    becomes('visible');

    expect(read).not.toHaveBeenCalled();
  });

  it('asks nothing while it is told not to', () => {
    const read = vi.fn();
    renderWithProviders(<Probe read={read} enabled={false} />, { signedIn: true });

    becomes('visible');

    expect(read).not.toHaveBeenCalled();
  });

  // Break caught: a read that is the first one the page gave, when the page has changed what it reads since.
  it('calls the latest read the page gave', () => {
    const first = vi.fn();
    const second = vi.fn();
    const view = renderWithProviders(<Probe read={first} />, { signedIn: true });
    view.rerenderUi(<Probe read={second} />);

    becomes('visible');

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
