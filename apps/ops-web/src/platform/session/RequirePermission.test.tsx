import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { sessionFixture } from '../../test-support/session-fixture';
import { wcagViolations } from '../../test-support/wcag';
import { RequirePermission } from './RequirePermission';
import { SessionContext } from './session-context';
import { SessionStore } from './session-store';
import { cannotText } from '../problem/capability-words';

function renderWith(store: SessionStore, permission: string) {
  return render(
    <MemoryRouter>
      <SessionContext value={store}>
        <RequirePermission permission={permission}>
          <p>The protected content</p>
        </RequirePermission>
      </SessionContext>
    </MemoryRouter>,
  );
}

function signedInWith(permissions: readonly string[] | undefined): SessionStore {
  const store = new SessionStore();
  store.signedIn(
    sessionFixture(
      permissions === undefined ? { permissions: undefined } : { permissions: [...permissions] },
    ),
  );
  return store;
}

describe('RequirePermission', () => {
  it('shows what it guards to a session that holds the permission', () => {
    renderWith(signedInWith(['staff.read', 'settings.read']), 'staff.read');

    expect(screen.getByText('The protected content')).toBeVisible();
  });

  // Break caught: the guard being a menu filter. A route a session may not use must refuse to render, not merely have
  // no link to it; "hidden is not enforcement". The server still checks on every request, and this is only the screen.
  it('shows the forbidden state, and never the content, to a session that lacks it', () => {
    renderWith(signedInWith(['settings.read']), 'staff.read');

    expect(screen.queryByText('The protected content')).toBeNull();
    expect(
      screen.getByRole('heading', { level: 1, name: 'You do not have access to this page' }),
    ).toBeVisible();
    expect(document.title).toBe('No access · Melarc Ops Portal');
  });

  // Break caught: the refusal naming a role. Authority is the key; a role name is not a thing the client may know
  // or decide on (surfaces/ops-portal.md section 7).
  it('says what the account cannot do in plain words, and names no role and no key', () => {
    renderWith(signedInWith([]), 'staff.read');

    expect(screen.getByText(cannotText('staff.read'))).toBeVisible();
    expect(document.body.textContent).not.toContain('staff.read');
    expect(document.body.textContent).not.toMatch(
      /senior ops|ops staff|platform admin|\brole\b|officer/i,
    );
  });

  // Break caught: a key matched as a prefix or as a substring, so `staff.read` opens a page that needs `staff.read.all`
  // or `staff.reader`.
  it.each([
    ['a longer key', ['staff.read.all'], 'staff.read'],
    ['a shorter key', ['staff'], 'staff.read'],
    ['a different case', ['STAFF.READ'], 'staff.read'],
    ['a key with a space', ['staff.read '], 'staff.read'],
  ])('does not take %s for the permission', (_label, held, needed) => {
    renderWith(signedInWith(held), needed);

    expect(screen.queryByText('The protected content')).toBeNull();
  });

  // Break caught (ops-portal.md section 7, `/pickup-requests/{id}/exception`): a page whose request another person decides refused as "you lack
  // access", when the rule is that it reads as who decides, by the key, and never a role.
  it('tells a page that another person decides as who decides, by the key', () => {
    render(
      <MemoryRouter>
        <SessionContext value={signedInWith(['pickup.read'])}>
          <RequirePermission
            permission="pickup.exception.request"
            decidedBy="pickup.exception.approve"
          >
            <p>The protected content</p>
          </RequirePermission>
        </SessionContext>
      </MemoryRouter>,
    );

    expect(screen.queryByText('The protected content')).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Approval is needed' })).toBeVisible();
    expect(screen.getByText('A different approver decides this.')).toBeVisible();
    expect(document.body.textContent).not.toContain('pickup.exception.approve');
    expect(document.body.textContent).not.toMatch(
      /do not have access|senior ops|ops staff|platform admin|\brole\b/i,
    );
  });

  it('shows what it guards to a session that holds the key, whoever decides', () => {
    render(
      <MemoryRouter>
        <SessionContext value={signedInWith(['pickup.exception.request'])}>
          <RequirePermission
            permission="pickup.exception.request"
            decidedBy="pickup.exception.approve"
          >
            <p>The protected content</p>
          </RequirePermission>
        </SessionContext>
      </MemoryRouter>,
    );

    expect(screen.getByText('The protected content')).toBeVisible();
  });

  it('refuses when the session lists no permissions at all', () => {
    renderWith(signedInWith(undefined), 'staff.read');

    expect(screen.queryByText('The protected content')).toBeNull();
  });

  // Break caught: the guard rendering the content while the session is not known, which shows a page to somebody who
  // may not be signed in. Deciding who is signed in is the session guard's job; this one shows nothing until it is
  // known, and the forbidden state is for a signed-in session only.
  it.each(['loading', 'signed-out', 'unavailable'] as const)(
    'shows neither the content nor the forbidden state while the session is %s',
    async (status) => {
      const store = new SessionStore();
      if (status === 'signed-out') store.end();
      if (status === 'unavailable') await store.load(() => Promise.reject(new Error('no')));
      expect(store.getState().status).toBe(status);
      renderWith(store, 'staff.read');

      expect(screen.queryByText('The protected content')).toBeNull();
      expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    },
  );

  it('has no WCAG 2.1 A or AA violations that can be checked without a layout engine', async () => {
    const { container } = renderWith(signedInWith([]), 'staff.read');

    expect(await wcagViolations(container)).toEqual([]);
  });
});
