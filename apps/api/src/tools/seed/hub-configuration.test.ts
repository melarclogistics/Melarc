import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseSettings } from '../../test-support/seed-documents.js';
import { SERVICE_AREAS } from '../../platform/database/schema/hub-configuration.js';
import { HUBS } from './hubs.js';
import {
  HUB_SETTINGS,
  LAUNCH_HUB_ID,
  SERVICE_ZONES,
  hubConfigurationPlan,
  type HubSettingSeed,
} from './hub-configuration.js';

/**
 * The launch hub's configuration against the documents that own it (S1.4; Family Z: the authority is read, not copied). Nothing
 * here compares a count with a number typed into the test: what a document states is read from the document.
 */
const ROOT = resolve(import.meta.dirname, '../../../../..');
const read = (path: string): string =>
  readFileSync(resolve(ROOT, path), 'utf8').replaceAll('\r', '');
const SETTINGS_DOC = read('contracts/settings.md');
const ROWS = parseSettings(SETTINGS_DOC);
const HUB_ROWS = ROWS.filter((row) => row.section === '7.2' || row.section === '7.3');
const HUB_SECTION_KEYS = new Set(HUB_ROWS.map((row) => row.key));

/**
 * The `CONFIRMED` hub keys that this seed does not carry, and why. Each is a reason to read, not a way to skip a check: an entry
 * here is the only way a confirmed key of sections 7.2 and 7.3 may be absent from the seed.
 */
const NOT_SEEDED: Readonly<Record<string, string>> = {
  MELARC_HIGH_VALUE_TIERS:
    'confirmed, but its bands have no stated boundary and its place in the price is the owner’s decision D-06',
  doorstep_wait_minutes: 'the delivery side (SLICE-002/003) seeds it when it reads it',
  delivery_service_window_start: 'the delivery side seeds it when it reads it',
  delivery_service_window_end: 'the delivery side seeds it when it reads it',
  cash_reconciliation_cutoff_time: 'the cash side (SLICE-004) seeds it when it reads it',
  recipient_cash_enabled: 'the cash side seeds it when it reads it',
  merchant_momo_fallback_enabled: 'the cash side seeds it when it reads it',
  handshake_code_length:
    'a platform setting (the Product Owner, 30 October 2026), not a hub setting: seeded in settings.ts by S1.27',
  handshake_code_ttl_minutes: 'a platform setting, seeded in settings.ts by S1.27',
  handshake_max_wrong_attempts: 'a platform setting, seeded in settings.ts by S1.27',
  handover_otp_length: 'the delivery side seeds it when it reads it',
  handover_otp_ttl_minutes: 'the delivery side seeds it when it reads it',
  handover_otp_max_wrong_attempts: 'the delivery side seeds it when it reads it',
  sms_fallback_max_per_pickup: 'a platform setting, seeded in settings.ts by S1.27',
  sms_fallback_cooldown_seconds: 'a platform setting, seeded in settings.ts by S1.27',
  adhoc_failure_sms_enabled: 'seeded by the notification task that reads it (S1.12)',
  heads_up_sms_enabled: 'seeded by the notification task that reads it (S1.12)',
};

const seedKeys = new Set(HUB_SETTINGS.map((seed) => seed.key));
const find = (key: string, scopeRef = ''): HubSettingSeed | undefined =>
  HUB_SETTINGS.find((seed) => seed.key === key && seed.scopeRef === scopeRef);
const valueCell = (key: string): string => HUB_ROWS.find((row) => row.key === key)?.value ?? '';
/** The whole row of a key as the document writes it, for the statements that sit in its Notes cell. */
const rowText = (key: string): string =>
  SETTINGS_DOC.split('\n').find((line) => line.startsWith('| `' + key + '`|')) ?? '';

/** The pesewas a cell states as `GH₵35` (or `GH₵2,000`), in the order they appear. */
const cedisIn = (cell: string): number[] =>
  [...cell.matchAll(/GH₵([\d,]+(?:\.\d+)?)/g)].map((match) =>
    Math.round(Number((match[1] ?? '0').replaceAll(',', '')) * 100),
  );

describe('the launch hub’s zones (settings.md section 7.2)', () => {
  const catalogue = /Hub service-zone catalogue\|[^|]*\| 7 zones\| ([^|]+)\|/.exec(
    SETTINGS_DOC.replaceAll('`', ''),
  )?.[1];

  // Break caught: a zone dropped, added or renamed against the catalogue the document confirms.
  it('are the seven the document names, by name', () => {
    expect(catalogue, 'the catalogue row').toBeDefined();
    const named = (catalogue ?? '')
      .split(/\s*\(/)[0]
      ?.split(/,\s*/)
      .map((name) => name.trim());
    expect(SERVICE_ZONES.map((zone) => zone.name)).toEqual(named);
    expect(SERVICE_ZONES).toHaveLength(7);
  });

  // Break caught: two zones sharing a code or an id, or a code that is not stable machine text.
  it('have distinct ids and codes in the grammar of the table', () => {
    expect(new Set(SERVICE_ZONES.map((zone) => zone.id)).size).toBe(SERVICE_ZONES.length);
    expect(new Set(SERVICE_ZONES.map((zone) => zone.code)).size).toBe(SERVICE_ZONES.length);
    for (const zone of SERVICE_ZONES) expect(zone.code).toMatch(/^[A-Z][A-Z0-9_]*$/);
  });

  // Break caught: the corridors grouped with Accra & Tema, which would price a corridor delivery at the flat fee every day.
  it('puts exactly the two corridors in their own service areas, and the other five in Accra & Tema', () => {
    const byArea = (area: string) => SERVICE_ZONES.filter((zone) => zone.serviceArea === area);
    expect(byArea('AMASAMAN_ENVIRONS').map((zone) => zone.code)).toEqual(['AMASAMAN_ENVIRONS']);
    expect(byArea('KASOA_CORRIDOR').map((zone) => zone.code)).toEqual(['KASOA_CORRIDOR']);
    expect(byArea('ACCRA_TEMA')).toHaveLength(5);
  });
});

describe('the launch hub’s settings (settings.md sections 7.2 and 7.3)', () => {
  // Break caught: a seeded key the document does not confirm (an invented value) or one the document marks OPEN.
  it('seeds only keys that the document confirms', () => {
    for (const key of seedKeys) {
      expect(HUB_SECTION_KEYS.has(key), `${key} is a key of section 7.2 or 7.3`).toBe(true);
      const status = HUB_ROWS.find((row) => row.key === key)?.status ?? '';
      expect(status, key).toBe('CONFIRMED');
    }
  });

  // Break caught: a confirmed hub-scoped fee missing from the seed, which would leave a hub unable to price (SETTING_MISSING) for
  // a value the owner has already given. Every confirmed key of 7.2 is seeded or named, with its reason, in NOT_SEEDED.
  it('seeds every confirmed key of section 7.2, or names the reason it does not', () => {
    const confirmed72 = HUB_ROWS.filter(
      (row) => row.section === '7.2' && row.status === 'CONFIRMED',
    );
    expect(confirmed72.length).toBeGreaterThan(5);
    for (const row of confirmed72) {
      const reason = NOT_SEEDED[row.key];
      if (reason === undefined) {
        expect(seedKeys.has(row.key), `${row.key} is seeded`).toBe(true);
      } else {
        expect(seedKeys.has(row.key), `${row.key} is not seeded: ${reason}`).toBe(false);
      }
    }
  });

  // Break caught: a not-seeded entry that has since been seeded (a stale excuse), or one that is not a key of the document.
  it('keeps the list of unseeded keys honest', () => {
    for (const key of Object.keys(NOT_SEEDED)) {
      expect(
        ROWS.some((row) => row.key === key),
        `${key} is a key of settings.md`,
      ).toBe(true);
      expect(seedKeys.has(key), `${key} is excused and also seeded`).toBe(false);
    }
  });

  // Break caught: a fee typed differently from the document, the failure the whole table exists to prevent. Each single-valued money
  // key is compared with the one GH₵ amount its Value cell states.
  it.each([
    'station_drop_fee',
    'redelivery_fee_minor',
    'flat_return_fee_amount',
    'single_package_pickup_fee',
    'cancellation_charge_amount',
    'outside_accra_margin',
  ])('seeds %s at the amount the document states', (key) => {
    const seeded = find(key);
    expect(seeded, key).toBeDefined();
    expect(cedisIn(valueCell(key))).toEqual([seeded?.value]);
  });

  // Break caught: the size surcharges or the base fees mistyped, or the batch day of a corridor seeded as a day it is not.
  it('seeds the size-class surcharges, the base fees and the batch days as the document states them', () => {
    expect(cedisIn(valueCell('size_class_surcharges'))).toEqual([0, 2000, 3000]);
    expect(find('size_class_surcharges')?.value).toEqual({ SMALL: 0, MEDIUM: 2000, LARGE: 3000 });

    expect(cedisIn(valueCell('service_area_base_fee'))).toEqual([3500]);
    expect(rowText('service_area_base_fee')).toContain(
      'Accra & Tema GH₵35 Mon–Sat; Amasaman & Environs GH₵35 **Friday only**; Kasoa Corridor GH₵35 **Friday only**',
    );
    expect(find('service_area_base_fee', 'ACCRA_TEMA')?.value).toEqual({
      amount_minor: 3500,
      days: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'],
    });
    for (const corridor of ['AMASAMAN_ENVIRONS', 'KASOA_CORRIDOR']) {
      expect(find('service_area_base_fee', corridor)?.value).toEqual({
        amount_minor: 3500,
        days: ['FRI'],
      });
    }
  });

  // Break caught: the two corridors' off-day fees collapsed back to one value. The owner set them apart on 29 October 2026.
  it('seeds the off-day fee of each corridor on its own, as the document states', () => {
    const cell = valueCell('corridor_off_day_fee');
    expect(cedisIn(cell)).toEqual([7000, 8000]);
    expect(cell).toMatch(/GH₵70 Amasaman & Environs/);
    expect(cell).toMatch(/GH₵80 Kasoa Corridor/);
    expect(find('corridor_off_day_fee', 'AMASAMAN_ENVIRONS')?.value).toEqual({
      amount_minor: 7000,
    });
    expect(find('corridor_off_day_fee', 'KASOA_CORRIDOR')?.value).toEqual({ amount_minor: 8000 });
    expect(find('corridor_off_day_fee')).toBeUndefined();
  });

  // Break caught: an operational value typed differently from the document.
  it.each([
    ['vendor_credit_grace_window_minutes', 60],
    ['booking_cutoff_time', '10:00'],
    ['MELARC_MAX_PICKUP_ATTEMPTS', 3],
    ['stale_failure_backstop_hours', 24],
    ['intake_parcel_cap', 100],
    ['pickup_service_window_start', '11:00'],
    ['pickup_service_window_end', '16:00'],
    ['rider_door_wait_minutes', 10],
  ])('seeds %s at the value the document states', (key, expected) => {
    expect(find(key)?.value).toBe(expected);
    expect(valueCell(key)).toContain(String(expected));
  });

  it('seeds auto_reschedule as off, as the document states', () => {
    expect(valueCell('auto_reschedule')).toBe('Off');
    expect(find('auto_reschedule')?.value).toBe(false);
  });

  // Break caught: a per-service-area value seeded with a service area that is not one, or a hub-wide value with a scope.
  it('names a service area for a per-area key and none for a hub-wide one', () => {
    const perArea = new Set(['service_area_base_fee', 'corridor_off_day_fee']);
    for (const seed of HUB_SETTINGS) {
      if (perArea.has(seed.key)) {
        expect(SERVICE_AREAS as readonly string[], seed.key).toContain(seed.scopeRef);
      } else {
        expect(seed.scopeRef, seed.key).toBe('');
      }
    }
    const keys = HUB_SETTINGS.map((seed) => `${seed.key}/${seed.scopeRef}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('the plan that carries it', () => {
  // Break caught: the plan naming a hub that is not the launch hub, or carrying an alias nobody supplied.
  it('is for the launch hub, carries no alias, and names every row’s hub', () => {
    const plan = hubConfigurationPlan();
    expect(plan.entryPoint).toBe('seed_hub_configuration');
    expect(Object.keys(plan.payload).toSorted()).toEqual(['hub_setting', 'service_zone']);
    expect(LAUNCH_HUB_ID).toBe(HUBS[0]?.id);
    for (const rows of Object.values(plan.payload)) {
      for (const row of rows) expect(row.hub_id).toBe(LAUNCH_HUB_ID);
    }
  });

  // Break caught: a plan that picks its own version, time or author, which the function alone decides.
  it('leaves the version-1 stamp to the data and the time and the author to the function', () => {
    const plan = hubConfigurationPlan();
    for (const row of plan.payload.hub_setting ?? []) {
      expect(row.version).toBe(1);
      expect(Object.keys(row)).not.toContain('effective_from');
      expect(Object.keys(row)).not.toContain('created_by');
    }
  });
});
