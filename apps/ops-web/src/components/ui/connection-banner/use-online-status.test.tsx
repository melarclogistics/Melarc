import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useOnlineStatus } from './use-online-status';

/**
 * Whether the browser says it is online (`navigator.onLine`), kept current by the window's `online` and `offline` events. It is what the browser says and no more: a browser that says online can still fail to reach
 * the server, which is why a page that has seen a request fail says so itself (`ConnectionBanner`, `requestFailed`).
 */
function Status() {
  return <p>{useOnlineStatus() ? 'online' : 'offline'}</p>;
}

const browserSays = (online: boolean): void => {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(online);
};
const goes = (event: 'online' | 'offline', online: boolean): void => {
  browserSays(online);
  act(() => {
    window.dispatchEvent(new Event(event));
  });
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useOnlineStatus', () => {
  // Break caught: a page that starts out saying online when the browser is already offline (a tablet carried into the stockroom with the page open).
  it.each([
    [true, 'online'],
    [false, 'offline'],
  ])('starts as the browser says: %s', (online, shown) => {
    browserSays(online);

    render(<Status />);

    expect(screen.getByText(shown)).toBeInTheDocument();
  });

  // Break caught: a status that is read once and never again, or that listens to one of the two events only.
  it('follows the browser offline and back online', () => {
    browserSays(true);
    render(<Status />);

    goes('offline', false);
    expect(screen.getByText('offline')).toBeInTheDocument();

    goes('online', true);
    expect(screen.getByText('online')).toBeInTheDocument();
  });

  // Break caught: a listener left on the window after the page is gone (a component that is drawn again and again adds one each time).
  it('stops listening when it is gone, and listens to nothing else', () => {
    const added = vi.spyOn(window, 'addEventListener');
    const removed = vi.spyOn(window, 'removeEventListener');
    const view = render(<Status />);
    const listened = added.mock.calls.map(([type]) => type);

    view.unmount();

    expect(listened.filter((type) => type === 'online' || type === 'offline').sort()).toEqual([
      'offline',
      'online',
    ]);
    const stopped = removed.mock.calls.map(([type]) => type);
    expect(stopped).toEqual(expect.arrayContaining(['online', 'offline']));
  });
});
