import { describe, expect, it } from 'vitest';

import { DeliveryNotQueueableError } from '../../delivery/delivery-errors.js';
import type { TransactionHandle } from '../ports/unit-of-work.port.js';
import type { LiveRecovery } from './recovery-request-store.js';
import { absorbingLink, RecoveryRequestService } from './recovery-request.service.js';

const live = (id: string, withinGuard: boolean): LiveRecovery => ({
  id,
  principalType: 'STAFF',
  principalId: '11111111-1111-4111-8111-111111111111',
  channel: 'EMAIL',
  state: 'PENDING',
  issuedAt: new Date(),
  expiresAt: new Date(Date.now() + 60_000),
  initiatedBy: null,
  consumedAt: null,
  withinGuard,
});

describe('which live link absorbs a request (credential-recovery.md section 5.5)', () => {
  // Break caught: a request issued inside the guard, or as a third live link, or one coalesced while a new link may still be issued.
  it('is the newest live link inside the guard or at the cap of two, and none otherwise', () => {
    expect(absorbingLink([])).toBeUndefined();
    expect(absorbingLink([live('a', false)])).toBeUndefined();
    expect(absorbingLink([live('a', true)])?.id).toBe('a');
    expect(absorbingLink([live('b', false), live('a', false)])?.id).toBe('b');
    expect(absorbingLink([live('b', true), live('a', false)])?.id).toBe('b');
  });
});

describe('a request whose message the queue refuses', () => {
  // Break caught: an eligible principal whose registered address cannot be queued answered with an error (which an unknown one never
  // gets), or its request kept without a message.
  it('is excluded like an unknown identifier: the transaction is taken back and the request counted', async () => {
    const counted: unknown[] = [];
    let rolledBack = false;
    const handle = {} as TransactionHandle;
    const service = new RecoveryRequestService({
      unitOfWork: {
        run: async <T>(
          _context: unknown,
          work: (transaction: TransactionHandle) => Promise<T>,
        ): Promise<T> => {
          try {
            return await work(handle);
          } catch (error) {
            rolledBack = true;
            throw error;
          }
        },
      },
      directory: {
        findStaffByCanonicalEmail: () =>
          Promise.resolve({
            ref: { type: 'STAFF', id: '11111111-1111-4111-8111-111111111111' },
            status: 'ACTIVE',
            credentialGeneration: 1,
            credentialEstablishedAt: new Date(),
            bundleId: 'b',
            authorizedHubIds: [],
          }),
        findVendorAccountByIdentifier: () => Promise.resolve(null),
        lockIdentity: (_transaction, ref) =>
          Promise.resolve({
            ref,
            status: 'ACTIVE',
            credentialGeneration: 1,
            credentialEstablishedAt: new Date(),
            bundleId: 'b',
            authorizedHubIds: [],
          }),
        recoveryEligible: () => Promise.resolve(true),
        registeredChannel: () =>
          Promise.resolve({ channel: 'EMAIL', destination: 'ama@example.test' }),
      },
      store: {
        liveOf: () => Promise.resolve([]),
        issue: () =>
          Promise.reject(new DeliveryNotQueueableError('REQUEST_INVALID', 'destination')),
      },
      settings: { integer: () => Promise.resolve(60) },
      audit: {
        write: () =>
          Promise.reject(new Error('no event is written for a request that was taken back')),
      },
      metrics: { increment: (name, labels) => counted.push({ name, labels }) },
      links: {
        STAFF: (token) => `https://ops/recovery/complete#token=${token}`,
        VENDOR: (token) => token,
      },
    });

    expect(await service.request({ principalType: 'STAFF', identifier: 'ama@example.test' })).toBe(
      'EXCLUDED',
    );
    expect(rolledBack).toBe(true);
    expect(counted).toEqual([
      {
        name: 'credential_recovery_requests_excluded_total',
        labels: { outcome: 'UNKNOWN_OR_INELIGIBLE' },
      },
    ]);
  });
});
