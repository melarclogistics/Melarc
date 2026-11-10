import { Outlet } from 'react-router';

import type { EnrolmentMaterial, MfaChallengeView } from '../../../platform/auth/pre-sign-in-shape';
import { useTransientSecret } from '../../../platform/secrets/use-transient-secret';
import { familyOf, PreSignInFlowContext } from './pre-sign-in-flow';

/**
 * The layout route of the five pre-sign-in screens, inside the neutral frame and outside the session guard. It draws nothing of its own: it
 * keeps, in memory, what two of the screens hand each other (`PreSignInFlow`), so that the hand-over crosses a change of route without the
 * address, the history state or a storage carrying it. What it holds is let go of when the person leaves the family of addresses it belongs
 * to, when the page is hidden, when the session changes, and when the time a page may hold a secret is up (`useTransientSecret`). **Both are let go of the moment the router leaves their family**
 * (`releaseWhenRouterMoves`, the review of f6cf02b), before the page it leads to is drawn: the material of an authenticator is a bearer secret that a slow page, and a Back, would otherwise
 * show again. A page that holds one draws nothing and redirects nowhere while it is on its way out (`moved`).
 */
export function PreSignInFlowLayout() {
  const challenge = useTransientSecret<MfaChallengeView>({
    scope: familyOf,
    releaseWhenRouterMoves: true,
  });
  const enrolment = useTransientSecret<EnrolmentMaterial>({
    scope: familyOf,
    releaseWhenRouterMoves: true,
  });
  return (
    <PreSignInFlowContext value={{ challenge, enrolment }}>
      <Outlet />
    </PreSignInFlowContext>
  );
}
