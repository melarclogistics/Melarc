import { vi } from 'vitest';

/**
 * A table's box of a width, in jsdom, which measures nothing: the box, the probe of no height and the table's root are `width` px wide (`clientWidth`), and the box **scrolls sideways**
 * (`scrollWidth` is more than its `clientWidth`) while the header cells it draws, which are what the columns that are drawn need, add up to more than `width`: `need` px for each. `resize`
 * changes the width and tells every observer of it, as a browser does; `restoreTableRoom` puts the measuring back to nothing, after each test.
 */
export function tableRoom(initialWidth: number, need = 200) {
  let width = initialWidth;
  const observers = new Set<ResizeObserverCallback>();
  class Observer {
    constructor(private readonly callback: ResizeObserverCallback) {
      observers.add(callback);
    }
    observe(): void {
      // Nothing is told when a box begins to be watched: a browser tells it at the next frame, which `resize` stands in for.
    }
    unobserve(): void {
      // As above.
    }
    disconnect(): void {
      observers.delete(this.callback);
    }
  }
  vi.stubGlobal('ResizeObserver', Observer);
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement): number {
      return this.matches('.ui-data-table, .ui-data-table__scroller, .ui-data-table__probe')
        ? width
        : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
    configurable: true,
    get(this: HTMLElement): number {
      return this.matches('.ui-data-table__scroller')
        ? Math.max(width, need * this.querySelectorAll('thead th').length)
        : 0;
    },
  });
  return {
    resize(next: number): void {
      width = next;
      for (const callback of [...observers]) callback([], {} as ResizeObserver);
    },
  };
}

/** The measuring of a table's box is the browser's again, that is, nothing's. */
export function restoreTableRoom(): void {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollWidth');
}
