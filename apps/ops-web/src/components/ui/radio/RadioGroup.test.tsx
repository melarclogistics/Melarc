import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RadioGroup, type RadioGroupProps } from './RadioGroup';

afterEach(() => {
  vi.restoreAllMocks();
});

const OPTIONS = [
  { value: 'one', label: 'Demo choice one', help: 'What choosing one does.' },
  { value: 'two', label: 'Demo choice two' },
  { value: 'three', label: 'Demo choice three' },
] as const;

/** A group whose value is held by a page, as a form holds it. */
function Held(props: Partial<RadioGroupProps> & { readonly initial?: string | null }) {
  const { initial = null, ...rest } = props;
  const [value, setValue] = useState<string | null>(initial);
  return (
    <>
      <button type="button">Before</button>
      <RadioGroup
        legend="Demo question"
        name="demo"
        options={OPTIONS}
        value={value}
        onChange={setValue}
        {...rest}
      />
      <p>Chosen: {value ?? 'nothing'}</p>
      <button type="button">After</button>
    </>
  );
}

describe('RadioGroup: what it is', () => {
  it('is a group named by its legend, each choice named by its label', () => {
    render(<Held />);

    const group = screen.getByRole('group', { name: 'Demo question' });
    expect(
      within(group)
        .getAllByRole('radio')
        .map((radio) => radio.getAttribute('value')),
    ).toEqual(['one', 'two', 'three']);
    expect(screen.getByRole('radio', { name: 'Demo choice one' })).toHaveAccessibleDescription(
      'What choosing one does.',
    );
  });

  // Break caught: a group that chooses for the person, so that a decision nobody made is sent.
  it('has nothing chosen until the person chooses', () => {
    render(<Held />);

    for (const radio of screen.getAllByRole('radio')) expect(radio).not.toBeChecked();
    expect(screen.getByText('Chosen: nothing')).toBeVisible();
  });

  it('shows the choice the page holds', () => {
    render(<Held initial="two" />);

    expect(screen.getByRole('radio', { name: 'Demo choice two' })).toBeChecked();
  });

  it('says it is required in its name, and on each choice', () => {
    render(<Held required />);

    expect(screen.getByRole('group', { name: 'Demo question (required)' })).toBeVisible();
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeRequired();
  });

  // Break caught: help or an error that a screen reader never reads with the choices, and an error told by colour alone.
  it('ties its help and its error to every choice, and marks each invalid', () => {
    render(<Held help="Demo help for the group." error="Choose one of the demo choices." />);

    for (const radio of screen.getAllByRole('radio')) {
      expect(radio).toHaveAttribute('aria-invalid', 'true');
      expect(radio).toHaveAccessibleDescription(
        expect.stringContaining('Choose one of the demo choices.'),
      );
      expect(radio).toHaveAccessibleDescription(
        expect.stringContaining('Demo help for the group.'),
      );
    }
    expect(screen.getByText('Choose one of the demo choices.')).toBeVisible();
  });

  it('takes every choice out of use when it is disabled, and one when that one is', () => {
    const { rerender } = render(
      <RadioGroup
        legend="Demo question"
        name="demo"
        options={[
          ...OPTIONS.slice(0, 2),
          { value: 'three', label: 'Demo choice three', disabled: true },
        ]}
        value={null}
        onChange={() => undefined}
      />,
    );
    expect(screen.getByRole('radio', { name: 'Demo choice three' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Demo choice one' })).toBeEnabled();

    rerender(
      <RadioGroup
        legend="Demo question"
        name="demo"
        options={OPTIONS}
        value={null}
        onChange={() => undefined}
        disabled
      />,
    );
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled();
  });

  // Break caught: two choices with one value, which a form could not tell apart.
  it('refuses two choices with the same value', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() =>
      render(
        <RadioGroup
          legend="Demo question"
          name="demo"
          options={[OPTIONS[0], { value: 'one', label: 'Another one' }]}
          value={null}
          onChange={() => undefined}
        />,
      ),
    ).toThrow(/same value|value "one"/);
  });
});

describe('RadioGroup: by keyboard', () => {
  it('is one stop for Tab, which enters at the first choice when none is chosen', async () => {
    const user = userEvent.setup();
    render(<Held />);

    await user.tab();
    expect(screen.getByRole('button', { name: 'Before' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('radio', { name: 'Demo choice one' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();
  });

  it('enters at the chosen choice', async () => {
    const user = userEvent.setup();
    render(<Held initial="three" />);

    await user.tab();
    await user.tab();
    expect(screen.getByRole('radio', { name: 'Demo choice three' })).toHaveFocus();
  });

  it('moves and chooses with the arrow keys, and chooses with Space', async () => {
    const user = userEvent.setup();
    render(<Held />);
    await user.tab();
    await user.tab();

    await user.keyboard(' ');
    expect(screen.getByRole('radio', { name: 'Demo choice one' })).toBeChecked();
    expect(screen.getByText('Chosen: one')).toBeVisible();

    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('radio', { name: 'Demo choice two' })).toHaveFocus();
    expect(screen.getByText('Chosen: two')).toBeVisible();

    await user.keyboard('{ArrowUp}');
    expect(screen.getByText('Chosen: one')).toBeVisible();
  });

  it('chooses with a click on the words', async () => {
    const user = userEvent.setup();
    render(<Held />);

    await user.click(screen.getByText('Demo choice three'));

    expect(screen.getByRole('radio', { name: 'Demo choice three' })).toBeChecked();
  });
});
