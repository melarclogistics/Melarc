import { useContext, useId, useLayoutEffect, useRef, useState, type ComponentProps } from 'react';

import { Calendar, CalendarDayButton } from '../../primitives/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '../../primitives/popover';
import { DialogContainer } from '../dialog/dialog-container';
import { useFieldControl } from '../field/Field';
import { Icon } from '../icon/Icon';
import './date-picker.css';
import {
  calendarFromJsDate,
  dateFromText,
  describeDay,
  jsDateFromCalendar,
  textFromDate,
  todayInAccra,
  weekdayInitial,
} from './date-value';
import {
  DAY_FIRST_LENGTH,
  dayFirstPartAt,
  formatDayFirst,
  maskDayFirst,
  readDayFirst,
  stepDayFirst,
} from './day-first';

export interface DatePickerProps {
  /** The date as `YYYY-MM-DD`, or null for none. The page holds it; the control only asks for a change. */
  readonly value: string | null;
  /**
   * The new date as `YYYY-MM-DD` once the text is a whole, real date, or null when there is none: the field was emptied, or the person left it with a part of the date cleared
   * or with a text that is refused (an impossible date, a year in fewer than four digits). A text that is only partly typed is not given, and the page keeps the date it held while
   * the person is still in the control, until they leave it.
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

type CalendarProps = ComponentProps<typeof Calendar>;

/**
 * A day of the calendar: the primitive's own, with the marks that this field's styles and checks name (they are the earlier calendar's): its class, the class of today, whether it is
 * chosen, outside the month or unavailable. A day outside the month is drawn hidden (date-picker.css) and an unavailable day is told so to a screen reader.
 */
function DatePickerDay({
  modifiers,
  className,
  ...props
}: ComponentProps<typeof CalendarDayButton>) {
  const classes = [
    'ui-date-picker__day',
    modifiers.today ? 'ui-date-picker__day--today' : undefined,
    className,
  ]
    .filter((name) => name !== undefined && name !== '')
    .join(' ');
  return (
    <CalendarDayButton
      {...props}
      modifiers={modifiers}
      className={classes}
      data-selected={modifiers.selected ? true : undefined}
      data-outside-month={modifiers.outside ? true : undefined}
      aria-disabled={modifiers.disabled ? true : undefined}
    />
  );
}

/**
 * The words and letters of the calendar are the portal's, in English and in this order, and not the browser's: a day is named `Thursday, 8 October 2026` (with `Today, ` before today's
 * and ` selected` after the chosen one), and the head of a column is the first letter of its weekday.
 */
const CALENDAR_LABELS: CalendarProps['labels'] = {
  labelDayButton: (date, modifiers) =>
    `${modifiers.today ? 'Today, ' : ''}${describeDay(calendarFromJsDate(date))}${modifiers.selected ? ' selected' : ''}`,
};

const CALENDAR_FORMATTERS: CalendarProps['formatters'] = {
  formatWeekdayName: (weekday) => weekdayInitial(weekday),
};

const CALENDAR_COMPONENTS: CalendarProps['components'] = { DayButton: DatePickerDay };

/**
 * A date, typed as DD/MM/YYYY or chosen from a calendar that opens under the field (COMPONENT_PATTERNS section 22a): one text field and a calendar in a popover,
 * on the shadcn/ui primitives (the calendar and the popover). A date goes in and comes out as the text `YYYY-MM-DD` and a page never sees a date object; the
 * language is fixed (day, month, year, Monday first, English) and not the browser's, so a screen does not change with the machine, and "today" is Accra's.
 *
 * **Reading is strict and corrects nothing** (`day-first.ts`): only `DD/MM/YYYY`, the year in full and a day that its month has; a text that is not a date is refused in plain
 * words (`There is no 30 February`, `Enter the year in full, for example 2026`), never moved to a date that it is not. Typing is helped (the slashes are put in), so `28102026`
 * is `28/10/2026`, and the arrow keys step the day, the month or the year under the caret. **The page keeps its date while the person is in the control** and is told of none
 * when they leave it with a part cleared or with a refused text (a refused text stays, with its words). Inside a Field it is named by the Field's label (a real label for the
 * field) and takes the Field's help, error and required state, as an Input does. It is a generic control: which days a pickup can be booked for is the page's
 * question and the server's answer, not this component's.
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
  const ids = useId();
  const groupId = `${ids}-group`;
  const buttonId = `${ids}-calendar`;
  const errorId = `${ids}-error`;
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  // Inside a modal dialog the calendar is drawn into it: the page behind a modal dialog is inert, and a calendar drawn there is unseen.
  const dialog = useContext(DialogContainer);
  const [open, setOpen] = useState(false);

  // What is in the field, and the value it stands for. The field keeps its own text while the person types: it is replaced only when the page changes the value
  // to one the control did not give, and it is never replaced by a value the control itself just gave.
  const [draft, setDraft] = useState(() => formatDayFirst(dateFromText(value)));
  const [standsFor, setStandsFor] = useState(value);
  const [showProblem, setShowProblem] = useState(false);
  if (value !== standsFor) {
    setStandsFor(value);
    setDraft(formatDayFirst(dateFromText(value)));
    setShowProblem(false);
  }

  const reading = readDayFirst(draft);
  const problem = reading !== undefined && !reading.ok ? reading : undefined;
  const heldDate = dateFromText(standsFor);
  const invalid = field?.invalid === true || (showProblem && problem !== undefined);

  const give = (next: string | null): void => {
    setStandsFor(next);
    onChange(next);
  };

  // The person has left the control (the field and its calendar button are one control), and what is in the field is settled. A whole date was given as it was typed. A text that
  // is not one is a mistake, and nothing is corrected. If a part of the date is missing or the text is in another form (`shape`) and the page held a date, the person took it out:
  // the page is told of none and the field is cleared; if the page held none, the field keeps what was typed and says in words what is wrong. A date written whole but refused (a year
  // in fewer than four digits, a day its month does not have, a day or month off the calendar) stays as it was typed, with its words, and the page, if it held a date, is told of none.
  const leave = (): void => {
    if (isReadOnly || isDisabled || reading === undefined || reading.ok) return;
    if (reading.problem === 'shape' && heldDate !== null) {
      setDraft('');
      setShowProblem(false);
      give(null);
      return;
    }
    setShowProblem(true);
    if (heldDate !== null) give(null);
  };

  // The caret stays where the person is typing when the field puts a slash in or takes a character out. Each request is a new object, so that the caret is
  // placed again even when the text did not change (a slash typed where one already is), and no request is ever left waiting for a later keystroke.
  const [caretAt, setCaretAt] = useState<{ readonly position: number } | undefined>();
  useLayoutEffect(() => {
    if (caretAt !== undefined) input.current?.setSelectionRange(caretAt.position, caretAt.position);
  }, [caretAt]);

  const today = jsDateFromCalendar(todayInAccra());
  const earliest = dateFromText(minValue);
  const latest = dateFromText(maxValue);
  // The calendar shows the date in the field, and while the field holds a text that is not yet a date, the date the page holds.
  const calendarDate = reading?.ok === true ? reading.date : heldDate;
  const unavailable = [
    ...(earliest === null ? [] : [{ before: jsDateFromCalendar(earliest) }]),
    ...(latest === null ? [] : [{ after: jsDateFromCalendar(latest) }]),
  ];

  const classes = [
    'ui-date-picker',
    invalid ? 'ui-date-picker--invalid' : undefined,
    isReadOnly ? 'ui-date-picker--readonly' : undefined,
    isDisabled ? 'ui-date-picker--disabled' : undefined,
  ]
    .filter((name) => name !== undefined)
    .join(' ');
  const describedBy = joined([
    ariaDescribedBy,
    field?.describedBy,
    showProblem && problem !== undefined ? errorId : undefined,
  ]);
  const labelId = field?.labelId ?? ariaLabelledBy;

  return (
    <div ref={root} className={classes}>
      <div
        role="group"
        id={groupId}
        className="ui-date-picker__control"
        aria-label={labelId === undefined ? ariaLabel : undefined}
        aria-labelledby={labelId}
        aria-describedby={describedBy}
        onBlur={(event) => {
          // Focus left the field or the calendar button (a blur from inside the calendar is the calendar's own business). A mistake in a half-typed date is said
          // when the person leaves the control, not when they pass from the field to its calendar button, which is how they open the calendar to finish the date.
          if (popover.current?.contains(event.target) === true) return;
          // Another window or the address bar has the focus: the control is as it was left, and the person comes back to it.
          if (document.activeElement === event.target) return;
          const next = event.relatedTarget;
          if (
            next instanceof Node &&
            (root.current?.contains(next) === true || popover.current?.contains(next) === true)
          ) {
            return;
          }
          leave();
        }}
      >
        <input
          ref={input}
          id={field?.id}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          maxLength={DAY_FIRST_LENGTH}
          placeholder="dd/mm/yyyy"
          className="ui-date-picker__input"
          value={draft}
          disabled={isDisabled}
          readOnly={isReadOnly}
          autoFocus={autoFocus}
          aria-label={labelId === undefined ? ariaLabel : undefined}
          aria-labelledby={field === null ? ariaLabelledBy : undefined}
          aria-describedby={describedBy}
          aria-invalid={invalid ? true : undefined}
          aria-required={field?.required === true ? true : undefined}
          onChange={(event) => {
            const native = event.nativeEvent as InputEvent;
            const raw = event.currentTarget.value;
            const next = maskDayFirst(draft, raw, native.inputType === 'insertFromPaste');
            if (next !== raw) {
              const position = event.currentTarget.selectionStart ?? raw.length;
              setCaretAt({
                position:
                  position >= raw.length
                    ? next.length
                    : Math.max(0, Math.min(next.length, position + next.length - raw.length)),
              });
            }
            setDraft(next);
            const result = readDayFirst(next);
            if (result === undefined) {
              // Emptied: no date, and no mistake.
              setShowProblem(false);
              if (heldDate !== null) give(null);
            } else if (result.ok) {
              setShowProblem(false);
              const text = textFromDate(result.date);
              if (text !== standsFor) give(text);
            } else {
              // Not a date (yet). The page keeps the date it held until the person leaves the control, as the earlier field did (`leave`). A text that is as long as a date is
              // told to be wrong at once (`There is no 30 February`); one still being typed (a year of two digits, a month and no year) is told when the person leaves.
              setShowProblem(next.length === DAY_FIRST_LENGTH);
            }
          }}
          onKeyDown={(event) => {
            // Enter in a form sends it, with whatever the page holds, and while the text is not a date the page still holds the date it had (the field
            // gives it none until the person leaves, `leave`): it would send the old date as if it were the person's. So while the text is not a date, Enter
            // does not send the form: it settles the field as leaving it does (a part taken out clears the date, a refused text says its words), and a
            // second Enter, the field now settled, sends. A whole date, or an empty field, sends at once. Never while a composition is open (an input
            // method's own Enter chooses a character), and never in a field that cannot be changed.
            if (event.key === 'Enter') {
              if (event.nativeEvent.isComposing || isReadOnly || isDisabled) return;
              if (problem !== undefined) {
                event.preventDefault();
                leave();
              }
              return;
            }
            // The arrow keys step the part of a whole date that the caret is in; with anything else typed, or the field read-only, they are the browser's.
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
            if (isReadOnly || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
              return;
            }
            if (reading?.ok !== true) return;
            event.preventDefault();
            const position = event.currentTarget.selectionStart ?? DAY_FIRST_LENGTH;
            const stepped = stepDayFirst(
              reading.date,
              dayFirstPartAt(position),
              event.key === 'ArrowUp' ? 1 : -1,
            );
            setDraft(formatDayFirst(stepped));
            setCaretAt({ position });
            setShowProblem(false);
            give(textFromDate(stepped));
          }}
        />
        <Popover
          open={open && !isDisabled && !isReadOnly}
          onOpenChange={(next) => {
            setOpen(next);
          }}
        >
          <PopoverTrigger asChild>
            <button
              type="button"
              id={buttonId}
              className="ui-date-picker__button"
              aria-label="Calendar"
              aria-labelledby={joined([
                buttonId,
                labelId ?? (ariaLabel === undefined ? undefined : groupId),
              ])}
              disabled={isDisabled || isReadOnly}
            >
              <Icon name="calendar" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            ref={popover}
            align="start"
            sideOffset={4}
            container={dialog}
            className="ui-date-picker__popover"
            aria-label="Choose a date"
            onOpenAutoFocus={(event) => {
              // The day to start from takes focus, as it does in every calendar: the chosen one, or today.
              event.preventDefault();
              popover.current
                ?.querySelector<HTMLElement>(
                  '[role="grid"] button:not([tabindex="-1"]):not(:disabled)',
                )
                ?.focus();
            }}
          >
            <Calendar
              mode="single"
              required
              selected={calendarDate === null ? undefined : jsDateFromCalendar(calendarDate)}
              defaultMonth={calendarDate === null ? today : jsDateFromCalendar(calendarDate)}
              today={today}
              disabled={unavailable}
              labels={CALENDAR_LABELS}
              formatters={CALENDAR_FORMATTERS}
              components={CALENDAR_COMPONENTS}
              onSelect={(date) => {
                const chosen = calendarFromJsDate(date);
                setDraft(formatDayFirst(chosen));
                setShowProblem(false);
                const text = textFromDate(chosen);
                if (text !== standsFor) give(text);
                setOpen(false);
              }}
            />
          </PopoverContent>
        </Popover>
      </div>
      {showProblem && problem !== undefined ? (
        <p id={errorId} className="ui-date-picker__problem">
          <Icon name="warning" size="sm" />
          <span>{problem.message}</span>
        </p>
      ) : null}
    </div>
  );
}
