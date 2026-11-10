/**
 * The control a person used to open a dialog or a panel, so that focus goes back to it when the dialog or the panel closes (Product Owner, 10 November 2026: Safari is a
 * supported browser, DESIGN_SYSTEM "Supported browsers").
 *
 * The obvious way to remember it is the element that has focus when the dialog opens, and it fails in Safari's engine: WebKit gives no focus to a button that a pointer
 * pressed (it does to a link and to a field), and takes it from the control that had it, so the body has focus when a dialog opens and there is nothing to go back to. The
 * kit remembers **the element that was pressed** instead: the target of the last press (a pointer press, or the `click` that a key, a script or assistive technology makes),
 * resolved to the control that holds it, since a press lands on an icon or a span inside a button. The press counts until the person does something else: a key pressed
 * since says they are on the keyboard, and then the control that has focus is the opener, as it is when nothing was pressed at all. A control that has left the page is not
 * an opener.
 *
 * What is remembered is a reference that does not keep a removed control alive, and nothing is read from the page but the target of an event. The listeners are the page's
 * own, on the document in the capture phase, so they run before a handler of the page's does (the dialog opens from one) and a handler that stops the event cannot hide it.
 */

/** What a script can give focus to: the places a press can lead back to. */
const CONTROL =
  'a[href], area[href], button, input:not([type="hidden"]), select, textarea, summary, iframe, [tabindex], [contenteditable=""], [contenteditable="true"]';

/** The control that was pressed last, until a key is pressed. */
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
  if (control?.isConnected === true) return control;
  const focused = document.activeElement;
  return focused instanceof HTMLElement && focused !== document.body ? focused : null;
}
