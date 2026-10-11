import { describe, expect, it } from 'vitest';

import { deployedEnv, validEnv } from '../../test-support/config-env.js';
import { EXPECTED, HASH_ADMISSION_DEFAULTS } from './config-settings.js';
import { inertConfig } from './inert-config.js';
import { loadConfig, type AppConfig } from './load-config.js';

const configFor = (env: Record<string, string>): AppConfig => {
  const result = loadConfig(env);
  if (!result.ok) {
    throw new Error(
      `expected a configuration, got problems with ${result.problems.map((p) => p.key).join(', ')}`,
    );
  }
  return result.config;
};
const problemKeys = (env: Record<string, string>): string[] => {
  const result = loadConfig(env);
  return result.ok ? [] : result.problems.map(({ key }) => key);
};

describe('hash admission (SECURITY_DESIGN.md §13.4c): how many hashes at once, and what memory they may take', () => {
  // Break caught: a default that cannot start the application, or a configuration that does not carry what the admission needs.
  it('has defaults that satisfy their own relation, and carries them in the configuration', () => {
    const { hashAdmission } = configFor(validEnv());

    expect(hashAdmission).toEqual({
      slots: Number(HASH_ADMISSION_DEFAULTS.HASH_ADMISSION_SLOTS),
      memoryBudgetMiB: Number(HASH_ADMISSION_DEFAULTS.HASH_ADMISSION_MEMORY_BUDGET_MIB),
    });
    expect(Object.isFrozen(hashAdmission)).toBe(true);
    expect(inertConfig().hashAdmission).toEqual(hashAdmission);
  });

  // Break caught: a count or a budget outside what a process can hold being accepted.
  it('refuses a slot count or a budget that is not a whole number in range', () => {
    for (const [key, value] of [
      ['HASH_ADMISSION_SLOTS', '0'],
      ['HASH_ADMISSION_SLOTS', '65'],
      ['HASH_ADMISSION_SLOTS', '1.5'],
      ['HASH_ADMISSION_SLOTS', 'two'],
      ['HASH_ADMISSION_SLOTS', ''],
      ['HASH_ADMISSION_MEMORY_BUDGET_MIB', '63'],
      ['HASH_ADMISSION_MEMORY_BUDGET_MIB', '65537'],
      ['HASH_ADMISSION_MEMORY_BUDGET_MIB', '256MiB'],
    ] as const) {
      expect(problemKeys(validEnv({ [key]: value })), `${key}=${value}`).toContain(key);
    }
    // The ends of both ranges, each with a partner that keeps the relation between them true.
    for (const env of [
      { HASH_ADMISSION_SLOTS: '1' },
      { HASH_ADMISSION_SLOTS: '64', HASH_ADMISSION_MEMORY_BUDGET_MIB: '65536' },
      { HASH_ADMISSION_SLOTS: '1', HASH_ADMISSION_MEMORY_BUDGET_MIB: '64' },
      { HASH_ADMISSION_MEMORY_BUDGET_MIB: '65536' },
    ]) {
      expect(problemKeys(validEnv(env)), JSON.stringify(env)).toEqual([]);
    }
  });

  // Break caught: memory budgeted for the write profile alone, so that verifying an older, larger hash can exceed the budget.
  it('budgets the memory of the largest profile that may be derived, not the write profile alone', () => {
    // 64 MiB write profile, 2 slots, a 256 MiB budget: 128 MiB, fine.
    expect(problemKeys(validEnv())).toEqual([]);
    // Exactly at the budget is fine: 4 slots of 64 MiB are 256 MiB.
    expect(problemKeys(validEnv({ HASH_ADMISSION_SLOTS: '4' }))).toEqual([]);
    // One more slot is over it.
    expect(problemKeys(validEnv({ HASH_ADMISSION_SLOTS: '5' }))).toEqual(['HASH_ADMISSION_SLOTS']);

    // An older hash made at 128 MiB may still be verified: three slots of it are 384 MiB, though three of the write profile are 192.
    const older = { ARGON2_ACCEPTED_PROFILES: '131072:2:1' };
    expect(problemKeys(validEnv({ ...older, HASH_ADMISSION_SLOTS: '2' }))).toEqual([]);
    expect(problemKeys(validEnv({ ...older, HASH_ADMISSION_SLOTS: '3' }))).toEqual([
      'HASH_ADMISSION_SLOTS',
    ]);
    expect(problemKeys(validEnv({ HASH_ADMISSION_SLOTS: '3' }))).toEqual([]);

    // The write profile may be the smaller one: the larger accepted profile decides.
    const smallWrite = {
      ARGON2_MEMORY_KIB: '19456',
      ARGON2_ACCEPTED_PROFILES: '262144:2:1',
      HASH_ADMISSION_SLOTS: '2',
    };
    expect(problemKeys(validEnv(smallWrite))).toEqual(['HASH_ADMISSION_SLOTS']);
    expect(
      problemKeys(validEnv({ ...smallWrite, HASH_ADMISSION_MEMORY_BUDGET_MIB: '512' })),
    ).toEqual([]);
  });

  // Break caught: the relation holding in a local run and not where it matters.
  it('holds in a deployed environment as in a local run', () => {
    // A deployed profile is at least 19 MiB; nine slots of the default 64 MiB are 576 MiB, over the 256 MiB budget.
    for (const appEnv of ['staging', 'production'] as const) {
      expect(problemKeys(deployedEnv(appEnv, { HASH_ADMISSION_SLOTS: '9' }))).toContain(
        'HASH_ADMISSION_SLOTS',
      );
    }
  });

  // Break caught: a refusal that names the value or the memory arithmetic of a profile.
  it('says which key is wrong and nothing else', () => {
    const result = loadConfig(validEnv({ HASH_ADMISSION_SLOTS: '9' }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(JSON.stringify(result.problems)).not.toContain('65536');
    expect(result.problems.find((p) => p.key === 'HASH_ADMISSION_SLOTS')?.expected).toBe(
      EXPECTED.HASH_ADMISSION_SLOTS,
    );
  });
});
