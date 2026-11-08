import { describe, expect, it } from 'vitest';

import { closeAll } from './teardown.js';

describe('closing what a hook opened', () => {
  // Break caught: a teardown that stops at the first failing step, which leaves the later ones (the database among them) behind.
  it('runs every step in order even when one fails, and reports the first failure after the last', async () => {
    const ran: string[] = [];
    await expect(
      closeAll([
        () => {
          ran.push('a');
          return Promise.resolve();
        },
        () => {
          ran.push('b');
          return Promise.reject(new Error('the pool would not end'));
        },
        () => {
          ran.push('c');
          return Promise.reject(new Error('a second failure'));
        },
        () => {
          ran.push('d');
          return Promise.resolve();
        },
      ]),
    ).rejects.toThrow('the pool would not end');
    expect(ran).toEqual(['a', 'b', 'c', 'd']);
  });

  // Break caught: a step for something a failed hook never opened (an undefined pool) taken for a failure of the teardown.
  it('lets a step stand for something that was never opened', async () => {
    const opened: { close?: () => Promise<void> } = {};
    await expect(closeAll([() => opened.close?.()])).resolves.toBeUndefined();
  });

  it('reports a thrown value that is not an error as one', async () => {
    await expect(closeAll([() => Promise.reject(new Error('plain'))])).rejects.toBeInstanceOf(
      Error,
    );
    await expect(
      closeAll([
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the value under test is not an Error
        () => Promise.reject('a string'),
      ]),
    ).rejects.toThrow('a string');
  });
});
