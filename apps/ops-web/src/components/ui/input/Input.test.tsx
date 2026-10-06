import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import { Field } from '../field/Field';
import { Input } from './Input';

describe('Input inside a Field: the label', () => {
  // Break caught: a control a screen reader user cannot name, or a label that does not focus its control.
  it('is named by the label, and clicking the label focuses it', async () => {
    const user = userEvent.setup();
    render(
      <Field label="Email address">
        <Input name="email" type="email" />
      </Field>,
    );

    const input = screen.getByRole('textbox', { name: 'Email address' });
    expect(input).toHaveAttribute('type', 'email');
    await user.click(screen.getByText('Email address'));
    expect(input).toHaveFocus();
  });

  // Break caught: a caller giving the input its own id, which would leave the label pointing at the Field's id and the
  // control with no name. Inside a Field, the Field owns the id.
  it('keeps the field id when the caller passes one, so the label still names the control', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <Field label="Email address" help="We only use it to sign you in.">
        <Input id="caller-chosen-id" />
      </Field>,
    );

    const input = screen.getByRole('textbox', { name: 'Email address' });
    expect(input.id).not.toBe('caller-chosen-id');
    expect(input).toHaveAccessibleDescription('We only use it to sign you in.');
    await user.click(screen.getByText('Email address'));
    expect(input).toHaveFocus();
    expect(await wcagViolations(container)).toEqual([]);
  });

  // Break caught: two fields on one page sharing an id, so the second label names the first control.
  it('gives each field its own id, so each label names its own control', () => {
    render(
      <>
        <Field label="First name">
          <Input />
        </Field>
        <Field label="Last name">
          <Input />
        </Field>
      </>,
    );

    const first = screen.getByRole('textbox', { name: 'First name' });
    const last = screen.getByRole('textbox', { name: 'Last name' });
    expect(first.id).not.toBe('');
    expect(first.id).not.toBe(last.id);
  });
});

describe('Input inside a Field: required, help and error', () => {
  // Break caught: a required field that says so only to people who can see an asterisk, or only in colour.
  it('says that it is required in the label and to assistive technology', () => {
    render(
      <Field label="Email address" required>
        <Input />
      </Field>,
    );

    const input = screen.getByRole('textbox', { name: 'Email address (required)' });
    expect(input).toHaveAttribute('aria-required', 'true');
    expect(screen.getByText('(required)')).toBeVisible();
  });

  it('is not marked required, and has no description, when nothing says so', () => {
    render(
      <Field label="Nickname">
        <Input />
      </Field>,
    );

    const input = screen.getByRole('textbox', { name: 'Nickname' });
    expect(input).not.toHaveAttribute('aria-required');
    expect(input).not.toHaveAttribute('aria-describedby');
    expect(input).not.toHaveAttribute('aria-invalid');
  });

  it('is described by its help text', () => {
    render(
      <Field label="Email address" help="We only use it to sign you in.">
        <Input />
      </Field>,
    );

    const input = screen.getByRole('textbox', { name: 'Email address' });
    expect(input).toHaveAccessibleDescription('We only use it to sign you in.');
    expect(input).not.toHaveAttribute('aria-invalid');
  });

  // Break caught: an error shown beside a field but not tied to it, or shown in red alone.
  it('is invalid and described by its error, which is visible text with an icon', () => {
    const { container } = render(
      <Field label="Email address" error="Enter an email address in the form name@example.com.">
        <Input />
      </Field>,
    );

    const input = screen.getByRole('textbox', { name: 'Email address' });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription(
      'Enter an email address in the form name@example.com.',
    );
    expect(screen.getByText('Enter an email address in the form name@example.com.')).toBeVisible();
    const icon = container.querySelector('.ui-field__error svg');
    expect(icon).not.toBeNull();
    expect(icon).toHaveAttribute('aria-hidden', 'true');
  });

  it('is described by its help first and its error second', () => {
    render(
      <Field label="Email address" help="Use your work address." error="That address is not valid.">
        <Input />
      </Field>,
    );

    expect(screen.getByRole('textbox', { name: 'Email address' })).toHaveAccessibleDescription(
      'Use your work address. That address is not valid.',
    );
  });

  // Break caught: the error being announced a second time by a live region on top of the description it already has
  // (DESIGN_SYSTEM section 14: each error is announced once).
  it('does not make the error a live region', () => {
    render(
      <Field label="Email address" error="That address is not valid.">
        <Input />
      </Field>,
    );

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('keeps a description the caller gave the input as well as the field own', () => {
    render(
      <>
        <p id="extra">Also see the policy.</p>
        <Field label="Email address" help="Use your work address.">
          <Input aria-describedby="extra" />
        </Field>
      </>,
    );

    expect(screen.getByRole('textbox', { name: 'Email address' })).toHaveAccessibleDescription(
      'Also see the policy. Use your work address.',
    );
  });
});

describe('Input: filled, disabled and read-only', () => {
  it('takes what is typed, and says so to its change handler', async () => {
    const user = userEvent.setup();
    render(
      <Field label="Email address">
        <Input defaultValue="" />
      </Field>,
    );

    const input = screen.getByRole('textbox', { name: 'Email address' });
    await user.type(input, 'ama@example.com');

    expect(input).toHaveValue('ama@example.com');
  });

  // Break caught: a disabled field that can still be reached and edited, or one that is not named.
  it('is disabled with the native attribute: not editable, skipped by Tab, still named', async () => {
    const user = userEvent.setup();
    render(
      <>
        <Field label="Region">
          <Input disabled defaultValue="Accra" />
        </Field>
        <button type="button">After</button>
      </>,
    );

    const input = screen.getByRole('textbox', { name: 'Region' });
    expect(input).toBeDisabled();
    await user.tab();
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();
  });

  // Break caught: a read-only value that looks and behaves like a disabled one (DESIGN_SYSTEM section 15): it must stay
  // reachable and readable, and its text must stay selectable and copyable, but it cannot be edited.
  it('is read-only without being disabled: reachable by Tab, not editable', async () => {
    const user = userEvent.setup();
    render(
      <Field label="Account number">
        <Input readOnly defaultValue="0042-17" />
      </Field>,
    );

    const input = screen.getByRole('textbox', { name: 'Account number' });
    expect(input).toHaveAttribute('readonly');
    expect(input).not.toBeDisabled();
    await user.tab();
    expect(input).toHaveFocus();
    await user.keyboard('x');
    expect(input).toHaveValue('0042-17');
  });
});

describe('Input on its own', () => {
  it('works without a Field when it is given a name', () => {
    render(<Input aria-label="Search" type="search" />);

    expect(screen.getByRole('searchbox', { name: 'Search' })).toBeVisible();
  });
});

describe('Input and Field: accessibility', () => {
  it('have no WCAG violations that can be checked without a layout engine, in any state', async () => {
    const { container } = render(
      <>
        <Field label="Default">
          <Input />
        </Field>
        <Field label="Required with help" required help="Some help.">
          <Input />
        </Field>
        <Field label="Invalid" error="This is wrong.">
          <Input />
        </Field>
        <Field label="Disabled">
          <Input disabled />
        </Field>
        <Field label="Read-only">
          <Input readOnly defaultValue="Fixed" />
        </Field>
      </>,
    );

    expect(await wcagViolations(container)).toEqual([]);
  });
});
