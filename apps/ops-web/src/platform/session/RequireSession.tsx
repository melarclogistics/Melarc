import { Navigate, Outlet } from 'react-router';

import { PageHeading } from '../../components/PageHeading';
import { Alert } from '../../components/ui/alert/Alert';
import { Button } from '../../components/ui/button/Button';
import { LoadingIndicator } from '../../components/ui/loading/LoadingIndicator';
import { SIGN_IN_PATH } from './paths';
import { useEnsureSession } from './use-ensure-session';

/**
 * The layout of every signed-in route. Nobody is shown a signed-in page until the API has said who is signed in:
 * while that is being read, a loading indicator; if nobody is, the sign-in screen, replacing this entry in the history
 * so the back button does not return to a page that cannot be shown; if the answer did not come, an error with an
 * explicit retry, and the person is not signed out for a connection that dropped.
 */
export function RequireSession() {
  const { state, retry } = useEnsureSession();

  switch (state.status) {
    case 'signed-in':
      return <Outlet />;
    case 'signed-out':
      return <Navigate to={SIGN_IN_PATH} replace />;
    case 'unavailable':
      return <SessionUnavailable onRetry={retry} />;
    case 'loading':
      return <LoadingIndicator label="Checking your session…" />;
  }
}

function SessionUnavailable({ onRetry }: { readonly onRetry: () => void }) {
  return (
    <>
      <title>Session not checked · Melarc Ops Portal</title>
      <PageHeading>We could not check your session</PageHeading>
      <Alert variant="danger" announce>
        <p>
          The page could not find out whether you are signed in. Check your connection and try
          again.
        </p>
      </Alert>
      <p>
        <Button type="button" onClick={onRetry}>
          Try again
        </Button>
      </p>
    </>
  );
}
