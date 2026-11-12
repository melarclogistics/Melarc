import * as React from 'react';

import { cn } from '@/lib/utils';

/*
 * A text field (design/DESIGN_SYSTEM.md sections 4.6 and 11; the Input of components/ui has the same recipe): the default surface, the control
 * boundary (3:1) that takes the strong border under the pointer, read-only as the subtle surface on the strong border (legible, selectable and
 * not styled as disabled), invalid as the 2px danger border (the icon and the message are the form's: the border is never alone), disabled as the
 * disabled tokens, which win over the rest. The height is a minimum, in rem, so that enlarged text grows it. Focus is the frame's one recipe.
 */
function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'min-h-(--control-height-md) w-full min-w-0 rounded-md border border-input bg-card px-3 py-1 text-sm leading-(--text-body-md-line-height) text-foreground transition-colors duration-(--motion-fast) file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground hover:border-(color:--color-border-strong) read-only:border-(color:--color-border-strong) read-only:bg-muted',
        'enabled:aria-invalid:border-2 enabled:aria-invalid:border-destructive enabled:aria-invalid:px-[calc(var(--space-3)-1px)]',
        'disabled:cursor-not-allowed disabled:border-(color:--color-border-disabled) disabled:bg-(color:--color-surface-disabled) disabled:text-(color:--color-text-disabled) disabled:placeholder:text-(color:--color-text-disabled)',
        className,
      )}
      {...props}
    />
  );
}

export { Input };
