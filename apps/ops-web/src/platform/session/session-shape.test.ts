import { describe, expect, it } from 'vitest';

import { sessionFixture } from '../../test-support/session-fixture';
import { parseCurrentSession } from './session-shape';

const HUB = '5b6c7d8e-9f01-4a2b-8c3d-4e5f6a7b8c9d';
const OTHER_HUB = '6c7d8e9f-0a12-4b3c-9d4e-5f6a7b8c9d0e';

/** A real-shaped answer of `getCurrentSession`: the fields the contract lists and nothing it does not. */
const real = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...sessionFixture(),
  ...overrides,
});

describe('parseCurrentSession: what is accepted', () => {
  it('accepts a real-shaped session and returns what the foundation reads of it', () => {
    const session = parseCurrentSession(real());

    expect(session).toMatchObject({
      principal_type: 'STAFF',
      state: 'ACTIVE',
      principal_display_name: 'Synthetic Officer',
      authorized_hubs: [{ id: HUB, display_name: 'Synthetic Hub' }],
      permissions: ['staff.read'],
    });
  });

  // Break caught: a name that the contract allows to be null (a principal with none) being refused, so that such a person cannot sign in.
  it('accepts a null display name, an empty hub list and a session with no permissions listed', () => {
    const bare = real();
    delete bare.permissions;

    expect(
      parseCurrentSession({ ...bare, principal_display_name: null, authorized_hubs: [] }),
    ).toMatchObject({
      principal_display_name: null,
      authorized_hubs: [],
    });
    expect(parseCurrentSession(real({ permissions: [] }))).toMatchObject({ permissions: [] });
  });

  // Break caught: the guard copying the server's object through, so that a field it did not validate reaches the screens.
  it('returns only the fields it has judged', () => {
    const session = parseCurrentSession(real({ surprise: { nested: true } }));

    expect(session).toBeDefined();
    expect(session).not.toHaveProperty('surprise');
  });
});

describe('parseCurrentSession: the principal id (S0.44)', () => {
  // Break caught: the id the screens compare a record's maker with being dropped, so "you created this" is never said.
  it('carries the id of the signed-in staff member', () => {
    expect(parseCurrentSession(real())?.principal_id).toBe('8a1d2c3e-4f50-4a6b-8c7d-9e0f1a2b3c4d');
  });

  // Break caught: an answer without it being refused, which would sign nobody in on a server that does not send it yet.
  it('accepts a session that does not name its principal', () => {
    const bare = real();
    delete bare.principal_id;

    const session = parseCurrentSession(bare);

    expect(session).toBeDefined();
    expect(session).not.toHaveProperty('principal_id');
  });

  // Break caught: a value that is not an id being believed and compared with ids.
  it.each([
    ['a string that is not an id', 'ama'],
    ['an empty string', ''],
    ['null, which the contract does not allow', null],
    ['a number', 7],
    ['an id with a stray character', '8a1d2c3e-4f50-4a6b-8c7d-9e0f1a2b3c4d '],
  ])('refuses %s', (_label, value) => {
    expect(parseCurrentSession(real({ principal_id: value }))).toBeUndefined();
  });
});

describe('parseCurrentSession: what is refused (U05 of 23 October 2026)', () => {
  // Break caught: a 200 with a body that is not a session being signed in. Each of these used to pass: an object was enough.
  it.each([
    ['null', null],
    ['a string', 'session'],
    ['a number', 7],
    ['a list', []],
    ['an empty object', {}],
    ['an object with only a name', { principal_display_name: 'Ama' }],
  ])('refuses %s', (_label, body) => {
    expect(parseCurrentSession(body)).toBeUndefined();
  });

  describe('the discriminators', () => {
    it.each([
      ['an unknown principal type', { principal_type: 'ROBOT' }],
      ['a type in lower case', { principal_type: 'staff' }],
      ['no principal type', { principal_type: undefined }],
      ['a vendor session, which is not the Ops Portal’s', { principal_type: 'VENDOR' }],
      ['a rider session, which is not the Ops Portal’s', { principal_type: 'RIDER' }],
      ['a session that has ended', { state: 'TERMINATED' }],
      ['an unknown state', { state: 'PAUSED' }],
      ['no state', { state: undefined }],
      ['no id', { id: undefined }],
      ['an id that is not text', { id: 7 }],
      ['no expiry', { expires_at: undefined }],
      ['an expiry that is not a time', { expires_at: 'tomorrow' }],
    ])('refuses %s', (_label, overrides) => {
      expect(parseCurrentSession(real(overrides))).toBeUndefined();
    });
  });

  describe('the name', () => {
    it.each([
      ['a number', 7],
      ['an object', { first: 'Ama' }],
      ['a list', ['Ama']],
      ['undefined (a field the contract says is always present)', undefined],
    ])('refuses a display name that is %s', (_label, name) => {
      expect(parseCurrentSession(real({ principal_display_name: name }))).toBeUndefined();
    });
  });

  describe('the hubs', () => {
    it.each([
      ['not a list', 'Accra'],
      ['an object', { id: HUB, display_name: 'Accra' }],
      ['absent', undefined],
      ['null', null],
      ['holding a string', ['Accra']],
      ['holding null', [null]],
      ['holding an entry with no id', [{ display_name: 'Accra' }]],
      ['holding an entry with no name', [{ id: HUB }]],
      ['holding an id that is not a UUID', [{ id: 'accra', display_name: 'Accra' }]],
      ['holding an id that is not text', [{ id: 7, display_name: 'Accra' }]],
      ['holding a name that is not text', [{ id: HUB, display_name: 7 }]],
      ['holding a name that is null', [{ id: HUB, display_name: null }]],
      [
        'holding the same hub twice, which would make two rows of one',
        [
          { id: HUB, display_name: 'Accra' },
          { id: HUB.toUpperCase(), display_name: 'Accra' },
        ],
      ],
      ['holding one good entry and one bad', [{ id: HUB, display_name: 'Accra' }, { id: 'x' }]],
    ])('refuses a hub list that is %s', (_label, hubs) => {
      expect(parseCurrentSession(real({ authorized_hubs: hubs }))).toBeUndefined();
    });

    it('accepts several distinct hubs, in the order given', () => {
      const session = parseCurrentSession(
        real({
          authorized_hubs: [
            { id: HUB, display_name: 'Accra' },
            { id: OTHER_HUB, display_name: 'Kumasi' },
          ],
        }),
      );

      expect(session?.authorized_hubs.map((hub) => hub.display_name)).toEqual(['Accra', 'Kumasi']);
    });
  });

  describe('the permissions', () => {
    it.each([
      ['not a list', 'staff.read'],
      ['null', null],
      ['an object', { 0: 'staff.read' }],
      ['holding a number', [7]],
      ['holding null', [null]],
      ['holding an empty key', ['']],
      ['holding a key that is not shaped like one', ['Staff Read']],
      ['holding a key in upper case', ['STAFF.READ']],
      ['holding a very long key', [`a.${'b'.repeat(200)}`]],
      ['holding one good key and one bad', ['staff.read', 7]],
    ])('refuses a permission list that is %s', (_label, permissions) => {
      expect(parseCurrentSession(real({ permissions }))).toBeUndefined();
    });
  });
});
