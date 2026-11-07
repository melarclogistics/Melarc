import { Fragment } from 'react';
import { Outlet } from 'react-router';

import { Alert } from '../components/ui/alert/Alert';
import { Button } from '../components/ui/button/Button';
import { Toaster } from '../components/ui/toast/Toast';
import { useSession } from '../platform/session/session-context';
import { useSignOut } from '../platform/session/use-sign-out';
import { useFrameLayout } from './frame-chrome';
import { SIGNED_IN_ROUTES, type SignedInRoute } from './navigation/route-registry';
import { ShellChrome } from './shell/ShellChrome';

/**
 * The layout of every signed-in screen (COMPONENT_PATTERNS section 12; DESIGN_SYSTEM section 13.1). It sits between the session guard and the
 * signed-in routes, so it is drawn only for a session the API has said is there and only around the routes of the registry. It does not go around
 * the frame: the frame's skip link, main landmark and move of focus to the new page's heading stay the frame's, and the shell adds the one thing the
 * frame must not have for a person who is not signed in. It asks the frame for the **sidebar** layout (`useFrameLayout`) and draws into the frame's
 * own places: the sidebar beside the main content and the top bar over it (`ShellChrome`), so each is a landmark of its own and neither inside the
 * main content nor after it.
 *
 * The sidebar holds the navigation, built from the permission keys the session holds and the routes that exist, with the counts of the queues; the
 * top bar the hub switcher, the search, the New menu and the account menu, which holds the sign-out that every signed-in screen carries. Hiding an
 * entry is not enforcement; the guard of each route and the server check again. A sign-out that did not finish is told at the top of the page, where
 * the person is looking.
 *
 * It draws **the one toaster of the application** (`Toaster`, bottom right): a toast that a screen raises (`showToast`) is shown here, once, and a screen never
 * mounts a toaster of its own. The showcase's pages are outside the shell and mount their own; a second toaster mounted anywhere draws nothing, so a toast is
 * never shown twice.
 *
 * It does not hold the **choice of hub** (`HubChoiceScope`, in `AppProviders`, above the router and inside the session): the choice must survive a
 * visit to a page that is outside the shell, an address that matches no route or the page of a route that failed. It is keyed by the session, so
 * that a new session starts the shell anew.
 */
export function AuthenticatedOpsShell({
  routes = SIGNED_IN_ROUTES,
}: {
  readonly routes?: readonly SignedInRoute[];
}) {
  const state = useSession();
  const { signOut, state: outcome } = useSignOut();
  const signedIn = state.status === 'signed-in';
  useFrameLayout('sidebar', signedIn);

  const page = (
    <>
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
  if (state.status !== 'signed-in') return page;

  return (
    <Fragment key={state.session.id}>
      <ShellChrome
        session={state.session}
        routes={routes}
        signOut={() => {
          void signOut();
        }}
        signingOut={outcome === 'pending'}
        signOutFailed={outcome === 'failed'}
      />
      {page}
      <Toaster />
    </Fragment>
  );
}
