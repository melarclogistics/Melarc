import { describe, expect, it } from 'vitest';

import { deployedEnv, validEnv } from '../../test-support/config-env.js';
import { loadConfig, type ConfigProblem } from './load-config.js';

/**
 * The in-process stand-in of the content scanner never stands beside a real bucket outside a local run (Run B, Part 1, item 5 of the review of Run A2). Staging keeps the stand-in store and the
 * stand-in scanner together until the owner's bucket exists (D-A8); the moment the store is the real one (R2) the scanner must be one that looks at the bytes, because a stand-in that calls
 * everything but the EICAR test file clean, beside a real bucket, stores a real file that nobody scanned. A scanner that is not configured at all is **not** refused: the application starts
 * and stores no evidence until one is (D-A6; `production-refusals.test.ts` holds that for production). Each test names the break it catches; the first two fail on 7cb3bb1.
 */
const R2 = {
  EVIDENCE_STORE: 'r2',
  EVIDENCE_R2_ACCOUNT_ID: 'testaccount',
  EVIDENCE_R2_BUCKET: 'test-evidence',
  EVIDENCE_R2_ACCESS_KEY_ID: 'TESTONLYACCESSKEY',
  EVIDENCE_R2_SECRET_ACCESS_KEY: 'TEST-ONLY-NOT-A-CREDENTIAL-0000000000',
} as const;
const CLAMAV = {
  EVIDENCE_SCANNER: 'clamav',
  EVIDENCE_CLAMAV_HOST: 'clamav.internal.example',
  EVIDENCE_CLAMAV_PORT: '3310',
  EVIDENCE_CLAMAV_TIMEOUT_MS: '8000',
} as const;

const keysOf = (env: Record<string, string>): string[] => {
  const result = loadConfig(env);
  return result.ok ? [] : result.problems.map((problem: ConfigProblem) => problem.key);
};

describe('the stand-in scanner beside a real bucket', () => {
  // Break caught: a staging with the real store whose scanner is left to default to the stand-in (the default of every environment but production), which would store unscanned files.
  it('is refused in staging when the scanner is left unnamed, because it then defaults to the stand-in', () => {
    expect(keysOf(deployedEnv('staging', { ...R2 }))).toEqual(['EVIDENCE_SCANNER']);
  });

  // Break caught: the stand-in named outright in staging beside the real store.
  it('is refused in staging when it is named', () => {
    expect(keysOf(deployedEnv('staging', { ...R2, EVIDENCE_SCANNER: 'in-process' }))).toEqual([
      'EVIDENCE_SCANNER',
    ]);
  });

  // Break caught: the refusal listed twice in production, where the stand-in is refused for production already (one problem for one setting).
  it('is refused once in production, which refuses the stand-in for itself', () => {
    const production = keysOf(deployedEnv('production', { ...R2, EVIDENCE_SCANNER: 'in-process' }));
    expect(production.filter((key) => key === 'EVIDENCE_SCANNER')).toEqual(['EVIDENCE_SCANNER']);
  });

  // Break caught: the real scanner refused for being real, or the rule applied to a staging that has not got its bucket yet.
  it.each([
    ['ClamAV beside the real store in staging', { ...R2, ...CLAMAV }],
    [
      'the stand-in store and the stand-in scanner together in staging, until the owner’s bucket exists',
      {},
    ],
    [
      'the stand-in scanner beside the stand-in store, named, in staging',
      { EVIDENCE_SCANNER: 'in-process' },
    ],
  ])('does not refuse %s', (_what, change) => {
    expect(keysOf(deployedEnv('staging', change))).toEqual([]);
  });

  // Break caught: a local run refused for its stand-ins (the owner's dry run of the smoke command composes the real store with the stand-in scanner from the local settings).
  it('does not refuse a local run with the real store and the stand-in scanner', () => {
    expect(keysOf(validEnv({ ...R2 }))).toEqual([]);
    expect(keysOf(validEnv({ ...R2, EVIDENCE_SCANNER: 'in-process' }))).toEqual([]);
  });
});
