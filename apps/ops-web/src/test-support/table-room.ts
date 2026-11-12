import { vi } from 'vitest';

/**
 * A table's box of a width, in jsdom, which measures nothing: the box, the probe of no height and the table's root are `width` px wide (`clientWidth`), and the box **scrolls sideways**
 * (`scrollWidth` is more than its `clientWidth`) while the header cells it draws, which are what the columns that are drawn need, add up to more than `width`: `need` px for each. The
 * calls it gives:
 *
 * - `resize` changes the width and tells every observer of the box, as a browser does;
 * - `setNeed` changes what a column needs (a face that loaded, a cell that grew), and tells nobody;
 * - `growTable` tells the observers of the table element itself (it grew wider than its box), which is how a browser says that what is in it grew;
 * - `fontsLoaded` tells the page's `document.fonts` that the faces finished loading, as a browser does, and `fontsReadyWithoutEvent` does it as WebKit does for some faces, with `ready` and no event;
 * - `frame` is the next animation frame: what was asked of `requestAnimationFrame` runs, once, in the order it was asked. A browser runs it before it lays the page out and tells the observers, so
 *   a table that changes its layout there is changing it outside the delivery of the observers' callbacks; `framesAsked` says how many are waiting. None of the calls above runs a frame by
 *   itself: a test that wants the frame that follows a change asks for it, and a test that wants to see that nothing was drawn before it looks first;
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
  const frames = new Map<number, FrameRequestCallback>();
  let lastFrame = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
    lastFrame += 1;
    frames.set(lastFrame, callback);
    return lastFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (handle: number): void => {
    frames.delete(handle);
  });
  const fonts = Object.assign(new EventTarget(), { status: 'loading' });
  let settleReady: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    settleReady = resolve;
  });
  Object.defineProperty(fonts, 'ready', { value: ready });
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
    /** The next animation frame comes: every request made of it so far runs, in order, and one that is made while they run waits for the frame after. */
    frame(): void {
      const due = [...frames.values()];
      frames.clear();
      for (const callback of due) callback(0);
    },
    /** How many requests wait for the next animation frame (one that was cancelled is not counted). */
    framesAsked(): number {
      return frames.size;
    },
    fontsLoaded(): void {
      fonts.status = 'loaded';
      fonts.dispatchEvent(new Event('loadingdone'));
    },
    /** The faces are in and the engine sent no `loadingdone`: only `document.fonts.ready` says so (WebKit, for a face its layout asked for). */
    fontsReadyWithoutEvent(): Promise<void> {
      fonts.status = 'loaded';
      settleReady();
      return ready;
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
