import type { BrowserApiClient } from '@melarc/api-client/browser';
import { describe, expect, it, vi } from 'vitest';

import { observeActs, type ActAnswer } from './answer-observer';

interface Answer {
  readonly response: Response;
  readonly error?: unknown;
}

const ok = (status = 200): Answer => ({ response: new Response('{}', { status }) });
const refused = (status = 409): Answer => ({
  response: new Response('{}', { status }),
  error: { code: 'STATE_CONFLICT' },
});

/** A client with the verbs the real one has, each answering what the test says, and recording what it was called with. */
function clientAnswering(answer: () => Promise<Answer>) {
  const calls: { readonly verb: string; readonly args: readonly unknown[] }[] = [];
  const verb =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push({ verb: name, args });
      return answer();
    };
  const client = {
    GET: verb('GET'),
    HEAD: verb('HEAD'),
    OPTIONS: verb('OPTIONS'),
    TRACE: verb('TRACE'),
    POST: verb('POST'),
    PUT: verb('PUT'),
    PATCH: verb('PATCH'),
    DELETE: verb('DELETE'),
    request: verb('request'),
  };
  return { client: client as unknown as BrowserApiClient, calls };
}

const verbs = (client: BrowserApiClient) =>
  client as unknown as Record<string, (...a: unknown[]) => Promise<Answer>>;

describe('observing the acts the client answers', () => {
  // Break caught: an observer that is not told of an act that was done (the counts lag it), or is told of the wrong path (an address with an
  // identifier in it that no table of acts can match).
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)(
    'tells of a %s that was answered with success, with the path as the call named it',
    async (method) => {
      const seen: ActAnswer[] = [];
      const { client } = clientAnswering(() => Promise.resolve(ok()));
      const observed = observeActs(client, (answer) => seen.push(answer));

      await verbs(observed)[method]?.('/pickup-requests/{id}/confirm', {
        params: { path: { id: 'abc' } },
      });

      expect(seen).toEqual([{ method, path: '/pickup-requests/{id}/confirm' }]);
    },
  );

  // Break caught: a read taken for an act: every page load would read the summary again, and every read of the summary would ask for another.
  it.each(['GET', 'HEAD', 'OPTIONS', 'TRACE'])('does not tell of a %s', async (method) => {
    const seen: ActAnswer[] = [];
    const { client } = clientAnswering(() => Promise.resolve(ok()));
    const observed = observeActs(client, (answer) => seen.push(answer));

    await verbs(observed)[method]?.('/ops/queue-summary');

    expect(seen).toEqual([]);
  });

  // Break caught: an act that was refused (a conflict, a validation, a refusal of authority) read as one that was done: nothing changed, so
  // there is nothing to read again, and a person who keeps trying a refused act would be reading the summary each time.
  it.each([400, 403, 404, 409, 422, 500, 503])(
    'does not tell of an act the API answered with %i',
    async (status) => {
      const seen: ActAnswer[] = [];
      const { client } = clientAnswering(() => Promise.resolve(refused(status)));
      const observed = observeActs(client, (answer) => seen.push(answer));

      await verbs(observed).POST?.('/pickup-requests/{id}/confirm');

      expect(seen).toEqual([]);
    },
  );

  // Break caught: success told when no answer came: a request that failed to send (no connection, a refusal of the boundary, a session that
  // changed meanwhile) is not an act that was done.
  it('does not tell of a call that failed, and lets the failure through as it was', async () => {
    const seen: ActAnswer[] = [];
    const failure = new TypeError('Failed to fetch');
    const { client } = clientAnswering(() => Promise.reject(failure));
    const observed = observeActs(client, (answer) => seen.push(answer));

    await expect(verbs(observed).POST?.('/pickup-requests')).rejects.toBe(failure);

    expect(seen).toEqual([]);
  });

  // Break caught: the generic `request(method, path)` of the client being a way round the observer.
  it('tells of an act made through `request`, naming the method it was given', async () => {
    const seen: ActAnswer[] = [];
    const { client } = clientAnswering(() => Promise.resolve(ok()));
    const observed = observeActs(client, (answer) => seen.push(answer));

    await verbs(observed).request?.('POST', '/pickup-manifests');
    await verbs(observed).request?.('GET', '/pickup-manifests');

    expect(seen).toEqual([{ method: 'POST', path: '/pickup-manifests' }]);
  });

  // Break caught: the wrapper changing the call: another argument, another answer. The caller must not be able to tell it is there.
  it('passes the arguments through and returns the very answer it was given', async () => {
    const answer = ok(201);
    const { client, calls } = clientAnswering(() => Promise.resolve(answer));
    const observed = observeActs(client, () => undefined);
    const init = { body: { a: 1 }, headers: { 'If-Match': '"1"' } };

    const result = await verbs(observed).POST?.('/pickup-requests', init);

    expect(result).toBe(answer);
    expect(calls).toEqual([{ verb: 'POST', args: ['/pickup-requests', init] }]);
  });

  // Break caught: a fault in the portal's own reaction turning an act that was done into one that reads as failed (the person would do it again).
  it('does not turn an act that was done into a failure when the observer throws', async () => {
    const answer = ok();
    const { client } = clientAnswering(() => Promise.resolve(answer));
    const observed = observeActs(
      client,
      vi.fn(() => {
        throw new Error('The observer broke.');
      }),
    );

    await expect(verbs(observed).POST?.('/pickup-requests')).resolves.toBe(answer);
  });

  it('is told once for one act', async () => {
    const onAct = vi.fn();
    const { client } = clientAnswering(() => Promise.resolve(ok()));

    await verbs(observeActs(client, onAct)).POST?.('/pickup-requests');

    expect(onAct).toHaveBeenCalledTimes(1);
  });
});
