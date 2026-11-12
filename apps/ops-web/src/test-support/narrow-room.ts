import { vi } from 'vitest';

/**
 * A queue draws every row as a row of a table or, in a room under 40rem, as a card: the table measures its own box, and jsdom measures nothing, so a test that reads cards tells
 * the table that its room is narrow. Each test therefore says which of the two it reads. `restoreRoom` undoes it, after each test.
 */
export function narrowRoom(): void {
  class Observer {
    observe(): void {
      // Nothing is told: the table measures its box itself when it is first drawn (a layout effect), which is what this room answers. A browser tells an observer at the next frame, never inside the
      // call, and an update flushed inside a lifecycle is refused by React.
    }
    unobserve(): void {
      // Nothing is watched: the room is answered by the first measure.
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
