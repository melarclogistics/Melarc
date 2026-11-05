import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useQueuePaging } from './use-queue-paging';

/**
 * The paging of a queue that pages by token: the tokens of the pages visited, for the filter that produced them. The tests of the pages that
 * move through it are in QueueTable.test.tsx; these are the two things a screen that brings a person back to a queue needs of it: to start
 * where the person was, and to send them to the first page on purpose.
 */
describe('useQueuePaging: the tokens of the pages visited', () => {
  it('starts at the first page with no token, and counts the pages the person moves through', () => {
    const { result } = renderHook(() => useQueuePaging('PENDING|'));

    expect(result.current.page).toBe(1);
    expect(result.current.pageToken).toBeUndefined();
    expect(result.current.tokens).toEqual([]);

    act(() => {
      result.current.toNextPage('token-two');
    });
    act(() => {
      result.current.toNextPage('token-three');
    });

    expect(result.current.page).toBe(3);
    expect(result.current.pageToken).toBe('token-three');
    expect(result.current.tokens).toEqual(['token-two', 'token-three']);
  });
});

describe('useQueuePaging: starting where the person was', () => {
  // Break caught: the pages given to start from ignored, so a person brought back to a queue is brought back to its first page.
  it('starts on the page the given tokens lead to, and goes back through them', () => {
    const { result } = renderHook(() => useQueuePaging('PENDING|', ['token-two', 'token-three']));

    expect(result.current.page).toBe(3);
    expect(result.current.pageToken).toBe('token-three');

    act(() => {
      result.current.toPreviousPage();
    });

    expect(result.current.page).toBe(2);
    expect(result.current.pageToken).toBe('token-two');
  });

  it('does not ask for focus on a page it started on: the screen that restored it places focus itself', () => {
    const { result } = renderHook(() => useQueuePaging('PENDING|', ['token-two']));

    expect(result.current.takeFocus()).toBe(false);
  });

  // Break caught: the start kept past a change of filter, which would ask a server for a page of one filter under another.
  it('starts again at the first page when the filter changes, whatever it was given to start from', () => {
    const { result, rerender } = renderHook(
      ({ signature }) => useQueuePaging(signature, ['token-two', 'token-three']),
      { initialProps: { signature: 'PENDING|' } },
    );
    expect(result.current.page).toBe(3);

    rerender({ signature: 'APPROVED|' });

    expect(result.current.page).toBe(1);
    expect(result.current.pageToken).toBeUndefined();
    expect(result.current.tokens).toEqual([]);
  });

  it('takes its start once: a different start on a later render does not move the person', () => {
    const { result, rerender } = renderHook(({ from }) => useQueuePaging('PENDING|', from), {
      initialProps: { from: ['token-two'] },
    });

    rerender({ from: ['token-two', 'token-three', 'token-four'] });

    expect(result.current.page).toBe(2);
  });
});

describe('useQueuePaging: to the first page, on purpose', () => {
  // Break caught: a way to the first page that leaves the tokens, or one that does not ask for focus, which would drop a keyboard user at the top.
  it('goes to the first page from any page and asks for focus once', () => {
    const { result } = renderHook(() => useQueuePaging('PENDING|', ['token-two', 'token-three']));

    act(() => {
      result.current.toFirstPage();
    });

    expect(result.current.page).toBe(1);
    expect(result.current.pageToken).toBeUndefined();
    expect(result.current.tokens).toEqual([]);
    expect(result.current.takeFocus()).toBe(true);
    expect(result.current.takeFocus()).toBe(false);
  });

  it('does nothing on the first page, where there is nowhere to go and no focus to move', () => {
    const { result } = renderHook(() => useQueuePaging('PENDING|'));

    act(() => {
      result.current.toFirstPage();
    });

    expect(result.current.page).toBe(1);
    expect(result.current.takeFocus()).toBe(false);
  });
});
