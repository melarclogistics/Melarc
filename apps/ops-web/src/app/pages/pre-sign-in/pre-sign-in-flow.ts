import { createContext, useContext } from 'react';
import type { Location } from 'react-router';

import type { EnrolmentMaterial, MfaChallengeView } from '../../../platform/auth/pre-sign-in-shape';
import type { TransientSecret } from '../../../platform/secrets/use-transient-secret';

/**
 * What the pre-sign-in screens hand each other, and where it is kept: in the memory of the layout they all sit in, as transient secrets, and
 * nowhere else. Two things cross from one route to the next. The challenge of a privileged sign-in goes from `/sign-in` to `/sign-in/mfa`:
 * it stands for a password that was proved, so it is not put in the address, the history state or a storage. The material of an
 * authenticator and the grant that proves its code go from `/setup/credential` to `/setup/mfa` on the same terms.
 */
export interface PreSignInFlow {
  /** The challenge a privileged sign-in was answered with. It grants nothing, and with a code it completes a sign-in. */
  readonly challenge: TransientSecret<MfaChallengeView>;
  /** The provisioning address of a new authenticator and the continuation grant. A bearer secret for as long as it is held. */
  readonly enrolment: TransientSecret<EnrolmentMaterial>;
}

export const PreSignInFlowContext = createContext<PreSignInFlow | undefined>(undefined);

export function usePreSignInFlow(): PreSignInFlow {
  const flow = useContext(PreSignInFlowContext);
  if (flow === undefined) {
    throw new Error('usePreSignInFlow must be used inside the PreSignInFlowLayout.');
  }
  return flow;
}

/**
 * The history state `/setup/mfa/complete` is shown on. It marks that this tab just proved a code. It is not a credential: a person who writes
 * the state into a history entry by hand sees a page that says the next step is to sign in, which is true of everyone.
 */
export const ENROLLED_STATE = { enrolled: true } as const;

/**
 * The history state `/setup/mfa` is left in once the material of an authenticator has been shown there (run 7, Stage 2.4). It marks that this tab was taken through the set-up: a person who comes
 * back to the page after the code has gone (a Back, a reload, the time up) is told what happened and what to do, and not that the link cannot be used. It is not a credential and says nothing
 * of anybody: a person who writes it into a history entry by hand sees the same words as everyone who has no code, which is true of them.
 */
export const ENROLLING_STATE = { enrolling: true } as const;

/** Whether the history state says this tab was taken through the set-up of an authenticator. */
export function wasEnrolling(state: unknown): boolean {
  return (
    typeof state === 'object' &&
    state !== null &&
    (state as { enrolling?: unknown }).enrolling === true
  );
}

/** Whether the history state says this tab has just proved a code. */
export function justEnrolled(state: unknown): boolean {
  return (
    typeof state === 'object' &&
    state !== null &&
    (state as { enrolled?: unknown }).enrolled === true
  );
}

/**
 * The family of addresses a thing handed between pre-sign-in screens belongs to: it is kept while the person moves inside the family and let
 * go of when they leave it. The sign-in pages are one family, the setup pages another, and the rest is none.
 */
export function familyOf(location: Location): string {
  const { pathname } = location;
  if (pathname === '/sign-in' || pathname.startsWith('/sign-in/')) return 'sign-in';
  if (pathname.startsWith('/setup/')) return 'setup';
  return 'elsewhere';
}
