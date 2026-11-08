import type {
  HubConfiguration,
  ServiceZoneRecord,
} from '../platform/settings/hub-configuration.js';

/**
 * The address-to-zone rule (S1.5, `SLICE-001`; the Product Owner’s decision of 29 October 2026, D-02; settings.md §7.2;
 * domain-model.md §6.20; §23.3: *a free-text address is never authoritative*).
 *
 * **The rule, in full.** An address is resolved to a zone by **exact whole-word match** of a hub-owned alias against the address and
 * its landmark, after both are normalised the same way (lower case, punctuation as a space, single-spaced). There is no geocoding
 * and no fuzzy matching: coordinates and a map link are optional on a location and never decide a zone, because the operation runs
 * on landmarks and phone calls. The longest alias in the text wins; where the longest aliases belong to more than one zone the
 * answer is **ambiguous**, and where none is present it is **none**. Neither is resolved by guessing: an ambiguous or unknown
 * address needs an **authorized selection** by Ops (`authorizeZone`), which is recorded as `EXPLICITLY_AUTHORIZED`.
 *
 * Pure: it is handed the hub’s configuration snapshot and reads nothing. A zone that is not active is out of coverage, so an alias
 * that points at one resolves to nothing. The alias data is the Product Owner’s to supply (OB-S1-02); this is the rule, not the data.
 */

/** The parts of a contract `Location` that the rule reads. Coordinates and the map link are accepted and ignored. */
export interface LocationText {
  readonly address: string;
  readonly landmark?: string;
  readonly map_link?: string;
  readonly latitude?: number;
  readonly longitude?: number;
}

export type ZoneResolution =
  | {
      readonly kind: 'RESOLVED';
      readonly resolution: 'SERVER_RESOLVED' | 'EXPLICITLY_AUTHORIZED';
      readonly zone: ServiceZoneRecord;
      /** The alias that matched, for `SERVER_RESOLVED`. */
      readonly alias?: string;
    }
  | { readonly kind: 'AMBIGUOUS'; readonly zones: readonly ServiceZoneRecord[] }
  | { readonly kind: 'NONE' };

/**
 * The one normal form of address text and of an alias: lower case (full Unicode), every run of anything that is not a letter or a
 * digit one space, ends trimmed. `Plot 12/B, Adenta` and `plot 12 b adenta` are the same text.
 */
export function normaliseAddressText(text: string): string {
  return text
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const wordsOf = (normalised: string): string[] => (normalised === '' ? [] : normalised.split(' '));

/** Whether `needle` is a contiguous run of whole words of `haystack`. */
function containsRun(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let start = 0; start + needle.length <= haystack.length; start++) {
    let all = true;
    for (let offset = 0; offset < needle.length; offset++) {
      if (haystack[start + offset] !== needle[offset]) {
        all = false;
        break;
      }
    }
    if (all) return true;
  }
  return false;
}

export function resolveZone(config: HubConfiguration, location: LocationText): ZoneResolution {
  // The address and the landmark are searched as one text, with a break between them that no alias can span.
  const parts = [location.address, location.landmark ?? '']
    .map((part) => wordsOf(normaliseAddressText(part)))
    .filter((words) => words.length > 0);
  if (parts.length === 0) return { kind: 'NONE' };

  const active = new Map(
    config.zones.filter((zone) => zone.active).map((zone) => [zone.id, zone] as const),
  );
  let longest = 0;
  const matches: { zone: ServiceZoneRecord; alias: string; length: number }[] = [];
  for (const row of config.aliases) {
    const zone = active.get(row.zoneId);
    if (zone === undefined) continue;
    const words = wordsOf(normaliseAddressText(row.alias));
    if (!parts.some((part) => containsRun(part, words))) continue;
    matches.push({ zone, alias: row.alias, length: words.length });
    longest = Math.max(longest, words.length);
  }
  if (matches.length === 0) return { kind: 'NONE' };

  const best = matches.filter((match) => match.length === longest);
  const zones = [...new Map(best.map((match) => [match.zone.id, match.zone] as const)).values()];
  if (zones.length > 1) return { kind: 'AMBIGUOUS', zones };
  const only = best[0];
  if (only === undefined) return { kind: 'NONE' };
  return { kind: 'RESOLVED', resolution: 'SERVER_RESOLVED', zone: only.zone, alias: only.alias };
}

/**
 * An authorized selection (§23.3: *ambiguous resolution requires a clear authorized selection*): Ops names a zone of the hub, and
 * the order records `EXPLICITLY_AUTHORIZED`. A zone of another hub, one that does not exist and one that is not active are `NONE`.
 */
export function authorizeZone(config: HubConfiguration, zoneId: string): ZoneResolution {
  const zone = config.zones.find((each) => each.id === zoneId && each.active);
  if (zone === undefined) return { kind: 'NONE' };
  return { kind: 'RESOLVED', resolution: 'EXPLICITLY_AUTHORIZED', zone };
}
