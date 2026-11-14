import { describe, expect, it } from 'vitest';

import { hubIntakePreCountOf, hubIntakeViewOf, type HubIntakeRow } from './hub-intake-view.js';

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

const COUNTED: HubIntakeRow = {
  ...ROW,
  state: 'COUNTED',
  physical_count: 3,
  count_variance: 'SHORT',
  count_difference: -2,
};

describe('the representation of an intake before its count (AC-SLICE-001-37)', () => {
  // Break caught: a view built by spreading the row, so that a column the row happens to carry (the declaration, what the form was pre-filled with: a `select *`, a join, a column added to a list)
  // is in the answer. Whatever else the row carries, the pre-count view has the members of the contract's shape and no other.
  it('has the members of HubIntakePreCount and no other, whatever else the row carries', () => {
    const leaky = { ...ROW, rider_declared_count: 9, prefilled_count: 9, storage_ref: 'x' };
    const view = hubIntakeViewOf(leaky, undefined);
    expect(Object.keys(view).toSorted()).toEqual([
      'active_receiver_id',
      'code',
      'count_phase',
      'declaration_captured_at',
      'handed_over_at',
      'handed_over_by',
      'hub_id',
      'id',
      'lock_acquired_at',
      'pickup_manifest_id',
      'pickup_request_id',
      'state',
    ]);
    expect(JSON.stringify(view)).not.toMatch(/declared|prefilled|storage_ref/);
    expect(view.count_phase).toBe('PRE_COUNT');
  });

  // Break caught: a declaration handed to the builder for an intake that has not been counted (a caller that looked it up anyway) reaching the answer.
  it('ignores a declaration it is given for an intake that has not been counted', () => {
    const view = hubIntakeViewOf(ROW, 5);
    expect(JSON.stringify(view)).not.toMatch(/declared/);
    expect(view.count_phase).toBe('PRE_COUNT');
  });

  // Break caught: the two moments told wrong (the receipt for the device's moment), the hub under the table's column name, or the lock shown as a string that is not a moment.
  it('names the hub as the contract does and gives every moment as an instant', () => {
    const view = hubIntakePreCountOf({
      ...ROW,
      active_receiver_id: '5eed0b00-0000-4000-8000-000000000001',
      lock_acquired_at: new Date('2026-11-14T10:05:00.000Z'),
    });
    expect(view).toMatchObject({
      hub_id: ROW.responsible_hub_id,
      handed_over_at: '2026-11-14T10:00:00.000Z',
      declaration_captured_at: '2026-11-14T09:58:00.000Z',
      active_receiver_id: '5eed0b00-0000-4000-8000-000000000001',
      lock_acquired_at: '2026-11-14T10:05:00.000Z',
    });
  });
});

describe('the representation of an intake once its count is committed', () => {
  // Break caught: a counted intake still answered as the pre-count shape (the comparison could never be shown), the declaration left out, or a number other than the one the database answered.
  it('is HubIntakePostCount: the declaration beside the count, the comparison and the condition', () => {
    const view = hubIntakeViewOf(COUNTED, 5);
    expect(view).toMatchObject({
      count_phase: 'POST_COUNT',
      state: 'COUNTED',
      rider_declared_count: 5,
      physical_count: 3,
      count_variance: 'SHORT',
      count_difference: -2,
      condition: 'OK',
    });
    expect(Object.keys(view)).not.toContain('prefilled_count');
  });

  // Break caught: a counted intake answered without the declaration or without its comparison as if that were a view (a silent pre-count shape, or a post-count one with holes): it is a fault.
  it('is a fault, and no answer, when the declaration or the comparison is missing', () => {
    expect(() => hubIntakeViewOf(COUNTED, undefined)).toThrow(/declaration/);
    expect(() => hubIntakeViewOf({ ...COUNTED, count_difference: null }, 5)).toThrow();
    expect(() => hubIntakeViewOf({ ...COUNTED, count_variance: null }, 5)).toThrow();
    expect(() => hubIntakeViewOf({ ...COUNTED, count_variance: 'MORE' }, 5)).toThrow();
  });
});
