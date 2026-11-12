import * as React from 'react';
import { Label as LabelPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';

/** A label: the 14px medium text of a field's name (label-md). Its line height is the text's own, so that a label that wraps at 200% text does not collapse onto itself. */
function Label({ className, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn(
        'flex items-center gap-2 text-sm font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:text-(color:--color-text-disabled) peer-disabled:cursor-not-allowed peer-disabled:text-(color:--color-text-disabled)',
        className,
      )}
      {...props}
    />
  );
}

export { Label };
