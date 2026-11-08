import { describe, expect, it } from 'vitest';

import {
  DatabaseNotificationSettings,
  SETTINGS_CACHE_MS,
  SMS_SETTING_KEYS,
  type SettingsReader,
} from './notification-settings.js';

/**
 * The notification lane's three platform settings (S1.12e): read as they are, kept for a short time, and failing safe when they are missing
 * or not what they should be. The reader here is a stand-in; the policy that lets the lane's capability read exactly these rows is proved
 * against PostgreSQL (`notification-settings.db.test.ts`).
 */
const GOOD = new Map<string, unknown>([
  [SMS_SETTING_KEYS.enabled, true],
  [SMS_SETTING_KEYS.perNumberPerDay, 10],
  [SMS_SETTING_KEYS.perDay, 500],
]);

function settingsOver(values: Map<string, unknown>) {
  let now = 1_000_000;
  const asked: (readonly string[])[] = [];
  const unusable: string[] = [];
  const reader: SettingsReader = {
    read: (keys) => {
      asked.push(keys);
      return Promise.resolve(values);
    },
  };
  const settings = new DatabaseNotificationSettings({
    reader,
    clock: { now: () => new Date(now) },
    onUnusable: (key) => unusable.push(key),
  });
  return {
    settings,
    asked,
    unusable,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('the settings the lane reads', () => {
  it('asks for the three keys and no other', async () => {
    const { settings, asked } = settingsOver(GOOD);
    await settings.smsEnabled();
    expect(asked).toHaveLength(1);
    expect([...(asked[0] ?? [])].toSorted()).toEqual([
      'sms_daily_limit',
      'sms_enabled',
      'sms_per_number_daily_limit',
    ]);
  });

  // Break caught: the pilot figures read from the wrong key or swapped.
  it('reads the switch and the two limits of the pilot', async () => {
    const { settings } = settingsOver(GOOD);
    expect(await settings.smsEnabled()).toBe(true);
    expect(await settings.limits()).toEqual({ perNumberPerDay: 10, perDay: 500 });
    expect(await settings.disabledKinds()).toEqual(new Set());
  });

  // Break caught: a switch that is Off read as On, which sends the texts the owner stopped.
  it('reads an Off switch as off', async () => {
    const { settings } = settingsOver(new Map(GOOD).set(SMS_SETTING_KEYS.enabled, false));
    expect(await settings.smsEnabled()).toBe(false);
  });

  // Break caught (settings.md section 8): a switch that is missing or not a boolean read as On, which spends money on a guess.
  it.each([undefined, 'true', 1, null, {}])(
    'holds every text back when the switch is %j, and says which key',
    async (value) => {
      const values = new Map(GOOD);
      if (value === undefined) values.delete(SMS_SETTING_KEYS.enabled);
      else values.set(SMS_SETTING_KEYS.enabled, value);
      const { settings, unusable } = settingsOver(values);
      expect(await settings.smsEnabled()).toBe(false);
      expect(unusable).toEqual([SMS_SETTING_KEYS.enabled]);
    },
  );

  // Break caught: a limit that is missing or unusable read as no limit, which is how a runaway sends.
  it.each([undefined, -1, 1.5, '10', null, Number.NaN])(
    'reads a limit of %j as zero and names the key',
    async (value) => {
      const values = new Map(GOOD);
      if (value === undefined) values.delete(SMS_SETTING_KEYS.perNumberPerDay);
      else values.set(SMS_SETTING_KEYS.perNumberPerDay, value);
      const { settings, unusable } = settingsOver(values);
      expect(await settings.limits()).toEqual({ perNumberPerDay: 0, perDay: 500 });
      expect(unusable).toEqual([SMS_SETTING_KEYS.perNumberPerDay]);
    },
  );

  it('accepts zero as a limit: it holds every text back, on purpose', async () => {
    const { settings, unusable } = settingsOver(new Map(GOOD).set(SMS_SETTING_KEYS.perDay, 0));
    expect(await settings.limits()).toEqual({ perNumberPerDay: 10, perDay: 0 });
    expect(unusable).toEqual([]);
  });

  // Break caught: a database asked for every message, or a change that never reaches a running lane.
  it('keeps the values for a short time and then asks again', async () => {
    const { settings, asked, advance } = settingsOver(GOOD);
    await settings.smsEnabled();
    await settings.limits();
    advance(SETTINGS_CACHE_MS - 1);
    await settings.smsEnabled();
    expect(asked).toHaveLength(1);
    advance(1);
    await settings.smsEnabled();
    expect(asked).toHaveLength(2);
  });

  // Break caught (review m6): a clock that steps back keeping a switch for as long as the step, so that a kill switch the owner has just
  // turned Off stays On.
  it('asks again when the clock has stepped back since the last read', async () => {
    const { settings, asked, advance } = settingsOver(GOOD);
    await settings.smsEnabled();
    advance(-5_000);
    await settings.smsEnabled();
    expect(asked).toHaveLength(2);
    // ...and keeps its value again from the new reading.
    advance(1_000);
    await settings.smsEnabled();
    expect(asked).toHaveLength(2);
  });
});
