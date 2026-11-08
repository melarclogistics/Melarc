import { SettingInvalidError, SettingMissingError } from './settings-reader.js';

/**
 * A hub's configuration as one immutable snapshot at one instant (S1.4, `SLICE-001`; settings.md §2 and §7.2; domain-model.md §3.7 and
 * §6.20): the hub's service zones and aliases, its versioned settings **in force at that instant**, and the company-wide rules.
 *
 * It is a **value, not a connection**. A rule (the zone a location is in, a fee, a calendar day) is evaluated by pure functions that
 * are handed this snapshot and read nothing themselves (`src/pricing/`), so the same snapshot gives the same answer, a test needs no
 * database, and the setting key, hub and version that a charge records are the ones the answer was computed from.
 *
 * - **No default, no borrowing.** A key with no row in force for this hub is `SETTING_MISSING`, never another hub's value and never a
 *   value that "worked before" (§33.4). Whether that fails the operation or is recorded as an absence is the caller's: a pricing or
 *   configuration path fails visibly, an operational path (a cancellation charge, a booking cutoff) records the condition and goes on.
 * - **A value is validated in the shape its key defines**, or the read fails as `SETTING_INVALID`, which fails safely. The database
 *   holds JSON and nothing ties it to a key's shape (as for `setting`, OB-86), so the snapshot does.
 * - **Money is integer pesewas** (the `_minor` convention), never a float or a decimal string.
 */

/** The seven weekdays a base fee names the days it applies on (the operating calendar is Monday to Saturday, §21.1). */
export const WEEKDAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const SIZE_CLASSES = ['SMALL', 'MEDIUM', 'LARGE'] as const;
export type SizeClass = (typeof SIZE_CLASSES)[number];

/** A version of a setting as it is stored: the row, with the hub, key, scope and version that identify it. */
export interface HubSettingRecord {
  readonly hubId: string;
  readonly key: string;
  /** Empty for a hub-wide value; a service-area code for a per-service-area one. */
  readonly scopeRef: string;
  readonly version: number;
  readonly value: unknown;
  readonly unit: string;
  readonly effectiveFrom: Date;
}

/**
 * Where a value came from: the four facts a charge snapshots (domain-model.md §3.7, `MSC-DEC-218`). Version counters are per hub and
 * collide across hubs, so the key and the version alone do not identify a value; the hub is part of the reference.
 */
export interface SettingReference {
  readonly hubId: string;
  readonly settingKey: string;
  readonly scopeRef: string;
  readonly effectiveVersion: number;
}

export interface ServiceZoneRecord {
  readonly id: string;
  readonly hubId: string;
  readonly code: string;
  readonly name: string;
  readonly serviceArea: string;
  readonly active: boolean;
}

export interface ZoneAliasRecord {
  readonly id: string;
  readonly hubId: string;
  readonly zoneId: string;
  /** Normalised (the table refuses any other form). */
  readonly alias: string;
  readonly kind: 'LANDMARK' | 'AREA';
}

/** A company-wide business rule (`setting`, scope `COMPANY`). It has no version and no date in this slice. */
export interface CompanyRuleRecord {
  readonly key: string;
  readonly valueType: string;
  readonly value: unknown;
  readonly unit: string;
}

/** `SETTING_MISSING` for a hub-scoped value: no version of it is in force for this hub at this instant. */
export class HubSettingMissingError extends SettingMissingError {
  constructor(
    key: string,
    readonly hubId: string,
    readonly scopeRef: string,
  ) {
    super(key);
    this.message = `The setting ${key}${scopeRef === '' ? '' : ` (${scopeRef})`} has no approved value for this hub`;
    this.name = 'HubSettingMissingError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isMinor = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const TIME_OF_DAY = /^([01]\d|2[0-3]):([0-5]\d)$/;

export interface Valued<T> {
  readonly value: T;
  readonly reference: SettingReference;
}

export class HubConfiguration {
  readonly hubId: string;
  /**
   * The hub's name, for the hub code of an operational code (MSC-DEC-202): a vendor session may read no hub, so the snapshot carries it.
   * Undefined where a snapshot is built for a rule that has no use for it (a test of pricing).
   */
  readonly hubName: string | undefined;
  readonly at: Date;
  readonly zones: readonly ServiceZoneRecord[];
  readonly aliases: readonly ZoneAliasRecord[];
  readonly #settings: ReadonlyMap<string, HubSettingRecord>;
  readonly #company: ReadonlyMap<string, CompanyRuleRecord>;

  constructor(input: {
    readonly hubId: string;
    readonly hubName?: string;
    readonly at: Date;
    readonly zones: readonly ServiceZoneRecord[];
    readonly aliases: readonly ZoneAliasRecord[];
    /** The version in force at `at` for each key and scope: the reader's `distinct on`, not a history. */
    readonly settings: readonly HubSettingRecord[];
    readonly company: readonly CompanyRuleRecord[];
  }) {
    this.hubId = input.hubId;
    this.hubName = input.hubName;
    this.at = input.at;
    this.zones = input.zones;
    this.aliases = input.aliases;
    const settings = new Map<string, HubSettingRecord>();
    for (const record of input.settings) {
      if (record.hubId !== input.hubId) {
        // The reader asks for one hub; a row of another is a defect in the reader, and is never carried.
        throw new RangeError('A hub’s configuration holds that hub’s settings and no other’s');
      }
      const id = `${record.key}\u0000${record.scopeRef}`;
      if (settings.has(id)) throw new RangeError('One setting is in force once per key and scope');
      settings.set(id, record);
    }
    this.#settings = settings;
    this.#company = new Map(input.company.map((rule) => [rule.key, rule]));
  }

  /** The version in force of a key and scope, or `undefined`: for the caller that records an absence instead of failing. */
  find(key: string, scopeRef = ''): HubSettingRecord | undefined {
    return this.#settings.get(`${key}\u0000${scopeRef}`);
  }

  /** The version in force, or `SETTING_MISSING` naming the key (and the scope), never another hub’s value. */
  setting(key: string, scopeRef = ''): HubSettingRecord {
    const found = this.find(key, scopeRef);
    if (found === undefined) throw new HubSettingMissingError(key, this.hubId, scopeRef);
    return found;
  }

  reference(record: HubSettingRecord): SettingReference {
    return {
      hubId: record.hubId,
      settingKey: record.key,
      scopeRef: record.scopeRef,
      effectiveVersion: record.version,
    };
  }

  /** A whole number of a stated minimum, in the setting’s own unit (minutes, hours, attempts, parcels, pesewas). */
  integer(key: string, scopeRef = '', minimum = 0): Valued<number> {
    const record = this.setting(key, scopeRef);
    if (!Number.isSafeInteger(record.value) || (record.value as number) < minimum) {
      throw new SettingInvalidError(key, 'it is not a whole number of the size its key allows');
    }
    return { value: record.value as number, reference: this.reference(record) };
  }

  /** An amount of money in pesewas. */
  money(key: string, scopeRef = ''): Valued<number> {
    const record = this.setting(key, scopeRef);
    if (!isMinor(record.value)) {
      throw new SettingInvalidError(key, 'it is not a whole number of pesewas');
    }
    return { value: record.value, reference: this.reference(record) };
  }

  boolean(key: string, scopeRef = ''): Valued<boolean> {
    const record = this.setting(key, scopeRef);
    if (typeof record.value !== 'boolean') {
      throw new SettingInvalidError(key, 'it is not a boolean');
    }
    return { value: record.value, reference: this.reference(record) };
  }

  /** A time of day, `HH:MM`, on the hub’s clock (Africa/Accra). Kept as the text the document gives and as minutes since midnight. */
  timeOfDay(
    key: string,
    scopeRef = '',
  ): Valued<{ readonly text: string; readonly minutesSinceMidnight: number }> {
    const record = this.setting(key, scopeRef);
    const match = typeof record.value === 'string' ? TIME_OF_DAY.exec(record.value) : null;
    if (match === null) throw new SettingInvalidError(key, 'it is not a time of day, HH:MM');
    return {
      value: {
        text: record.value as string,
        minutesSinceMidnight: Number(match[1]) * 60 + Number(match[2]),
      },
      reference: this.reference(record),
    };
  }

  /** The flat fee of a service area and the weekdays it applies on (a corridor’s batch day is the day its base fee is for). */
  baseFee(
    serviceArea: string,
  ): Valued<{ readonly amountMinor: number; readonly days: readonly Weekday[] }> {
    const key = 'service_area_base_fee';
    const record = this.setting(key, serviceArea);
    const value = record.value;
    if (
      !isRecord(value) ||
      !isMinor(value.amount_minor) ||
      !Array.isArray(value.days) ||
      value.days.length === 0 ||
      !value.days.every((day): day is Weekday => (WEEKDAYS as readonly unknown[]).includes(day)) ||
      new Set(value.days).size !== value.days.length
    ) {
      throw new SettingInvalidError(key, 'it is not an amount and a set of weekdays');
    }
    return {
      value: { amountMinor: value.amount_minor, days: value.days },
      reference: this.reference(record),
    };
  }

  /** What a corridor delivery costs off its batch day. One value per corridor. */
  corridorOffDayFee(serviceArea: string): Valued<number> {
    const key = 'corridor_off_day_fee';
    const record = this.setting(key, serviceArea);
    if (!isRecord(record.value) || !isMinor(record.value.amount_minor)) {
      throw new SettingInvalidError(key, 'it is not an amount');
    }
    return { value: record.value.amount_minor, reference: this.reference(record) };
  }

  /** The surcharge of each size class; applies only to a parcel delivered outside the service area (`MSC-DEC-209`). */
  sizeClassSurcharges(): Valued<Readonly<Record<SizeClass, number>>> {
    const key = 'size_class_surcharges';
    const record = this.setting(key);
    const value = record.value;
    if (
      !isRecord(value) ||
      Object.keys(value).length !== SIZE_CLASSES.length ||
      !SIZE_CLASSES.every((size) => isMinor(value[size]))
    ) {
      throw new SettingInvalidError(key, 'it is not an amount for each of the three size classes');
    }
    return {
      value: {
        SMALL: value.SMALL as number,
        MEDIUM: value.MEDIUM as number,
        LARGE: value.LARGE as number,
      },
      reference: this.reference(record),
    };
  }

  /** A company-wide business rule in pesewas (`liability_cap_amount`, `value_declaration_threshold`), or `SETTING_MISSING`. */
  companyMoney(key: string): number {
    const rule = this.#company.get(key);
    if (rule === undefined) throw new SettingMissingError(key);
    if (rule.valueType !== 'integer' || !isMinor(rule.value)) {
      throw new SettingInvalidError(key, 'it is not a whole number of pesewas');
    }
    return rule.value;
  }
}
