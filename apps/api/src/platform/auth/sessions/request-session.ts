import type { Request } from 'express';

import type { AuthenticatedSession } from './session-authenticator.js';

/**
 * The session a request was authenticated with, kept beside the request and not on it: the authentication guard sets it, and the
 * later slots of the chain (the CSRF check of S0.25, the authorization of S0.26) and the use cases read it. A request that was not
 * authenticated, because its route is anonymous or technical or because the guard refused it, has none. Keeping it in a weak map
 * means no code can set it by assigning to the request, and it goes when the request does.
 */
const held = new WeakMap<object, AuthenticatedSession>();

export function holdAuthenticatedSession(
  request: Request,
  authenticated: AuthenticatedSession,
): void {
  held.set(request, authenticated);
}

export function authenticatedSessionOf(request: Request): AuthenticatedSession | undefined {
  return held.get(request);
}
