import { describe, expect, it } from 'vitest';

import { createPhotoLinkQueue } from './photo-link-queue';

/**
 * A page that draws sixty photos asks the platform for sixty retrieval authorizations (one for each tile that comes near the screen), and every request of an authenticated session counts toward its
 * limit (120 a minute), so the asking is bounded: at most `limit` at once, in the order they were asked for, and a tile that went away before its turn gives its place up.
 */
function gate() {
  let release: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { opened, release };
}

describe('the queue of the requests for a photo link', () => {
  // Break caught: sixty requests at once (the limit of the session spent by a page that was only opened).
  it('runs no more than its limit at once, and the next as soon as one finishes', async () => {
    const queue = createPhotoLinkQueue(2);
    let inFlight = 0;
    let peak = 0;
    const gates = Array.from({ length: 5 }, gate);
    const results = gates.map((one, index) =>
      queue.run(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await one.opened;
        inFlight -= 1;
        return index;
      }),
    );
    await Promise.resolve();
    expect(inFlight).toBe(2);

    gates[0]?.release();
    await results[0];
    await Promise.resolve();
    expect(inFlight).toBe(2);

    for (const one of gates) one.release();
    expect(await Promise.all(results)).toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
  });

  // Break caught: a later request that overtakes an earlier one (the tile at the top of the screen waits for the ones that came after it).
  it('runs the requests in the order they were asked for', async () => {
    const queue = createPhotoLinkQueue(1);
    const order: number[] = [];
    const gates = Array.from({ length: 4 }, gate);
    const results = gates.map((one, index) =>
      queue.run(async () => {
        order.push(index);
        await one.opened;
      }),
    );
    for (const one of gates) {
      one.release();
      await Promise.resolve();
    }
    await Promise.all(results);

    expect(order).toEqual([0, 1, 2, 3]);
  });

  // Break caught: a request that failed and kept its place for ever, so that the queue stops after `limit` failures.
  it('gives a place up when the request fails, and tells the failure to whoever asked', async () => {
    const queue = createPhotoLinkQueue(1);
    const failure = queue
      .run(() => Promise.reject(new Error('refused')))
      .catch((error: unknown) => error);
    const next = queue.run(() => Promise.resolve('then this'));

    expect(await failure).toMatchObject({ message: 'refused' });
    expect(await next).toBe('then this');
  });

  it('gives a place up when the request throws at once, before it returns a promise', async () => {
    const queue = createPhotoLinkQueue(1);
    const failure = queue
      .run(() => {
        throw new Error('at once');
      })
      .catch((error: unknown) => error);

    expect(await failure).toMatchObject({ message: 'at once' });
    expect(await queue.run(() => Promise.resolve('next'))).toBe('next');
  });

  // Break caught: a tile that has gone off the screen (or off the page) still holding a place that a tile in view waits for.
  it('lets a request that is abandoned while it waits give its place up, and never runs it', async () => {
    const queue = createPhotoLinkQueue(1);
    const first = gate();
    const running = queue.run(() => first.opened);
    let started = false;
    const controller = new AbortController();
    const abandoned = queue
      .run(() => {
        started = true;
        return Promise.resolve('no');
      }, controller.signal)
      .catch((error: unknown) => error);
    const waiting = queue.run(() => Promise.resolve('yes'));

    controller.abort();
    const reason = await abandoned;
    first.release();
    await running;

    expect(reason).toMatchObject({ name: 'AbortError' });
    // The place it gave up is the next one's: asked after the first finished, and only then is it known that the abandoned one never ran.
    expect(await waiting).toBe('yes');
    expect(started).toBe(false);
  });

  it('refuses a request that is abandoned before it is asked, and runs none of it', async () => {
    const queue = createPhotoLinkQueue(2);
    const controller = new AbortController();
    controller.abort();
    let started = false;

    const reason: unknown = await queue
      .run(() => {
        started = true;
        return Promise.resolve('no');
      }, controller.signal)
      .catch((error: unknown) => error);

    expect(reason).toMatchObject({ name: 'AbortError' });
    expect(started).toBe(false);
  });

  it('is told a limit it can run with', () => {
    expect(() => createPhotoLinkQueue(0)).toThrow(/limit/i);
    expect(() => createPhotoLinkQueue(1.5)).toThrow(/limit/i);
  });
});
