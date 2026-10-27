import { useMemo } from 'react';

import { useSession } from './session-context';
import type { SessionView } from './session-store';

export interface SignedInSession {
  readonly session: SessionView;
  /**
   * Whether the session lists this permission key. A hint for what to show, never the authority: the server checks the key on every request,
   * so a screen that shows or hides an action by this decides nothing. A key matches exactly, and a session that lists none holds none.
   */
  readonly holds: (key: string) => boolean;
}

/**
 * Who is signed in and which keys the session lists, for a screen under the session guard. Nothing while nobody is signed in: the guard
 * above a screen has already decided that, and the screen draws nothing for it.
 */
export function useSignedInSession(): SignedInSession | undefined {
  const state = useSession();
  const session = state.status === 'signed-in' ? state.session : undefined;
  return useMemo(() => {
    if (session === undefined) return undefined;
    const held = new Set(session.permissions);
    return { session, holds: (key: string) => held.has(key) };
  }, [session]);
}
