import { describe, expect, it } from 'vitest';

import { fileContractSource } from '../platform/contract/contract-source.js';
import {
  COLLECTION_DISPUTE_SCHEMA,
  COLLECTION_SHORTFALL_SCHEMA,
  OPS_HANDSHAKE_SCHEMA,
  PICKUP_FAILURE_QUEUE_ITEM_SCHEMA,
} from './ops-work-list-schemas.js';
import {
  disputeViewOf,
  escalationViewOf,
  failureViewOf,
  opsHandshakeViewOf,
  shortfallViewOf,
  type CollectionDisputeRow,
  type CollectionShortfallRow,
  type OpsHandshakeRow,
  type PickupFailureRow,
} from './ops-work-list-views.js';

/**
 * The four items of the Ops work lists are closed projections (D-A3, OB-S1-70): they carry the members the contract names and no other, whatever else a row
 * holds, and each figure they carry is the row's. The closed list of fields is held to the contract's own, so that a member cannot grow in silently on either
 * side, and a member that a row holds and no reader may see (a phone number, a code's digest, a staff note, the position of a page) never reaches the wire.
 */
const contract = fileContractSource.load() as {
  components: {
    schemas: Record<string, { required: string[]; properties: Record<string, unknown> }>;
  };
};
const schemaOf = (name: string) => {
  const found = contract.components.schemas[name];
  if (found === undefined) throw new Error(`the contract has no schema ${name}`);
  return found;
};
const names = (members: object): string[] => Object.keys(members).toSorted();

const ID = (n: number): string => `0191a4f8-6c2e-7a3e-8f10-5d6c7b8a9e${String(n).padStart(2, '0')}`;
const CONTEXT = {
  pickup_stop_id: ID(1),
  pickup_manifest_id: ID(2),
  pickup_request_id: ID(3),
  responsible_hub_id: ID(4),
  request_code: 'ACC-20261103-0001',
  sender_name: 'Kofi Foods',
  position_text: '2026-11-03 09:30:00.123456+00',
  position_id: ID(9),
};
/** Members a row of the tables or of a join may hold and that no item may carry. */
const LEAK = {
  primary_phone: '+233200000000',
  contact_phone: '+233200000001',
  code_digest: 'deadbeef',
  code: '1234',
  note_of_ops: 'Phoned the vendor on the number we hold',
  raised_by: ID(8),
  version: 4,
  resolved_address: '12 Ring Road',
};

describe('the items hold the contract’s members and no other', () => {
  it.each([
    [
      'the code’s schema equals the contract’s, member for member',
      COLLECTION_DISPUTE_SCHEMA,
      'CollectionDisputeListItem',
    ],
    [
      'the code’s schema equals the contract’s, member for member',
      OPS_HANDSHAKE_SCHEMA,
      'OpsHandshake',
    ],
    [
      'the code’s schema equals the contract’s, member for member',
      COLLECTION_SHORTFALL_SCHEMA,
      'CollectionShortfall',
    ],
    [
      'the code’s schema equals the contract’s, member for member',
      PICKUP_FAILURE_QUEUE_ITEM_SCHEMA,
      'PickupFailureQueueItem',
    ],
  ] as const)('%s (%#)', (_what, code, name) => {
    const written = code as unknown as { required: string[]; properties: object };
    const stated = schemaOf(name);
    expect(names(written.properties)).toEqual(names(stated.properties));
    expect(written.required.toSorted()).toEqual(stated.required.toSorted());
    // Every member of an item is stated: a member that is optional is the exception, and the items have none at the top.
    expect(stated.required.toSorted()).toEqual(names(stated.properties));
  });

  // Break caught: a member a row holds copied to the wire (the vendor’s account, a phone number, a position, a digest), or a member of the contract left out.
  it('a dispute carries the contract’s members, whatever the row holds', () => {
    const row = {
      ...CONTEXT,
      ...LEAK,
      id: ID(10),
      vendor_organization_id: ID(5),
      state: 'OPEN',
      note: 'Two of the three parcels were not ours',
      created_at: new Date('2026-11-03T09:30:00.123Z'),
      resolved_at: null,
      stop_state: 'COLLECTED',
      declared_count: 3,
      collected_count: 3,
      variance: 'MATCH',
    } as unknown as CollectionDisputeRow;

    const item = disputeViewOf(row);

    expect(names(item)).toEqual(names(schemaOf('CollectionDisputeListItem').properties));
    expect(item).toMatchObject({
      note: 'Two of the three parcels were not ours',
      created_at: '2026-11-03T09:30:00.123Z',
      resolved_at: null,
      declared_count: 3,
      collected_count: 3,
    });
  });

  // Break caught: a moment printed as the driver gave it (a date object, or the text of the database), not as an instant.
  it('writes every moment as an instant in UTC, from a date or from text', () => {
    const base = {
      ...CONTEXT,
      id: ID(10),
      vendor_organization_id: ID(5),
      state: 'RESOLVED',
      note: 'n',
      stop_state: 'PARTIALLY_COLLECTED',
      declared_count: 3,
      collected_count: 2,
      variance: 'SHORT',
    };
    const fromDates = disputeViewOf({
      ...base,
      created_at: new Date('2026-11-03T09:30:00.000Z'),
      resolved_at: new Date('2026-11-04T08:00:00.000Z'),
    } as unknown as CollectionDisputeRow);
    const fromText = disputeViewOf({
      ...base,
      created_at: '2026-11-03T09:30:00.000Z',
      resolved_at: '2026-11-04T08:00:00.000Z',
    } as unknown as CollectionDisputeRow);

    expect(fromText).toEqual(fromDates);
    expect([fromDates.created_at, fromDates.resolved_at]).toEqual([
      '2026-11-03T09:30:00.000Z',
      '2026-11-04T08:00:00.000Z',
    ]);
  });

  // Break caught: a code, a digest or the Ops note on the wire; a limit invented where the platform holds none (a missing figure is never a number).
  it('a handshake carries the contract’s members and no code, no digest and no note of Ops’s', () => {
    const row = {
      ...CONTEXT,
      ...LEAK,
      id: ID(11),
      direction: 'VENDOR_ENTERED_RIDER_DISPLAYED',
      state: 'EXPIRED',
      stop_state: 'ARRIVED',
      routed_because: 'CODE_EXPIRED',
      expires_at: new Date('2026-11-03T09:45:00.000Z'),
      attempts: 2,
      attempt_limit: null,
      fallback_sends: 1,
      fallback_limit: null,
      channel: null,
      confirmed_at: null,
      authorised_by: null,
      created_at: new Date('2026-11-03T09:30:00.000Z'),
    } as unknown as OpsHandshakeRow;

    const item = opsHandshakeViewOf(row);

    expect(names(item)).toEqual(names(schemaOf('OpsHandshake').properties));
    expect(item.attempt_limit).toBeNull();
    expect(item.fallback_limit).toBeNull();
    expect(item.expires_at).toBe('2026-11-03T09:45:00.000Z');
  });

  // Break caught: the shortfall computed the wrong way round, a note that is absent shown as an empty string, or a member of the rider’s count left on the wire.
  it('a shortfall carries the contract’s members, the shortfall as declared less counted, and a missing note as null', () => {
    const row = {
      ...CONTEXT,
      ...LEAK,
      id: ID(12),
      declared_count: 5,
      collected_count: 3,
      variance_reason_snapshot: {
        reason_code: 'SOME_PARCELS_NOT_READY',
        label: 'Some parcels not ready',
        attribution: 'CUSTOMER',
      },
      office_notified_at: new Date('2026-11-03T09:31:00.000Z'),
      recorded_at: new Date('2026-11-03T09:31:00.000Z'),
      recorded_by: ID(6),
      stop_state: 'ARRIVED',
      run_state: 'IN_PROGRESS',
    } as unknown as CollectionShortfallRow;

    const plain = shortfallViewOf(row);
    const noted = shortfallViewOf({
      ...row,
      variance_reason_snapshot: {
        ...row.variance_reason_snapshot,
        note: 'Two cartons were still open',
      },
    });

    expect(names(plain)).toEqual(names(schemaOf('CollectionShortfall').properties));
    expect(plain.shortfall_count).toBe(2);
    expect(plain.note).toBeNull();
    expect(plain.reason).toEqual({
      code: 'SOME_PARCELS_NOT_READY',
      label: 'Some parcels not ready',
      attribution: 'CUSTOMER',
    });
    expect(noted.note).toBe('Two cartons were still open');
  });

  // Break caught: the members of a contact attempt copied wholesale (so that what the snapshot holds beside them reaches the wire), a note that is absent shown
  // as null, the contact attempts missing from a snapshot that has none shown as null, and the label and attribution left behind.
  it('a failure carries the contract’s members, copies each contact attempt member by member and shows none as an empty list', () => {
    const snapshot = {
      reason_code: 'PARCELS_NOT_PACKED',
      label: 'Parcels not packed',
      attribution: 'CUSTOMER',
      note: 'The parcels were not packed when the rider came',
      reported_at: '2026-11-03T09:30:00.000Z',
      contact_attempts: [
        {
          method: 'PHONE_CALL',
          attempted_at: '2026-11-03T09:20:00.000Z',
          outcome: 'No answer',
          phone: '+233200000000',
        },
        {
          method: 'SMS',
          attempted_at: '2026-11-03T09:25:00.000Z',
          outcome: 'Sent',
          note: 'Asked to call back',
        },
      ],
    };
    const row = {
      ...CONTEXT,
      ...LEAK,
      failure_category: 'PARCEL_NOT_READY',
      failure_reason_snapshot: snapshot,
      failed_at: new Date('2026-11-03T09:30:00.000Z'),
      waiting_seconds: 5400,
      request_state: 'CONFIRMED',
      decision: 'PENDING',
      attempt_number: 2,
      attempt_extended: false,
      escalated_at: null,
      escalation_event: null,
      decided_at: null,
      replacement_request_id: null,
      rider_id: ID(6),
      photo_count: 2,
    } as unknown as PickupFailureRow;

    const item = failureViewOf(row);
    const bare = failureViewOf({
      ...row,
      failure_reason_snapshot: { ...snapshot, note: undefined, contact_attempts: undefined },
    });

    expect(names(item)).toEqual(names(schemaOf('PickupFailureQueueItem').properties));
    expect(item.category).toBe('PARCEL_NOT_READY');
    expect(item.reason).toEqual({
      code: 'PARCELS_NOT_PACKED',
      label: 'Parcels not packed',
      attribution: 'CUSTOMER',
    });
    expect(item.contact_attempts).toEqual([
      { method: 'PHONE_CALL', attempted_at: '2026-11-03T09:20:00.000Z', outcome: 'No answer' },
      {
        method: 'SMS',
        attempted_at: '2026-11-03T09:25:00.000Z',
        outcome: 'Sent',
        note: 'Asked to call back',
      },
    ]);
    expect(item.waiting_seconds).toBe(5400);
    // The count of the photos is the database's, passed on as it is: a view that dropped it, or answered a constant, shows no photo to the office.
    expect(item.photo_count).toBe(2);
    expect(failureViewOf({ ...row, photo_count: 0 }).photo_count).toBe(0);
    expect(bare.note).toBeNull();
    expect(bare.contact_attempts).toEqual([]);
    // Not escalated: the request has no moment of an escalation, so the item says none, whatever the ledger holds.
    expect(item.escalation).toBeNull();
  });

  // Break caught (S1.30, section 17.3): the queue saying a person escalated what the backstop did (or the reverse), the backstop's threshold and wait dropped, a threshold or a wait that is
  // not a whole number passed on as one, a threshold below one hour passed on, an escalation with no event read as an officer's act, and an escalation shown for a request that was not escalated.
  describe('the escalation of a failure', () => {
    const AT = '2026-11-03T12:00:00.000Z';

    it('says the backstop escalated, with the threshold and the wait its event recorded', () => {
      expect(
        escalationViewOf(AT, { trigger: 'BACKSTOP', threshold_hours: 24, waited_seconds: 90061 }),
      ).toEqual({ by: 'BACKSTOP', threshold_hours: 24, waited_seconds: 90061 });
      // A figure of a ledger event that arrives as text is read as the whole number it is.
      expect(
        escalationViewOf(new Date(AT), {
          trigger: 'BACKSTOP',
          threshold_hours: '24',
          waited_seconds: '90061',
        }),
      ).toEqual({ by: 'BACKSTOP', threshold_hours: 24, waited_seconds: 90061 });
    });

    it('says a person escalated what an officer escalated, and states neither a threshold nor a wait for it', () => {
      expect(
        escalationViewOf(AT, { trigger: 'OPS', threshold_hours: 24, waited_seconds: 60 }),
      ).toEqual({ by: 'PERSON', threshold_hours: null, waited_seconds: null });
      expect(
        escalationViewOf(AT, { trigger: null, threshold_hours: null, waited_seconds: null }),
      ).toEqual({ by: 'PERSON', threshold_hours: null, waited_seconds: null });
    });

    it('says it does not know who where the ledger holds no event, and nothing where there was no escalation', () => {
      expect(escalationViewOf(AT, null)).toEqual({
        by: 'UNKNOWN',
        threshold_hours: null,
        waited_seconds: null,
      });
      expect(escalationViewOf(null, null)).toBeNull();
      expect(
        escalationViewOf(null, { trigger: 'BACKSTOP', threshold_hours: 24, waited_seconds: 1 }),
      ).toBeNull();
    });

    it.each([
      ['a fraction', 2.5],
      ['a negative number', -3],
      ['text that is not a number', '24h'],
      ['an object', {}],
      ['nothing', null],
    ])('reads %s as no figure, never as one', (_what, value) => {
      const view = escalationViewOf(AT, {
        trigger: 'BACKSTOP',
        threshold_hours: value as number | string | null,
        waited_seconds: value as number | string | null,
      });
      expect(view).toEqual({ by: 'BACKSTOP', threshold_hours: null, waited_seconds: null });
    });

    it('reads a threshold below one hour as no threshold: the backstop cannot have judged by it', () => {
      expect(
        escalationViewOf(AT, { trigger: 'BACKSTOP', threshold_hours: 0, waited_seconds: 5 }),
      ).toEqual({ by: 'BACKSTOP', threshold_hours: null, waited_seconds: 5 });
    });
  });
});
