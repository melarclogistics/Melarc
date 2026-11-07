import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import { Field } from '../field/Field';
import { DatePicker, type DatePickerProps } from './DatePicker';
import { DAY_FIRST_MESSAGES } from './day-first';

/**
 * The date field is one text field for DD/MM/YYYY and a calendar in a popover (COMPONENT_PATTERNS section 22a). Until the last block, these are the earlier field's tests with
 * every assertion as it was written (the Product Owner's decision of 6 November 2026), except the two tests of the two rules that the Product Owner changed on 7 November 2026:
 * an impossible date is refused (it was moved to the nearest real one) and the year is required in full (a year of fewer than four digits was taken as that year). Otherwise only the
 * way a test enters a date or finds the control changed, because the three parts (day, month, year) became one field. `part()` is the one field, which holds all three;
 * `clickPart()` and `selectPart()` put the caret in a part, as a click or a double click on it did; `parts()` reads the field as the tests read the three parts, with what is still
 * to be typed (dd, mm, yyyy) where a part has nothing yet. The last block is what the one field adds, written for it.
 */

type User = ReturnType<typeof userEvent.setup>;
type Kind = 'day' | 'month' | 'year';

/** A page that holds the date, as a real one does: the control only asks for a change, and shows what it is given. */
function Host({
  initial = null,
  onChange,
  ...rest
}: { initial?: string | null; onChange?: (value: string | null) => void } & Omit<
  DatePickerProps,
  'value' | 'onChange'
>) {
  const [value, setValue] = useState<string | null>(initial);
  return (
    <Field label="Service date" help="Monday to Saturday." required>
      <DatePicker
        {...rest}
        value={value}
        onChange={(next) => {
          setValue(next);
          onChange?.(next);
        }}
      />
    </Field>
  );
}

/** The one text field of the date on the page (a test that has more than one date finds each by its group). */
const field = (): HTMLInputElement => screen.getByRole<HTMLInputElement>('textbox');
/** The three parts of the date as the field shows them: the digits typed, or what is still to be typed (dd, mm, yyyy) where a part has nothing yet. */
const parts = (): string[] => {
  const typed = field().value.split('/');
  return ['dd', 'mm', 'yyyy'].map((still, index) => {
    const written = typed[index] ?? '';
    return written === '' ? still : written;
  });
};
const calendarButton = (): HTMLElement => screen.getByRole('button', { name: /^Calendar/ });
const day = (label: RegExp | string): HTMLElement => screen.getByRole('button', { name: label });

/** Where a click into a part leaves the caret in `dd/mm/yyyy`: at the end of that part. */
const END_OF = { day: 2, month: 5, year: 10 } as const;
/** The characters of a part, for selecting it. */
const SPAN = { day: [0, 2], month: [3, 5], year: [6, 10] } as const;

/** One part of the date: the one field, which holds all three (the earlier control had a spinbutton for each). */
const part = (kind: Kind): HTMLInputElement => {
  if (!(kind in SPAN)) throw new Error(`The date has no ${kind} part`);
  return field();
};

/** Clicks into one part of the date: a click in the field, with the caret at the end of that part (or of the text, where it is shorter). */
async function clickPart(user: User, kind: Kind): Promise<void> {
  const input = field();
  await user.pointer({
    keys: '[MouseLeft]',
    target: input,
    offset: Math.min(END_OF[kind], input.value.length),
  });
}

/** Selects one part of the date, as a double click on it does, so that what is typed next replaces it. */
async function selectPart(user: User, kind: Kind): Promise<void> {
  await user.click(field());
  const [start, end] = SPAN[kind];
  field().setSelectionRange(start, Math.min(end, field().value.length));
}

const originalZone = process.env.TZ;

afterEach(() => {
  vi.useRealTimers();
  if (originalZone === undefined) Reflect.deleteProperty(process.env, 'TZ');
  else process.env.TZ = originalZone;
});

/** The clock as it is in Accra's Wednesday 28 October 2026, at ten in the morning. */
const AT_ACCRA_WEDNESDAY = new Date('2026-10-28T10:00:00Z');

describe('DatePicker: what a person sees', () => {
  // Break caught: the order of the parts taken from the browser (jsdom's is United States English: month first), so that 03/04 means two
  // days to two people. The order and the words are the portal's: day, month, year.
  it('shows a date day first, with a zero in front, whatever language the browser has', () => {
    render(<Host initial="2026-10-08" />);

    expect(parts()).toEqual(['08', '10', '2026']);
    expect(navigator.language).toBe('en-US');
  });

  // Break caught: an empty control that shows nothing of what each part is for, or one that gives the page a date nobody chose.
  it('shows what each part is for when there is no date, and gives nothing', () => {
    const onChange = vi.fn();
    render(<Host onChange={onChange} />);

    expect(parts()).toEqual(['dd', 'mm', 'yyyy']);
    expect(onChange).not.toHaveBeenCalled();
  });

  // Break caught: text that is not a date drawn as another one (30 February as the 28th), which a person would then confirm.
  it.each(['2026-02-30', '28/10/2026', 'tomorrow', ''])(
    'shows %j, which is not a date, as an empty control',
    (text) => {
      render(<Host initial={text} />);

      expect(parts()).toEqual(['dd', 'mm', 'yyyy']);
    },
  );
});

describe('DatePicker inside a Field', () => {
  // Break caught: a date a screen reader user cannot name, or one whose help and error are never read.
  it('is named by the Field label, and described by its help and its error', () => {
    render(
      <Field label="Service date" help="Monday to Saturday." error="Choose a day we collect on.">
        <DatePicker value="2026-10-08" onChange={() => undefined} />
      </Field>,
    );

    const group = screen.getByRole('group', { name: 'Service date' });
    expect(group).toHaveAccessibleDescription(/Monday to Saturday\. Choose a day we collect on\./);
    for (const part of screen.getAllByRole('textbox')) {
      expect(part).toHaveAccessibleName(/Service date/);
      expect(part).toHaveAccessibleDescription(/Monday to Saturday\./);
    }
    expect(calendarButton()).toHaveAccessibleName(/Calendar.*Service date/);
  });

  // Break caught: an error that is only a red border, or a required date that is not announced as required.
  it('is invalid when the Field has an error and required when the Field says so, on every part', () => {
    const { container } = render(
      <Field label="Service date" error="Choose a day we collect on." required>
        <DatePicker value={null} onChange={() => undefined} />
      </Field>,
    );

    expect(screen.getByRole('group', { name: 'Service date (required)' })).toBeInTheDocument();
    for (const part of screen.getAllByRole('textbox')) {
      expect(part).toHaveAttribute('aria-invalid', 'true');
      expect(part).toHaveAttribute('aria-required', 'true');
    }
    expect(container.querySelector('.ui-date-picker')).toHaveClass('ui-date-picker--invalid');
    expect(screen.getByText('Choose a day we collect on.')).toBeInTheDocument();
  });

  // Break caught: a control that marks itself invalid or required when no Field says so (it is the page's to say, with the words).
  it('is not invalid or required of its own accord', () => {
    render(
      <Field label="Service date">
        <DatePicker value={null} onChange={() => undefined} />
      </Field>,
    );

    for (const part of screen.getAllByRole('textbox')) {
      expect(part).not.toHaveAttribute('aria-invalid');
      expect(part).not.toHaveAttribute('aria-required');
    }
  });

  // Break caught: a control outside a Field with no accessible name, which a screen reader would meet as an unlabelled edit box.
  it('is named by aria-label when it stands on its own', () => {
    render(<DatePicker value={null} onChange={() => undefined} aria-label="Reschedule to" />);

    expect(screen.getByRole('group', { name: 'Reschedule to' })).toBeInTheDocument();
  });

  // Break caught: two dates on one page naming or describing each other.
  it('keeps two dates on one page apart', () => {
    render(
      <>
        <Field label="From">
          <DatePicker value="2026-10-01" onChange={() => undefined} />
        </Field>
        <Field label="To">
          <DatePicker value="2026-10-31" onChange={() => undefined} />
        </Field>
      </>,
    );

    expect(
      within(screen.getByRole('group', { name: 'From' })).getAllByRole('textbox'),
    ).toHaveLength(1);
    expect(
      within(screen.getByRole('group', { name: 'To' }))
        .getByRole<HTMLInputElement>('textbox')
        .value.split('/')[0],
    ).toBe('31');
  });
});

describe('DatePicker: typing a date', () => {
  // Break caught: a date given in another shape from the one the page and the API use, or before it is whole.
  it('gives the date once all of it is typed, as YYYY-MM-DD, and not before', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Host onChange={onChange} />);

    await clickPart(user, 'day');
    await user.keyboard('2810');
    expect(onChange).not.toHaveBeenCalled();

    await user.keyboard('2026');
    expect(onChange).toHaveBeenLastCalledWith('2026-10-28');
    expect(parts()).toEqual(['28', '10', '2026']);
  });

  // Break caught: a date with a part cleared still held by the page after the person has left, which would save a date they can see is not there. While they are in the control
  // the page keeps the date it held (the control and the page disagree, as the earlier field's did); leaving makes them agree: the page is told none and the field is cleared.
  it('gives none when the person leaves a date they have cleared a part of', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <>
        <Host initial="2026-10-28" onChange={onChange} />
        <button type="button">Elsewhere</button>
      </>,
    );

    await clickPart(user, 'day');
    await user.keyboard('{Backspace}{Backspace}');
    expect(parts()).toEqual(['dd', '10', '2026']);
    expect(onChange).not.toHaveBeenLastCalledWith(null);

    await user.click(screen.getByRole('button', { name: 'Elsewhere' }));

    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(parts()).toEqual(['dd', 'mm', 'yyyy']);
  });

  // Break caught: the calendar taken for leaving the control, so that opening it to finish a half-cleared date discards the date first.
  it('does not take opening the calendar, or moving about in it, for leaving the control', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Host initial="2026-10-28" onChange={onChange} />);

    // The earlier field gave the page the day 2 as the first digit came off 28, and the calendar then opened on the 2nd. This field gives the page a date only when it is whole,
    // so the person sets the day to 02 first (the page is given the 2nd), and then takes it off with the same two Backspaces.
    await selectPart(user, 'day');
    await user.keyboard('02');
    await user.keyboard('{Backspace}{Backspace}');
    await user.click(calendarButton());
    await user.keyboard('{ArrowRight}');

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalledWith(null);

    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenLastCalledWith('2026-10-03');
    expect(parts()).toEqual(['03', '10', '2026']);
  });

  // Break caught: a date object made anew at every render, which the library takes for a new value and so draws again from, wiping a date
  // that is half edited whenever the page renders for any reason (a refetch, a timer, a parent's state).
  it('keeps a date that is half edited when the page renders again with the same value', async () => {
    const user = userEvent.setup();
    function Ticking() {
      const [ticks, setTicks] = useState(0);
      const [value, setValue] = useState<string | null>('2026-10-28');
      useEffect(() => {
        const tick = () => {
          setTicks((count) => count + 1);
        };
        window.addEventListener('demo-tick', tick);
        return () => {
          window.removeEventListener('demo-tick', tick);
        };
      }, []);
      return (
        <Field label="Service date">
          <DatePicker
            value={value}
            onChange={setValue}
            minValue="2026-01-01"
            maxValue="2026-12-31"
          />
          <output>{ticks}</output>
        </Field>
      );
    }
    render(<Ticking />);

    await clickPart(user, 'day');
    await user.keyboard('{Backspace}{Backspace}');
    expect(parts()).toEqual(['dd', '10', '2026']);

    act(() => {
      window.dispatchEvent(new Event('demo-tick'));
    });

    expect(screen.getByRole('status')).toHaveTextContent('1');
    expect(parts()).toEqual(['dd', '10', '2026']);
  });

  // Break caught: the window losing focus (another window, the address bar) taken for leaving the control, which discarded a half-edited
  // date that the person comes back to.
  it('does not take the window losing focus for leaving the control', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Host initial="2026-10-28" onChange={onChange} />);

    await clickPart(user, 'day');
    await user.keyboard('{Backspace}{Backspace}');
    expect(document.activeElement).toBe(part('day'));
    fireEvent.focusOut(part('day'), { relatedTarget: null });

    expect(onChange).not.toHaveBeenCalledWith(null);
    expect(parts()).toEqual(['dd', '10', '2026']);
  });

  // Break caught: tabbing through a date the page holds as text that is no date, or through one that cannot be edited, changing what the page
  // holds.
  it.each([
    ['text that is no date', '2026-02-30', {}],
    ['a read-only date', '2026-10-28', { isReadOnly: true }],
    ['a disabled date', '2026-10-28', { isDisabled: true }],
  ] as const)('says nothing when the person passes through %s', async (_label, initial, props) => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <>
        <Host initial={initial} onChange={onChange} {...props} />
        <button type="button">Elsewhere</button>
      </>,
    );

    await user.tab();
    await user.click(screen.getByRole('button', { name: 'Elsewhere' }));

    expect(onChange).not.toHaveBeenCalled();
  });

  // Break caught: a label that leads nowhere, where a native date's leads into the field.
  it('leads the label to the first part of the date', async () => {
    const user = userEvent.setup();
    render(<Host />);

    await user.click(screen.getByText('Service date'));

    expect(part('day')).toHaveFocus();
  });

  // Break caught: the same disagreement the other way round: the control left blank in a place by a person who never had a date, and the page
  // told of none, again and again.
  it('says nothing when the person leaves a date they never completed', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <>
        <Host onChange={onChange} />
        <button type="button">Elsewhere</button>
      </>,
    );

    await clickPart(user, 'day');
    await user.keyboard('2810');
    await user.click(screen.getByRole('button', { name: 'Elsewhere' }));

    expect(parts()).toEqual(['28', '10', 'yyyy']);
    expect(onChange).not.toHaveBeenCalled();
  });

  // Break caught: a year typed in two digits (26 for 2026) taken as the year 26, or as another year, instead of refused: the year is required in full (the Product Owner's decision of
  // 7 November 2026; the earlier field took it as the year 26). The control keeps what was typed, says what to do, and gives the page nothing until the year is whole.
  it('refuses a year typed in fewer than four digits, in words, and gives the date once the year is whole', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <>
        <Host onChange={onChange} />
        <button type="button">Elsewhere</button>
      </>,
    );

    await clickPart(user, 'day');
    await user.keyboard('281026');
    await user.click(screen.getByRole('button', { name: 'Elsewhere' }));

    expect(parts()).toEqual(['28', '10', '26']);
    expect(screen.getByText('Enter the year in full, for example 2026')).toBeVisible();
    expect(onChange).not.toHaveBeenCalled();

    await selectPart(user, 'year');
    await user.keyboard('2026');
    expect(onChange).toHaveBeenLastCalledWith('2026-10-28');
    expect(parts()).toEqual(['28', '10', '2026']);
  });

  // Break caught: a date that does not exist (30 February) moved to one that does, or given as it was typed, or left without words: the field refuses an impossible date (the Product
  // Owner's decision of 7 November 2026; the earlier field moved it to the 28th). It says so as soon as the date is written whole, keeps what was typed, and gives the page nothing.
  it('refuses a date that does not exist, in words, and gives nothing', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <>
        <Host onChange={onChange} />
        <button type="button">Elsewhere</button>
      </>,
    );

    await clickPart(user, 'day');
    await user.keyboard('30022026');
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText('There is no 30 February')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Elsewhere' }));

    expect(parts()).toEqual(['30', '02', '2026']);
    expect(screen.getByText('There is no 30 February')).toBeVisible();
    expect(onChange).not.toHaveBeenCalled();
  });

  // Break caught: the arrow keys not stepping the part the caret is in.
  it('steps a part with the arrow keys', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Host initial="2026-10-28" onChange={onChange} />);

    await clickPart(user, 'day');
    await user.keyboard('{ArrowUp}');

    expect(onChange).toHaveBeenLastCalledWith('2026-10-29');
  });

  // Break caught: a stop a keyboard user can reach only after the one before it, in the wrong order, or not at all. (The earlier control had three stops before the button, one
  // for each of day, month and year; this one has the field.)
  it('is walked by Tab: the field, then the calendar button', async () => {
    const user = userEvent.setup();
    render(<Host initial="2026-10-28" />);

    await user.tab();
    expect(field()).toHaveFocus();
    await user.tab();
    expect(calendarButton()).toHaveFocus();
  });
});

describe('DatePicker: the calendar', () => {
  // Break caught: the week starting on Sunday (the browser's habit in the United States), or the calendar opening on another month than the date.
  it('opens on the month of the date, with the week starting on Monday', async () => {
    const user = userEvent.setup();
    render(<Host initial="2026-10-08" />);

    await user.click(calendarButton());

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('grid', { name: 'October 2026' })).toBeInTheDocument();
    expect(
      within(dialog)
        .getAllByRole('columnheader', { hidden: true })
        .map((cell) => cell.textContent),
    ).toEqual(['M', 'T', 'W', 'T', 'F', 'S', 'S']);
    expect(day('Thursday, 8 October 2026 selected')).toHaveFocus();
  });

  // Break caught: "today" taken from the machine's zone, so a laptop abroad opens on, and marks, the wrong day for hours of every day.
  it("opens on today in Accra when there is no date, and marks it, whatever the machine's zone", async () => {
    process.env.TZ = 'Pacific/Kiritimati';
    vi.useFakeTimers({ toFake: ['Date'] });
    // Fourteen hours ahead of Accra, it is already Sunday 1 November there; in Accra it is still Saturday 31 October.
    vi.setSystemTime(new Date('2026-10-31T23:30:00Z'));
    const user = userEvent.setup();
    render(<Host />);

    await user.click(calendarButton());

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('grid', { name: 'October 2026' })).toBeInTheDocument();
    const today = day(/Saturday, 31 October 2026/);
    expect(today).toHaveClass('ui-date-picker__day--today');
    expect(
      within(dialog)
        .getAllByRole('button')
        .filter((cell) => cell.classList.contains('ui-date-picker__day--today')),
    ).toHaveLength(1);
  });

  // Break caught: a click that does not choose, a choice that is not given as text, a calendar left open, or focus lost after it closes.
  it('chooses a day by click, gives it as text, closes, and puts focus back on the button', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(AT_ACCRA_WEDNESDAY);
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Host onChange={onChange} />);

    await user.click(calendarButton());
    await user.click(day(/Friday, 30 October 2026/));

    expect(onChange).toHaveBeenLastCalledWith('2026-10-30');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(parts()).toEqual(['30', '10', '2026']);
    await waitFor(() => {
      expect(calendarButton()).toHaveFocus();
    });
  });

  // Break caught: a calendar a keyboard cannot move in, choose from or leave, or an Escape that changes the date.
  it('moves by the arrow keys, chooses with Enter, and Escape leaves it as it was', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(AT_ACCRA_WEDNESDAY);
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Host initial="2026-10-28" onChange={onChange} />);

    await user.click(calendarButton());
    expect(day(/Wednesday, 28 October 2026 selected/)).toHaveFocus();
    await user.keyboard('{ArrowRight}{ArrowDown}');
    expect(day(/Thursday, 5 November 2026/)).toHaveFocus();
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    expect(parts()).toEqual(['28', '10', '2026']);
    await waitFor(() => {
      expect(calendarButton()).toHaveFocus();
    });

    await user.keyboard('{Enter}');
    await user.keyboard('{ArrowLeft}{Enter}');
    expect(onChange).toHaveBeenLastCalledWith('2026-10-27');
  });

  // Break caught: month buttons that do not turn the month, or that have no names for a screen reader.
  it('turns the months with its two buttons', async () => {
    const user = userEvent.setup();
    render(<Host initial="2026-10-28" />);

    // The two buttons are found by their names, "Go to the next month" and "Go to the previous month"; the earlier calendar's were named Next and Previous.
    await user.click(calendarButton());
    await user.click(screen.getByRole('button', { name: /next month/i }));
    expect(screen.getByRole('grid', { name: 'November 2026' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /previous month/i }));
    await user.click(screen.getByRole('button', { name: /previous month/i }));
    expect(screen.getByRole('grid', { name: 'September 2026' })).toBeInTheDocument();
  });

  // Break caught: a day outside the range offered as if it could be chosen, or one the control gives anyway when it is clicked.
  it('does not offer, and does not give, a day outside the earliest and the latest it was told of', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Host initial="2026-10-12" onChange={onChange} minValue="2026-10-05" maxValue="2026-10-20" />,
    );

    await user.click(calendarButton());
    const before = day(/Sunday, 4 October 2026/);
    const after = day(/Wednesday, 21 October 2026/);
    expect(before).toHaveAttribute('aria-disabled', 'true');
    expect(after).toHaveAttribute('aria-disabled', 'true');
    expect(day(/Monday, 5 October 2026/)).not.toHaveAttribute('aria-disabled');
    await user.click(before);
    await user.click(after);

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  // Break caught: the range taken as a rule, so that a date typed outside it is refused by the control and the page never learns of it.
  it('still gives a date that was typed outside the range, because the page and the server decide', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Host initial="2026-10-12" onChange={onChange} minValue="2026-10-05" maxValue="2026-10-20" />,
    );

    await clickPart(user, 'day');
    await user.keyboard('{ArrowUp}'.repeat(12));

    expect(onChange).toHaveBeenLastCalledWith('2026-10-24');
  });
});

describe('DatePicker: the rest of the keys, and what it is named and described by', () => {
  // Break caught: a calendar that moves by the day only (PageUp and PageDown by the month are the keys of every calendar), or one that Space
  // does not choose in.
  it('moves by the month with PageUp and PageDown, and chooses with Space', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(AT_ACCRA_WEDNESDAY);
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Host initial="2026-10-28" onChange={onChange} />);

    await user.click(calendarButton());
    await user.keyboard('{PageDown}');
    expect(day(/Saturday, 28 November 2026/)).toHaveFocus();
    await user.keyboard('{PageUp}{PageUp}');
    expect(day(/Monday, 28 September 2026/)).toHaveFocus();
    await user.keyboard(' ');

    expect(onChange).toHaveBeenLastCalledWith('2026-09-28');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  // Break caught: a range handed to the library as a rule, which flags a date typed outside it invalid with no words beside it: the range is
  // a hint, and an error is the page's to say.
  it('does not mark a date typed outside the range as invalid', async () => {
    const user = userEvent.setup();
    render(<Host initial="2026-10-12" minValue="2026-10-05" maxValue="2026-10-20" />);

    await clickPart(user, 'day');
    await user.keyboard('{ArrowUp}'.repeat(12));

    expect(parts()).toEqual(['24', '10', '2026']);
    for (const each of screen.getAllByRole('textbox')) {
      expect(each).not.toHaveAttribute('aria-invalid', 'true');
    }
  });

  // Break caught: a description the caller gave dropped when the Field adds its own (or the Field's dropped for the caller's), so that a
  // screen reader hears one of the two.
  it('is described by what the caller says and by what the Field says', () => {
    render(
      <>
        <p id="own-note">Pickups are Monday to Saturday.</p>
        <Field label="Service date" help="Day, month and year.">
          <DatePicker value={null} onChange={vi.fn()} aria-describedby="own-note" />
        </Field>
      </>,
    );

    // The group and the field are both described, so that a screen reader reads it once, on arriving, whichever of the two it arrives at.
    for (const described of [screen.getByRole('group', { name: 'Service date' }), part('day')]) {
      expect(described).toHaveAccessibleDescription(/Pickups are Monday to Saturday\./);
      expect(described).toHaveAccessibleDescription(/Day, month and year\./);
    }
  });

  // Break caught: a control that stands on its own named by nothing, because only the Field's label and aria-label were wired.
  it('is named by the element aria-labelledby points at when it stands on its own', () => {
    render(
      <>
        <span id="outside-label">Collection date</span>
        <DatePicker value={null} onChange={vi.fn()} aria-labelledby="outside-label" />
      </>,
    );

    expect(screen.getByRole('group', { name: 'Collection date' })).toBeInTheDocument();
    expect(part('day')).toHaveAccessibleName(/Collection date/);
  });

  // Break caught: autoFocus dropped, so that a form that opens on its date field opens on nothing.
  it('takes focus on its first part when it is asked to', () => {
    render(<Host autoFocus />);

    expect(part('day')).toHaveFocus();
  });
});

describe('DatePicker: read-only and disabled', () => {
  // Break caught: a read-only date that opens a calendar and so invites an edit that is then silently dropped.
  it('offers a read-only date no calendar, and keeps it legible and focusable', async () => {
    const user = userEvent.setup();
    const { container } = render(<Host initial="2026-10-08" isReadOnly />);

    expect(calendarButton()).toBeDisabled();
    await user.click(calendarButton());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(parts()).toEqual(['08', '10', '2026']);
    await user.tab();
    expect(screen.getAllByRole('textbox')[0]).toHaveFocus();
    expect(container.querySelector('.ui-date-picker')).toHaveClass('ui-date-picker--readonly');
    expect(container.querySelector('.ui-date-picker')).not.toHaveClass('ui-date-picker--disabled');
  });

  // Break caught: a disabled date that still takes focus, can be edited or opens its calendar.
  it('gives a disabled date no focus, no editing and no calendar', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container } = render(<Host initial="2026-10-08" isDisabled onChange={onChange} />);

    expect(calendarButton()).toBeDisabled();
    // The earlier control was three divs and so said it with aria-disabled on each; the one field is a native input, which says it with `disabled`.
    for (const part of screen.getAllByRole('textbox')) {
      expect(part).toBeDisabled();
    }
    await clickPart(user, 'day');
    await user.keyboard('{ArrowUp}');
    expect(onChange).not.toHaveBeenCalled();
    expect(container.querySelector('.ui-date-picker')).toHaveClass('ui-date-picker--disabled');
  });
});

describe('DatePicker: accessibility checks that need no layout', () => {
  // Break caught: a name, a role or a relationship the automated checks can see is wrong, closed or with the calendar open.
  it('has no automated WCAG violation, closed or open', async () => {
    const user = userEvent.setup();
    const { container } = render(<Host initial="2026-10-08" />);

    expect(await wcagViolations(container)).toEqual([]);
    await user.click(calendarButton());
    expect(await wcagViolations(document.body)).toEqual([]);
  });
});

describe('DatePicker: what the one field adds', () => {
  // Break caught: an empty control that is a blank field with no hint of what to type.
  it('shows what is to be typed when there is no date', () => {
    render(<Host />);

    expect(field()).toHaveValue('');
    expect(field()).toHaveAttribute('placeholder', 'dd/mm/yyyy');
  });

  // Break caught: a native date input in the page (the browser's own order and language), which this field replaces everywhere.
  it('is a text field and never a native date input', () => {
    const { container } = render(<Host />);

    expect(container.querySelector('input[type="date"]')).toBeNull();
    expect(field()).toHaveAttribute('type', 'text');
  });

  // Break caught: the page told of a year on the way (the year 2, then 20, then 202), which it would check as dates.
  it('never tells the page of a date that is only part typed', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Host onChange={onChange} />);

    await user.click(field());
    await user.keyboard('2810202');

    expect(field()).toHaveValue('28/10/202');
    expect(onChange).not.toHaveBeenCalled();
  });

  // Break caught: an emptied field that the page still holds a date for, or one that is told to be a mistake.
  it('gives none when the field is emptied, and no mistake', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Host initial="2026-10-28" onChange={onChange} />);

    await user.clear(field());

    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(screen.queryByText(DAY_FIRST_MESSAGES.shape)).toBeNull();
  });

  // Break caught: a value the page changes (a "today" button, a clear button, a navigation) not reaching the field, which would go on showing the old date.
  it('shows a value the page changes, and replaces what was typed', async () => {
    const user = userEvent.setup();
    function Controlled() {
      const [value, setValue] = useState<string | null>('2026-10-28');
      return (
        <>
          <Field label="Service date">
            <DatePicker value={value} onChange={setValue} />
          </Field>
          <button
            type="button"
            onClick={() => {
              setValue('2026-11-03');
            }}
          >
            Set
          </button>
          <button
            type="button"
            onClick={() => {
              setValue(null);
            }}
          >
            Clear
          </button>
        </>
      );
    }
    render(<Controlled />);
    await user.click(field());
    await user.keyboard('{End}{Backspace}');

    await user.click(screen.getByRole('button', { name: 'Set' }));
    expect(field()).toHaveValue('03/11/2026');
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(field()).toHaveValue('');
  });

  // Break caught: the field and the page disagreeing about a date nobody completed, with the person told nothing about why.
  it('says in words why a date that was left half typed is not one, and tells the page of none', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <>
        <Host onChange={onChange} />
        <button type="button">Elsewhere</button>
      </>,
    );

    await user.click(field());
    await user.keyboard('2810');
    expect(screen.queryByText(DAY_FIRST_MESSAGES.shape)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Elsewhere' }));

    expect(screen.getByText(DAY_FIRST_MESSAGES.shape)).toBeVisible();
    expect(field()).toHaveAttribute('aria-invalid', 'true');
    expect(field()).toHaveAccessibleDescription(new RegExp(DAY_FIRST_MESSAGES.shape.slice(0, 20)));
    expect(onChange).not.toHaveBeenCalled();
  });

  // Break caught: the mistake said as the person passes from the field to the calendar button (they are on their way to choose the day: the control is
  // not left), or never said because only the field was watched, so that a person who tabs on from the calendar button is never told. Found by the
  // browser run, where Tab from the field lands on the button.
  it('says a mistake when the person leaves the control from its calendar button, and not on the way to it', async () => {
    const user = userEvent.setup();
    render(
      <>
        <Host />
        <button type="button">Elsewhere</button>
      </>,
    );

    await user.click(field());
    await user.keyboard('2810');
    await user.tab();
    expect(calendarButton()).toHaveFocus();
    expect(screen.queryByText(DAY_FIRST_MESSAGES.shape)).toBeNull();

    await user.tab();

    expect(screen.getByRole('button', { name: 'Elsewhere' })).toHaveFocus();
    expect(screen.getByText(DAY_FIRST_MESSAGES.shape)).toBeVisible();
  });

  // Break caught: a year of two digits told while the person is still typing it (they are not finished), or never told: it is said when the person leaves, with the year's own words
  // (not the words for a date written in another form), and the field is marked invalid with them.
  it('says a year in fewer than four digits is not enough only when the person leaves, with its own words', async () => {
    const user = userEvent.setup();
    render(
      <>
        <Host />
        <button type="button">Elsewhere</button>
      </>,
    );

    await user.click(field());
    await user.keyboard('281026');
    expect(field()).toHaveValue('28/10/26');
    expect(screen.queryByText(DAY_FIRST_MESSAGES.year)).toBeNull();
    expect(field()).not.toHaveAttribute('aria-invalid');
    await user.click(screen.getByRole('button', { name: 'Elsewhere' }));

    expect(screen.getByText(DAY_FIRST_MESSAGES.year)).toBeVisible();
    expect(screen.queryByText(DAY_FIRST_MESSAGES.shape)).toBeNull();
    expect(field()).toHaveAttribute('aria-invalid', 'true');
    expect(field()).toHaveAccessibleDescription(new RegExp(DAY_FIRST_MESSAGES.year));
    expect(field()).toHaveValue('28/10/26');
  });

  // Break caught: the words for a day that its month does not have saying the wrong day or month, a month's name in the browser's language, a fault found only on leaving, or the
  // 29th of February refused in a leap year. The 29th of February of a year that is not a leap year names the year (the Product Owner's decision of 7 November 2026, afternoon).
  it.each([
    ['30022026', '30/02/2026', 'There is no 30 February'],
    ['31022026', '31/02/2026', 'There is no 31 February'],
    ['29022027', '29/02/2027', '2027 has no 29 February'],
    ['31042026', '31/04/2026', 'There is no 31 April'],
    ['31112026', '31/11/2026', 'There is no 31 November'],
  ])('refuses %s at once, and says %j', async (digits, written, message) => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Host onChange={onChange} />);

    await user.click(field());
    await user.keyboard(digits);

    expect(field()).toHaveValue(written);
    expect(screen.getByText(message)).toBeVisible();
    expect(field()).toHaveAttribute('aria-invalid', 'true');
    expect(onChange).not.toHaveBeenCalled();
  });

  // Break caught: the 29th of February refused where there is one.
  it('gives the 29th of February of a leap year', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Host onChange={onChange} />);

    await user.click(field());
    await user.keyboard('29022028');

    expect(onChange).toHaveBeenLastCalledWith('2028-02-29');
    expect(field()).not.toHaveAttribute('aria-invalid');
  });

  // Break caught: a refused date that the page still holds after the person has left, which would save a date the field does not show as valid, or one that disappears from the
  // field with its words (the person could not see what to put right); and the words left on the screen after the date is put right.
  it('keeps a refused date and its words when the person leaves it, tells the page none, and drops the words once the date is right', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <>
        <Host initial="2026-01-31" onChange={onChange} />
        <button type="button">Elsewhere</button>
      </>,
    );

    await selectPart(user, 'month');
    await user.keyboard('02');
    expect(field()).toHaveValue('31/02/2026');
    expect(screen.getByText('There is no 31 February')).toBeVisible();
    expect(onChange).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Elsewhere' }));
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(field()).toHaveValue('31/02/2026');
    expect(screen.getByText('There is no 31 February')).toBeVisible();

    await selectPart(user, 'month');
    await user.keyboard('01');
    expect(onChange).toHaveBeenLastCalledWith('2026-01-31');
    expect(field()).toHaveValue('31/01/2026');
    expect(screen.queryByText('There is no 31 February')).toBeNull();
    expect(field()).not.toHaveAttribute('aria-invalid');
  });

  // Break caught: a month that does not exist (the 28th) read as a month, or its mistake left unsaid until the person leaves, when the text is already as long as a date.
  it('says at once that a month that does not exist is not on the calendar, and gives nothing', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Host onChange={onChange} />);

    await user.click(field());
    await user.keyboard('10282026');

    expect(field()).toHaveValue('10/28/2026');
    expect(screen.getByText(DAY_FIRST_MESSAGES.calendar)).toBeVisible();
    expect(field()).toHaveAttribute('aria-invalid', 'true');
    expect(onChange).not.toHaveBeenCalled();
  });

  // Break caught: a date pasted in another order or with other separators read as a different day (2026-10-28 as 20/26/1028, 10/28/2026 as the 10th of the 28th).
  it.each([
    ['2026-10-28', DAY_FIRST_MESSAGES.shape],
    ['28.10.2026', DAY_FIRST_MESSAGES.shape],
    ['10/28/2026', DAY_FIRST_MESSAGES.calendar],
  ])('does not read %s, pasted, as a date: it says why', async (text, message) => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Host onChange={onChange} />);

    await user.click(field());
    await user.paste(text);

    expect(screen.getByText(message)).toBeVisible();
    expect(onChange).not.toHaveBeenCalled();
  });

  // Break caught: a date pasted as eight digits left without its slashes, or never given to the page.
  it('reads a date pasted as digits, and gives it', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Host onChange={onChange} />);

    await user.click(field());
    await user.paste('28102026');

    expect(field()).toHaveValue('28/10/2026');
    expect(onChange).toHaveBeenCalledExactlyOnceWith('2026-10-28');
  });

  // Break caught: the slashes the person types themselves left out or doubled.
  it('takes the slashes a person types, and pads a day or a month typed in one digit', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Host onChange={onChange} />);

    await user.click(field());
    await user.keyboard('3/11/2026');

    expect(field()).toHaveValue('03/11/2026');
    expect(onChange).toHaveBeenCalledExactlyOnceWith('2026-11-03');
  });

  // Break caught: a field that takes letters, or that grows beyond a date.
  it('takes digits and slashes only, and no more than a date', async () => {
    const user = userEvent.setup();
    render(<Host />);

    await user.click(field());
    await user.keyboard('ab28cd/10/2026999');

    expect(field()).toHaveValue('28/10/2026');
  });

  // Break caught: a day that cannot be typed again once it is cleared (the first digit padded into 02 as if a slash had been typed), or the other parts moved by the clearing.
  it('lets a cleared day be typed again, a digit at a time, with the month and the year where they were', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Host initial="2026-10-28" onChange={onChange} />);

    await clickPart(user, 'day');
    await user.keyboard('{Backspace}{Backspace}');
    expect(field()).toHaveValue('/10/2026');
    await user.keyboard('3');
    expect(field()).toHaveValue('3/10/2026');
    await user.keyboard('1');

    expect(field()).toHaveValue('31/10/2026');
    expect(onChange).toHaveBeenLastCalledWith('2026-10-31');
  });

  // Break caught: the arrow keys stepping the day whichever part the caret is in, or letting the caret jump to the end of the text after a step.
  it('steps the month and the year under the caret, and keeps the caret in the part', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Host initial="2026-10-28" onChange={onChange} />);

    await clickPart(user, 'month');
    await user.keyboard('{ArrowDown}');
    expect(field()).toHaveValue('28/09/2026');
    expect(onChange).toHaveBeenLastCalledWith('2026-09-28');
    expect(field().selectionStart).toBe(5);

    await clickPart(user, 'year');
    await user.keyboard('{ArrowUp}');
    expect(field()).toHaveValue('28/09/2027');
    expect(onChange).toHaveBeenLastCalledWith('2027-09-28');
    expect(field().selectionStart).toBe(10);
  });

  // Break caught: a day that steps past the end of its month into a date that does not exist.
  it('goes round within the month, and keeps the day within a shorter month', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Host initial="2026-10-31" onChange={onChange} />);

    await clickPart(user, 'day');
    await user.keyboard('{ArrowUp}');
    expect(onChange).toHaveBeenLastCalledWith('2026-10-01');

    await user.keyboard('{ArrowDown}');
    expect(onChange).toHaveBeenLastCalledWith('2026-10-31');
    await clickPart(user, 'month');
    await user.keyboard('{ArrowUp}');
    expect(onChange).toHaveBeenLastCalledWith('2026-11-30');
  });

  // Break caught: the arrow keys stepping a text that is not yet a date (the person is typing), or stepping a read-only date.
  it('does not step a text that is not yet a date, or a date that is read-only', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { unmount } = render(<Host onChange={onChange} />);

    await user.click(field());
    await user.keyboard('28/10');
    expect(field()).toHaveValue('28/10/');
    await user.keyboard('{ArrowUp}');
    expect(field()).toHaveValue('28/10/');
    expect(onChange).not.toHaveBeenCalled();
    unmount();

    render(<Host initial="2026-10-28" isReadOnly onChange={onChange} />);
    await clickPart(user, 'day');
    await user.keyboard('{ArrowUp}');
    expect(field()).toHaveValue('28/10/2026');
    expect(onChange).not.toHaveBeenCalled();
  });

  // Break caught: a read-only date that takes a keystroke, which would show a date the page does not hold.
  it('does not take typing into a read-only date', async () => {
    const user = userEvent.setup();
    render(<Host initial="2026-10-08" isReadOnly />);

    await user.tab();
    await user.keyboard('9');

    expect(field()).toHaveAttribute('readonly');
    expect(field()).toHaveValue('08/10/2026');
  });

  // Break caught: a name, a role or a relationship the automated checks can see is wrong with the words of a mistake showing under the control.
  it('has no automated WCAG violation with a mistake shown', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <>
        <Host />
        <button type="button">Elsewhere</button>
      </>,
    );

    await user.click(field());
    await user.keyboard('2810');
    await user.click(screen.getByRole('button', { name: 'Elsewhere' }));

    expect(screen.getByText(DAY_FIRST_MESSAGES.shape)).toBeVisible();
    expect(await wcagViolations(container)).toEqual([]);
  });
});
