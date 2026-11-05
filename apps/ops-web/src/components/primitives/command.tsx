import * as React from 'react';
import { Command as CommandPrimitive } from 'cmdk';
import { SearchIcon } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/primitives/dialog';
import { cn } from '@/lib/utils';

function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        'flex h-full w-full flex-col overflow-hidden rounded-lg bg-popover text-popover-foreground',
        className,
      )}
      {...props}
    />
  );
}

/**
 * The command palette in a dialog. The registry's version put the (hidden) title and description beside the dialog's panel and not in it,
 * which left a heading in the page while the palette was closed; they are in the panel here, where the dialog names itself from them.
 *
 * A palette is opened from a button or a key, and has no `DialogTrigger` to give focus back to when it closes: Radix then leaves focus on the body.
 * `onCloseAutoFocus` is passed through to the panel, so that whoever opens the palette can return focus to where the person was (call
 * `event.preventDefault()` and focus that element); the registry's file has no such prop.
 */
function CommandDialog({
  title = 'Command palette',
  description = 'Search for a command to run',
  children,
  className,
  showCloseButton = true,
  onCloseAutoFocus,
  ...props
}: React.ComponentProps<typeof Dialog> & {
  title?: string;
  description?: string;
  className?: string;
  showCloseButton?: boolean;
  onCloseAutoFocus?: React.ComponentProps<typeof DialogContent>['onCloseAutoFocus'];
}) {
  return (
    <Dialog {...props}>
      <DialogContent
        className={cn('gap-0 overflow-hidden p-0', className)}
        showCloseButton={showCloseButton}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <Command>{children}</Command>
      </DialogContent>
    </Dialog>
  );
}

/** The field sits in its own row with room around it, so that the frame's focus ring on the field is not cut by the palette's edge. */
function CommandInput({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div
      data-slot="command-input-wrapper"
      className="flex items-center gap-2 border-b border-border px-3 py-2"
    >
      <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn(
          'flex min-h-(--control-height-sm) w-full rounded-md bg-transparent py-1 text-sm placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:text-(color:--color-text-disabled)',
          className,
        )}
        {...props}
      />
    </div>
  );
}

function CommandList({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn('max-h-80 scroll-py-1 overflow-x-hidden overflow-y-auto', className)}
      {...props}
    />
  );
}

function CommandEmpty({ ...props }: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className="py-6 text-center text-sm text-muted-foreground"
      {...props}
    />
  );
}

function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        'overflow-hidden p-1 text-foreground [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}

/**
 * The list of a palette is a `listbox`, whose children may be options and groups of options and nothing else (ARIA 1.2), and cmdk puts a
 * `separator` between groups. The line is for the eye, so it is hidden from assistive technology; axe reports `aria-required-children` otherwise.
 */
function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      aria-hidden="true"
      className={cn('-mx-1 h-px bg-border', className)}
      {...props}
    />
  );
}

/*
 * The focus of a palette stays in its field, and the option that Enter would choose is told by `data-selected`: the subtle fill, and an inset ring
 * in the focus colour, because a fill that faint is not a way to find the option (the focus ring is the frame's, and it is not drawn on an
 * element that does not have focus).
 */
function CommandItem({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        "relative flex min-h-(--control-height-sm) cursor-default items-center gap-2 rounded-md px-3 py-1 text-sm select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:text-(color:--color-text-disabled) data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground data-[selected=true]:outline-2 data-[selected=true]:-outline-offset-2 data-[selected=true]:outline-(color:--focus-ring) [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  );
}

function CommandShortcut({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="command-shortcut"
      className={cn('ml-auto text-xs tracking-widest text-muted-foreground', className)}
      {...props}
    />
  );
}

export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
};
