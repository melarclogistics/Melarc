import { vi } from 'vitest';

/**
 * A queue draws every row as a row of a table or, in a room under 40rem, as a card: the table measures its own box, and jsdom measures nothing, so a test that reads cards tells
 * the table that its room is narrow. Each test therefore says which of the two it reads. `restoreRoom` undoes it, after each test.
 */
export function narrowRoom(): void {
  class Observer {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(): void {
      this.callback([], this);
    }
    unobserve(): void {
      // Nothing is watched: the room was told, once, when the table began to observe.
    }
    disconnect(): void {
      // As above.
    }
  }
  vi.stubGlobal('ResizeObserver', Observer);
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => 300,
  });
}

/** The room is measured by the browser again (that is, by nothing): the table draws its rows. */
export function restoreRoom(): void {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
}
