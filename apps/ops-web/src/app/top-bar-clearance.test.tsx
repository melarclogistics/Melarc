import { act, render } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TOP_BAR_HEIGHT_PROPERTY, useTopBarClearance } from './top-bar-clearance';

/**
 * The scroll padding of the root is the height the sticky top bar has now (audit B2, 7 November 2026). jsdom has no layout and no ResizeObserver, so
 * both are stood in: the bar's height is what the test says, and the observer is a hand that the test pulls. What a browser does with the property is
 * proved in `test/browser/shell.spec.ts` (Shift+Tab up a long list, with text at 100% and 200%).
 */
let height = 56;
let observed: (() => void) | undefined;
let disconnected = 0;

class FakeObserver {
  constructor(callback: () => void) {
    observed = callback;
  }
  observe(): void {
    // The browser calls the observer once when it starts to watch: the test pulls it by hand.
  }
  disconnect(): void {
    disconnected += 1;
  }
  unobserve(): void {
    // Not used.
  }
}

function Harness({ sticky = true }: { readonly sticky?: boolean }) {
  const [bar, setBar] = useState<HTMLElement | null>(null);
  useTopBarClearance(bar, sticky);
  return <div ref={setBar} data-testid="bar" />;
}

const published = (): string =>
  document.documentElement.style.getPropertyValue(TOP_BAR_HEIGHT_PROPERTY);

beforeEach(() => {
  height = 56;
  observed = undefined;
  disconnected = 0;
  vi.stubGlobal('ResizeObserver', FakeObserver);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({ height, width: 0, top: 0, left: 0, right: 0, bottom: height, x: 0, y: 0 }) as DOMRect,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.documentElement.style.removeProperty(TOP_BAR_HEIGHT_PROPERTY);
});

describe('the clearance of the sticky top bar', () => {
  // Break caught: a padding written for the one row of the bar, which leaves a control under the second row when the bar wraps.
  it('publishes the height the bar has, and again when it changes', () => {
    render(<Harness />);
    expect(published()).toBe('56px');

    height = 128;
    act(() => {
      observed?.();
    });

    expect(published()).toBe('128px');
  });

  // Break caught: a stale measure left on the root after the layout that made the bar stick has gone (a sign-out to a page with no sidebar).
  it('takes the property away when the bar goes, and stops watching it', () => {
    const view = render(<Harness />);
    expect(published()).toBe('56px');

    view.unmount();

    expect(published()).toBe('');
    expect(disconnected).toBeGreaterThan(0);
  });

  it('publishes nothing for a layout in which the bar does not stick', () => {
    render(<Harness sticky={false} />);

    expect(published()).toBe('');
    expect(observed).toBeUndefined();
  });

  // Break caught: "0px" published for a bar that is not drawn, which would make the page scroll its headings under whatever is at the top.
  it('leaves the property out while the bar has no height, so that the token of one row applies', () => {
    height = 0;
    render(<Harness />);

    expect(published()).toBe('');
  });

  it('works in a browser that cannot observe sizes, with the one measure it has', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    render(<Harness />);

    expect(published()).toBe('56px');
  });
});
