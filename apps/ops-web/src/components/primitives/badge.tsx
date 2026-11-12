import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';

import { cn } from '@/lib/utils';

/*
 * A badge (design/DESIGN_SYSTEM.md section 4.4; the StatusBadge of components/ui has the same recipe). The five status variants are the status
 * pairs of the tokens, each spelled out, because a class name built from a variable is not one a stylesheet is generated for. A badge says the
 * state in words; the colour never carries it alone. `destructive` is the danger pair, as `danger` is.
 */
const badgeVariants = cva(
  'inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-sm border border-transparent px-2 py-1 text-xs leading-(--text-label-sm-line-height) font-medium whitespace-nowrap transition-colors duration-(--motion-fast) [&>svg]:pointer-events-none [&>svg]:size-3',
  {
    variants: {
      variant: {
        default:
          'bg-primary text-primary-foreground [a&]:hover:bg-(color:--color-action-primary-hover)',
        secondary: 'border-border bg-secondary text-secondary-foreground [a&]:hover:bg-accent',
        destructive:
          'border-(color:--color-status-danger-border) bg-(color:--color-status-danger-background) text-(color:--color-status-danger-foreground)',
        outline: 'border-border text-foreground [a&]:hover:bg-accent',
        ghost: 'text-foreground [a&]:hover:bg-accent',
        link: 'text-(color:--color-text-link) underline underline-offset-4 [a&]:hover:text-(color:--color-text-link-hover)',
        success:
          'border-(color:--color-status-success-border) bg-(color:--color-status-success-background) text-(color:--color-status-success-foreground)',
        warning:
          'border-(color:--color-status-warning-border) bg-(color:--color-status-warning-background) text-(color:--color-status-warning-foreground)',
        danger:
          'border-(color:--color-status-danger-border) bg-(color:--color-status-danger-background) text-(color:--color-status-danger-foreground)',
        info: 'border-(color:--color-status-info-border) bg-(color:--color-status-info-background) text-(color:--color-status-info-foreground)',
        neutral:
          'border-(color:--color-status-neutral-border) bg-(color:--color-status-neutral-background) text-(color:--color-status-neutral-foreground)',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

function Badge({
  className,
  variant = 'default',
  asChild = false,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'span';

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
