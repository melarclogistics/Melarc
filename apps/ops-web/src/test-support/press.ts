import { fireEvent } from '@testing-library/react';

/**
 * A press as Safari's engine makes it on a button, a row's button or a card: the pointer events and the `click`, and **no focus**. WebKit does not give focus to a button
 * that a pointer pressed (it does to a link and to a field), and the control that had focus loses it, so `document.activeElement` is the body when the press has been
 * handled. `user.click` of user-event does what Chromium and Firefox do and focuses the pressed control, so a test of what a press opens uses this to be the
 * other engine as well. `target` may be an element inside the control (an icon, a span): that is the target of a real press.
 */
export function pressWithoutFocus(target: Element): void {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  fireEvent.pointerDown(target);
  fireEvent.mouseDown(target);
  fireEvent.pointerUp(target);
  fireEvent.mouseUp(target);
  fireEvent.click(target);
}
