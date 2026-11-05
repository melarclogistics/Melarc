import { describe, expect, it } from 'vitest';

import {
  HubConfiguration,
  type ServiceZoneRecord,
  type ZoneAliasRecord,
} from '../platform/settings/hub-configuration.js';
import { authorizeZone, normaliseAddressText, resolveZone } from './zone-resolver.js';

/**
 * The address-to-zone rule (S1.5; SLICE-001 D-02 of 29 October 2026; settings.md §7.2; §23.3: a free-text address is never
 * authoritative). The aliases in these tests are fixtures: the real alias data is the Product Owner’s to supply (OB-S1-02), and the
 * resolver is proved on the shapes of an address, not on Accra’s geography.
 */
const HUB = '5eed0100-0000-4000-8000-000000000001';

const zone = (n: number, code: string, serviceArea: string, active = true): ServiceZoneRecord => ({
  id: `5eed0101-0000-4000-8000-${String(n).padStart(12, '0')}`,
  hubId: HUB,
  code,
  name: code,
  serviceArea,
  active,
});
const TEMA = zone(1, 'TEMA', 'ACCRA_TEMA');
const MADINA = zone(2, 'MADINA_ADENTA', 'ACCRA_TEMA');
const AMASAMAN = zone(3, 'AMASAMAN_ENVIRONS', 'AMASAMAN_ENVIRONS');
const RETIRED = zone(4, 'OLD_ZONE', 'ACCRA_TEMA', false);

const alias = (n: number, text: string, target: ServiceZoneRecord): ZoneAliasRecord => ({
  id: `5eed0102-0000-4000-8000-${String(n).padStart(12, '0')}`,
  hubId: HUB,
  zoneId: target.id,
  alias: text,
  kind: 'AREA',
});

const config = (aliases: readonly ZoneAliasRecord[]) =>
  new HubConfiguration({
    hubId: HUB,
    at: new Date('2026-10-29T10:00:00Z'),
    zones: [TEMA, MADINA, AMASAMAN, RETIRED],
    aliases,
    settings: [],
    company: [],
  });

describe('normalising an address', () => {
  // Break caught: two spellings of one place failing to meet because of case, spacing or punctuation.
  it.each([
    ['  Community 1,  Tema  ', 'community 1 tema'],
    ['MADINA-ZONGO Junction.', 'madina zongo junction'],
    ['Plot 12/B,\tAdenta', 'plot 12 b adenta'],
    ['', ''],
  ])('turns %j into %j', (input, expected) => {
    expect(normaliseAddressText(input)).toBe(expected);
  });
});

describe('resolving a location', () => {
  const aliases = [
    alias(1, 'community 1', TEMA),
    alias(2, 'tema station', TEMA),
    alias(3, 'madina', MADINA),
    alias(4, 'adenta', MADINA),
    alias(5, 'amasaman', AMASAMAN),
    alias(6, 'old town', RETIRED),
  ];

  // Break caught: a landmark or area named in the address not meeting its alias, which would send every booking to Ops.
  it('resolves an address that contains one alias, wherever it sits in the text', () => {
    expect(resolveZone(config(aliases), { address: 'House 4, Community 1, Tema' })).toMatchObject({
      kind: 'RESOLVED',
      resolution: 'SERVER_RESOLVED',
      zone: { code: 'TEMA' },
      alias: 'community 1',
    });
    expect(resolveZone(config(aliases), { address: 'Near the Tema Station' })).toMatchObject({
      kind: 'RESOLVED',
      zone: { code: 'TEMA' },
    });
  });

  // Break caught: the landmark field ignored, when it is exactly where a vendor puts the part of the address that is recognisable.
  it('reads the landmark as part of the location', () => {
    expect(
      resolveZone(config(aliases), { address: 'Behind the big tree', landmark: 'Adenta barrier' }),
    ).toMatchObject({ kind: 'RESOLVED', zone: { code: 'MADINA_ADENTA' } });
  });

  // Break caught: a substring of a word counting as a match ("madina" inside "madinaville"), which is how a fuzzy rule enters.
  it('matches whole words only', () => {
    expect(resolveZone(config(aliases), { address: 'Madinaville estate' })).toEqual({
      kind: 'NONE',
    });
    expect(resolveZone(config(aliases), { address: 'Communityone' })).toEqual({ kind: 'NONE' });
  });

  // Break caught: an unknown address resolved to something anyway. The answer is none, and Ops selects (or the booking waits).
  it('is none when no alias is in the address', () => {
    expect(resolveZone(config(aliases), { address: 'Somewhere unknown' })).toEqual({
      kind: 'NONE',
    });
    expect(resolveZone(config([]), { address: 'Community 1, Tema' })).toEqual({ kind: 'NONE' });
    expect(resolveZone(config(aliases), { address: '   ' })).toEqual({ kind: 'NONE' });
  });

  // Break caught: two zones both matching and the first one winning, which prices a parcel by the order of a table.
  it('is ambiguous, naming both zones, when aliases of two zones are in the address', () => {
    const bare = [alias(1, 'madina', MADINA), alias(2, 'tema', TEMA)];
    const result = resolveZone(config(bare), { address: 'Madina to Tema road' });
    expect(result.kind).toBe('AMBIGUOUS');
    expect(
      result.kind === 'AMBIGUOUS' ? result.zones.map((each) => each.code).toSorted() : [],
    ).toEqual(['MADINA_ADENTA', 'TEMA']);
  });

  // Break caught: a short alias overriding a longer, more specific one inside the same address.
  it('prefers the longest alias, and is ambiguous only when the longest tie across zones', () => {
    const specific = [alias(1, 'tema', TEMA), alias(2, 'tema madina', MADINA)];
    expect(resolveZone(config(specific), { address: 'Tema Madina junction' })).toMatchObject({
      kind: 'RESOLVED',
      zone: { code: 'MADINA_ADENTA' },
    });
    const tie = [alias(1, 'junction', TEMA), alias(2, 'junction', MADINA)];
    // The table forbids two zones sharing an alias in one hub; the resolver is still correct if it ever sees one.
    expect(resolveZone(config(tie), { address: 'The junction' }).kind).toBe('AMBIGUOUS');
  });

  // Break caught: an inactive zone still resolving, which would price and accept a booking in an area the hub no longer serves.
  it('does not resolve to a zone that is not active', () => {
    expect(resolveZone(config(aliases), { address: 'Old Town road' })).toEqual({ kind: 'NONE' });
  });

  // Break caught: coordinates or a map link deciding a zone. There is no geocoding: the operation runs on landmarks and phone calls.
  it('ignores coordinates and a map link', () => {
    expect(
      resolveZone(config(aliases), {
        address: 'Somewhere unknown',
        latitude: 5.6698,
        longitude: -0.0166,
        map_link: 'https://maps.example/tema',
      }),
    ).toEqual({ kind: 'NONE' });
  });
});

describe('an authorized selection', () => {
  // Break caught: a selection accepted for a zone of another hub or one that is retired, and one recorded as server-resolved.
  it('accepts an active zone of the hub and records it as explicitly authorized', () => {
    expect(authorizeZone(config([]), MADINA.id)).toEqual({
      kind: 'RESOLVED',
      resolution: 'EXPLICITLY_AUTHORIZED',
      zone: MADINA,
    });
    expect(authorizeZone(config([]), RETIRED.id)).toEqual({ kind: 'NONE' });
    expect(authorizeZone(config([]), '5eed0101-0000-4000-8000-0000000000ff')).toEqual({
      kind: 'NONE',
    });
  });
});
