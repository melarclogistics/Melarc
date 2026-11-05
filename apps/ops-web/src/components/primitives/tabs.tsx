import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Tabs as TabsPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';

function Tabs({
  className,
  orientation = 'horizontal',
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      orientation={orientation}
      className={cn('group/tabs flex gap-4 data-[orientation=horizontal]:flex-col', className)}
      {...props}
    />
  );
}

/*
 * Tabs are an underline and not a pill. The list is a track (the default border, `variant="default"`) or no track (`variant="line"`), and the
 * current tab is told by an Ink underline drawn as a border, so that forced-colours mode keeps it, with the weight of its text; the underline
 * takes `motion.normal` (design/DESIGN_SYSTEM.md section 9). Vertical tabs put the same line on the side.
 */
const tabsListVariants = cva(
  'group/tabs-list inline-flex items-center text-muted-foreground group-data-[orientation=horizontal]/tabs:w-full group-data-[orientation=horizontal]/tabs:gap-1 group-data-[orientation=vertical]/tabs:h-fit group-data-[orientation=vertical]/tabs:flex-col',
  {
    variants: {
      variant: {
        default:
          'group-data-[orientation=horizontal]/tabs:border-b group-data-[orientation=horizontal]/tabs:border-border group-data-[orientation=vertical]/tabs:border-r group-data-[orientation=vertical]/tabs:border-border',
        line: '',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

function TabsList({
  className,
  variant = 'default',
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> & VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  );
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        'relative inline-flex min-h-(--control-height-md) items-center justify-center gap-2 border-0 border-transparent px-3 py-2 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors duration-(--motion-normal) hover:text-foreground disabled:cursor-not-allowed disabled:text-(color:--color-text-disabled) data-[state=active]:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*="size-"])]:size-4',
        'group-data-[orientation=horizontal]/tabs:-mb-px group-data-[orientation=horizontal]/tabs:border-b-2 group-data-[orientation=horizontal]/tabs:data-[state=active]:border-primary',
        'group-data-[orientation=vertical]/tabs:-mr-px group-data-[orientation=vertical]/tabs:w-full group-data-[orientation=vertical]/tabs:justify-start group-data-[orientation=vertical]/tabs:border-r-2 group-data-[orientation=vertical]/tabs:data-[state=active]:border-primary',
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn('flex-1', className)}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants };
