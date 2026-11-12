import { describe, expect, it } from 'vitest';

import type { RecordLookupResultView } from '../../platform/lookup/record-lookup-shape';
import { recordLine, stateWords } from './record-line';

const HUB = { id: '5b6c7d8e-9f01-4a2b-8c3d-4e5f6a7b8c9d', name: 'Accra Hub' };

const result = (over: Partial<RecordLookupResultView>): RecordLookupResultView => ({
  kind: 'PICKUP_REQUEST',
  id: '3f4c6b0e-0d8a-4a6e-9f55-1b2f0c9d7e11',
  code: 'PR-000123',
  title: 'PR-000123',
  state: null,
  hub: null,
  serviceDate: null,
  senderName: null,
  phoneHint: null,
  ...over,
});

describe('the line under a result of the search', () => {
  // Break caught: the sender's name, the state, the hub and the date out of the order the decision gave, or a part missing.
  it('is, for a pickup request, the sender, the state in plain words, the hub and the date', () => {
    expect(
      recordLine(
        result({
          senderName: 'Ama Vendor',
          state: 'PENDING',
          hub: HUB,
          serviceDate: '2026-11-02',
        }),
      ),
    ).toBe('Ama Vendor · Waiting for confirmation · Accra Hub · Mon 2 Nov 2026');
  });

  // Break caught: a raw state value on the screen (`IN_PROGRESS`), or a state worded differently from the page that shows the same state.
  it.each([
    ['PICKUP_REQUEST', 'PENDING', 'Waiting for confirmation'],
    ['PICKUP_REQUEST', 'CONFIRMED', 'Confirmed'],
    ['PICKUP_REQUEST', 'CANCELLED', 'Cancelled'],
    ['PICKUP_MANIFEST', 'IN_PROGRESS', 'In progress'],
    ['PICKUP_MANIFEST', 'DRAFT', 'Draft'],
    ['VENDOR_ACCOUNT', 'SUSPENDED', 'Suspended'],
    ['RIDER', 'TEMPORARILY_UNAVAILABLE', 'Temporarily unavailable'],
    ['STAFF_IDENTITY', 'PENDING_APPROVAL', 'Waiting for approval'],
  ] as const)('words the state of a %s, %s, as %s', (kind, state, words) => {
    expect(stateWords(kind, state)).toBe(words);
    expect(recordLine(result({ kind, state }))).toBe(words);
  });

  // Break caught: a state this build has no words for drawn as the server's value, which is never shown.
  it('leaves out a state it has no words for, and a state that is a property of another kind', () => {
    expect(recordLine(result({ state: 'A_STATE_FROM_THE_FUTURE' }))).toBe('');
    expect(stateWords('PICKUP_REQUEST', 'IN_PROGRESS')).toBeUndefined();
    expect(stateWords('PICKUP_REQUEST', 'constructor')).toBeUndefined();
    expect(stateWords('PICKUP_REQUEST', null)).toBeUndefined();
  });

  // Break caught: the sender's name drawn for a kind that has none, or for a rider (whose name is already the title).
  it('names the sender for a pickup request only', () => {
    expect(
      recordLine(result({ kind: 'RIDER', senderName: 'Not shown', state: 'ACTIVE', hub: HUB })),
    ).toBe('Active · Accra Hub');
  });

  it('is the state and the hub for a vendor account, a rider and a staff profile, and adds the date for a run', () => {
    expect(recordLine(result({ kind: 'VENDOR_ACCOUNT', state: 'ACTIVE', hub: HUB }))).toBe(
      'Active · Accra Hub',
    );
    expect(
      recordLine(
        result({
          kind: 'PICKUP_MANIFEST',
          state: 'DISPATCHED',
          hub: HUB,
          serviceDate: '2026-11-03',
        }),
      ),
    ).toBe('Dispatched · Accra Hub · Tue 3 Nov 2026');
  });

  // Break caught: a phone number that is not the server's hint, drawn in clear; or the hint dropped when it is the reason the record was found.
  it('ends with the masked phone exactly as it was returned, and only then', () => {
    expect(
      recordLine(result({ kind: 'RIDER', state: 'ACTIVE', hub: HUB, phoneHint: '+233******222' })),
    ).toBe('Active · Accra Hub · +233******222');
    expect(recordLine(result({ kind: 'RIDER', state: 'ACTIVE', phoneHint: '+233******222' }))).toBe(
      'Active · +233******222',
    );
  });

  it('leaves out every part the result does not have, and is empty for a result with none', () => {
    expect(recordLine(result({ kind: 'STAFF_IDENTITY' }))).toBe('');
    expect(recordLine(result({ kind: 'STAFF_IDENTITY', hub: HUB }))).toBe('Accra Hub');
  });
});
