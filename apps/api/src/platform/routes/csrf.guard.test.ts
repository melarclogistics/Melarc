import 'reflect-metadata';

import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';

import type { CsrfRejectionRecorder } from '../auth/csrf/csrf-rejection.js';
import { Sha256TokenService } from '../auth/crypto/sha256.token-service.adapter.js';
import { holdAuthenticatedSession } from '../auth/sessions/request-session.js';
import type { AuthenticatedSession } from '../auth/sessions/session-authenticator.js';
import type { StoredSession } from '../auth/ports/session-store.port.js';
import type { AppConfig } from '../config/load-config.js';
import { ApiException } from '../http/api-exception.js';
import { TEST_CONFIG } from '../../test-support/test-config.js';
import {
  ACCESS_DECLARATION_KEY,
  ACCESS_DETAIL_KEY,
  type AccessDeclaration,
  type AccessDetail,
} from './access-declaration.js';
import { CsrfGuard } from './csrf.guard.js';

/**
 * The CSRF slot reached directly (S0.25). The paths the real routes cannot reach are the ones that decide what happens when a
 * declaration is missing a part or the chain is not what it should be: a guard that is the last line must refuse what it cannot
 * place. The cases with a real route, a real session and a real database are `csrf-guard.db.test.ts`.
 */
const OPS = TEST_CONFIG.origins.ops;
const tokens = new Sha256TokenService();

interface Declared {
  readonly kind: AccessDeclaration | undefined;
  readonly detail?: AccessDetail;
}

function context(declared: Declared, request: Request): ExecutionContext {
  const handler = (): void => undefined;
  const controller = (): void => undefined;
  if (declared.kind !== undefined)
    Reflect.defineMetadata(ACCESS_DECLARATION_KEY, declared.kind, handler);
  if (declared.detail !== undefined)
    Reflect.defineMetadata(ACCESS_DETAIL_KEY, declared.detail, handler);
  return {
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function requestOf(
  method: string,
  headers: readonly [string, string][] = [],
  route?: string,
): Request {
  return {
    method,
    rawHeaders: headers.flat(),
    headers: {},
    ...(route === undefined ? {} : { route: { path: route } }),
  } as unknown as Request;
}

function sessionOf(
  principalType: StoredSession['principalType'],
  csrfTokenHash: Uint8Array | null,
): StoredSession {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    principalType,
    principalId: '22222222-2222-4222-8222-222222222222',
    state: 'ACTIVE',
    issuedAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    lastActivityAt: new Date(),
    terminatedAt: null,
    terminationReason: null,
    authority: {
      bundleId: '33333333-3333-4333-8333-333333333333',
      bundleRevision: 1,
      policyRevision: null,
      snapshot: {
        format: 1,
        name: 'Ops Staff',
        audience: principalType,
        privileged: false,
        grants: [],
      },
      authorizedHubIds: [],
    },
    registeredDeviceId: null,
    clientRootSignal: null,
    csrfTokenHash,
  };
}

function authenticated(
  session: StoredSession,
  credential: AuthenticatedSession['credential'],
): AuthenticatedSession {
  return {
    session,
    credential,
    judgedAt: new Date(),
    idleMinutes: credential === 'BEARER' ? null : 30,
  };
}

const recorder = () => {
  const record = vi.fn<CsrfRejectionRecorder['record']>(() => Promise.resolve());
  return { port: { record } as unknown as CsrfRejectionRecorder, record };
};

function guardOf(options: {
  readonly tokens?: Sha256TokenService | undefined;
  readonly recorder?: CsrfRejectionRecorder | undefined;
  readonly config?: AppConfig;
}): CsrfGuard {
  return new CsrfGuard(
    new Reflector(),
    options.config ?? TEST_CONFIG,
    'tokens' in options ? options.tokens : tokens,
    options.recorder,
  );
}

async function outcome(
  guard: CsrfGuard,
  ctx: ExecutionContext,
): Promise<'passes' | 'CSRF' | Error> {
  try {
    await guard.canActivate(ctx);
    return 'passes';
  } catch (error) {
    if (error instanceof ApiException && error.code === 'CSRF_VALIDATION_FAILED') {
      expect(error.getStatus()).toBe(403);
      return 'CSRF';
    }
    return error as Error;
  }
}

describe('what the guard does with a declaration that is missing a part', () => {
  // Break caught: an anonymous route that states no client read as native, which would release a pre-session mutation from the
  // Origin check by omission. The strict reading is the default.
  it('holds an anonymous route with no client to the browser rule on both surfaces', async () => {
    const guard = guardOf({});
    const declared: Declared = { kind: 'anonymous' };

    expect(await outcome(guard, context(declared, requestOf('POST')))).toBe('CSRF');
    expect(await outcome(guard, context(declared, requestOf('POST', [['Origin', OPS]])))).toBe(
      'passes',
    );
    expect(
      await outcome(
        guard,
        context(declared, requestOf('POST', [['Origin', TEST_CONFIG.origins.vendor]])),
      ),
    ).toBe('passes');
  });

  it('lets an anonymous route that is declared native through with no Origin', async () => {
    const guard = guardOf({});

    expect(
      await outcome(
        guard,
        context({ kind: 'anonymous', detail: { client: { kind: 'native' } } }, requestOf('POST')),
      ),
    ).toBe('passes');
  });

  // Break caught: a route that needs a principal, reached with no session held, let on by the slot that is meant to be the last
  // line. Authentication always holds the session it found, so this is a state that cannot happen, and it must not be a way through.
  it.each<AccessDeclaration>(['self', 'permission'])(
    'refuses a %s route that is reached with no session held',
    async (kind) => {
      const guard = guardOf({});

      expect(await outcome(guard, context({ kind }, requestOf('POST', [['Origin', OPS]])))).toBe(
        'CSRF',
      );
    },
  );

  it('does not hold a read, a technical route or an undeclared route to the rule', async () => {
    const guard = guardOf({});

    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect(await outcome(guard, context({ kind: 'anonymous' }, requestOf(method)))).toBe(
        'passes',
      );
      expect(await outcome(guard, context({ kind: 'self' }, requestOf(method)))).toBe('passes');
    }
    expect(await outcome(guard, context({ kind: 'technical' }, requestOf('POST')))).toBe('passes');
    expect(await outcome(guard, context({ kind: undefined }, requestOf('POST')))).toBe('passes');
  });
});

describe('what the guard does when a part of the stack is not there', () => {
  const issued = tokens.issue();
  const cookieRequest = (token: string): Request => {
    const request = requestOf('POST', [
      ['Origin', OPS],
      ['X-CSRF-Token', token],
    ]);
    holdAuthenticatedSession(request, authenticated(sessionOf('STAFF', issued.hash), 'COOKIE'));
    return request;
  };

  it('passes a cookie session with its own token and Origin', async () => {
    expect(await outcome(guardOf({}), context({ kind: 'self' }, cookieRequest(issued.token)))).toBe(
      'passes',
    );
  });

  // Break caught: no token service composed meaning "no token to check", so that every request passes.
  it('refuses a cookie session when no token service is composed, even with the right token', async () => {
    expect(
      await outcome(
        guardOf({ tokens: undefined }),
        context({ kind: 'self' }, cookieRequest(issued.token)),
      ),
    ).toBe('CSRF');
  });

  // Break caught: the cookie of a session that is not a staff or a vendor session judged against some origin, or none.
  it('refuses a cookie that authenticated a session of no browser surface', async () => {
    const request = requestOf('POST', [
      ['Origin', OPS],
      ['X-CSRF-Token', issued.token],
    ]);
    holdAuthenticatedSession(request, authenticated(sessionOf('RIDER', issued.hash), 'COOKIE'));

    expect(await outcome(guardOf({}), context({ kind: 'self' }, request))).toBe('CSRF');
  });

  it('refuses a cookie session that holds no hash, whatever token is sent', async () => {
    const request = requestOf('POST', [
      ['Origin', OPS],
      ['X-CSRF-Token', issued.token],
    ]);
    holdAuthenticatedSession(request, authenticated(sessionOf('STAFF', null), 'COOKIE'));

    expect(await outcome(guardOf({}), context({ kind: 'self' }, request))).toBe('CSRF');
  });

  it('serves a bearer-authenticated session without an Origin or a token', async () => {
    const request = requestOf('POST');
    holdAuthenticatedSession(request, authenticated(sessionOf('RIDER', null), 'BEARER'));

    expect(await outcome(guardOf({}), context({ kind: 'self' }, request))).toBe('passes');
  });
});

describe('what the guard records', () => {
  // Break caught: a refusal that is not recorded, or recorded with the address as sent rather than the route.
  it('hands the recorder the route as matched and the check that failed', async () => {
    const spy = recorder();
    const guard = guardOf({ recorder: spy.port });

    const result = await outcome(
      guard,
      context(
        { kind: 'anonymous' },
        requestOf('POST', [['Origin', 'https://evil.example']], '/api/v1/auth/staff/sign-in'),
      ),
    );

    expect(result).toBe('CSRF');
    expect(spy.record).toHaveBeenCalledOnce();
    expect(spy.record.mock.calls[0]?.[0]).toMatchObject({
      method: 'POST',
      route: '/api/v1/auth/staff/sign-in',
      check: 'ORIGIN_UNLISTED',
    });
    expect(spy.record.mock.calls[0]?.[0]).not.toHaveProperty('session');
  });

  it('says so when the router matched no route, and never repeats the address', async () => {
    const spy = recorder();

    await outcome(
      guardOf({ recorder: spy.port }),
      context({ kind: 'anonymous' }, requestOf('POST')),
    );

    expect(spy.record.mock.calls[0]?.[0].route).toBe('(unmatched)');
  });

  // Break caught: a record that fails deciding the answer: an audit outage turned into a way past the check, or into a 500.
  it('still refuses with the CSRF answer when the recorder fails', async () => {
    const failing = {
      record: vi.fn(() => Promise.reject(new Error('the audit table is unreachable'))),
    } as unknown as CsrfRejectionRecorder;

    expect(
      await outcome(
        guardOf({ recorder: failing }),
        context({ kind: 'anonymous' }, requestOf('POST')),
      ),
    ).toBe('CSRF');
  });

  it('still refuses when no recorder is composed', async () => {
    expect(
      await outcome(
        guardOf({ recorder: undefined }),
        context({ kind: 'anonymous' }, requestOf('POST')),
      ),
    ).toBe('CSRF');
  });

  it('does not record a request that passes', async () => {
    const spy = recorder();

    await outcome(
      guardOf({ recorder: spy.port }),
      context({ kind: 'anonymous' }, requestOf('POST', [['Origin', OPS]])),
    );

    expect(spy.record).not.toHaveBeenCalled();
  });
});
