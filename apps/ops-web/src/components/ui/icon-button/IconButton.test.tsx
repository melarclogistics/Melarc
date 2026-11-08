import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import { IconButton } from './IconButton';

describe('IconButton', () => {
  // Break caught: an icon-only control with no name, which a screen reader announces as "button" and nothing else (DESIGN_SYSTEM section 24).
  it('is named by its label and says what it does to a pointer user too', () => {
    render(<IconButton type="button" icon="show-password" label="Show password" />);

    const button = screen.getByRole('button', { name: 'Show password' });
    expect(button).toHaveAttribute('title', 'Show password');
    expect(button.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  // Break caught: a button inside a form that submits it because no type was set.
  it('always says its type', () => {
    render(
      <>
        <IconButton type="button" icon="close" label="Close" />
        <IconButton type="submit" icon="sign-out" label="Send" />
      </>,
    );

    expect(screen.getByRole('button', { name: 'Close' })).toHaveAttribute('type', 'button');
    expect(screen.getByRole('button', { name: 'Send' })).toHaveAttribute('type', 'submit');
  });

  it('is bare unless told otherwise, and can be inverse for Ink', () => {
    render(
      <>
        <IconButton type="button" icon="menu" label="A" />
        <IconButton type="button" icon="menu" label="B" variant="inverse" />
      </>,
    );

    expect(screen.getByRole('button', { name: 'A' })).toHaveClass('ui-icon-button--bare');
    expect(screen.getByRole('button', { name: 'B' })).toHaveClass('ui-icon-button--inverse');
  });

  // Break caught: a control that works with the mouse and not the keyboard.
  it('is reached by Tab and activated by Enter and by Space', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<IconButton type="button" icon="menu" label="Open menu" onClick={onClick} />);

    await user.tab();
    expect(screen.getByRole('button', { name: 'Open menu' })).toHaveFocus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  // Break caught: a second press while the first is under way, which would sign out, or send, twice (as `Button`).
  it('keeps its name, stays focusable and ignores activation while an action is under way', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<IconButton type="button" icon="sign-out" label="Sign out" loading onClick={onClick} />);

    const button = screen.getByRole('button', { name: 'Sign out' });
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).not.toBeDisabled();
    await user.click(button);

    expect(onClick).not.toHaveBeenCalled();
  });

  it('passes state to assistive technology through the attributes it is given', () => {
    render(
      <IconButton
        type="button"
        icon="collapse-menu"
        label="Collapse menu"
        aria-expanded={true}
        aria-controls="menu"
      />,
    );

    const button = screen.getByRole('button', { name: 'Collapse menu' });
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(button).toHaveAttribute('aria-controls', 'menu');
  });

  it('gives its element to a caller that moves focus to it', () => {
    let element: HTMLButtonElement | null = null;
    render(
      <IconButton
        ref={(node) => {
          element = node;
        }}
        type="button"
        icon="menu"
        label="Open menu"
      />,
    );

    expect(element).toBe(screen.getByRole('button', { name: 'Open menu' }));
  });

  it('has no accessibility violations', async () => {
    const { container } = render(
      <IconButton type="button" icon="show-password" label="Show password" />,
    );

    expect(await wcagViolations(container)).toEqual([]);
  });
});
