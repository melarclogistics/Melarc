/**
 * The control a person used to open a dialog or a panel, so that focus goes back to it when the dialog or the panel closes (Product Owner, 10 November 2026: Safari is a
 * supported browser, DESIGN_SYSTEM "Supported browsers").
 *
 * The obvious way to remember it is the element that has focus when the dialog opens, and it fails in Safari's engine: WebKit gives no focus to a button that a pointer
 * pressed (it does to a link and to a field), and takes it from the control that had it, so the body has focus when a dialog opens and there is nothing to go back to. The
 * kit remembers **the element that was pressed** instead: the target of the last press (a pointer press, or the `click` that a key, a script or assistive technology makes),
 * resolved to the control that holds it, since a press lands on an icon or a span inside a button. The press counts until the person does something else: a key pressed
 * since says they are on the keyboard, and then the control that has focus is the opener, as it is when nothing was pressed at all. **A press belongs to the dialog that takes it**
 * (run 7, Stage 2.4): it is forgotten when the turn it was taken in is over, so that a dialog opened later by something that was no press (a timer, a route, a message from the server)
 * has the control that has focus and not a control pressed some time ago; everything that asks in the same turn (effects that run twice in development, a dialog and a panel opened by
 * one press) is told the same control. A control that has left the page, or is not shown (it, or something above it, is not drawn, is hidden or is inert: focus cannot go there), is
 * not an opener.
 *
 * What is remembered is a reference that does not keep a removed control alive, and nothing is read from the page but the target of an event. The listeners are the page's
 * own, on the document in the capture phase, so they run before a handler of the page's does (the dialog opens from one) and a handler that stops the event cannot hide it.
 */

/** What a script can give focus to: the places a press can lead back to. */
const CONTROL =
  'a[href], area[href], button, input:not([type="hidden"]), select, textarea, summary, iframe, [tabindex], [contenteditable=""], [contenteditable="true"]';

/** The control that was pressed last, until a key is pressed or a dialog has taken it. */
let pressed: WeakRef<HTMLElement> | null = null;

/** The control a press on `target` was a press of: the nearest one that is not disabled, or none when the press was on the page itself. */
function controlOf(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const control = target.closest<HTMLElement>(CONTROL);
  return control !== null && !control.matches(':disabled') ? control : null;
}

function remember(event: Event): void {
  const control = controlOf(event.target);
  pressed = control === null ? null : new WeakRef(control);
}

function forget(): void {
  pressed = null;
}

let tracking = false;

/** Starts the listening, once. The module does it when it is loaded, so a press that comes before the first dialog was drawn is seen. */
export function trackPresses(): void {
  if (tracking || typeof document === 'undefined') return;
  tracking = true;
  // The `click` is what a keyboard, a script and assistive technology make; the pointer's own press is seen the moment it is made, for a control that opens on it.
  document.addEventListener('pointerdown', remember, { capture: true, passive: true });
  document.addEventListener('click', remember, { capture: true, passive: true });
  document.addEventListener('keydown', forget, { capture: true, passive: true });
}

trackPresses();

/**
 * The control to give focus back to when what is opening now has closed: the one that was pressed, and else the one that has focus. `null` when there is neither (a dialog
 * opened by a timer on a page nobody has touched), and then focus stays where the browser leaves it.
 */
export function openerOf(): HTMLElement | null {
  const control = pressed?.deref();
  if (control !== undefined && isShown(control)) {
    // Taken: the press is let go of when this turn is over, and not before, since what is opening may ask more than once.
    queueMicrotask(forget);
    return control;
  }
  const focused = document.activeElement;
  return focused instanceof HTMLElement && focused !== document.body && isShown(focused)
    ? focused
    : null;
}

/** Whether focus can be given to the control now: it is on the page, nothing from it up to the root is not drawn or inert, and it is not hidden. */
function isShown(control: HTMLElement): boolean {
  if (!control.isConnected) return false;
  if (getComputedStyle(control).visibility !== 'visible') return false;
  for (let node: Element | null = control; node !== null; node = node.parentElement) {
    if (node.hasAttribute('inert') || getComputedStyle(node).display === 'none') return false;
  }
  return true;
}
