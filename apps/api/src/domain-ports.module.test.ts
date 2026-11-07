import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { riderRecordLookupSources } from './dispatch/rider-record-lookup.adapter.js';
import { pickupQueueCounters } from './pickup/pickup-queue-counters.adapter.js';
import { pickupRecordLookupSources } from './pickup/pickup-record-lookup.adapter.js';
import type { TransactionHandle } from './platform/auth/ports/unit-of-work.port.js';
import type { AuthorizedRequest } from './platform/authorization/authorized-request.js';
import type { OperationRunner } from './platform/authorization/operation-runner.js';
import type { DatabaseTransaction } from './platform/database/database.service.js';
import type { SecurityContext } from './platform/database/transaction-context.js';
import { registerTransactionFacts } from './platform/database/transaction-facts.js';
import { bindTransactionHandle } from './platform/database/transaction-handle.js';
import { ANY_HUB, QUEUE_IDS, type QueueId } from './platform/domain-ports/queue-counter.port.js';
import {
  RECORD_LOOKUP_KINDS,
  type RecordLookupKind,
} from './platform/domain-ports/record-lookup.port.js';
import { lookupQueryOf } from './platform/lookup/lookup-query.js';
import { QueueSummaryService } from './platform/queue-summary/queue-summary.service.js';
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

/**
 * The column that is the hub of the records of each queue, which a count with a hub narrows by (task C3, `AC-HUBF-04`): the hub a pickup request
 * and a run answer to is `responsible_hub_id`, the hub of a staff profile is its `primary_hub_id` (as the staff list's own `hub_id` reads it). A
 * closed record over the queues of the contract, so that a queue added to the list has to say here whose hub it counts by, and cannot be added
 * without a hub filter that this file reads.
 */
const HUB_COLUMN_OF: Readonly<Record<QueueId, string>> = {
  PICKUP_AWAITING_CONFIRMATION: 'responsible_hub_id',
  PICKUP_CUTOFF_REVIEW: 'responsible_hub_id',
  PICKUP_EXCEPTION_APPROVAL: 'responsible_hub_id',
  PICKUP_UNMANIFESTED_POOL: 'responsible_hub_id',
  PICKUP_RUNS_IN_PROGRESS: 'responsible_hub_id',
  STAFF_AWAITING_APPROVAL: 'primary_hub_id',
};

const CONTEXT: SecurityContext = {
  principalType: 'STAFF',
  principalId: '11111111-1111-4111-8111-111111111111',
  surface: 'OPS_PORTAL',
  hubScopeMode: 'SET',
  authorizedHubIds: [],
  correlationId: 'c3',
};

/** A handle over a transaction that runs nothing and keeps each statement it is given, so that what a counter asks of the database can be read. */
function recording(): { readonly handle: TransactionHandle; readonly statements: SQL[] } {
  const statements: SQL[] = [];
  const transaction = {
    execute: (statement: SQL) => {
      statements.push(statement);
      return Promise.resolve({ rows: [{ count: 0, oldest: null }] });
    },
  } as unknown as DatabaseTransaction;
  registerTransactionFacts(transaction, {
    statementsSinceContext: () => statements.length,
    markContextApplied: () => undefined,
    appliedContext: () => CONTEXT,
  });
  return { handle: bindTransactionHandle(transaction), statements };
}

/** What each comparison of `column` with a bound, `uuid`-cast value is bound to, in the order they stand in the statement the counter ran. */
function hubComparisons(statement: SQL | undefined, column: string): unknown[] {
  if (statement === undefined) throw new Error('The counter ran no statement');
  const { sql: text, params } = new PgDialect().sqlToQuery(statement);
  return [...text.matchAll(new RegExp(`\\b${column}\\s*=\\s*\\$(\\d+)::uuid`, 'g'))].map(
    (match) => params[Number(match[1]) - 1],
  );
}

const A_HUB = '0191a4f8-6c2e-7a3e-8f10-5d6c7b8a9e01';

/** The work a read hands the runner: what runs on the handle of the transaction the runner opened. */
type WorkOf = (handle: TransactionHandle, decision: AuthorizedRequest) => Promise<unknown>;

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

  // Break caught: a queue, of any domain, whose counter takes the filter and does not narrow by it (a count of every hub beside a list of one, which the
  // comparison of a count with its list cannot see, both being written from one function), or narrows by the wrong column, or by it twice, or by a hub
  // that is not the one asked for (task C3, `AC-HUBF-04`, `-06`): each of the six counts its table by its own hub column, bound to the hub of the filter.
  it.each(QUEUE_IDS.map((queue) => [queue] as const))(
    '%s counts the hub it is given, by the hub column of its records',
    async (queue) => {
      const counter = counters.find((each) => each.queue === queue);
      const { handle, statements } = recording();

      await counter?.count(handle, { hubId: A_HUB });

      expect(statements).toHaveLength(1);
      expect(hubComparisons(statements[0], HUB_COLUMN_OF[queue])).toEqual([A_HUB]);
    },
  );

  // Break caught: a counter that is given no hub and still binds one (a default of its own, or the hub of an earlier count): without a hub each counts
  // every hub the session's grant of its list's key reaches, as it always did (`AC-HUBF-11`).
  it.each(QUEUE_IDS.map((queue) => [queue] as const))(
    '%s binds no hub when it is given none',
    async (queue) => {
      const counter = counters.find((each) => each.queue === queue);
      const { handle, statements } = recording();

      await counter?.count(handle, { hubId: A_HUB });
      await counter?.count(handle, ANY_HUB);

      expect(statements).toHaveLength(2);
      expect(
        hubComparisons(statements[1], HUB_COLUMN_OF[queue]).every((value) => value === null),
      ).toBe(true);
    },
  );

  // Break caught: a count whose filter has no list to be the filter of (a counter taking a hub that its list does not take, so that "the count is
  // what the list returns" has nothing to be compared with): each list the queues follow declares `hub_id` in the contract, as a query parameter.
  it.each(QUEUE_IDS.map((queue) => [queue] as const))(
    'the list %s follows takes the same hub as a filter, in the contract',
    (queue) => {
      const listed = Object.values(contract.paths)
        .flatMap((item) => Object.values(item))
        .find((operation) => operation.operationId === FOLLOWS[queue].list) as
        { parameters?: { name?: string; in?: string }[] } | undefined;
      const hub = listed?.parameters?.find((parameter) => parameter.name === 'hub_id');

      expect(hub, FOLLOWS[queue].list).toMatchObject({ name: 'hub_id', in: 'query' });
    },
  );

  // Break caught: a hub that is handed down some links of the chain and not all (the service to its counters, a counter to its statement, a statement
  // to the criteria its list also calls): through the real service and the real counters of both domains, the statement each of the six queues
  // runs, in the two transactions the keys need, is the one of the hub the read was asked for (`AC-HUBF-04`).
  it('gives the hub of the filter to the statement of every queue, from the service down', async () => {
    const { handle, statements } = recording();
    // A session that holds the four keys, each at its own hubs: every queue is the session's, in two groups (pickup.read, staff.read).
    const authorized = {
      session: {
        principalType: 'STAFF',
        principalId: '11111111-1111-4111-8111-111111111111',
        authority: {
          snapshot: {
            grants: [
              'pickup.read',
              'pickup.exception.approve',
              'staff.read',
              'staff.identity.approve',
            ].map((permission) => ({
              permission,
              hubScope: 'own',
              ownershipScope: 'any',
              tier: 'A',
            })),
          },
          authorizedHubIds: [A_HUB],
        },
      },
    } as unknown as AuthorizedRequest;
    const service = new QueueSummaryService({
      runner: {
        read: (decision: AuthorizedRequest, _correlationId: string, work: WorkOf) =>
          work(handle, decision),
      } as unknown as Pick<OperationRunner, 'read'>,
      counters,
      limitStatements: () => Promise.resolve(),
    });

    const answer = await service.read(authorized, 'c3', { hubId: A_HUB });

    expect(answer.queues.map((entry) => entry.queue)).toEqual([...QUEUE_IDS]);
    expect(statements).toHaveLength(QUEUE_IDS.length);
    // The statements are in the order the queues were counted in: the five of pickup.read, then the one of staff.read, which is the contract's order.
    expect(
      QUEUE_IDS.map((queue, at) => hubComparisons(statements[at], HUB_COLUMN_OF[queue])),
    ).toEqual(QUEUE_IDS.map(() => [A_HUB]));
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
