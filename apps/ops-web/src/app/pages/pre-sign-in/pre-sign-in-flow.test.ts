import type { Location } from 'react-router';
import { describe, expect, it } from 'vitest';

import { ENROLLED_STATE, familyOf, justEnrolled } from './pre-sign-in-flow';

const at = (pathname: string): Location => ({
  pathname,
  search: '',
  hash: '',
  state: null,
  key: 'default',
});

describe('familyOf: which addresses a thing handed between screens belongs to', () => {
  // Break caught: the sign-in pages and the setup pages falling in one family, so that a challenge follows the person into the setup pages or
  // the authenticator's material follows them to the sign-in.
  it('names the sign-in pages, the setup pages and the rest as three families', () => {
    expect(familyOf(at('/sign-in'))).toBe('sign-in');
    expect(familyOf(at('/sign-in/mfa'))).toBe('sign-in');
    expect(familyOf(at('/setup/credential'))).toBe('setup');
    expect(familyOf(at('/setup/mfa'))).toBe('setup');
    expect(familyOf(at('/setup/mfa/complete'))).toBe('setup');
    expect(familyOf(at('/'))).toBe('elsewhere');
    expect(familyOf(at('/admin/staff'))).toBe('elsewhere');
  });

  // Break caught: a prefix match that takes a neighbouring address for the family.
  it('does not take an address that merely starts alike for a member', () => {
    expect(familyOf(at('/sign-input'))).toBe('elsewhere');
    expect(familyOf(at('/setups/credential'))).toBe('elsewhere');
    expect(familyOf(at('/setup'))).toBe('elsewhere');
  });

  it('ignores the query and the fragment, which are not part of an address’s family', () => {
    expect(familyOf({ ...at('/setup/mfa'), search: '?step=2', hash: '#x' })).toBe('setup');
  });
});

describe('justEnrolled: the marker the confirmation is shown on', () => {
  it('is true for the marker the authenticator screen sets, and for nothing else', () => {
    expect(justEnrolled(ENROLLED_STATE)).toBe(true);
    for (const state of [
      undefined,
      null,
      'enrolled',
      1,
      true,
      {},
      { enrolled: false },
      { enrolled: 'yes' },
    ]) {
      expect(justEnrolled(state), JSON.stringify(state)).toBe(false);
    }
  });
});
