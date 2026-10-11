import { describe, expect, it } from 'vitest';

import { Opened, closeEach } from './cleanup.js';

/**
 * Closing what a test kit opened (correction F06). A kit opens several things in turn, and any of them can fail to open or to close:
 * whatever was opened is closed, every close is attempted whatever the others do, the failure of one is not lost behind another's,
 * and closing twice does nothing the second time.
 */
describe('closeEach', () => {
  // Break caught: a close that stops at the first failure, which leaves the connections after it open.
  it('attempts every step, in order, even when an earlier one fails', async () => {
    const attempted: string[] = [];

    const outcome = await closeEach([
      {
        name: 'one',
        close: () => {
          attempted.push('one');
          return Promise.reject(new Error('one failed'));
        },
      },
      {
        name: 'two',
        close: () => {
          attempted.push('two');
          return Promise.resolve();
        },
      },
      {
        name: 'three',
        close: () => {
          attempted.push('three');
          return Promise.resolve();
        },
      },
    ]).catch((error: unknown) => error);

    expect(attempted).toEqual(['one', 'two', 'three']);
    expect(outcome).toBeInstanceOf(Error);
  });

  // Break caught: a step that throws before it returns a promise ending the run.
  it('attempts the steps after one that throws at once', async () => {
    const attempted: string[] = [];

    await closeEach([
      {
        name: 'throws',
        close: () => {
          throw new Error('threw at once');
        },
      },
      {
        name: 'after',
        close: () => {
          attempted.push('after');
        },
      },
    ]).catch(() => undefined);

    expect(attempted).toEqual(['after']);
  });

  // Break caught: the failure replaced by a generic one, or by the last of several, so the cause of a leak is not what is reported.
  it('reports the one failure as itself, with its class and message', async () => {
    class OddFailure extends Error {}
    const failure = new OddFailure('the connection would not end');

    const outcome = await closeEach([
      { name: 'good', close: () => Promise.resolve() },
      { name: 'bad', close: () => Promise.reject(failure) },
    ]).catch((error: unknown) => error);

    expect(outcome).toBe(failure);
  });

  it('reports several failures together, in order, naming the steps', async () => {
    const first = new Error('first');
    const second = new TypeError('second');

    const outcome = (await closeEach([
      { name: 'application', close: () => Promise.reject(first) },
      { name: 'good', close: () => Promise.resolve() },
      { name: 'admin', close: () => Promise.reject(second) },
    ]).catch((error: unknown) => error)) as AggregateError;

    expect(outcome).toBeInstanceOf(AggregateError);
    expect(outcome.errors).toEqual([first, second]);
    expect(outcome.message).toContain('application');
    expect(outcome.message).toContain('admin');
    expect(outcome.message).not.toContain('good');
  });

  it('resolves when every step does, and when there are none', async () => {
    await expect(closeEach([])).resolves.toBeUndefined();
    await expect(
      closeEach([{ name: 'good', close: () => Promise.resolve() }]),
    ).resolves.toBeUndefined();
  });
});

describe('Opened', () => {
  // Break caught: a resource closed before the ones that were opened on top of it (the application before the connections that read
  // what it did, or the other way round).
  it('closes what was opened last first', async () => {
    const order: string[] = [];
    const opened = new Opened();
    opened.add('application', 'app', (value) => {
      order.push(value);
      return Promise.resolve();
    });
    opened.add('admin', 'admin', (value) => {
      order.push(value);
      return Promise.resolve();
    });
    opened.add('observer', 'observer', (value) => {
      order.push(value);
      return Promise.resolve();
    });

    await opened.close();

    expect(order).toEqual(['observer', 'admin', 'app']);
  });

  it('hands back the resource it was given, so that opening and recording are one step', () => {
    const opened = new Opened();
    const resource = { name: 'resource' };
    expect(opened.add('resource', resource, () => Promise.resolve())).toBe(resource);
  });

  // Break caught: a second stop that closes again (an error from a connection that is already closed), or that runs again while
  // the first is still closing.
  it('closes once: a second call, whether while the first is closing or after it, does nothing', async () => {
    let closed = 0;
    let finish: () => void = () => undefined;
    const opened = new Opened();
    opened.add(
      'slow',
      undefined,
      () =>
        new Promise<void>((resolve) => {
          closed += 1;
          finish = resolve;
        }),
    );

    const first = opened.close();
    const during = opened.close();
    finish();
    await Promise.all([first, during]);
    await opened.close();

    expect(closed).toBe(1);
  });

  // Break caught: a failed close reported again to a later caller, so a cleanup chain (`stop()`, then drop the database) stops at
  // the second call and leaves the database behind.
  it('reports a failure to the call that closed, and not again to a later one', async () => {
    const opened = new Opened();
    opened.add('bad', undefined, () => Promise.reject(new Error('would not close')));

    await expect(opened.close()).rejects.toThrow('would not close');
    await expect(opened.close()).resolves.toBeUndefined();
  });

  // Break caught: a call made while the first is closing getting a different answer from the first.
  it('gives a call made while the first is closing the same answer', async () => {
    let fail: (error: Error) => void = () => undefined;
    const opened = new Opened();
    opened.add(
      'bad',
      undefined,
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        }),
    );

    const first = opened.close().catch((error: unknown) => error);
    const during = opened.close().catch((error: unknown) => error);
    const failure = new Error('would not close');
    fail(failure);

    expect(await first).toBe(failure);
    expect(await during).toBe(failure);
  });

  it('closes nothing when nothing was opened', async () => {
    await expect(new Opened().close()).resolves.toBeUndefined();
  });
});
