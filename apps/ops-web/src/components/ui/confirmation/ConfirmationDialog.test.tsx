import { ApiError } from '@melarc/api-client/browser';
import { act, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OperationFailure } from '../../../platform/api/api-response';
import { installFakeApi, type FakeApi } from '../../../test-support/fake-api';
import {
  describeInterfaceStates,
  OFFLINE_NOT_APPLICABLE,
} from '../../../test-support/interface-states';
import { renderWithProviders } from '../../../test-support/render-providers';
import { wcagViolations } from '../../../test-support/wcag';
import { ConfirmationDialog } from './ConfirmationDialog';

let api: FakeApi;

beforeEach(() => {
  api = installFakeApi();
});

afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
});

const DIAGNOSTIC = /Diagnostic text that must never reach a screen/;

type Props = ComponentProps<typeof ConfirmationDialog<string>>;

function setup({ open: startOpen = true, ...overrides }: Partial<Props> = {}) {
  const send = vi.fn<(command: unknown, key: string) => Promise<string>>(() =>
    Promise.resolve('done'),
  );
  const onDone = vi.fn();
  const onCancel = vi.fn();
  const onReload = vi.fn();
  const dialog = (open: boolean) => (
    <ConfirmationDialog<string>
      open={open}
      title="Approve this demo profile?"
      consequence={<p>The demo person can then set a password and sign in.</p>}
      confirmLabel="Approve profile"
      version={'"v1"'}
      send={send}
      onDone={onDone}
      onCancel={onCancel}
      onReload={onReload}
      {...overrides}
    />
  );
  const view = renderWithProviders(dialog(startOpen), { signedIn: true });
  return {
    ...view,
    send,
    onDone,
    onCancel,
    onReload,
    setOpen: (open: boolean) => {
      view.rerenderUi(dialog(open));
    },
  };
}

const confirm = () => screen.getByRole('button', { name: 'Approve profile' });

const lost = () => Promise.reject(new TypeError('Failed to fetch'));
const refusal = (status: number, code: string) =>
  Promise.reject(
    new OperationFailure(new ApiError({ kind: 'http', status, code, requestId: 'req-t1' }), []),
  );

describe('ConfirmationDialog: the confirmation', () => {
  // Break caught: a confirmation that is not announced as one, has no name or leaves the consequence unsaid.
  it('is an alert dialog named by its title and described by the consequence', () => {
    setup();

    const dialog = screen.getByRole('alertdialog', { name: 'Approve this demo profile?' });
    expect(dialog).toHaveAccessibleDescription(/can then set a password/);
  });

  // Break caught: focus on the act, so that a keypress meant for something else does it.
  it('puts focus on Cancel, not on the act', () => {
    setup();

    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('cancels from the button and on Escape', async () => {
    const { user, onCancel } = setup();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.keyboard('{Escape}');

    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it('is not in the page while it is closed, and draws it again clean', () => {
    const view = setup({ open: false });
    expect(screen.queryByRole('alertdialog')).toBeNull();

    view.setOpen(true);

    expect(screen.getByRole('alertdialog')).toBeVisible();
  });

  // Break caught: an act that does no harm drawn as if it did, or one that does harm drawn gently.
  it('confirms in the primary treatment unless the act is told to be a harmful one', () => {
    setup();
    expect(confirm()).toHaveClass('ui-button--primary');
  });

  it('confirms in the danger treatment when asked', () => {
    setup({ confirmVariant: 'danger' });
    expect(confirm()).toHaveClass('ui-button--danger');
  });
});

describe('ConfirmationDialog: the command', () => {
  // Break caught: the act sent without the version the person saw, which would be a silent overwrite of a record that moved.
  it('sends the version the person saw and a key', async () => {
    const view = setup();

    await view.user.click(confirm());

    await waitFor(() => {
      expect(view.onDone).toHaveBeenCalledExactlyOnceWith('done');
    });
    expect(view.send.mock.calls[0]?.[0]).toEqual({ version: '"v1"' });
    expect(view.send.mock.calls[0]?.[1]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('sends no version for an act that has none', async () => {
    const view = setup({ version: undefined });

    await view.user.click(confirm());

    await waitFor(() => {
      expect(view.send).toHaveBeenCalledTimes(1);
    });
    expect(view.send.mock.calls[0]?.[0]).toEqual({});
  });

  // Break caught: a form that can be confirmed twice, or cancelled while its command is on its way.
  it('shows the act busy, takes no second confirmation and cannot be cancelled while it is under way', async () => {
    let finish: (value: string) => void = () => undefined;
    const send = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const view = setup({ send });

    await view.user.click(confirm());

    await waitFor(() => {
      expect(confirm()).toHaveAttribute('aria-busy', 'true');
    });
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await view.user.click(confirm());
    await view.user.keyboard('{Escape}');
    expect(send).toHaveBeenCalledTimes(1);
    expect(view.onCancel).not.toHaveBeenCalled();

    await act(async () => {
      finish('done');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(view.onDone).toHaveBeenCalledTimes(1);
    });
  });
});

describe('ConfirmationDialog: a refusal', () => {
  // Break caught: the server's diagnostic text on the screen, or a refusal that closes the dialog.
  it('keeps the dialog, says what was refused in approved words and lets the act be sent again as a new command', async () => {
    const send = vi
      .fn<(command: unknown, key: string) => Promise<string>>()
      .mockImplementationOnce(() => refusal(403, 'SELF_APPROVAL_FORBIDDEN'))
      .mockResolvedValueOnce('done');
    const view = setup({ send });

    await view.user.click(confirm());

    expect(await screen.findByRole('alert')).toHaveTextContent('A different approver is required.');
    expect(screen.getByText(/req-t1/)).toBeVisible();
    expect(document.body.textContent).not.toMatch(DIAGNOSTIC);
    expect(screen.getByRole('alertdialog')).toBeVisible();

    await view.user.click(confirm());
    await waitFor(() => {
      expect(send).toHaveBeenCalledTimes(2);
    });
    expect(send.mock.calls[1]?.[1]).not.toBe(send.mock.calls[0]?.[1]);
  });

  it('says in words that a record changed and offers to reload it instead of the act', async () => {
    const send = vi.fn(() => refusal(409, 'STATE_CONFLICT'));
    const view = setup({ send });

    await view.user.click(confirm());

    expect(await screen.findByText(/This record changed after you opened it/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Approve profile' })).toBeNull();
    await view.user.click(screen.getByRole('button', { name: 'Reload the record' }));
    expect(view.onReload).toHaveBeenCalledTimes(1);
  });

  // Break caught: the operation's own wording not used.
  it('words a refusal for the operation it was sent for', async () => {
    const view = setup({
      operation: 'approveStaffIdentity',
      send: () => refusal(403, 'INSUFFICIENT_AUTHORITY'),
    });

    await view.user.click(confirm());

    expect(await screen.findByRole('alert')).toHaveTextContent(/higher authority/i);
  });
});

describe('ConfirmationDialog: an outcome nobody knows', () => {
  // Break caught: the heart of the workflow. The answer was lost, so the act may have been done: the dialog stays and says so.
  it('stays open, says the outcome is not known and offers to check the record', async () => {
    const view = setup({ send: lost });

    await view.user.click(confirm());

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /could not confirm whether this was done/i,
    );
    expect(screen.getByRole('alertdialog')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Check the record' })).toBeVisible();
    expect(view.onDone).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('Failed to fetch');
  });

  it('offers no retry for an act that cannot be sent again, and ignores Escape', async () => {
    const view = setup({ send: lost });
    await view.user.click(confirm());
    await screen.findByRole('button', { name: 'Check the record' });

    await view.user.keyboard('{Escape}');

    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(view.onCancel).not.toHaveBeenCalled();
  });

  it('moves focus to the way out and reads the record again when asked', async () => {
    const view = setup({ send: lost });
    await view.user.click(confirm());
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Check the record' })).toHaveFocus();
    });

    await view.user.click(screen.getByRole('button', { name: 'Check the record' }));

    expect(view.onReload).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(confirm()).toBeEnabled();
    });
  });

  // Break caught: the retry of a lost command that is not the same command with the same key.
  it('retries with the same command and the same key when the act can be sent again', async () => {
    const send = vi
      .fn<(command: unknown, key: string) => Promise<string>>()
      .mockImplementationOnce(lost)
      .mockResolvedValueOnce('replayed');
    const view = setup({ send, retryable: true });
    await view.user.click(confirm());

    await view.user.click(await screen.findByRole('button', { name: 'Try again' }));

    await waitFor(() => {
      expect(view.onDone).toHaveBeenCalledExactlyOnceWith('replayed');
    });
    expect(send.mock.calls[1]?.[0]).toEqual(send.mock.calls[0]?.[0]);
    expect(send.mock.calls[1]?.[1]).toBe(send.mock.calls[0]?.[1]);
  });
});

describe('ConfirmationDialog: the session', () => {
  // Break caught: a late answer for a person who has gone being shown to the next, or an act reported as done for them.
  it('shows nothing and reports nothing when the session changed while the act was under way', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const send = vi.fn(async () => {
      await held;
      return 'done';
    });
    const view = setup({ send });
    await view.user.click(confirm());
    await waitFor(() => {
      expect(send).toHaveBeenCalledTimes(1);
    });

    act(() => {
      view.store.end();
    });
    await act(async () => {
      release();
      await held;
    });

    expect(view.onDone).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describeInterfaceStates('ConfirmationDialog', {
  loading: {
    test: async () => {
      let finish: (value: string) => void = () => undefined;
      const view = setup({
        send: () =>
          new Promise<string>((resolve) => {
            finish = resolve;
          }),
      });

      await view.user.click(confirm());

      await waitFor(() => {
        expect(confirm()).toHaveAttribute('aria-busy', 'true');
      });
      await act(async () => {
        finish('done');
        await Promise.resolve();
      });
    },
  },
  empty: {
    inapplicable:
      'The dialog reads no list, so there is nothing it could find empty; the reasons a reason dialog reads are that dialog’s.',
  },
  'validation error': {
    inapplicable:
      'The dialog has no input to validate: it confirms an act on a record the screen already holds.',
  },
  error: {
    test: async () => {
      const view = setup({ send: () => refusal(403, 'SELF_APPROVAL_FORBIDDEN') });

      await view.user.click(confirm());

      expect(await screen.findByRole('alert')).toBeVisible();
      expect(document.body.textContent).not.toMatch(DIAGNOSTIC);
    },
  },
  retry: {
    test: async () => {
      const view = setup({ send: lost, retryable: true });

      await view.user.click(confirm());

      expect(await screen.findByRole('button', { name: 'Try again' })).toBeVisible();
    },
  },
  offline: { inapplicable: OFFLINE_NOT_APPLICABLE },
  'stale / conflict': {
    test: async () => {
      const view = setup({ send: () => refusal(409, 'STATE_CONFLICT') });

      await view.user.click(confirm());

      expect(await screen.findByText(/This record changed/)).toBeVisible();
      expect(screen.getByRole('button', { name: 'Reload the record' })).toBeVisible();
    },
  },
  success: {
    test: async () => {
      const view = setup();

      await view.user.click(confirm());

      await waitFor(() => {
        expect(view.onDone).toHaveBeenCalledTimes(1);
      });
    },
  },
  'permission-restricted': {
    test: async () => {
      const view = setup({ send: () => refusal(403, 'PERMISSION_DENIED') });

      await view.user.click(confirm());

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Your session does not hold the permission this needs.',
      );
    },
  },
});

describe('ConfirmationDialog: accessibility', () => {
  it('has no WCAG violations that can be checked without a layout engine, in its states', async () => {
    const open = setup();
    expect(await wcagViolations(open.container)).toEqual([]);
    open.unmount();

    const unknown = setup({ send: lost });
    await unknown.user.click(confirm());
    await screen.findByRole('button', { name: 'Check the record' });
    expect(await wcagViolations(unknown.container)).toEqual([]);
    unknown.unmount();

    const conflict = setup({ send: () => refusal(409, 'STATE_CONFLICT') });
    await conflict.user.click(confirm());
    await screen.findByRole('button', { name: 'Reload the record' });
    expect(await wcagViolations(conflict.container)).toEqual([]);
  });
});

describe('ConfirmationDialog: inside a form (task R5.2, M3)', () => {
  // Break caught: the dialog's submit bubbling to a form that holds it: confirming the question sends the form too.
  it('never submits a form that holds it', async () => {
    const submitted = vi.fn();
    const send = vi.fn<(command: unknown, key: string) => Promise<string>>(() =>
      Promise.resolve('done'),
    );
    const view = renderWithProviders(
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submitted();
        }}
      >
        <ConfirmationDialog<string>
          open
          title="Approve this demo profile?"
          consequence={<p>The demo person can then set a password and sign in.</p>}
          confirmLabel="Approve profile"
          version={'"v1"'}
          send={send}
          onDone={vi.fn()}
          onCancel={vi.fn()}
          onReload={vi.fn()}
        />
      </form>,
      { signedIn: true },
    );

    await view.user.click(confirm());

    await waitFor(() => {
      expect(send).toHaveBeenCalledTimes(1);
    });
    expect(submitted).not.toHaveBeenCalled();
  });
});
