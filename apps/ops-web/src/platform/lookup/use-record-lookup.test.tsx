import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { errorResponse, installFakeApi, json, type FakeApi } from '../../test-support/fake-api';
import { renderWithProviders } from '../../test-support/render-providers';
import { LOOKUP_DEBOUNCE_MS, useRecordLookup } from './use-record-lookup';

/**
 * The hook behind the top bar's search and the palette (task C2; `AC-LOOKUP-12`): it asks late, asks little, and never offers an earlier text's
 * answer as a later text's. The palette that draws it is step R4's; here a plain input stands in for it.
 */
let api: FakeApi;

afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
  vi.useRealTimers();
});

const LOOKUP = 'POST /ops/lookup';
const ID = '6a7b8c9d-0e1f-4a2b-9c3d-4e5f6a7b8c9d';
/** The text a request asked about: the field `q` of its body (read from a clone, so that the body stays readable for whoever reads it next). */
const qOf = async (request: Request): Promise<string> =>
  ((await request.clone().json()) as { q?: string }).q ?? '';
const asked = (): Promise<string[]> =>
  Promise.all(
    api.requests
      .filter((request) => request.url.includes('/ops/lookup'))
      .map((request) => qOf(request)),
  );

/** The (fake) moment each request left, so that a debounce is judged by the clock the hook reads. */
const leftAt: number[] = [];

const answerFor = (q: string): Response =>
  json(200, {
    items: [
      {
        kind: 'RIDER',
        id: ID,
        title: `Found for ${q}`,
        state: 'ACTIVE',
        hub: { id: '5eed0100-0000-4000-8000-000000000001', display_name: 'Accra' },
      },
    ],
  });

/** One screen: a text box and what the hook says of it. */
function Box({ initial = '' }: { readonly initial?: string }) {
  const [text, setText] = useState(initial);
  const lookup = useRecordLookup(text);
  return (
    <>
      <label>
        Search
        <input
          value={text}
          onChange={(event) => {
            setText(event.target.value);
          }}
        />
      </label>
      <p data-testid="status">{lookup.status}</p>
      <p data-testid="for">{lookup.query}</p>
      <ul>
        {lookup.results.map((result) => (
          <li key={result.id}>{result.title}</li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => {
          lookup.retry();
        }}
      >
        Retry
      </button>
    </>
  );
}

const type = (text: string) => {
  fireEvent.change(screen.getByLabelText('Search'), { target: { value: text } });
};

describe('the lookup hook', () => {
  // Break caught (AC-LOOKUP-01, -11): the text sent in the address (a phone number typed in full that a proxy or a monitoring tool keeps), a GET,
  // a POST without the session's synchronizer token, or an Idempotency-Key asked of a read.
  it('sends the text in the body of a POST with the synchronizer token, and nothing in the address', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    document.cookie = 'melarc_csrf=csrf-token-of-this-session; path=/';
    try {
      api = installFakeApi({ [LOOKUP]: async (request) => answerFor(await qOf(request)) });
      renderWithProviders(<Box />, { signedIn: true });

      type('024 111 2222');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(LOOKUP_DEBOUNCE_MS + 20);
      });
      await waitFor(() => {
        expect(screen.getByTestId('status')).toHaveTextContent('success');
      });

      const sent = api.requests.filter((request) => request.url.includes('/ops/lookup'));
      expect(sent).toHaveLength(1);
      const [request] = sent;
      expect(request?.method).toBe('POST');
      // Nothing of the text is in the address, in any form.
      expect(new URL(request?.url ?? '').search).toBe('');
      expect(request?.url).not.toMatch(/111|2222|024/);
      expect(request?.headers.get('X-CSRF-Token')).toBe('csrf-token-of-this-session');
      expect(request?.headers.get('Content-Type')).toMatch(/^application\/json/);
      expect(await request?.clone().json()).toEqual({ q: '024 111 2222' });
      // No convention asks an Idempotency-Key of a read.
      expect(request?.headers.has('Idempotency-Key')).toBe(false);
    } finally {
      document.cookie = 'melarc_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
    }
  });

  // Break caught: a request for a text too short to search, or one made before the person stopped typing.
  it('asks nothing for fewer than two characters once trimmed, and nothing before the text has stood still', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    leftAt.length = 0;
    api = installFakeApi({
      [LOOKUP]: async (request) => {
        leftAt.push(Date.now());
        return answerFor(await qOf(request));
      },
    });
    renderWithProviders(<Box />, { signedIn: true });

    expect(screen.getByTestId('status')).toHaveTextContent('idle');
    type(' a ');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOOKUP_DEBOUNCE_MS * 3);
    });
    expect(await asked()).toEqual([]);
    expect(screen.getByTestId('status')).toHaveTextContent('idle');

    type('am');
    type('ama');
    type('ama b');
    const lastKeystroke = Date.now();
    expect(screen.getByTestId('status')).toHaveTextContent('waiting');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOOKUP_DEBOUNCE_MS / 4);
    });
    expect(await asked()).toEqual([]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOOKUP_DEBOUNCE_MS);
    });
    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('success');
    });
    // One request, for the text that stood still, trimmed, and it left no sooner than the debounce after the last keystroke.
    expect(await asked()).toEqual(['ama b']);
    expect(leftAt).toHaveLength(1);
    expect((leftAt[0] ?? 0) - lastKeystroke).toBeGreaterThanOrEqual(LOOKUP_DEBOUNCE_MS);
    expect(screen.getByText('Found for ama b')).toBeVisible();
  });

  // Break caught: the answer of the earlier text offered as the answer of the later one while it is waited for.
  it('does not offer the results of an earlier text for a later one, while it waits or is answered', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let release: (response: Response) => void = () => undefined;
    api = installFakeApi({
      [LOOKUP]: async (request) => {
        const q = await qOf(request);
        if (q === 'kofi') return new Promise<Response>((resolve) => (release = resolve));
        return answerFor(q);
      },
    });
    renderWithProviders(<Box initial="ama" />, { signedIn: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOOKUP_DEBOUNCE_MS + 20);
    });
    expect(await screen.findByText('Found for ama')).toBeVisible();

    type('kofi');
    expect(screen.queryByText('Found for ama')).toBeNull();
    expect(screen.getByTestId('status')).toHaveTextContent('waiting');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOOKUP_DEBOUNCE_MS + 20);
    });
    expect(screen.getByTestId('status')).toHaveTextContent('loading');
    expect(screen.queryByText('Found for ama')).toBeNull();

    await act(async () => {
      release(answerFor('kofi'));
      await Promise.resolve();
    });
    expect(await screen.findByText('Found for kofi')).toBeVisible();
    expect(screen.getByTestId('for')).toHaveTextContent('kofi');
  });

  // Break caught (AC-LOOKUP-12): a text that had settled, left and typed again within the debounce, asked at once because it equals the one that
  // settled: a request for a text that did not stand still.
  it('waits again for a text it had settled when the person leaves it and comes back to it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api = installFakeApi({
      [LOOKUP]: async (request) => answerFor(await qOf(request)),
    });
    renderWithProviders(<Box />, { signedIn: true });
    type('kofi');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOOKUP_DEBOUNCE_MS + 20);
    });
    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('success');
    });
    expect(await asked()).toEqual(['kofi']);

    type('kof');
    type('kofi');
    expect(screen.getByTestId('status')).toHaveTextContent('waiting');
    expect(screen.queryByText('Found for kofi')).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOOKUP_DEBOUNCE_MS / 2);
    });
    expect(await asked()).toEqual(['kofi']);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOOKUP_DEBOUNCE_MS);
    });
    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('success');
    });
    expect(await asked()).toEqual(['kofi', 'kofi']);
  });

  // Break caught: a request for a text the person has already typed past, left running on the server (a scan each, at scale).
  it('cancels the request for a text that is no longer the one asked about', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let aborted = false;
    api = installFakeApi({
      [LOOKUP]: async (request) => {
        const q = await qOf(request);
        if (q !== 'kofi') return answerFor(q);
        return new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => {
            aborted = true;
            reject(new DOMException('aborted', 'AbortError'));
          });
        });
      },
    });
    renderWithProviders(<Box initial="kofi" />, { signedIn: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOOKUP_DEBOUNCE_MS + 20);
    });
    expect(screen.getByTestId('status')).toHaveTextContent('loading');

    type('ama');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOOKUP_DEBOUNCE_MS + 20);
    });
    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('success');
    });
    expect(screen.getByTestId('for')).toHaveTextContent('ama');
    expect(aborted).toBe(true);
  });

  // Break caught: a failure drawn as "nothing found", or one that cannot be tried again.
  it('says a failed read is an error and tries again only when asked; an answer with no result is a success', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let calls = 0;
    api = installFakeApi({
      [LOOKUP]: () => {
        calls += 1;
        return calls === 1 ? errorResponse(500, 'INTERNAL_ERROR') : json(200, { items: [] });
      },
    });
    renderWithProviders(<Box initial="nobody" />, { signedIn: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOOKUP_DEBOUNCE_MS + 20);
    });
    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('error');
    });
    expect(calls).toBe(1);

    await act(async () => {
      screen.getByRole('button', { name: 'Retry' }).click();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('success');
    });
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
    expect(calls).toBe(2);
  });

  it('refuses an answer that is not a page of results, as an error', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api = installFakeApi({ [LOOKUP]: () => json(200, { items: 'many' }) });
    renderWithProviders(<Box initial="ama" />, { signedIn: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOOKUP_DEBOUNCE_MS + 20);
    });
    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('error');
    });
  });

  // Break caught: a retry that asks the server for a text that is empty, too short, or has not stood still (a refetch ignores `enabled`).
  it('sends nothing when it is asked to try again while there is nothing to ask or the text has not stood still', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api = installFakeApi({
      [LOOKUP]: async (request) => answerFor(await qOf(request)),
    });
    renderWithProviders(<Box />, { signedIn: true });

    expect(screen.getByTestId('status')).toHaveTextContent('idle');
    await act(async () => {
      screen.getByRole('button', { name: 'Retry' }).click();
      await Promise.resolve();
    });
    type('ama');
    expect(screen.getByTestId('status')).toHaveTextContent('waiting');
    await act(async () => {
      screen.getByRole('button', { name: 'Retry' }).click();
      await Promise.resolve();
    });
    expect(await asked()).toEqual([]);
  });

  // Break caught: a request before the Ops session is known, which a signed-out screen would send.
  it('asks nothing while the session is not signed in', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api = installFakeApi({ [LOOKUP]: () => answerFor('x') });
    renderWithProviders(<Box initial="ama" />, { signedIn: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOOKUP_DEBOUNCE_MS * 3);
    });
    expect(await asked()).toEqual([]);
  });
});
