import { BadRequestException, HttpException, NotFoundException } from '@nestjs/common';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { Logger } from 'pino';
import { firstValueFrom, lastValueFrom, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import type { SessionStore, StoredSession } from '../auth/ports/session-store.port.js';
import type { UnitOfWork } from '../auth/ports/unit-of-work.port.js';
import { ActivityRecorder } from '../auth/sessions/activity-recorder.js';
import { ACTIVITY_COALESCE_MS } from '../auth/sessions/session-parameters.js';
import { ApiException } from '../http/api-exception.js';
import { ErrorCode } from '../http/error-codes.js';
import { holdAuthorization, type AuthorizedRequest } from './authorized-request.js';
import { SessionActivityInterceptor, countsAsActivity } from './session-activity.interceptor.js';

/**
 * Which requests count as the person acting (decision A of 12 October 2026), and what happens to the write. The statement that
 * writes, and what it does when the session ended while it waited, are `activity.db.test.ts` on a real database.
 */
const NOW = new Date('2026-10-12T09:00:00.000Z');

function sessionRecordedAt(lastActivityAt: Date): StoredSession {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    principalType: 'STAFF',
    principalId: '22222222-2222-4222-8222-222222222222',
    state: 'ACTIVE',
    issuedAt: new Date(NOW.getTime() - 3_600_000),
    expiresAt: new Date(NOW.getTime() + 3_600_000),
    lastActivityAt,
    terminatedAt: null,
    terminationReason: null,
    authority: {
      bundleId: '33333333-3333-4333-8333-333333333333',
      bundleRevision: 1,
      policyRevision: null,
      snapshot: { format: 1, name: 'Ops Staff', audience: 'STAFF', privileged: false, grants: [] },
      authorizedHubIds: [],
    },
    registeredDeviceId: null,
    clientRootSignal: null,
    csrfTokenHash: new Uint8Array(32),
  };
}

function authorized(overrides: Partial<AuthorizedRequest> = {}): AuthorizedRequest {
  return {
    session: sessionRecordedAt(new Date(NOW.getTime() - 5 * 60_000)),
    credential: 'COOKIE',
    idleMinutes: 30,
    judgedAt: NOW,
    permission: undefined,
    grant: undefined,
    scope: { hubScopeMode: 'SET', authorizedHubIds: [] },
    activity: 'qualifying',
    stateChanging: true,
    ...overrides,
  };
}

interface Harness {
  readonly interceptor: SessionActivityInterceptor;
  readonly written: { sessionId: string; idleMinutes: number | null }[];
  readonly warnings: unknown[];
  contextFor(decision: AuthorizedRequest | undefined): ExecutionContext;
}

function harness(
  options: { unitOfWork?: 'absent'; failing?: boolean; recorded?: boolean } = {},
): Harness {
  const written: { sessionId: string; idleMinutes: number | null }[] = [];
  const warnings: unknown[] = [];
  const sessions = {
    recordActivity: vi.fn((_handle: unknown, sessionId: string, idleMinutes: number | null) => {
      if (options.failing === true) return Promise.reject(new Error('the database is down'));
      written.push({ sessionId, idleMinutes });
      return Promise.resolve(options.recorded ?? true);
    }),
  } as unknown as SessionStore;
  const unitOfWork = {
    run: (_context: unknown, work: (handle: unknown) => Promise<unknown>) => work({}),
  } as unknown as UnitOfWork;
  const logger = { warn: (fields: unknown) => warnings.push(fields) } as unknown as Logger;
  const interceptor = new SessionActivityInterceptor(
    options.unitOfWork === 'absent'
      ? undefined
      : new ActivityRecorder({ unitOfWork, sessions, logger }),
  );
  return {
    interceptor,
    written,
    warnings,
    contextFor: (decision) => {
      const request = {} as Request;
      if (decision !== undefined) holdAuthorization(request, decision);
      return { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
    },
  };
}

const answering = (value: unknown): CallHandler => ({ handle: () => of(value) });
const failing = (error: unknown): CallHandler => ({ handle: () => throwError(() => error) });

describe('countsAsActivity: which end of a request is the person acting', () => {
  // Break caught (decision A): "every 4xx is inactivity". An authorized action that is answered with a validation failure, a
  // version or state conflict, a business rule or a record that is not there is still the person at the screen.
  it.each([
    ['a validation failure', ApiException.of(ErrorCode.ValidationFailed, 'x')],
    ['a state conflict', ApiException.of(ErrorCode.StateConflict, 'x')],
    ['an idempotency conflict', ApiException.of(ErrorCode.IdempotencyKeyConflict, 'x')],
    ['a record that is not there', ApiException.of(ErrorCode.NotFound, 'x')],
    ['a business rule', ApiException.of(ErrorCode.SelfApprovalForbidden, 'x')],
    ['a framework 404', new NotFoundException()],
    ['a framework 400', new BadRequestException()],
    ['a framework 409', new HttpException('x', 409)],
  ])('counts %s', (_label, error) => {
    expect(countsAsActivity(error)).toBe(true);
  });

  // Break caught (decision A): a refusal of authority extending the idle lifetime of the session it was refused.
  it.each([
    ErrorCode.SessionInvalid,
    ErrorCode.SessionSuperseded,
    ErrorCode.CsrfValidationFailed,
    ErrorCode.PermissionDenied,
    ErrorCode.InsufficientAuthority,
    ErrorCode.HubScopeViolation,
    ErrorCode.RateLimited,
  ])('does not count %s', (code) => {
    expect(countsAsActivity(ApiException.of(code, 'x'))).toBe(false);
  });

  // Break caught: the platform's own failure counted as the person acting, because it arrived as the platform's envelope: an
  // exception of the contract that maps to a 5xx (the contract's only declared one) says nothing about the person.
  it('does not count an exception of the contract that maps to a server failure', () => {
    expect(countsAsActivity(ApiException.of(ErrorCode.TrustDataUnavailable, 'x'))).toBe(false);
  });

  it.each([
    ['a framework 401', new HttpException('x', 401)],
    ['a framework 403', new HttpException('x', 403)],
    ['a framework 429', new HttpException('x', 429)],
    ['a server failure', new HttpException('x', 500)],
    ['an operational failure', new HttpException('x', 503)],
    ['an unexpected error', new Error('boom')],
    ['something thrown that is not an error', 'text'],
    ['nothing', undefined],
  ])('does not count %s', (_label, error) => {
    expect(countsAsActivity(error)).toBe(false);
  });
});

describe('what the interceptor writes, and when', () => {
  // Break caught: a qualifying request that passed every guard and succeeded not recorded, so a session in use goes idle.
  it('records the activity of a qualifying request that succeeded, with the idle limit it was judged by', async () => {
    const kit = harness();

    const value = await lastValueFrom(
      kit.interceptor.intercept(kit.contextFor(authorized()), answering({ ok: 1 })),
    );

    expect(value).toEqual({ ok: 1 });
    expect(kit.written).toEqual([
      { sessionId: '11111111-1111-4111-8111-111111111111', idleMinutes: 30 },
    ]);
  });

  // Break caught (decision A): a poll keeping an unattended session alive.
  it('records nothing for a route declared background, whatever it answers', async () => {
    const kit = harness();
    const context = kit.contextFor(authorized({ activity: 'background' }));

    await lastValueFrom(kit.interceptor.intercept(context, answering({ ok: 1 })));
    await expect(
      lastValueFrom(
        kit.interceptor.intercept(context, failing(ApiException.of(ErrorCode.NotFound, 'x'))),
      ),
    ).rejects.toBeInstanceOf(ApiException);

    expect(kit.written).toEqual([]);
  });

  // Break caught: a request nothing authorized (a technical route, one the guards did not decide) recording activity of a session.
  it('records nothing for a request with no authorization decision', async () => {
    const kit = harness();

    await lastValueFrom(kit.interceptor.intercept(kit.contextFor(undefined), answering(1)));

    expect(kit.written).toEqual([]);
  });

  // Break caught (decision A): the feedback on an authorized action not counting, or a refusal of authority counting.
  it('records an authorized action answered with feedback, and still raises the answer unchanged', async () => {
    const kit = harness();
    const feedback = ApiException.of(ErrorCode.StateConflict, 'conflict');

    await expect(
      lastValueFrom(kit.interceptor.intercept(kit.contextFor(authorized()), failing(feedback))),
    ).rejects.toBe(feedback);

    expect(kit.written).toHaveLength(1);
  });

  it('records nothing when the use case refused for authority, and raises that refusal unchanged', async () => {
    const kit = harness();
    for (const code of [ErrorCode.InsufficientAuthority, ErrorCode.HubScopeViolation]) {
      const refusal = ApiException.of(code, 'refused');
      await expect(
        lastValueFrom(kit.interceptor.intercept(kit.contextFor(authorized()), failing(refusal))),
      ).rejects.toBe(refusal);
    }

    expect(kit.written).toEqual([]);
  });

  it('records nothing for a failure of the platform, and raises it unchanged', async () => {
    const kit = harness();
    const failure = new Error('boom');

    await expect(
      lastValueFrom(kit.interceptor.intercept(kit.contextFor(authorized()), failing(failure))),
    ).rejects.toBe(failure);

    expect(kit.written).toEqual([]);
  });

  // Break caught: a statement per request, which a burst would turn into a burst of writes on one row.
  it('does not write when the activity authentication read is younger than the coalescing window', async () => {
    const kit = harness();
    const fresh = authorized({
      session: sessionRecordedAt(new Date(NOW.getTime() - ACTIVITY_COALESCE_MS + 1)),
    });
    const stale = authorized({
      session: sessionRecordedAt(new Date(NOW.getTime() - ACTIVITY_COALESCE_MS)),
    });

    await lastValueFrom(kit.interceptor.intercept(kit.contextFor(fresh), answering(1)));
    expect(kit.written).toEqual([]);
    await lastValueFrom(kit.interceptor.intercept(kit.contextFor(stale), answering(1)));
    expect(kit.written).toHaveLength(1);
  });

  it('passes a rider’s null idle limit on to the write', async () => {
    const kit = harness();

    await lastValueFrom(
      kit.interceptor.intercept(
        kit.contextFor(authorized({ idleMinutes: null, credential: 'BEARER' })),
        answering(1),
      ),
    );

    expect(kit.written.map((each) => each.idleMinutes)).toEqual([null]);
  });
});

describe('what the interceptor never does', () => {
  // Break caught: a failure to record turning a served request into an error, or hiding the answer it should have raised.
  it('serves the answer, and says so once, when the write fails', async () => {
    const kit = harness({ failing: true });

    const value = await lastValueFrom(
      kit.interceptor.intercept(kit.contextFor(authorized()), answering('served')),
    );

    expect(value).toBe('served');
    expect(kit.warnings).toHaveLength(1);
  });

  it('raises the use case’s own answer, not the write’s failure, when both go wrong', async () => {
    const kit = harness({ failing: true });
    const feedback = ApiException.of(ErrorCode.ValidationFailed, 'x');

    await expect(
      lastValueFrom(kit.interceptor.intercept(kit.contextFor(authorized()), failing(feedback))),
    ).rejects.toBe(feedback);
  });

  it('serves the answer when no unit of work is composed', async () => {
    const kit = harness({ unitOfWork: 'absent' });

    expect(
      await firstValueFrom(
        kit.interceptor.intercept(kit.contextFor(authorized()), answering('served')),
      ),
    ).toBe('served');
    expect(kit.written).toEqual([]);
  });

  // Break caught: the answer not being what the use case returned, or the write happening before the use case ran.
  it('writes after the use case has answered, not before', async () => {
    const kit = harness();
    const order: string[] = [];
    const handler: CallHandler = {
      handle: () => {
        order.push(`handled with ${String(kit.written.length)} written`);
        return of('answer');
      },
    };

    await lastValueFrom(kit.interceptor.intercept(kit.contextFor(authorized()), handler));

    expect(order).toEqual(['handled with 0 written']);
    expect(kit.written).toHaveLength(1);
  });
});
