import { describe, expect, it } from 'vitest';

import { BUNDLES, BUNDLE_ID, HUB_ID } from '../../../test-support/staff-fixture';
import { STAFF_STATUSES } from '../../../platform/staff/staff-shape';
import {
  defaultViewFor,
  hubNameOf,
  roleNameOf,
  STAFF_STATUS_MAP,
  STAFF_VIEWS,
  statusOfView,
  viewOf,
} from './staff-presentation';

describe('the words for a status', () => {
  // Break caught: a status the contract has that no screen has words for, which would be drawn as "Unknown status".
  it('has a label and a tone for every status of the contract', () => {
    for (const status of STAFF_STATUSES) {
      expect(STAFF_STATUS_MAP[status].label, status).toMatch(/\S/);
    }
  });

  it('says what a person understands, not what the database stores', () => {
    expect(STAFF_STATUS_MAP.PENDING_APPROVAL.label).toBe('Waiting for approval');
    expect(STAFF_STATUS_MAP.ACTIVE.label).toBe('Active');
    expect(STAFF_STATUS_MAP.REJECTED.label).toBe('Rejected');
    expect(STAFF_STATUS_MAP.SUSPENDED.label).toBe('Suspended');
    expect(STAFF_STATUS_MAP.OFFBOARDED.label).toBe('Offboarded');
  });

  // Break caught: a tone that says the opposite of the words (a rejected profile drawn as a success).
  it('draws a rejection and a suspension in the tones that mean them', () => {
    expect(STAFF_STATUS_MAP.ACTIVE.tone).toBe('success');
    expect(STAFF_STATUS_MAP.PENDING_APPROVAL.tone).toBe('warning');
    expect(STAFF_STATUS_MAP.SUSPENDED.tone).toBe('warning');
    expect(STAFF_STATUS_MAP.REJECTED.tone).toBe('danger');
    expect(STAFF_STATUS_MAP.OFFBOARDED.tone).toBe('neutral');
  });
});

describe('the views of the staff list', () => {
  it('has one view for each status and one for everyone', () => {
    expect(Object.keys(STAFF_VIEWS)).toEqual([
      'waiting',
      'active',
      'rejected',
      'suspended',
      'offboarded',
      'all',
    ]);
  });

  it('asks the server for the status a view is, and for none for everyone', () => {
    expect(statusOfView('waiting')).toBe('PENDING_APPROVAL');
    expect(statusOfView('active')).toBe('ACTIVE');
    expect(statusOfView('rejected')).toBe('REJECTED');
    expect(statusOfView('suspended')).toBe('SUSPENDED');
    expect(statusOfView('offboarded')).toBe('OFFBOARDED');
    expect(statusOfView('all')).toBeUndefined();
  });

  // Break caught: a view read out of the address without being checked, so that a made-up one asks the server for a made-up filter.
  it('reads a view out of the address and refuses what is not one', () => {
    expect(viewOf('active')).toBe('active');
    expect(viewOf('all')).toBe('all');
    expect(viewOf('ACTIVE')).toBeUndefined();
    expect(viewOf('toString')).toBeUndefined();
    expect(viewOf('__proto__')).toBeUndefined();
    expect(viewOf('')).toBeUndefined();
    expect(viewOf(null)).toBeUndefined();
  });

  // Break caught: an approver landing on a long list when what they came for is the queue, or a maker who cannot approve landing on an empty queue.
  it('opens on the queue for a person who can approve, and on everyone for a person who cannot', () => {
    expect(defaultViewFor(true)).toBe('waiting');
    expect(defaultViewFor(false)).toBe('all');
  });
});

describe('the names of a role and a hub', () => {
  it('gives the role its name from the list the server gave', () => {
    expect(roleNameOf(BUNDLE_ID, BUNDLES)).toBe('Ops Staff');
  });

  // Break caught: an id shown to a person where a name was owed.
  it('says "Another role" for a role the list does not have, and never shows its id', () => {
    expect(roleNameOf('b0000000-0000-4000-8000-0000000000ff', BUNDLES)).toBe('Another role');
    expect(roleNameOf(BUNDLE_ID, undefined)).toBe('Another role');
  });

  it('gives the hub its name from the session’s hubs, and "No hub" for none', () => {
    const hubs = [{ id: HUB_ID, display_name: 'Accra Central' }];

    expect(hubNameOf(HUB_ID, hubs)).toBe('Accra Central');
    expect(hubNameOf(null, hubs)).toBe('No hub');
    expect(hubNameOf(undefined, hubs)).toBe('No hub');
    expect(hubNameOf('5b6c7d8e-9f01-4a2b-8c3d-4e5f6a7b8caa', hubs)).toBe('Another hub');
  });
});
