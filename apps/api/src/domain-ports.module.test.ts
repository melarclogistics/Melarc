import { describe, expect, it } from 'vitest';

import { riderRecordLookupSources } from './dispatch/rider-record-lookup.adapter.js';
import { pickupQueueCounters } from './pickup/pickup-queue-counters.adapter.js';
import { pickupRecordLookupSources } from './pickup/pickup-record-lookup.adapter.js';
import { QUEUE_IDS, type QueueId } from './platform/domain-ports/queue-counter.port.js';
import {
  RECORD_LOOKUP_KINDS,
  type RecordLookupKind,
} from './platform/domain-ports/record-lookup.port.js';
import { lookupQueryOf } from './platform/lookup/lookup-query.js';
import { staffQueueCounters } from './staff/staff-queue-counter.adapter.js';
import { staffRecordLookupSources } from './staff/staff-record-lookup.adapter.js';
import { loadContract } from './test-support/contract.js';
import { vendorRecordLookupSources } from './vendor/vendor-record-lookup.adapter.js';

/**
 * The counters of the queues against the contract that names them (task C1): `getQueueSummary` is gated by the keys of the lists it
 * follows, and a counter that names another key than its list's would quietly widen or narrow what a session is told. The contract is the
 * one place that says which key each operation takes (`x-permission`), and the conformance check holds the routes to it, so the counters are
 * held to the contract here.
 */
interface ContractDocument {
  readonly paths: Readonly<Record<string, Readonly<Record<string, { operationId?: string }>>>>;
  readonly components: {
    readonly schemas: {
      readonly QueueId: { readonly enum: readonly string[] };
      readonly RecordLookupKind: { readonly enum: readonly string[] };
    };
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

/** The read that opens each kind of record the lookup finds: the lookup searches a kind under the key of that read, and no other. */
const OPENED_BY: Readonly<Record<RecordLookupKind, string>> = {
  PICKUP_REQUEST: 'getPickupRequest',
  PICKUP_MANIFEST: 'getPickupManifest',
  VENDOR_ACCOUNT: 'getVendorAccount',
  RIDER: 'getRider',
  STAFF_IDENTITY: 'getStaffIdentity',
};

const lookupSources = [
  ...pickupRecordLookupSources(),
  ...vendorRecordLookupSources(),
  ...riderRecordLookupSources(),
  ...staffRecordLookupSources(),
];

/** Every kind in the order the lookup lists them but those given. */
function allBut(left: readonly RecordLookupKind[]): readonly RecordLookupKind[] {
  return RECORD_LOOKUP_KINDS.filter((kind) => !left.includes(kind));
}

function failure(): never {
  throw new Error('the text is not a query');
}

describe('the sources of the global lookup', () => {
  // Break caught: a kind the contract names that no domain searches (it would never appear), a source for a kind the contract does not name, or
  // two sources for one kind.
  it('are one for each kind of the contract’s closed list, and no other', () => {
    expect(lookupSources.map((source) => source.kind).toSorted()).toEqual(
      [...RECORD_LOOKUP_KINDS].toSorted(),
    );
    expect(contract.components.schemas.RecordLookupKind.enum).toEqual([...RECORD_LOOKUP_KINDS]);
  });

  // Break caught: a source that says it cannot answer a query its search can (a record that was found before is now missed, with no error), or
  // one that says it can answer what it cannot (a transaction opened for nothing). Each row is a question the people at the desk ask.
  it.each([
    ['a request code', 'ACC-PR-7KQ2MZ', ['PICKUP_REQUEST']],
    ['a run code, in lower case', 'acc-mf-8wxh4t', ['PICKUP_MANIFEST']],
    ['a code of a record type with no page', 'ACC-IN-AAAAAA', []],
    ['a phone number typed in full', '024 111 2222', ['PICKUP_REQUEST', 'RIDER']],
    ['a part of a phone number, which is a name', '024 111', allBut(['PICKUP_MANIFEST'])],
    ['a name', 'Kofi Mensah', allBut(['PICKUP_MANIFEST'])],
    ['a vendor account identifier, which is a name too', 'K7M2P9XQ', allBut(['PICKUP_MANIFEST'])],
  ] as const)('asks %s of the kinds that can answer it: %j', (_what, text, kinds) => {
    const query = lookupQueryOf(text);
    expect(query).toBeDefined();
    expect(
      lookupSources
        .filter((source) => source.answers(query ?? failure()))
        .map((source) => source.kind),
    ).toEqual(kinds);
  });

  // Break caught: a kind searched under another key than the read that opens it (a result the session could not open, or a record hidden
  // that it could): the scope of a result must be the scope of that kind's own read.
  it.each(RECORD_LOOKUP_KINDS.map((kind) => [kind] as const))(
    '%s is searched under the key of the read that opens it',
    (kind) => {
      const source = lookupSources.find((each) => each.kind === kind);
      expect(source?.readKey).toBe(permissionOf(OPENED_BY[kind]));
    },
  );
});
