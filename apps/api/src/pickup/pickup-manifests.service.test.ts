import { describe, expect, it } from 'vitest';

import type { AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import { ApiException } from '../platform/http/api-exception.js';
import { PICKUP_MANIFEST_STATES } from './pickup-manifest.schema.js';
import {
  PickupManifestsService,
  type PickupManifestListFilter,
} from './pickup-manifests.service.js';

/**
 * What the manifest list refuses before it reads anything (OB-S1-25). The contract's validation answers these first, on the route (the
 * database test of the list proves the answer a client sees, in the platform's form); the service states them again because it is the one
 * place that knows what a filter may hold, and a read that trusted its caller to have checked would pass a bad value on to a statement.
 * This proves the refusal, with no statement attempted.
 */
const AUTHORIZED = {} as AuthorizedRequest;
const AUDIT = {} as AuditWriter;

/** A runner that notes that a read was attempted and answers an empty page. */
function service(): { readonly manifests: PickupManifestsService; readonly reads: () => number } {
  let reads = 0;
  const runner = {
    read: () => {
      reads += 1;
      return Promise.resolve({ items: [], next_page_token: null });
    },
  } as unknown as Pick<OperationRunner, 'read'>;
  return {
    manifests: new PickupManifestsService({ runner, audit: AUDIT }),
    reads: () => reads,
  };
}

const refusal = async (filter: Parameters<PickupManifestsService['list']>[2]) => {
  const { manifests, reads } = service();
  const error = await manifests.list(AUTHORIZED, 'correlation', filter).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(reads(), 'no statement was attempted').toBe(0);
  return error;
};

describe('the manifest list refuses what no filter may hold, before it reads (OB-S1-25)', () => {
  // Break caught: a state taken on trust and handed to a statement, where it would answer an empty list for a mistake and hide it.
  it.each([
    ['a state that is not one', 'NOPE'],
    ['a lower-case state', 'draft'],
    ['an empty state', ''],
    ['a state with a space after it', 'DRAFT '],
  ])('refuses %s', async (_what, state) => {
    const error = await refusal({ state });
    expect(error).toBeInstanceOf(ApiException);
    const refused = error as ApiException;
    expect(refused.code).toBe('VALIDATION_FAILED');
    expect(refused.getStatus()).toBe(400);
    expect(refused.details).toEqual({
      violations: [{ in: 'query', pointer: '/state', rule: 'enum' }],
    });
  });

  // Break caught: a day taken on trust: one that does not exist, is not written as the contract writes it, or carries more than a day.
  it.each([
    ['a day that does not exist', '2031-02-30'],
    ['the 29th of February of a year that is not a leap year', '2031-02-29'],
    ['the 31st of a month of thirty days', '2031-06-31'],
    ['a month that does not exist', '2031-13-01'],
    ['a month of zero', '2031-00-10'],
    ['a day of zero', '2031-06-00'],
    ['a day without its zeros', '2031-6-2'],
    ['text that is not a day', 'not-a-date'],
    ['an empty day', ''],
    ['a day with a time', '2031-06-02T00:00:00Z'],
  ])('refuses %s', async (_what, serviceDate) => {
    const error = await refusal({ serviceDate });
    expect(error).toBeInstanceOf(ApiException);
    const refused = error as ApiException;
    expect(refused.code).toBe('VALIDATION_FAILED');
    expect(refused.getStatus()).toBe(400);
    expect(refused.details).toEqual({
      violations: [{ in: 'query', pointer: '/service_date', rule: 'format' }],
    });
  });

  // Break caught: a refusal that is too wide, which would turn a legitimate filter into a 400.
  const ACCEPTED: readonly (readonly [string, PickupManifestListFilter])[] = [
    ['no filter at all', {}],
    ...PICKUP_MANIFEST_STATES.map((state): readonly [string, PickupManifestListFilter] => [
      `the state ${state}`,
      { state },
    ]),
    ['a day', { serviceDate: '2031-06-02' }],
    ['the 29th of February of a leap year', { serviceDate: '2032-02-29' }],
    ['a state and a day', { state: 'DISPATCHED', serviceDate: '2031-06-02' }],
  ];
  it.each(ACCEPTED)('goes on to read with %s', async (_what, filter) => {
    const { manifests, reads } = service();
    await expect(manifests.list(AUTHORIZED, 'correlation', filter)).resolves.toEqual({
      items: [],
      next_page_token: null,
    });
    expect(reads()).toBe(1);
  });
});
