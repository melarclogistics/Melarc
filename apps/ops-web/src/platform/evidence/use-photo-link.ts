import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { useApiClient } from '../api/api-client';
import { createRetrievalAuthorization } from '../pickup-work/pickup-work-commands';
import { holdOf } from '../query/read-hold';
import { photoLinkQueue } from './photo-link-queue';
import { watchPolicy, type PolicyWatch } from './policy-violation';

/**
 * A link with this little time left is as good as run out: the picture is asked for after it, and by then the store would refuse it. It is judged when the link arrives, so a link that comes with seconds to
 * live is replaced before the picture is asked for, and never while an officer is looking at a photo that has long since loaded.
 */
export const NEARLY_OVER_MS = 15_000;

/**
 * How long a link is shared: the tile of a grid and the viewer that opens on the same photo draw from one link while it is this fresh, so that one photo costs one request of the session. A link lives five
 * minutes; this leaves it more than the margin above, and a link older than this is asked for again by whoever draws the photo next.
 */
const LINK_FRESH_MS = 3 * 60_000;

/** What the picture of a photo can be drawn from, in one of six states. No address is held beyond the photo: the query that gave it is dropped with the last thing that drew the photo. */
export type PhotoLink =
  /** Not asked for: nothing wants the photo yet (a tile that is not near the screen). */
  | { readonly status: 'idle' }
  /** A link is being asked for, or replaced, or has not been judged yet: nothing is drawn. */
  | { readonly status: 'loading' }
  /** Draw the picture from this address, and tell `onImageError` when it will not load. */
  | { readonly status: 'ready'; readonly url: string }
  /** The browser's own policy stopped the picture: a new link can never get past a policy, and none is asked for. */
  | { readonly status: 'blocked' }
  /** The picture would not load even with a new link: the photo store did not answer, or the connection is down. */
  | { readonly status: 'unreachable' }
  /** The platform would not give a link (the read's own failure, in its own words); `error` is what `problemOf` words. */
  | { readonly status: 'failed'; readonly error: unknown };

export interface PhotoLinkView {
  readonly link: PhotoLink;
  /** The `<img>` says its picture would not load: a new link is asked for, once, unless the browser blocked the picture. */
  readonly onImageError: () => void;
  /**
   * The person asked to try again after the platform could not give a link (`failed`): the link is asked for again, as often as they say so. It is **not** the one renewal of a picture that would not load, which
   * is the hook's own and is spent once, and it is never called by the hook: a read that failed is not asked again by itself.
   */
  readonly retry: () => Promise<unknown>;
}

/** What was concluded of one link: judged when it arrived, and never again by the clock. */
interface Verdict {
  readonly url: string;
  readonly nearlyOver: boolean;
  readonly failure?: 'blocked' | 'unreachable';
}

/**
 * The link to the picture of one stored photo (`createEvidenceRetrievalAuthorization`, five minutes), for whatever draws it: **asked for only while `enabled`** (a tile that is near the screen), through a
 * bounded queue (`photo-link-queue.ts`: a page of sixty photos does not spend the session's limit), **shared** by everything that draws the same photo while it is fresh, **renewed once** when the picture
 * would not load or when the link arrives with seconds left, and **told as blocked** when the browser's own policy stopped the picture (a `securitypolicyviolation` of the image directive for this address,
 * watched from the moment the address is known). The one renewal belongs to whoever draws the photo, so a second failure is told and no third link is asked for. The link is a bearer capability: it is held by
 * this query only, never drawn as text, logged or kept after the photo is.
 */
export function usePhotoLink(
  evidenceId: string,
  enabled: boolean,
  automatic = false,
): PhotoLinkView {
  const client = useApiClient();
  const hold = holdOf(useQueryClient());
  const query = useQuery({
    queryKey: ['evidence', 'photo-link', evidenceId],
    enabled,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    gcTime: 0,
    staleTime: LINK_FRESH_MS,
    queryFn: async ({ signal }) => {
      // A tile that came near the screen is **automatic** work: while the API has asked the page to wait it waits too, and goes on when the wait is over (it is not retried). The photo the person opened is theirs, and is never held.
      for (;;) {
        if (automatic) await hold.untilFree(`photo-link:${evidenceId}`, signal);
        const authorization = await photoLinkQueue.run(async () => {
          // **The hold is judged again when its turn comes**, not only before it joined the queue: a page that draws a hundred tiles puts them all in the queue at once, and a refusal that arrives for the first
          // of them must stop the ninety-six that have not been sent, not let them run one after another into the limit it has just told. A tile whose turn comes in a hold gives its place up at once (the places
          // stay free for the photo a person opens) and waits for the end of it outside the queue.
          if (automatic && hold.held) return undefined;
          return createRetrievalAuthorization(client, evidenceId);
        }, signal);
        if (authorization !== undefined) return authorization;
      }
    },
  });
  const { data, refetch } = query;
  const url = data?.url;
  const expiresAt = data?.expires_at;
  // One renewal for this drawing of the photo. A ref beside the state: the development server runs an effect twice, and a second call must not ask again.
  const spent = useRef(false);
  const [verdict, setVerdict] = useState<Verdict | undefined>(undefined);
  const policy = useRef<PolicyWatch | undefined>(undefined);

  const renew = useCallback(() => {
    if (spent.current) return;
    spent.current = true;
    void refetch();
  }, [refetch]);

  // A link is judged once, when it arrives: a link that comes with seconds left is replaced before any picture is asked for.
  useEffect(() => {
    if (url === undefined || expiresAt === undefined) return;
    const nearlyOver = !spent.current && Date.parse(expiresAt) - Date.now() <= NEARLY_OVER_MS;
    setVerdict({ url, nearlyOver });
    if (nearlyOver) renew();
  }, [url, expiresAt, renew]);

  // The browser says that it blocked a picture as an event of the window, which a picture that fails says nothing of: listened for from the moment the picture is asked for (a layout effect runs before the
  // browser has had the chance to report it).
  useLayoutEffect(() => {
    if (url === undefined) return;
    const watching = watchPolicy('img-src', url);
    policy.current = watching;
    return () => {
      watching.stop();
      if (policy.current === watching) policy.current = undefined;
    };
  }, [url]);

  const onImageError = useCallback(() => {
    if (policy.current?.blocked() === true) {
      setVerdict((current) =>
        current === undefined ? current : { ...current, failure: 'blocked' },
      );
      return;
    }
    if (!spent.current) {
      renew();
      return;
    }
    setVerdict((current) =>
      current === undefined ? current : { ...current, failure: 'unreachable' },
    );
  }, [renew]);

  let link: PhotoLink;
  if (query.isError) link = { status: 'failed', error: query.error };
  else if (url === undefined) link = enabled ? { status: 'loading' } : { status: 'idle' };
  else if (query.isFetching || verdict?.url !== url || verdict.nearlyOver) {
    link = { status: 'loading' };
  } else if (verdict.failure !== undefined) link = { status: verdict.failure };
  else link = { status: 'ready', url };
  return { link, onImageError, retry: refetch };
}
