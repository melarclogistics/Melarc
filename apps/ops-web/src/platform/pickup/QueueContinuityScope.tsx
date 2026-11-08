import { useEffect, useMemo, useState } from 'react';
import { Outlet, useLocation } from 'react-router';

import { useSignedInSession } from '../session/use-permissions';
import { bindingOf, LIST_PATHS, QueueContinuity } from './queue-continuity';
import { ContinuityContext } from './queue-continuity-context';

/**
 * Where each list's one remembered place lives (COMPONENT_PATTERNS section 22f; the pickup queue and the manifest list): a layout route inside
 * the session guard, so that it exists only for a signed-in session and is gone with it. The memory is this component's own state, in the
 * application and nowhere else (not the address, not a storage), so a full reload, a new tab or a typed address starts without it. Each list has a
 * memory of its own, held here together so that one door lets go of both.
 *
 * It lets go of a place in three ways. The screens ask (`discard`) once a visit to the list has used or refused it. This scope watches where the
 * person goes and lets go once they are out of the visit to the record the place was left for (`noteLocation`). And it lets go whenever whose it
 * is changes: another session, another person, or a change in the hubs the session acts in (`bindingOf`), including a session that ends and a
 * person who signs in again as the same one.
 */
export function QueueContinuityScope() {
  const me = useSignedInSession();
  const [stores] = useState(() => ({
    pickup: new QueueContinuity(LIST_PATHS.pickup),
    manifests: new QueueContinuity(LIST_PATHS.manifests),
  }));
  const { pathname } = useLocation();
  const binding = me === undefined ? undefined : bindingOf(me.session);

  useEffect(() => {
    for (const store of Object.values(stores)) store.noteLocation(pathname);
  }, [stores, pathname]);

  // The cleanup runs when the binding changes, and when the scope goes: whatever was left under the earlier binding is not for the next.
  useEffect(
    () => () => {
      for (const store of Object.values(stores)) store.discard();
    },
    [stores, binding],
  );

  const scope = useMemo(
    () => (binding === undefined ? null : { stores, binding }),
    [stores, binding],
  );

  return (
    <ContinuityContext value={scope}>
      <Outlet />
    </ContinuityContext>
  );
}
