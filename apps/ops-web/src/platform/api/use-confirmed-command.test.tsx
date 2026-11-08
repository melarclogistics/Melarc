import { ApiError, createBrowserApiClient } from '@melarc/api-client/browser';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { errorResponse, installFakeApi, json } from '../../test-support/fake-api';
import { sessionFixture } from '../../test-support/session-fixture';
import { SessionProvider } from '../session/SessionProvider';
import { StaleSessionError } from '../session/session-boundary';
import { SessionStore } from '../session/session-store';
import { answerOf, OperationFailure } from './api-response';
import { useConfirmedCommand, type ConfirmedCommandOptions } from './use-confirmed-command';

/** Everything that makes the request what it is: the reason, the note and the version the person saw. */
interface Command {
  reasonCode: string;
  note?: string;
  version: string;
}

const COMMAND: Command = { reasonCode: 'DEMO_REASON', note: 'A note.', version: '"v1"' };

const refusal = (status: number, code: string): ApiError =>
  new ApiError({ kind: 'http', status, code });
const lost = (): Promise<never> => Promise.reject(new TypeError('Failed to fetch'));

function mount(
  options: Partial<ConfirmedCommandOptions<Command, string>> & {
    send: ConfirmedCommandOptions<Command, string>['send'];
  },
) {
  const store = new SessionStore();
  store.signedIn(sessionFixture());
  const wrapper = ({ children }: { readonly children: ReactNode }) => (
    <SessionProvider store={store}>{children}</SessionProvider>
  );
  // A command that can be sent again unchanged is the one whose unknown outcome is worth a retry; the tests of the other kind say so.
  const view = renderHook(
    () => useConfirmedCommand<Command, string>({ retryable: true, ...options }),
    { wrapper },
  );
  return { store, ...view };
}

/** Sends the command and waits for the attempt to end. */
async function submit(
  result: { readonly current: ReturnType<typeof useConfirmedCommand<Command, string>> },
  command: Command = COMMAND,
) {
  await act(async () => {
    await result.current.submit(command);
  });
}

describe('useConfirmedCommand: the way through', () => {
  it('sends the command with a key, and ends done with what the server answered', async () => {
    const send = vi.fn<(command: Command, key: string) => Promise<string>>(() =>
      Promise.resolve('answer'),
    );
    const onDone = vi.fn();
    const { result } = mount({ send, onDone });
    expect(result.current.phase).toBe('idle');

    await submit(result);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toEqual(COMMAND);
    expect(send.mock.calls[0]?.[1]).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.current.phase).toBe('done');
    expect(onDone).toHaveBeenCalledExactlyOnceWith('answer');
  });

  it('is under way while the call is, and the fields are locked', async () => {
    let finish: (value: string) => void = () => undefined;
    const send = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const { result } = mount({ send });

    let attempt: Promise<void> = Promise.resolve();
    act(() => {
      attempt = result.current.submit(COMMAND);
    });

    expect(result.current.phase).toBe('sending');
    expect(result.current.locked).toBe(true);
    await waitFor(() => {
      expect(send).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      finish('answer');
      await attempt;
    });
    expect(result.current.phase).toBe('done');
    expect(result.current.locked).toBe(false);
  });

  // Break caught: a second press, or the Enter key, sending the command twice while the first is under way.
  it('ignores a second submit while one is under way', async () => {
    let finish: (value: string) => void = () => undefined;
    const send = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const { result } = mount({ send });

    let first: Promise<void> = Promise.resolve();
    act(() => {
      first = result.current.submit(COMMAND);
      void result.current.submit(COMMAND);
    });
    await waitFor(() => {
      expect(send).toHaveBeenCalledTimes(1);
    });
    await act(async () => {
      finish('answer');
      await first;
    });

    expect(send).toHaveBeenCalledTimes(1);
  });

  // Break caught: a command that is edited after it was sent, such as the object the form still holds, being what a retry sends.
  it('keeps the command as it was when it was sent, whatever the form does to its object afterwards', async () => {
    const send = vi
      .fn<(command: Command, key: string) => Promise<string>>()
      .mockImplementationOnce(lost)
      .mockResolvedValueOnce('answer');
    const { result } = mount({ send });
    const command = { ...COMMAND };

    await submit(result, command);
    command.reasonCode = 'SOMETHING_ELSE';
    command.version = '"v2"';
    await act(async () => {
      await result.current.retry();
    });

    expect(send.mock.calls[1]?.[0]).toEqual(COMMAND);
  });
});

describe('useConfirmedCommand: what the screen does with the answer', () => {
  // Break caught: a screen's own mistake in its done handler being read as the failure of the command. The act was done and the API said so;
  // a fault in what the screen does next must not turn that into "we could not confirm whether this was done".
  it('keeps a command done when the screen’s done handler throws, and lets the fault surface', async () => {
    const onDone = vi.fn(() => {
      throw new Error('the screen’s own mistake');
    });
    const { result } = mount({ send: () => Promise.resolve('answer'), onDone });

    await act(async () => {
      await expect(result.current.submit(COMMAND)).rejects.toThrow('the screen’s own mistake');
    });

    expect(onDone).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe('done');
    expect(result.current.problem).toBeUndefined();
  });
});

describe('useConfirmedCommand: an outcome nobody knows', () => {
  // Break caught: the heart of it. The answer was lost, so the command may have been done. The retry must be the same command, with the
  // same key and the same version, so that the server replays the first result and does not do it twice.
  it('keeps the dialog on an unknown outcome, locked, and retries with the same key and the same command', async () => {
    const send = vi
      .fn<(command: Command, key: string) => Promise<string>>()
      .mockImplementationOnce(lost)
      .mockResolvedValueOnce('replayed');
    const onDone = vi.fn();
    const { result } = mount({ send, onDone });

    await submit(result);

    expect(result.current.phase).toBe('unknown');
    expect(result.current.locked).toBe(true);
    expect(onDone).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.retry();
    });

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[1]).toBe(send.mock.calls[0]?.[1]);
    expect(send.mock.calls[1]?.[0]).toEqual(send.mock.calls[0]?.[0]);
    expect(send.mock.calls[1]?.[0].version).toBe('"v1"');
    expect(result.current.phase).toBe('done');
    expect(onDone).toHaveBeenCalledExactlyOnceWith('replayed');
  });

  it('treats a server fault as an unknown outcome too, because the API uses it for a commit it cannot vouch for', async () => {
    const send = vi.fn(() => Promise.reject(refusal(500, 'INTERNAL_ERROR')));
    const { result } = mount({ send });

    await submit(result);

    expect(result.current.phase).toBe('unknown');
  });

  // Break caught: a refusal of the retry (a rate limit) being taken as the end of the first attempt. It decided nothing about it.
  it('stays unknown when the retry is refused, and says why it was refused', async () => {
    const send = vi
      .fn<(command: Command, key: string) => Promise<string>>()
      .mockImplementationOnce(lost)
      .mockRejectedValueOnce(refusal(429, 'RATE_LIMITED'));
    const { result } = mount({ send });
    await submit(result);

    await act(async () => {
      await result.current.retry();
    });

    expect(result.current.phase).toBe('unknown');
    expect(result.current.problem?.kind).toBe('rate-limited');
  });

  // Break caught: a changed command sent with the old key (IDEMPOTENCY_KEY_CONFLICT) or with a new one (done twice).
  it('refuses to send a different command while the first is unresolved', async () => {
    const send = vi
      .fn<(command: Command, key: string) => Promise<string>>()
      .mockImplementation(lost);
    const { result } = mount({ send });
    await submit(result);

    await submit(result, { ...COMMAND, reasonCode: 'ANOTHER_REASON' });

    expect(send).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe('unknown');
  });

  // Break caught: "Check the record" that leaves the key held, so that the next command, which may be a new one on a record that has
  // changed, is sent as a retry of the old.
  it('lets the person check the record: the attempt is abandoned, the record is read again, and the next command is a new one', async () => {
    const send = vi
      .fn<(command: Command, key: string) => Promise<string>>()
      .mockImplementationOnce(lost)
      .mockResolvedValueOnce('answer');
    const onReload = vi.fn();
    const { result } = mount({ send, onReload });
    await submit(result);

    act(() => {
      result.current.checkRecord();
    });

    expect(onReload).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe('idle');
    expect(result.current.locked).toBe(false);

    await submit(result);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[1]).toMatch(/^[0-9a-f-]{36}$/);
    expect(send.mock.calls[1]?.[1]).not.toBe(send.mock.calls[0]?.[1]);
  });

  // Break caught: a retry offered for a command that takes no Idempotency-Key. Sent again after the first was done, it is not a
  // replay: it meets a record that has moved (STATE_CONFLICT) or does the thing twice. COMPONENT_PATTERNS section 33.2: where the
  // operation takes no such key, the person is offered to reload the record instead.
  it('offers no retry for a command that cannot be sent again, only a look at the record', async () => {
    const send = vi.fn(lost);
    const onReload = vi.fn();
    const { result } = mount({ send, onReload, retryable: false });

    await submit(result);

    expect(result.current.phase).toBe('unknown');
    expect(result.current.canRetry).toBe(false);
    await act(async () => {
      await result.current.retry();
    });
    expect(send).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.checkRecord();
    });
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe('idle');
  });

  it('says a command that can be sent again can be', async () => {
    const { result } = mount({ send: lost });

    expect(result.current.canRetry).toBe(false);
    await submit(result);

    expect(result.current.canRetry).toBe(true);
  });

  it('retries nothing when there is nothing to retry', async () => {
    const send = vi.fn(() => Promise.resolve('answer'));
    const { result } = mount({ send });

    await act(async () => {
      await result.current.retry();
    });

    expect(send).not.toHaveBeenCalled();
    expect(result.current.phase).toBe('idle');
  });
});

describe('useConfirmedCommand: a refusal', () => {
  // Break caught: a refused command holding on to its key. A refusal got an answer, so nothing is in doubt; the next submit is a new
  // command, perhaps with a corrected reason, and a key held would make it look like a changed command (IDEMPOTENCY_KEY_CONFLICT).
  it('ends the attempt: the fields are free, and the next submit is a new command with a new key', async () => {
    const send = vi
      .fn<(command: Command, key: string) => Promise<string>>()
      .mockRejectedValueOnce(refusal(422, 'REASON_NOT_ACTIVE'))
      .mockResolvedValueOnce('answer');
    const { result } = mount({ send });

    await submit(result);

    expect(result.current.phase).toBe('refused');
    expect(result.current.locked).toBe(false);
    expect(result.current.problem).toMatchObject({ kind: 'invalid', code: 'REASON_NOT_ACTIVE' });

    await submit(result, { ...COMMAND, reasonCode: 'ANOTHER_REASON' });

    expect(send.mock.calls[1]?.[1]).not.toBe(send.mock.calls[0]?.[1]);
    expect(result.current.phase).toBe('done');
  });

  // Break caught: a stale version being sent again, which can only be refused again.
  it('says the record changed on a conflict, and reloading starts again with a new key', async () => {
    const send = vi
      .fn<(command: Command, key: string) => Promise<string>>()
      .mockRejectedValueOnce(refusal(409, 'STATE_CONFLICT'))
      .mockResolvedValueOnce('answer');
    const onReload = vi.fn();
    const { result } = mount({ send, onReload });

    await submit(result);

    expect(result.current.phase).toBe('conflict');
    expect(result.current.problem?.message).toMatch(/changed/i);

    act(() => {
      result.current.checkRecord();
    });
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe('idle');

    await submit(result, { ...COMMAND, version: '"v2"' });
    expect(send.mock.calls[1]?.[0].version).toBe('"v2"');
    expect(send.mock.calls[1]?.[1]).not.toBe(send.mock.calls[0]?.[1]);
  });

  it('keeps the places a request was refused, for the form to show on its fields, and no value', async () => {
    const failure = new OperationFailure(refusal(400, 'VALIDATION_FAILED'), [
      { in: 'body', pointer: '/note', rule: 'maxLength' },
    ]);
    const { result } = mount({ send: () => Promise.reject(failure) });

    await submit(result);

    expect(result.current.problem?.violations).toEqual([
      { in: 'body', pointer: '/note', rule: 'maxLength' },
    ]);
  });

  it('can be dismissed back to idle', async () => {
    const { result } = mount({ send: () => Promise.reject(refusal(422, 'REASON_NOT_ACTIVE')) });
    await submit(result);

    act(() => {
      result.current.dismiss();
    });

    expect(result.current.phase).toBe('idle');
    expect(result.current.problem).toBeUndefined();
  });
});

describe('useConfirmedCommand: the session', () => {
  // Break caught: an answer for a session that has gone being shown to the next person, or a command done for them.
  it('shows nothing for an answer to a session that has changed, and does not call it done', async () => {
    const onDone = vi.fn();
    const { result } = mount({ send: () => Promise.reject(new StaleSessionError()), onDone });

    await submit(result);

    expect(result.current.phase).toBe('idle');
    expect(result.current.problem).toBeUndefined();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('sends nothing for a command begun in a session that changed while it was being prepared', async () => {
    const send = vi.fn(() => Promise.resolve('answer'));
    const { result, store } = mount({ send });

    let attempt: Promise<void> = Promise.resolve();
    act(() => {
      attempt = result.current.submit(COMMAND);
      store.end();
      store.signedIn(sessionFixture({ principal_display_name: 'Someone Else' }));
    });
    await act(async () => {
      await attempt;
    });

    expect(send).not.toHaveBeenCalled();
    expect(result.current.phase).toBe('idle');
  });

  it('does not call done for a screen that has gone', async () => {
    let finish: (value: string) => void = () => undefined;
    const onDone = vi.fn();
    const { result, unmount } = mount({
      send: () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
      onDone,
    });
    let attempt: Promise<void> = Promise.resolve();
    act(() => {
      attempt = result.current.submit(COMMAND);
    });
    await waitFor(() => {
      expect(result.current.phase).toBe('sending');
    });

    unmount();
    finish('late');
    await attempt;

    expect(onDone).not.toHaveBeenCalled();
  });
});

describe('useConfirmedCommand: on the wire, through the real client', () => {
  // The point of all of the above, seen from the server's side: the retry of a lost command carries the same Idempotency-Key and the same
  // If-Match as the first attempt, and the same body.
  it('sends the same Idempotency-Key, If-Match and body on a retry', async () => {
    const api = installFakeApi();
    try {
      let answers = 0;
      api.on('POST /pickup-stops/5b6c7d8e-9f01-4a2b-8c3d-4e5f6a7b8c9d/skip', () => {
        answers += 1;
        return answers === 1
          ? Promise.reject(new TypeError('Failed to fetch'))
          : json(200, { id: '5b6c7d8e-9f01-4a2b-8c3d-4e5f6a7b8c9d', state: 'SKIPPED' });
      });
      const client = createBrowserApiClient();
      const { result } = mount({
        send: async (command, key) =>
          answerOf(
            await client.POST('/pickup-stops/{id}/skip', {
              params: {
                path: { id: '5b6c7d8e-9f01-4a2b-8c3d-4e5f6a7b8c9d' },
                header: { 'Idempotency-Key': key, 'If-Match': command.version },
              },
              body: {
                reason_code: command.reasonCode,
                ...(command.note === undefined ? {} : { note: command.note }),
              },
            }),
          ).status.toString(),
      });

      await submit(result);
      expect(result.current.phase).toBe('unknown');
      await act(async () => {
        await result.current.retry();
      });

      expect(result.current.phase).toBe('done');
      const [first, second] = api.requests;
      expect(first?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
      expect(second?.headers.get('Idempotency-Key')).toBe(first?.headers.get('Idempotency-Key'));
      expect(first?.headers.get('If-Match')).toBe('"v1"');
      expect(second?.headers.get('If-Match')).toBe('"v1"');
      expect(await second?.text()).toBe(await first?.text());
      expect(api.unhandled).toEqual([]);
    } finally {
      api.restore();
    }
  });

  it('is told of a stale version as a conflict by the real error envelope', async () => {
    const api = installFakeApi({
      'POST /pickup-stops/5b6c7d8e-9f01-4a2b-8c3d-4e5f6a7b8c9d/skip': () =>
        errorResponse(409, 'STATE_CONFLICT'),
    });
    try {
      const client = createBrowserApiClient();
      const { result } = mount({
        send: async (command, key) =>
          answerOf(
            await client.POST('/pickup-stops/{id}/skip', {
              params: {
                path: { id: '5b6c7d8e-9f01-4a2b-8c3d-4e5f6a7b8c9d' },
                header: { 'Idempotency-Key': key, 'If-Match': command.version },
              },
              body: { reason_code: command.reasonCode },
            }),
          ).status.toString(),
      });

      await submit(result);

      expect(result.current.phase).toBe('conflict');
    } finally {
      api.restore();
    }
  });
});
