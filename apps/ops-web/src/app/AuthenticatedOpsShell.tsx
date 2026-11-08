import { createPortal } from 'react-dom';
import { Outlet } from 'react-router';

import { SideMenu, type SideMenuAccount } from '../components/side-menu/SideMenu';
import { Alert } from '../components/ui/alert/Alert';
import { Button } from '../components/ui/button/Button';
import { useSession } from '../platform/session/session-context';
import type { SessionView } from '../platform/session/session-store';
import { useSignOut } from '../platform/session/use-sign-out';
import { useFrameChrome, useFrameControls, useFrameLayout } from './frame-chrome';
import { entriesFor, SIGNED_IN_ROUTES, type SignedInRoute } from './navigation/route-registry';

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

  const items = state.status === 'signed-in' ? entriesFor(state.session.permissions, routes) : [];

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
