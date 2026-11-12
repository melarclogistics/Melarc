import * as React from 'react';
import { Separator as SeparatorPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';

/** A rule in the default border colour. It is decorative unless the caller says otherwise (`decorative={false}`), and then it is a separator to a reader. */
function Separator({
  className,
  orientation = 'horizontal',
  decorative = true,
  ...props
}: React.ComponentProps<typeof SeparatorPrimitive.Root>) {
  return (
    <SeparatorPrimitive.Root
      data-slot="separator"
      decorative={decorative}
      orientation={orientation}
      className={cn(
        'shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px',
        className,
      )}
      {...props}
    />
  );
}

export { Separator };
