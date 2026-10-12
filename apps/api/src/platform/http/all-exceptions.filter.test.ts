import { HttpException, NotFoundException, type ArgumentsHost } from '@nestjs/common';
import type { Response } from 'express';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';

import {
  AcquireTimeoutError,
  PoolClosedError,
  PoolSaturatedError,
} from '../database/connection-queue.js';
import {
  CommitOutcomeUnknownError,
  DatabaseDeadlineError,
  TransactionRolledBackError,
} from '../database/database-failures.js';
import { BudgetExpiredError } from '../execution/execution-budget.js';
import { AllExceptionsFilter } from './all-exceptions.filter.js';
import { ApiException } from './api-exception.js';
import { ErrorCode } from './error-codes.js';

interface Sent {
  status: number | undefined;
  body: Record<string, unknown> | undefined;
}

/**
 * What the filter did with one exception: what it sent (and the headers it set), what it logged as a server fault, and what it
 * logged as a warning.
 */
function filtered(exception: unknown): {
  sent: Sent;
  headers: Record<string, unknown>;
  faults: unknown[];
  warnings: unknown[];
} {
  const sent: Sent = { status: undefined, body: undefined };
  const headers: Record<string, unknown> = {};
  const response = {
    headersSent: false,
    getHeader: () => 'request-id-1',
    setHeader(name: string, value: unknown) {
      headers[name.toLowerCase()] = value;
      return this;
    },
    status(code: number) {
      sent.status = code;
      return this;
    },
    json(body: Record<string, unknown>) {
      sent.body = body;
      return this;
    },
  } as unknown as Response;
  const faults: unknown[] = [];
  const warnings: unknown[] = [];
  const logger = {
    error: (fields: unknown) => faults.push(fields),
    warn: (fields: unknown) => warnings.push(fields),
  } as unknown as Logger;
  const host = {
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ArgumentsHost;

  new AllExceptionsFilter(logger).catch(exception, host);
  return { sent, headers, faults, warnings };
}

describe('AllExceptionsFilter: what counts as a client error', () => {
  // Break caught: a 5xx taken for a client error. It would be answered with its own status and a reason phrase and
  // would never be logged as a fault, so a failing dependency would look like a caller's mistake and raise no alert.
  it.each([500, 502, 503, 504])(
    'answers an HttpException with status %i as a server fault: 500, generic, and logged',
    (status) => {
      const { sent, faults } = filtered(new HttpException('upstream said: secret-value', status));

      expect(sent).toEqual({
        status: 500,
        body: { message: 'Internal server error', request_id: 'request-id-1' },
      });
      expect(faults).toHaveLength(1);
    },
  );

  it('answers an HttpException with a 4xx status as that status', () => {
    const { sent, faults } = filtered(new NotFoundException('a message with a path /x'));

    expect(sent).toEqual({
      status: 404,
      body: { code: 'NOT_FOUND', message: 'Resource not found', request_id: 'request-id-1' },
    });
    expect(faults).toEqual([]);
  });

  // Break caught: an error thrown by a client library (an SDK, an HTTP client) that carries a `status` of its own
  // becoming the API's answer. A 401 or 429 from a dependency is not a 401 or 429 for the caller of this API. Only
  // an error that says it is meant for the client (`expose`, as the body parser's errors do) keeps its status.
  it.each([401, 403, 409, 429])(
    'does not take the status %i of an error that is not meant for the client',
    (status) => {
      const { sent, faults } = filtered(Object.assign(new Error('dependency refused'), { status }));

      expect(sent.status).toBe(500);
      expect(faults).toHaveLength(1);
    },
  );

  it('keeps the status of an error that says it is meant for the client', () => {
    const tooLarge = Object.assign(new Error('request entity too large'), {
      status: 413,
      expose: true,
    });

    const { sent, faults } = filtered(tooLarge);

    expect(sent).toEqual({
      status: 413,
      body: { message: 'Payload Too Large', request_id: 'request-id-1' },
    });
    expect(faults).toEqual([]);
  });

  // Break caught: the filter throwing out of itself, which Express would answer with its own page.
  it('does not write a second answer when the first has already left', () => {
    const json = vi.fn();
    const response = {
      headersSent: true,
      getHeader: () => 'x',
      status: vi.fn(),
      json,
    } as unknown as Response;
    const host = {
      switchToHttp: () => ({ getResponse: () => response }),
    } as unknown as ArgumentsHost;
    const logger = { error: vi.fn() } as unknown as Logger;

    new AllExceptionsFilter(logger).catch(new Error('late'), host);

    expect(json).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledOnce();
  });
});

describe('AllExceptionsFilter: the platform’s own resources (S0.20, OB-55)', () => {
  const secret = 'postgres://melarc:hunter2@db.internal/melarc token=abc123';
  const operational: readonly [string, () => Error][] = [
    ['the request budget ran out', () => new BudgetExpiredError('request', 15_000)],
    [
      'a database time bound ended the work',
      () => new DatabaseDeadlineError('statement', '57014', { cause: new Error(secret) }),
    ],
    ['the pool is saturated', () => new PoolSaturatedError(64)],
    ['no connection became free', () => new AcquireTimeoutError(3_000)],
    ['the pool is closed', () => new PoolClosedError()],
  ];

  // Break caught: an outage answered as a defect (500, paged) or as the caller's mistake, or the answer carrying a hint to retry
  // that the platform has no value for.
  it.each(operational)(
    'answers a failure where %s with 503, no code, no Retry-After and fixed text',
    (_label, make) => {
      const { sent, headers, faults, warnings } = filtered(make());

      expect(sent.status).toBe(503);
      expect(sent.body).toEqual({ message: 'Service unavailable', request_id: 'request-id-1' });
      expect(headers['retry-after']).toBeUndefined();
      // Operational, not unexpected: it is a warning with the error, and it is not logged as an unhandled fault.
      expect(faults).toEqual([]);
      expect(warnings).toHaveLength(1);
    },
  );

  // Break caught: the typed error found only at the top of the chain. Inside the work a statement's failure arrives wrapped.
  it('answers 503 for an operational failure under a wrapper, and copies nothing of the chain into the body', () => {
    const wrapped = new Error(`Failed query: select 1 -- ${secret}`, {
      cause: new DatabaseDeadlineError('lock', '55P03', { cause: new Error(secret) }),
    });

    const { sent } = filtered(wrapped);

    expect(sent.status).toBe(503);
    expect(JSON.stringify(sent.body)).not.toContain('hunter2');
    expect(JSON.stringify(sent.body)).not.toContain('abc123');
  });

  // Break caught: a commit that may have happened answered "try again later". The owner's answer (11 October 2026): 500, no code,
  // no Retry-After, and a text of its own, so the caller can tell it from both the outage and an unexpected failure.
  it.each(['budget-expired', 'connection-lost', 'unrecognized-completion'] as const)(
    'answers a commit that may have happened (%s) with 500, no code, no Retry-After and its own text',
    (reason) => {
      const { sent, headers, faults, warnings } = filtered(
        new CommitOutcomeUnknownError(reason, { cause: new Error(secret) }),
      );

      expect(sent.status).toBe(500);
      expect(sent.body).toEqual({
        message: 'The outcome of the request could not be confirmed',
        request_id: 'request-id-1',
      });
      expect(headers['retry-after']).toBeUndefined();
      expect(JSON.stringify(sent.body)).not.toContain('hunter2');
      // It is logged as a fault, with the reason and no more, and not mistaken for an outage's warning.
      expect(warnings).toEqual([]);
      expect(faults).toHaveLength(1);
      expect(JSON.stringify(faults)).toContain(reason);
    },
  );

  // Break caught: the wire not telling the two apart. The unknown outcome and an unexpected failure are both 500, and only the
  // text says which: the outage is the only 503.
  it('keeps the three readings apart on the wire', () => {
    const outage = filtered(new PoolClosedError()).sent;
    const unknown = filtered(
      new CommitOutcomeUnknownError('connection-lost', {
        cause: new Error('gone'),
      }),
    ).sent;
    const unexpected = filtered(new Error('boom')).sent;

    expect(outage.status).toBe(503);
    expect(unknown.status).toBe(500);
    expect(unexpected.status).toBe(500);
    expect(
      new Set([outage.body?.message, unknown.body?.message, unexpected.body?.message]).size,
    ).toBe(3);
  });

  // Break caught: a definite rollback, which is a defect of the work, answered as an outage or as an unknown outcome.
  it('answers a definite rollback as any unexpected failure: 500, generic, and logged as a fault', () => {
    const { sent, faults } = filtered(
      new TransactionRolledBackError({ cause: new Error('first') }),
    );

    expect(sent.status).toBe(500);
    expect(sent.body).toEqual({ message: 'Internal server error', request_id: 'request-id-1' });
    expect(faults).toHaveLength(1);
  });

  // Break caught: a deliberate refusal that carries an operational error in its chain being rewritten as an outage.
  it('leaves an HttpException alone even when its cause is an outage', () => {
    const refusal = new NotFoundException('x', { cause: new PoolClosedError() });

    expect(filtered(refusal).sent.status).toBe(404);
  });
});

describe('AllExceptionsFilter: a refusal that carries a code', () => {
  // Break caught: a declared header (the Retry-After of TRUST_DATA_UNAVAILABLE) set on the exception and never sent, or sent on an
  // answer that did not ask for it.
  it('sends the declared headers of the exception with its code and status', () => {
    const { sent, headers } = filtered(
      new ApiException(ErrorCode.TrustDataUnavailable, 503, 'Not now', undefined, {
        'Retry-After': '30',
      }),
    );

    expect(sent.status).toBe(503);
    expect(sent.body).toEqual({
      code: 'TRUST_DATA_UNAVAILABLE',
      message: 'Not now',
      request_id: 'request-id-1',
    });
    expect(headers['retry-after']).toBe('30');
  });

  it('sends no header an exception did not carry', () => {
    const { sent, headers } = filtered(
      ApiException.of(ErrorCode.StateConflict, 'Not in that state'),
    );

    expect(sent.status).toBe(409);
    expect(headers).toEqual({});
  });
});

describe('AllExceptionsFilter: the end of work the pipeline answered for', () => {
  const alreadySent = (answeredByPipeline: boolean) => {
    const json = vi.fn();
    const response = {
      headersSent: true,
      locals: answeredByPipeline ? { pipelineAnswered: true } : {},
      getHeader: () => 'x',
      status: vi.fn(),
      json,
    } as unknown as Response;
    const host = {
      switchToHttp: () => ({ getResponse: () => response }),
    } as unknown as ArgumentsHost;
    const logger = { error: vi.fn(), warn: vi.fn() };
    return { host, logger, json };
  };
  const headersSent = Object.assign(
    new Error('Cannot set headers after they are sent to the client'),
    {
      code: 'ERR_HTTP_HEADERS_SENT',
    },
  );

  // Break caught: every request the pipeline had to answer for (its work outlasted the budget) ending in an "unhandled error" at
  // error level, with a stack, when the framework tried to send what the work finally returned. That is how such work ends.
  it('says once, as a warning, that the work ended and its result was not sent', () => {
    const { host, logger, json } = alreadySent(true);

    new AllExceptionsFilter(logger as unknown as Logger).catch(headersSent, host);

    expect(json).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  // Break caught: the allowance reaching a defect. Only the framework's refusal to write twice is expected; any other failure of the
  // work, or the same refusal on a request the pipeline did not answer, is still a fault.
  it.each([
    ['another failure of that work', true, new Error('the work failed after the answer')],
    ['the same refusal on a request the pipeline did not answer', false, headersSent],
  ])('still reports %s', (_label, answered, failure) => {
    const { host, logger } = alreadySent(answered);

    new AllExceptionsFilter(logger as unknown as Logger).catch(failure, host);

    expect(logger.error).toHaveBeenCalledOnce();
  });
});

describe('AllExceptionsFilter: a failure that arrives after the answer', () => {
  // Break caught: the pipeline answering a handler that outlasted its budget, and the handler's own failure then writing a second
  // answer over it (which throws out of the filter). The answer that left stands, and the failure is still logged.
  it.each([
    ['an outage', () => new BudgetExpiredError('request', 1_000), 'warn'],
    [
      'an unknown commit outcome',
      () => new CommitOutcomeUnknownError('connection-lost', { cause: new Error('gone') }),
      'error',
    ],
  ] as const)('writes no second answer for %s, and logs it', (_label, make, level) => {
    const json = vi.fn();
    const status = vi.fn();
    const response = {
      headersSent: true,
      getHeader: () => 'x',
      status,
      json,
    } as unknown as Response;
    const host = {
      switchToHttp: () => ({ getResponse: () => response }),
    } as unknown as ArgumentsHost;
    const logger = { error: vi.fn(), warn: vi.fn() } as unknown as Logger;

    new AllExceptionsFilter(logger).catch(make(), host);

    expect(json).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
    expect(logger[level]).toHaveBeenCalledOnce();
  });
});
