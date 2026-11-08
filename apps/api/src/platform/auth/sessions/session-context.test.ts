import { describe, expect, it } from 'vitest';

import { SecurityContextError, toContextSettings } from '../../database/transaction-context.js';
import type { StoredSession } from '../ports/session-store.port.js';
import { contextOfSession } from './session-context.js';

const SESSION_ID = '0199c4a2-7b00-7000-8000-000000000001';
const PRINCIPAL_ID = '0199c4a2-7b00-7000-8000-000000000002';
const ORGANIZATION_ID = '0199c4a2-7b00-7000-8000-000000000003';
const CORRELATION_ID = 'request-0001';

function session(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    id: SESSION_ID,
    principalType: 'STAFF',
    principalId: PRINCIPAL_ID,
    state: 'ACTIVE',
    issuedAt: new Date('2026-10-11T08:00:00Z'),
    expiresAt: new Date('2026-10-11T16:00:00Z'),
    lastActivityAt: new Date('2026-10-11T08:00:00Z'),
    terminatedAt: null,
    terminationReason: null,
    registeredDeviceId: null,
    clientRootSignal: null,
    csrfTokenHash: null,
    authority: {
      bundleId: '0199c4a2-7b00-7000-8000-000000000009',
      bundleRevision: 1,
      policyRevision: null,
      snapshot: { format: 1, name: 'Ops Staff', audience: 'STAFF', privileged: false, grants: [] },
      authorizedHubIds: ['0199c4a2-7b00-7000-8000-0000000000a1'],
    },
    ...overrides,
  };
}

describe('contextOfSession', () => {
  // Break caught (plan obligation OB-54): a context built from an authenticated session that does not name the session, so that
  // the transaction (and the audit event it writes) could not say which session acted.
  it.each([
    ['STAFF', 'OPS_PORTAL', {}],
    ['RIDER', 'RIDER_ANDROID', {}],
    ['VENDOR', 'VENDOR_PWA', { vendorOrganizationId: ORGANIZATION_ID }],
  ] as const)(
    'carries the session id, the principal and the surface of a %s session',
    (type, surface, extra) => {
      const context = contextOfSession(
        session({
          principalType: type,
          ...(type === 'STAFF'
            ? {}
            : { registeredDeviceId: '0199c4a2-7b00-7000-8000-0000000000b1' }),
        }),
        { correlationId: CORRELATION_ID, ...extra },
      );

      expect(context).toMatchObject({
        principalType: type,
        principalId: PRINCIPAL_ID,
        sessionId: SESSION_ID,
        surface,
        correlationId: CORRELATION_ID,
      });
      // It is a context the database service accepts, and the setting that row-level security reads is the session's.
      expect(Object.fromEntries(toContextSettings(context))['melarc.session_id']).toBe(SESSION_ID);
    },
  );

  it('names the rider as the rider, and the organisation of a vendor', () => {
    expect(
      contextOfSession(session({ principalType: 'RIDER' }), { correlationId: CORRELATION_ID }),
    ).toMatchObject({ riderId: PRINCIPAL_ID });
    expect(
      contextOfSession(session({ principalType: 'VENDOR' }), {
        correlationId: CORRELATION_ID,
        vendorOrganizationId: ORGANIZATION_ID,
      }),
    ).toMatchObject({ vendorOrganizationId: ORGANIZATION_ID });
  });

  // Break caught (data-scope-registry.md: hub scope is "resolved from that grant, never from the Session as a whole"; `ALL` is never
  // inferred): a context that already carries the session's whole hub list, or a scope mode, or a permission, before any grant has
  // been consulted.
  it('carries no hub scope, no hub list, no permission and no capability: those are the authorization step’s', () => {
    const context = contextOfSession(session(), { correlationId: CORRELATION_ID });

    expect(context.hubScopeMode).toBeUndefined();
    expect(context.authorizedHubIds).toBeUndefined();
    expect(context.authorizationKey).toBeUndefined();
    expect(context.taskCapability).toBeUndefined();
  });

  // Break caught: a vendor context without the organisation its row-level security keys on, which would read as no records.
  it('refuses a vendor session with no organisation to name, through the context validation', () => {
    const context = contextOfSession(session({ principalType: 'VENDOR' }), {
      correlationId: CORRELATION_ID,
    });

    expect(() => toContextSettings(context)).toThrow(SecurityContextError);
  });

  // Break caught: a session that has ended, or one that is not one, given a context to act with.
  it('refuses a session that is not active', () => {
    expect(() =>
      contextOfSession(session({ state: 'TERMINATED', terminationReason: 'SIGNED_OUT' }), {
        correlationId: CORRELATION_ID,
      }),
    ).toThrow(/not active/);
  });
});
