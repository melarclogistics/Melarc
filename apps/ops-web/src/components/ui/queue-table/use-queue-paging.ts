import { useCallback, useMemo, useRef, useState } from 'react';

/** Where a person is in a paged queue, and the way to move. */
export interface QueuePaging {
  /** The token to ask the server for the page shown, or none for the first page. */
  readonly pageToken: string | undefined;
  /** The page shown, counted from 1. */
  readonly page: number;
  /** The token of each page after the first that was visited to reach the page shown: the way back to it. Position tokens, never records. */
  readonly tokens: readonly string[];
  /** Moves to the page after this one, with the token the server gave for it. */
  readonly toNextPage: (token: string) => void;
  /** Moves back one page. Nothing on the first. */
  readonly toPreviousPage: () => void;
  /** Goes back to the first page from any other, on purpose (the way out of a page that is no longer there). Nothing on the first. */
  readonly toFirstPage: () => void;
  /**
   * Whether the page now drawn is one the person moved to, and so where focus should go, once: the pager buttons are gone while the next page
   * loads, and a keyboard user would be dropped at the top of the document. Asked by the queue table when it has drawn its rows.
   */
  readonly takeFocus: () => boolean;
}

/** No page visited beyond the first. One array, so that a page with no history is the same from one render to the next. */
const FIRST_PAGE: readonly string[] = [];

/**
 * The paging of a queue whose server pages by token (`next_page_token`): the tokens of the pages visited, so that a person can go back, kept
 * **for the filter that produced them** (`signature`, any text that changes when the filter does). A token is only good for the query it came
 * from, so a change of filter starts again at the first page, and no page of one filter is ever asked for under another. Nothing is kept in the
 * address or in a storage: a page is a place in one reading of a queue that changes.
 *
 * A screen that brings a person back to a queue they left may say where to start (`from`, the tokens of the pages they had visited), once, as a
 * state starts: it is the page that is asked for again, not the rows that were on it, and it holds only for the filter it was given with. The
 * memory of the place, how long it lasts and whom it belongs to are the screen's (`queue-continuity.ts`), not this hook's.
 */
export function useQueuePaging(signature: string, from?: readonly string[]): QueuePaging {
  const [paging, setPaging] = useState<{ signature: string; tokens: readonly string[] }>(() => ({
    signature,
    tokens: from === undefined || from.length === 0 ? FIRST_PAGE : [...from],
  }));
  const focusWanted = useRef(false);
  const tokens = paging.signature === signature ? paging.tokens : FIRST_PAGE;

  const toNextPage = useCallback(
    (token: string) => {
      focusWanted.current = true;
      setPaging({ signature, tokens: [...tokens, token] });
    },
    [signature, tokens],
  );
  const toPreviousPage = useCallback(() => {
    if (tokens.length === 0) return;
    focusWanted.current = true;
    setPaging({ signature, tokens: tokens.slice(0, -1) });
  }, [signature, tokens]);
  const toFirstPage = useCallback(() => {
    if (tokens.length === 0) return;
    focusWanted.current = true;
    setPaging({ signature, tokens: FIRST_PAGE });
  }, [signature, tokens]);
  const takeFocus = useCallback(() => {
    const wanted = focusWanted.current;
    focusWanted.current = false;
    return wanted;
  }, []);

  return useMemo(
    () => ({
      pageToken: tokens.at(-1),
      page: tokens.length + 1,
      tokens,
      toNextPage,
      toPreviousPage,
      toFirstPage,
      takeFocus,
    }),
    [tokens, toNextPage, toPreviousPage, toFirstPage, takeFocus],
  );
}
