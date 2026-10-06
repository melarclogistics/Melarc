import { describe, expect, it } from 'vitest';

import { failWithCleanup } from './cleanup.ts';

describe('failWithCleanup', () => {
  // Break caught: the cleanup after a failure replacing the failure. The first thing that went wrong is what
  // the person reads, and it is rethrown as it was.
  it('rethrows the original failure itself when the cleanup works', async () => {
    const original = new Error('the api exited before it was ready');
    let cleaned = false;

    const error = await failWithCleanup(original, () => {
      cleaned = true;
      return Promise.resolve();
    }).catch((e: unknown) => e);

    expect(error).toBe(original);
    expect(cleaned).toBe(true);
  });

  // Break caught: a cleanup that cannot finish being swallowed. A process left running is something the next run
  // trips over, so it is reported next to the failure it followed, and the original stays the cause.
  it('reports both, with the original as the cause, when the cleanup fails too', async () => {
    const original = new Error('the api exited before it was ready');
    const cleanup = new Error('api (pid 4242) did not end');

    const error = await failWithCleanup(original, () => Promise.reject(cleanup)).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('the api exited before it was ready');
    expect((error as Error).message).toContain('api (pid 4242) did not end');
    expect((error as Error).cause).toBe(original);
  });

  it('reads a failure that is not an Error as text', async () => {
    const error = await failWithCleanup('plain text', () =>
      Promise.reject(new Error('stuck')),
    ).catch((e: unknown) => e);

    expect((error as Error).message).toContain('plain text');
    expect((error as Error).message).toContain('stuck');
  });
});
