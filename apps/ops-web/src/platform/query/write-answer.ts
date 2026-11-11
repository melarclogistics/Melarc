import type { QueryClient, QueryKey } from '@tanstack/react-query';

/**
 * Writes the answer of an act into the read it answers for (a request, a run, a custody handover), **after letting go of any read of that key that is already on its way**.
 * A read sent before the act is answered after it with the record as it was before, and written over the answer: the version of the page goes back to the one before the act, and the next act
 * is refused with 412 (the Product Owner's review of 198e5be, run 7, Stage 2.2). A cancelled read goes back to what it was before it began, and its late answer is dropped. Every place that
 * writes an act's answer into the cache does it through this and is given the answer back, and none calls `setQueryData` for that on its own (`test/answer-written-through-one-door.test.ts`).
 */
export async function writeAnswer<Data>(
  queryClient: QueryClient,
  queryKey: QueryKey,
  answer: Data,
): Promise<Data> {
  await queryClient.cancelQueries({ queryKey, exact: true });
  queryClient.setQueryData<Data>(queryKey, answer);
  return answer;
}
