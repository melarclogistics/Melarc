import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { Checkbox } from './Checkbox';

describe('Checkbox', () => {
  // Break caught: a control with no accessible name, or a label that is not part of the target.
  it('is a native checkbox named by its label, and clicking the label turns it on', async () => {
    const user = userEvent.setup();
    render(<Checkbox name="remember" label="Remember this browser" />);

    const box = screen.getByRole('checkbox', { name: 'Remember this browser' });
    expect(box).not.toBeChecked();
    await user.click(screen.getByText('Remember this browser'));
    expect(box).toBeChecked();
    await user.click(screen.getByText('Remember this browser'));
    expect(box).not.toBeChecked();
  });

  // Break caught: a control that cannot be reached or turned on from the keyboard.
  it('is reached with Tab and turned on and off with Space', async () => {
    const user = userEvent.setup();
    render(<Checkbox name="remember" label="Remember this browser" />);

    await user.tab();
    expect(screen.getByRole('checkbox')).toHaveFocus();
    await user.keyboard(' ');
    expect(screen.getByRole('checkbox')).toBeChecked();
    await user.keyboard(' ');
    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });

  // Break caught: help that is drawn and not announced with the control, or a caller's own description lost.
  it('links its help, and a description the caller gives, with aria-describedby', () => {
    render(
      <Checkbox
        name="remember"
        label="Remember this browser"
        help="You still enter your password."
        aria-describedby="elsewhere"
      />,
    );

    const box = screen.getByRole('checkbox');
    expect(box).toHaveAccessibleDescription('You still enter your password.');
    expect(box.getAttribute('aria-describedby')).toMatch(/^elsewhere .+-help$/);
  });

  it('has no description when it has no help', () => {
    render(<Checkbox name="remember" label="Remember this browser" />);

    expect(screen.getByRole('checkbox')).not.toHaveAttribute('aria-describedby');
  });

  // Break caught: a choice that starts on, which would make it a default the person never made.
  it('is off unless the caller says the choice was already the person’s', () => {
    const off = render(<Checkbox name="remember" label="Remember" />);
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    off.unmount();

    render(<Checkbox name="remember" label="Remember" defaultChecked />);
    expect(screen.getByRole('checkbox')).toBeChecked();
  });

  it('is submitted with a form only when it is on, and a disabled one cannot be turned on', async () => {
    const user = userEvent.setup();
    render(
      <form aria-label="demo">
        <Checkbox name="remember" label="Remember" />
        <Checkbox name="locked" label="Locked" disabled />
      </form>,
    );
    const form = screen.getByRole<HTMLFormElement>('form', { name: 'demo' });

    expect(new FormData(form).has('remember')).toBe(false);
    await user.click(screen.getByRole('checkbox', { name: 'Remember' }));
    await user.click(screen.getByRole('checkbox', { name: 'Locked' }));
    expect(new FormData(form).has('remember')).toBe(true);
    expect(new FormData(form).has('locked')).toBe(false);
  });
});
