import { describe, expect, it } from 'vitest';

import { parseRecordLookup, RECORD_LOOKUP_KINDS } from './record-lookup-shape';

/**
 * The guard that judges the answer of `lookupRecords` (task C2; `AC-LOOKUP-10`, `-12`): the same discipline as the queue summary's. A result is a
 * pointer to a record and the facts that say where it stands; the page draws what the guard judged and nothing else, and never a number in
 * clear.
 */
const ID = '6a7b8c9d-0e1f-4a2b-9c3d-4e5f6a7b8c9d';
const HUB = '5eed0100-0000-4000-8000-000000000001';

const result = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: 'PICKUP_REQUEST',
  id: ID,
  code: 'ACC-PR-7KQ2MZ',
  title: 'ACC-PR-7KQ2MZ',
  state: 'PENDING',
  hub: { id: HUB, display_name: 'Accra' },
  service_date: '2026-11-07',
  ...over,
});

describe('the answer of lookupRecords', () => {
  // Break caught: a field of the answer renamed or dropped on the way to the screen, or a property the guard does not read carried into it.
  it('carries the facts of each result, none for what the record does not have, and nothing the guard did not read', () => {
    const view = parseRecordLookup({
      items: [
        // A property the contract does not have (a route, a sentence) is not carried, even if a proxy adds it.
        result({ extra: 'x', route: '/pickup-requests/x', subtitle: 'Kofi · Confirmed' }),
        result({
          kind: 'RIDER',
          code: undefined,
          title: 'Ama Boateng',
          state: 'ACTIVE',
          service_date: undefined,
          phone_hint: '+233******222',
        }),
        result({
          kind: 'STAFF_IDENTITY',
          code: undefined,
          title: 'Yara Floating',
          state: 'ACTIVE',
          hub: undefined,
          service_date: undefined,
        }),
      ],
    });

    expect(view?.items).toEqual([
      {
        kind: 'PICKUP_REQUEST',
        id: ID,
        code: 'ACC-PR-7KQ2MZ',
        title: 'ACC-PR-7KQ2MZ',
        state: 'PENDING',
        hub: { id: HUB, name: 'Accra' },
        serviceDate: '2026-11-07',
        phoneHint: null,
      },
      {
        kind: 'RIDER',
        id: ID,
        code: null,
        title: 'Ama Boateng',
        state: 'ACTIVE',
        hub: { id: HUB, name: 'Accra' },
        serviceDate: null,
        phoneHint: '+233******222',
      },
      {
        kind: 'STAFF_IDENTITY',
        id: ID,
        code: null,
        title: 'Yara Floating',
        state: 'ACTIVE',
        hub: null,
        serviceDate: null,
        phoneHint: null,
      },
    ]);
  });

  it('is an empty list for an answer with no result', () => {
    expect(parseRecordLookup({ items: [] })?.items).toEqual([]);
  });

  // Break caught: a proxy's "{}", or a page of the wrong shape, drawn as "nothing found".
  it.each([
    undefined,
    null,
    'items',
    [],
    {},
    { items: 'many' },
    { items: {} },
    { items: [null] },
    { items: [7] },
  ])('refuses %j as an answer', (body) => {
    expect(parseRecordLookup(body)).toBeUndefined();
  });

  it.each([
    ['an id that is not a string', { id: 7 }],
    ['an id that is empty', { id: '' }],
    ['an id that is not an identifier', { id: '../admin/staff' }],
    ['a title that is not a string', { title: 7 }],
    ['a title that is missing', { title: undefined }],
    ['a code that is not a string', { code: 7 }],
    ['a kind that is not a word', { kind: 7 }],
    ['a state that is not a string', { state: 7 }],
    ['a state that is not a word of an enumeration', { state: 'pending approval' }],
    ['a state with a sentence in it', { state: 'PENDING <b>' }],
    ['a hub that is not an object', { hub: 'Accra' }],
    ['a hub with no name', { hub: { id: HUB } }],
    ['a hub whose name is blank', { hub: { id: HUB, display_name: '   ' } }],
    ['a hub whose name is empty', { hub: { id: HUB, display_name: '' } }],
    ['a hub with no id', { hub: { display_name: 'Accra' } }],
    ['a hub whose id is not an identifier', { hub: { id: 'accra', display_name: 'Accra' } }],
    ['a hub whose name is not a string', { hub: { id: HUB, display_name: 7 } }],
    ['a service date that is not a date', { service_date: 'tomorrow' }],
    ['a service date that does not exist', { service_date: '2026-02-30' }],
    ['a phone hint that is not a string', { phone_hint: 7 }],
  ])('refuses an answer with %s', (_why, over) => {
    expect(parseRecordLookup({ items: [result(over)] })).toBeUndefined();
  });

  // Break caught: a phone number in clear drawn because a result said it was a hint.
  it.each([
    '+233241112222',
    '0241112222',
    '233241112222',
    '+233 24 111 2222',
    '024 111 2222',
    '+233******',
    '******222',
    '+233******222222',
  ])('refuses a phone hint that is not a masked number: %j', (phone_hint) => {
    expect(parseRecordLookup({ items: [result({ phone_hint })] })).toBeUndefined();
  });

  // Break caught: a kind of a newer server drawn with an identifier for words, or the whole answer refused for one record the page cannot show.
  it('leaves out a result of a kind this build does not know, and keeps the rest', () => {
    const view = parseRecordLookup({
      items: [result({ kind: 'DELIVERY_ORDER' }), result({ kind: 'VENDOR_ACCOUNT' })],
    });
    expect(view?.items.map((item) => item.kind)).toEqual(['VENDOR_ACCOUNT']);
  });

  // Break caught: a guard that takes more than the contract's twenty, which a page of the API would never be.
  it('refuses an answer with more results than the contract allows, and takes the twenty it does', () => {
    expect(
      parseRecordLookup({ items: Array.from({ length: 21 }, () => result()) }),
    ).toBeUndefined();
    expect(
      parseRecordLookup({ items: Array.from({ length: 20 }, () => result()) })?.items,
    ).toHaveLength(20);
  });

  it('knows the five kinds the contract names, in the order the answer lists them', () => {
    expect([...RECORD_LOOKUP_KINDS]).toEqual([
      'PICKUP_REQUEST',
      'PICKUP_MANIFEST',
      'VENDOR_ACCOUNT',
      'RIDER',
      'STAFF_IDENTITY',
    ]);
  });
});
