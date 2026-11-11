import { vi } from 'vitest';

/**
 * A table's box of a width, in jsdom, which measures nothing: the box, the probe of no height and the table's root are `width` px wide (`clientWidth`), and the box **scrolls sideways**
 * (`scrollWidth` is more than its `clientWidth`) while the header cells it draws, which are what the columns that are drawn need, add up to more than `width`: `need` px for each. The
 * calls it gives:
 *
 * - `resize` changes the width and tells every observer of the box, as a browser does;
 * - `setNeed` changes what a column needs (a face that loaded, a cell that grew), and tells nobody;
 * - `growTable` tells the observers of the table element itself (it grew wider than its box), which is how a browser says that what is in it grew;
 * - `fontsLoaded` tells the page's `document.fonts` that the faces finished loading, as a browser does;
 *
 * and `restoreTableRoom` puts the measuring back to nothing, after each test.
 */
export function tableRoom(initialWidth: number, initialNeed = 200) {
  let width = initialWidth;
  let need = initialNeed;
  const observers = new Map<ResizeObserverCallback, Set<Element>>();
  class Observer {
    constructor(private readonly callback: ResizeObserverCallback) {
      observers.set(callback, new Set());
    }
    observe(target: Element): void {
      // Nothing is told when a box begins to be watched: a browser tells it at the next frame, which `resize` and `growTable` stand in for.
      observers.get(this.callback)?.add(target);
    }
    unobserve(target: Element): void {
      observers.get(this.callback)?.delete(target);
    }
    disconnect(): void {
      observers.delete(this.callback);
    }
  }
  vi.stubGlobal('ResizeObserver', Observer);
  const fonts = new EventTarget();
  Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });
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
  /** Tells the observers that watch an element for which `watches` holds. */
  const tell = (watches: (target: Element) => boolean): void => {
    for (const [callback, targets] of [...observers]) {
      if ([...targets].some(watches)) callback([], {} as ResizeObserver);
    }
  };
  return {
    resize(next: number): void {
      width = next;
      tell((target) => !target.matches('table'));
    },
    setNeed(next: number): void {
      need = next;
    },
    growTable(): void {
      tell((target) => target.matches('table'));
    },
    fontsLoaded(): void {
      fonts.dispatchEvent(new Event('loadingdone'));
    },
  };
}

/** The measuring of a table's box is the browser's again, that is, nothing's. */
export function restoreTableRoom(): void {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollWidth');
  Reflect.deleteProperty(document, 'fonts');
}
