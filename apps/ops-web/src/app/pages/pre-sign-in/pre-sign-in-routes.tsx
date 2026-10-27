import type { RouteObject } from 'react-router';

import { AuthSplitLayout } from './AuthSplitLayout';
import { PreSignInFlowLayout } from './PreSignInFlowLayout';
import { RecoveryCompletePage } from './RecoveryCompletePage';
import { RecoveryRequestPage } from './RecoveryRequestPage';
import { SetupCredentialPage } from './SetupCredentialPage';
import { SetupMfaCompletePage } from './SetupMfaCompletePage';
import { SetupMfaPage } from './SetupMfaPage';
import { SignInMfaPage } from './SignInMfaPage';
import { SignInPage } from './SignInPage';

/**
 * The pre-sign-in screens: the routes a person reaches with no session, which must render with none and must not ask for one. They are
 * siblings of the session guard in the route tree, inside the frame, drawn in its **split-screen** layout (`AuthSplitLayout`: imagery in
 * one half, the form in the other), and **no application shell is drawn around any of them** (surfaces/ops-portal.md section 7;
 * DESIGN_SYSTEM section 13.1). The layout route holds, in memory, what two of them hand each other.
 *
 * The two recovery screens of the same family (`/recovery`, `/recovery/complete`; S0.52a) are here too: reached with no session, in the same
 * layout, and holding nothing they hand each other.
 */
export const PRE_SIGN_IN_ROUTES: RouteObject[] = [
  {
    element: <AuthSplitLayout />,
    children: [
      {
        element: <PreSignInFlowLayout />,
        children: [
          { path: 'sign-in', element: <SignInPage /> },
          { path: 'sign-in/mfa', element: <SignInMfaPage /> },
          { path: 'setup/credential', element: <SetupCredentialPage /> },
          { path: 'setup/mfa', element: <SetupMfaPage /> },
          { path: 'setup/mfa/complete', element: <SetupMfaCompletePage /> },
          { path: 'recovery', element: <RecoveryRequestPage /> },
          { path: 'recovery/complete', element: <RecoveryCompletePage /> },
        ],
      },
    ],
  },
];
