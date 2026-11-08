import { Navigate, useLocation } from 'react-router';

import { FormPage } from '../../../components/FormPage';
import { PageHeading } from '../../../components/PageHeading';
import { Link } from '../../../components/ui/link/Link';
import { SIGN_IN_PATH } from '../../../platform/session/paths';
import { justEnrolled } from './pre-sign-in-flow';

/**
 * `/setup/mfa/complete` (no operation: it renders the result of the one before). It says plainly that **the next step is ordinary sign-in**. No
 * session is issued here and nothing on it is signed in, in the neutral frame like the other setup pages (ops-portal.md section 7).
 *
 * A visit that did not follow a proven code (a typed address, a link someone sent) has nothing to confirm, and goes to the sign-in, which is the
 * next step for everyone.
 */
export function SetupMfaCompletePage() {
  // The router types the history state as `any`; it is judged as the unknown value it is.
  const state: unknown = useLocation().state;
  if (!justEnrolled(state)) return <Navigate to={SIGN_IN_PATH} replace />;

  return (
    <>
      <title>Authenticator set up · Melarc Ops Portal</title>
      <PageHeading>Your authenticator is set up</PageHeading>
      <FormPage>
        <p>
          The next step is to sign in with your email, your password and a code from your
          authenticator.
        </p>
        <p>You are not signed in yet.</p>
        <p>
          <Link to={SIGN_IN_PATH}>Go to sign-in</Link>
        </p>
      </FormPage>
    </>
  );
}
