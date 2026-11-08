import * as React from 'react';
import { Tooltip as TooltipPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';

function TooltipProvider({
  delayDuration = 0,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  );
}

function Tooltip({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

function TooltipTrigger({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

/*
 * A tooltip names an icon or adds a hint; it never replaces the accessible name (design/COMPONENT_PATTERNS.md section 22). Radix gives what
 * WCAG 1.4.13 asks of content that appears on hover or focus: Escape dismisses it, the pointer can move onto it, and it stays until it is
 * left. It is the inverse of the page (the foreground as its ground), so it reads on a light page and on a dark one, and it fades in the
 * fast time of the tokens.
 *
 * `container` is not in the registry's source (design/DESIGN_SYSTEM.md section 29.6), as the popover's is not: the element the tooltip is drawn into, the body unless
 * one is given. A modal `<dialog>` is in the top layer and the page behind it is inert, so a tooltip of a control inside one is drawn into the dialog, or it would
 * open under it.
 */
function TooltipContent({
  className,
  sideOffset = 4,
  container,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content> & { container?: HTMLElement | null }) {
  return (
    <TooltipPrimitive.Portal container={container}>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          'z-50 w-fit origin-(--radix-tooltip-content-transform-origin) rounded-md bg-foreground px-3 py-1 text-xs leading-(--text-label-sm-line-height) text-balance text-background duration-(--motion-fast) ease-(--motion-ease-enter) animate-in fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:ease-(--motion-ease-exit) data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
          className,
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className="z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px] bg-foreground fill-foreground" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
