import type { ReactNode } from 'react';

import { toast, Toaster as ToasterPrimitive } from '../../primitives/sonner';
import { Icon } from '../icon/Icon';
import type { IconName } from '../icon/icons';
import './toast.css';

/** How the message went: the status pairs of the design system. The words carry it, the disc supports them. */
export type ToastTone = 'success' | 'info' | 'warning' | 'danger';

/**
 * The one action a toast may carry, and the only two words it may say. **Undo** only where the server allows that act to be undone; **Open** where the act
 * made something to open ("Open" the request). The type is the rule: a toast has at most one action, and no other label compiles.
 */
export interface ToastAction {
  readonly label: 'Undo' | 'Open';
  readonly onClick: () => void;
}

export interface ToastOptions {
  readonly tone: ToastTone;
  /**
   * What happened, in a sentence of plain words ("Request ACC-PR-7KQ2MZ confirmed."). It states the state reached, not only that a request returned. Text, or
   * text with an `OperationalCode` in it: a code in a toast is kept whole, as it is everywhere, and not broken across two lines like a word.
   */
  readonly message: ReactNode;
  readonly action?: ToastAction;
}

const ICON: Record<ToastTone, IconName> = {
  success: 'success',
  info: 'info',
  warning: 'warning',
  danger: 'warning',
};

/** How long a toast with no action stays: it only repeats what the page already shows. A toast with an action never times out. */
const TRANSIENT_MS = 6000;

function StatusDisc({ tone }: { readonly tone: ToastTone }) {
  return (
    <span className="ui-toast__disc" data-tone={tone}>
      <Icon name={ICON[tone]} size="sm" />
    </span>
  );
}

/**
 * Raises a toast (COMPONENT_PATTERNS section 21, *Toast*): a message at the bottom right, with a disc of the tone and its icon, the words, at most one action and,
 * when it has an action, a way to dismiss it. **A toast with an action stays until it is dismissed** (WCAG 2.2.1: the person has the time to use it), and one
 * without goes after a few seconds. An important outcome must never exist only in a toast: it is the page's too (a changed row, a state told on the page); the toast
 * is the acknowledgement. Returns the toast's id, for `dismissToast`.
 */
export function showToast({ tone, message, action }: ToastOptions): string | number {
  return toast.custom(
    (id) => (
      <div className="ui-toast" data-tone={tone}>
        <StatusDisc tone={tone} />
        <p className="ui-toast__message">{message}</p>
        {action === undefined ? null : (
          <button
            type="button"
            className="ui-toast__action"
            onClick={() => {
              action.onClick();
              toast.dismiss(id);
            }}
          >
            {action.label}
          </button>
        )}
        {action === undefined ? null : (
          <button
            type="button"
            className="ui-toast__close"
            aria-label="Dismiss this message"
            onClick={() => {
              toast.dismiss(id);
            }}
          >
            <Icon name="close" size="sm" />
          </button>
        )}
      </div>
    ),
    { duration: action === undefined ? TRANSIENT_MS : Infinity },
  );
}

/** Takes a toast away, or every toast when no id is given. */
export function dismissToast(id?: string | number): void {
  toast.dismiss(id);
}

/** Mounts the place toasts appear: once, in the application's frame. Bottom right. */
export function Toaster() {
  return (
    <ToasterPrimitive
      position="bottom-right"
      visibleToasts={3}
      offset="1.5rem"
      mobileOffset="1rem"
    />
  );
}
