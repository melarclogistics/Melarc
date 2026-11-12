import * as React from 'react';

import { cn } from '@/lib/utils';

/*
 * Decoration that keeps the layout still while content loads (design/COMPONENT_PATTERNS.md section 17): the loading words are the loading
 * indicator's, not this block's. The pulse is the only motion and it keeps to `motion-safe`, because its length is its own and not a token's.
 * Forced colours drop a background, so there the block keeps a border and the layout it holds stays visible.
 */
function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      className={cn(
        'rounded-md bg-border motion-safe:animate-pulse forced-colors:border forced-colors:border-[color:GrayText]',
        className,
      )}
      {...props}
    />
  );
}

export { Skeleton };
