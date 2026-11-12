import { act, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { useApiClient } from '../api/api-client';
import { errorResponse, installFakeApi, json, type FakeApi } from '../../test-support/fake-api';
import { renderWithProviders } from '../../test-support/render-providers';
import {
  QUEUE_CHANGING_ACTS,
  QUEUE_NEUTRAL_CALLS,
  type QueueChangingAct,
} from './queue-changing-acts';
import { useQueueSummary } from './use-queue-summary';

/**
 * The menu's counts and My work after an act the person has just taken (the Product Owner's decision D11(b), 6 November 2026; the last of the moments at
 * which the summary is read again, `AC-QSUM-09`, so that the counts the menu draws, `AC-QSUM-07`, and the cards of My work, `AC-QSUM-08`, follow the act):
 * **one mechanism, and a test for each act**. The probe draws the summary the way the shell does (it asks, and stays asking), the acts are sent through the real client
 * of the real providers, and only the network is replaced. Nothing here is a page: that no page has to remember is the point.
 */
let api: FakeApi;

afterEach(() => {
  api.restore();
});

const ID = '3f4c6b0e-0d8a-4a6e-9f55-1b2f0c9d7e11';
const SUMMARY = '/ops/queue-summary';

type Verb = (path: string, init?: unknown) => Promise<unknown>;
let send: (method: string, path: string) => Promise<unknown> = () =>
  Promise.reject(new Error('The probe is not mounted.'));

/** The menu, as far as the summary goes: it draws the number of the one queue it is given. */
function Menu() {
  const summary = useQueueSummary();
  if (summary.isError) return <p data-testid="count">failed</p>;
  return <p data-testid="count">{String(summary.data?.queues[0]?.count ?? 'none')}</p>;
}

/** Sends a call through the application's own client: the template of a path and the method, as a page names them. */
function Doer() {
  const client = useApiClient() as unknown as Record<string, Verb>;
  useEffect(() => {
    send = (method, path) => {
      const verb = client[method];
      if (verb === undefined) return Promise.reject(new Error(`The client has no ${method}.`));
      return verb(path, {
        params: { path: { id: ID, riderId: ID, stopId: ID } },
        body: {},
      });
    };
  }, [client]);
  return null;
}

const concrete = (path: string): string =>
  path.replaceAll('{id}', ID).replaceAll('{riderId}', ID).replaceAll('{stopId}', ID);

const summaryReads = () => api.requests.filter((request) => request.url.endsWith(SUMMARY)).length;

/** A summary that says how many reads it has been asked for, so that a count shown is a read that happened. */
function open(extra: Record<string, () => Response> = {}, mountMenu = true) {
  let reads = 0;
  api = installFakeApi({
    [`GET ${SUMMARY}`]: () => {
      reads += 1;
      return json(200, {
        queues: [
          {
            queue: 'PICKUP_AWAITING_CONFIRMATION',
            count: reads,
            oldest_at: '2026-11-02T09:00:00Z',
          },
        ],
      });
    },
    ...extra,
  });
  return renderWithProviders(
    <>
      {mountMenu ? <Menu /> : null}
      <Doer />
    </>,
    { signedIn: true },
  );
}

const shown = () => screen.getByTestId('count').textContent;

describe('the summary read again after an act', () => {
  // Break caught: an act of the table that the mechanism does not read the summary after: the menu says 3 waiting for a person who has just
  // confirmed one. One case for each of the acts of the table, through the real client and the real providers.
  it.each(QUEUE_CHANGING_ACTS.map((each) => [each.operation, each] as const))(
    'after %s answered with success',
    async (_operation, each: QueueChangingAct) => {
      open({ [`${each.method} ${concrete(each.path)}`]: () => json(200, {}) });
      await waitFor(() => {
        expect(shown()).toBe('1');
      });

      await act(async () => {
        await send(each.method, each.path);
      });

      await waitFor(() => {
        expect(shown()).toBe('2');
      });
      expect(summaryReads()).toBe(2);
    },
  );

  // Break caught: a call that changes no queue (or is not an act of the person) making a read of the summary, which is a request more in the
  // session's 120 a minute for nothing, on a search typed letter by letter.
  it.each(QUEUE_NEUTRAL_CALLS.map((each) => [each.operation, each] as const))(
    'not after %s, which changes no queue',
    async (_operation, each) => {
      open({ [`${each.method} ${concrete(each.path)}`]: () => json(200, {}) });
      await waitFor(() => {
        expect(shown()).toBe('1');
      });

      await act(async () => {
        await send(each.method, each.path);
      });
      // Give a read that should not happen the time to happen.
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(summaryReads()).toBe(1);
      expect(shown()).toBe('1');
    },
  );

  // Break caught: the summary read again for an act that was refused: nothing changed, and every try of a refused act would read it.
  it.each([
    [400, 'VALIDATION_FAILED'],
    [403, 'PERMISSION_DENIED'],
    [409, 'STATE_CONFLICT'],
    [500, 'INTERNAL_ERROR'],
  ])('not after an act the API refused with %i', async (status, code) => {
    open({
      'POST /pickup-requests/3f4c6b0e-0d8a-4a6e-9f55-1b2f0c9d7e11/confirm': () =>
        errorResponse(status, code),
    });
    await waitFor(() => {
      expect(shown()).toBe('1');
    });

    await act(async () => {
      await send('POST', '/pickup-requests/{id}/confirm');
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(summaryReads()).toBe(1);
  });

  // Break caught: the read made at once but joined to one that was already under way (`cancelRefetch: false`): that read began before the act and
  // its answer may not have it, so the menu would show the figure of before the act, after the act.
  it('replaces a read that began before the act and has not come back', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reads = 0;
    api = installFakeApi({
      [`GET ${SUMMARY}`]: async () => {
        reads += 1;
        const mine = reads;
        // The first read is slow and carries the figure of before the act; the second is the one that follows it.
        if (mine === 1) await held;
        return json(200, {
          queues: [
            {
              queue: 'PICKUP_AWAITING_CONFIRMATION',
              count: mine === 1 ? 5 : 4,
              oldest_at: '2026-11-02T09:00:00Z',
            },
          ],
        });
      },
      [`POST ${concrete('/pickup-requests/{id}/confirm')}`]: () => json(200, {}),
    });
    renderWithProviders(
      <>
        <Menu />
        <Doer />
      </>,
      { signedIn: true },
    );
    await waitFor(() => {
      expect(reads).toBe(1);
    });

    await act(async () => {
      await send('POST', '/pickup-requests/{id}/confirm');
    });
    await waitFor(() => {
      expect(shown()).toBe('4');
    });
    release();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(shown()).toBe('4');
  });

  // Break caught: a read forced when nothing asks for the summary (no menu on the screen): a request for a page that draws no count.
  it('does not read what nothing is asking for', async () => {
    open({ 'POST /pickup-requests': () => json(201, {}) }, false);

    await act(async () => {
      await send('POST', '/pickup-requests');
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(summaryReads()).toBe(0);
  });

  // Break caught: a failed read of the summary after an act drawn as a count (the old figure left standing beside a failure), or thrown at the
  // person as a failure of the act that was done.
  it('draws no count when the read that follows the act fails, and the act is still done', async () => {
    let reads = 0;
    api = installFakeApi({
      [`GET ${SUMMARY}`]: () => {
        reads += 1;
        return reads === 1
          ? json(200, { queues: [{ queue: 'PICKUP_AWAITING_CONFIRMATION', count: 3 }] })
          : errorResponse(503, 'INTERNAL_ERROR');
      },
      'POST /pickup-requests': () => json(201, { id: ID }),
    });
    renderWithProviders(
      <>
        <Menu />
        <Doer />
      </>,
      { signedIn: true },
    );
    await waitFor(() => {
      expect(shown()).toBe('3');
    });

    let result: unknown;
    await act(async () => {
      result = await send('POST', '/pickup-requests');
    });

    expect((result as { response: Response }).response.status).toBe(201);
    await waitFor(() => {
      expect(shown()).toBe('failed');
    });
  });
});
