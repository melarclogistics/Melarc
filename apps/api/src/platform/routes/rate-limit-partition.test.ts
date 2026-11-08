import 'reflect-metadata';

import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { describe, expect, it } from 'vitest';

import type { RateLimiter } from '../auth/ports/rate-limiter.port.js';
import { LimiterUnavailableError } from '../limiter/limiter-errors.js';
import { Anonymous, type AnonymousLimit } from './access-declaration.js';
import type { LimitPartitions } from './limit-partitions.js';
import { RateLimitGuard } from './rate-limit.guard.js';

/**
 * The partition step of the rate limit (S0.48; `AC-SLICE-000-19`): a limit that names a partition is keyed on what the partition reads of
 * the request beside the identifier's canonical form, and a partition the application was not composed with fails closed. The guard is
 * reached directly, on a fixture route, with a limiter and a partition that record what they are asked.
 */
const PARTITIONED: AnonymousLimit = {
  bucket: 'rate_limit_vendor_signin',
  identifier: { field: 'account_identifier', maxBytes: 64 },
  canonical: (raw) => raw.trim().toUpperCase(),
  partition: 'VENDOR_DEVICE',
};

/** A route whose declaration the guard reads, decorated as a controller's method is; it is never called. */
const handler = (): void => undefined;
const controller = (): void => undefined;
Anonymous(PARTITIONED)(controller, 'signIn', { value: handler });

function contextFor(body: unknown, headers: Record<string, string> = {}): ExecutionContext {
  const request = { body, headers } as unknown as Request;
  return {
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function recording(): { limiter: RateLimiter; asked: { bucket: string; key: string }[] } {
  const asked: { bucket: string; key: string }[] = [];
  return {
    asked,
    limiter: {
      admit: (bucket, key) => {
        asked.push({ bucket, key });
        return Promise.resolve({ allowed: true });
      },
    },
  };
}

describe('a limit keyed on a partition', () => {
  // Break caught: the partition ignored, so a vendor's two browsers share one bucket and invented cookie values each get their own.
  it('asks the limiter with the key the partition makes from the canonical identifier and the request', async () => {
    const { limiter, asked } = recording();
    const seen: { key: string; cookie: string | undefined }[] = [];
    const partitions: LimitPartitions = {
      VENDOR_DEVICE: (request, key) => {
        seen.push({ key, cookie: request.headers.cookie });
        return Promise.resolve(`${key}|device-1`);
      },
    };
    const guard = new RateLimitGuard(new Reflector(), limiter, partitions);

    expect(
      await guard.canActivate(
        contextFor({ account_identifier: ' abcd2345 ' }, { cookie: 'melarc_vendor_device=x' }),
      ),
    ).toBe(true);

    expect(seen).toEqual([{ key: 'ABCD2345', cookie: 'melarc_vendor_device=x' }]);
    expect(asked).toEqual([{ bucket: 'rate_limit_vendor_signin', key: 'ABCD2345|device-1' }]);
  });

  // Break caught: a partitioned route served on the identifier alone when its partition was not composed: the permissive fallback.
  it('fails closed when the application was composed without the partition', async () => {
    const { limiter, asked } = recording();
    const guard = new RateLimitGuard(new Reflector(), limiter, undefined);

    await expect(
      guard.canActivate(contextFor({ account_identifier: 'ABCD2345' })),
    ).rejects.toBeInstanceOf(LimiterUnavailableError);
    expect(asked).toEqual([]);
  });

  it('asks no partition for a request whose identifier cannot be taken', async () => {
    const { limiter, asked } = recording();
    let partitioned = 0;
    const guard = new RateLimitGuard(new Reflector(), limiter, {
      VENDOR_DEVICE: () => {
        partitioned += 1;
        return Promise.resolve('x');
      },
    });

    expect(await guard.canActivate(contextFor({ account_identifier: 7 }))).toBe(true);
    expect([partitioned, asked.length]).toEqual([0, 0]);
  });
});
