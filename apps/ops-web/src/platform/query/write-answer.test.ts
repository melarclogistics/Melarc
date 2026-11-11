import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import { writeAnswer } from './write-answer';

const KEY = ['requests', 'request', 'one'] as const;

describe('writeAnswer', () => {
  // Break caught (run 7, Stage 2.2): the answer written while a read of the same key was already on its way, so that the read, sent before the act and answered after it, put the version
  // before the act back.
  it('keeps the answer when a read that was already on its way is answered after it', async () => {
    const queryClient = new QueryClient();
    let answerTheRead: (data: string) => void = () => undefined;
    const read = queryClient.query({
      queryKey: KEY,
      queryFn: () =>
        new Promise<string>((resolve) => {
          answerTheRead = resolve;
        }),
    });
    const settled = read.catch(() => undefined);

    await writeAnswer(queryClient, KEY, 'after the act');
    answerTheRead('before the act');
    await settled;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(queryClient.getQueryData(KEY)).toBe('after the act');
    expect(queryClient.getQueryState(KEY)?.fetchStatus).toBe('idle');
  });

  it('writes the answer when nothing is being read', async () => {
    const queryClient = new QueryClient();

    await writeAnswer(queryClient, KEY, 'the answer');

    expect(queryClient.getQueryData(KEY)).toBe('the answer');
  });

  // Break caught: a cancellation that reaches the reads of other keys.
  it('leaves a read of another key alone', async () => {
    const queryClient = new QueryClient();
    let answerTheOther: (data: string) => void = () => undefined;
    const other = queryClient.query({
      queryKey: ['requests', 'request', 'two'],
      queryFn: () =>
        new Promise<string>((resolve) => {
          answerTheOther = resolve;
        }),
    });

    await writeAnswer(queryClient, KEY, 'the answer');
    answerTheOther('the other');

    await expect(other).resolves.toBe('the other');
  });
});
