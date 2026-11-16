import { useCallback, useRef, useState, type RefCallback } from 'react';

/**
 * Whether an element is near the screen, for the one thing that needs to know: a picture that is not asked for until its tile is about to be seen. **Once near, always near** (the observer is dropped the
 * moment it says so): a picture that has been asked for is not asked for again when its tile scrolls away and back. A browser with no `IntersectionObserver` takes every element as near, so nothing waits for
 * a signal that cannot come. `margin` is how far outside the screen counts as near (a CSS length of pixels), so that a tile just below the screen is ready when it arrives.
 */
export function useNearViewport<Node extends Element>(
  margin = '200px',
): readonly [RefCallback<Node>, boolean] {
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined');
  const observer = useRef<IntersectionObserver | null>(null);
  const attach = useCallback<RefCallback<Node>>(
    (node) => {
      observer.current?.disconnect();
      observer.current = null;
      if (node === null || typeof IntersectionObserver === 'undefined') return;
      const watching = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            setNear(true);
            watching.disconnect();
          }
        },
        { rootMargin: margin },
      );
      watching.observe(node);
      observer.current = watching;
    },
    [margin],
  );
  return [attach, near];
}
