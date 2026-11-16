import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

import { holdOf } from './read-hold';

/**
 * Reads a page's data again **when the page becomes visible**: the tab was brought back, the tablet was picked up. What a page of work in progress shows is as old as the moment it was put down, and the
 * person who returns to it expects what is true now (the stop's photos arrive while the officer is elsewhere). It is made for the one kind of page that needs it and is not a general rule: the portal reads
 * nothing again on a focus, a reconnection or a timer (`createQueryClient`, `AC-QSUM-09`), and this adds none of those; only the return of a page that was hidden.
 *
 * **It is an automatic read** (the person did not ask for it by pressing a control), so it asks the hold first (`read-hold.ts`): when the API has asked the page to wait (a `429`) the read is sent once when
 * the wait ends and not before, and what waits is dropped with the page. A read the person asks for (a *Refresh* control) is never held and is the page's own.
 *
 * `key` names this trigger in the hold, so that one that fires again while it waits is one read at the end. `read` is called as it is when the page becomes visible, the latest one the page gave. Nothing is
 * listened for while `enabled` is false (a page that has no right to the read).
 */
export function useRefreshWhenVisible(key: string, read: () => void, enabled = true): void {
  const hold = holdOf(useQueryClient());
  const latest = useRef(read);
  useEffect(() => {
    latest.current = read;
  });
  useEffect(() => {
    if (!enabled) return;
    const onChange = () => {
      if (document.visibilityState !== 'visible') return;
      hold.whenFree(key, () => {
        latest.current();
      });
    };
    document.addEventListener('visibilitychange', onChange);
    return () => {
      document.removeEventListener('visibilitychange', onChange);
      hold.forget(key);
    };
  }, [enabled, hold, key]);
}
