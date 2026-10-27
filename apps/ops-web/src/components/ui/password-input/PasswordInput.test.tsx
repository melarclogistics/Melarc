import { render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import { Field } from '../field/Field';
import { PasswordInput } from './PasswordInput';

function setup(props: Partial<ComponentProps<typeof PasswordInput>> = {}) {
  const user = userEvent.setup();
  const view = render(
    <form aria-label="Demo">
      <Field label="Password" required>
        <PasswordInput name="password" autoComplete="current-password" {...props} />
      </Field>
      <button type="submit">Submit</button>
    </form>,
  );
  const input = () => screen.getByLabelText<HTMLInputElement>('Password (required)');
  return { user, input, ...view };
}

describe('PasswordInput: what it is', () => {
  // Break caught: a password field that is a plain text box, which shows the password to anyone looking at the screen.
  it('is a password field by default, named by its label', () => {
    const { input } = setup();

    expect(input()).toHaveAttribute('type', 'password');
    expect(input()).toHaveAttribute('aria-required', 'true');
  });

  // Break caught: the browser and the password manager being unable to tell a sign-in from a new password. A sign-in
  // field says `current-password`, a field that sets one says `new-password`, and the component refuses to leave it out.
  it.each(['current-password', 'new-password'] as const)('tells the browser it is a %s', (kind) => {
    setup({ autoComplete: kind });

    expect(screen.getByLabelText('Password (required)')).toHaveAttribute('autocomplete', kind);
  });

  // Break caught: the browser "helping" with a password: capitalising it, correcting it, or sending it to a spell checker.
  it('turns off capitalisation, correction and spell checking', () => {
    const { input } = setup();

    expect(input()).toHaveAttribute('autocapitalize', 'off');
    expect(input()).toHaveAttribute('autocorrect', 'off');
    expect(input()).toHaveAttribute('spellcheck', 'false');
  });

  it('is described by its help and error like any field', () => {
    render(
      <Field label="Password" help="At least 12 characters." error="That password is too short.">
        <PasswordInput autoComplete="new-password" />
      </Field>,
    );

    expect(screen.getByLabelText('Password')).toHaveAccessibleDescription(
      'At least 12 characters. That password is too short.',
    );
    expect(screen.getByLabelText('Password')).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('PasswordInput: the value is the person’s, untouched', () => {
  // Break caught: a password trimmed, truncated, case-folded or otherwise changed in the browser. The credential rule
  // is the server's and counts what was typed (SLICE-000-FINAL-DECISIONS section 15: never trim, truncate or fold).
  it('keeps exactly what is typed, spaces and case included', async () => {
    const { user, input } = setup();

    await user.type(input(), '  Pa ss WORD  ');

    expect(input()).toHaveValue('  Pa ss WORD  ');
  });

  // Break caught: paste blocked, which pushes people to short, memorable passwords and breaks password managers.
  it('accepts a pasted value', async () => {
    const { user, input } = setup();
    await user.click(input());

    await user.paste('a long pasted passphrase');

    expect(input()).toHaveValue('a long pasted passphrase');
  });

  it('tells its change handler what was typed, as it was typed', async () => {
    const onChange = vi.fn();
    const { user, input } = setup({ onChange });

    await user.type(input(), 'Ab');

    expect(onChange).toHaveBeenCalledTimes(2);
    expect(input()).toHaveValue('Ab');
  });
});

describe('PasswordInput: showing the password', () => {
  // Break caught: no way to check what was typed (which makes people choose passwords they can type blind), or a toggle
  // that reveals the value without the person asking.
  it('is hidden until the person asks, then shown, then hidden again', async () => {
    const { user, input } = setup();
    await user.type(input(), 'secret value');

    await user.click(screen.getByRole('button', { name: 'Show password' }));
    expect(input()).toHaveAttribute('type', 'text');
    expect(input()).toHaveValue('secret value');

    await user.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(input()).toHaveAttribute('type', 'password');
    expect(input()).toHaveValue('secret value');
  });

  // Break caught: the toggle moving focus off itself, or only working with the mouse.
  it('works from the keyboard, keeps focus on the toggle and says what happened', async () => {
    const { user, input } = setup();
    await user.click(input());
    await user.tab();
    const toggle = screen.getByRole('button', { name: 'Show password' });
    expect(toggle).toHaveFocus();

    await user.keyboard('{Enter}');

    expect(screen.getByRole('button', { name: 'Hide password' })).toHaveFocus();
    expect(screen.getByRole('status')).toHaveTextContent('Password shown');
    await user.keyboard(' ');
    expect(screen.getByRole('button', { name: 'Show password' })).toHaveFocus();
    expect(screen.getByRole('status')).toHaveTextContent('Password hidden');
    expect(input()).toHaveAttribute('type', 'password');
  });

  // Break caught: the toggle submitting the form, which sends a half-typed password.
  it('does not submit the form', async () => {
    const onSubmit = vi.fn((event: Event) => {
      event.preventDefault();
    });
    const { user } = setup();
    screen.getByRole('form', { name: 'Demo' }).addEventListener('submit', onSubmit);

    await user.click(screen.getByRole('button', { name: 'Show password' }));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  // Break caught: a shown password staying on the screen after the form is sent, for the next person at the screen.
  it('is hidden again when the form is submitted', async () => {
    const { user, input } = setup();
    screen.getByRole('form', { name: 'Demo' }).addEventListener('submit', (event) => {
      event.preventDefault();
    });
    await user.type(input(), 'secret value');
    await user.click(screen.getByRole('button', { name: 'Show password' }));
    expect(input()).toHaveAttribute('type', 'text');

    await user.click(screen.getByRole('button', { name: 'Submit' }));

    expect(input()).toHaveAttribute('type', 'password');
    expect(screen.getByRole('button', { name: 'Show password' })).toBeVisible();
  });

  // Break caught: the toggle being skipped by Tab, or reached before the field it belongs to.
  it('comes straight after the field in the tab order', async () => {
    const { user, input } = setup();

    await user.tab();
    expect(input()).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Show password' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Submit' })).toHaveFocus();
  });

  it('can be left without a toggle', () => {
    setup({ revealable: false });

    expect(screen.queryByRole('button', { name: /password/i })).toBeNull();
  });
});

describe('PasswordInput: disabled and accessibility', () => {
  it('has a disabled toggle when the field is disabled', () => {
    setup({ disabled: true });

    expect(screen.getByLabelText('Password (required)')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Show password' })).toBeDisabled();
  });

  it('has no WCAG 2.1 A or AA violations that can be checked without a layout engine, in any state', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <>
        <Field label="Password" required help="At least 12 characters.">
          <PasswordInput autoComplete="new-password" />
        </Field>
        <Field label="Repeat password" error="The passwords differ.">
          <PasswordInput autoComplete="new-password" />
        </Field>
      </>,
    );
    expect(await wcagViolations(container)).toEqual([]);

    const [first] = screen.getAllByRole('button', { name: 'Show password' });
    if (first === undefined) throw new Error('No Show password button was rendered.');
    await user.click(first);

    expect(await wcagViolations(container)).toEqual([]);
  });
});
