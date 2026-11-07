import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import { ActionMenu, type ActionMenuItem } from './ActionMenu';

const CANCEL_CONFIRMATION = {
  title: 'Cancel request ACC-PR-7KQ2MZ?',
  description: 'The vendor is told. A cancellation charge may apply.',
  confirmLabel: 'Cancel the request',
} as const;

function items(
  overrides: { reassign?: () => void; cancel?: () => void; escalate?: () => void } = {},
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
    it('is not run when it is chosen: a question comes first, with Cancel focused', async () => {
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
      expect(within(question).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    });

    // Break caught: a Cancel that runs the act anyway, or one that leaves the person somewhere that is not where they were.
    it('is left alone by Cancel, and focus goes back to the button that opened the menu', async () => {
      const user = userEvent.setup();
      const cancel = vi.fn();
      render(<ActionMenu label="More actions for ACC-PR-7KQ2MZ" items={items({ cancel })} />);
      const { trigger } = await open(user);
      await user.click(screen.getByRole('menuitem', { name: 'Cancel request' }));
      const question = await screen.findByRole('alertdialog');

      await user.click(within(question).getByRole('button', { name: 'Cancel' }));

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
