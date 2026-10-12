import 'reflect-metadata';

import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { IncomingHttpHeaders } from 'node:http';
import { describe, expect, it } from 'vitest';

import type { RateLimiter } from '../auth/ports/rate-limiter.port.js';
import type { StoredSession } from '../auth/ports/session-store.port.js';
import { authenticatedSessionOf } from '../auth/sessions/request-session.js';
import { AuthenticationUnavailableError } from '../auth/sessions/session-errors.js';
import type {
  AuthenticatedSession,
  AuthenticationOutcome,
  SessionAuthenticator,
} from '../auth/sessions/session-authenticator.js';
import type { PresentedCredential } from '../auth/sessions/session-credentials.js';
import { ApiException } from '../http/api-exception.js';
import { LimiterUnavailableError } from '../limiter/limiter-errors.js';
import { ACCESS_DECLARATION_KEY } from './access-declaration.js';
import { AuthenticationGuard } from './authentication.guard.js';

/**
 * The authentication slot (S0.24) held to its own rules with its collaborators replaced, so that each rule is seen alone: what it
 * asks the authenticator, what it asks the limiter and in which order, what it answers, and what it keeps for the slots after it.
 * The real stack (a database, the real authenticator and limiter, HTTP) is `test/database/authentication-guard.db.test.ts`.
 */
const SESSION: StoredSession = {
  id: '0199c4a2-7b00-7000-8000-000000000001',
  principalType: 'STAFF',
  principalId: '0199c4a2-7b00-7000-8000-000000000002',
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
    authorizedHubIds: [],
  },
};

const AUTHENTICATED_SESSION: AuthenticatedSession = {
  session: SESSION,
  credential: 'COOKIE',
  judgedAt: new Date('2026-10-11T09:00:00Z'),
};
const AUTHENTICATED: AuthenticationOutcome = {
  kind: 'AUTHENTICATED',
  authenticated: AUTHENTICATED_SESSION,
};

interface Calls {
  authenticated: { credential: PresentedCredential; correlationId: string }[];
  admitted: { bucket: string; key: string }[];
  order: string[];
}

function fixtures(options: {
  outcome?: AuthenticationOutcome;
  authenticator?: 'absent';
  limiter?: 'absent' | 'refuses' | 'down';
}) {
  const calls: Calls = { authenticated: [], admitted: [], order: [] };
  const authenticator = {
    authenticate: (credential: PresentedCredential, correlationId: string) => {
      calls.order.push('authenticate');
      calls.authenticated.push({ credential, correlationId });
      return Promise.resolve(options.outcome ?? AUTHENTICATED);
    },
  } as unknown as SessionAuthenticator;
  const limiter: RateLimiter = {
    admit: (bucket, key) => {
      calls.order.push('admit');
      calls.admitted.push({ bucket, key });
      if (options.limiter === 'down') return Promise.reject(new LimiterUnavailableError());
      return Promise.resolve(
        options.limiter === 'refuses'
          ? { allowed: false, retryAfterSeconds: 30 }
          : { allowed: true },
      );
    },
  };
  const guard = new AuthenticationGuard(
    new Reflector(),
    options.authenticator === 'absent' ? undefined : authenticator,
    options.limiter === 'absent' ? undefined : limiter,
  );
  return { guard, calls };
}

function contextOf(declaration: string, headers: IncomingHttpHeaders) {
  const controller = (): void => undefined;
  const handler = (): void => undefined;
  Reflect.defineMetadata(ACCESS_DECLARATION_KEY, declaration, handler);
  // The raw header lines of a request that sent each header once, which is what the fake client below does.
  const rawHeaders = Object.entries(headers).flatMap(([name, value]) => [name, String(value)]);
  const request = { headers, rawHeaders, method: 'GET' };
  const context = {
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, request };
}

const TOKEN = 'dGhlIHRva2VuIGlzIDQzIGJhc2U2NHVybCBjaGFyYWN0ZXJz';
const COOKIE = { cookie: `melarc_session=${TOKEN}` };

async function refusalOf(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('a route that needs a principal', () => {
  // Break caught (AC-SLICE-000-44): a missing session answered 403, or served.
  it.each([
    ['no credential', {}],
    ['a cookie and a bearer credential together', { ...COOKIE, authorization: `Bearer ${TOKEN}` }],
    ['the session cookie twice', { cookie: `melarc_session=${TOKEN}; melarc_session=${TOKEN}` }],
  ])(
    'is refused 401 SESSION_INVALID with %s, without asking the authenticator or the limiter',
    async (_label, headers) => {
      const { guard, calls } = fixtures({});
      const { context } = contextOf('self', headers);

      const refusal = await refusalOf(guard.canActivate(context));

      expect(refusal).toBeInstanceOf(ApiException);
      expect(refusal).toMatchObject({ code: 'SESSION_INVALID' });
      expect((refusal as ApiException).getStatus()).toBe(401);
      expect(calls.order).toEqual([]);
    },
  );

  // Break caught: a missing credential refused as an operational failure when no store is composed (which would turn a plain 401
  // into a 503 for every anonymous probe of a protected route), or a credential judged when there is nothing to judge it.
  it('answers a request with no credential 401 even when nothing is composed to judge one, and 503 when it presents one', async () => {
    const { guard } = fixtures({ authenticator: 'absent', limiter: 'absent' });

    const none = await refusalOf(guard.canActivate(contextOf('permission', {}).context));
    const presented = await refusalOf(guard.canActivate(contextOf('permission', COOKIE).context));

    expect((none as ApiException).getStatus()).toBe(401);
    expect(presented).toBeInstanceOf(AuthenticationUnavailableError);
  });

  it.each(['self', 'permission'])(
    'asks the authenticator what a %s route presented, with the request’s id',
    async (declaration) => {
      const { guard, calls } = fixtures({});

      await guard.canActivate(contextOf(declaration, COOKIE).context);

      expect(calls.authenticated).toHaveLength(1);
      expect(calls.authenticated[0]?.credential).toEqual({ kind: 'COOKIE', token: TOKEN });
      expect(calls.authenticated[0]?.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    },
  );

  // Break caught: the cause of a refusal (unknown, expired, terminated) reaching the caller, who then learns which guess was close.
  it.each([
    ['SESSION_INVALID', 'No usable session'],
    ['SESSION_SUPERSEDED', 'Session superseded'],
  ] as const)(
    'answers a refusal of %s with that code, a fixed message and nothing of the cause',
    async (code, message) => {
      const { guard, calls } = fixtures({
        outcome: { kind: 'REFUSED', code, cause: 'SESSION_EXPIRED_IDLE' },
      });

      const refusal = await refusalOf(guard.canActivate(contextOf('self', COOKIE).context));

      expect(refusal).toMatchObject({ code });
      expect((refusal as ApiException).getStatus()).toBe(401);
      expect(JSON.stringify((refusal as ApiException).getResponse())).toBe(
        JSON.stringify({ code, message }),
      );
      expect(calls.admitted).toEqual([]);
    },
  );
});

describe('the authenticated-API bucket', () => {
  // Break caught (plan §7.16): the bucket applied before the session was found (keyed on an unverified credential, so any caller
  // could fill the limiter's table), or keyed on something other than the session, or on another bucket.
  it('is asked after the session is found, for the session’s id', async () => {
    const { guard, calls } = fixtures({});

    expect(await guard.canActivate(contextOf('self', COOKIE).context)).toBe(true);

    expect(calls.order).toEqual(['authenticate', 'admit']);
    expect(calls.admitted).toEqual([{ bucket: 'rate_limit_authenticated_api', key: SESSION.id }]);
  });

  it('refuses 429 RATE_LIMITED when the bucket is spent, and does not keep the session for the later slots', async () => {
    const { guard } = fixtures({ limiter: 'refuses' });
    const { context, request } = contextOf('self', COOKIE);

    const refusal = await refusalOf(guard.canActivate(context));

    expect(refusal).toMatchObject({ code: 'RATE_LIMITED' });
    expect((refusal as ApiException).getStatus()).toBe(429);
    expect(authenticatedSessionOf(request as never)).toBeUndefined();
  });

  // Break caught: a permissive fallback when the limiter cannot decide, or none is composed, for authenticated requests.
  it.each(['down', 'absent'] as const)('fails closed when the limiter is %s', async (limiter) => {
    const { guard } = fixtures({ limiter });
    const { context, request } = contextOf('permission', COOKIE);

    const refusal = await refusalOf(guard.canActivate(context));

    expect(refusal).toBeInstanceOf(LimiterUnavailableError);
    expect(authenticatedSessionOf(request as never)).toBeUndefined();
  });
});

describe('what it keeps for the slots after it', () => {
  // Break caught: the later slots unable to find the session the guard authenticated, or finding one it did not.
  it('keeps the authenticated session beside the request, and only after the bucket admitted it', async () => {
    const { guard } = fixtures({});
    const { context, request } = contextOf('self', COOKIE);

    await guard.canActivate(context);

    expect(authenticatedSessionOf(request as never)).toBe(AUTHENTICATED_SESSION);
  });

  // Break caught: a pre-authentication or technical route made to authenticate (and so to depend on a store, and to refuse a
  // sign-in whose browser still holds a stale cookie).
  it.each(['anonymous', 'technical'])(
    'does nothing for a %s route, even when it carries a session cookie',
    async (declaration) => {
      const { guard, calls } = fixtures({
        outcome: { kind: 'REFUSED', code: 'SESSION_INVALID', cause: 'UNKNOWN_SESSION' },
      });
      const { context, request } = contextOf(declaration, COOKIE);

      expect(await guard.canActivate(context)).toBe(true);

      expect(calls.order).toEqual([]);
      expect(authenticatedSessionOf(request as never)).toBeUndefined();
    },
  );
});
