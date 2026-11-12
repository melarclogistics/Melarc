import { ApiError } from '@melarc/api-client/browser';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OperationFailure } from '../../../platform/api/api-response';
import { errorResponse, installFakeApi, json, type FakeApi } from '../../../test-support/fake-api';
import {
  describeInterfaceStates,
  OFFLINE_NOT_APPLICABLE,
} from '../../../test-support/interface-states';
import { reasonFixture } from '../../../test-support/reason-fixture';
import { renderWithProviders } from '../../../test-support/render-providers';
import { wcagViolations } from '../../../test-support/wcag';
import { ReasonConfirmationDialog } from './ReasonConfirmationDialog';
import { cannotText } from '../../../platform/problem/capability-words';

let api: FakeApi;

beforeEach(() => {
  api = installFakeApi();
});

afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
});

const LIST = '/reason-definitions';
const DIAGNOSTIC = /Diagnostic text that must never reach a screen/;

const catalogue = () => [
  reasonFixture({ code: 'DEMO_ONE', label: 'Demo reason one' }),
  reasonFixture({ code: 'DEMO_NOTE', label: 'Demo reason that needs a note', requiresNote: true }),
];

type Props = ComponentProps<typeof ReasonConfirmationDialog<string>>;

const answerWithCatalogue = () => json(200, catalogue());

/** The dialog in its providers, with the reasons answered as the test says. */
function setup(overrides: Partial<Props> = {}, list: () => Response = answerWithCatalogue) {
  api.on(`GET ${LIST}`, list);
  const send = vi.fn<(command: unknown, key: string) => Promise<string>>(() =>
    Promise.resolve('done'),
  );
  const onDone = vi.fn();
  const onCancel = vi.fn();
  const onReload = vi.fn();
  const dialog = (open: boolean) => (
    <ReasonConfirmationDialog<string>
      open={open}
      title="Reset this demo person’s second factor?"
      consequence={<p>Every session of this demo person ends. This cannot be undone.</p>}
      confirmLabel="Reset the second factor"
      operation="resetStaffMfa"
      branch="FACTOR_ACTIVE"
      version={'"v1"'}
      send={send}
      onDone={onDone}
      onCancel={onCancel}
      onReload={onReload}
      {...overrides}
    />
  );
  const view = renderWithProviders(dialog(overrides.open ?? true), { signedIn: true });
  return {
    ...view,
    send,
    onDone,
    onCancel,
    onReload,
    /** Closes the dialog, or opens it again, as the screen that holds it does. */
    setOpen: (open: boolean) => {
      view.rerenderUi(dialog(open));
    },
  };
}

const reasonField = () => screen.findByRole('combobox', { name: 'Reason (required)' });
const confirm = () => screen.getByRole('button', { name: 'Reset the second factor' });

/** Chooses a reason and confirms. */
async function choose(
  view: ReturnType<typeof setup>,
  code = 'DEMO_ONE',
  note?: string,
): Promise<void> {
  await view.user.selectOptions(await reasonField(), code);
  if (note !== undefined) {
    const field = screen.getByRole('textbox', { name: /Note/ });
    await view.user.click(field);
    await view.user.paste(note);
  }
  await view.user.click(confirm());
}

const lost = () => Promise.reject(new TypeError('Failed to fetch'));
const refusal = (status: number, code: string, violations: OperationFailure['violations'] = []) =>
  Promise.reject(
    new OperationFailure(
      new ApiError({ kind: 'http', status, code, requestId: 'req-t1' }),
      violations,
    ),
  );

describe('ReasonConfirmationDialog: the confirmation', () => {
  // Break caught: a confirmation that is not announced as one, has no name or leaves the consequence unsaid.
  it('is an alert dialog named by its title and described by the consequence', async () => {
    setup();

    const dialog = screen.getByRole('alertdialog', {
      name: 'Reset this demo person’s second factor?',
    });
    expect(dialog).toHaveAccessibleDescription(/cannot be undone/);
    await reasonField();
  });

  it('puts focus on Cancel, not on the act', async () => {
    setup();
    await reasonField();

    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('asks the server for the reasons of this action only', async () => {
    setup();
    await reasonField();

    const url = new URL(api.requests[0]?.url ?? '');
    expect(url.searchParams.get('operation')).toBe('resetStaffMfa');
    expect(url.searchParams.get('branch')).toBe('FACTOR_ACTIVE');
  });

  it('cancels from the button and on Escape', async () => {
    const { user, onCancel } = setup();
    await reasonField();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.keyboard('{Escape}');

    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it('is not in the page while it is closed', () => {
    setup({ open: false });

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(api.requests).toHaveLength(0);
  });

  // Break caught: a form that keeps what was typed for the next time, or a key held for an attempt nobody is retrying.
  it('starts clean each time it is opened', async () => {
    const view = setup();
    await view.user.selectOptions(await reasonField(), 'DEMO_NOTE');
    await view.user.click(screen.getByRole('textbox', { name: /Note/ }));
    await view.user.paste('A note from last time');

    view.setOpen(false);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    view.setOpen(true);

    const select = await reasonField();
    expect(select).toHaveValue('');
    expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('');
  });
});

describe('ReasonConfirmationDialog: the reason and the note', () => {
  // Break caught: the act done with no reason, which the server refuses as REASON_REQUIRED after the round trip.
  it('asks for a reason before it sends anything, and puts focus on the field', async () => {
    const { user, send } = setup();
    const select = await reasonField();

    await user.click(confirm());

    expect(select).toHaveAttribute('aria-invalid', 'true');
    expect(select).toHaveAccessibleDescription('Choose a reason.');
    expect(select).toHaveFocus();
    expect(send).not.toHaveBeenCalled();
  });

  it('sends the reason, the version the person saw and a key, and no note when there is none', async () => {
    const view = setup();

    await choose(view);

    await waitFor(() => {
      expect(view.send).toHaveBeenCalledTimes(1);
    });
    expect(view.send.mock.calls[0]?.[0]).toEqual({ reasonCode: 'DEMO_ONE', version: '"v1"' });
    expect(view.send.mock.calls[0]?.[1]).toMatch(/^[0-9a-f-]{36}$/);
    expect(view.onDone).toHaveBeenCalledExactlyOnceWith('done');
  });

  it('sends no version for an action that has none', async () => {
    const view = setup({ version: undefined });

    await choose(view);

    await waitFor(() => {
      expect(view.send).toHaveBeenCalledTimes(1);
    });
    expect(view.send.mock.calls[0]?.[0]).toEqual({ reasonCode: 'DEMO_ONE' });
  });

  // Break caught: a note changed on its way. It is the person's words, kept on the audit event as they wrote them.
  it('sends the note as it was typed', async () => {
    const view = setup();

    await choose(view, 'DEMO_ONE', '  Spoke to the person by phone.  ');

    await waitFor(() => {
      expect(view.send).toHaveBeenCalledTimes(1);
    });
    expect(view.send.mock.calls[0]?.[0]).toMatchObject({
      note: '  Spoke to the person by phone.  ',
    });
  });

  it('treats a blank note as none', async () => {
    const view = setup();

    await choose(view, 'DEMO_ONE', '   ');

    await waitFor(() => {
      expect(view.send).toHaveBeenCalledTimes(1);
    });
    expect(view.send.mock.calls[0]?.[0]).not.toHaveProperty('note');
  });

  // Break caught: a mandatory note left out, which the server refuses as REASON_REQUIRED.
  it('requires a note when the reason says so, and says so on the field', async () => {
    const { user, send } = setup();
    await user.selectOptions(await reasonField(), 'DEMO_NOTE');

    expect(screen.getByRole('textbox', { name: 'Note (required)' })).toHaveAttribute(
      'aria-required',
      'true',
    );
    await user.click(confirm());

    const note = screen.getByRole('textbox', { name: 'Note (required)' });
    expect(note).toHaveAttribute('aria-invalid', 'true');
    expect(note).toHaveAccessibleDescription(/Enter a note for this reason/);
    expect(note).toHaveFocus();
    expect(send).not.toHaveBeenCalled();
  });

  it('does not take spaces for a mandatory note', async () => {
    const { user, send } = setup();
    await user.selectOptions(await reasonField(), 'DEMO_NOTE');
    await user.click(screen.getByRole('textbox', { name: 'Note (required)' }));
    await user.paste('     ');

    await user.click(confirm());

    expect(screen.getByRole('textbox', { name: 'Note (required)' })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('does not require a note for a reason that does not need one', async () => {
    const { user } = setup();
    await user.selectOptions(await reasonField(), 'DEMO_ONE');

    expect(screen.getByRole('textbox', { name: 'Note' })).not.toHaveAttribute('aria-required');
  });

  // Break caught: a note the server will refuse (a control character, more than 1000 UTF-16 code units) sent anyway, or a message
  // that repeats what the person typed. The audit screens free text; the page says what is wrong and not what was written.
  it.each([
    ['a tab', 'Two\twords', /one line/i],
    ['more than a thousand code units', 'x'.repeat(1001), /1000/],
    ['emoji that make more than a thousand code units', '😀'.repeat(501), /1000/],
  ])('refuses a note with %s without echoing it', async (_label, text, message) => {
    const { user, send } = setup();
    await user.selectOptions(await reasonField(), 'DEMO_ONE');
    const note = screen.getByRole('textbox', { name: 'Note' });
    fireEvent.change(note, { target: { value: text } });

    await user.click(confirm());

    expect(note).toHaveAttribute('aria-invalid', 'true');
    expect(note).toHaveAccessibleDescription(message);
    expect(document.body.textContent).not.toContain(text);
    expect(send).not.toHaveBeenCalled();
  });

  it('limits the note to a thousand code units as it is typed', async () => {
    const { user } = setup();
    await user.selectOptions(await reasonField(), 'DEMO_ONE');

    expect(screen.getByRole('textbox', { name: 'Note' })).toHaveAttribute('maxlength', '1000');
  });

  it('is a single line: Enter in the note confirms, and does not add a line', async () => {
    const view = setup();
    await view.user.selectOptions(await reasonField(), 'DEMO_ONE');
    await view.user.click(screen.getByRole('textbox', { name: 'Note' }));
    await view.user.paste('One line.');

    await view.user.keyboard('{Enter}');

    await waitFor(() => {
      expect(view.send).toHaveBeenCalledTimes(1);
    });
    expect(view.send.mock.calls[0]?.[0]).toMatchObject({ note: 'One line.' });
  });
});

describe('ReasonConfirmationDialog: the reasons cannot be had', () => {
  // Break caught: an act offered with nothing to choose, or a refusal that names a role.
  it('names settings.reason.read when the session lacks it, and the act cannot be confirmed', async () => {
    const { send } = setup({}, () => errorResponse(403, 'PERMISSION_DENIED'));

    expect(await screen.findByText(cannotText('settings.reason.read'))).toBeVisible();
    expect(confirm()).toBeDisabled();
    expect(send).not.toHaveBeenCalled();
  });

  it('cannot be confirmed while the reasons are loading', async () => {
    setup();

    expect(confirm()).toBeDisabled();
    await reasonField();
    expect(confirm()).toBeEnabled();
  });

  it('cannot be confirmed when there is no reason to give', async () => {
    setup({}, () => json(200, []));

    expect(
      await screen.findByText('No reason is available for this action, so it cannot be done now.'),
    ).toBeVisible();
    expect(confirm()).toBeDisabled();
  });

  it('can still be cancelled when the reasons cannot be had', async () => {
    const view = setup({}, () => errorResponse(500, 'INTERNAL_ERROR'));
    await screen.findByRole('button', { name: 'Try again' });

    await view.user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(view.onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('ReasonConfirmationDialog: while the act is under way', () => {
  // Break caught: a form that can be changed while its command is being sent: the retry would then be a different command.
  it('locks the reason and the note, shows the act busy and takes no second confirmation', async () => {
    let finish: (value: string) => void = () => undefined;
    const send = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const view = setup({ send });
    await choose(view, 'DEMO_ONE', 'A note.');

    await waitFor(() => {
      expect(confirm()).toHaveAttribute('aria-busy', 'true');
    });
    expect(screen.getByRole('combobox', { name: 'Reason (required)' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Note' })).toHaveAttribute('readonly');
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

describe('ReasonConfirmationDialog: a refusal', () => {
  // Break caught: the server’s diagnostic text on the screen, or a refusal that closes the dialog and loses what was typed.
  it('keeps the dialog and the person’s input, says what was refused in approved words, and sends a new command next time', async () => {
    const send = vi
      .fn<(command: unknown, key: string) => Promise<string>>()
      .mockImplementationOnce(() => refusal(422, 'REASON_NOT_ACTIVE'))
      .mockResolvedValueOnce('done');
    let lists = 0;
    const view = setup({ send }, () => {
      lists += 1;
      return json(200, catalogue());
    });
    await choose(view, 'DEMO_ONE', 'Kept note.');

    const select = await screen.findByRole('combobox', { name: 'Reason (required)' });
    await waitFor(() => {
      expect(select).toHaveAttribute('aria-invalid', 'true');
    });
    expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('Kept note.');
    expect(document.body.textContent).not.toMatch(DIAGNOSTIC);
    expect(screen.getByText(/req-t1/)).toBeVisible();
    expect(lists).toBeGreaterThanOrEqual(2);

    await view.user.selectOptions(select, 'DEMO_NOTE');
    await view.user.click(confirm());

    await waitFor(() => {
      expect(send).toHaveBeenCalledTimes(2);
    });
    expect(send.mock.calls[1]?.[1]).not.toBe(send.mock.calls[0]?.[1]);
  });

  // Break caught: the server's refusal of the note shown nowhere near the note.
  it('puts a refused note on the note and moves focus to it, naming no value', async () => {
    const send = vi.fn(() =>
      refusal(400, 'VALIDATION_FAILED', [{ in: 'body', pointer: '/note', rule: 'format' }]),
    );
    const view = setup({ send });

    await choose(view, 'DEMO_ONE', 'Call me on +233 24 000 0000');

    const note = await screen.findByRole('textbox', { name: 'Note' });
    await waitFor(() => {
      expect(note).toHaveAttribute('aria-invalid', 'true');
    });
    expect(note).toHaveAccessibleDescription(/email addresses and telephone numbers/i);
    expect(note).toHaveFocus();
    expect(document.body.textContent).not.toContain('+233');
  });

  it('puts a mandatory note the server wanted on the note', async () => {
    const send = vi.fn(() => refusal(422, 'REASON_REQUIRED'));
    const view = setup({ send });

    await choose(view, 'DEMO_ONE');

    const note = await screen.findByRole('textbox', { name: /Note/ });
    await waitFor(() => {
      expect(note).toHaveAttribute('aria-invalid', 'true');
    });
  });

  it('says in words that a record changed, and offers to reload it, instead of the act', async () => {
    const send = vi.fn(() => refusal(409, 'STATE_CONFLICT'));
    const view = setup({ send });

    await choose(view);

    expect(await screen.findByText(/changed after you opened it/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Reset the second factor' })).toBeNull();
    await view.user.click(screen.getByRole('button', { name: 'Reload the record' }));
    expect(view.onReload).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toMatch(DIAGNOSTIC);
  });
});

describe('ReasonConfirmationDialog: an outcome nobody knows', () => {
  // Break caught: the heart of the workflow. The answer was lost, so the act may have been done. The dialog stays and says so; it
  // does not claim success, does not claim failure and does not let the person edit the command.
  it('stays open, says the outcome is not known, locks the form and offers to check the record', async () => {
    const send = vi.fn(lost);
    const view = setup({ send });

    await choose(view, 'DEMO_ONE', 'A note.');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/could not confirm whether this was done/i);
    expect(screen.getByRole('alertdialog')).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Reason (required)' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Note' })).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: 'Check the record' })).toBeVisible();
    expect(view.onDone).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('Failed to fetch');
  });

  // Break caught: a retry offered for an act that takes no Idempotency-Key. Sent again after the first was done it is not a replay
  // (COMPONENT_PATTERNS section 33.2): the person is offered the record instead.
  it('offers no retry for an act that cannot be sent again', async () => {
    const view = setup({ send: lost });

    await choose(view);

    await screen.findByRole('button', { name: 'Check the record' });
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('ignores Escape, because an unknown outcome must stay in front of the person', async () => {
    const view = setup({ send: lost });
    await choose(view);
    await screen.findByRole('button', { name: 'Check the record' });

    await view.user.keyboard('{Escape}');

    expect(view.onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeVisible();
  });

  it('moves focus to the way out, so a keyboard user lands on it', async () => {
    const view = setup({ send: lost });
    await choose(view);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Check the record' })).toHaveFocus();
    });
  });

  it('reads the record again when the person asks to check it, and lets them start again', async () => {
    const view = setup({ send: lost });
    await choose(view);

    await view.user.click(await screen.findByRole('button', { name: 'Check the record' }));

    expect(view.onReload).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Reason (required)' })).toBeEnabled();
    });
    expect(screen.queryByRole('button', { name: 'Check the record' })).toBeNull();
  });

  // Break caught: the retry of a lost command that is not the same command with the same key.
  it('retries with the same command and the same key when the act can be sent again', async () => {
    const send = vi
      .fn<(command: unknown, key: string) => Promise<string>>()
      .mockImplementationOnce(lost)
      .mockResolvedValueOnce('replayed');
    const view = setup({ send, retryable: true });
    await choose(view, 'DEMO_ONE', 'A note.');

    await view.user.click(await screen.findByRole('button', { name: 'Try again' }));

    await waitFor(() => {
      expect(view.onDone).toHaveBeenCalledExactlyOnceWith('replayed');
    });
    expect(send.mock.calls[1]?.[0]).toEqual(send.mock.calls[0]?.[0]);
    expect(send.mock.calls[1]?.[1]).toBe(send.mock.calls[0]?.[1]);
  });
});

describe('ReasonConfirmationDialog: the session', () => {
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
    await choose(view);
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

describe('ReasonConfirmationDialog: an act whose operation takes no note (S0.60)', () => {
  // Break caught: a note field on an act whose operation has no field for one, so that a person writes a sentence that is never kept.
  it('shows no note field, before or after the reason is chosen, and says nothing of one', async () => {
    const view = setup({ withNote: false });
    await reasonField();
    expect(screen.queryByRole('textbox')).toBeNull();

    await view.user.selectOptions(await reasonField(), 'DEMO_NOTE');

    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByText(/leave out email addresses/i)).toBeNull();
  });

  // Break caught: a note sent for an act whose request body is closed on the reason alone.
  it('sends the reason and the version and nothing else', async () => {
    const view = setup({ withNote: false });

    await choose(view, 'DEMO_ONE');

    await waitFor(() => {
      expect(view.send).toHaveBeenCalledTimes(1);
    });
    expect(view.send.mock.calls[0]?.[0]).toEqual({ reasonCode: 'DEMO_ONE', version: '"v1"' });
  });

  // Break caught: a reason that wants a note, offered for an act that has no field for one, leaving the person with a form that can never be
  // sent. The server judges the reason, and says so if it refuses it.
  it('does not block on a note it has no field for: the server decides', async () => {
    const view = setup({ withNote: false });

    await choose(view, 'DEMO_NOTE');

    await waitFor(() => {
      expect(view.send).toHaveBeenCalledTimes(1);
    });
    expect(view.send.mock.calls[0]?.[0]).toEqual({ reasonCode: 'DEMO_NOTE', version: '"v1"' });
  });

  it('still asks for a reason before it sends anything', async () => {
    const { user, send } = setup({ withNote: false });
    const select = await reasonField();

    await user.click(confirm());

    expect(select).toHaveAttribute('aria-invalid', 'true');
    expect(send).not.toHaveBeenCalled();
  });

  // The default is the note: every other act of the identity screens takes one.
  it('shows the note by default', async () => {
    setup();
    await reasonField();

    expect(screen.getByRole('textbox', { name: 'Note' })).toBeVisible();
  });
});

describe('ReasonConfirmationDialog: the look of the act (S0.44)', () => {
  // Break caught: an act that does harm confirmed in a neutral colour, because the danger treatment stopped being the default.
  it('confirms in the danger treatment unless the act is told to be gentler', async () => {
    setup();
    await reasonField();

    expect(confirm()).toHaveClass('ui-button--danger');
  });

  // Break caught: an act that does no harm (a new link to someone who lost theirs) drawn as if it did, which teaches people to ignore the colour.
  it('confirms in the primary treatment for an act that does no harm', async () => {
    setup({ confirmVariant: 'primary' });
    await reasonField();

    expect(confirm()).toHaveClass('ui-button--primary');
    expect(confirm()).not.toHaveClass('ui-button--danger');
  });
});

describeInterfaceStates('ReasonConfirmationDialog', {
  loading: {
    test: () => {
      setup();

      expect(screen.getByRole('status')).toHaveTextContent('Loading the reasons…');
      expect(confirm()).toBeDisabled();
    },
  },
  empty: {
    test: async () => {
      setup({}, () => json(200, []));

      expect(
        await screen.findByText(
          'No reason is available for this action, so it cannot be done now.',
        ),
      ).toBeVisible();
      expect(confirm()).toBeDisabled();
    },
  },
  'validation error': {
    test: async () => {
      const { user } = setup();
      await reasonField();

      await user.click(confirm());

      expect(screen.getByRole('combobox', { name: 'Reason (required)' })).toHaveAttribute(
        'aria-invalid',
        'true',
      );
    },
  },
  error: {
    test: async () => {
      const view = setup({ send: () => refusal(422, 'REASON_NOT_ACTIVE') });
      await choose(view);

      expect(await screen.findByRole('alert')).toBeVisible();
      expect(document.body.textContent).not.toMatch(DIAGNOSTIC);
    },
  },
  retry: {
    test: async () => {
      const view = setup({ send: lost, retryable: true });
      await choose(view);

      expect(await screen.findByRole('button', { name: 'Try again' })).toBeVisible();
    },
  },
  offline: { inapplicable: OFFLINE_NOT_APPLICABLE },
  'stale / conflict': {
    test: async () => {
      const view = setup({ send: () => refusal(409, 'STATE_CONFLICT') });
      await choose(view);

      expect(await screen.findByText(/changed after you opened it/)).toBeVisible();
      expect(screen.getByRole('button', { name: 'Reload the record' })).toBeVisible();
    },
  },
  success: {
    test: async () => {
      const view = setup();
      await choose(view);

      await waitFor(() => {
        expect(view.onDone).toHaveBeenCalledTimes(1);
      });
    },
  },
  'permission-restricted': {
    test: async () => {
      setup({}, () => errorResponse(403, 'PERMISSION_DENIED'));

      expect(await screen.findByText(cannotText('settings.reason.read'))).toBeVisible();
      expect(confirm()).toBeDisabled();
    },
  },
});

describe('ReasonConfirmationDialog: accessibility', () => {
  it('has no WCAG 2.1 A or AA violations that can be checked without a layout engine, in its states', async () => {
    const open = setup();
    await reasonField();
    expect(await wcagViolations(open.container)).toEqual([]);
    open.unmount();

    const unknown = setup({ send: lost });
    await choose(unknown);
    await screen.findByRole('button', { name: 'Check the record' });
    expect(await wcagViolations(unknown.container)).toEqual([]);
    unknown.unmount();

    const conflict = setup({ send: () => refusal(409, 'STATE_CONFLICT') });
    await choose(conflict);
    await screen.findByRole('button', { name: 'Reload the record' });
    expect(await wcagViolations(conflict.container)).toEqual([]);
    expect(within(screen.getByRole('alertdialog')).getAllByRole('button').length).toBeGreaterThan(
      0,
    );
  });
});

describe('ReasonConfirmationDialog: inside a form (task R5.2, M3)', () => {
  // Break caught: the dialog's submit bubbling to a form that holds it: confirming the question sends the form too.
  it('never submits a form that holds it', async () => {
    api.on(`GET ${LIST}`, answerWithCatalogue);
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
        <ReasonConfirmationDialog<string>
          open
          title="Reset this demo person’s second factor?"
          consequence={<p>Every session of this demo person ends. This cannot be undone.</p>}
          confirmLabel="Reset the second factor"
          operation="resetStaffMfa"
          branch="FACTOR_ACTIVE"
          version={'"v1"'}
          send={send}
          onDone={vi.fn()}
          onCancel={vi.fn()}
          onReload={vi.fn()}
        />
      </form>,
      { signedIn: true },
    );

    await view.user.selectOptions(await reasonField(), 'DEMO_ONE');
    await view.user.click(confirm());

    await waitFor(() => {
      expect(send).toHaveBeenCalledTimes(1);
    });
    expect(submitted).not.toHaveBeenCalled();
  });
});
