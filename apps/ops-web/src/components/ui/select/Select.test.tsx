import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import { Field } from '../field/Field';
import { Select, type SelectProps } from './Select';

const options = (
  <>
    <option value="">Choose one</option>
    <option value="a">Demo option A</option>
    <option value="b">Demo option B</option>
  </>
);

describe('Select inside a Field', () => {
  // Break caught: a control a screen reader user cannot name, or a label that does not focus its control.
  it('is named by the label, and clicking the label focuses it', async () => {
    const user = userEvent.setup();
    render(
      <Field label="Demo choice">
        <Select name="choice">{options}</Select>
      </Field>,
    );

    const select = screen.getByRole('combobox', { name: 'Demo choice' });
    await user.click(screen.getByText('Demo choice'));

    expect(select).toHaveFocus();
  });

  // Break caught: a caller's id orphaning the label, as for an Input.
  it('keeps the field id when the caller passes one', () => {
    render(
      <Field label="Demo choice">
        <Select id="caller-chosen-id">{options}</Select>
      </Field>,
    );

    expect(screen.getByRole('combobox', { name: 'Demo choice' }).id).not.toBe('caller-chosen-id');
  });

  it('says that it is required, in the label and to assistive technology', () => {
    render(
      <Field label="Demo choice" required>
        <Select>{options}</Select>
      </Field>,
    );

    const select = screen.getByRole('combobox', { name: 'Demo choice (required)' });
    expect(select).toHaveAttribute('aria-required', 'true');
  });

  // Break caught: an error beside a field and not tied to it, or shown in red alone.
  it('is invalid and described by its help and its error', () => {
    render(
      <Field label="Demo choice" help="Pick the nearest." error="Choose one.">
        <Select>{options}</Select>
      </Field>,
    );

    const select = screen.getByRole('combobox', { name: 'Demo choice' });
    expect(select).toHaveAttribute('aria-invalid', 'true');
    expect(select).toHaveAccessibleDescription('Pick the nearest. Choose one.');
  });

  it('keeps a description the caller gave as well as the field’s own', () => {
    render(
      <>
        <p id="extra">Also see the policy.</p>
        <Field label="Demo choice" help="Pick the nearest.">
          <Select aria-describedby="extra">{options}</Select>
        </Field>
      </>,
    );

    expect(screen.getByRole('combobox', { name: 'Demo choice' })).toHaveAccessibleDescription(
      'Also see the policy. Pick the nearest.',
    );
  });
});

describe('Select: choosing', () => {
  it('lists its options, and says which one was chosen to the change handler', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Field label="Demo choice">
        <Select
          defaultValue=""
          onChange={(event) => {
            onChange(event.target.value);
          }}
        >
          {options}
        </Select>
      </Field>,
    );

    const select = screen.getByRole('combobox', { name: 'Demo choice' });
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Choose one',
      'Demo option A',
      'Demo option B',
    ]);
    await user.selectOptions(select, 'b');

    expect(onChange).toHaveBeenCalledExactlyOnceWith('b');
    expect(select).toHaveValue('b');
  });

  // Break caught: a select that a keyboard cannot reach. It is the native control, so its keys (the arrows, type-ahead) are the browser's and
  // are proved in a real browser (components.spec.ts); a jsdom test can show that Tab arrives at it.
  it('is reached with the keyboard', async () => {
    const user = userEvent.setup();
    render(
      <Field label="Demo choice">
        <Select defaultValue="">{options}</Select>
      </Field>,
    );

    await user.tab();

    expect(screen.getByRole('combobox', { name: 'Demo choice' })).toHaveFocus();
  });

  // Break caught: a disabled select that can still be reached or changed.
  it('is disabled with the native attribute: skipped by Tab, still named', async () => {
    const user = userEvent.setup();
    render(
      <>
        <Field label="Demo choice">
          <Select disabled defaultValue="a">
            {options}
          </Select>
        </Field>
        <button type="button">After</button>
      </>,
    );

    expect(screen.getByRole('combobox', { name: 'Demo choice' })).toBeDisabled();
    await user.tab();

    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();
  });

  it('is not a multiple choice: a list that takes several is another control', () => {
    // @ts-expect-error the `multiple` attribute is not part of this control
    const props: SelectProps = { 'aria-label': 'Demo choice', multiple: true };

    expect(Object.keys(props)).toContain('multiple');
  });
});

describe('Select on its own', () => {
  it('works without a Field when it is given a name', () => {
    render(<Select aria-label="Demo choice">{options}</Select>);

    expect(screen.getByRole('combobox', { name: 'Demo choice' })).toBeVisible();
  });

  it('has no WCAG 2.1 A or AA violations that can be checked without a layout engine, in any state', async () => {
    const { container } = render(
      <>
        <Field label="Default">
          <Select>{options}</Select>
        </Field>
        <Field label="Required with help" required help="Some help.">
          <Select>{options}</Select>
        </Field>
        <Field label="Invalid" error="This is wrong.">
          <Select>{options}</Select>
        </Field>
        <Field label="Disabled">
          <Select disabled>{options}</Select>
        </Field>
      </>,
    );

    expect(await wcagViolations(container)).toEqual([]);
  });
});
