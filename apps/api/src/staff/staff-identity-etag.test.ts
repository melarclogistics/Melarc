import { describe, expect, it } from 'vitest';

import type { StaffIdentityView } from './staff-identities.service.js';
import { staffIdentityEtagMatches, staffIdentityEtagOf } from './staff-identity-etag.js';

/**
 * The ETag of a staff identity is an opaque strong digest of the whole representation a read returns and of the durable revision (F02 of
 * the audit of 22 October 2026). What it is made of is pinned here; what moves each part is the database's (`staff-identity-routes`).
 */
const VIEW: StaffIdentityView = {
  id: '01a16207-68c5-7fd8-95cb-917caace6294',
  work_email: 'ama.mensah@example.test',
  full_name: 'Ama Mensah',
  phone: '+233200000000',
  status: 'ACTIVE',
  role_bundle_id: '2fd0e8f2-0d3e-4c6f-8e7e-000000000001',
  primary_hub_id: 'b0b0b0b0-0000-4000-8000-00000000000b',
  mfa_enrolled: true,
  mfa_reset_state: 'FACTOR_ACTIVE',
  created_by: '2fd0e8f2-0d3e-4c6f-8e7e-000000000002',
  approved_by: '2fd0e8f2-0d3e-4c6f-8e7e-000000000003',
};

describe('the ETag of a staff identity', () => {
  // Break caught: a token that is weak, unquoted or of another length, or one that shows the version it was made from.
  it('is one strong quoted opaque token, and shows neither a version nor a field', () => {
    const etag = staffIdentityEtagOf(VIEW, 7);

    expect(etag).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
    expect(etag).not.toBe('"7"');
    expect(etag.startsWith('W/')).toBe(false);
  });

  // Break caught: a token that is not the same for the same representation and revision, which would refuse every `If-Match`.
  it('is the same for the same representation and the same revision', () => {
    expect(staffIdentityEtagOf({ ...VIEW }, 7)).toBe(staffIdentityEtagOf(VIEW, 7));
  });

  // Break caught: the revision left out of the digest: a credential replaced (which no read shows) would not change the token.
  it('changes with the durable revision alone', () => {
    expect(staffIdentityEtagOf(VIEW, 8)).not.toBe(staffIdentityEtagOf(VIEW, 7));
  });

  // Break caught: a field the read returns left out of the digest, so that it can change under a token that still matches. Each
  // field of the view is changed in turn.
  it.each(Object.keys(VIEW) as (keyof StaffIdentityView)[])('changes when %s changes', (field) => {
    const changed: StaffIdentityView = {
      ...VIEW,
      [field]: typeof VIEW[field] === 'boolean' ? !VIEW[field] : `${String(VIEW[field])}x`,
    };

    expect(staffIdentityEtagOf(changed, 7)).not.toBe(staffIdentityEtagOf(VIEW, 7));
  });

  // Break caught: an absent value and the text "null" taking one token, or two fields' values running together.
  it('tells an absent value from the text of it, and a boundary between two values', () => {
    expect(staffIdentityEtagOf({ ...VIEW, phone: null }, 1)).not.toBe(
      staffIdentityEtagOf({ ...VIEW, phone: 'null' }, 1),
    );
    expect(staffIdentityEtagOf({ ...VIEW, work_email: 'a', full_name: 'bc' }, 1)).not.toBe(
      staffIdentityEtagOf({ ...VIEW, work_email: 'ab', full_name: 'c' }, 1),
    );
  });

  it.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'refuses a revision that is not a non-negative safe integer (%s)',
    (version) => {
      expect(() => staffIdentityEtagOf(VIEW, version)).toThrow(RangeError);
    },
  );
});

describe('the If-Match of a staff identity', () => {
  const current = staffIdentityEtagOf(VIEW, 7);

  it('matches exactly the current token', () => {
    expect(staffIdentityEtagMatches(current, current)).toBe(true);
  });

  // Break caught: a precondition that is not the one token accepted: weak, a list, `*`, unquoted, another record's, the integer form of
  // the other records, the empty header or none.
  it.each([
    ['a different token', staffIdentityEtagOf(VIEW, 8)],
    ['a weak validator', `W/${current}`],
    ['a list of the current token', `${current}, ${current}`],
    ['the wildcard', '*'],
    ['the token without its quotes', current.slice(1, -1)],
    ['the integer form of other records', '"7"'],
    ['the empty header', ''],
    ['whitespace around the token', ` ${current} `],
    ['no header', undefined],
  ])('does not match %s', (_name, header) => {
    expect(staffIdentityEtagMatches(header, current)).toBe(false);
  });
});
