import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import { OperationalCode } from '../code/OperationalCode';
import { dismissToast, showToast, Toaster, type ToastOptions } from './Toast';

// jsdom has no pointer capture. Sonner takes it when a pointer goes down on a toast (to follow a swipe), so pressing a button in a toast would throw in the
// middle of the event, outside the test. A browser has the methods; this gives jsdom enough of them for a click to go through.
beforeAll(() => {
  for (const name of ['setPointerCapture', 'releasePointerCapture'] as const) {
    if (typeof Element.prototype[name] !== 'function') Element.prototype[name] = () => undefined;
  }
});

beforeEach(() => {
  render(<Toaster />);
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

  // Break caught: an action label other than the two the design allows, or a second action: the type is the rule, so this file does not compile
  // if it is loosened.
  it('allows one action, and only Open or Undo (a type test)', () => {
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
    const wrong: ToastOptions = {
      tone: 'success',
      message: 'Done.',
      // @ts-expect-error Only "Open" and "Undo" are words a toast's action may say.
      action: { label: 'Retry', onClick: vi.fn() },
    };
    expect([open.action?.label, undo.action?.label, wrong.tone]).toEqual([
      'Open',
      'Undo',
      'success',
    ]);
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

  // Break caught: a toast with an action that goes away on its own before the person can use it (WCAG 2.2.1), or one that cannot be dismissed.
  it('stays when it has an action, until it is dismissed, and can be dismissed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    act(() => {
      showToast({
        tone: 'info',
        message: 'The run is being built.',
        action: { label: 'Open', onClick: vi.fn() },
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
  });

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

  // Break caught: a toast whose action or dismiss button has no name, or whose region fails a rule of WCAG 2.2 that can be seen without a layout engine.
  it('has no WCAG violations that can be checked without a layout engine', async () => {
    act(() => {
      showToast({
        tone: 'success',
        message: 'Request ACC-PR-7KQ2MZ booked.',
        action: { label: 'Open', onClick: vi.fn() },
      });
    });
    await screen.findByText('Request ACC-PR-7KQ2MZ booked.');

    expect(await wcagViolations(document.body)).toEqual([]);
  });
});
