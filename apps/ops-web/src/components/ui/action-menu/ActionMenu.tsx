import { Fragment, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../primitives/dropdown-menu';
import { AlertDialog } from '../dialog/AlertDialog';
import { DialogContainer } from '../dialog/dialog-container';
import { Icon } from '../icon/Icon';
import type { IconName } from '../icon/icons';
import { IconButton } from '../icon-button/IconButton';
import './action-menu.css';

/** The words of the question a destructive act is always asked behind. */
export interface ActionConfirmation {
  /** The question, as a question: "Cancel request ACC-PR-7KQ2MZ?". */
  readonly title: string;
  /** The consequence, in words. The dialog is described by it. */
  readonly description: string;
  /** What confirming does, in the act's own words ("Cancel the request"), never "OK". */
  readonly confirmLabel: string;
}

/**
 * How an act ended, when it is asked for after the question was confirmed (task R5.2, M3): nothing (it was immediate, and the question closes), `{ ok: true }`, or
 * `{ ok: false, message }`, whose words are the page's own, never the API's `message`: the question stays open with them under it, and the person may try again or go back.
 */
export type ActionOutcome =
  undefined | { readonly ok: true } | { readonly ok: false; readonly message: string };

interface ItemBase {
  /** Tells the item from the others. Unique in a menu. */
  readonly id: string;
  /** What the act does, in one to three words. */
  readonly label: string;
  readonly icon?: IconName;
  /**
   * The act cannot be taken now, and why, in plain words of what is needed ("An approver decides this"), never a permission key or a role. A disabled
   * item stays in the menu and in the keyboard order and says its reason on hover, on focus and when it is chosen: an act that is greyed out and
   * explains nothing is a dead end. The server decides, whatever the menu shows.
   */
  readonly disabled?: { readonly reason: string };
}

/** An act that needs no question: the person chose it and it runs. */
type PlainItem = ItemBase & {
  readonly destructive?: false;
  readonly onSelect: () => void;
  readonly confirm?: undefined;
  readonly dialog?: undefined;
};

/**
 * A destructive act (it ends or cancels or removes something) with the question the menu asks for it, once. It runs only after the question is confirmed, and may take
 * its time: return a promise of an `ActionOutcome`, and the question stays open and busy until it settles, or shows the failure.
 */
type ConfirmedItem = ItemBase & {
  readonly destructive: true;
  readonly confirm: ActionConfirmation;
  readonly onSelect: () => ActionOutcome | Promise<ActionOutcome>;
  readonly dialog?: undefined;
};

/**
 * An act that brings its own dialog (a reason to give, a note to write: `ReasonConfirmationDialog`). The menu opens it **instead of** its own question, so that an act is
 * confirmed once, and gives focus back to its button when the dialog closes. The type requires it of a destructive act in place of `confirm`, so a destructive act
 * with no question behind it still cannot be written.
 */
type OwnDialogItem = ItemBase & {
  readonly destructive?: boolean;
  readonly dialog: (control: { readonly onClose: () => void }) => ReactNode;
  readonly onSelect?: undefined;
  readonly confirm?: undefined;
};

/** An item of the menu. */
export type ActionMenuItem = PlainItem | ConfirmedItem | OwnDialogItem;

export interface ActionMenuProps {
  /** Names the button that opens the menu, in words: "More actions for ACC-PR-7KQ2MZ". */
  readonly label: string;
  readonly items: readonly ActionMenuItem[];
}

/** What the question says when an act's promise broke instead of answering: the page's own outcome is the way to say more. */
const FAILED = 'That did not go through. Try again, or go back.';

/**
 * The overflow menu of a record's acts, behind a "⋯" button (PRODUCT_DESIGN_DIRECTION section 6.2; COMPONENT_PATTERNS, *ActionMenu*): the rarer and the heavier
 * acts, which do not compete with the primary action. Destructive acts are always last, set apart by a separator and in the vermilion of danger, and **always
 * confirmed, once**: choosing one opens the question (or the act's own dialog), and the act runs only when it is confirmed. The question's safe button says "Go back"
 * (never "Cancel", beside an act called "Cancel the request") and has focus first; while an act that takes its time is under way the question stays open and busy, and
 * a failure is told in it. A confirmation never submits a form that holds the menu. The keys are the menu primitive's (Radix UI): Enter, Space or the down arrow opens it,
 * the arrows, Home and End move, typing finds an item, Escape closes it and gives focus back. Inside a modal dialog the menu is drawn into the dialog.
 */
export function ActionMenu({ label, items }: ActionMenuProps) {
  const ids = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  // Inside a modal dialog the menu is drawn into it: the page behind a modal dialog is inert, and a menu drawn there is unseen.
  const dialog = useContext(DialogContainer);
  const [confirming, setConfirming] = useState<ConfirmedItem | undefined>();
  const [owning, setOwning] = useState<OwnDialogItem | undefined>();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | undefined>();
  // The item whose reason was asked for by choosing it (a touch screen has no hover).
  const [revealed, setRevealed] = useState<string | undefined>();
  const wasAsking = useRef(false);
  const mounted = useRef(true);
  /** An act that has a question or a dialog was chosen: it opens once the menu has finished closing (below), so that the two never hold focus at once. */
  const chosen = useRef<ConfirmedItem | OwnDialogItem | undefined>(undefined);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // The question is a modal dialog, which gives focus back to what had it when it opened: nothing, for the menu has closed by then. The button that opened
  // the menu has it back when the question (or the act's own dialog) is answered.
  const asking = confirming !== undefined || owning !== undefined;
  useEffect(() => {
    if (asking) {
      wasAsking.current = true;
      return;
    }
    if (wasAsking.current) {
      wasAsking.current = false;
      trigger.current?.focus();
    }
  }, [asking]);

  const duplicate = items.find(
    (item, index) => items.findIndex((other) => other.id === item.id) !== index,
  );
  if (duplicate !== undefined)
    throw new Error(`Two items of the menu "${label}" have the id "${duplicate.id}".`);
  // Destructive acts last, in the order they were given: a caller cannot put one among the others.
  const ordered = [
    ...items.filter((item) => item.destructive !== true),
    ...items.filter((item) => item.destructive === true),
  ];
  const firstDestructive = ordered.findIndex((item) => item.destructive === true);

  function settle(outcome: ActionOutcome): void {
    if (!mounted.current) return;
    setPending(false);
    if (outcome !== undefined && !outcome.ok) {
      setFailure(outcome.message);
      return;
    }
    setFailure(undefined);
    setConfirming(undefined);
  }

  function confirm(): void {
    const item = confirming;
    if (item === undefined || pending) return;
    const result: unknown = item.onSelect();
    if (!(result instanceof Promise)) {
      setFailure(undefined);
      setConfirming(undefined);
      return;
    }
    // The act takes its time: the question stays open and busy until it is settled.
    setPending(true);
    setFailure(undefined);
    (result as Promise<ActionOutcome>).then(settle, () => {
      settle({ ok: false, message: FAILED });
    });
  }

  return (
    <>
      <DropdownMenu
        onOpenChange={(open) => {
          if (!open) setRevealed(undefined);
        }}
      >
        <DropdownMenuTrigger asChild>
          <IconButton ref={trigger} type="button" icon="more-actions" label={label} />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          container={dialog}
          className="ui-action-menu__content"
          onCloseAutoFocus={(event) => {
            // The menu has closed. A closing menu gives focus back to its button; with an act chosen that has a question or a dialog, that opens instead and has focus,
            // and the button gets it back when it is answered. (Opening it before the menu has gone would have the menu pull focus back.)
            const item = chosen.current;
            if (item === undefined) return;
            chosen.current = undefined;
            event.preventDefault();
            if (item.dialog === undefined) {
              setFailure(undefined);
              setConfirming(item);
            } else {
              setOwning(item);
            }
          }}
        >
          {ordered.map((item, index) => {
            const disabled = item.disabled;
            const labelId = `${ids}-${item.id}-label`;
            const reasonId = `${ids}-${item.id}-reason`;
            return (
              <Fragment key={item.id}>
                {index === firstDestructive && index > 0 ? <DropdownMenuSeparator /> : null}
                <DropdownMenuItem
                  className="ui-action-menu__item"
                  variant={item.destructive === true ? 'destructive' : 'default'}
                  textValue={item.label}
                  aria-labelledby={labelId}
                  aria-describedby={disabled === undefined ? undefined : reasonId}
                  aria-disabled={disabled === undefined ? undefined : true}
                  data-unavailable={disabled === undefined ? undefined : 'true'}
                  data-revealed={revealed === item.id ? 'true' : undefined}
                  onSelect={(event) => {
                    if (disabled !== undefined) {
                      // It stays open, says why, and does nothing.
                      event.preventDefault();
                      setRevealed(item.id);
                      return;
                    }
                    if (item.dialog !== undefined || item.destructive === true) {
                      chosen.current = item;
                      return;
                    }
                    item.onSelect();
                  }}
                >
                  {item.icon === undefined ? null : <Icon name={item.icon} size="sm" />}
                  <span className="ui-action-menu__text">
                    <span id={labelId}>{item.label}</span>
                    {disabled === undefined ? null : (
                      <span id={reasonId} className="ui-action-menu__reason">
                        {disabled.reason}
                      </span>
                    )}
                  </span>
                </DropdownMenuItem>
              </Fragment>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog
        open={confirming !== undefined}
        title={confirming?.confirm.title ?? ''}
        confirmLabel={confirming?.confirm.confirmLabel ?? ''}
        cancelLabel="Go back"
        pending={pending}
        {...(failure === undefined ? {} : { error: failure })}
        onConfirm={confirm}
        onCancel={() => {
          setFailure(undefined);
          setConfirming(undefined);
        }}
      >
        {confirming?.confirm.description}
      </AlertDialog>
      {owning?.dialog({
        onClose: () => {
          setOwning(undefined);
        },
      })}
    </>
  );
}
