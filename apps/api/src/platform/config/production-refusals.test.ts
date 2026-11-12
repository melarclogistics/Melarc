import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { deployedEnv, randomKey } from '../../test-support/config-env.js';
import { KEY_PURPOSES, keyEnvName } from './key-material.js';
import { loadConfig, type ConfigProblem } from './load-config.js';

/**
 * `AC-SLICE-000-55`, completed by S0.57 (plan section 7.47): *no test substitute, for attestation or for message delivery, can run in
 * production*. Each earlier task added the refusal of its own (S0.54 the substitute verifier, S0.18 the capture delivery adapter, S0.56 the
 * verifier service's endpoint and caller authentication, S0.2 the key material, S0.22 the limiter); this file holds **every refusal the
 * criterion lists, together, against one baseline**: a production environment that selects only real adapters, which is refused for the key
 * custody it has not got (`KEY_CUSTODY`, plan obligation OB-36) and for nothing else. Each row of the table changes one thing and names what
 * production then refuses.
 *
 * The criterion's other half is the verifier **service's own** start: no accepted roots, no Rider package name, no signing-certificate digest,
 * a trust-data maximum age that is unset or not greater than six hours, no caller secret, and a debug signer. That process is not the API's and
 * is started by the JVM tests, which `verifier:test` runs in the gate; this file names the tests that prove each entry and fails if one is
 * renamed or removed, so the criterion cannot lose a clause unseen. The behaviour on the wire (a verifier that is unreachable, overloaded or
 * late is `503 TRUST_DATA_UNAVAILABLE`, nothing written, the grant not consumed) is `rider-device-enrolment-routes.db.test.ts` and
 * `rider-device-enrolment-verifier.db.test.ts`.
 */
const REAL_ADAPTERS = {
  DELIVERY_EMAIL_ADAPTER: 'provider',
  DELIVERY_EMAIL_ENDPOINT: 'https://email.provider.example/v1',
  DELIVERY_EMAIL_TIMEOUT_MS: '5000',
  DELIVERY_SMS_ADAPTER: 'provider',
  DELIVERY_SMS_ENDPOINT: 'https://sms.provider.example/v1',
  DELIVERY_SMS_TIMEOUT_MS: '5000',
  ATTESTATION_VERIFIER: 'service',
  ATTESTATION_VERIFIER_URL: 'https://verifier.internal.example',
  ATTESTATION_VERIFIER_TIMEOUT_MS: '3000',
  ATTESTATION_VERIFIER_CALLER_SECRET: randomKey(),
  // The evidence store (S1.11): a real one, so that production's other refusals are judged alone. The values are made up for the test.
  EVIDENCE_STORE: 'r2',
  EVIDENCE_R2_ACCOUNT_ID: 'testaccount',
  EVIDENCE_R2_BUCKET: 'test-evidence',
  EVIDENCE_R2_ACCESS_KEY_ID: 'TESTONLYACCESSKEY',
  EVIDENCE_R2_SECRET_ACCESS_KEY: 'TEST-ONLY-NOT-A-CREDENTIAL-0000000000',
};

function problemsFor(env: Record<string, string | undefined>): readonly ConfigProblem[] {
  const result = loadConfig(env);
  if (result.ok) throw new Error('expected the environment to be rejected');
  return result.problems;
}
const keysOf = (problems: readonly ConfigProblem[]): string[] =>
  problems.map((problem) => problem.key).toSorted();

const production = (change: Readonly<Record<string, string | undefined>> = {}) =>
  deployedEnv('production', { ...REAL_ADAPTERS, ...change });

describe('AC-SLICE-000-55: the API refuses to start in production with what is only for tests', () => {
  // The baseline every row is judged against: real adapters, and the one thing production cannot have yet.
  it('refuses, with every adapter real, the key custody alone', () => {
    expect(problemsFor(production())).toEqual([
      expect.objectContaining({ key: 'KEY_CUSTODY', problem: 'invalid' }),
    ]);
  });

  // Break caught: any one clause of the criterion dropped, or answered by a different setting than the one it names.
  it.each([
    [
      'the substitute attestation verifier is selected',
      {
        ATTESTATION_VERIFIER: 'substitute',
        ATTESTATION_VERIFIER_URL: undefined,
        ATTESTATION_VERIFIER_TIMEOUT_MS: undefined,
        ATTESTATION_VERIFIER_CALLER_SECRET: undefined,
      },
      ['ATTESTATION_VERIFIER'],
    ],
    [
      'the in-process stand-in of the evidence store is selected',
      {
        EVIDENCE_STORE: 'in-process',
        EVIDENCE_R2_ACCOUNT_ID: undefined,
        EVIDENCE_R2_BUCKET: undefined,
        EVIDENCE_R2_ACCESS_KEY_ID: undefined,
        EVIDENCE_R2_SECRET_ACCESS_KEY: undefined,
      },
      ['EVIDENCE_STORE'],
    ],
    [
      'the R2 evidence store is selected without its bucket',
      { EVIDENCE_R2_BUCKET: undefined },
      ['EVIDENCE_R2_BUCKET'],
    ],
    [
      'the R2 evidence store is selected without its secret',
      { EVIDENCE_R2_SECRET_ACCESS_KEY: undefined },
      ['EVIDENCE_R2_SECRET_ACCESS_KEY'],
    ],
    [
      'the verifier service’s endpoint is missing',
      { ATTESTATION_VERIFIER_URL: undefined },
      ['ATTESTATION_VERIFIER_URL'],
    ],
    [
      'the verifier service’s caller authentication is missing',
      { ATTESTATION_VERIFIER_CALLER_SECRET: undefined },
      ['ATTESTATION_VERIFIER_CALLER_SECRET'],
    ],
    [
      'the verifier service’s time-out is missing',
      { ATTESTATION_VERIFIER_TIMEOUT_MS: undefined },
      ['ATTESTATION_VERIFIER_TIMEOUT_MS'],
    ],
    [
      'the credential-message delivery port’s capture adapter is selected for e-mail',
      {
        DELIVERY_EMAIL_ADAPTER: 'capture',
        DELIVERY_EMAIL_ENDPOINT: undefined,
        DELIVERY_EMAIL_TIMEOUT_MS: undefined,
      },
      ['DELIVERY_EMAIL_ADAPTER'],
    ],
    [
      'the credential-message delivery port’s capture adapter is selected for SMS',
      {
        DELIVERY_SMS_ADAPTER: 'capture',
        DELIVERY_SMS_ENDPOINT: undefined,
        DELIVERY_SMS_TIMEOUT_MS: undefined,
      },
      ['DELIVERY_SMS_ADAPTER'],
    ],
    [
      'no production delivery adapter is configured for e-mail (a provider with nowhere to send)',
      { DELIVERY_EMAIL_ENDPOINT: undefined },
      ['DELIVERY_EMAIL_ENDPOINT'],
    ],
    [
      'no production delivery adapter is configured for SMS (a provider with nowhere to send)',
      { DELIVERY_SMS_ENDPOINT: undefined },
      ['DELIVERY_SMS_ENDPOINT'],
    ],
    ['the in-memory rate limiter is selected', { RATE_LIMITER: 'memory' }, ['RATE_LIMITER']],
  ] as const)('refuses it when %s', (_clause, change, keys) => {
    const refused = keysOf(problemsFor(production(change)));

    for (const key of keys) expect(refused).toContain(key);
    // And it refuses what the baseline refuses, and nothing more than what the row changed.
    expect(refused.filter((key) => key !== 'KEY_CUSTODY')).toEqual(keys.toSorted());
  });

  // Break caught: a purpose-separated key allowed to be absent, which would start the API with a purpose that cannot seal or hash.
  it.each(KEY_PURPOSES)('refuses it when the purpose-separated key %s is absent', (purpose) => {
    const material = keyEnvName(purpose, 'MATERIAL');

    expect(problemsFor(production({ [material]: undefined }))).toContainEqual(
      expect.objectContaining({ key: material, problem: 'missing' }),
    );
  });

  // Break caught: a test key adapter (the local key custody, or the describe custody) accepted by production.
  it.each(['local', 'describe'])('refuses the %s key custody, a test key adapter', (custody) => {
    expect(problemsFor(production({ KEY_CUSTODY: custody }))).toContainEqual(
      expect.objectContaining({ key: 'KEY_CUSTODY' }),
    );
  });

  // Break caught: a message that names the value it refused (a secret, an endpoint).
  it('names settings and never a value', () => {
    const secret = randomKey();
    const text = JSON.stringify(
      problemsFor(
        production({
          ATTESTATION_VERIFIER: 'substitute',
          ATTESTATION_VERIFIER_URL: 'https://verifier.internal.example',
          ATTESTATION_VERIFIER_CALLER_SECRET: secret,
        }),
      ),
    );

    expect(text).not.toContain(secret);
    expect(text).not.toContain('verifier.internal.example');
  });
});

describe('AC-SLICE-000-55: the verifier service’s own production refusals have their proofs, named', () => {
  const kotlin = (file: string) =>
    readFileSync(
      resolve(
        import.meta.dirname,
        '../../../../attestation-verifier/service/src/test/kotlin/com/melarc/attestation',
        file,
      ),
      'utf8',
    );

  // Break caught: a clause of the criterion that no test answers any more because the JVM test that did was renamed, rewritten or removed.
  it.each([
    [
      'no accepted roots, no package name, no signing digest, no caller secret and no explicit maximum age',
      'MainProcessTest.kt',
      'production refuses to start without its release inputs, its caller secret and an explicit maximum age',
    ],
    [
      'a maximum age that does not outlive the refresh (not greater than six hours), and a debug signer',
      'MainProcessTest.kt',
      'production refuses a maximum age that does not outlive the refresh, and a debug signer',
    ],
    [
      'the caller secret, beyond loopback and in production',
      'VerifierConfigTest.kt',
      'a verifier reachable beyond loopback, or in production, requires its caller',
    ],
    [
      'what production requires and nothing it forbids',
      'VerifierConfigTest.kt',
      'production holds what production requires',
    ],
  ])('names the test of %s', (_clause, file, name) => {
    expect(kotlin(file)).toContain(name);
  });
});

describe('AC-SLICE-000-55: no production enrolment path accepts a substitute’s outcome or skips verification', () => {
  const source = (path: string) => readFileSync(resolve(import.meta.dirname, '..', path), 'utf8');

  // Break caught: the enrolment taking a shortcut for an environment (a branch on the environment that waves evidence through), or reaching
  // for the substitute itself. The composition root is the only place a verifier is chosen, and production refuses the substitute there.
  it.each([
    'auth/rider/rider-enrolment.service.ts',
    'auth/rider/rider-enrolment.controller.ts',
    'auth/rider/rider-enrolment-providers.ts',
  ])('keeps %s free of the substitute and of any branch on the environment', (path) => {
    const text = source(path);

    expect(text).not.toMatch(/substitute/i);
    expect(text).not.toMatch(/APP_ENV|appEnv|NODE_ENV|nodeEnv|process\.env/);
  });

  // Break caught: a verdict acted on without the verifier being asked (a path from the grant to the registration that never calls it).
  it('registers a device only after the verifier has answered VERIFIED', () => {
    const text = source('auth/rider/rider-enrolment.service.ts');

    expect(text.indexOf('verifier.verify(')).toBeGreaterThan(0);
    expect(text.indexOf('devices.register(')).toBeGreaterThan(text.indexOf('verifier.verify('));
    expect(text.indexOf("case 'VERIFIED':")).toBeGreaterThan(text.indexOf('verifier.verify('));
    expect(text.indexOf('devices.register(')).toBeGreaterThan(text.indexOf("case 'VERIFIED':"));
  });
});
