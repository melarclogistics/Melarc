import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { sessionFixture } from '../../test-support/session-fixture';
import { SessionProvider } from '../session/SessionProvider';
import { SessionStore } from '../session/session-store';
import { useCommandKeySlot } from './use-command-key-slot';

const COMMAND = {
  operation: 'resetStaffMfa',
  id: 'a1',
  body: { reason_code: 'MFA_AUTHENTICATOR_UNAVAILABLE' },
};

function mount() {
  const store = new SessionStore();
  store.signedIn(sessionFixture());
  const wrapper = ({ children }: { readonly children: ReactNode }) => (
    <SessionProvider store={store}>{children}</SessionProvider>
  );
  return { store, ...renderHook(() => useCommandKeySlot(), { wrapper }) };
}

/** Sends the command and answers as if the connection dropped: the attempt's outcome is unknown, and its key is kept. */
async function sendAndLoseTheAnswer(slot: ReturnType<typeof useCommandKeySlot>): Promise<string> {
  let sentWith = '';
  await slot
    .run(COMMAND, (key) => {
      sentWith = key;
      return Promise.reject(new TypeError('Failed to fetch'));
    })
    .catch(() => undefined);
  return sentWith;
}

describe('useCommandKeySlot', () => {
  // Break caught: the key of an attempt that may have been committed being replaced for a retry in the same session.
  it('keeps the key of an unresolved command for the retry in the same session', async () => {
    const { result } = mount();

    const first = await sendAndLoseTheAnswer(result.current);
    const second = await sendAndLoseTheAnswer(result.current);

    expect(first).not.toBe('');
    expect(second).toBe(first);
  });

  // Break caught: a key made for one person's command reaching another person's: the idempotency record belongs to a principal.
  it('does not carry a key into another session', async () => {
    const { result, store } = mount();
    const first = await sendAndLoseTheAnswer(result.current);

    act(() => {
      store.end();
      store.signedIn(sessionFixture({ principal_display_name: 'Someone Else' }));
    });
    const second = await sendAndLoseTheAnswer(result.current);

    expect(second).not.toBe(first);
  });

  // Break caught: a session that ended and began again by the same sign-in being taken for the same session.
  it('does not carry a key across a session that ended while nobody signed in again', async () => {
    const { result, store } = mount();
    const first = await sendAndLoseTheAnswer(result.current);

    act(() => {
      store.end();
    });
    const second = await sendAndLoseTheAnswer(result.current);

    expect(second).not.toBe(first);
  });

  // Break caught: a key surviving the form it was made for, so a form opened again later is a retry of an attempt nobody is retrying.
  it('forgets the held key when the form goes away', async () => {
    const first = mount();
    const heldKey = await sendAndLoseTheAnswer(first.result.current);
    expect(first.result.current.describe()).toEqual({ held: true, unresolved: true });

    first.unmount();

    expect(first.result.current.describe()).toEqual({ held: false, unresolved: false });
    const again = mount();
    expect(await sendAndLoseTheAnswer(again.result.current)).not.toBe(heldKey);
  });
});

describe('useCommandKeySlot: a command still being prepared (review of 24 October 2026)', () => {
  // Break caught: the form's disposal erasing a key that exists and leaving a command that is being prepared to be sent from a form that
  // is gone.
  it('sends nothing for a command still being prepared when the form goes away', async () => {
    const view = mount();
    const send = vi.fn(() => Promise.resolve('ok' as const));

    const pending = view.result.current.run(COMMAND, send);
    view.unmount();

    await expect(pending).rejects.toMatchObject({ name: 'CommandCancelledError' });
    expect(send).not.toHaveBeenCalled();
  });

  // Break caught: the session read after the digest, so that a command begun for one person is sent into the session that replaced it.
  it('sends nothing for a command still being prepared when the session is replaced', async () => {
    const { result, store } = mount();
    const send = vi.fn(() => Promise.resolve('ok' as const));

    const pending = result.current.run(COMMAND, send);
    act(() => {
      store.end();
      store.signedIn(sessionFixture({ principal_display_name: 'Someone Else' }));
    });

    await expect(pending).rejects.toMatchObject({ name: 'CommandCancelledError' });
    expect(send).not.toHaveBeenCalled();
    expect(result.current.describe()).toEqual({ held: false, unresolved: false });
  });
});
