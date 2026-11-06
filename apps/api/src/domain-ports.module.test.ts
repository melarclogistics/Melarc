import { describe, expect, it } from 'vitest';

import { pickupQueueCounters } from './pickup/pickup-queue-counters.adapter.js';
import { QUEUE_IDS, type QueueId } from './platform/domain-ports/queue-counter.port.js';
import { staffQueueCounters } from './staff/staff-queue-counter.adapter.js';
import { loadContract } from './test-support/contract.js';

/**
 * The counters of the queues against the contract that names them (task C1): `getQueueSummary` is gated by the keys of the lists it
 * follows, and a counter that names another key than its list's would quietly widen or narrow what a session is told. The contract is the
 * one place that says which key each operation takes (`x-permission`), and the conformance check holds the routes to it, so the counters are
 * held to the contract here.
 */
interface ContractDocument {
  readonly paths: Readonly<Record<string, Readonly<Record<string, { operationId?: string }>>>>;
  readonly components: {
    readonly schemas: { readonly QueueId: { readonly enum: readonly string[] } };
  };
}

const contract = loadContract() as unknown as ContractDocument;

function permissionOf(operationId: string): string {
  for (const item of Object.values(contract.paths)) {
    for (const operation of Object.values(item)) {
      if (operation.operationId === operationId) {
        const permission = (operation as { 'x-permission'?: string })['x-permission'];
        if (permission === undefined) throw new Error(`${operationId} names no permission`);
        return permission;
      }
    }
  }
  throw new Error(`The contract has no operation ${operationId}`);
}

/** The list each queue is counted from, and the operation that decides the work of an approver's queue (none for the others). */
const FOLLOWS: Readonly<Record<QueueId, { readonly list: string; readonly decision?: string }>> = {
  PICKUP_AWAITING_CONFIRMATION: { list: 'listPickupRequests' },
  PICKUP_CUTOFF_REVIEW: { list: 'listPickupRequests' },
  PICKUP_EXCEPTION_APPROVAL: { list: 'listPickupRequests', decision: 'approveOnePackageException' },
  PICKUP_UNMANIFESTED_POOL: { list: 'listPickupRequests' },
  PICKUP_RUNS_IN_PROGRESS: { list: 'listPickupManifests' },
  STAFF_AWAITING_APPROVAL: { list: 'listStaffIdentities', decision: 'approveStaffIdentity' },
};

const counters = [...pickupQueueCounters(), ...staffQueueCounters()];

describe('the counters of the queues', () => {
  // Break caught: a queue the contract names that no domain counts (it would never appear), or a counter for a queue the contract does not name.
  it('are one for each queue of the contract’s closed list, and no other', () => {
    expect(counters.map((counter) => counter.queue).toSorted()).toEqual([...QUEUE_IDS].toSorted());
    expect(contract.components.schemas.QueueId.enum).toEqual([...QUEUE_IDS]);
  });

  // Break caught: a counter gated by another key than the list it follows (a count that reaches what the list would refuse, or that hides
  // what it would show), or by a decision key that is not the key of the decision.
  it.each(QUEUE_IDS.map((queue) => [queue] as const))(
    '%s is gated by the key of its list and, for an approver’s queue, by the key of the decision',
    (queue) => {
      const counter = counters.find((each) => each.queue === queue);
      const follows = FOLLOWS[queue];
      expect(counter?.listKey).toBe(permissionOf(follows.list));
      expect(counter?.decisionKey).toBe(
        follows.decision === undefined ? undefined : permissionOf(follows.decision),
      );
    },
  );

  // Break caught: a counter whose decision key is the list's own key, which would make "the work of an approver" mean "anyone who reads".
  it('name a decision key that is not the key of the list they follow', () => {
    for (const counter of counters) {
      if (counter.decisionKey !== undefined) expect(counter.decisionKey).not.toBe(counter.listKey);
    }
  });
});
