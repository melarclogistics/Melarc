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

const LOOKUP = 'GET /ops/lookup';
const ID = '6a7b8c9d-0e1f-4a2b-9c3d-4e5f6a7b8c9d';
const asked = (): string[] =>
  api.requests
    .filter((request) => request.url.includes('/ops/lookup'))
    .map((request) => new URL(request.url).searchParams.get('q') ?? '');

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
  // Break caught: a request for a text too short to search, or one made before the person stopped typing.
  it('asks nothing for fewer than two characters once trimmed, and nothing before the text has stood still', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    leftAt.length = 0;
    api = installFakeApi({
      [LOOKUP]: (request) => {
        leftAt.push(Date.now());
        return answerFor(new URL(request.url).searchParams.get('q') ?? '');
      },
    });
    renderWithProviders(<Box />, { signedIn: true });

    expect(screen.getByTestId('status')).toHaveTextContent('idle');
    type(' a ');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOOKUP_DEBOUNCE_MS * 3);
    });
    expect(asked()).toEqual([]);
    expect(screen.getByTestId('status')).toHaveTextContent('idle');

    type('am');
    type('ama');
    type('ama b');
    const lastKeystroke = Date.now();
    expect(screen.getByTestId('status')).toHaveTextContent('waiting');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOOKUP_DEBOUNCE_MS / 4);
    });
    expect(asked()).toEqual([]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOOKUP_DEBOUNCE_MS);
    });
    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('success');
    });
    // One request, for the text that stood still, trimmed, and it left no sooner than the debounce after the last keystroke.
    expect(asked()).toEqual(['ama b']);
    expect(leftAt).toHaveLength(1);
    expect((leftAt[0] ?? 0) - lastKeystroke).toBeGreaterThanOrEqual(LOOKUP_DEBOUNCE_MS);
    expect(screen.getByText('Found for ama b')).toBeVisible();
  });

  // Break caught: the answer of the earlier text offered as the answer of the later one while it is waited for.
  it('does not offer the results of an earlier text for a later one, while it waits or is answered', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let release: (response: Response) => void = () => undefined;
    api = installFakeApi({
      [LOOKUP]: (request) => {
        const q = new URL(request.url).searchParams.get('q') ?? '';
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
      [LOOKUP]: (request) => answerFor(new URL(request.url).searchParams.get('q') ?? ''),
    });
    renderWithProviders(<Box />, { signedIn: true });
    type('kofi');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOOKUP_DEBOUNCE_MS + 20);
    });
    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('success');
    });
    expect(asked()).toEqual(['kofi']);

    type('kof');
    type('kofi');
    expect(screen.getByTestId('status')).toHaveTextContent('waiting');
    expect(screen.queryByText('Found for kofi')).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOOKUP_DEBOUNCE_MS / 2);
    });
    expect(asked()).toEqual(['kofi']);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOOKUP_DEBOUNCE_MS);
    });
    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('success');
    });
    expect(asked()).toEqual(['kofi', 'kofi']);
  });

  // Break caught: a request for a text the person has already typed past, left running on the server (a scan each, at scale).
  it('cancels the request for a text that is no longer the one asked about', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let aborted = false;
    api = installFakeApi({
      [LOOKUP]: (request) => {
        const q = new URL(request.url).searchParams.get('q') ?? '';
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
      [LOOKUP]: (request) => answerFor(new URL(request.url).searchParams.get('q') ?? ''),
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
    expect(asked()).toEqual([]);
  });

  // Break caught: a request before the Ops session is known, which a signed-out screen would send.
  it('asks nothing while the session is not signed in', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api = installFakeApi({ [LOOKUP]: () => answerFor('x') });
    renderWithProviders(<Box initial="ama" />, { signedIn: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOOKUP_DEBOUNCE_MS * 3);
    });
    expect(asked()).toEqual([]);
  });
});
