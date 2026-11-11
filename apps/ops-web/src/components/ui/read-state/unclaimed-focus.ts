/**
 * The mark of a region that focus lands on without anybody having chosen it (run 7, Stage 2.1). `ReadState` draws its content in a region at `tabindex="-1"`, because a retry parks focus there
 * and because Safari's engine, which gives no focus to a button that is pressed, gives it to the nearest ancestor that can have it: after a press in the panel of a queue, that region.
 * A page that gives focus back to the row an act changed, only where nobody has put it, reads this mark (`isUnclaimed`) and nothing else: a heading, a dialog or any other container at
 * `tabindex="-1"` is somebody's focus, put there by the person or by a component to say what has opened, and is never taken for nobody's.
 */
export const UNCLAIMED_FOCUS_ATTRIBUTE = 'data-unclaimed-focus';

/** The selector of a region marked with {@link UNCLAIMED_FOCUS_ATTRIBUTE}. */
export const UNCLAIMED_FOCUS_SELECTOR = `[${UNCLAIMED_FOCUS_ATTRIBUTE}]`;
