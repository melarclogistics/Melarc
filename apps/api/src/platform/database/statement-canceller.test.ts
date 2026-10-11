import { EventEmitter } from 'node:events';

import type pg from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ManualClock } from '../../test-support/manual-clock.js';
import { PgStatementCanceller } from './statement-canceller.js';

class FakeClient extends EventEmitter {
  connect = vi.fn(() => Promise.resolve());
  query = vi.fn<(text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>>(() =>
    Promise.resolve({ rows: [{ signalled: true }] }),
  );
  end = vi.fn(() => Promise.resolve());
}

const SETTINGS: pg.ClientConfig = {
  host: '127.0.0.1',
  port: 5432,
  user: 'melarc_api_runtime',
  database: 'melarc_test',
  password: 'not-a-real-password',
};

let clock: ManualClock;

/** Time passing for the injected clock and the fake timers together, with the promise callbacks it triggers. */
async function pass(milliseconds: number): Promise<void> {
  // What was started has taken its turn and made its connection before time moves.
  await vi.advanceTimersByTimeAsync(0);
  clock.advance(milliseconds);
  await vi.advanceTimersByTimeAsync(milliseconds);
}

function build(client: FakeClient, timeoutMilliseconds = 500) {
  const made: pg.ClientConfig[] = [];
  const canceller = new PgStatementCanceller(SETTINGS, {
    timeoutMilliseconds,
    clock,
    makeClient: (config) => {
      made.push(config);
      return client as unknown as pg.Client;
    },
  });
  return { canceller, made };
}

/** A canceller that hands out the clients a test makes, one after another. */
function buildMany(
  timeoutMilliseconds: number,
  maxConcurrent: number,
  make: (index: number) => FakeClient,
) {
  const clients: FakeClient[] = [];
  const made: pg.ClientConfig[] = [];
  const canceller = new PgStatementCanceller(SETTINGS, {
    timeoutMilliseconds,
    maxConcurrent,
    clock,
    makeClient: (config) => {
      made.push(config);
      const client = make(clients.length);
      clients.push(client);
      return client as unknown as pg.Client;
    },
  });
  return { canceller, clients, made };
}

/** Whether a promise has settled, without waiting for it. */
function watch<T>(promise: Promise<T>): {
  readonly done: () => boolean;
  readonly result: Promise<T>;
} {
  let done = false;
  const result = promise.finally(() => {
    done = true;
  });
  result.catch(() => undefined);
  return { done: () => done, result };
}

const never = (): Promise<never> => new Promise<never>(() => undefined);

beforeEach(() => {
  vi.useFakeTimers();
  clock = new ManualClock();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PgStatementCanceller (S0.6)', () => {
  // Break caught: a cancel on the pool's own connection, which is the one that is busy; or on one the pool may be out of.
  it('cancels from a connection of its own, made from the same checked settings, and ends it', async () => {
    const client = new FakeClient();
    const { canceller, made } = build(client);

    await expect(canceller.cancel(4242)).resolves.toBe('signalled');

    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({
      ...SETTINGS,
      application_name: 'melarc-api-cancel',
      connectionTimeoutMillis: 500,
      statement_timeout: 500,
    });
    expect(client.connect).toHaveBeenCalledOnce();
    expect(client.end).toHaveBeenCalledOnce();
  });

  // Break caught: a cancel that terminates the session, or reaches another role's or database's session.
  it('cancels the running statement only (not the session), of the same role and database, never its own', async () => {
    const client = new FakeClient();
    const { canceller } = build(client);

    await canceller.cancel(4242);

    const [text, values] = client.query.mock.calls[0] ?? [];
    expect(values).toEqual([4242]);
    expect(text).toMatch(/pg_cancel_backend\(pid\)/);
    expect(text).not.toMatch(/pg_terminate_backend/);
    expect(text).toMatch(/usename = current_user/);
    expect(text).toMatch(/datname = current_database\(\)/);
    expect(text).toMatch(/pid <> pg_backend_pid\(\)/);
    expect(text).toMatch(/pid = \$1/);
  });

  it('says the backend was not found when no session of this role has that process id', async () => {
    const client = new FakeClient();
    client.query.mockResolvedValueOnce({ rows: [] });
    const { canceller } = build(client);
    await expect(canceller.cancel(4242)).resolves.toBe('not-found');
    expect(client.end).toHaveBeenCalledOnce();
  });

  it('says it failed when the server declined to signal the backend', async () => {
    const client = new FakeClient();
    client.query.mockResolvedValueOnce({ rows: [{ signalled: false }] });
    const { canceller } = build(client);
    await expect(canceller.cancel(4242)).resolves.toBe('failed');
  });

  // Break caught: a cancel path that throws, so the expiry handler that called it never reaches the rollback or the disposal.
  it('never throws: a connection that cannot be made, or a query that fails, is a failed cancel', async () => {
    const refused = new FakeClient();
    refused.connect.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    await expect(build(refused).canceller.cancel(1)).resolves.toBe('failed');
    expect(refused.end).toHaveBeenCalledOnce();

    const broken = new FakeClient();
    broken.query.mockRejectedValueOnce(new Error('connection terminated'));
    await expect(build(broken).canceller.cancel(1)).resolves.toBe('failed');
    expect(broken.end).toHaveBeenCalledOnce();

    const cannotEnd = new FakeClient();
    cannotEnd.end.mockRejectedValueOnce(new Error('already closed'));
    await expect(build(cannotEnd).canceller.cancel(1)).resolves.toBe('signalled');

    const endThrows = new FakeClient();
    endThrows.end.mockImplementationOnce(() => {
      throw new Error('end threw at once');
    });
    await expect(build(endThrows).canceller.cancel(1)).resolves.toBe('signalled');
  });

  // Break caught: a connection error on the cancel client escaping as an uncaught exception that ends the process.
  it('listens for an error on its connection', async () => {
    const client = new FakeClient();
    client.query.mockImplementationOnce(() => {
      client.emit('error', new Error('connection reset'));
      return Promise.resolve({ rows: [{ signalled: true }] });
    });
    const { canceller } = build(client);
    await expect(canceller.cancel(1)).resolves.toBe('signalled');
  });

  it.each([0, -1, 1.5, Number.NaN])('refuses to cancel process id %s', async (processId) => {
    const client = new FakeClient();
    await expect(build(client).canceller.cancel(processId)).resolves.toBe('failed');
    expect(client.connect).not.toHaveBeenCalled();
  });

  it('refuses a bound that is not a finite, positive number of milliseconds', () => {
    for (const timeoutMilliseconds of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new PgStatementCanceller(SETTINGS, { timeoutMilliseconds, clock })).toThrow(
        RangeError,
      );
    }
  });
});

/**
 * One bound for the whole cancel (correction F04B). The wait for a turn, connecting, the statement and closing the connection
 * all draw on the one `timeoutMilliseconds` the cancel was given: nothing is granted a fresh budget when the phase before it
 * ends, and when the bound is reached the caller is answered, the turn is given back and nothing the cancel started goes on to
 * act. A `signalled` outcome stays what it always was: a request that was sent, not proof that the statement stopped.
 * Time is the injected clock together with fake timers, so each assertion is about which side of the bound a phase ends.
 */
describe('PgStatementCanceller: one bound for the whole cancel (F04B)', () => {
  // Break caught: the reproduction of F04B. A cancel whose connect and close both stall waited its bound for the connect and then
  // granted the close a second full bound (an isolated probe with 60 ms took about 121 ms).
  it('answers at the bound, not after twice it, when the connect and the close both stall', async () => {
    const client = new FakeClient();
    client.connect.mockReturnValueOnce(never());
    client.end.mockReturnValueOnce(never());
    const { canceller } = build(client, 300);

    const cancel = watch(canceller.cancel(4242));
    await pass(299);
    expect(cancel.done()).toBe(false);
    await pass(1);
    expect(cancel.done()).toBe(true);
    await expect(cancel.result).resolves.toBe('failed');

    // The connection was told to close, and nothing went on waiting for it to say so.
    expect(client.end).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('answers at the bound when the statement stalls and the close does too', async () => {
    const client = new FakeClient();
    client.query.mockReturnValueOnce(never());
    client.end.mockReturnValueOnce(never());
    const { canceller } = build(client, 300);

    const cancel = watch(canceller.cancel(4242));
    await pass(299);
    expect(cancel.done()).toBe(false);
    await pass(1);

    await expect(cancel.result).resolves.toBe('failed');
    expect(client.end).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  // The request was sent and only the close stalls: the caller still learns it by the bound at the latest, and the turn goes back.
  it('answers signalled by the bound, not later, when only the close stalls, and gives its turn back', async () => {
    const { canceller, clients } = buildMany(300, 1, (index) => {
      const client = new FakeClient();
      if (index === 0) client.end.mockReturnValueOnce(never());
      return client;
    });

    const first = watch(canceller.cancel(1));
    await pass(299);
    expect(first.done()).toBe(false);
    await pass(1);
    await expect(first.result).resolves.toBe('signalled');

    // The turn is free: the next cancel connects at once.
    await expect(canceller.cancel(2)).resolves.toBe('signalled');
    expect(clients).toHaveLength(2);
  });

  // Break caught: a turn kept until the close ends, or for a second bound after the first, so the cancels in line behind a stalled
  // close are starved of the time they were asked to be served in.
  it('does not hold its turn for a close that outlives the bound', async () => {
    const { canceller, clients } = buildMany(300, 1, (index) => {
      const client = new FakeClient();
      if (index === 0) client.end.mockReturnValueOnce(never());
      return client;
    });

    const first = canceller.cancel(1);
    await pass(250);
    const second = watch(canceller.cancel(2));
    await pass(50);
    await expect(first).resolves.toBe('signalled');

    // The first gave its turn back at its bound, 250 ms into the second's: the second is served, with the time that is left.
    await pass(0);
    await expect(second.result).resolves.toBe('signalled');
    expect(clients).toHaveLength(2);
  });

  // Break caught: the wait for a turn not counted against the bound, so a cancel queued behind a stalled one gets a whole bound of
  // its own after the wait, when the request that asked for it was told long since.
  it('counts the wait for a turn against the same bound, and connects with only what is left of it', async () => {
    const { canceller, clients, made } = buildMany(500, 1, (index) => {
      const client = new FakeClient();
      if (index === 0) client.query.mockReturnValueOnce(never());
      return client;
    });

    const first = watch(canceller.cancel(1));
    await pass(200);
    const second = watch(canceller.cancel(2));
    // The first reaches its bound at 500 and gives the turn up; the second began at 200 and has 200 ms left of its own 500.
    await pass(300);
    await expect(first.result).resolves.toBe('failed');
    await pass(0);

    expect(clients).toHaveLength(2);
    const config = made[1];
    expect(config?.connectionTimeoutMillis).toBeGreaterThan(0);
    expect(config?.connectionTimeoutMillis).toBeLessThanOrEqual(200);
    expect(config?.statement_timeout).toBeGreaterThan(0);
    expect(config?.statement_timeout).toBeLessThanOrEqual(200);
    // It was served: it had a turn and time, and nothing stalled for it.
    await expect(second.result).resolves.toBe('signalled');
  });

  it('is answered at its own bound, counted from when it was asked, when it waits for a turn that is never given back', async () => {
    const { canceller, clients } = buildMany(500, 1, () => {
      const client = new FakeClient();
      client.connect.mockReturnValue(never());
      client.end.mockReturnValue(never());
      return client;
    });

    const first = watch(canceller.cancel(1));
    await pass(100);
    const second = watch(canceller.cancel(2));
    await pass(399);
    expect(second.done()).toBe(false);
    await pass(1);
    // The first's bound passed at 500: it is answered and gives the turn up. The second, asked at 100, has 100 ms left and has
    // just been given the turn: it connects with those, and is answered at 600, not at 1000.
    await expect(first.result).resolves.toBe('failed');
    await pass(0);
    expect(clients).toHaveLength(2);
    await pass(99);
    expect(second.done()).toBe(false);
    await pass(1);
    await expect(second.result).resolves.toBe('failed');
    expect(vi.getTimerCount()).toBe(0);
  });

  // Break caught: a cancel that connects late and then sends its statement, after the caller was told it failed and the process
  // id may belong to another statement or session.
  it('sends nothing on a connection that is made after the bound', async () => {
    let connected: () => void = () => undefined;
    const client = new FakeClient();
    client.connect.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        connected = resolve;
      }),
    );
    const { canceller } = build(client, 300);

    const cancel = canceller.cancel(4242);
    await pass(300);
    await expect(cancel).resolves.toBe('failed');
    connected();
    await pass(0);

    expect(client.query).not.toHaveBeenCalled();
    expect(client.end).toHaveBeenCalled();
  });

  // Break caught: a late rejection of what the cancel abandoned escaping as an unhandled rejection that ends the process.
  it('lets what it abandoned settle later, whether it resolves or rejects, without a trace', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const rejecting = new FakeClient();
      let failConnect: (error: Error) => void = () => undefined;
      rejecting.connect.mockReturnValueOnce(
        new Promise<void>((_resolve, reject) => {
          failConnect = reject;
        }),
      );
      rejecting.end.mockReturnValueOnce(
        new Promise<void>((_resolve, reject) => {
          setTimeout(() => {
            reject(new Error('close failed late'));
          }, 450);
        }),
      );
      const { canceller } = build(rejecting, 300);

      const cancel = canceller.cancel(4242);
      await pass(300);
      await expect(cancel).resolves.toBe('failed');
      failConnect(new Error('connect ETIMEDOUT'));
      await pass(300);
      // Give the runtime the turns it needs to report an unhandled rejection, if there is one.
      await vi.advanceTimersByTimeAsync(0);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  // A cancel that already passed its bound before it could make a connection does not make one.
  it('makes no connection at all when its bound has passed while it waited for a turn', async () => {
    const { canceller, clients } = buildMany(200, 1, () => {
      const client = new FakeClient();
      client.query.mockReturnValue(never());
      return client;
    });

    const first = canceller.cancel(1);
    const second = canceller.cancel(2);
    await pass(200);
    await expect(first).resolves.toBe('failed');
    await expect(second).resolves.toBe('failed');

    expect(clients).toHaveLength(1);
  });

  // Not a claim of success. A signalled cancel is a request that was sent; the statement's own failure is the proof it stopped.
  it('says signalled for a request that was sent, and offers no outcome that claims the statement stopped', async () => {
    const client = new FakeClient();
    const { canceller } = build(client);
    const outcome = await canceller.cancel(4242);
    expect(outcome).toBe('signalled');
    expect(['signalled', 'not-found', 'failed']).toContain(outcome);
  });
});

describe('PgStatementCanceller: how many connections it keeps (S0.6)', () => {
  // Break caught: a stall in the database expiring every request at once and each opening a connection to cancel, which is a
  // storm of connections against a database already in trouble.
  it('opens no more than its allowed number of cancel connections at once, and all of them end at the bound', async () => {
    const gates: (() => void)[] = [];
    const { canceller, clients } = buildMany(500, 2, () => {
      const client = new FakeClient();
      client.connect.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            gates.push(resolve);
          }),
      );
      return client;
    });

    const outcomes = [1, 2, 3].map((pid) => canceller.cancel(pid));
    await pass(499);

    // Two connect; the third waits for one of them to finish.
    expect(clients).toHaveLength(2);
    await pass(1);
    expect(await Promise.all(outcomes)).toEqual(['failed', 'failed', 'failed']);
    for (const client of clients) expect(client.end).toHaveBeenCalledOnce();
    for (const gate of gates) gate();
  });

  // Break caught: a cancel in line behind others that the others' answers serve in turn.
  it('serves a cancel that waits for its turn as soon as a connection is free', async () => {
    const { canceller, clients } = buildMany(500, 1, () => new FakeClient());

    const outcomes = await Promise.all([
      canceller.cancel(1),
      canceller.cancel(2),
      canceller.cancel(3),
    ]);

    expect(outcomes).toEqual(['signalled', 'signalled', 'signalled']);
    expect(clients).toHaveLength(3);
  });

  // Break caught: the permit for a cancel kept by one that failed, so later cancels are refused for good.
  it('frees its place when a cancel fails, so the next one connects', async () => {
    const { canceller, clients } = buildMany(500, 1, (index) => {
      const client = new FakeClient();
      if (index === 0) client.connect.mockRejectedValue(new Error('refused'));
      return client;
    });

    expect(await canceller.cancel(1)).toBe('failed');
    expect(await canceller.cancel(2)).toBe('signalled');
    expect(clients).toHaveLength(2);
  });

  // Break caught: a connection that never finishes closing keeping its place for good, so after as many as there are places every
  // later cancel fails and the statements of expired requests run on until the server's own bound.
  it('lets go of its place when ending the connection never finishes', async () => {
    const { canceller, clients } = buildMany(500, 1, (index) => {
      const client = new FakeClient();
      if (index === 0) client.end = vi.fn(() => never());
      return client;
    });

    const first = canceller.cancel(1);
    await pass(500);
    await expect(first).resolves.toBe('signalled');
    await expect(canceller.cancel(2)).resolves.toBe('signalled');
    expect(clients).toHaveLength(2);
  });
});
