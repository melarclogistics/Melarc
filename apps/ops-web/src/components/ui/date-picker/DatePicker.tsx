import { useContext, useMemo, useRef } from 'react';
import {
  Button,
  Calendar,
  CalendarCell,
  CalendarGrid,
  DateInput,
  DatePicker as AriaDatePicker,
  DateSegment,
  Dialog,
  Group,
  Heading,
  I18nProvider,
  Popover,
} from 'react-aria-components';

import { DialogContainer } from '../dialog/dialog-container';
import { useFieldControl } from '../field/Field';
import { Icon } from '../icon/Icon';
import './date-picker.css';
import { DATE_LOCALE, dateFromText, textFromDate } from './date-value';
import { todayText } from '../../../platform/time/format-time';

export interface DatePickerProps {
  /** The date as `YYYY-MM-DD`, or null for none. The page holds it; the control only asks for a change. */
  readonly value: string | null;
  /**
   * The new date as `YYYY-MM-DD` once it is whole and real, or null when there is none: every part was cleared, or the person left the
   * control with a part of a date missing (the control then starts again from none). While a date is being typed the page hears of each
   * whole date on the way (the year 2, then 20, then 202, then 2026), so what it holds is checked, never trusted.
   */
  readonly onChange: (value: string | null) => void;
  /**
   * The earliest and the latest date the calendar offers, as `YYYY-MM-DD`. They are hints about what is worth choosing, never a rule: the
   * page checks what it can and the server decides (COMPONENT_PATTERNS sections 24 and 25), so a date typed outside them is still given.
   */
  readonly minValue?: string;
  readonly maxValue?: string;
  readonly isDisabled?: boolean;
  /** Readable and copyable, not editable, and no calendar: it is not styled as disabled. */
  readonly isReadOnly?: boolean;
  readonly autoFocus?: boolean;
  /** The name of a control that stands on its own. Inside a Field the Field's label names it. */
  readonly 'aria-label'?: string;
  readonly 'aria-labelledby'?: string;
  readonly 'aria-describedby'?: string;
}

const joined = (parts: readonly (string | undefined)[]): string | undefined => {
  const text = parts.filter((part) => part !== undefined && part !== '').join(' ');
  return text === '' ? undefined : text;
};

/**
 * A date, chosen by typing its day, month and year or from a calendar (COMPONENT_PATTERNS section 22a). The behaviour is React Aria
 * Components' (keys, focus, screen-reader names, the calendar's grid); the look is the portal's alone, from tokens.css. A page never sees the
 * library: a date goes in and comes out as the text `YYYY-MM-DD`, and the language is fixed (day, month, year, Monday first, English) and not
 * the browser's, so a screen does not change with the machine. "Today" is Accra's.
 *
 * Inside a Field it is named by the Field's label and takes the Field's help, error and required state, as an Input does. It is a generic
 * control: which days a pickup can be booked for is the page's question and the server's answer, not this component's.
 */
export function DatePicker({
  value,
  onChange,
  minValue,
  maxValue,
  isDisabled = false,
  isReadOnly = false,
  autoFocus = false,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  'aria-describedby': ariaDescribedBy,
}: DatePickerProps) {
  const field = useFieldControl();
  const root = useRef<HTMLDivElement>(null);
  // Inside a modal dialog the calendar is drawn into it: the page behind a modal dialog is inert, and a calendar drawn there is unseen.
  const dialog = useContext(DialogContainer);
  // The library keeps what a person has typed and not finished until the value it was given changes, and it judges a change by identity: a
  // new date object on every render would wipe an edit at the next render of the page (a refetch, a timer, a parent's state). So the
  // objects it is given are made once for the text they are made from.
  const todayAt = todayText();
  const today = useMemo(() => dateFromText(todayAt), [todayAt]);
  const date = useMemo(() => dateFromText(value), [value]);
  const earliest = useMemo(() => dateFromText(minValue), [minValue]);
  const latest = useMemo(() => dateFromText(maxValue), [maxValue]);
  const invalid = field?.invalid === true;
  const classes = [
    'ui-date-picker',
    invalid ? 'ui-date-picker--invalid' : undefined,
    isReadOnly ? 'ui-date-picker--readonly' : undefined,
    isDisabled ? 'ui-date-picker--disabled' : undefined,
  ]
    .filter((name) => name !== undefined)
    .join(' ');

  return (
    <I18nProvider locale={DATE_LOCALE}>
      <div
        ref={root}
        className={classes}
        onBlur={(event) => {
          // The library tells the page of a date once it is whole, and of none once every part is cleared. A person who clears one part of a
          // whole date (or takes a digit off it: 28 becomes 2) leaves the control blank in a place while the page still holds the date it
          // last heard of, and would submit it. On leaving, the two are made to agree: a date with a part missing is none, and the control
          // starts again from none. Moving between the parts, to the calendar button or into the calendar is not leaving.
          const next = event.relatedTarget;
          if (isReadOnly || isDisabled || date === null || root.current === null) return;
          // The window lost focus (another window, the address bar, the developer tools): focus did not leave the control, and comes back with
          // the window, to a control that must be as it was left.
          if (document.activeElement === event.target) return;
          if (
            next instanceof Element &&
            (root.current.contains(next) || next.closest('.ui-date-picker__popover') !== null)
          )
            return;
          if (root.current.querySelector('.ui-date-picker__segment[data-placeholder]') !== null)
            onChange(null);
        }}
      >
        <AriaDatePicker
          className="ui-date-picker__picker"
          value={date}
          onChange={(date) => {
            onChange(textFromDate(date));
          }}
          minValue={earliest}
          maxValue={latest}
          placeholderValue={today}
          granularity="day"
          shouldForceLeadingZeros
          validationBehavior="aria"
          isDisabled={isDisabled}
          isReadOnly={isReadOnly}
          isInvalid={invalid}
          isRequired={field?.required === true}
          autoFocus={autoFocus}
          aria-label={ariaLabel}
          aria-labelledby={field?.labelId ?? ariaLabelledBy}
          aria-describedby={joined([ariaDescribedBy, field?.describedBy])}
        >
          <Group className="ui-date-picker__control">
            <DateInput className="ui-date-picker__input">
              {(segment) => <DateSegment segment={segment} className="ui-date-picker__segment" />}
            </DateInput>
            <Button className="ui-date-picker__button">
              <Icon name="calendar" />
            </Button>
          </Group>
          {/* The library marks this prop deprecated for a parent `UNSAFE_PortalProvider`, which it exports from `react-aria` and not from
              `react-aria-components`: using it would add a package to the dependencies, which is the owner's to decide (plan section 7.50).
              The prop works at the pinned version; this is the one use of it. */}
          <Popover
            className="ui-date-picker__popover"
            placement="bottom start"
            offset={4}
            // eslint-disable-next-line @typescript-eslint/no-deprecated -- see the comment above
            UNSTABLE_portalContainer={dialog ?? undefined}
          >
            <Dialog className="ui-date-picker__dialog">
              <Calendar className="ui-date-picker__calendar">
                <header className="ui-date-picker__header">
                  <Button slot="previous" className="ui-date-picker__button">
                    <Icon name="previous" />
                  </Button>
                  <Heading className="ui-date-picker__month" />
                  <Button slot="next" className="ui-date-picker__button">
                    <Icon name="next" />
                  </Button>
                </header>
                <CalendarGrid className="ui-date-picker__grid">
                  {(day) => (
                    <CalendarCell
                      date={day}
                      className={
                        today !== null && day.compare(today) === 0
                          ? 'ui-date-picker__day ui-date-picker__day--today'
                          : 'ui-date-picker__day'
                      }
                    />
                  )}
                </CalendarGrid>
              </Calendar>
            </Dialog>
          </Popover>
        </AriaDatePicker>
      </div>
    </I18nProvider>
  );
}
