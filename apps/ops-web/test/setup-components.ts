import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Vitest does not expose globals here, so Testing Library cannot register its own cleanup.
afterEach(() => {
  cleanup();
});

/*
 * What the shadcn/ui primitives (Radix UI and cmdk) need of a browser that jsdom does not have, as no-ops: a ResizeObserver (a menu, a tooltip and the
 * palette's list measure themselves), scrollIntoView (the palette scrolls the option that Enter would choose into view) and the pointer-capture methods
 * (a menu's items). A component test of a menu, a sheet or the palette can then drive it the way a person does, and what only a real browser can show
 * (where it opens, what is under it, what is focused when it closes in a real engine) is proved in the browser tests.
 */
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    observe(): void {
      // Nothing is laid out in jsdom, so nothing is measured.
    }
    unobserve(): void {
      // As above.
    }
    disconnect(): void {
      // As above.
    }
  };
}
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = (): void => undefined;
}
for (const method of ['hasPointerCapture', 'setPointerCapture', 'releasePointerCapture'] as const) {
  if (typeof Element.prototype[method] !== 'function') {
    Element.prototype[method] = (): boolean => false;
  }
}

/*
 * jsdom has an HTMLDialogElement and its `open` attribute, and nothing a dialog does: no showModal(), show(), close() or returnValue.
 * A real browser does these things; this does enough of them for a component test to drive a modal dialog the way a person does:
 * the open state, the `cancel` event that Escape fires (and the close that follows if nobody prevents it), the `close` event
 * (queued, as a browser queues it), and where focus goes when a modal opens.
 *
 * What a jsdom test cannot show is that the page behind a modal dialog is inert, that Tab stays inside it, that the backdrop is drawn
 * and that focus goes back to what opened it: those are proved in a real browser, in three engines (test/browser/dialogs.spec.ts).
 */
const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The modal dialogs that are open, the last one opened on top: the one Escape goes to. */
const openModals: HTMLDialogElement[] = [];

if (typeof HTMLDialogElement.prototype.showModal !== 'function') {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement): void {
    if (this.open) throw new DOMException('The dialog is already open.', 'InvalidStateError');
    if (!this.isConnected)
      throw new DOMException('The dialog is not connected.', 'InvalidStateError');
    this.setAttribute('open', '');
    openModals.push(this);
    // The dialog focusing steps: the control marked `autofocus`, else the first focusable one, else the dialog itself.
    const target =
      this.querySelector<HTMLElement>('[autofocus]') ?? this.querySelector<HTMLElement>(FOCUSABLE);
    (target ?? this).focus();
  };

  HTMLDialogElement.prototype.close = function close(
    this: HTMLDialogElement,
    returnValue?: string,
  ): void {
    if (!this.open) return;
    this.removeAttribute('open');
    const index = openModals.indexOf(this);
    if (index !== -1) openModals.splice(index, 1);
    if (returnValue !== undefined) this.returnValue = returnValue;
    // A browser queues the event; it does not run inside the call.
    setTimeout(() => {
      this.dispatchEvent(new Event('close'));
    }, 0);
  };
}

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  const top = openModals.at(-1);
  if (top === undefined) return;
  const cancel = new Event('cancel', { cancelable: true });
  top.dispatchEvent(cancel);
  if (!cancel.defaultPrevented) top.close();
});

afterEach(() => {
  openModals.length = 0;
});
