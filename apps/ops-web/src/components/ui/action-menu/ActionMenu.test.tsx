import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import { Dialog } from '../dialog/Dialog';
import { ActionMenu, type ActionMenuItem, type ActionOutcome } from './ActionMenu';

const CANCEL_CONFIRMATION = {
  title: 'Cancel request ACC-PR-7KQ2MZ?',
  description: 'The vendor is told. A cancellation charge may apply.',
  confirmLabel: 'Cancel the request',
} as const;

function items(
  overrides: {
    reassign?: () => void;
    cancel?: () => ActionOutcome | Promise<ActionOutcome>;
    escalate?: () => void;
  } = {},
) {
  return [
    {
      id: 'cancel',
      label: 'Cancel request',
      destructive: true,
      confirm: CANCEL_CONFIRMATION,
      onSelect: overrides.cancel ?? vi.fn(),
    },
    { id: 'reassign', label: 'Change the hub', onSelect: overrides.reassign ?? vi.fn() },
    {
      id: 'escalate',
      label: 'Escalate',
      disabled: { reason: 'An approver decides this.' },
      onSelect: overrides.escalate ?? vi.fn(),
    },
  ] satisfies ActionMenuItem[];
}

async function open(user: ReturnType<typeof userEvent.setup>) {
  const trigger = screen.getByRole('button', { name: 'More actions for ACC-PR-7KQ2MZ' });
  trigger.focus();
  await user.keyboard('{Enter}');
  return { trigger, menu: await screen.findByRole('menu') };
}

describe('ActionMenu', () => {
  // Break caught: a menu button named "More actions" alone (it must say what it acts on), or one the keyboard cannot open.
  it('opens from the keyboard on a button named for what it acts on', async () => {
    const user = userEvent.setup();
    render(<ActionMenu label="More actions for ACC-PR-7KQ2MZ" items={items()} />);
    const trigger = screen.getByRole('button', { name: 'More actions for ACC-PR-7KQ2MZ' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');

    await open(user);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByRole('menuitem').length).toBe(3);
  });

  // Break caught: a destructive act among the others (the order the caller gave), which a person reaches by habit and a pointer slip.
  it('puts the destructive acts last, whatever order they were given in, set apart by a separator', async () => {
    const user = userEvent.setup();
    render(<ActionMenu label="More actions for ACC-PR-7KQ2MZ" items={items()} />);

    const { menu } = await open(user);

    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Change the hub', 'EscalateAn approver decides this.', 'Cancel request']);
    const roles = [...menu.children].map((node) => node.getAttribute('role'));
    expect(roles).toEqual(['menuitem', 'menuitem', 'separator', 'menuitem']);
    expect(within(menu).getByRole('menuitem', { name: 'Cancel request' })).toHaveAttribute(
      'data-variant',
      'destructive',
    );
  });

  // Break caught: a plain act that never runs, runs twice, or leaves the menu open over the page.
  it('runs a plain act when it is chosen, and closes', async () => {
    const user = userEvent.setup();
    const reassign = vi.fn();
    render(<ActionMenu label="More actions for ACC-PR-7KQ2MZ" items={items({ reassign })} />);
    await open(user);

    await user.click(screen.getByRole('menuitem', { name: 'Change the hub' }));

    expect(reassign).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull();
    });
  });

  describe('a destructive act', () => {
    // Break caught: a destructive act that runs as it is chosen, with no question: the whole point of confirming it.
    it('is not run when it is chosen: a question comes first, with Go back focused', async () => {
      const user = userEvent.setup();
      const cancel = vi.fn();
      render(<ActionMenu label="More actions for ACC-PR-7KQ2MZ" items={items({ cancel })} />);
      await open(user);

      await user.click(screen.getByRole('menuitem', { name: 'Cancel request' }));

      const question = await screen.findByRole('alertdialog', {
        name: 'Cancel request ACC-PR-7KQ2MZ?',
      });
      expect(cancel).not.toHaveBeenCalled();
      expect(question).toHaveAccessibleDescription(/A cancellation charge may apply\./);
      // "Go back", and not "Cancel": the act is called "Cancel the request", and a button that says Cancel beside it is a button nobody can tell from it (task R5.2, M3).
      expect(within(question).getByRole('button', { name: 'Go back' })).toHaveFocus();
      expect(within(question).queryByRole('button', { name: 'Cancel' })).toBeNull();
    });

    // Break caught: a Cancel that runs the act anyway, or one that leaves the person somewhere that is not where they were.
    it('is left alone by Go back, and focus goes back to the button that opened the menu', async () => {
      const user = userEvent.setup();
      const cancel = vi.fn();
      render(<ActionMenu label="More actions for ACC-PR-7KQ2MZ" items={items({ cancel })} />);
      const { trigger } = await open(user);
      await user.click(screen.getByRole('menuitem', { name: 'Cancel request' }));
      const question = await screen.findByRole('alertdialog');

      await user.click(within(question).getByRole('button', { name: 'Go back' }));

      expect(cancel).not.toHaveBeenCalled();
      await waitFor(() => {
        expect(trigger).toHaveFocus();
      });
    });

    // Break caught: Escape confirming the act, or a confirm that does not run it.
    it('runs only when it is confirmed, in the act own words', async () => {
      const user = userEvent.setup();
      const cancel = vi.fn();
      render(<ActionMenu label="More actions for ACC-PR-7KQ2MZ" items={items({ cancel })} />);
      await open(user);
      await user.click(screen.getByRole('menuitem', { name: 'Cancel request' }));
      const question = await screen.findByRole('alertdialog');

      await user.keyboard('{Escape}');
      expect(cancel).not.toHaveBeenCalled();
      await waitFor(() => {
        expect(screen.queryByRole('alertdialog')).toBeNull();
      });

      await open(user);
      await user.click(screen.getByRole('menuitem', { name: 'Cancel request' }));
      await user.click(
        within(await screen.findByRole('alertdialog')).getByRole('button', {
          name: 'Cancel the request',
        }),
      );

      expect(cancel).toHaveBeenCalledTimes(1);
      expect(question).toBeDefined();
    });
  });

  describe('an act that cannot be taken', () => {
    // Break caught: a disabled item that cannot be reached by keyboard (its reason can then never be heard), that runs, or that closes the menu with no word.
    it('stays in the keyboard order, does nothing when chosen, keeps the menu open and says why', async () => {
      const user = userEvent.setup();
      const escalate = vi.fn();
      render(<ActionMenu label="More actions for ACC-PR-7KQ2MZ" items={items({ escalate })} />);
      await open(user);

      const item = screen.getByRole('menuitem', { name: 'Escalate' });
      expect(item).toHaveAttribute('aria-disabled', 'true');
      await user.keyboard('{ArrowDown}');
      expect(item).toHaveFocus();
      await user.keyboard('{Enter}');

      expect(escalate).not.toHaveBeenCalled();
      expect(screen.getByRole('menu')).toBeInTheDocument();
      expect(item).toHaveAttribute('data-revealed', 'true');
    });

    // Break caught: a reason that exists only as a tooltip or a colour: it must be the item's description for assistive technology.
    it('is described by its reason, in plain words, and named by its label alone', async () => {
      const user = userEvent.setup();
      render(<ActionMenu label="More actions for ACC-PR-7KQ2MZ" items={items()} />);
      await open(user);

      const item = screen.getByRole('menuitem', { name: 'Escalate' });
      expect(item).toHaveAccessibleDescription('An approver decides this.');
      expect(document.body.textContent).not.toMatch(/pickup\.|approve\b.*permission|Senior Ops/);
    });
  });

  // Break caught: two items with one id, taking one another's reason or confirmation.
  it('throws for two items with one id', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() =>
      render(
        <ActionMenu
          label="More"
          items={[
            { id: 'a', label: 'A', onSelect: vi.fn() },
            { id: 'a', label: 'B', onSelect: vi.fn() },
          ]}
        />,
      ),
    ).toThrow(/have the id "a"/);
    quiet.mockRestore();
  });

  // Break caught: the type letting a destructive act be written without the question behind it: this file does not compile if it does.
  it('cannot be given a destructive act without its confirmation (a type test)', () => {
    // @ts-expect-error A destructive item must carry `confirm`.
    const unconfirmed: ActionMenuItem = {
      id: 'x',
      label: 'X',
      destructive: true,
      onSelect: vi.fn(),
    };
    expect(unconfirmed.destructive).toBe(true);
  });

  // Break caught: an item with no name, a reason not tied to its item, or a menu that fails a rule of WCAG 2.2 (without a layout engine) closed or open.
  it('has no WCAG violations that can be checked without a layout engine, closed or open', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ActionMenu label="More actions for ACC-PR-7KQ2MZ" items={items()} />,
    );
    expect(await wcagViolations(container)).toEqual([]);

    await open(user);
    expect(await wcagViolations(document.body)).toEqual([]);
  });
});

// Task R5.2, M3 and M8: the confirmation of an act is asked once, never sends a form that holds the menu, shows what is under way and what failed, and the menu is drawn
// into the dialog that holds it.
describe('ActionMenu: the confirmation (task R5.2, M3)', () => {
  const MENU = 'More actions for ACC-PR-7KQ2MZ';

  /** Chooses the destructive act and returns the question it opens. */
  async function ask(user: ReturnType<typeof userEvent.setup>) {
    await open(user);
    await user.click(screen.getByRole('menuitem', { name: 'Cancel request' }));
    return screen.findByRole('alertdialog', { name: 'Cancel request ACC-PR-7KQ2MZ?' });
  }

  // Break caught: the question's submit reaching a form that holds the menu (the form's own handler runs, and the page sends what it was filling).
  it('never submits a form that holds the menu', async () => {
    const user = userEvent.setup();
    const cancel = vi.fn();
    const submitted = vi.fn();
    render(
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submitted();
        }}
      >
        <ActionMenu label={MENU} items={items({ cancel })} />
      </form>,
    );

    const question = await ask(user);
    await user.click(within(question).getByRole('button', { name: 'Cancel the request' }));

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(submitted).not.toHaveBeenCalled();
  });

  // Break caught: the question closing at once on an act that takes its time, so that nothing says it is under way and a second press can run it twice.
  it('stays open and busy while the act is under way, and closes when it is done', async () => {
    const user = userEvent.setup();
    let finish: (outcome: ActionOutcome) => void = () => undefined;
    const cancel = vi.fn(
      () =>
        new Promise<ActionOutcome>((resolve) => {
          finish = resolve;
        }),
    );
    render(<ActionMenu label={MENU} items={items({ cancel })} />);

    const question = await ask(user);
    await user.click(within(question).getByRole('button', { name: 'Cancel the request' }));

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(within(question).getByRole('button', { name: 'Cancel the request' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
    expect(within(question).getByRole('button', { name: 'Go back' })).toBeDisabled();
    // Escape does nothing while it is under way, and a second press runs nothing.
    await user.keyboard('{Escape}');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    await user.click(within(question).getByRole('button', { name: 'Cancel the request' }));
    expect(cancel).toHaveBeenCalledTimes(1);

    await act(async () => {
      finish({ ok: true });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
  });

  // Break caught: a failure that closes the question as though the act were done, or that shows the error's own text instead of the page's words.
  it('tells a failure in the page’s words, stays open, and lets the person go back or try again', async () => {
    const user = userEvent.setup();
    const cancel = vi
      .fn<() => Promise<ActionOutcome>>()
      .mockResolvedValueOnce({ ok: false, message: 'The request is already in a pickup run.' })
      .mockResolvedValueOnce({ ok: true });
    render(<ActionMenu label={MENU} items={items({ cancel })} />);

    const question = await ask(user);
    await user.click(within(question).getByRole('button', { name: 'Cancel the request' }));

    expect(await screen.findByText('The request is already in a pickup run.')).toBeVisible();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(within(question).getByRole('button', { name: 'Go back' })).toBeEnabled();

    // The next confirmation is a new act.
    await user.click(within(question).getByRole('button', { name: 'Cancel the request' }));
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it('says that an act did not go through when its promise breaks, never with the error’s own text', async () => {
    const user = userEvent.setup();
    const cancel = vi.fn(() => Promise.reject(new Error('socket hang up: 10.0.0.7')));
    render(<ActionMenu label={MENU} items={items({ cancel })} />);

    const question = await ask(user);
    await user.click(within(question).getByRole('button', { name: 'Cancel the request' }));

    expect(
      await screen.findByText('That did not go through. Try again, or go back.'),
    ).toBeVisible();
    expect(screen.queryByText(/socket hang up/)).toBeNull();
  });

  it('leaves the failure behind when the person goes back, and starts the next question clean', async () => {
    const user = userEvent.setup();
    const cancel = vi.fn().mockResolvedValue({ ok: false, message: 'Not now.' });
    render(<ActionMenu label={MENU} items={items({ cancel })} />);

    const question = await ask(user);
    await user.click(within(question).getByRole('button', { name: 'Cancel the request' }));
    expect(await screen.findByText('Not now.')).toBeVisible();
    await user.click(within(question).getByRole('button', { name: 'Go back' }));
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });

    await ask(user);
    expect(screen.queryByText('Not now.')).toBeNull();
  });

  // Break caught: an act that brings its own dialog asked about twice (the menu's question and then its own), or one that does not give focus back.
  it('opens an act’s own dialog instead of its question, and gives focus back when it closes', async () => {
    const user = userEvent.setup();
    const items: ActionMenuItem[] = [
      {
        id: 'revoke',
        label: 'Revoke access',
        destructive: true,
        dialog: ({ onClose }) => (
          <Dialog open title="Why is access revoked?" role="alertdialog" onRequestClose={onClose}>
            <label>
              Reason <input type="text" />
            </label>
            <button type="button" onClick={onClose}>
              Done
            </button>
          </Dialog>
        ),
      },
      { id: 'note', label: 'Add a note', onSelect: vi.fn() },
    ];
    render(<ActionMenu label={MENU} items={items} />);

    const { trigger } = await open(user);
    await user.click(screen.getByRole('menuitem', { name: 'Revoke access' }));

    const own = await screen.findByRole('alertdialog', { name: 'Why is access revoked?' });
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
    // It is last, in the vermilion of danger, as a destructive act is.
    await user.click(within(own).getByRole('button', { name: 'Done' }));
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
    await waitFor(() => {
      expect(trigger).toHaveFocus();
    });
  });

  it('keeps an act with its own dialog last when it is destructive, set apart by the separator', async () => {
    const user = userEvent.setup();
    render(
      <ActionMenu
        label={MENU}
        items={[
          {
            id: 'revoke',
            label: 'Revoke access',
            destructive: true,
            dialog: () => null,
          },
          { id: 'note', label: 'Add a note', onSelect: vi.fn() },
        ]}
      />,
    );

    const { menu } = await open(user);

    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Add a note', 'Revoke access']);
    expect(within(menu).getByRole('separator')).toBeInTheDocument();
  });
});

describe('ActionMenu: inside a modal dialog (task R5.2, M8)', () => {
  // Break caught: the menu drawn into the page's body, under the dialog's top layer: unseen and out of reach. (The top layer and the inertness are proved in a browser,
  // in `kit.spec.ts`; here, that the menu is inside the dialog's own element.)
  it('is drawn into the dialog that holds it', async () => {
    const user = userEvent.setup();
    render(
      <Dialog open title="Request ACC-PR-7KQ2MZ">
        <ActionMenu label="More actions for ACC-PR-7KQ2MZ" items={items()} />
      </Dialog>,
    );

    await open(user);

    const menu = await screen.findByRole('menu');
    expect(menu.closest('dialog')).toBe(document.querySelector('dialog'));
    expect(menu.closest('[data-slot="dropdown-menu-content"]')).not.toBeNull();
  });

  it('draws its own question over the dialog, once', async () => {
    const user = userEvent.setup();
    render(
      <Dialog open title="Request ACC-PR-7KQ2MZ">
        <ActionMenu label="More actions for ACC-PR-7KQ2MZ" items={items()} />
      </Dialog>,
    );

    await open(user);
    await user.click(screen.getByRole('menuitem', { name: 'Cancel request' }));

    expect(
      await screen.findByRole('alertdialog', { name: 'Cancel request ACC-PR-7KQ2MZ?' }),
    ).toBeVisible();
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
  });
});
