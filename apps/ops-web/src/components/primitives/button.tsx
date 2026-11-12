import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';

import { cn } from '@/lib/utils';

/*
 * The button, drawn through the tokens (design/DESIGN_SYSTEM.md sections 4.6 and 11). The heights are the minimums of section 11, in rem, so that
 * enlarged text grows a button; focus is the one recipe of base.css; a disabled button takes the disabled tokens, whatever its variant.
 *
 * `default` is Ink, `brand` is the crimson New button and nothing else, `secondary` and `ghost` are the Secondary and Tertiary recipes, and
 * `destructive` is the Danger recipe, which is an outline: a filled Danger button is not part of the system (section 16.3).
 */
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md border border-transparent text-sm font-medium whitespace-nowrap transition-colors duration-(--motion-fast) aria-busy:cursor-progress disabled:cursor-not-allowed disabled:border-transparent disabled:bg-(color:--color-action-disabled) disabled:text-(color:--color-action-disabled-text) [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          'bg-primary text-primary-foreground hover:bg-(color:--color-action-primary-hover) active:bg-(color:--color-action-primary-pressed)',
        brand:
          'bg-brand text-brand-foreground hover:bg-(color:--color-action-new-hover) active:bg-(color:--color-action-new-pressed)',
        destructive:
          'border-destructive bg-card text-destructive hover:bg-(color:--color-status-danger-background) active:bg-(color:--button-pressed-background)',
        outline:
          'border-input bg-transparent text-foreground hover:bg-accent active:bg-(color:--button-pressed-background)',
        secondary:
          'border-border bg-secondary text-secondary-foreground hover:bg-accent active:bg-(color:--button-pressed-background)',
        ghost:
          'text-(color:--color-text-link) hover:bg-accent hover:text-(color:--color-text-link-hover) active:bg-(color:--button-pressed-background) active:text-(color:--color-text-link-hover) disabled:bg-transparent disabled:text-(color:--color-text-disabled)',
        link: 'text-(color:--color-text-link) underline underline-offset-4 hover:text-(color:--color-text-link-hover) disabled:bg-transparent disabled:text-(color:--color-text-disabled)',
      },
      size: {
        default: 'min-h-(--control-height-md) px-4 py-2 has-[>svg]:px-3',
        sm: 'min-h-(--control-height-sm) px-3 py-1 has-[>svg]:px-2',
        lg: 'min-h-(--control-height-lg) px-6 py-2 has-[>svg]:px-4',
        icon: 'size-(--control-height-md)',
        'icon-sm': 'size-(--control-height-sm)',
        'icon-lg': 'size-(--control-height-lg)',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

function Button({
  className,
  variant = 'default',
  size = 'default',
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : 'button';

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
