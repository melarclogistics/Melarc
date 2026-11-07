import { describe, expect, it } from 'vitest';

import { QUEUE_IDS } from './queue-summary-shape';
import { QUEUE_CHANGING_ACTS, QUEUE_NEUTRAL_CALLS, changesAQueue } from './queue-changing-acts';

describe('the acts that can change a queue', () => {
  // Break caught: an act that the decision names left out of the table: the menu's counts and My work would lag it. One case for each, by name.
  it.each([
    ['confirm', 'POST', '/pickup-requests/{id}/confirm'],
    ['cancel', 'POST', '/pickup-requests/{id}/cancel'],
    [
      'approve or decide an exception',
      'POST',
      '/pickup-requests/{id}/one-package-exception/approve',
    ],
    ['decide a late booking', 'POST', '/pickup-requests/{id}/cutoff-exception'],
    ['build a run', 'POST', '/pickup-manifests'],
    ['assign a run', 'POST', '/pickup-manifests/{id}/assign-rider'],
    ['dispatch a run', 'POST', '/pickup-manifests/{id}/dispatch'],
    ['cancel a run', 'POST', '/pickup-manifests/{id}/cancel'],
    ['approve or reject a staff profile', 'POST', '/staff-identities/{id}/approve'],
  ])('includes the act the Product Owner named: %s', (_act, method, path) => {
    expect(changesAQueue(method, path)).toBe(true);
  });

  // Break caught: an act that adds to a queue (a new booking, a requested exception, a new profile) forgotten because it is not an
  // "approve" or a "cancel": the person who just booked a pickup would be told by the menu that nothing is waiting.
  it.each([
    ['book a pickup', 'POST', '/pickup-requests'],
    ['request an exception', 'POST', '/pickup-requests/{id}/one-package-exception'],
    ['add a staff profile', 'POST', '/staff-identities'],
  ])('includes the act that adds to a queue: %s', (_act, method, path) => {
    expect(changesAQueue(method, path)).toBe(true);
  });

  // Break caught: the table matching on the path alone (a read of the same address) or on the method alone.
  it('matches the method and the path together', () => {
    expect(changesAQueue('GET', '/pickup-requests')).toBe(false);
    expect(changesAQueue('DELETE', '/pickup-requests/{id}/confirm')).toBe(false);
    expect(changesAQueue('POST', '/pickup-requests/{id}')).toBe(false);
    expect(changesAQueue('POST', '/pickup-requests/123/confirm')).toBe(false);
    expect(changesAQueue('post', '/pickup-requests')).toBe(false);
  });

  it.each(QUEUE_NEUTRAL_CALLS.map((call) => [call.operation, call.method, call.path] as const))(
    'leaves out %s, which changes no queue',
    (_operation, method, path) => {
      expect(changesAQueue(method, path)).toBe(false);
    },
  );

  // Break caught: one call in both tables, which says two things about it.
  it('lists no call twice, and none in both tables', () => {
    const keys = [...QUEUE_CHANGING_ACTS, ...QUEUE_NEUTRAL_CALLS].map(
      (call) => `${call.method} ${call.path}`,
    );

    expect(new Set(keys).size).toBe(keys.length);
    const operations = [...QUEUE_CHANGING_ACTS, ...QUEUE_NEUTRAL_CALLS].map(
      (call) => call.operation,
    );
    expect(new Set(operations).size).toBe(operations.length);
  });

  // Break caught: an act that says why it is here and moves no queue, without being one the decision names: a table of acts that is not a
  // table of what the queues count is a list nobody can check.
  it('names a queue that each act can move, except the two the decision names that no queue counts yet', () => {
    const withoutQueue = QUEUE_CHANGING_ACTS.filter((act) => act.queues.length === 0).map(
      (act) => act.operation,
    );

    expect(withoutQueue.toSorted()).toEqual(['assignRider', 'dispatchManifest']);
    for (const act of QUEUE_CHANGING_ACTS) {
      for (const queue of act.queues) expect(QUEUE_IDS).toContain(queue);
      expect(act.why.length, act.operation).toBeGreaterThan(20);
    }
  });

  // Break caught: a queue that no act can change: its count would be read on load and never after an act, which is the lag this removes.
  it('leaves no queue that nothing in the portal can change out of the table', () => {
    const moved = new Set(QUEUE_CHANGING_ACTS.flatMap((act) => act.queues));

    for (const queue of QUEUE_IDS) expect(moved, queue).toContain(queue);
  });
});
