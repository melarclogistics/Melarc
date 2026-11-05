import * as React from 'react';

import { cn } from '@/lib/utils';

/** A multi-line field: the Input's recipe (the surface, the control boundary, read-only, invalid, disabled), growing with its text from the large control height. */
function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'flex field-sizing-content min-h-(--control-height-lg) w-full rounded-md border border-input bg-card px-3 py-2 text-sm leading-(--text-body-md-line-height) text-foreground transition-colors duration-(--motion-fast) placeholder:text-muted-foreground hover:border-(color:--color-border-strong) read-only:border-(color:--color-border-strong) read-only:bg-muted',
        'enabled:aria-invalid:border-2 enabled:aria-invalid:border-destructive enabled:aria-invalid:px-[calc(var(--space-3)-1px)] enabled:aria-invalid:py-[calc(var(--space-2)-1px)]',
        'disabled:cursor-not-allowed disabled:border-(color:--color-border-disabled) disabled:bg-(color:--color-surface-disabled) disabled:text-(color:--color-text-disabled) disabled:placeholder:text-(color:--color-text-disabled)',
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
