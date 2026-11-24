import { ApiError } from '@melarc/api-client/browser';
import { screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Field } from '../../../components/ui/field/Field';
import { Input } from '../../../components/ui/input/Input';
import { OperationFailure } from '../../../platform/api/api-response';
import { renderWithProviders } from '../../../test-support/render-providers';
import { ActDialog } from './ManifestActDialogs';

describe('the dialog of an act, refused', () => {
  // Break caught: a refusal that the dialog marks on a field (what the server said was wrong) with the focus left where it was, so that a person at the keyboard or with a screen reader is not taken to what is
  // marked: the focus goes to the first marked field once the marks are on the screen, not before.
  it('gives the focus to the first field the refusal marked, once the mark is drawn', async () => {
    const { user } = renderWithProviders(
      <ActDialogOfOneField
        send={() =>
          Promise.reject(
            new OperationFailure(
              new ApiError({ kind: 'http', status: 400, code: 'VALIDATION_FAILED' }),
              [{ in: 'body', pointer: '/note', rule: 'phone_number' }],
            ),
          )
        }
      />,
      { signedIn: true },
    );
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Mark' }));
    const field = within(dialog).getByLabelText('Note');
    await waitFor(() => {
      expect(field).toHaveAttribute('aria-invalid', 'true');
    });
    expect(field).toHaveFocus();
  });
});

/** A dialog of one field that marks that field when the act is refused. */
function ActDialogOfOneField({ send }: { readonly send: () => Promise<string> }) {
  const [marked, setMarked] = useState(false);
  return (
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
      onRefused={() => {
        setMarked(true);
      }}
    >
      <Field label="Note" {...(marked ? { error: 'Leave the number out.' } : {})}>
        <Input name="note" />
      </Field>
    </ActDialog>
  );
}

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
