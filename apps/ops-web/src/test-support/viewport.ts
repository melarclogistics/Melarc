import type { Viewport } from '../platform/viewport/use-viewport';

/** A width, in px, inside each size the shell tells (`use-viewport.ts`): 390 is a phone, 900 a tablet and 1440 a desktop. */
const WIDTHS: Readonly<Record<Viewport, number>> = { narrow: 390, medium: 900, wide: 1440 };

/** What `matchMedia` answers for the two queries the shell asks, for a window of `width` px at the browser's 16px of text. */
function matches(query: string, width: number): boolean {
  const limit = /\((max|min)-width:\s*([\d.]+)rem\)/.exec(query);
  if (limit === null) return false;
  const px = Number(limit[2]) * 16;
  return limit[1] === 'max' ? width <= px : width >= px;
}

/**
 * Gives the window the size the shell is told about (a size, or a width in px), for a component test: jsdom has no `matchMedia`, and without one the shell is wide. Returns what
 * puts it back, and a function that resizes the window while the test runs (the listeners of the queries are told, as a browser tells them).
 * Call `restore` in `afterEach`. It is set on the window itself and not as a stubbed global, so that the stand-in of the API putting the network back
 * does not take the window's size with it.
 */
export function stubViewport(viewport: Viewport | number) {
  const widthOf = (given: Viewport | number): number =>
    typeof given === 'number' ? given : WIDTHS[given];
  let width = widthOf(viewport);
  const lists = new Set<{ query: string; listeners: Set<() => void> }>();
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => {
      const entry = { query, listeners: new Set<() => void>() };
      lists.add(entry);
      return {
        media: query,
        get matches() {
          return matches(query, width);
        },
        addEventListener: (_type: string, listener: () => void) => {
          entry.listeners.add(listener);
        },
        removeEventListener: (_type: string, listener: () => void) => {
          entry.listeners.delete(listener);
        },
      };
    },
  });
  return {
    resize: (next: Viewport | number) => {
      width = widthOf(next);
      for (const { listeners } of [...lists]) for (const listener of [...listeners]) listener();
    },
    restore: () => {
      Reflect.deleteProperty(window, 'matchMedia');
    },
  };
}
