import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import { Field } from '../field/Field';
import { DatePicker, type DatePickerProps } from './DatePicker';

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

const parts = (): string[] => screen.getAllByRole('spinbutton').map((part) => part.textContent);
/** One part of the date, by what it is called: its name begins with day, month or year. */
const part = (kind: 'day' | 'month' | 'year'): HTMLElement =>
  screen.getByRole('spinbutton', { name: new RegExp(`^${kind}`) });
const calendarButton = (): HTMLElement => screen.getByRole('button', { name: /^Calendar/ });
const day = (label: RegExp | string): HTMLElement => screen.getByRole('button', { name: label });

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
    expect(
      screen.getAllByRole('spinbutton').map((part) => part.getAttribute('aria-valuenow')),
    ).toEqual(['8', '10', '2026']);
    expect(navigator.language).toBe('en-US');
  });

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
    for (const part of screen.getAllByRole('spinbutton')) {
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
    for (const part of screen.getAllByRole('spinbutton')) {
      expect(part).toHaveAttribute('aria-invalid', 'true');
      expect(part).toHaveAttribute('aria-required', 'true');
    }
    expect(container.querySelector('.ui-date-picker')).toHaveClass('ui-date-picker--invalid');
    expect(screen.getByText('Choose a day we collect on.')).toBeInTheDocument();
  });

  it('is not invalid or required of its own accord', () => {
    render(
      <Field label="Service date">
        <DatePicker value={null} onChange={() => undefined} />
      </Field>,
    );

    for (const part of screen.getAllByRole('spinbutton')) {
      expect(part).not.toHaveAttribute('aria-invalid');
      expect(part).not.toHaveAttribute('aria-required');
    }
  });

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
      within(screen.getByRole('group', { name: 'From' })).getAllByRole('spinbutton'),
    ).toHaveLength(3);
    expect(
      within(screen.getByRole('group', { name: 'To' })).getAllByRole('spinbutton')[0]?.textContent,
    ).toBe('31');
  });
});

describe('DatePicker: typing a date', () => {
  // Break caught: a date given in another shape from the one the page and the API use, or before it is whole.
  it('gives the date once all of it is typed, as YYYY-MM-DD, and not before', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Host onChange={onChange} />);

    await user.click(part('day'));
    await user.keyboard('2810');
    expect(onChange).not.toHaveBeenCalled();

    await user.keyboard('2026');
    expect(onChange).toHaveBeenLastCalledWith('2026-10-28');
    expect(parts()).toEqual(['28', '10', '2026']);
  });

  // Break caught: a date with a part cleared still held by the page, which would save a date the person can see is not there. Taking a
  // digit off 28 gives the page 2 on the way (the library tells it eagerly), and clearing the day leaves the page holding that 2: the control
  // and the page disagree until the person leaves, when they are made to agree.
  it('gives none when the person leaves a date they have cleared a part of', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <>
        <Host initial="2026-10-28" onChange={onChange} />
        <button type="button">Elsewhere</button>
      </>,
    );

    await user.click(part('day'));
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

    await user.click(part('day'));
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

    await user.click(part('day'));
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

    await user.click(part('day'));
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

    await user.click(part('day'));
    await user.keyboard('2810');
    await user.click(screen.getByRole('button', { name: 'Elsewhere' }));

    expect(parts()).toEqual(['28', '10', 'yyyy']);
    expect(onChange).not.toHaveBeenCalled();
  });

  // Break caught: a year typed in two digits (26 for 2026) drawn as something else from what the page holds. The control shows the year it
  // gave, 26, so the person sees the mistake and the page's own check (`minValue`, the server) refuses it; nothing guesses a century.
  it('shows and gives a year typed in two digits as that year, and the date again once the year is whole', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <>
        <Host onChange={onChange} />
        <button type="button">Elsewhere</button>
      </>,
    );

    await user.click(part('day'));
    await user.keyboard('281026');
    await user.click(screen.getByRole('button', { name: 'Elsewhere' }));

    expect(parts()).toEqual(['28', '10', '26']);
    expect(onChange).toHaveBeenLastCalledWith('0026-10-28');

    await user.click(part('year'));
    await user.keyboard('2026');
    expect(onChange).toHaveBeenLastCalledWith('2026-10-28');
    expect(parts()).toEqual(['28', '10', '2026']);
  });

  // Break caught: a date that does not exist (30 February) given as it was typed, or left on the screen while the page holds something else.
  it('corrects a date that does not exist to the nearest real one when the person leaves, and gives that', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <>
        <Host onChange={onChange} />
        <button type="button">Elsewhere</button>
      </>,
    );

    await user.click(part('day'));
    await user.keyboard('30022026');
    expect(onChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Elsewhere' }));

    expect(parts()).toEqual(['28', '02', '2026']);
    expect(onChange).toHaveBeenLastCalledWith('2026-02-28');
  });

  it('steps a part with the arrow keys', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Host initial="2026-10-28" onChange={onChange} />);

    await user.click(part('day'));
    await user.keyboard('{ArrowUp}');

    expect(onChange).toHaveBeenLastCalledWith('2026-10-29');
  });

  // Break caught: a part a keyboard user can reach by Tab only after the one before it, in the wrong order, or not at all.
  it('is walked by Tab: day, month, year, then the calendar button', async () => {
    const user = userEvent.setup();
    render(<Host initial="2026-10-28" />);

    await user.tab();
    expect(screen.getAllByRole('spinbutton')[0]).toHaveFocus();
    await user.tab();
    expect(screen.getAllByRole('spinbutton')[1]).toHaveFocus();
    await user.tab();
    expect(screen.getAllByRole('spinbutton')[2]).toHaveFocus();
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
    expect(within(dialog).getByRole('application', { name: 'October 2026' })).toBeInTheDocument();
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
    expect(within(dialog).getByRole('application', { name: 'October 2026' })).toBeInTheDocument();
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

  it('turns the months with its two buttons', async () => {
    const user = userEvent.setup();
    render(<Host initial="2026-10-28" />);

    // The calendar also keeps a pair of buttons for screen readers out of sight; the two a person sees are the ones the portal draws.
    const drawn = (name: string): HTMLElement => {
      const found = screen
        .getAllByRole('button', { name })
        .find((button) => button.classList.contains('ui-date-picker__button'));
      if (found === undefined) throw new Error(`No drawn ${name} button`);
      return found;
    };

    await user.click(calendarButton());
    await user.click(drawn('Next'));
    expect(screen.getByRole('application', { name: 'November 2026' })).toBeInTheDocument();
    await user.click(drawn('Previous'));
    await user.click(drawn('Previous'));
    expect(screen.getByRole('application', { name: 'September 2026' })).toBeInTheDocument();
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

    await user.click(part('day'));
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

    await user.click(part('day'));
    await user.keyboard('{ArrowUp}'.repeat(12));

    expect(parts()).toEqual(['24', '10', '2026']);
    for (const each of screen.getAllByRole('spinbutton')) {
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

    // The library describes the group and its first part (a screen reader reads it once, on arriving), not each of the three.
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
    expect(screen.getAllByRole('spinbutton')[0]).toHaveFocus();
    expect(container.querySelector('.ui-date-picker')).toHaveClass('ui-date-picker--readonly');
    expect(container.querySelector('.ui-date-picker')).not.toHaveClass('ui-date-picker--disabled');
  });

  it('gives a disabled date no focus, no editing and no calendar', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container } = render(<Host initial="2026-10-08" isDisabled onChange={onChange} />);

    expect(calendarButton()).toBeDisabled();
    for (const part of screen.getAllByRole('spinbutton')) {
      expect(part).toHaveAttribute('aria-disabled', 'true');
    }
    await user.click(part('day'));
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
