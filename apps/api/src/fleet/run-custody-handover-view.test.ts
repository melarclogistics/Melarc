import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { pickupStopEtagOf } from '../pickup/pickup-stop-etag.js';
import { stopViewOf } from '../pickup/pickup-manifest-view.js';
import {
  handoverEtagMatches,
  handoverEtagOf,
  handoverViewOf,
  type RunCustodyHandoverRow,
} from './run-custody-handover-view.js';

const ROW: RunCustodyHandoverRow = {
  id: '5eed0900-0000-4000-8000-000000000001',
  manifest_id: '5eed0700-0000-4000-8000-000000000001',
  responsible_hub_id: '5eed0100-0000-4000-8000-000000000001',
  from_rider_id: '5eed0300-0000-4000-8000-000000000001',
  to_rider_id: '5eed0300-0000-4000-8000-000000000002',
  to_hub_id: null,
  state: 'PENDING',
  parcel_count_taken: null,
  initiated_at: new Date('2026-11-03T09:00:00.000Z'),
  resolved_at: null,
  version: 1,
  initiated_at_text: '2026-11-03 09:00:00+00',
};

const view = (over: Partial<RunCustodyHandoverRow> = {}) => handoverViewOf({ ...ROW, ...over });

describe('the representation of a custody handover', () => {
  // Break caught: a member added from the row (the hub, a note, the officer, the version, the position of a page), which a rider party to the
  // handover would then read: the notes are Ops's own and a handover names people only by their rider identifiers.
  it('has exactly the members of the contract, and no note', () => {
    const row = {
      ...ROW,
      initiation_note: 'Broke down at the roadside',
      failure_note: 'Did not arrive',
      initiated_by: 'an officer',
    };
    expect(Object.keys(handoverViewOf(row)).toSorted()).toEqual(
      [
        'from_rider_id',
        'id',
        'initiated_at',
        'manifest_id',
        'parcel_count_taken',
        'resolved_at',
        'state',
        'to_hub_id',
        'to_rider_id',
      ].toSorted(),
    );
    expect(JSON.stringify(handoverViewOf(row))).not.toMatch(/roadside|arrive|officer/);
  });

  // Break caught: a moment shown in the database's text form or in the time zone of the machine, which a client could not compare.
  it('shows the moments as ISO instants, from a date or from the database’s text', () => {
    expect(view().initiated_at).toBe('2026-11-03T09:00:00.000Z');
    expect(view({ initiated_at: '2026-11-03 09:00:00+00' }).initiated_at).toBe(
      '2026-11-03T09:00:00.000Z',
    );
    expect(view().resolved_at).toBeNull();
    expect(view({ resolved_at: new Date('2026-11-03T09:30:00.000Z') }).resolved_at).toBe(
      '2026-11-03T09:30:00.000Z',
    );
  });

  it('shows the destination that is set and the one that is not as null, never absent', () => {
    expect(view()).toMatchObject({ to_hub_id: null });
    expect(view({ to_rider_id: null, to_hub_id: ROW.responsible_hub_id })).toMatchObject({
      to_rider_id: null,
      to_hub_id: ROW.responsible_hub_id,
    });
  });
});

describe('the ETag of a custody handover', () => {
  // Break caught: a token that is not the form a client can send back strictly (43 base64url characters between quotes).
  it('is one strong quoted token of a SHA-256 digest', () => {
    expect(handoverEtagOf(view(), 1)).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
  });

  it('is the same for the same representation and version, every time', () => {
    expect(handoverEtagOf(view(), 3)).toBe(handoverEtagOf(view(), 3));
  });

  // Break caught: the domain of the token lost or shared with another kind of record. Two records with the same members would then have the same
  // token, and the one's could be sent for the other's. The members of a handover differ from a stop's and a manifest's today, so nothing but
  // this derivation shows that the domain is in the digest.
  it('is made under a domain of its own, with the version and the members, in this order', () => {
    const shown = view();
    const members = [
      shown.id,
      shown.manifest_id,
      shown.from_rider_id,
      shown.to_rider_id,
      shown.to_hub_id,
      shown.state,
      shown.parcel_count_taken,
      shown.initiated_at,
      shown.resolved_at,
    ];
    const digest = (domain: string): string =>
      `"${createHash('sha256')
        .update(JSON.stringify([domain, 7, ...members]), 'utf8')
        .digest('base64url')}"`;
    expect(handoverEtagOf(shown, 7)).toBe(digest('melarc.run-custody-handover-etag.v1'));
    expect(handoverEtagOf(shown, 7)).not.toBe(digest('melarc.pickup-stop-etag.v1'));
  });

  // Break caught: a token that does not move with the row's version, so that a change the representation does not show goes unseen.
  it('moves with the version', () => {
    expect(handoverEtagOf(view(), 2)).not.toBe(handoverEtagOf(view(), 1));
  });

  // Break caught: a member of the handover left out of the digest, so that a change the caller can see goes unnoticed (above all the state:
  // an acceptance taken on the token of a handover that has since failed would otherwise be let through).
  it.each([
    ['its identity', { id: '5eed0900-0000-4000-8000-000000000002' }],
    ['its run', { manifest_id: '5eed0700-0000-4000-8000-000000000002' }],
    ['the rider handing over', { from_rider_id: '5eed0300-0000-4000-8000-000000000003' }],
    ['the rider named to receive', { to_rider_id: '5eed0300-0000-4000-8000-000000000004' }],
    ['the hub named to receive', { to_rider_id: null, to_hub_id: ROW.responsible_hub_id }],
    ['its state', { state: 'FAILED' as const }],
    ['the count taken', { parcel_count_taken: 4 }],
    ['the moment it was opened', { initiated_at: new Date('2026-11-03T10:00:00.000Z') }],
    ['the moment it was resolved', { resolved_at: new Date('2026-11-03T09:30:00.000Z') }],
  ] as const)('moves with %s', (_label, change) => {
    expect(handoverEtagOf(view(change), 1)).not.toBe(handoverEtagOf(view(), 1));
  });

  // Break caught: a handover's token that is a stop's, so that one could be sent for the other.
  it('is not the token of a stop, whatever the two have in common', () => {
    const stop = stopViewOf({
      id: ROW.id,
      pickup_manifest_id: ROW.manifest_id,
      pickup_request_id: ROW.id,
      sequence: 1,
      state: 'PENDING',
      arrived_at: null,
      failure_category: null,
      failure_reason_snapshot: null,
      skip_snapshot: null,
      pickup_summary: null,
    });
    expect(handoverEtagOf(view(), 1)).not.toBe(pickupStopEtagOf(stop, 1));
  });

  it('refuses a version that is not a non-negative safe integer', () => {
    for (const version of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => handoverEtagOf(view(), version)).toThrow(RangeError);
    }
  });
});

describe('the comparison of an If-Match with the current ETag of a handover', () => {
  const current = handoverEtagOf(view(), 1);

  it('accepts exactly the current token', () => {
    expect(handoverEtagMatches(current, current)).toBe(true);
  });

  // Break caught: a header that is accepted although it is not the one token the read handed out: missing, weak, a list, `*`, unquoted, the token
  // of another version, or the right digest in another form.
  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['weak', `W/${current}`],
    ['a list', `${current}, ${current}`],
    ['a star', '*'],
    ['unquoted', current.slice(1, -1)],
    ['another version’s', handoverEtagOf(view(), 2)],
    ['another state’s', handoverEtagOf(view({ state: 'FAILED' }), 1)],
    ['padded', ` ${current}`],
    ['lower-cased', current.toLowerCase()],
  ])('refuses a header that is %s', (_label, header) => {
    expect(handoverEtagMatches(header, current)).toBe(false);
  });
});
