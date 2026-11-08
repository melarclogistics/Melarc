import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { sessionFixture } from '../../test-support/session-fixture';
import { SessionProvider } from './SessionProvider';
import { SessionStore, type SessionView } from './session-store';
import { useSignedInSession } from './use-permissions';

function hookWith(session: SessionView | undefined) {
  const store = new SessionStore();
  if (session !== undefined) store.signedIn(session);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <SessionProvider store={store}>{children}</SessionProvider>
  );
  return { ...renderHook(() => useSignedInSession(), { wrapper }), store };
}

describe('useSignedInSession', () => {
  it('has nothing while nobody is signed in', () => {
    expect(hookWith(undefined).result.current).toBeUndefined();
  });

  it('has the session of the person who is signed in', () => {
    const session = sessionFixture({ permissions: ['staff.read'] });

    expect(hookWith(session).result.current?.session).toBe(session);
  });

  // Break caught: a key matched as a prefix, or without regard to case, which would show an action the key does not allow.
  it('holds exactly the keys the session lists', () => {
    const me = hookWith(sessionFixture({ permissions: ['staff.read', 'staff.identity.approve'] }))
      .result.current;

    expect(me?.holds('staff.read')).toBe(true);
    expect(me?.holds('staff.identity.approve')).toBe(true);
    expect(me?.holds('staff.identity')).toBe(false);
    expect(me?.holds('STAFF.READ')).toBe(false);
    expect(me?.holds('staff.read.all')).toBe(false);
  });

  // Break caught: a session that lists no keys being taken for one that holds them all.
  it('holds nothing when the session lists no keys', () => {
    const bare = sessionFixture();
    delete (bare as { permissions?: string[] }).permissions;

    expect(hookWith(bare).result.current?.holds('staff.read')).toBe(false);
  });

  it('changes when the session ends', () => {
    const view = hookWith(sessionFixture());

    view.store.end();
    view.rerender();

    expect(view.result.current).toBeUndefined();
  });
});
