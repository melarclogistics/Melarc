import type { ReactElement } from 'react';

import {
  Tooltip as TooltipRoot,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../../primitives/tooltip';
import './tooltip.css';

/** The wait before a tooltip appears under the pointer, in milliseconds (Melarc's default; a keyboard focus shows it at once). */
export const TOOLTIP_DELAY_MS = 300;

/** How far the tooltip stands from what it names, in pixels. */
export const TOOLTIP_OFFSET_PX = 8;

export interface TooltipProps {
  /** The words. A tooltip **names an icon or adds a hint**; it never replaces the accessible name of what it is on, and a thing that can only be understood by its tooltip is not named. */
  readonly content: string;
  /** What the tooltip is on: one element that takes a pointer and a focus (a button, a link, an input). It is not wrapped; the tooltip attaches to it. */
  readonly children: ReactElement;
  readonly side?: 'top' | 'right' | 'bottom' | 'left';
}

/**
 * A tooltip with Melarc's defaults (COMPONENT_PATTERNS, *Tooltip*; the second half of redesign step R5), so that a screen never touches the primitive: it appears after 300ms under
 * the pointer and at once on keyboard focus, stands 8px from what it names, floats on the one soft shadow, goes with Escape, stays while the pointer is on it (WCAG 1.4.13) and is
 * described to assistive technology by its words. It is text only.
 */
export function Tooltip({ content, children, side = 'top' }: TooltipProps) {
  return (
    <TooltipProvider delayDuration={TOOLTIP_DELAY_MS}>
      <TooltipRoot>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent side={side} sideOffset={TOOLTIP_OFFSET_PX} className="ui-tooltip">
          {content}
        </TooltipContent>
      </TooltipRoot>
    </TooltipProvider>
  );
}
