import { describe, expect, it } from 'vitest';

import { hubIntakeEtagMatches, hubIntakeEtagOf } from './hub-intake-etag.js';
import { hubIntakeViewOf, type HubIntakeRow, type HubIntakeView } from './hub-intake-view.js';

const ROW: HubIntakeRow = {
  id: '5eed0900-0000-4000-8000-000000000001',
  code: 'ACC-IN-7K3M9Q',
  responsible_hub_id: '5eed0100-0000-4000-8000-000000000001',
  pickup_request_id: '5eed0200-0000-4000-8000-000000000001',
  pickup_manifest_id: '5eed0700-0000-4000-8000-000000000001',
  handed_over_by: '5eed0a00-0000-4000-8000-000000000001',
  handed_over_at: new Date('2026-11-14T10:00:00.000Z'),
  declaration_captured_at: new Date('2026-11-14T09:58:00.000Z'),
  state: 'AWAITING_COUNT',
  active_receiver_id: null,
  lock_acquired_at: null,
  physical_count: null,
  count_variance: null,
  count_difference: null,
  condition: 'OK',
  version: 1,
};

const view = (over: Partial<HubIntakeRow> = {}, declared?: number): HubIntakeView =>
  hubIntakeViewOf(
    { ...ROW, ...over },
    declared === undefined ? undefined : { declared, photoIds: [] },
  );

describe('the ETag of an intake', () => {
  // Break caught: a token that is not the form a client can send back strictly (43 base64url characters between quotes).
  it('is one strong quoted token of a SHA-256 digest, the same for the same facts and version', () => {
    expect(hubIntakeEtagOf(view(), 1)).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
    expect(hubIntakeEtagOf(view(), 4)).toBe(hubIntakeEtagOf(view(), 4));
  });

  // Break caught: a token that does not move with the record's version, so that a change the representation does not show is not seen by a client holding the old token.
  it('moves with the version', () => {
    expect(hubIntakeEtagOf(view(), 2)).not.toBe(hubIntakeEtagOf(view(), 1));
  });

  // Break caught: a member of the intake left out of the digest, so that a change the caller can see goes unnoticed.
  it.each([
    ['its identity', { id: '5eed0900-0000-4000-8000-000000000002' }],
    ['its code', { code: 'ACC-IN-2K3M9Q' }],
    [
      'its state',
      { state: 'COUNTED', physical_count: 3, count_variance: 'MATCH', count_difference: 0 },
    ],
    ['its hub', { responsible_hub_id: '5eed0100-0000-4000-8000-000000000002' }],
    ['its request', { pickup_request_id: '5eed0200-0000-4000-8000-000000000002' }],
    ['its run', { pickup_manifest_id: '5eed0700-0000-4000-8000-000000000002' }],
    ['the rider that handed over', { handed_over_by: '5eed0a00-0000-4000-8000-000000000002' }],
    ['the receipt of the handover', { handed_over_at: new Date('2026-11-14T10:01:00.000Z') }],
    ['the device’s moment', { declaration_captured_at: new Date('2026-11-14T09:59:00.000Z') }],
  ] as const)('moves with %s', (_name, over) => {
    // The one change that makes the intake counted is read with the declaration the database answered for it.
    const declared = 'state' in over ? 3 : undefined;
    expect(hubIntakeEtagOf(view(over as Partial<HubIntakeRow>, declared), 1)).not.toBe(
      hubIntakeEtagOf(view(), 1),
    );
  });

  // Break caught: a digest that takes in the advisory lock, so that a receiver who read the intake is told it is stale by the lock of another (or by its own refresh), and a count is refused for
  // a lock that is no fact of the intake: the lock would be a guard (AC-SLICE-001-43).
  it('does not move with the lock: who holds it, or since when', () => {
    const free = hubIntakeEtagOf(view(), 1);
    expect(
      hubIntakeEtagOf(
        view({
          active_receiver_id: '5eed0b00-0000-4000-8000-000000000001',
          lock_acquired_at: new Date('2026-11-14T10:05:00.000Z'),
        }),
        1,
      ),
    ).toBe(free);
    expect(
      hubIntakeEtagOf(
        view({
          active_receiver_id: '5eed0b00-0000-4000-8000-000000000002',
          lock_acquired_at: new Date('2026-11-14T10:40:00.000Z'),
        }),
        1,
      ),
    ).toBe(free);
  });

  // Break caught: the facts of a count left out of the digest of a counted intake (its comparison, its declaration), or the declaration let into the digest of one that has not been counted.
  it('moves with the facts of a count, and a pre-count digest is made of nothing a declaration could change', () => {
    const counted = {
      state: 'COUNTED',
      physical_count: 3,
      count_variance: 'MATCH',
      count_difference: 0,
    } as const;
    const base = hubIntakeEtagOf(view(counted, 3), 2);
    expect(
      hubIntakeEtagOf(
        view({ ...counted, physical_count: 4, count_variance: 'OVER', count_difference: 1 }, 3),
        2,
      ),
    ).not.toBe(base);
    expect(hubIntakeEtagOf(view(counted, 4), 2)).not.toBe(base);
    expect(hubIntakeEtagOf(view({ ...counted, condition: 'DAMAGED' }, 3), 2)).not.toBe(base);
    // Whatever declaration is offered for an intake that has not been counted, the digest is the same.
    expect(hubIntakeEtagOf(view({}, 9), 1)).toBe(hubIntakeEtagOf(view({}, undefined), 1));
  });

  // Break caught: the photos of the parcels counted at the door left out of the digest of a counted intake, so that a change to them is not seen by a client holding the old token.
  it('moves with the photos of a counted intake, and with their order', () => {
    const counted = {
      state: 'COUNTED',
      physical_count: 3,
      count_variance: 'MATCH',
      count_difference: 0,
    } as const;
    const photos = ['5eed0b00-0000-4000-8000-000000000001', '5eed0b00-0000-4000-8000-000000000002'];
    const etagWith = (photoIds: readonly string[]): string =>
      hubIntakeEtagOf(hubIntakeViewOf({ ...ROW, ...counted }, { declared: 3, photoIds }), 2);
    const none = etagWith([]);
    expect(etagWith(photos)).not.toBe(none);
    expect(etagWith([...photos].reverse())).not.toBe(etagWith(photos));
    expect(etagWith(photos.slice(0, 1))).not.toBe(etagWith(photos));
  });

  // Break caught: the findings left out of the digest of a counted intake, so that an escalation (which adds a finding and changes nothing else of the row, so the version does not move) is not seen by a client
  // holding the old token.
  it('moves with the findings of a counted intake, though the version has not moved', () => {
    const counted = {
      state: 'RECONCILIATION_REQUIRED',
      physical_count: 1,
      count_variance: 'SHORT',
      count_difference: -2,
    } as const;
    const finding = (id: string) => ({
      id,
      kind: 'ADJUDICATION',
      condition: null,
      outcome: 'ESCALATED',
      note: 'To the manager',
      evidence_ids: [],
      recorded_by: '5eed0d00-0000-4000-8000-000000000001',
      recorded_at: '2026-11-14T11:30:00.000Z',
    });
    const etagWith = (findings: readonly ReturnType<typeof finding>[]): string =>
      hubIntakeEtagOf(
        hubIntakeViewOf({ ...ROW, ...counted }, { declared: 3, photoIds: [], findings }),
        4,
      );
    const none = etagWith([]);
    const one = etagWith([finding('5eed0c00-0000-4000-8000-000000000001')]);
    expect(one).not.toBe(none);
    expect(etagWith([finding('5eed0c00-0000-4000-8000-000000000002')])).not.toBe(one);
    expect(
      etagWith([
        finding('5eed0c00-0000-4000-8000-000000000001'),
        finding('5eed0c00-0000-4000-8000-000000000002'),
      ]),
    ).not.toBe(one);
  });

  // Break caught: a header read leniently (a weak validator, a list, a bare token, another intake's token, a missing one).
  it('is read strictly: exactly one strong quoted token, equal to the current one', () => {
    const current = hubIntakeEtagOf(view(), 1);
    expect(hubIntakeEtagMatches(current, current)).toBe(true);
    for (const header of [
      undefined,
      '',
      current.slice(1, -1),
      `W/${current}`,
      `${current}, ${current}`,
      hubIntakeEtagOf(view(), 2),
      '"0"',
    ]) {
      expect(hubIntakeEtagMatches(header, current), String(header)).toBe(false);
    }
  });

  it('refuses a version that is not a non-negative safe integer', () => {
    for (const version of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => hubIntakeEtagOf(view(), version), String(version)).toThrow(RangeError);
    }
  });
});
