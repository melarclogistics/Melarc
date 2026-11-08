import { describe, expect, it } from 'vitest';

import {
  ARGON2ID_DEPLOYED_FLOOR,
  ARGON2ID_LIMITS,
  DEVELOPMENT_QUALIFIED_ARGON2ID,
  type Argon2idParameters,
} from '../auth/crypto/argon2-parameters.js';
import { deployedEnv, validEnv } from '../../test-support/config-env.js';
import { adapterRefusals } from './adapter-refusals.js';
import { EXPECTED, HASHING_DEFAULTS } from './config-settings.js';
import { MAX_ACCEPTED_PROFILES, parseAcceptedProfiles } from './credential-hashing.js';
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
const problemsFor = (env: Record<string, string>): { key: string; problem: string }[] => {
  const result = loadConfig(env);
  return result.ok ? [] : result.problems.map(({ key, problem }) => ({ key, problem }));
};
const profile = (memoryKiB: number, passes: number, parallelism = 1): Argon2idParameters => ({
  memoryKiB,
  passes,
  parallelism,
});

describe('the credential-hashing profile (SECURITY_DESIGN.md §13.4, §13.4c; plan S0.3: "parameters from configuration")', () => {
  describe('the defaults', () => {
    // Break caught: a default that drifted from the profile the code qualified and measured (argon2-parameters.ts).
    it('are the development-qualified profile', () => {
      expect(Number(HASHING_DEFAULTS.ARGON2_MEMORY_KIB)).toBe(
        DEVELOPMENT_QUALIFIED_ARGON2ID.memoryKiB,
      );
      expect(Number(HASHING_DEFAULTS.ARGON2_PASSES)).toBe(DEVELOPMENT_QUALIFIED_ARGON2ID.passes);
      expect(Number(HASHING_DEFAULTS.ARGON2_PARALLELISM)).toBe(
        DEVELOPMENT_QUALIFIED_ARGON2ID.parallelism,
      );
    });

    it('apply when nothing is set, with no older profile accepted', () => {
      const config = configFor(validEnv());

      expect(config.credentialHashing).toEqual({
        profile: DEVELOPMENT_QUALIFIED_ARGON2ID,
        acceptedProfiles: [],
      });
    });

    it('are the same in the inert configuration', () => {
      expect(inertConfig().credentialHashing).toEqual({
        profile: DEVELOPMENT_QUALIFIED_ARGON2ID,
        acceptedProfiles: [],
      });
    });

    it('are accepted by every environment, so a deployment that sets nothing is not refused for them', () => {
      expect(adapterRefusals(configFor(deployedEnv('staging')))).toEqual([]);
      expect(
        adapterRefusals(configFor(deployedEnv('staging'))).map((problem) => problem.key),
      ).not.toContain('ARGON2_MEMORY_KIB');
    });
  });

  describe('a profile that is set', () => {
    it('is read as the profile new hashes are written at', () => {
      const config = configFor(
        validEnv({ ARGON2_MEMORY_KIB: '47104', ARGON2_PASSES: '3', ARGON2_PARALLELISM: '2' }),
      );

      expect(config.credentialHashing.profile).toEqual(profile(47104, 3, 2));
    });

    it('is read with the older profiles that stored hashes may still be verified at', () => {
      const config = configFor(validEnv({ ARGON2_ACCEPTED_PROFILES: '19456:2:1,32768:3:1' }));

      expect(config.credentialHashing.acceptedProfiles).toEqual([
        profile(19456, 2),
        profile(32768, 3),
      ]);
    });

    it('treats a blank list as none, as a copied template leaves it', () => {
      expect(
        configFor(validEnv({ ARGON2_ACCEPTED_PROFILES: '' })).credentialHashing.acceptedProfiles,
      ).toEqual([]);
    });

    it('cannot be modified, at any depth', () => {
      const { credentialHashing } = configFor(validEnv({ ARGON2_ACCEPTED_PROFILES: '19456:2:1' }));

      expect(Object.isFrozen(credentialHashing)).toBe(true);
      expect(Object.isFrozen(credentialHashing.profile)).toBe(true);
      expect(Object.isFrozen(credentialHashing.acceptedProfiles)).toBe(true);
      expect(Object.isFrozen(credentialHashing.acceptedProfiles[0])).toBe(true);
    });
  });

  describe('is refused at start', () => {
    // Break caught: a profile the algorithm or the limits would refuse at the first sign-in, found only then.
    it.each([
      ['memory below 8 KiB per lane', { ARGON2_MEMORY_KIB: '4' }, 'ARGON2_MEMORY_KIB'],
      [
        'memory that is not a multiple of 4 KiB per lane',
        { ARGON2_MEMORY_KIB: '65537' },
        'ARGON2_MEMORY_KIB',
      ],
      [
        'memory that is not a multiple of 4 KiB per lane at 4 lanes',
        { ARGON2_MEMORY_KIB: '1000', ARGON2_PARALLELISM: '4' },
        'ARGON2_MEMORY_KIB',
      ],
      [
        'memory above the limit',
        { ARGON2_MEMORY_KIB: String(ARGON2ID_LIMITS.maxMemoryKiB + 4) },
        'ARGON2_MEMORY_KIB',
      ],
      ['zero passes', { ARGON2_PASSES: '0' }, 'ARGON2_PASSES'],
      [
        'passes above the limit',
        { ARGON2_PASSES: String(ARGON2ID_LIMITS.maxPasses + 1) },
        'ARGON2_PASSES',
      ],
      ['zero lanes', { ARGON2_PARALLELISM: '0' }, 'ARGON2_PARALLELISM'],
      [
        'lanes above the limit',
        { ARGON2_PARALLELISM: String(ARGON2ID_LIMITS.maxParallelism + 1) },
        'ARGON2_PARALLELISM',
      ],
      ['text for a number', { ARGON2_PASSES: 'two' }, 'ARGON2_PASSES'],
      ['a fraction', { ARGON2_MEMORY_KIB: '65536.5' }, 'ARGON2_MEMORY_KIB'],
      ['a signed number', { ARGON2_PASSES: '+2' }, 'ARGON2_PASSES'],
    ])('%s', (_label, change, key) => {
      const problems = problemsFor(validEnv(change));

      expect(problems.map((problem) => problem.key)).toContain(key);
      expect(loadConfig(validEnv(change)).ok).toBe(false);
    });

    it('with a message that says what is expected and never what was given', () => {
      const result = loadConfig(validEnv({ ARGON2_MEMORY_KIB: '65537' }));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      const problem = result.problems.find((p) => p.key === 'ARGON2_MEMORY_KIB');
      expect(problem?.expected).toBe(EXPECTED.ARGON2_MEMORY_KIB);
      expect(JSON.stringify(result.problems)).not.toContain('65537');
    });

    it.each([
      ['an entry with a space', '19456:2:1, 32768:3:1'],
      ['a trailing comma', '19456:2:1,'],
      ['a missing field', '19456:2'],
      ['an extra field', '19456:2:1:1'],
      ['a leading zero', '019456:2:1'],
      ['text', 'strong'],
      ['a profile the limits refuse', '65537:2:1'],
      ['a repeated profile', '19456:2:1,19456:2:1'],
      ['the write profile itself', `${String(DEVELOPMENT_QUALIFIED_ARGON2ID.memoryKiB)}:2:1`],
      [
        'more than eight profiles',
        Array.from({ length: 9 }, (_, i) => `${String(8192 + 4 * i)}:2:1`).join(','),
      ],
    ])('an accepted-profile list with %s', (_label, list) => {
      expect(problemsFor(validEnv({ ARGON2_ACCEPTED_PROFILES: list })).map((p) => p.key)).toContain(
        'ARGON2_ACCEPTED_PROFILES',
      );
    });

    it('judges the accepted list against the write profile that was set, not the default', () => {
      // 65536:2:1 is the default write profile, but this environment writes at 19456:2:1, so listing it is fine.
      expect(
        problemsFor(
          validEnv({ ARGON2_MEMORY_KIB: '19456', ARGON2_ACCEPTED_PROFILES: '65536:2:1' }),
        ),
      ).toEqual([]);
    });
  });

  describe('what a deployed environment refuses: a write profile below the initial floor', () => {
    // The floor is the OWASP minimum named in the correction review of S0.3 (19 MiB, 2 passes, one lane), taken as the agreed
    // minimum of the initial policy. It is a floor on what is written and not a claim about capacity; a Product decision may
    // change it, and S0.65 proposes the release values.
    it('is 19456 KiB and 2 passes', () => {
      expect(ARGON2ID_DEPLOYED_FLOOR).toEqual({ memoryKiB: 19456, passes: 2 });
    });

    it.each(['staging', 'production'] as const)(
      'is refused in %s, naming the setting',
      (appEnv) => {
        for (const [change, key] of [
          [{ ARGON2_MEMORY_KIB: '19452' }, 'ARGON2_MEMORY_KIB'],
          [{ ARGON2_PASSES: '1' }, 'ARGON2_PASSES'],
          [{ ARGON2_MEMORY_KIB: '64', ARGON2_PASSES: '1' }, 'ARGON2_MEMORY_KIB'],
        ] as const) {
          const result = loadConfig(deployedEnv(appEnv, change));

          expect(result.ok, `${appEnv} ${JSON.stringify(change)}`).toBe(false);
          if (!result.ok) expect(result.problems.map((p) => p.key)).toContain(key);
        }
      },
    );

    it('holds for a configuration made by hand, as for one made from the environment', () => {
      const weak = { profile: profile(64, 1), acceptedProfiles: [] };
      const config = { ...configFor(validEnv()), credentialHashing: weak };

      expect(adapterRefusals({ ...config, appEnv: 'local' }).map((p) => p.key)).not.toContain(
        'ARGON2_MEMORY_KIB',
      );
      expect(adapterRefusals({ ...config, appEnv: 'staging' }).map((p) => p.key)).toEqual(
        expect.arrayContaining(['ARGON2_MEMORY_KIB', 'ARGON2_PASSES']),
      );
    });

    it('accepts exactly the floor, and anything above it, in staging', () => {
      expect(
        loadConfig(deployedEnv('staging', { ARGON2_MEMORY_KIB: '19456', ARGON2_PASSES: '2' })).ok,
      ).toBe(true);
      expect(
        loadConfig(deployedEnv('staging', { ARGON2_MEMORY_KIB: '131072', ARGON2_PASSES: '3' })).ok,
      ).toBe(true);
    });

    it('lets a local run use a cheap profile, which is for explicit test compositions', () => {
      expect(
        configFor(validEnv({ ARGON2_MEMORY_KIB: '64', ARGON2_PASSES: '1' })).credentialHashing
          .profile,
      ).toEqual(profile(64, 1));
    });

    it('does not apply the floor to the older profiles that may still be verified', () => {
      expect(loadConfig(deployedEnv('staging', { ARGON2_ACCEPTED_PROFILES: '64:1:1' })).ok).toBe(
        true,
      );
    });
  });
});

describe('parseAcceptedProfiles', () => {
  it('reads memory:passes:lanes entries in order', () => {
    expect(parseAcceptedProfiles('19456:2:1')).toEqual([profile(19456, 2)]);
    expect(parseAcceptedProfiles('19456:2:1,65536:3:2')).toEqual([
      profile(19456, 2),
      profile(65536, 3, 2),
    ]);
  });

  it('allows up to eight', () => {
    const eight = Array.from(
      { length: MAX_ACCEPTED_PROFILES },
      (_, i) => `${String(8192 + 4 * i)}:2:1`,
    );

    expect(parseAcceptedProfiles(eight.join(','))).toHaveLength(MAX_ACCEPTED_PROFILES);
  });

  it.each(['', ' ', ',', '1:1:1', '19456:2:1;32768:3:1', '19456:2:01', '-19456:2:1'])(
    'returns nothing for %j',
    (text) => {
      expect(parseAcceptedProfiles(text)).toBeUndefined();
    },
  );
});
