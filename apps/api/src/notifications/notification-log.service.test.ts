import { describe, expect, it } from 'vitest';

import type { AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import { ApiException } from '../platform/http/api-exception.js';
import { NotificationLogService } from './notification-log.service.js';
import { encodePageToken } from './notification-page-token.js';

/**
 * What the Ops message log refuses before it reads anything (S1.12e). The contract's validation answers most of these first, on the
 * route; the service states them again because it is the one place that knows what a filter may hold, and a read that trusted its caller
 * to have checked would pass a bad value on to a statement. The route test proves the answer a client sees; this proves the refusal.
 */
const AUTHORIZED = {} as AuthorizedRequest;
const AUDIT = {} as AuditWriter;

/** A runner that fails the test if a read is attempted, or notes that it was and answers an empty page. */
function service(): { readonly log: NotificationLogService; readonly reads: () => number } {
  let reads = 0;
  const runner = {
    read: () => {
      reads += 1;
      return Promise.resolve({ items: [], next_page_token: null });
    },
  } as unknown as Pick<OperationRunner, 'read'>;
  return { log: new NotificationLogService({ runner, audit: AUDIT }), reads: () => reads };
}

const refusal = async (filter: Parameters<NotificationLogService['list']>[2]) => {
  const { log, reads } = service();
  const error = await log.list(AUTHORIZED, 'correlation', filter).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(reads(), 'no statement was attempted').toBe(0);
  return error;
};

describe('the Ops message log refuses what no filter may hold, before it reads', () => {
  // Break caught: a page size, a filter or a position taken on trust and handed to a statement.
  it.each([
    ['a page size of zero', { pageSize: 0 }, '/page_size'],
    ['a negative page size', { pageSize: -1 }, '/page_size'],
    ['a page size over the maximum', { pageSize: 101 }, '/page_size'],
    ['a page size that is not whole', { pageSize: 1.5 }, '/page_size'],
    ['a page size that is not a number', { pageSize: Number.NaN }, '/page_size'],
    ['a state that is not one', { state: 'SENDING' }, '/state'],
    ['a lower-case state', { state: 'queued' }, '/state'],
    ['an empty state', { state: '' }, '/state'],
    ['an audience that is not one', { audience: 'EVERYONE' }, '/audience'],
    ['a channel that is not one', { channel: 'PUSH' }, '/channel'],
    ['a subject that is not an id', { subjectId: 'not-a-uuid' }, '/subject_id'],
    ['a position that is not one', { pageToken: 'not-a-position' }, '/page_token'],
  ])('refuses %s', async (_what, filter, pointer) => {
    const error = await refusal(filter);
    expect(error).toBeInstanceOf(ApiException);
    const refused = error as ApiException;
    expect(refused.code).toBe('VALIDATION_FAILED');
    expect(refused.getStatus()).toBe(400);
    expect(refused.details).toMatchObject({ violations: [{ in: 'query', pointer }] });
  });

  // Break caught: a refusal that is too wide, which would turn a legitimate filter into a 400.
  it.each([
    ['no filter at all', {}],
    ['the largest page', { pageSize: 100 }],
    ['the smallest page', { pageSize: 1 }],
    [
      'every filter at once',
      {
        state: 'SUPPRESSED',
        audience: 'AD_HOC_SENDER',
        channel: 'SMS',
        subjectId: '0191a4f8-6c2e-7a3e-8f10-5d6c7b8a9e01',
      },
    ],
    [
      'a position a page made',
      {
        pageToken: encodePageToken({
          createdAt: '2026-10-28 10:00:00+00',
          id: '0191a4f8-6c2e-7a3e-8f10-5d6c7b8a9e01',
        }),
      },
    ],
  ])('goes on to read with %s', async (_what, filter) => {
    const { log, reads } = service();
    await expect(log.list(AUTHORIZED, 'correlation', filter)).resolves.toEqual({
      items: [],
      next_page_token: null,
    });
    expect(reads()).toBe(1);
  });
});
