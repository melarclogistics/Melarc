import * as React from 'react';
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, ChevronUpIcon } from 'lucide-react';
import { DayPicker, getDefaultClassNames, type DayButton } from 'react-day-picker';
import { enGB } from 'react-day-picker/locale';

import { Button, buttonVariants } from '@/components/primitives/button';
import { cn } from '@/lib/utils';

/*
 * A calendar on react-day-picker 10, drawn as the date field's own calendar is (components/ui/date-picker): a day is a square of the medium control
 * height that shrinks, down from there, to seven across the screen, so a week fits at 320px; a chosen day is Ink; today is told by a bar under the
 * number as well as its weight; the days between the ends of a range are the selected surface. A chosen day keeps a border of its own colour, which
 * forced-colours mode draws when it drops the fill.
 *
 * Its language and order are the portal's, not the browser's (`DATE_LOCALE` of the date field, COMPONENT_PATTERNS section 22a): English as written in the
 * United Kingdom, the week starting on Monday, a date told as day, month, year. They are defaults before the props, so a caller may still say otherwise.
 */
function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  captionLayout = 'label',
  buttonVariant = 'ghost',
  formatters,
  components,
  ...props
}: React.ComponentProps<typeof DayPicker> & {
  buttonVariant?: React.ComponentProps<typeof Button>['variant'];
}) {
  const defaultClassNames = getDefaultClassNames();

  return (
    <DayPicker
      locale={enGB}
      weekStartsOn={1}
      showOutsideDays={showOutsideDays}
      className={cn(
        'group/calendar bg-card p-3 [--cell-size:min(var(--control-height-md),calc((100vw_-_3rem)/7))] [[data-slot=card-content]_&]:bg-transparent [[data-slot=popover-content]_&]:bg-transparent',
        String.raw`rtl:**:[.rdp-button\_next>svg]:rotate-180`,
        String.raw`rtl:**:[.rdp-button\_previous>svg]:rotate-180`,
        className,
      )}
      captionLayout={captionLayout}
      formatters={{
        formatMonthDropdown: (date) => date.toLocaleString('en-GB', { month: 'short' }),
        ...formatters,
      }}
      classNames={{
        root: cn('w-fit', defaultClassNames.root),
        months: cn('relative flex flex-col gap-4 md:flex-row', defaultClassNames.months),
        month: cn('flex w-full flex-col gap-4', defaultClassNames.month),
        nav: cn(
          'absolute inset-x-0 top-0 flex w-full items-center justify-between gap-1',
          defaultClassNames.nav,
        ),
        button_previous: cn(
          buttonVariants({ variant: buttonVariant, size: 'icon' }),
          'size-(--cell-size) select-none',
          defaultClassNames.button_previous,
        ),
        button_next: cn(
          buttonVariants({ variant: buttonVariant, size: 'icon' }),
          'size-(--cell-size) select-none',
          defaultClassNames.button_next,
        ),
        month_caption: cn(
          'flex h-(--cell-size) w-full items-center justify-center px-(--cell-size)',
          defaultClassNames.month_caption,
        ),
        dropdowns: cn(
          'flex h-(--cell-size) w-full items-center justify-center gap-2 text-sm font-medium',
          defaultClassNames.dropdowns,
        ),
        dropdown_root: cn(
          'relative rounded-md border border-input has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-(color:--focus-ring)',
          defaultClassNames.dropdown_root,
        ),
        dropdown: cn('absolute inset-0 bg-popover opacity-0', defaultClassNames.dropdown),
        caption_label: cn(
          'font-semibold select-none',
          captionLayout === 'label'
            ? 'text-base'
            : 'flex min-h-(--control-height-sm) items-center gap-1 rounded-md pr-1 pl-2 text-sm [&>svg]:size-4 [&>svg]:text-muted-foreground',
          defaultClassNames.caption_label,
        ),
        month_grid: cn('w-full border-collapse', defaultClassNames.month_grid),
        weekdays: cn('flex', defaultClassNames.weekdays),
        weekday: cn(
          'flex-1 rounded-md pb-1 text-xs font-medium text-muted-foreground select-none',
          defaultClassNames.weekday,
        ),
        week: cn('flex w-full', defaultClassNames.week),
        week_number_header: cn('w-(--cell-size) select-none', defaultClassNames.week_number_header),
        week_number: cn(
          'size-(--cell-size) text-center align-middle text-xs text-muted-foreground select-none',
          defaultClassNames.week_number,
        ),
        day: cn(
          'group/day relative aspect-square h-full w-full p-0 text-center select-none',
          defaultClassNames.day,
        ),
        range_start: cn(
          'rounded-l-md bg-(color:--color-surface-selected)',
          defaultClassNames.range_start,
        ),
        range_middle: cn('rounded-none', defaultClassNames.range_middle),
        range_end: cn(
          'rounded-r-md bg-(color:--color-surface-selected)',
          defaultClassNames.range_end,
        ),
        today: cn(defaultClassNames.today),
        outside: cn(
          'text-muted-foreground aria-selected:text-muted-foreground',
          defaultClassNames.outside,
        ),
        disabled: cn('text-(color:--color-text-disabled)', defaultClassNames.disabled),
        hidden: cn('invisible', defaultClassNames.hidden),
        ...classNames,
      }}
      components={{
        Root: ({ className, rootRef, ...props }) => {
          return <div data-slot="calendar" ref={rootRef} className={cn(className)} {...props} />;
        },
        Chevron: ({ className, orientation, ...props }) => {
          if (orientation === 'left') {
            return <ChevronLeftIcon className={cn('size-4', className)} {...props} />;
          }

          if (orientation === 'right') {
            return <ChevronRightIcon className={cn('size-4', className)} {...props} />;
          }

          if (orientation === 'up') {
            return <ChevronUpIcon className={cn('size-4', className)} {...props} />;
          }

          return <ChevronDownIcon className={cn('size-4', className)} {...props} />;
        },
        DayButton: CalendarDayButton,
        ...components,
      }}
      {...props}
    />
  );
}

function CalendarDayButton({
  className,
  day,
  modifiers,
  ...props
}: React.ComponentProps<typeof DayButton>) {
  const defaultClassNames = getDefaultClassNames();

  const ref = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    if (modifiers.focused) ref.current?.focus();
  }, [modifiers.focused]);

  return (
    <Button
      ref={ref}
      variant="ghost"
      size="icon"
      data-day={day.date.toLocaleDateString()}
      data-selected-single={
        modifiers.selected &&
        !modifiers.range_start &&
        !modifiers.range_end &&
        !modifiers.range_middle
      }
      data-range-start={modifiers.range_start}
      data-range-end={modifiers.range_end}
      data-range-middle={modifiers.range_middle}
      data-today={modifiers.today}
      className={cn(
        'relative flex aspect-square size-auto w-full min-w-(--cell-size) flex-col items-center justify-center gap-1 rounded-md p-0 leading-none font-normal tabular-nums [&>span]:text-xs [&>span]:opacity-70',
        'data-[today=true]:font-medium data-[today=true]:after:absolute data-[today=true]:after:bottom-1 data-[today=true]:after:w-4 data-[today=true]:after:rounded-full data-[today=true]:after:border-b-2 data-[today=true]:after:border-current',
        'data-[selected-single=true]:border-primary data-[selected-single=true]:bg-primary data-[selected-single=true]:text-primary-foreground data-[selected-single=true]:hover:bg-(color:--color-action-primary-hover)',
        'data-[range-start=true]:rounded-md data-[range-start=true]:rounded-l-md data-[range-start=true]:border-primary data-[range-start=true]:bg-primary data-[range-start=true]:text-primary-foreground data-[range-start=true]:hover:bg-(color:--color-action-primary-hover)',
        'data-[range-end=true]:rounded-md data-[range-end=true]:rounded-r-md data-[range-end=true]:border-primary data-[range-end=true]:bg-primary data-[range-end=true]:text-primary-foreground data-[range-end=true]:hover:bg-(color:--color-action-primary-hover)',
        'data-[range-middle=true]:rounded-none data-[range-middle=true]:bg-(color:--color-surface-selected) data-[range-middle=true]:text-foreground data-[range-middle=true]:hover:bg-accent',
        defaultClassNames.day,
        className,
      )}
      {...props}
    />
  );
}

export { Calendar, CalendarDayButton };
