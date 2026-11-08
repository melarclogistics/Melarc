import { act, waitFor } from '@testing-library/react';
import { expect } from 'vitest';

import type { Handler } from './fake-api';

/**
 * A read the test answers by hand: every request the handler receives waits until the test settles it, in the order they were sent. It lets a
 * test look at the screen in the moment between a click and the answer, which a handler that answers at once never shows.
 */
export function byHand(): {
  readonly handler: Handler;
  readonly answer: (response: Response) => Promise<void>;
  readonly waiting: () => number;
} {
  const waiting: ((response: Response) => void)[] = [];
  const handler: Handler = () =>
    new Promise<Response>((resolve) => {
      waiting.push(resolve);
    });
  return {
    handler,
    waiting: () => waiting.length,
    async answer(response: Response): Promise<void> {
      await waitFor(() => {
        expect(waiting.length).toBeGreaterThan(0);
      });
      await act(async () => {
        waiting.shift()?.(response);
        await Promise.resolve();
      });
    },
  };
}
