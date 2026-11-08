import { describe, expect, it } from 'vitest';

import {
  ENROLMENT_CHALLENGE,
  ENROLMENT_TOKEN,
  ENROLMENT_URI,
  enrolmentGrantFixture,
  OTHER_RIDER_ID,
  riderDetailFixture,
  riderDeviceFixture,
  riderFixture,
  RIDER_ID,
} from '../../test-support/rider-fixture';
import {
  ENROLMENT_URI_LENGTH,
  parseEnrolmentGrant,
  parseRider,
  parseRiderDetail,
  parseRiderDevice,
  parseRiderPage,
  RIDER_STATUSES,
} from './rider-shape';

const rider = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...riderFixture(),
  ...overrides,
});

describe('parseRider: what is accepted', () => {
  it('accepts a real-shaped rider and returns what the screens read of it', () => {
    expect(parseRider(rider())).toEqual(riderFixture());
  });

  // Break caught: a status of the contract being refused, so that a rider in it cannot be listed.
  it.each(RIDER_STATUSES)('accepts the status %s', (status) => {
    expect(parseRider(rider({ status }))?.status).toBe(status);
  });

  // Break caught: the guard copying the server's object through, so that a field it did not judge (a PIN, a hash, a key) reaches a screen.
  it('returns only the fields it has judged', () => {
    const found = parseRider(
      rider({
        pin: '123456',
        pin_hash: '$argon2id$x',
        public_key: 'MFkw',
        attestation: { chain: ['x'] },
        failed_attempts: 3,
      }),
    );

    expect(found).toBeDefined();
    for (const name of ['pin', 'pin_hash', 'public_key', 'attestation', 'failed_attempts']) {
      expect(found, name).not.toHaveProperty(name);
    }
  });

  it('accepts a phone of the shortest and the longest E.164 length, and nothing between is folded', () => {
    expect(parseRider(rider({ phone: '+12345678' }))?.phone).toBe('+12345678');
    expect(parseRider(rider({ phone: '+123456789012345' }))?.phone).toBe('+123456789012345');
  });
});

describe('parseRider: what is refused', () => {
  // Break caught: a 200 with a body that is not a rider being shown as one.
  it.each([
    ['null', null],
    ['a string', 'rider'],
    ['a number', 7],
    ['a list', []],
    ['an empty object', {}],
  ])('refuses %s', (_label, body) => {
    expect(parseRider(body)).toBeUndefined();
  });

  // Break caught: a field the screens draw from, or act on, being believed without being judged.
  it.each([
    ['no id', { id: undefined }],
    ['an id that is not a uuid', { id: 'kwame' }],
    ['a blank name', { full_name: '   ' }],
    ['a name that is not a string', { full_name: 7 }],
    ['a name with a line break', { full_name: 'Kwame\nMensah' }],
    ['a name beyond the bound of a line', { full_name: 'k'.repeat(513) }],
    ['no phone', { phone: undefined }],
    ['a phone that is not a string', { phone: 233201234567 }],
    ['a national number', { phone: '0201234567' }],
    ['a number without its plus', { phone: '233201234567' }],
    ['a number with spaces', { phone: '+233 20 123 4567' }],
    ['a number that starts with a zero', { phone: '+0201234567' }],
    ['a number too short', { phone: '+1234567' }],
    ['a number too long', { phone: '+1234567890123456' }],
    ['a number with letters', { phone: '+23320123456a' }],
    ['no status', { status: undefined }],
    ['a status the contract does not have', { status: 'PENDING' }],
    ['a status in lower case', { status: 'active' }],
    ['no hub', { primary_hub_id: undefined }],
    ['a null hub', { primary_hub_id: null }],
    ['a hub that is not a uuid', { primary_hub_id: 'accra' }],
    ['no pin_established', { pin_established: undefined }],
    ['a pin_established that is a string', { pin_established: 'true' }],
    ['a pin_established that is a number', { pin_established: 1 }],
    ['no has_active_device', { has_active_device: undefined }],
    ['a has_active_device that is null', { has_active_device: null }],
  ])('refuses a rider with %s', (_label, overrides) => {
    expect(parseRider(rider(overrides))).toBeUndefined();
  });
});

describe('parseRiderPage', () => {
  it('accepts a page, with and without a token for the next', () => {
    expect(parseRiderPage({ items: [rider()], next_page_token: null })).toEqual({
      items: [riderFixture()],
      nextPageToken: null,
    });
    expect(parseRiderPage({ items: [], next_page_token: 'abc' })).toEqual({
      items: [],
      nextPageToken: 'abc',
    });
  });

  // Break caught: one bad rider being dropped quietly, so that a roster looks complete when it is not.
  it('refuses a page in which one rider is not one', () => {
    expect(parseRiderPage({ items: [rider(), rider({ phone: 'x' })], next_page_token: null })).toBe(
      undefined,
    );
  });

  // Break caught: a page larger than the contract's page size being believed.
  it('refuses a page beyond the largest the contract allows', () => {
    const items = Array.from({ length: 101 }, () => rider());
    expect(parseRiderPage({ items, next_page_token: null })).toBeUndefined();
    expect(parseRiderPage({ items: items.slice(0, 100), next_page_token: null })).toBeDefined();
  });

  it.each([
    ['no items', { next_page_token: null }],
    ['items that are not a list', { items: {}, next_page_token: null }],
    ['no token field', { items: [] }],
    ['an empty token', { items: [], next_page_token: '' }],
    ['a token that is a number', { items: [], next_page_token: 3 }],
    ['a token beyond any the API makes', { items: [], next_page_token: 't'.repeat(2049) }],
    ['a body that is a list', []],
    ['nothing', null],
  ])('refuses a page with %s', (_label, body) => {
    expect(parseRiderPage(body)).toBeUndefined();
  });
});

describe('parseRiderDevice', () => {
  const device = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    ...riderDeviceFixture(),
    ...overrides,
  });

  it('accepts a real-shaped device of the rider and returns what the screens read of it', () => {
    expect(parseRiderDevice(device(), RIDER_ID)).toEqual(riderDeviceFixture());
  });

  // Break caught: the optional fields of a device (an old record has neither) being required, so that the rider cannot be opened.
  it('accepts a device with no registration time and no officer', () => {
    const bare = device();
    delete bare.registered_at;
    delete bare.registered_by;

    expect(parseRiderDevice(bare, RIDER_ID)).toEqual({
      id: riderDeviceFixture().id,
      principal_type: 'RIDER',
      principal_id: RIDER_ID,
      device_kind: 'RIDER_ANDROID_KEYPAIR',
      status: 'ACTIVE',
      registered_by: null,
    });
    expect(parseRiderDevice(device({ registered_by: null }), RIDER_ID)?.registered_by).toBeNull();
  });

  it.each(['ACTIVE', 'REPLACED', 'REVOKED'])('accepts the status %s', (status) => {
    expect(parseRiderDevice(device({ status }), RIDER_ID)?.status).toBe(status);
  });

  it('judges the owner without regard to case', () => {
    expect(
      parseRiderDevice(device({ principal_id: RIDER_ID.toUpperCase() }), RIDER_ID),
    ).toBeDefined();
  });

  // Break caught: a key, a hash or an attestation (neither of which the API sends) reaching a screen through the device.
  it('returns only the fields it has judged', () => {
    const found = parseRiderDevice(
      device({ public_key: 'MFkw', device_credential_hash: 'h', attestation: {} }),
      RIDER_ID,
    );

    expect(found).toBeDefined();
    for (const name of ['public_key', 'device_credential_hash', 'attestation']) {
      expect(found, name).not.toHaveProperty(name);
    }
  });

  // Break caught: another rider's device, a vendor's browser, or a record of an unknown kind being listed as this rider's.
  it.each([
    ['another rider’s device', { principal_id: OTHER_RIDER_ID }],
    ['a vendor’s browser', { principal_type: 'VENDOR', device_kind: 'VENDOR_BROWSER_CREDENTIAL' }],
    ['a device kind of the vendors', { device_kind: 'VENDOR_BROWSER_CREDENTIAL' }],
    ['a principal type of the vendors', { principal_type: 'VENDOR' }],
    ['a status the contract does not have', { status: 'LOST' }],
    ['an id that is not a uuid', { id: 'phone' }],
    ['a registration time that is not an instant', { registered_at: 'yesterday' }],
    ['an officer that is not a uuid', { registered_by: 'amina' }],
    ['no principal', { principal_id: undefined }],
  ])('refuses %s', (_label, overrides) => {
    expect(parseRiderDevice(device(overrides), RIDER_ID)).toBeUndefined();
  });

  it('refuses what is not a record', () => {
    expect(parseRiderDevice(null, RIDER_ID)).toBeUndefined();
    expect(parseRiderDevice([], RIDER_ID)).toBeUndefined();
    expect(parseRiderDevice('device', RIDER_ID)).toBeUndefined();
  });
});

describe('parseRiderDetail', () => {
  it('accepts the rider and the devices the rider has held', () => {
    const body = riderDetailFixture(riderFixture(), [
      riderDeviceFixture(),
      riderDeviceFixture({ id: '9c0d1e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f', status: 'REVOKED' }),
    ]);

    const found = parseRiderDetail(body);

    expect(found?.rider).toEqual(riderFixture());
    expect(found?.devices.map((device) => device.status)).toEqual(['ACTIVE', 'REVOKED']);
  });

  it('accepts a rider who has held no device', () => {
    expect(parseRiderDetail({ rider: rider(), devices: [] })?.devices).toEqual([]);
  });

  // Break caught: one device that is not the rider's being dropped quietly, so that the record looks complete when it is not.
  it('refuses a record in which one device is not one of the rider’s', () => {
    expect(
      parseRiderDetail({
        rider: rider(),
        devices: [riderDeviceFixture(), riderDeviceFixture({ principal_id: OTHER_RIDER_ID })],
      }),
    ).toBeUndefined();
  });

  it.each([
    ['no rider', { devices: [] }],
    ['a rider that is not one', { rider: { id: RIDER_ID }, devices: [] }],
    ['no devices', { rider: rider() }],
    ['devices that are not a list', { rider: rider(), devices: {} }],
    [
      'more devices than a rider has ever held',
      { rider: rider(), devices: new Array(201).fill(1) },
    ],
  ])('refuses a record with %s', (_label, body) => {
    expect(parseRiderDetail(body)).toBeUndefined();
  });
});

describe('parseEnrolmentGrant', () => {
  const grant = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    ...enrolmentGrantFixture(),
    ...overrides,
  });

  it('is the exact version-1 code and the moment it lapses, and nothing else', () => {
    const body = grant();

    expect(parseEnrolmentGrant(body, RIDER_ID)).toEqual({
      enrolmentUri: ENROLMENT_URI,
      expiresAt: body.expires_at,
    });
    expect(ENROLMENT_URI).toHaveLength(ENROLMENT_URI_LENGTH);
  });

  // Break caught: a field the grant does not need reaching the page that holds it.
  it('keeps nothing the answer carries besides the code and when it lapses', () => {
    const found = parseEnrolmentGrant(grant({ token: ENROLMENT_TOKEN, extra: 'x' }), RIDER_ID);

    expect(Object.keys(found ?? {}).toSorted()).toEqual(['enrolmentUri', 'expiresAt']);
  });

  it('accepts a grant that does not name the rider, and one that names this rider in either case', () => {
    expect(parseEnrolmentGrant(grant({ rider_id: undefined }), RIDER_ID)).toBeDefined();
    expect(parseEnrolmentGrant(grant({ rider_id: null }), RIDER_ID)).toBeDefined();
    expect(
      parseEnrolmentGrant(grant({ rider_id: RIDER_ID.toUpperCase() }), RIDER_ID),
    ).toBeDefined();
  });

  // Break caught: a code made for another rider being drawn for this one.
  it('refuses a grant that names another rider', () => {
    expect(parseEnrolmentGrant(grant({ rider_id: OTHER_RIDER_ID }), RIDER_ID)).toBeUndefined();
    expect(parseEnrolmentGrant(grant({ rider_id: 'not-a-uuid' }), RIDER_ID)).toBeUndefined();
  });

  // Break caught: a code the Rider app would take, or reject, that the page draws all the same: only the one exact form is a code.
  it.each([
    ['another version', ENROLMENT_URI.replace('/v1#', '/v2#')],
    ['another scheme', ENROLMENT_URI.replace('melarc-rider', 'https')],
    ['another host', ENROLMENT_URI.replace('//enrol/', '//evil/')],
    [
      'the token and the challenge the wrong way round',
      `melarc-rider://enrol/v1#challenge=${ENROLMENT_CHALLENGE}&token=${ENROLMENT_TOKEN}`,
    ],
    ['a query where the fragment belongs', ENROLMENT_URI.replace('#', '?')],
    ['padding', `${ENROLMENT_URI.slice(0, -1)}=`],
    ['a token that is too short', ENROLMENT_URI.replace(ENROLMENT_TOKEN, ENROLMENT_TOKEN.slice(1))],
    [
      'a character outside base64url',
      ENROLMENT_URI.replace('SentinelEnrolmentToken', 'SentinelEnrolmentToke+'),
    ],
    ['a trailing parameter', `${ENROLMENT_URI}&callback=https://evil.example`],
    ['a trailing newline', `${ENROLMENT_URI}\n`],
    ['a leading space', ` ${ENROLMENT_URI}`],
    ['nothing', ''],
  ])('refuses a code with %s', (_label, uri) => {
    expect(parseEnrolmentGrant(grant({ enrolment_uri: uri }), RIDER_ID)).toBeUndefined();
  });

  it('refuses a code that is not text', () => {
    expect(parseEnrolmentGrant(grant({ enrolment_uri: 7 }), RIDER_ID)).toBeUndefined();
    expect(parseEnrolmentGrant(grant({ enrolment_uri: undefined }), RIDER_ID)).toBeUndefined();
  });

  // Break caught: a code with no end, which would be drawn and never lapse.
  it.each([
    ['no moment', { expires_at: undefined }],
    ['a moment that is not an instant', { expires_at: 'soon' }],
    ['a moment without a zone', { expires_at: '2026-10-27T10:00:00' }],
  ])('refuses a grant with %s', (_label, overrides) => {
    expect(parseEnrolmentGrant(grant(overrides), RIDER_ID)).toBeUndefined();
  });

  it('refuses what is not a record', () => {
    expect(parseEnrolmentGrant(null, RIDER_ID)).toBeUndefined();
    expect(parseEnrolmentGrant([], RIDER_ID)).toBeUndefined();
    expect(parseEnrolmentGrant(ENROLMENT_URI, RIDER_ID)).toBeUndefined();
  });
});
