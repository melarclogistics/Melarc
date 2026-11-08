import { useEffect } from 'react';
import { useLocation, useNavigate, type Location } from 'react-router';

import {
  MAX_HOLD_MS,
  useTransientSecret,
  type SecretStatus,
} from '../secrets/use-transient-secret';
import { tokenFromHash } from './grant-fragment';

export interface GrantToken {
  /**
   * `held`: `token` is there. `none`: the link carried none, or it has been used up or taken away. `expired`: it was held and the time a page
   * may hold a secret ended. A page shows the one error of a grant that cannot be used for `none` and `expired` alike.
   */
  readonly status: SecretStatus;
  /** The grant, only while it is held. */
  readonly token: string | undefined;
  /**
   * The fragment is still in the address: it has not been read and removed yet, which happens in the first effect after the page appears. A page
   * shows nothing of its own while this is true, or the first render of every good link would say the link cannot be used.
   */
  readonly reading: boolean;
  /** The grant has done its work, or been refused: it is gone at once. */
  readonly clear: () => void;
}

/** The page's own path is what the grant belongs to: the page rewriting its address (removing the fragment) is not the person leaving it. */
const pathOf = (location: Location): string => location.pathname;

/**
 * The grant of a link, read **once** from the URL fragment and kept in memory (GBT-W16; SECURITY_DESIGN section 13.9a; surfaces/ops-portal.md
 * section 7, "the three link pages"). The page that calls this is one that a message links to: `/setup/credential`, `/setup/mfa` and, when it
 * is built, `/recovery/complete`.
 *
 * - **Read once, removed at once.** On the first render that sees a fragment the token is taken from it and the fragment is removed from the
 *   address by *replacing* the history entry, whatever the fragment held, so the Back button has no address with a token in it. It is
 *   removed in the same effect that reads it, before anything else the page does.
 * - **Opening the page redeems nothing.** This only reads. Nothing is sent from here; the page sends the token when the person acts.
 * - **In memory, as a transient secret** (`useTransientSecret`): never in the query cache, a storage, the address, the history state, the
 *   title, a log, or an attribute. It is gone at completion (`clear`), after the longest a page may hold a secret, when the person goes to
 *   another page, when the session changes and when the page is hidden. A reload finds no fragment and therefore no token: "a reload after
 *   that may need the message reopened".
 * - **Development's strict mode** runs an effect, undoes it and runs it again. The fragment is read from the render's own location, which
 *   both runs share, and the transient secret drops what it holds when an effect is undone, so the second run holds the token again; the
 *   token is not kept in a ref or in state of this hook that the undo would not reach.
 *
 * It is not for the page to put the token anywhere: it is read here, passed to the request that redeems it, and cleared.
 */
export function useGrantToken(): GrantToken {
  const secret = useTransientSecret<string>({ scope: pathOf });
  const { begin, hold, clear } = secret;
  const { hash, pathname, search } = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    if (hash === '') return;
    const token = tokenFromHash(hash);
    // Whatever the fragment held, it is not left in the address; a malformed one is as much a thing to remove as a good one.
    void navigate({ pathname, search }, { replace: true });
    if (token !== undefined) hold(begin(), token, MAX_HOLD_MS);
  }, [hash, pathname, search, navigate, begin, hold]);

  return { status: secret.status, token: secret.value, reading: hash !== '', clear };
}
