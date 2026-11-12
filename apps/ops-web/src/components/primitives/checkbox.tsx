import * as React from 'react';
import { CheckIcon } from 'lucide-react';
import { Checkbox as CheckboxPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';

/*
 * A checkbox: the 1.25rem box of the native checkbox of components/ui, on the control boundary, Ink when checked or mixed. Its target is the whole
 * row (the label is part of it, through `Label htmlFor`). Disabled wins over the checked fill, so a disabled box never looks like one that can be used.
 */
function Checkbox({ className, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        'peer size-5 shrink-0 rounded-sm border border-input bg-card transition-colors duration-(--motion-fast) enabled:aria-invalid:border-2 enabled:aria-invalid:border-destructive data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground',
        'disabled:cursor-not-allowed disabled:border-(color:--color-border-disabled) disabled:bg-(color:--color-surface-disabled) disabled:text-(color:--color-text-disabled) disabled:data-[state=checked]:border-transparent disabled:data-[state=checked]:bg-(color:--color-action-disabled) disabled:data-[state=checked]:text-(color:--color-action-disabled-text) disabled:data-[state=indeterminate]:border-transparent disabled:data-[state=indeterminate]:bg-(color:--color-action-disabled) disabled:data-[state=indeterminate]:text-(color:--color-action-disabled-text)',
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="grid place-content-center text-current transition-none"
      >
        <CheckIcon className="size-4" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
