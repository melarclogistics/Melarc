import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useRef } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import { OperationalCode } from '../code/OperationalCode';
import { Dialog } from '../dialog/Dialog';
import { dismissToast, showToast, Toaster, type ToastOptions } from './Toast';
import { TOAST_CLEARANCE_PROPERTY, useToastClearance } from './toast-clearance';

// jsdom has no pointer capture. Sonner takes it when a pointer goes down on a toast (to follow a swipe), so pressing a button in a toast would throw in the
// middle of the event, outside the test. A browser has the methods; this gives jsdom enough of them for a click to go through.
beforeAll(() => {
  for (const name of ['setPointerCapture', 'releasePointerCapture'] as const) {
    if (typeof Element.prototype[name] !== 'function') Element.prototype[name] = () => undefined;
  }
});

let unmountFirstToaster: () => void;

beforeEach(() => {
  ({ unmount: unmountFirstToaster } = render(<Toaster />));
});

afterEach(() => {
  act(() => {
    dismissToast();
  });
  vi.useRealTimers();
});

function toastOf(message: string): HTMLElement {
  const toast = screen.getByText(message).closest<HTMLElement>('.ui-toast');
  if (toast === null) throw new Error(`The message "${message}" is not in a toast.`);
  return toast;
}

/** The places toasts are drawn: Sonner's one region, named "Notifications". */
const toasters = (): NodeListOf<Element> =>
  document.querySelectorAll('section[aria-label^="Notifications"]');

describe('Toast', () => {
  // Break caught: a message that can only be text, so that a code in it (read aloud on calls) breaks across lines like any word, with no way for a page to
  // keep it whole. A message may hold an element, and the code in it stays in its own (found by the screenshots, where "ACC-MF-" and "Q92422" were two lines).
  it('draws a message that holds a code in its own element, whole', async () => {
    act(() => {
      showToast({
        tone: 'success',
        message: (
          <>
            Pickup run <OperationalCode>ACC-MF-Q92422</OperationalCode> dispatched.
          </>
        ),
      });
    });

    const code = await screen.findByText('ACC-MF-Q92422');
    expect(code).toHaveClass('ui-code');
    expect(code.closest('.ui-toast__message')).toHaveTextContent(
      'Pickup run ACC-MF-Q92422 dispatched.',
    );
  });

  // Break caught: a message raised that never reaches the page, or one that is read twice (the tone's icon is decoration).
  it('shows the message once, with a disc of its tone', async () => {
    act(() => {
      showToast({ tone: 'success', message: 'Request ACC-PR-7KQ2MZ confirmed.' });
    });

    await screen.findByText('Request ACC-PR-7KQ2MZ confirmed.');
    const toast = toastOf('Request ACC-PR-7KQ2MZ confirmed.');
    expect(toast).toHaveAttribute('data-tone', 'success');
    expect(toast.querySelector('.ui-toast__disc')).toHaveAttribute('data-tone', 'success');
    expect(screen.getAllByText('Request ACC-PR-7KQ2MZ confirmed.')).toHaveLength(1);
    expect(toast.querySelector('.ui-toast__disc svg')).toHaveAttribute('aria-hidden', 'true');
  });

  // Break caught: a tone drawn with another tone's disc (a failure in the success colours), or with no icon, so that the tone is told by colour alone.
  it.each(['success', 'info', 'warning', 'danger'] as const)(
    'draws the %s tone with its own disc and an icon',
    async (tone) => {
      act(() => {
        showToast({ tone, message: `A ${tone} message.` });
      });

      await screen.findByText(`A ${tone} message.`);
      const disc = toastOf(`A ${tone} message.`).querySelector('.ui-toast__disc');
      expect(disc).toHaveAttribute('data-tone', tone);
      expect(disc?.querySelector('svg')).not.toBeNull();
    },
  );

  // Break caught: a primary label other than the two the design allows, a secondary action with no primary one, or a third action: the type is the rule, so this file
  // does not compile if it is loosened. (`Undo` is the primary action's, and only where the server can undo the act; the secondary action is the screen's own words.)
  it('allows a primary action (Open or Undo) and a secondary one in the screen’s own words, and no other shape (type tests)', () => {
    const none: ToastOptions = { tone: 'success', message: 'Done.' };
    const open: ToastOptions = {
      tone: 'success',
      message: 'Done.',
      action: { label: 'Open', onClick: vi.fn() },
    };
    const undo: ToastOptions = {
      tone: 'success',
      message: 'Done.',
      action: { label: 'Undo', onClick: vi.fn() },
    };
    const two: ToastOptions = {
      tone: 'success',
      message: 'Done.',
      action: { label: 'Open', onClick: vi.fn() },
      secondaryAction: { label: 'Book another', onClick: vi.fn() },
    };
    const wrongPrimary: ToastOptions = {
      tone: 'success',
      message: 'Done.',
      // @ts-expect-error Only "Open" and "Undo" are words the primary action of a toast may say.
      action: { label: 'Retry', onClick: vi.fn() },
    };
    // @ts-expect-error A toast has a secondary action only beside a primary one.
    const secondaryOnly: ToastOptions = {
      tone: 'success',
      message: 'Done.',
      secondaryAction: { label: 'Book another', onClick: vi.fn() },
    };
    const third: ToastOptions = {
      tone: 'success',
      message: 'Done.',
      action: { label: 'Open', onClick: vi.fn() },
      secondaryAction: { label: 'Book another', onClick: vi.fn() },
      // @ts-expect-error A toast has at most two actions.
      tertiaryAction: { label: 'Cancel', onClick: vi.fn() },
    };

    expect([
      none.action,
      open.action.label,
      undo.action.label,
      two.secondaryAction?.label,
      wrongPrimary.tone,
      secondaryOnly.tone,
      third.tone,
    ]).toEqual([undefined, 'Open', 'Undo', 'Book another', 'success', 'success', 'success']);
  });

  // Break caught: an action that does not act, or one that leaves the toast on the screen after it has been used.
  it('runs its one action, and takes the toast away', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    act(() => {
      showToast({
        tone: 'success',
        message: 'Request ACC-PR-7KQ2MZ booked.',
        action: { label: 'Open', onClick },
      });
    });
    await screen.findByText('Request ACC-PR-7KQ2MZ booked.');

    await user.click(
      within(toastOf('Request ACC-PR-7KQ2MZ booked.')).getByRole('button', { name: 'Open' }),
    );

    expect(onClick).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.queryByText('Request ACC-PR-7KQ2MZ booked.')).toBeNull();
    });
  });

  // Break caught: two actions drawn as one, in the wrong order (the lesser one before the result), beside the message where they would squeeze it into a few words, or not
  // told apart by what they are (the stylesheet tells the quieter one by `data-action`).
  it('draws two actions under the message, the primary one first, each in a button of its own', async () => {
    act(() => {
      showToast({
        tone: 'success',
        message: 'Request ACC-PR-7KQ2MZ booked.',
        action: { label: 'Open', onClick: vi.fn() },
        secondaryAction: { label: 'Book another', onClick: vi.fn() },
      });
    });
    await screen.findByText('Request ACC-PR-7KQ2MZ booked.');

    const toast = toastOf('Request ACC-PR-7KQ2MZ booked.');
    const buttons = within(toast).getAllByRole('button');
    expect(
      buttons.map((button) => button.getAttribute('aria-label') ?? button.textContent),
    ).toEqual(['Open', 'Book another', 'Dismiss this message']);
    expect(buttons.map((button) => button.getAttribute('data-action'))).toEqual([
      'primary',
      'secondary',
      null,
    ]);
    const actions = toast.querySelector('.ui-toast__actions');
    expect(actions?.previousElementSibling).toBe(toast.querySelector('.ui-toast__message'));
    expect(actions).toContainElement(buttons[0] ?? null);
    expect(actions).toContainElement(buttons[1] ?? null);
    expect(actions).not.toContainElement(buttons[2] ?? null);
  });

  // Break caught: the secondary action that runs the primary one's act (or both), or one that leaves the toast on the screen, or the primary one that is lost once there is a
  // second.
  it.each(['Open', 'Book another'] as const)(
    'runs only its own act when %s is used, and takes the toast away',
    async (label) => {
      const user = userEvent.setup();
      const open = vi.fn();
      const another = vi.fn();
      act(() => {
        showToast({
          tone: 'success',
          message: 'Request ACC-PR-4HT9WD booked.',
          action: { label: 'Open', onClick: open },
          secondaryAction: { label: 'Book another', onClick: another },
        });
      });
      await screen.findByText('Request ACC-PR-4HT9WD booked.');

      await user.click(
        within(toastOf('Request ACC-PR-4HT9WD booked.')).getByRole('button', { name: label }),
      );

      expect(open).toHaveBeenCalledTimes(label === 'Open' ? 1 : 0);
      expect(another).toHaveBeenCalledTimes(label === 'Open' ? 0 : 1);
      await waitFor(() => {
        expect(screen.queryByText('Request ACC-PR-4HT9WD booked.')).toBeNull();
      });
    },
  );

  // Break caught: an action that a keyboard cannot reach or use (a div that looks like a button, or an action left out of the order of the page): both are real buttons in
  // the order primary, secondary, dismiss, and Enter on either one runs it.
  it('reaches both actions and the dismiss control with the keyboard, in that order, and Enter uses one', async () => {
    const user = userEvent.setup();
    const another = vi.fn();
    act(() => {
      showToast({
        tone: 'success',
        message: 'Request ACC-PR-2MX8RC booked.',
        action: { label: 'Open', onClick: vi.fn() },
        secondaryAction: { label: 'Book another', onClick: another },
      });
    });
    await screen.findByText('Request ACC-PR-2MX8RC booked.');
    const toast = toastOf('Request ACC-PR-2MX8RC booked.');

    within(toast).getByRole('button', { name: 'Open' }).focus();
    await user.tab();
    expect(within(toast).getByRole('button', { name: 'Book another' })).toHaveFocus();
    await user.tab();
    expect(within(toast).getByRole('button', { name: 'Dismiss this message' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(within(toast).getByRole('button', { name: 'Book another' })).toHaveFocus();

    await user.keyboard('{Enter}');

    expect(another).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.queryByText('Request ACC-PR-2MX8RC booked.')).toBeNull();
    });
  });

  // Break caught: a toast with an action that goes away on its own before the person can use it (WCAG 2.2.1), or one that cannot be dismissed. Any action keeps it, and
  // two do the same.
  it.each([
    ['one action', false],
    ['two actions', true],
  ] as const)(
    'stays when it has %s, until it is dismissed, and can be dismissed',
    async (_name, both) => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      act(() => {
        showToast({
          tone: 'info',
          message: 'The run is being built.',
          action: { label: 'Open', onClick: vi.fn() },
          ...(both ? { secondaryAction: { label: 'Build another', onClick: vi.fn() } } : {}),
        });
      });
      await screen.findByText('The run is being built.');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(screen.getByText('The run is being built.')).toBeVisible();

      await user.click(screen.getByRole('button', { name: 'Dismiss this message' }));
      await waitFor(() => {
        expect(screen.queryByText('The run is being built.')).toBeNull();
      });
    },
  );

  // Break caught: a message with no action that stays for ever (it only repeats what the page shows), or that offers a dismiss control it does not need.
  it('goes by itself when it has no action, and offers no button', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    act(() => {
      showToast({ tone: 'success', message: 'Saved.' });
    });
    await screen.findByText('Saved.');
    expect(within(toastOf('Saved.')).queryByRole('button')).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    await waitFor(() => {
      expect(screen.queryByText('Saved.')).toBeNull();
    });
  });

  // Break caught: the type refusing a secondary action with no primary one but a caller who gets round the type (a cast, a value that came from elsewhere) raising a toast
  // whose only action is the lesser one, or whose secondary action says nothing or is the primary's word "Undo".
  it('refuses at run time what the type refuses, and a secondary action that says nothing or says Undo', () => {
    const secondary = { label: 'Book another', onClick: vi.fn() };
    const noPrimary = { tone: 'success', message: 'Done.', secondaryAction: secondary };
    const emptyWords = {
      tone: 'success',
      message: 'Done.',
      action: { label: 'Open', onClick: vi.fn() },
      secondaryAction: { label: '  ', onClick: vi.fn() },
    };
    const undoAsSecondary = {
      tone: 'success',
      message: 'Done.',
      action: { label: 'Open', onClick: vi.fn() },
      secondaryAction: { label: 'Undo', onClick: vi.fn() },
    };

    expect(() => showToast(noPrimary as unknown as ToastOptions)).toThrow(/only beside a primary/);
    expect(() => showToast(emptyWords as unknown as ToastOptions)).toThrow(/has to say what/);
    expect(() => showToast(undoAsSecondary as unknown as ToastOptions)).toThrow(
      /Only the primary action/,
    );
    expect(screen.queryByText('Done.')).toBeNull();
  });

  // Break caught: a toaster that does not announce (its messages reach no one who cannot see them).
  it('is announced politely, in a region the keyboard can reach', async () => {
    act(() => {
      showToast({ tone: 'success', message: 'Saved.' });
    });
    await screen.findByText('Saved.');

    const region = document.querySelector('[aria-live]');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveAttribute('aria-label', expect.stringMatching(/Notifications/));
  });

  // Break caught: a second toaster, wherever it is mounted (a page that adds its own, the showcase inside a frame that has one): every toast would be drawn twice, because
  // Sonner's store is one for the whole page. Only the first one mounted draws; the next takes over when it goes, so that a toast is never left with no place.
  it('draws one toaster however many are mounted, and the next takes over when the first goes', async () => {
    const second = render(<Toaster />);
    const third = render(<Toaster />);
    expect(toasters()).toHaveLength(1);

    act(() => {
      showToast({ tone: 'success', message: 'Saved once.' });
    });
    await screen.findByText('Saved once.');
    expect(screen.getAllByText('Saved once.')).toHaveLength(1);

    unmountFirstToaster();
    expect(toasters()).toHaveLength(1);
    act(() => {
      dismissToast();
    });
    act(() => {
      showToast({ tone: 'success', message: 'Saved after the first went.' });
    });
    await screen.findByText('Saved after the first went.');
    expect(screen.getAllByText('Saved after the first went.')).toHaveLength(1);

    second.unmount();
    expect(toasters()).toHaveLength(1);
    third.unmount();
    expect(toasters()).toHaveLength(0);
  });

  // Break caught: the toaster drawn where it is mounted, inside the main landmark. A sheet or a dialog that hides the page from assistive technology leaves a live region alone, and
  // with it every element that holds it, so the whole of the main landmark stayed exposed behind an open sheet (shell.spec.ts found it). It is drawn into the body, outside every landmark.
  it('is drawn into the body of the page, outside the landmark it is mounted in', () => {
    unmountFirstToaster();
    render(
      <main>
        <Toaster />
      </main>,
    );

    const region = screen.getByRole('region', { name: /^Notifications/ });
    expect(region.parentElement).toBe(document.body);
    expect(screen.getByRole('main')).not.toContainElement(region);
  });

  // Break caught: a toast whose action or dismiss button has no name, or whose region fails a rule of WCAG 2.2 that can be seen without a layout engine.
  it('has no WCAG violations that can be checked without a layout engine', async () => {
    act(() => {
      showToast({
        tone: 'success',
        message: 'Request ACC-PR-7KQ2MZ booked.',
        action: { label: 'Open', onClick: vi.fn() },
        secondaryAction: { label: 'Book another', onClick: vi.fn() },
      });
    });
    await screen.findByText('Request ACC-PR-7KQ2MZ booked.');

    expect(await wcagViolations(document.body)).toEqual([]);
  });
});

describe('Toast: across sessions, while a dialog is open, and the rest of task R5.2', () => {
  // Break caught (H2): a toast with an action (which has no end of its own) shown again, to the next person, by a toaster that mounts after the session ended: Sonner keeps
  // its toasts in one store and replays the active ones to every new toaster.
  it('is gone when the toaster goes, and is not shown again by the toaster that mounts next', async () => {
    act(() => {
      showToast({
        tone: 'success',
        message: 'Request ACC-PR-7KQ2MZ confirmed.',
        action: { label: 'Open', onClick: () => undefined },
      });
    });
    await screen.findByText('Request ACC-PR-7KQ2MZ confirmed.');

    // The session ends: the shell, and the one toaster with it, is gone; the next person signs in and a new toaster mounts.
    act(() => {
      unmountFirstToaster();
    });
    render(<Toaster />);

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText('Request ACC-PR-7KQ2MZ confirmed.')).toBeNull();
  });

  it('stays while another toaster is mounted: only the last one going takes the toasts with it', async () => {
    render(<Toaster />);
    act(() => {
      showToast({
        tone: 'info',
        message: 'The run is being built.',
        action: { label: 'Open', onClick: () => undefined },
      });
    });
    await screen.findByText('The run is being built.');

    act(() => {
      unmountFirstToaster();
    });

    expect(await screen.findByText('The run is being built.')).toBeVisible();
  });

  // Break caught (M11a): a toast raised while a modal dialog is open, drawn behind its scrim (everything outside a modal dialog is inert): never seen, and with an action it
  // never goes by itself.
  it('is held while a modal dialog is open, and shown when it has closed', async () => {
    const view = render(
      <Dialog open title="Add a note">
        <p>Write the note.</p>
      </Dialog>,
    );

    act(() => {
      showToast({ tone: 'success', message: 'The note is saved.' });
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText('The note is saved.')).toBeNull();

    view.rerender(
      <Dialog open={false} title="Add a note">
        <p>Write the note.</p>
      </Dialog>,
    );

    expect(await screen.findByText('The note is saved.')).toBeVisible();
  });

  it('is shown when the dialog leaves the page without closing, and the held ones keep the order they were raised in', async () => {
    const view = render(
      <Dialog open title="Add a note">
        <p>Write the note.</p>
      </Dialog>,
    );
    act(() => {
      showToast({ tone: 'success', message: 'First message.' });
      showToast({ tone: 'info', message: 'Second message.' });
    });
    expect(screen.queryByText('First message.')).toBeNull();

    view.unmount();

    const first = await screen.findByText('First message.');
    const second = await screen.findByText('Second message.');
    // Sonner puts the newest on top: the one raised second stands above the one raised first, as it would had no dialog been open.
    expect(second.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  it('is never shown when it was taken away while it was held', async () => {
    const view = render(
      <Dialog open title="Add a note">
        <p>Write the note.</p>
      </Dialog>,
    );
    let id: string | number = '';
    act(() => {
      id = showToast({ tone: 'success', message: 'The note is saved.' });
    });

    act(() => {
      dismissToast(id);
    });
    view.rerender(
      <Dialog open={false} title="Add a note">
        <p>Write the note.</p>
      </Dialog>,
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText('The note is saved.')).toBeNull();
  });

  it('is shown at once when no dialog is open', async () => {
    act(() => {
      showToast({ tone: 'success', message: 'Shown at once.' });
    });

    expect(await screen.findByText('Shown at once.')).toBeVisible();
  });

  // Break caught (M11b): the same toast raised twice stacking two copies (a double press, a retry): an id names it, and the second replaces the first in place.
  it('replaces a toast that has the same id instead of stacking a copy', async () => {
    act(() => {
      showToast({ tone: 'success', message: 'Request confirmed (1).', id: 'confirmed' });
      showToast({ tone: 'success', message: 'Request confirmed (2).', id: 'confirmed' });
    });

    expect(await screen.findByText('Request confirmed (2).')).toBeVisible();
    expect(screen.queryByText('Request confirmed (1).')).toBeNull();
    expect(document.querySelectorAll('.ui-toast')).toHaveLength(1);
  });

  it('stacks toasts that have no id, each its own', async () => {
    act(() => {
      showToast({ tone: 'info', message: 'One.' });
      showToast({ tone: 'info', message: 'Two.' });
    });

    await screen.findByText('Two.');
    expect(document.querySelectorAll('.ui-toast')).toHaveLength(2);
  });

  // Break caught (M11d): a dismiss control that is its own button instead of the kit's IconButton (two controls to keep the same).
  it('has the kit’s icon button to dismiss it', async () => {
    act(() => {
      showToast({
        tone: 'info',
        message: 'The run is being built.',
        action: { label: 'Open', onClick: () => undefined },
      });
    });

    await screen.findByText('The run is being built.');
    const dismiss = within(toastOf('The run is being built.')).getByRole('button', {
      name: 'Dismiss this message',
    });
    expect(dismiss).toHaveClass('ui-icon-button');
  });
});

describe('useToastClearance (task R5.2, M11)', () => {
  function Bar({ shown }: { readonly shown: boolean }) {
    const bar = useRef<HTMLDivElement>(null);
    useToastClearance(bar);
    return shown ? <div ref={bar}>Bar</div> : <div ref={bar}>Bar</div>;
  }

  // Break caught: a sticky bar that cannot say where it is, so a toast at the bottom of a narrow window covers it; or one that leaves its clearance behind when it goes.
  it('publishes how far up the toasts stand while the bar is there, and takes it back when it goes', () => {
    const view = render(<Bar shown />);

    expect(document.documentElement.style.getPropertyValue(TOAST_CLEARANCE_PROPERTY)).toMatch(
      /^\d+(\.\d+)?px$/,
    );

    view.unmount();
    expect(document.documentElement.style.getPropertyValue(TOAST_CLEARANCE_PROPERTY)).toBe('');
  });

  it('is what the toaster reads at the foot of a narrow window', () => {
    const source = readFileSync(join(import.meta.dirname, 'Toast.tsx'), 'utf8');

    expect(source).toContain(`var(${TOAST_CLEARANCE_PROPERTY}, 0px)`);
  });
});
