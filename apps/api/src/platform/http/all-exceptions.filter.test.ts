import { HttpException, NotFoundException, type ArgumentsHost } from '@nestjs/common';
import type { Response } from 'express';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { AllExceptionsFilter } from './all-exceptions.filter.js';

interface Sent {
  status: number | undefined;
  body: Record<string, unknown> | undefined;
}

/** What the filter did with one exception: what it sent, and what it logged as a server fault. */
function filtered(exception: unknown): { sent: Sent; faults: unknown[] } {
  const sent: Sent = { status: undefined, body: undefined };
  const response = {
    headersSent: false,
    getHeader: () => 'request-id-1',
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
  const logger = { error: (fields: unknown) => faults.push(fields) } as unknown as Logger;
  const host = {
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ArgumentsHost;

  new AllExceptionsFilter(logger).catch(exception, host);
  return { sent, faults };
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
