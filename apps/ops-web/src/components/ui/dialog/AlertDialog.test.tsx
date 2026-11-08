import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import { AlertDialog } from './AlertDialog';

function renderAlert(props: Partial<Parameters<typeof AlertDialog>[0]> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const view = render(
    <AlertDialog
      open
      title="End this demo session?"
      confirmLabel="End the demo session"
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...props}
    >
      <p>The demo person is signed out of every browser. This cannot be undone.</p>
    </AlertDialog>,
  );
  return { ...view, onConfirm, onCancel, user: userEvent.setup() };
}

describe('AlertDialog', () => {
  // Break caught: a confirmation that is not announced as one, or that has no name or no consequence for a screen reader to read.
  it('is an alert dialog, named by its title and described by the consequence', () => {
    renderAlert();

    const dialog = screen.getByRole('alertdialog', { name: 'End this demo session?' });
    expect(dialog).toHaveAccessibleDescription(/cannot be undone/);
  });

  // Break caught: focus landing on the destructive button, so that a keypress meant for something else confirms it.
  it('puts focus on the safe action, not on the one that does the harm', () => {
    renderAlert();

    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'End the demo session' })).not.toHaveFocus();
  });

  // Break caught: the safe action found first only because it happens to come first in the page. It is marked, so that the focus stays on it
  // when the order of the buttons is changed for a language or a layout.
  it('marks the safe action as the one to focus, and not the act', () => {
    renderAlert();

    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveAttribute('data-initial-focus');
    expect(screen.getByRole('button', { name: 'End the demo session' })).not.toHaveAttribute(
      'data-initial-focus',
    );
  });

  it('names the consequence in the confirming button, not "OK"', () => {
    renderAlert({ confirmLabel: 'Reset the second factor' });

    expect(screen.getByRole('button', { name: 'Reset the second factor' })).toBeVisible();
    expect(screen.queryByRole('button', { name: /^(ok|yes|confirm)$/i })).toBeNull();
  });

  it('lets the cancelling button say what it does', () => {
    renderAlert({ cancelLabel: 'Keep the session' });

    expect(screen.getByRole('button', { name: 'Keep the session' })).toHaveFocus();
  });

  it('confirms once, from the button or from the keyboard', async () => {
    const { user, onConfirm, onCancel } = renderAlert();

    await user.tab();
    expect(screen.getByRole('button', { name: 'End the demo session' })).toHaveFocus();
    await user.keyboard('{Enter}');

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('cancels from the button, and on Escape', async () => {
    const { user, onCancel, onConfirm } = renderAlert();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.keyboard('{Escape}');

    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  // Break caught: a stray click on the backdrop answering a question nobody was asked.
  it('is not answered by a click on the backdrop', async () => {
    const { user, onCancel, onConfirm } = renderAlert();

    await user.click(screen.getByRole('alertdialog'));

    expect(onCancel).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('is not in the page while it is closed', () => {
    renderAlert({ open: false });

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByText(/cannot be undone/)).toBeNull();
  });
});

describe('AlertDialog: while the act is under way', () => {
  // Break caught: an act that is under way being cancelled on the screen while it goes on in the server, or confirmed a second time.
  it('shows the confirming button busy, takes no second confirmation, and cannot be cancelled', async () => {
    const { user, onConfirm, onCancel } = renderAlert({ pending: true });

    const confirm = screen.getByRole('button', { name: 'End the demo session' });
    expect(confirm).toHaveAttribute('aria-busy', 'true');
    await user.click(confirm);
    await user.keyboard('{Escape}');

    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByRole('alertdialog')).toBeVisible();
  });

  // Break caught: the browser closing a dialog that holds an act that is under way, which hides what the person must see.
  it('opens again if the browser closes it while the act is under way', async () => {
    renderAlert({ pending: true });

    screen.getByRole<HTMLDialogElement>('alertdialog').close();

    await waitFor(() => {
      expect(screen.getByRole<HTMLDialogElement>('alertdialog').open).toBe(true);
    });
  });

  it('answers to Escape again when the act is over', async () => {
    const onCancel = vi.fn();
    const { rerender, user } = renderAlert({ pending: true, onCancel });
    await user.keyboard('{Escape}');
    expect(onCancel).not.toHaveBeenCalled();

    rerender(
      <AlertDialog
        open
        title="End this demo session?"
        confirmLabel="End the demo session"
        onConfirm={vi.fn()}
        onCancel={onCancel}
      >
        <p>The demo person is signed out of every browser. This cannot be undone.</p>
      </AlertDialog>,
    );
    await user.keyboard('{Escape}');

    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('AlertDialog: accessibility', () => {
  it('has no WCAG 2.1 A or AA violations that can be checked without a layout engine', async () => {
    const { container } = renderAlert();

    expect(await wcagViolations(container)).toEqual([]);
  });

  it('has none while the act is under way', async () => {
    const { container } = renderAlert({ pending: true });

    expect(await wcagViolations(container)).toEqual([]);
  });
});
