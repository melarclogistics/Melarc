import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '../../../test-support/render-providers';
import { ActDialog } from './ManifestActDialogs';

describe('the dialog of an act', () => {
  // Break caught: a dialog drawn where a form holds it (the mark on the form of an order) whose submit was heard by that form, which then saved what was on it: the dialog's submit stays inside the dialog.
  it('keeps its submit to itself when a form holds it, by the button and by Enter', async () => {
    const outer = vi.fn((event: { preventDefault: () => void }) => {
      event.preventDefault();
    });
    const send = vi.fn(() => Promise.resolve('done'));
    const { user } = renderWithProviders(
      <form onSubmit={outer}>
        <ActDialog<{ note: string }, string>
          open
          title="Mark the parcel"
          consequence={<p>Others will see it.</p>}
          confirmLabel="Mark"
          operation="setParcelWaitingForVendor"
          retryable
          build={() => ({ note: 'x' })}
          send={send}
          onDone={() => undefined}
          onCancel={() => undefined}
          onReload={() => undefined}
        >
          <input name="note" aria-label="Note" />
        </ActDialog>
      </form>,
      { signedIn: true },
    );
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Mark' }));
    expect(send).toHaveBeenCalledTimes(1);
    await user.type(within(dialog).getByLabelText('Note'), '{Enter}');
    expect(outer).not.toHaveBeenCalled();
  });
});
