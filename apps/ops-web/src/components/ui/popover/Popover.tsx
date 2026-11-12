import { useContext, type ReactElement, type ReactNode, type Ref } from 'react';

import { Popover as PopoverRoot, PopoverContent, PopoverTrigger } from '../../primitives/popover';
import { DialogContainer } from '../dialog/dialog-container';
import './popover.css';

/** How far the popover stands from what opens it, in pixels (Melarc's default). */
export const POPOVER_OFFSET_PX = 8;

/** How near the edge of the window the popover may come before it is moved away from it, in pixels: a popover opened at 390px stays whole and never sits on the edge (task R5.2, M12). */
export const POPOVER_COLLISION_PADDING_PX = 8;

export interface PopoverProps {
  /** What opens it: one element that takes a pointer and a focus (a button). It is not wrapped; the popover attaches to it. */
  readonly trigger: ReactElement;
  /** The name of the popover, for a screen reader ("Choose a filter"): it is a dialog, and a dialog is named. */
  readonly label: string;
  readonly children: ReactNode;
  /** Controlled use: leave both out and the popover opens and closes itself. */
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly align?: 'start' | 'center' | 'end';
  readonly side?: 'top' | 'right' | 'bottom' | 'left';
  /**
   * The element the popover is drawn into: the modal `<dialog>` that holds it (`DialogContainer`), else the page's body. A modal `<dialog>` is in the top layer and the page
   * behind it is inert, so a popover opened from inside one is drawn into the dialog, or it would open under it, unseen. Left out, it is read from the context, and no page
   * passes one (task R5.2, M8); pass one only to draw it elsewhere.
   */
  readonly container?: HTMLElement | null;
  /** What takes focus when it opens, if not the first control: the date field's calendar puts focus on the day to start from. */
  readonly onOpenAutoFocus?: (event: Event) => void;
  /** A reference to the popover's own element, for a caller that has to tell a blur inside it from a blur outside (the date field does). */
  readonly contentRef?: Ref<HTMLDivElement>;
  readonly className?: string;
}

/**
 * A popover with Melarc's defaults (COMPONENT_PATTERNS, *Popover*; the second half of redesign step R5), so that a screen never touches the primitive: a named dialog that opens under
 * what opened it, 8px away, on the one floating shadow, with Escape to close it and focus returned to what opened it. The props are those that the date field's calendar and the
 * filter bar's popover use from the primitive (`container`, `align`, `onOpenAutoFocus`, a reference to the element and a name), so that they can move onto it without changing.
 */
export function Popover({
  trigger,
  label,
  children,
  open,
  onOpenChange,
  align = 'start',
  side = 'bottom',
  container,
  onOpenAutoFocus,
  contentRef,
  className,
}: PopoverProps) {
  const dialog = useContext(DialogContainer);
  return (
    <PopoverRoot
      {...(open === undefined ? {} : { open })}
      {...(onOpenChange === undefined ? {} : { onOpenChange })}
    >
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        ref={contentRef}
        align={align}
        side={side}
        sideOffset={POPOVER_OFFSET_PX}
        container={container === undefined ? dialog : container}
        collisionPadding={POPOVER_COLLISION_PADDING_PX}
        aria-label={label}
        className={['ui-popover', className].filter((name) => name !== undefined).join(' ')}
        {...(onOpenAutoFocus === undefined ? {} : { onOpenAutoFocus })}
      >
        {children}
      </PopoverContent>
    </PopoverRoot>
  );
}
