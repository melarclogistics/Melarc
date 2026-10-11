import { describe, expect, it } from 'vitest';

import {
  SETTING_TYPES,
  SettingInvalidError,
  SettingMissingError,
  interpretSetting,
  type SettingRow,
} from './settings-reader.js';

const row = (overrides: Partial<SettingRow> = {}): SettingRow => ({
  key: 'signin_max_attempts',
  scope: 'PLATFORM',
  value_type: 'integer',
  value: 5,
  unit: 'attempts',
  ...overrides,
});

const invalid = (run: () => unknown): SettingInvalidError => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SettingInvalidError);
    return error as SettingInvalidError;
  }
  throw new Error('expected the setting to be refused as invalid');
};

describe('reading a setting row', () => {
  // Break caught: a setting that does not exist being answered with something, which the contract forbids ("never borrows").
  it('says a missing row is SETTING_MISSING, naming the key and nothing else', () => {
    try {
      interpretSetting('signin_max_attempts', undefined);
      expect.unreachable('a missing setting must not read as a value');
    } catch (error) {
      expect(error).toBeInstanceOf(SettingMissingError);
      expect((error as SettingMissingError).code).toBe('SETTING_MISSING');
      expect((error as SettingMissingError).message).toContain('signin_max_attempts');
    }
  });

  // Break caught: a value read as the wrong type, or a type lost on the way to the caller.
  it('returns the value in the type it is declared, with its scope and unit', () => {
    const cases: [SettingRow, unknown][] = [
      [row({ value_type: 'integer', value: 5 }), 5],
      [row({ value_type: 'integer', value: 0 }), 0],
      [row({ value_type: 'integer', value: -3 }), -3],
      [row({ value_type: 'decimal', value: 1.5 }), 1.5],
      [row({ value_type: 'boolean', value: false }), false],
      [row({ value_type: 'string', value: 'Accra' }), 'Accra'],
      [row({ value_type: 'string', value: '' }), ''],
      [row({ value_type: 'list', value: ['A', 'B'] }), ['A', 'B']],
      [row({ value_type: 'list', value: [] }), []],
      [
        row({ value_type: 'object', value: { standard: 30, privileged: 15 } }),
        { standard: 30, privileged: 15 },
      ],
    ];
    for (const [stored, expected] of cases) {
      const read = interpretSetting(stored.key, stored);
      expect(read.value).toEqual(expected);
      expect(read.type).toBe(stored.value_type);
      expect(read.scope).toBe('PLATFORM');
      expect(read.unit).toBe('attempts');
    }
  });

  // Break caught: a stored JSON value that does not fit its declared type being passed on (no constraint ties them, OB-86).
  it('refuses a stored value that is not of its declared type, as SETTING_INVALID', () => {
    const bad: SettingRow[] = [
      row({ value_type: 'integer', value: '5' }),
      row({ value_type: 'integer', value: 5.5 }),
      row({ value_type: 'integer', value: 2 ** 60 }),
      row({ value_type: 'integer', value: null }),
      row({ value_type: 'decimal', value: '1.5' }),
      row({ value_type: 'boolean', value: 'true' }),
      row({ value_type: 'boolean', value: 1 }),
      row({ value_type: 'string', value: 5 }),
      row({ value_type: 'list', value: { 0: 'A' } }),
      row({ value_type: 'object', value: ['A'] }),
      row({ value_type: 'object', value: null }),
      row({ value_type: 'unknown' as never, value: 5 }),
    ];
    for (const stored of bad) {
      expect(invalid(() => interpretSetting(stored.key, stored)).code).toBe('SETTING_INVALID');
    }
  });

  // Break caught: the error repeating the stored value, which may be configuration that should not reach a log.
  it('names the key and never the stored value in the refusal', () => {
    const error = invalid(() =>
      interpretSetting(
        'signin_max_attempts',
        row({ value_type: 'integer', value: 'secret-looking' }),
      ),
    );

    expect(error.message).toContain('signin_max_attempts');
    expect(error.message).not.toContain('secret-looking');
  });

  // Break caught: asking for an integer of a setting declared as another type quietly returning it.
  it('refuses a request for a type other than the one the setting is declared as', () => {
    const stored = row({ value_type: 'string', value: '5' });

    expect(invalid(() => interpretSetting(stored.key, stored, 'integer')).code).toBe(
      'SETTING_INVALID',
    );
    expect(interpretSetting(stored.key, stored, 'string').value).toBe('5');
  });

  // Break caught: the closed set of types drifting from the table's.
  it('knows the six types of the table and no other', () => {
    expect([...SETTING_TYPES]).toEqual([
      'integer',
      'decimal',
      'boolean',
      'string',
      'list',
      'object',
    ]);
  });
});
