import { useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { toast, Toaster as ToasterPrimitive } from '../../primitives/sonner';
import { Icon } from '../icon/Icon';
import type { IconName } from '../icon/icons';
import { IconButton } from '../icon-button/IconButton';
import './toast.css';

/** How the message went: the status pairs of the design system. The words carry it, the disc supports them. */
export type ToastTone = 'success' | 'info' | 'warning' | 'danger';

/**
 * The primary action of a toast, and the only two words it may say. **Open** where the act made something to open ("Open" the request). **Undo** only where the
 * server allows that act to be undone (no operation of the contract does yet, so no screen may offer it). The type is the rule: no other label compiles here.
 */
export interface ToastAction {
  readonly label: 'Undo' | 'Open';
  readonly onClick: () => void;
}

/**
 * The secondary action of a toast: the next thing to do, in the screen's own words ("Book another", as the task form's success has it: PRODUCT_DESIGN_DIRECTION
 * section 6.3). It is never "Undo" (that is the primary action's, and only where the server can undo), and it only exists beside a primary action.
 */
export interface ToastSecondaryAction {
  readonly label: string;
  readonly onClick: () => void;
}

interface ToastContent {
  readonly tone: ToastTone;
  /**
   * What happened, in a sentence of plain words ("Request ACC-PR-7KQ2MZ confirmed."). It states the state reached, not only that a request returned. Text, or
   * text with an `OperationalCode` in it: a code in a toast is kept whole, as it is everywhere, and not broken across two lines like a word.
   */
  readonly message: ReactNode;
  /**
   * Names the toast, so that raising it again does not stack a second copy: a toast with this id that is showing (or held, below) is **replaced in place** by the
   * new one (task R5.2, M11). Leave it out and every call is its own toast. Text only: it is a key, never shown.
   */
  readonly id?: string;
}

/**
 * A toast has no action, or a primary one, or a primary one and a secondary one: **at most two, and a secondary one without a primary one does not compile**
 * (the second branch is the only one that has `secondaryAction`, and it requires `action`).
 */
export type ToastOptions = ToastContent &
  (
    | { readonly action?: undefined; readonly secondaryAction?: undefined }
    | { readonly action: ToastAction; readonly secondaryAction?: ToastSecondaryAction }
  );

const ICON: Record<ToastTone, IconName> = {
  success: 'success',
  info: 'info',
  warning: 'warning',
  danger: 'warning',
};

/** How long a toast with no action stays: it only repeats what the page already shows. A toast with any action never times out. */
const TRANSIENT_MS = 6000;

function StatusDisc({ tone }: { readonly tone: ToastTone }) {
  return (
    <span className="ui-toast__disc" data-tone={tone}>
      <Icon name={ICON[tone]} size="sm" />
    </span>
  );
}

/**
 * What the type refuses, refused at run time too, for a caller that gets round the type (a cast, a value that came from elsewhere): a secondary action with no primary
 * one, one that says nothing, and one that says "Undo". The parameter is typed with the two actions apart, because the point is what the type cannot be trusted with.
 */
function refuseWhatTheTypeRefuses({
  action,
  secondaryAction,
}: {
  readonly action?: ToastAction | undefined;
  readonly secondaryAction?: ToastSecondaryAction | undefined;
}): void {
  if (secondaryAction === undefined) return;
  if (action === undefined) {
    throw new Error('A toast has a secondary action only beside a primary one.');
  }
  if (secondaryAction.label.trim() === '') {
    throw new Error('The secondary action of a toast has to say what it does.');
  }
  if (secondaryAction.label === 'Undo') {
    throw new Error('Only the primary action of a toast may be "Undo".');
  }
}

/*
 * A toast raised while a native modal dialog is open is **held** until the last one has closed, and then shown (task R5.2, M11): a modal dialog makes everything outside
 * it inert and draws its scrim over the page, so a toast raised then is drawn behind the scrim, unseen and out of reach, and with an action it never goes by itself, so it
 * would still be there to be found afterwards, late. The held ones are shown in the order they were raised. Only `Dialog` makes `<dialog>` elements, and it makes them
 * modal; the docked side panel is an `<aside>`. What is held is watched for as the page changes (`MutationObserver`), because a dialog may close by its `open` attribute
 * going, or by the element leaving the page, and no event says both.
 */
interface Held {
  readonly id: string | number;
  readonly options: ToastOptions;
}
const held: Held[] = [];
let watcher: MutationObserver | undefined;
let heldCount = 0;

const modalIsOpen = (): boolean => document.querySelector('dialog[open]') !== null;

function releaseHeld(): void {
  if (modalIsOpen()) return;
  watcher?.disconnect();
  watcher = undefined;
  for (const { id, options } of held.splice(0)) raise(options, id);
}

function hold(options: ToastOptions, id: string | number): void {
  const at = held.findIndex((one) => one.id === id);
  if (at === -1) held.push({ id, options });
  else held.splice(at, 1, { id, options });
  if (watcher === undefined) {
    watcher = new MutationObserver(releaseHeld);
    watcher.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['open'],
    });
  }
}

/** Drops every toast, the showing and the held, and stops watching: the toaster is gone, or the session ended. */
function dropEverything(): void {
  held.length = 0;
  watcher?.disconnect();
  watcher = undefined;
  toast.dismiss();
}

/**
 * Raises a toast (COMPONENT_PATTERNS section 21, *Toast*): a message at the bottom right, with a disc of the tone and its icon, the words, up to two actions (a
 * primary and a secondary one, under the message) and, when it has an action, a way to dismiss it. **A toast with any action stays until it is dismissed**
 * (WCAG 2.2.1: the person has the time to use it), and one without goes after a few seconds. An important outcome must never exist only in a toast: it is the
 * page's too (a changed row, a state told on the page); the toast is the acknowledgement. Returns the toast's id, for `dismissToast`.
 *
 * Each action is a real button in the keyboard order (the primary one, the secondary one, then the dismiss control), and using either takes the toast away.
 * The type refuses a secondary action with no primary one; a caller that gets round the type is refused here too, because a toast whose only action is the
 * lesser one would put the next act before the result.
 */
export function showToast(options: ToastOptions): string | number {
  refuseWhatTheTypeRefuses({ action: options.action, secondaryAction: options.secondaryAction });
  if (modalIsOpen()) {
    // Held until the dialog has closed; the id it will have is given now.
    heldCount += 1;
    const id = options.id ?? `held-${String(heldCount)}`;
    hold(options, id);
    return id;
  }
  return raise(options, options.id);
}

/** Draws a toast now. `id` is the caller's, or Sonner's own when there is none. */
function raise(
  { tone, message, action, secondaryAction }: ToastOptions,
  id: string | number | undefined,
): string | number {
  return toast.custom(
    (toastId) => (
      <div className="ui-toast" data-tone={tone}>
        <StatusDisc tone={tone} />
        <div className="ui-toast__body">
          <p className="ui-toast__message">{message}</p>
          {action === undefined ? null : (
            <div className="ui-toast__actions">
              <button
                type="button"
                className="ui-toast__action"
                data-action="primary"
                onClick={() => {
                  action.onClick();
                  toast.dismiss(toastId);
                }}
              >
                {action.label}
              </button>
              {secondaryAction === undefined ? null : (
                <button
                  type="button"
                  className="ui-toast__action"
                  data-action="secondary"
                  onClick={() => {
                    secondaryAction.onClick();
                    toast.dismiss(toastId);
                  }}
                >
                  {secondaryAction.label}
                </button>
              )}
            </div>
          )}
        </div>
        {action === undefined ? null : (
          <IconButton
            type="button"
            icon="close"
            size="sm"
            label="Dismiss this message"
            onClick={() => {
              toast.dismiss(toastId);
            }}
          />
        )}
      </div>
    ),
    {
      ...(id === undefined ? {} : { id }),
      duration: action === undefined ? TRANSIENT_MS : Infinity,
    },
  );
}

/** Takes a toast away (one that is held, too), or every toast when no id is given. */
export function dismissToast(id?: string | number): void {
  if (id === undefined) {
    dropEverything();
    return;
  }
  const at = held.findIndex((one) => one.id === id);
  if (at !== -1) held.splice(at, 1);
  toast.dismiss(id);
}

/*
 * The toasters that are mounted, in the order they were mounted. Sonner keeps its toasts in one store for the whole page, and every toaster it draws shows every
 * toast, so a second toaster would show each one twice. Only the first one mounted draws; the others draw nothing, and the next takes over when it goes. A second
 * mount is therefore harmless, and not only forbidden by where the first one is put.
 */
const mounted: symbol[] = [];
const listeners = new Set<() => void>();
const tell = (): void => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const firstMounted = (): symbol | undefined => mounted[0];

/**
 * Mounts the place toasts appear: **once, in the application's frame** (the signed-in shell, `app/AuthenticatedOpsShell.tsx`). Bottom right, and still under reduced
 * motion (Sonner stops its own animations there). A page never mounts one. The showcase's pages are outside the shell and mount their own, and there is only ever one
 * drawn: a second one mounted anywhere draws nothing.
 *
 * **It is drawn into the body of the page and not where it is mounted**, so that it is outside every landmark. A sheet or a dialog that hides the page from assistive
 * technology (Radix UI hides the siblings of what it opens) leaves a live region alone, and with it every element that holds it: a toaster inside the main landmark kept
 * the whole of *main* exposed behind an open sheet (found by `shell.spec.ts`). At the body it keeps only itself. (A native modal dialog makes everything outside it inert,
 * the toaster too: a toast raised while one is open is held until it closes, `showToast` above.) When the last toaster goes, every toast goes with it (`dropEverything`).
 */
export function Toaster() {
  const [self] = useState(() => Symbol('toaster'));
  const first = useSyncExternalStore(subscribe, firstMounted, firstMounted);
  useLayoutEffect(() => {
    mounted.push(self);
    tell();
    return () => {
      mounted.splice(mounted.indexOf(self), 1);
      tell();
      // The last toaster is gone (the session ended and the shell with it, or the page was left): Sonner keeps its toasts in a store of its own and shows every one that is
      // still active to a toaster that mounts later, so a toast with an action (which has no end of its own) would appear again for the next person (task R5.2, H2).
      if (mounted.length === 0) dropEverything();
    };
  }, [self]);
  if (first !== self) return null;
  return createPortal(
    <ToasterPrimitive
      position="bottom-right"
      visibleToasts={3}
      offset="var(--space-6)"
      // Under 600px a toast keeps clear of a control that sticks to the bottom of the window (a page's submit bar): the bar publishes its height with `useToastClearance`.
      mobileOffset={{
        bottom: 'calc(var(--space-4) + var(--ui-toast-clearance, 0px))',
        left: 'var(--space-4)',
        right: 'var(--space-4)',
      }}
    />,
    document.body,
  );
}
