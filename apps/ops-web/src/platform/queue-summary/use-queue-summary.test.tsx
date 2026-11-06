import { act, screen, waitFor } from '@testing-library/react';
import { useLocation, useNavigate } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { errorResponse, installFakeApi, json, type FakeApi } from '../../test-support/fake-api';
import { renderWithProviders } from '../../test-support/render-providers';
import {
  useQueueSummary,
  useRefreshQueueSummary,
  useRefreshQueueSummaryOnReturn,
} from './use-queue-summary';

let api: FakeApi;

afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
  vi.useRealTimers();
});

const SUMMARY = 'GET /ops/queue-summary';
const reads = (): number =>
  api.requests.filter((request) => request.url.includes('/ops/queue-summary')).length;

let counted = 0;
/** A server whose answer moves with each read, so that a read that happened is a read that can be seen. */
const answering = () => {
  counted = 0;
  return () => {
    counted += 1;
    return json(200, {
      queues: [
        {
          queue: 'PICKUP_AWAITING_CONFIRMATION',
          count: counted,
          oldest_at: '2026-11-02T09:00:00.000Z',
        },
      ],
    });
  };
};

/** One screen that asks for the summary and says what it holds. */
function Asker({ enabled = true }: { readonly enabled?: boolean }) {
  const summary = useQueueSummary(enabled);
  if (summary.isPending) return <p>{summary.fetchStatus === 'idle' ? 'Not asked' : 'Reading'}</p>;
  if (summary.isError) return <p>Failed</p>;
  return <p>{`Waiting: ${String(summary.data.queues[0]?.count)}`}</p>;
}

describe('the read of the queue summary', () => {
  // Break caught: the answer of the server drawn raw, or the call not made at all.
  it('reads getQueueSummary and hands on what the guard judged', async () => {
    api = installFakeApi({ [SUMMARY]: answering() });
    renderWithProviders(<Asker />, { signedIn: true });

    expect(await screen.findByText('Waiting: 1')).toBeVisible();
    expect(reads()).toBe(1);
  });

  // Break caught: an answer that is not a summary taken for one, or a failure retried silently so that it is told late.
  it('fails as an unexpected answer when it is not a summary, and is not tried again by itself', async () => {
    api = installFakeApi({ [SUMMARY]: () => json(200, { queues: 'many' }) });
    renderWithProviders(<Asker />, { signedIn: true });

    expect(await screen.findByText('Failed')).toBeVisible();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(reads()).toBe(1);
  });

  it('fails when the server fails, and not into a number', async () => {
    api = installFakeApi({ [SUMMARY]: () => errorResponse(500, 'INTERNAL_ERROR') });
    renderWithProviders(<Asker />, { signedIn: true });

    expect(await screen.findByText('Failed')).toBeVisible();
  });

  // Break caught: a read made for a session that is not there, which would be answered `SESSION_INVALID` and take the page back to sign-in.
  it('asks nothing while it is told not to', async () => {
    api = installFakeApi({ [SUMMARY]: answering() });
    renderWithProviders(<Asker enabled={false} />, { signedIn: true });

    expect(await screen.findByText('Not asked')).toBeVisible();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(reads()).toBe(0);
  });

  // Break caught: the menu and the landing each reading the summary, so that one page makes two requests for the same figures.
  it('is one read for the menu and the page that ask for it together', async () => {
    api = installFakeApi({ [SUMMARY]: answering() });
    renderWithProviders(
      <>
        <Asker />
        <Asker />
      </>,
      { signedIn: true },
    );

    expect(await screen.findAllByText('Waiting: 1')).toHaveLength(2);
    expect(reads()).toBe(1);
  });
});

describe('when the summary is read again (AC-QSUM-09)', () => {
  // Break caught: a page that reads again whenever the window is focused or the connection returns, which keeps a session alive that
  // its owner has walked away from.
  it('is not read again when the window is focused or the connection returns', async () => {
    api = installFakeApi({ [SUMMARY]: answering() });
    renderWithProviders(<Asker />, { signedIn: true });
    await screen.findByText('Waiting: 1');

    act(() => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
      window.dispatchEvent(new Event('offline'));
      window.dispatchEvent(new Event('online'));
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(reads()).toBe(1);
  });

  // Break caught: a timer. The portal sets no interval for the summary: an hour of an open page makes no request.
  it('is never read on a timer', async () => {
    api = installFakeApi({ [SUMMARY]: answering() });
    renderWithProviders(<Asker />, { signedIn: true });
    await screen.findByText('Waiting: 1');

    vi.useFakeTimers();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    });
    vi.useRealTimers();

    expect(reads()).toBe(1);
  });

  // Break caught: a page that shows an old figure after the person has returned to it.
  it('is read again when a page is returned to, and not for a change of the query string alone', async () => {
    api = installFakeApi({ [SUMMARY]: answering() });
    function Shell() {
      const navigate = useNavigate();
      const { pathname } = useLocation();
      useRefreshQueueSummaryOnReturn(pathname);
      return (
        <>
          <Asker />
          <button
            type="button"
            onClick={() => {
              void navigate('/pickup-requests');
            }}
          >
            Go to the queue
          </button>
          <button
            type="button"
            onClick={() => {
              void navigate('/pickup-requests?state=PENDING');
            }}
          >
            Filter
          </button>
        </>
      );
    }
    const { user } = renderWithProviders(<Shell />, { signedIn: true });
    await screen.findByText('Waiting: 1');
    expect(reads()).toBe(1);

    await user.click(screen.getByRole('button', { name: 'Go to the queue' }));
    expect(await screen.findByText('Waiting: 2')).toBeVisible();
    expect(reads()).toBe(2);

    await user.click(screen.getByRole('button', { name: 'Filter' }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(reads()).toBe(2);
  });

  // Break caught: the first page read twice, once by the menu and once by the "return" that the first render is not.
  it('does not read a second time for the page it starts at', async () => {
    api = installFakeApi({ [SUMMARY]: answering() });
    function Shell() {
      useRefreshQueueSummaryOnReturn('/');
      return <Asker />;
    }
    renderWithProviders(<Shell />, { signedIn: true });

    await screen.findByText('Waiting: 1');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(reads()).toBe(1);
  });

  // Break caught: a refresh that starts a second read while one is under way, or that cancels it and loses the first answer.
  it('is read again on request, and a request while a read is under way joins it', async () => {
    let release: () => void = () => undefined;
    let held: Promise<void> | undefined;
    counted = 0;
    api = installFakeApi({
      [SUMMARY]: async () => {
        counted += 1;
        const mine = counted;
        if (mine === 2) {
          held = new Promise<void>((resolve) => {
            release = resolve;
          });
          await held;
        }
        return json(200, {
          queues: [
            {
              queue: 'PICKUP_AWAITING_CONFIRMATION',
              count: mine,
              oldest_at: '2026-11-02T09:00:00.000Z',
            },
          ],
        });
      },
    });
    function Shell() {
      const refresh = useRefreshQueueSummary();
      return (
        <>
          <Asker />
          <button
            type="button"
            onClick={() => {
              void refresh();
              void refresh();
            }}
          >
            Refresh
          </button>
        </>
      );
    }
    const { user } = renderWithProviders(<Shell />, { signedIn: true });
    await screen.findByText('Waiting: 1');

    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => {
      expect(reads()).toBe(2);
    });
    await act(async () => {
      release();
      await held;
    });

    expect(await screen.findByText('Waiting: 2')).toBeVisible();
    expect(reads()).toBe(2);
  });

  // Break caught: a refresh that reads the summary when no screen asks for it, which would be a request for nothing.
  it('is not read on request when nothing is asking for it', async () => {
    api = installFakeApi({ [SUMMARY]: answering() });
    function Refresher() {
      const refresh = useRefreshQueueSummary();
      return (
        <button
          type="button"
          onClick={() => {
            void refresh();
          }}
        >
          Refresh
        </button>
      );
    }
    const { user } = renderWithProviders(<Refresher />, { signedIn: true });

    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(reads()).toBe(0);
  });
});

describe('what is kept', () => {
  // Break caught: one person's counts shown to the next person on the same browser.
  it('is dropped when the session ends, with everything else the query client holds', async () => {
    api = installFakeApi({ [SUMMARY]: answering() });
    const view = renderWithProviders(<Asker />, { signedIn: true });
    await screen.findByText('Waiting: 1');
    expect(view.queryClient.getQueryData(['queue-summary'])).toBeDefined();

    act(() => {
      view.queryClient.clear();
    });

    expect(view.queryClient.getQueryData(['queue-summary'])).toBeUndefined();
  });

  // Break caught: the summary kept after nothing shows it, so that the next visit starts from an old figure.
  it('is not kept once nothing asks for it', async () => {
    api = installFakeApi({ [SUMMARY]: answering() });
    const view = renderWithProviders(<Asker />, { signedIn: true });
    await screen.findByText('Waiting: 1');

    view.unmount();

    await waitFor(() => {
      expect(view.queryClient.getQueryData(['queue-summary'])).toBeUndefined();
    });
  });
});
