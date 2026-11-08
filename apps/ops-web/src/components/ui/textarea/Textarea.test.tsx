import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import { Field } from '../field/Field';
import { Textarea } from './Textarea';

describe('Textarea inside a Field', () => {
  // Break caught: a control a screen reader user cannot name, or a label that does not focus its control.
  it('is named by the label, and clicking the label focuses it', async () => {
    const user = userEvent.setup();
    render(
      <Field label="How you verified the rider">
        <Textarea name="note" />
      </Field>,
    );

    const area = screen.getByRole('textbox', { name: 'How you verified the rider' });
    expect(area.tagName).toBe('TEXTAREA');
    await user.click(screen.getByText('How you verified the rider'));
    expect(area).toHaveFocus();
  });

  // Break caught: a caller giving the control its own id, which would leave the label pointing at the Field's id.
  it('keeps the field id when the caller passes one, so the label still names the control', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <Field label="Note" help="One line.">
        <Textarea id="caller-chosen-id" />
      </Field>,
    );

    const area = screen.getByRole('textbox', { name: 'Note' });
    expect(area.id).not.toBe('caller-chosen-id');
    expect(area).toHaveAccessibleDescription('One line.');
    await user.click(screen.getByText('Note'));
    expect(area).toHaveFocus();
    expect(await wcagViolations(container)).toEqual([]);
  });

  it('says that it is required in the label and to assistive technology', () => {
    render(
      <Field label="Note" required>
        <Textarea />
      </Field>,
    );

    const area = screen.getByRole('textbox', { name: 'Note (required)' });
    expect(area).toHaveAttribute('aria-required', 'true');
  });

  // Break caught: an error shown beside a field but not tied to it, or shown in red alone.
  it('is invalid and described by its error, which is visible text with an icon', () => {
    const { container } = render(
      <Field label="Note" help="One line." error="Say how you verified the rider.">
        <Textarea />
      </Field>,
    );

    const area = screen.getByRole('textbox', { name: 'Note' });
    expect(area).toHaveAttribute('aria-invalid', 'true');
    expect(area).toHaveAccessibleDescription('One line. Say how you verified the rider.');
    expect(container.querySelector('.ui-field__error svg')).not.toBeNull();
  });

  it('is not marked required, invalid or described when nothing says so', () => {
    render(
      <Field label="Note">
        <Textarea />
      </Field>,
    );

    const area = screen.getByRole('textbox', { name: 'Note' });
    expect(area).not.toHaveAttribute('aria-required');
    expect(area).not.toHaveAttribute('aria-describedby');
    expect(area).not.toHaveAttribute('aria-invalid');
  });
});

describe('Textarea: what it holds', () => {
  // Break caught: a control that cannot take more than a line, or that loses what was typed.
  it('takes what is typed, over several lines, and keeps it', async () => {
    const user = userEvent.setup();
    render(
      <Field label="Note">
        <Textarea defaultValue="" />
      </Field>,
    );

    const area = screen.getByRole('textbox', { name: 'Note' });
    await user.type(area, 'first line{Enter}second line');

    expect(area).toHaveValue('first line\nsecond line');
  });

  it('starts at three rows, and the caller may ask for another number', () => {
    render(
      <>
        <Field label="Default">
          <Textarea />
        </Field>
        <Field label="Taller">
          <Textarea rows={6} />
        </Field>
      </>,
    );

    expect(screen.getByRole('textbox', { name: 'Default' })).toHaveAttribute('rows', '3');
    expect(screen.getByRole('textbox', { name: 'Taller' })).toHaveAttribute('rows', '6');
  });

  // Break caught: a disabled field that can still be reached and edited.
  it('is disabled with the native attribute: not editable, skipped by Tab, still named', async () => {
    const user = userEvent.setup();
    render(
      <>
        <Field label="Locked">
          <Textarea disabled defaultValue="Fixed" />
        </Field>
        <button type="button">After</button>
      </>,
    );

    expect(screen.getByRole('textbox', { name: 'Locked' })).toBeDisabled();
    await user.tab();
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();
  });

  // Break caught (DESIGN_SYSTEM section 15): a read-only value that looks and behaves like a disabled one: it must stay reachable and readable.
  it('is read-only without being disabled: reachable by Tab, not editable', async () => {
    const user = userEvent.setup();
    render(
      <Field label="Record">
        <Textarea readOnly defaultValue="As verified" />
      </Field>,
    );

    const area = screen.getByRole('textbox', { name: 'Record' });
    expect(area).not.toBeDisabled();
    await user.tab();
    expect(area).toHaveFocus();
    await user.keyboard('x');
    expect(area).toHaveValue('As verified');
  });
});

describe('Textarea on its own', () => {
  it('works without a Field when it is given a name', () => {
    render(<Textarea aria-label="Comment" />);

    expect(screen.getByRole('textbox', { name: 'Comment' })).toBeVisible();
  });

  it('has no WCAG violations that can be checked without a layout engine, in any state', async () => {
    const { container } = render(
      <>
        <Field label="Default">
          <Textarea />
        </Field>
        <Field label="Required with help" required help="Some help.">
          <Textarea />
        </Field>
        <Field label="Invalid" error="This is wrong.">
          <Textarea />
        </Field>
        <Field label="Disabled">
          <Textarea disabled />
        </Field>
        <Field label="Read-only">
          <Textarea readOnly defaultValue="Fixed" />
        </Field>
      </>,
    );

    expect(await wcagViolations(container)).toEqual([]);
  });
});
