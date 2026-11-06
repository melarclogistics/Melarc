import { createPortal } from 'react-dom';
import { Outlet, useLocation } from 'react-router';

import { SideMenu, type SideMenuAccount } from '../components/side-menu/SideMenu';
import { Alert } from '../components/ui/alert/Alert';
import { Button } from '../components/ui/button/Button';
import type { NavigationItem } from '../components/PrimaryNavigation';
import type { QueueSummaryView } from '../platform/queue-summary/queue-summary-shape';
import {
  useQueueSummary,
  useRefreshQueueSummaryOnReturn,
} from '../platform/queue-summary/use-queue-summary';
import { useSession } from '../platform/session/session-context';
import type { SessionView } from '../platform/session/session-store';
import { useSignOut } from '../platform/session/use-sign-out';
import { useFrameChrome, useFrameControls, useFrameLayout } from './frame-chrome';
import { QUEUE_WORDS } from './navigation/queue-places';
import {
  entriesFor,
  queueOfEntries,
  SIGNED_IN_ROUTES,
  type SignedInRoute,
} from './navigation/route-registry';

/** Where the person acts, in a few words for the account card: the hub's name, or how many hubs. Nothing when the session lists none. */
function hubsLine(hubs: SessionView['authorized_hubs']): string | null {
  const [only] = hubs;
  if (only === undefined) return null;
  return hubs.length === 1 ? only.display_name : `${String(hubs.length)} hubs`;
}

function accountOf(session: SessionView): SideMenuAccount {
  return { name: session.principal_display_name, detail: hubsLine(session.authorized_hubs) };
}

/**
 * The entries with the count of their queue beside them, where the summary holds one (task C1; `AC-QSUM-07`). An entry whose queue the summary
 * does not hold, and every entry while the summary is being read or when it could not be, has no count and draws none: **a count that is not
 * there is never drawn as `0`**. Which entries belong to which queue is the registry's; the words after the number are `QUEUE_WORDS`.
 */
function withCounts(
  items: readonly NavigationItem[],
  routes: readonly SignedInRoute[],
  summary: QueueSummaryView | undefined,
): NavigationItem[] {
  if (summary === undefined) return [...items];
  const queues = queueOfEntries(routes);
  return items.map((item) => {
    const queue = queues.get(item.to);
    const counted =
      queue === undefined ? undefined : summary.queues.find((each) => each.queue === queue);
    return queue === undefined || counted === undefined
      ? item
      : { ...item, badge: { count: counted.count, meaning: QUEUE_WORDS[queue].meaning } };
  });
}

/**
 * The layout of every signed-in screen (COMPONENT_PATTERNS section 12; DESIGN_SYSTEM section 13.1). It sits between the session guard and the
 * signed-in routes, so it is drawn only for a session the API has said is there and only around the routes of the registry. It does not
 * go around the frame: the frame's skip link, main landmark and move of focus to the new page's heading stay the frame's, and the
 * shell adds the one thing the frame must not have for a person who is not signed in. It asks the frame for the **sidebar** layout
 * (`useFrameLayout`) and draws its **side menu** into the frame's place beside the main content, so the menu is a landmark of its own and
 * neither inside the main content nor after it.
 *
 * The menu holds the navigation, built from the permission keys the session holds and the routes that exist, and the account card with
 * the sign-out control that every signed-in screen carries. Hiding an entry is not enforcement; the guard of each route and the server
 * check again. A sign-out that did not finish is told at the top of the page, where the person is looking.
 *
 * It also reads the **queue summary** (`getQueueSummary`, task C1) for the menu's counts, and again whenever the person goes to another page;
 * a read that fails or has not finished draws no count, and the menu works as it did.
 */
export function AuthenticatedOpsShell({
  routes = SIGNED_IN_ROUTES,
}: {
  readonly routes?: readonly SignedInRoute[];
}) {
  const slot = useFrameChrome();
  const { setMainInert } = useFrameControls();
  const state = useSession();
  const { signOut, state: outcome } = useSignOut();
  const signedIn = state.status === 'signed-in';
  useFrameLayout('sidebar', signedIn);
  const { pathname } = useLocation();
  const summary = useQueueSummary(signedIn);
  useRefreshQueueSummaryOnReturn(pathname);

  // The counts of the last read, and none when that read failed: TanStack Query keeps the last answer beside the error, and a count that
  // failed is not drawn (`AC-QSUM-07`; the review of task C1 found the old counts left on every page after a failed re-read).
  const counted = summary.isError ? undefined : summary.data;
  const items =
    state.status === 'signed-in'
      ? withCounts(entriesFor(state.session.permissions, routes), routes, counted)
      : [];

  return (
    <>
      {slot === null || state.status !== 'signed-in'
        ? null
        : createPortal(
            <SideMenu
              items={items}
              account={accountOf(state.session)}
              signingOut={outcome === 'pending'}
              onSignOut={() => {
                void signOut();
              }}
              onOpenChange={setMainInert}
            />,
            slot,
          )}
      {outcome === 'failed' ? (
        <div className="app-shell-notice">
          <Alert variant="danger" announce>
            <p>Sign-out did not finish, so you are still signed in.</p>
          </Alert>
          <p>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                void signOut();
              }}
            >
              Try again
            </Button>
          </p>
        </div>
      ) : null}
      <Outlet />
    </>
  );
}
