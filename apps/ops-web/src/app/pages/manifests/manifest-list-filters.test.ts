import { describe, expect, it } from 'vitest';

import { MANIFEST_FILTER_STATES } from '../../../platform/manifest/manifest-shape';
import { filtersOf, searchOf, stateOfText } from './manifest-list-filters';

/**
 * The filters of the manifest list as the address carries them (OB-S1-25): each judged as it is read, so that what the screen holds, and sends,
 * is a state of the contract or a day that exists, and nothing else. The address is the person's to edit.
 */
const params = (query: string) => new URLSearchParams(query);

describe('the state of an address', () => {
  it.each(MANIFEST_FILTER_STATES)('reads %s', (state) => {
    expect(stateOfText(state)).toBe(state);
  });

  // Break caught: a made-up state kept as a filter, which the server answers with a 400.
  it.each([null, '', 'draft', 'Draft', 'DRAFT ', ' DRAFT', 'ASSIGNED', 'constructor', '__proto__'])(
    'reads %j as no state',
    (text) => {
      expect(stateOfText(text)).toBeUndefined();
    },
  );
});

describe('the filters of an address', () => {
  it('reads both, each judged', () => {
    expect(filtersOf(params('state=IN_PROGRESS&date=2026-11-04'))).toEqual({
      state: 'IN_PROGRESS',
      date: '2026-11-04',
    });
  });

  it('keeps one that is sound when the other is not', () => {
    expect(filtersOf(params('state=nope&date=2026-11-04'))).toEqual({ date: '2026-11-04' });
    expect(filtersOf(params('state=DRAFT&date=2026-02-30'))).toEqual({ state: 'DRAFT' });
  });

  // Break caught: a repeated parameter read as the last, or as both.
  it('reads the first of a repeated parameter', () => {
    expect(
      filtersOf(params('state=DRAFT&state=COMPLETED&date=2026-11-04&date=2026-11-05')),
    ).toEqual({
      state: 'DRAFT',
      date: '2026-11-04',
    });
  });

  it('reads nothing from an address with no filter', () => {
    expect(filtersOf(params(''))).toEqual({});
    expect(filtersOf(params('page_token=abc&evil=1'))).toEqual({});
  });
});

describe('the address of filters', () => {
  it('is the filters that are set, in a fixed order, and nothing when none is', () => {
    expect(searchOf({})).toBe('');
    expect(searchOf({ state: 'DRAFT' })).toBe('?state=DRAFT');
    expect(searchOf({ date: '2026-11-04' })).toBe('?date=2026-11-04');
    expect(searchOf({ date: '2026-11-04', state: 'DRAFT' })).toBe('?state=DRAFT&date=2026-11-04');
  });
});
