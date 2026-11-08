import { describe, expect, it } from 'vitest';

import {
  BUNDLES,
  bundleFixture,
  sessionRecordFixture,
  staffIdentityFixture,
  trustedBrowserFixture,
} from '../../test-support/staff-fixture';
import {
  parseAssignableBundles,
  parseMfaResetResult,
  parseSessionRecord,
  parseSessionRecords,
  parseSetupGrant,
  parseStaffIdentity,
  parseStaffIdentityPage,
  parseTrustedBrowser,
  parseTrustedBrowsers,
  parseTrustedBrowsersRevoked,
  type SessionRecordView,
} from './staff-shape';

const record = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...staffIdentityFixture(),
  ...overrides,
});

describe('parseStaffIdentity: what is accepted', () => {
  it('accepts a real-shaped identity and returns what the screens read of it', () => {
    expect(parseStaffIdentity(record())).toEqual(staffIdentityFixture());
  });

  // Break caught: an optional field the contract allows to be null or absent being refused, so that such a profile cannot be opened.
  it('accepts a profile with no phone and no hub, and one that nobody has approved', () => {
    const bare = record();
    delete bare.phone;
    delete bare.primary_hub_id;
    delete bare.approved_by;

    const identity = parseStaffIdentity(bare);

    expect(identity).toBeDefined();
    expect(parseStaffIdentity(record({ phone: null, primary_hub_id: null }))).toMatchObject({
      phone: null,
      primary_hub_id: null,
    });
  });

  // Break caught: every status and every reset state of the contract being accepted, one at a time.
  it.each(['PENDING_APPROVAL', 'ACTIVE', 'REJECTED', 'SUSPENDED', 'OFFBOARDED'])(
    'accepts the status %s',
    (status) => {
      expect(parseStaffIdentity(record({ status }))?.status).toBe(status);
    },
  );

  it.each(['FACTOR_ACTIVE', 'ENROLMENT_UNFINISHED', 'NOT_ELIGIBLE'])(
    'accepts the reset state %s',
    (state) => {
      expect(parseStaffIdentity(record({ mfa_reset_state: state }))?.mfa_reset_state).toBe(state);
    },
  );

  // Break caught: the guard copying the server's object through, so that a field it did not judge (a credential, if a server ever sent
  // one) reaches a screen.
  it('returns only the fields it has judged', () => {
    const identity = parseStaffIdentity(record({ password_hash: 'x', credential: { token: 'y' } }));

    expect(identity).toBeDefined();
    expect(identity).not.toHaveProperty('password_hash');
    expect(identity).not.toHaveProperty('credential');
  });
});

describe('parseStaffIdentity: what is refused', () => {
  // Break caught: a 200 with a body that is not an identity being shown as one, with actions to approve it.
  it.each([
    ['null', null],
    ['a string', 'staff'],
    ['a list', []],
    ['an empty object', {}],
    ['an object with only a name', { full_name: 'Kofi' }],
  ])('refuses %s', (_label, body) => {
    expect(parseStaffIdentity(body)).toBeUndefined();
  });

  it.each([
    ['no id', { id: undefined }],
    ['an id that is not a uuid', { id: 'kofi' }],
    ['no email', { work_email: undefined }],
    ['an empty email', { work_email: '' }],
    ['an email that is not text', { work_email: 7 }],
    ['an email with a control character', { work_email: 'a\u0000@example.test' }],
    ['no name', { full_name: undefined }],
    ['an empty name', { full_name: '  ' }],
    ['a name with a line break', { full_name: 'Kofi\nBoateng' }],
    ['an unknown status', { status: 'DELETED' }],
    ['a status in lower case', { status: 'active' }],
    ['no status', { status: undefined }],
    ['a bundle that is not a uuid', { role_bundle_id: 'ops' }],
    ['no bundle', { role_bundle_id: undefined }],
    ['a hub that is not a uuid', { primary_hub_id: 'accra' }],
    ['an enrolment flag that is not a boolean', { mfa_enrolled: 'yes' }],
    ['no enrolment flag', { mfa_enrolled: undefined }],
    ['an unknown reset state', { mfa_reset_state: 'MAYBE' }],
    ['no reset state', { mfa_reset_state: undefined }],
    ['a maker that is not a uuid', { created_by: 'me' }],
    ['no maker', { created_by: undefined }],
    ['an approver that is not a uuid', { approved_by: 'you' }],
    ['a phone that is not text', { phone: 233 }],
  ])('refuses %s', (_label, overrides) => {
    expect(parseStaffIdentity(record(overrides))).toBeUndefined();
  });
});

describe('parseStaffIdentityPage', () => {
  it('accepts a page and keeps its order and its token', () => {
    const second = staffIdentityFixture({ id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' });

    expect(
      parseStaffIdentityPage({ items: [staffIdentityFixture(), second], next_page_token: 'abc' }),
    ).toEqual({ items: [staffIdentityFixture(), second], nextPageToken: 'abc' });
    expect(parseStaffIdentityPage({ items: [], next_page_token: null })).toEqual({
      items: [],
      nextPageToken: null,
    });
  });

  // Break caught: one bad entry being skipped and the rest shown, so that a list silently misses a person an approver was to find.
  it('refuses the whole page when one entry is not an identity', () => {
    expect(
      parseStaffIdentityPage({
        items: [staffIdentityFixture(), { id: 'x' }],
        next_page_token: null,
      }),
    ).toBeUndefined();
  });

  // Break caught: a repeated id becoming two rows of one person, and a key React cannot tell apart.
  it('refuses a page that lists a person twice', () => {
    expect(
      parseStaffIdentityPage({
        items: [staffIdentityFixture(), staffIdentityFixture()],
        next_page_token: null,
      }),
    ).toBeUndefined();
  });

  it.each([
    ['no items', { next_page_token: null }],
    ['items that are not a list', { items: {}, next_page_token: null }],
    ['no token field', { items: [] }],
    ['a token that is a number', { items: [], next_page_token: 4 }],
    [
      'an empty token, which would ask for the first page again',
      { items: [], next_page_token: '' },
    ],
    ['a body that is a list', []],
    ['null', null],
  ])('refuses %s', (_label, body) => {
    expect(parseStaffIdentityPage(body)).toBeUndefined();
  });

  // Break caught: a page larger than the contract's largest page size being believed.
  it('refuses a page of more than a hundred entries, which is more than the contract allows', () => {
    const items = Array.from({ length: 101 }, (_, index) =>
      staffIdentityFixture({
        id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      }),
    );
    expect(parseStaffIdentityPage({ items, next_page_token: null })).toBeUndefined();
    expect(
      parseStaffIdentityPage({ items: items.slice(0, 100), next_page_token: null }),
    ).toBeDefined();
  });
});

describe('parseAssignableBundles', () => {
  it('accepts the list and returns what the form offers of each bundle', () => {
    expect(parseAssignableBundles({ items: BUNDLES })).toEqual(BUNDLES);
    expect(parseAssignableBundles({ items: [] })).toEqual([]);
  });

  // Break caught: a permission, a count or a holder reaching the form because a server sent one (the contract says none is ever sent).
  it('returns only the fields it has judged', () => {
    const [bundle] =
      parseAssignableBundles({ items: [{ ...bundleFixture(), permissions: ['staff.read'] }] }) ??
      [];

    expect(bundle).toEqual(bundleFixture());
  });

  it.each([
    ['no items', {}],
    ['a list that is the body', []],
    ['an entry with no name', { items: [{ ...bundleFixture(), name: undefined }] }],
    ['an entry with a blank name', { items: [{ ...bundleFixture(), name: ' ' }] }],
    [
      'an entry with a name that has a line break',
      { items: [{ ...bundleFixture(), name: 'a\nb' }] },
    ],
    ['an entry with an id that is not a uuid', { items: [{ ...bundleFixture(), id: 'ops' }] }],
    [
      'an entry with a flag that is not a boolean',
      { items: [{ ...bundleFixture(), requires_platform_admin_approval: 'no' }] },
    ],
    [
      'an entry with no flag',
      { items: [{ ...bundleFixture(), requires_platform_admin_approval: undefined }] },
    ],
    ['the same bundle twice', { items: [bundleFixture(), bundleFixture()] }],
  ])('refuses %s', (_label, body) => {
    expect(parseAssignableBundles(body)).toBeUndefined();
  });
});

describe('parseSessionRecord and parseSessionRecords', () => {
  it('accepts a session and returns what the sessions page reads of it', () => {
    expect(parseSessionRecord(sessionRecordFixture())).toEqual(sessionRecordFixture());
    expect(parseSessionRecords({ items: [sessionRecordFixture()] })).toEqual([
      sessionRecordFixture(),
    ]);
    expect(parseSessionRecords({ items: [] })).toEqual([]);
  });

  // Break caught: a session credential or a token hash reaching a screen (the contract says none is ever listed).
  it('returns only the fields it has judged', () => {
    const session = parseSessionRecord({
      ...sessionRecordFixture(),
      token_hash: 'abc',
      token: 'secret',
    });

    expect(session).toBeDefined();
    expect(session).not.toHaveProperty('token_hash');
    expect(session).not.toHaveProperty('token');
  });

  it('accepts a session with only the fields the contract requires', () => {
    const bare = {
      id: sessionRecordFixture().id,
      principal_type: 'STAFF',
      state: 'ACTIVE',
      expires_at: '2026-10-23T16:00:00Z',
    };

    expect(parseSessionRecord(bare)).toEqual(bare);
  });

  it.each<SessionRecordView['termination_reason']>([
    'SIGNED_OUT',
    'SUPERSEDED_BY_NEW_LOGIN',
    'ADMIN_REVOKED',
    'MFA_RESET',
    null,
  ])('accepts the termination reason %s', (reason) => {
    expect(
      parseSessionRecord(sessionRecordFixture({ state: 'TERMINATED', termination_reason: reason }))
        ?.termination_reason,
    ).toBe(reason);
  });

  it.each([
    ['null', null],
    ['an empty object', {}],
    ['a list', []],
  ])('refuses %s as the body', (_label, body) => {
    expect(parseSessionRecord(body)).toBeUndefined();
  });

  it.each([
    ['an id that is not a uuid', { id: 'abc' }],
    ['an unknown principal type', { principal_type: 'ROBOT' }],
    ['an unknown state', { state: 'PAUSED' }],
    ['no expiry', { expires_at: undefined }],
    ['an expiry that is not an instant', { expires_at: 'tomorrow' }],
    ['a last activity that is not an instant', { last_activity_at: 'now' }],
    ['an issue time that is not an instant', { issued_at: 7 }],
    ['an unknown termination reason', { termination_reason: 'BORED' }],
    ['a principal that is not a uuid', { principal_id: 'me' }],
  ])('refuses %s', (_label, overrides) => {
    expect(parseSessionRecord({ ...sessionRecordFixture(), ...overrides })).toBeUndefined();
  });

  it.each([
    ['no items', {}],
    ['an entry that is not a session', { items: [{}] }],
    ['the same session twice', { items: [sessionRecordFixture(), sessionRecordFixture()] }],
  ])('refuses a list with %s', (_label, body) => {
    expect(parseSessionRecords(body)).toBeUndefined();
  });
});

describe('parseMfaResetResult', () => {
  it('accepts a reset that issued a grant', () => {
    expect(
      parseMfaResetResult({
        sessions_terminated: 2,
        reenrolment_grant_issued: true,
        grant_expires_at: '2026-10-23T16:00:00Z',
      }),
    ).toEqual({
      sessionsTerminated: 2,
      grantIssued: true,
      coalesced: false,
      grantExpiresAt: '2026-10-23T16:00:00Z',
    });
  });

  // Break caught: a repeated request, answered by the existing grant's metadata, being told as "a new link was sent".
  it('accepts a request that was coalesced, and says nothing new was issued', () => {
    expect(
      parseMfaResetResult({
        sessions_terminated: 0,
        reenrolment_grant_issued: false,
        coalesced: true,
        grant_expires_at: '2026-10-23T16:00:00Z',
      }),
    ).toMatchObject({ grantIssued: false, coalesced: true });
  });

  it('treats an absent flag as false and an absent or null expiry as none', () => {
    expect(parseMfaResetResult({ sessions_terminated: 0 })).toEqual({
      sessionsTerminated: 0,
      grantIssued: false,
      coalesced: false,
      grantExpiresAt: null,
    });
    expect(parseMfaResetResult({ sessions_terminated: 1, grant_expires_at: null })).toMatchObject({
      grantExpiresAt: null,
    });
  });

  // Break caught: a grant, a token or a link the server should never send being carried to the screen.
  it('returns only the fields it has judged, and never a grant', () => {
    const result = parseMfaResetResult({
      sessions_terminated: 1,
      reenrolment_grant_issued: true,
      setup_token: 'secret',
      link: 'https://example.test/setup/mfa#token=secret',
    });

    expect(result).toBeDefined();
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it.each([
    ['null', null],
    ['an empty object', {}],
    ['a count that is not a number', { sessions_terminated: 'two' }],
    ['a count below zero', { sessions_terminated: -1 }],
    ['a count that is not a whole number', { sessions_terminated: 1.5 }],
    ['an absurd count', { sessions_terminated: 1_000_000 }],
    [
      'an issued flag that is not a boolean',
      { sessions_terminated: 0, reenrolment_grant_issued: 1 },
    ],
    ['a coalesced flag that is not a boolean', { sessions_terminated: 0, coalesced: 'yes' }],
    ['an expiry that is not an instant', { sessions_terminated: 0, grant_expires_at: 'soon' }],
  ])('refuses %s', (_label, body) => {
    expect(parseMfaResetResult(body)).toBeUndefined();
  });
});

describe('parseSetupGrant', () => {
  const grant = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'd0000000-0000-4000-8000-000000000001',
    principal_type: 'STAFF',
    principal_id: staffIdentityFixture().id,
    purpose: 'STAFF_CREDENTIAL_SETUP',
    state: 'PENDING',
    issued_at: '2026-10-23T08:00:00Z',
    expires_at: '2026-10-23T08:30:00Z',
    ...overrides,
  });

  it('accepts a pending staff credential grant and returns when it lapses', () => {
    expect(parseSetupGrant(grant())).toEqual({ expiresAt: '2026-10-23T08:30:00Z' });
  });

  // Break caught: an answer for another kind of grant being told as "a setup link is on its way".
  it.each([
    ['a grant for another purpose', { purpose: 'MFA_REENROLMENT' }],
    ['a grant for another kind of principal', { principal_type: 'VENDOR' }],
    ['a grant that is not pending', { state: 'CONSUMED' }],
    ['no issue time', { issued_at: undefined }],
    ['an expiry that is not an instant', { expires_at: 'soon' }],
    ['an id that is not a uuid', { id: 'abc' }],
  ])('refuses %s', (_label, overrides) => {
    expect(parseSetupGrant(grant(overrides))).toBeUndefined();
  });

  it('accepts no expiry and carries none', () => {
    expect(parseSetupGrant(grant({ expires_at: null }))).toEqual({ expiresAt: null });
  });

  // Break caught: a token reaching a screen if a server ever sent one (the contract says it never does).
  it('never carries a token', () => {
    const result = parseSetupGrant(grant({ token: 'secret', setup_token: 'secret' }));

    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it.each([null, 'grant', [], {}])('refuses %j', (body) => {
    expect(parseSetupGrant(body)).toBeUndefined();
  });
});

describe('parseTrustedBrowser: a browser of a list (staff-authentication.md section 5.8)', () => {
  it('accepts a real-shaped browser and returns the six fields the contract gives, and nothing else', () => {
    expect(parseTrustedBrowser(trustedBrowserFixture())).toEqual(trustedBrowserFixture());
  });

  // Break caught: a credential, a hash, an authenticator or a generation reaching a screen because a server sent it.
  it('never carries a credential, a hash, a factor or a generation, if a server sent them', () => {
    const result = parseTrustedBrowser({
      ...trustedBrowserFixture(),
      token: 'SENTINEL-CREDENTIAL',
      token_hash: 'SENTINEL-HASH',
      factor_id: 'SENTINEL-FACTOR',
      credential_generation: 7,
    });

    expect(JSON.stringify(result)).not.toMatch(/SENTINEL|generation/);
    expect(Object.keys(result ?? {}).toSorted()).toEqual([
      'created_at',
      'current',
      'expires_at',
      'id',
      'label',
      'last_used_at',
    ]);
  });

  it('accepts a browser that has not been used, with the field null or absent', () => {
    expect(parseTrustedBrowser(trustedBrowserFixture({ last_used_at: null }))).toMatchObject({
      last_used_at: null,
    });
    const absent: Record<string, unknown> = { ...trustedBrowserFixture() };
    delete absent.last_used_at;
    expect(parseTrustedBrowser(absent)).toMatchObject({ last_used_at: null });
  });

  // Break caught: a half-made browser, a label that could be markup or a line break, or a browser that is not told from its neighbours.
  it.each([
    ['an id that is not a uuid', { id: 'abc' }],
    ['no label', { label: undefined }],
    ['a blank label', { label: '   ' }],
    ['a label over the contract’s 80 characters', { label: 'x'.repeat(81) }],
    ['a label with a line break', { label: 'Chrome\non Windows' }],
    ['a creation that is not an instant', { created_at: 'yesterday' }],
    ['an end that is not an instant', { expires_at: 'soon' }],
    ['a last use that is not an instant', { last_used_at: 'never' }],
    ['a current that is not a boolean', { current: 'yes' }],
    ['no current', { current: undefined }],
  ])('refuses %s', (_label, overrides) => {
    expect(parseTrustedBrowser({ ...trustedBrowserFixture(), ...overrides })).toBeUndefined();
  });

  it.each([undefined, null, 'browser', 3, []])('refuses %j', (body) => {
    expect(parseTrustedBrowser(body)).toBeUndefined();
  });
});

describe('parseTrustedBrowsers: the list', () => {
  const second = trustedBrowserFixture({ id: 'd1000000-0000-4000-8000-000000000002' });

  it('accepts the list, in the order sent, and an empty one', () => {
    expect(parseTrustedBrowsers({ items: [trustedBrowserFixture(), second] })).toEqual([
      trustedBrowserFixture(),
      second,
    ]);
    expect(parseTrustedBrowsers({ items: [] })).toEqual([]);
  });

  // Break caught: a list that is not the list, a browser listed twice, a list longer than anyone can hold, or two browsers saying they are the
  // one asking.
  it.each([
    ['a list with a browser that is not one', { items: [trustedBrowserFixture(), { id: 'x' }] }],
    ['a browser listed twice', { items: [trustedBrowserFixture(), trustedBrowserFixture()] }],
    ['no items', {}],
    ['items that are not a list', { items: 'many' }],
    [
      'more than anyone can hold',
      {
        items: Array.from({ length: 51 }, (_, index) =>
          trustedBrowserFixture({
            id: `d1000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
          }),
        ),
      },
    ],
    [
      'two browsers that say they are the one asking',
      {
        items: [
          trustedBrowserFixture({ current: true }),
          trustedBrowserFixture({ id: 'd1000000-0000-4000-8000-000000000002', current: true }),
        ],
      },
    ],
  ])('refuses %s', (_label, body) => {
    expect(parseTrustedBrowsers(body)).toBeUndefined();
  });
});

describe('parseTrustedBrowsersRevoked: how many an administrator’s removal ended', () => {
  it.each([0, 1, 5])('accepts %j', (count) => {
    expect(parseTrustedBrowsersRevoked({ revoked: count })).toBe(count);
  });

  it.each([
    undefined,
    null,
    {},
    { revoked: -1 },
    { revoked: 1.5 },
    { revoked: '2' },
    { revoked: 51 },
    { revoked: null },
  ])('refuses %j', (body) => {
    expect(parseTrustedBrowsersRevoked(body)).toBeUndefined();
  });
});
