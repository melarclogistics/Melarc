import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { KEYBOARD_INSET_PROPERTY, keyboardInset, useKeyboardInset } from './use-keyboard-inset';

/**
 * The inset the on-screen keyboard leaves at the foot of the page (the hub floor's action bar must be reachable with the keyboard open at 768 px): read from the visual viewport, kept in one custom property of the
 * root while the page is open, and removed when it goes.
 */
class FakeViewport extends EventTarget {
  height = 1024;
  offsetTop = 0;
}

let viewport: FakeViewport;
const rootValue = (): string =>
  document.documentElement.style.getPropertyValue(KEYBOARD_INSET_PROPERTY);

function Probe() {
  useKeyboardInset();
  return null;
}

beforeEach(() => {
  viewport = new FakeViewport();
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1024 });
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
});
afterEach(() => {
  document.documentElement.style.removeProperty(KEYBOARD_INSET_PROPERTY);
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: null });
});

describe('the keyboard’s inset', () => {
  // Break caught: an inset worked out from the window alone (no keyboard is ever seen), or one that is negative when the page is zoomed.
  it('is what the window has and the visual viewport does not, and never negative', () => {
    expect(keyboardInset()).toBe(0);
    viewport.height = 604;
    expect(keyboardInset()).toBe(420);
    viewport.height = 604;
    viewport.offsetTop = 100;
    expect(keyboardInset()).toBe(320);
    viewport.height = 1500;
    expect(keyboardInset()).toBe(0);
  });

  // Break caught: a page that stops with a TypeError where the document has no visual viewport at all (`undefined`, as a test document and an old browser have), not only where it says it has none (`null`).
  it.each([[null], [undefined]])('is nothing for a browser whose visual viewport is %s', (none) => {
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: none });
    expect(keyboardInset()).toBe(0);
  });
});

describe('useKeyboardInset', () => {
  // Break caught: an inset written once and never kept, so that a bar stays behind a keyboard that opened after the page; or one that is written as an attribute (the strict policy refuses it).
  it('writes the inset to the root at once and keeps it as the visual viewport changes', () => {
    render(<Probe />);
    expect(rootValue()).toBe('0px');

    act(() => {
      viewport.height = 604;
      viewport.dispatchEvent(new Event('resize'));
    });
    expect(rootValue()).toBe('420px');

    act(() => {
      viewport.offsetTop = 100;
      viewport.dispatchEvent(new Event('scroll'));
    });
    expect(rootValue()).toBe('320px');
    expect(document.documentElement.getAttribute('style') ?? '').toContain(KEYBOARD_INSET_PROPERTY);
  });

  // Break caught: the property left on the root after the page has gone, lifting the foot of every other page.
  it('takes the property off the root and stops listening when the page goes', () => {
    const view = render(<Probe />);
    act(() => {
      viewport.height = 604;
      viewport.dispatchEvent(new Event('resize'));
    });
    view.unmount();
    expect(rootValue()).toBe('');
    viewport.height = 504;
    viewport.dispatchEvent(new Event('resize'));
    expect(rootValue()).toBe('');
  });

  it.each([[null], [undefined]])(
    'does nothing in a browser whose visual viewport is %s',
    (none) => {
      Object.defineProperty(window, 'visualViewport', { configurable: true, value: none });
      render(<Probe />);
      expect(rootValue()).toBe('');
    },
  );
});
