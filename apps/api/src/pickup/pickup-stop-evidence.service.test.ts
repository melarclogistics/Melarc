import { describe, expect, it } from 'vitest';

import type { AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import { ApiException } from '../platform/http/api-exception.js';
import { PickupStopEvidence, type StopEvidenceFilter } from './pickup-stop-evidence.service.js';

/**
 * What `listPickupStopEvidence` refuses before it reads anything (S1.30). The contract's validation answers most of these first, on the route, and the guard refuses a vendor and a rider; the
 * service states them again because it is the one place that knows what a query may hold, and a read that trusted its caller to have checked would hand a bad value to a statement. The route
 * test proves what a client sees; this proves the refusal and that nothing was asked of the database.
 */
const AUDIT = {} as AuditWriter;
const STOP = '0191a4f8-6c2e-7a3e-8f10-5d6c7b8a9e01';

const principal = (principalType: string): AuthorizedRequest =>
  ({
    session: { principalType, principalId: '11111111-1111-4111-8111-111111111111' },
    scope: { hubScopeMode: 'SET', authorizedHubIds: [] },
  }) as unknown as AuthorizedRequest;

/** A runner that notes each read it is asked for. */
function evidence(): { readonly under: PickupStopEvidence; readonly reads: () => number } {
  let reads = 0;
  const runner = {
    read: () => {
      reads += 1;
      return Promise.resolve({});
    },
  } as unknown as Pick<OperationRunner, 'read'>;
  return { under: new PickupStopEvidence({ runner, audit: AUDIT }), reads: () => reads };
}

async function refusal(
  filter: StopEvidenceFilter,
  over: { readonly stop?: string; readonly caller?: AuthorizedRequest } = {},
): Promise<{ readonly error: unknown; readonly reads: number }> {
  const { under, reads } = evidence();
  const error = await under
    .list(over.caller ?? principal('STAFF'), 'correlation', over.stop ?? STOP, filter)
    .then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
  return { error, reads: reads() };
}

describe('what the evidence of a stop refuses before it reads anything', () => {
  // Break caught: a read of the evidence of a stop answered to a vendor or a rider (the guard refuses them first; this is the second line), or answered after a statement was made.
  it.each(['VENDOR', 'RIDER'])('refuses a %s session with no statement', async (type) => {
    const { error, reads } = await refusal({}, { caller: principal(type) });
    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).getStatus()).toBe(403);
    expect(reads).toBe(0);
  });

  // Break caught: an identifier that is not a UUID handed to a statement (a cast error that is a server error), or the place of the mistake not named.
  it('refuses a stop that is not an identifier, naming the path, with no statement', async () => {
    const { error, reads } = await refusal({}, { stop: 'not-an-id' });
    expect((error as ApiException).getStatus()).toBe(400);
    expect((error as ApiException).details).toEqual({
      violations: [{ in: 'path', pointer: '/id', rule: 'format' }],
    });
    expect(reads).toBe(0);
  });

  // Break caught: a page size outside the range served as the default, a purpose that is not one served as "all", or a position that is not one served as the first page: each would
  // hide the mistake of a client.
  it.each([
    [{ pageSize: 0 }, 'page_size', 'range'],
    [{ pageSize: 101 }, 'page_size', 'range'],
    [{ pageSize: 1.5 }, 'page_size', 'range'],
    [{ pageSize: Number.NaN }, 'page_size', 'range'],
    [{ purpose: 'CONDITION' }, 'purpose', 'enum'],
    [{ purpose: '' }, 'purpose', 'enum'],
    [{ pageToken: 'not-a-position' }, 'page_token', 'format'],
  ] as const)('refuses %j, naming the parameter, with no statement', async (filter, name, rule) => {
    const { error, reads } = await refusal(filter);
    expect((error as ApiException).getStatus()).toBe(400);
    expect((error as ApiException).details).toEqual({
      violations: [{ in: 'query', pointer: `/${name}`, rule }],
    });
    expect(reads).toBe(0);
  });

  // Break caught: a valid query refused, or answered with no statement (the guard of the validation too strict).
  it('reads once for a query that is valid', async () => {
    const { under, reads } = evidence();
    await under.list(principal('STAFF'), 'correlation', STOP, {
      purpose: 'PARCEL_PHOTO',
      pageSize: 100,
    });
    expect(reads()).toBe(1);
  });
});
