import { Fragment, useEffect, useId, useRef, useState } from 'react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../primitives/dropdown-menu';
import { AlertDialog } from '../dialog/AlertDialog';
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

interface ItemBase {
  /** Tells the item from the others. Unique in a menu. */
  readonly id: string;
  /** What the act does, in one to three words. */
  readonly label: string;
  readonly icon?: IconName;
  /** The person chose the act. For a destructive act this runs only after the confirmation is confirmed. */
  readonly onSelect: () => void;
  /**
   * The act cannot be taken now, and why, in plain words of what is needed ("An approver decides this"), never a permission key or a role. A disabled
   * item stays in the menu and in the keyboard order and says its reason on hover, on focus and when it is chosen: an act that is greyed out and
   * explains nothing is a dead end. The server decides, whatever the menu shows.
   */
  readonly disabled?: { readonly reason: string };
}

/**
 * An item of the menu. A destructive act (it ends or cancels or removes something) must say how it is confirmed: the type requires it, so a destructive act
 * with no question behind it cannot be written.
 */
export type ActionMenuItem =
  | (ItemBase & { readonly destructive?: false })
  | (ItemBase & { readonly destructive: true; readonly confirm: ActionConfirmation });

/** A destructive item: the kind that has a question behind it. */
type ConfirmedItem = ActionMenuItem & { readonly destructive: true };

export interface ActionMenuProps {
  /** Names the button that opens the menu, in words: "More actions for ACC-PR-7KQ2MZ". */
  readonly label: string;
  readonly items: readonly ActionMenuItem[];
}

/**
 * The overflow menu of a record's acts, behind a "⋯" button (PRODUCT_DESIGN_DIRECTION section 6.2; COMPONENT_PATTERNS, *ActionMenu*): the rarer and the heavier
 * acts, which do not compete with the primary action. Destructive acts are always last, set apart by a separator and in the vermilion of danger, and **always
 * confirmed**: choosing one opens the question, and the act runs only when it is confirmed (Cancel has focus first). The keys are the menu primitive's (Radix UI):
 * Enter, Space or the down arrow opens it, the arrows, Home and End move, typing finds an item, Escape closes it and gives focus back.
 */
export function ActionMenu({ label, items }: ActionMenuProps) {
  const ids = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [confirming, setConfirming] = useState<ConfirmedItem | undefined>();
  // The item whose reason was asked for by choosing it (a touch screen has no hover).
  const [revealed, setRevealed] = useState<string | undefined>();
  const wasConfirming = useRef(false);
  /** A destructive act was chosen: its question opens once the menu has finished closing (below), so that the two never hold focus at once. */
  const chosen = useRef<ConfirmedItem | undefined>(undefined);

  // The question is a modal dialog, which gives focus back to what had it when it opened: nothing, for the menu has closed by then. The button that opened
  // the menu has it back when the question is answered.
  useEffect(() => {
    if (confirming !== undefined) {
      wasConfirming.current = true;
      return;
    }
    if (wasConfirming.current) {
      wasConfirming.current = false;
      trigger.current?.focus();
    }
  }, [confirming]);

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
          className="ui-action-menu__content"
          onCloseAutoFocus={(event) => {
            // The menu has closed. A closing menu gives focus back to its button; with a destructive act chosen, the question opens instead and has focus,
            // and the button gets it back when the question is answered. (Opening the question before the menu has gone would have the menu pull focus back.)
            const item = chosen.current;
            if (item === undefined) return;
            chosen.current = undefined;
            event.preventDefault();
            setConfirming(item);
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
                    if (item.destructive === true) {
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
        onConfirm={() => {
          const item = confirming;
          setConfirming(undefined);
          item?.onSelect();
        }}
        onCancel={() => {
          setConfirming(undefined);
        }}
      >
        {confirming?.confirm.description}
      </AlertDialog>
    </>
  );
}
