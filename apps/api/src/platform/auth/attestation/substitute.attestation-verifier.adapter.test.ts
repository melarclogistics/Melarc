import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { locateContract } from '../../contract/locate-contract.js';
import { parseDevicePublicKey } from '../device-key/device-key-protocol.js';
import {
  ATTESTATION_INTEGRITY_CAUSES,
  ATTESTATION_UNAVAILABLE_CAUSES,
  type AttestationEvidence,
} from '../ports/attestation-verifier.port.js';
import { AttestationInterfaceError } from './attestation-errors.js';
import {
  SubstituteAttestationVerifier,
  substituteChain,
  substituteVerdict,
} from './substitute.attestation-verifier.adapter.js';

const VECTORS = JSON.parse(
  readFileSync(
    join(
      dirname(dirname(locateContract(import.meta.dirname))),
      'apps',
      'api',
      'test',
      'vectors',
      'device-key.v1.json',
    ),
    'utf8',
  ),
) as { public_keys: { public_key: string }[] };
const KEY_A = VECTORS.public_keys[0]?.public_key ?? '';
const KEY_B = VECTORS.public_keys[1]?.public_key ?? '';

const evidence = (directive: string, devicePublicKey = KEY_A): AttestationEvidence => ({
  expectedChallengeSha256: new Uint8Array(32).fill(5),
  certificateChain: substituteChain(directive),
  devicePublicKey,
});
const verifier = new SubstituteAttestationVerifier();

/** AC-SLICE-000-75: each outcome class, from controlled test input, deterministically, with no device and no production trust setting. */
describe('the substitute attestation verifier (AC-SLICE-000-75)', () => {
  // Break caught: a substitute that waves evidence through, or one that cannot yield the accepted outcome.
  it('accepts, attesting the key that was submitted, with a summary that is plainly not a handset’s', async () => {
    const verdict = await verifier.verify(evidence('VERIFIED'));
    expect(verdict).toMatchObject({ verdict: 'VERIFIED', attestedPublicKey: KEY_A });
    if (verdict.verdict !== 'VERIFIED') throw new Error('expected VERIFIED');
    expect(verdict.summary).toEqual({
      securityLevel: 'TRUSTED_ENVIRONMENT',
      attestationVersion: 0,
      keyMintVersion: 0,
      packageName: 'substitute.attestation',
      signerDigests: ['0'.repeat(64)],
    });
    expect((await verifier.verify(evidence('VERIFIED', KEY_B))).verdict).toBe('VERIFIED');
  });

  it('yields the unsupported outcome', async () => {
    expect(await verifier.verify(evidence('UNSUPPORTED'))).toEqual({
      verdict: 'DEVICE_SECURITY_UNSUPPORTED',
    });
  });

  // Break caught: a cause the policy has no step for, or a step with no way to be reached from a test.
  it.each(ATTESTATION_INTEGRITY_CAUSES.map((cause) => [cause] as const))(
    'yields the integrity failure of the cause %s',
    async (cause) => {
      expect(await verifier.verify(evidence(`INTEGRITY:${cause}`))).toEqual({
        verdict: 'DEVICE_INTEGRITY_FAILED',
        cause,
      });
    },
  );

  it.each(ATTESTATION_UNAVAILABLE_CAUSES.map((cause) => [cause] as const))(
    'yields trust data unavailable with the cause %s',
    async (cause) => {
      expect(await verifier.verify(evidence(`UNAVAILABLE:${cause}`))).toEqual({
        verdict: 'TRUST_DATA_UNAVAILABLE',
        cause,
      });
    },
  );

  // Break caught: a verdict that depends on anything but the evidence (a clock, a counter, the order of calls).
  it('gives the same verdict for the same evidence, every time', async () => {
    for (const directive of [
      'VERIFIED',
      'UNSUPPORTED',
      'INTEGRITY:KEY_MISMATCH',
      'UNAVAILABLE:VERIFIER_TIMEOUT',
    ]) {
      const first = await verifier.verify(evidence(directive));
      for (let again = 0; again < 20; again += 1) {
        expect(await verifier.verify(evidence(directive))).toEqual(first);
      }
    }
  });

  // Break caught: the substitute accepting evidence it did not understand, which would let a real chain through in a place that
  // selected it by mistake.
  it.each([
    ['a real-looking certificate', 'MIIBszCCAVmgAwIBAgIUXXXXXXXX'],
    ['an empty directive', 'substitute:'],
    ['an unknown outcome', 'substitute:APPROVE'],
    ['a lower-case outcome', 'substitute:verified'],
    ['an integrity failure with no cause', 'substitute:INTEGRITY'],
    ['an integrity failure with an unknown cause', 'substitute:INTEGRITY:BECAUSE'],
    ['an unavailable verifier with no cause', 'substitute:UNAVAILABLE'],
    [
      'an unavailable verifier with a cause of the other set',
      'substitute:UNAVAILABLE:KEY_MISMATCH',
    ],
    ['an integrity failure with a cause of the other set', 'substitute:INTEGRITY:VERIFIER_TIMEOUT'],
    ['an acceptance with a cause', 'substitute:VERIFIED:KEY_MISMATCH'],
    ['an unsupported outcome with a cause', 'substitute:UNSUPPORTED:KEY_MISMATCH'],
    ['a directive with a further part', 'substitute:INTEGRITY:KEY_MISMATCH:more'],
    ['a directive that is only a prefix of another', 'substitute'],
  ])('refuses %s as unparseable evidence, and never as acceptance', (_name, first) => {
    expect(
      substituteVerdict({
        expectedChallengeSha256: new Uint8Array(32),
        certificateChain: [first],
        devicePublicKey: KEY_A,
      }),
    ).toEqual({ verdict: 'DEVICE_INTEGRITY_FAILED', cause: 'EVIDENCE_MALFORMED' });
  });

  it('reads only the first element of the chain, and a chain with none is malformed', () => {
    const base = { expectedChallengeSha256: new Uint8Array(32), devicePublicKey: KEY_A };
    expect(substituteVerdict({ ...base, certificateChain: [] })).toEqual({
      verdict: 'DEVICE_INTEGRITY_FAILED',
      cause: 'EVIDENCE_MALFORMED',
    });
    expect(
      substituteVerdict({ ...base, certificateChain: ['not-a-directive', 'substitute:VERIFIED'] }),
    ).toEqual({ verdict: 'DEVICE_INTEGRITY_FAILED', cause: 'EVIDENCE_MALFORMED' });
    expect(
      substituteVerdict({ ...base, certificateChain: ['substitute:UNSUPPORTED', 'ignored'] }),
    ).toEqual({ verdict: 'DEVICE_SECURITY_UNSUPPORTED' });
  });

  // Break caught: the tests of the caller having no way to make a verifier that attests another key, or one that breaks its interface.
  it('can attest another key than the one submitted, and can break its interface, so a caller’s defences can be shown', async () => {
    const other = await verifier.verify(evidence('VERIFIED_OTHER_KEY'));
    if (other.verdict !== 'VERIFIED') throw new Error('expected VERIFIED');
    expect(other.attestedPublicKey).not.toBe(KEY_A);
    expect(parseDevicePublicKey(other.attestedPublicKey).ok).toBe(true);
    const fromB = await verifier.verify(evidence('VERIFIED_OTHER_KEY', KEY_B));
    if (fromB.verdict !== 'VERIFIED') throw new Error('expected VERIFIED');
    expect(fromB.attestedPublicKey).not.toBe(KEY_B);
    expect(parseDevicePublicKey(fromB.attestedPublicKey).ok).toBe(true);

    await expect(verifier.verify(evidence('BROKEN'))).rejects.toBeInstanceOf(
      AttestationInterfaceError,
    );
  });

  // Break caught: the substitute's two stand-in keys drifting from the published ones, or becoming keys the protocol refuses.
  it('holds as its stand-in keys the first two of the published device-key vectors', async () => {
    const first = await verifier.verify(evidence('VERIFIED_OTHER_KEY', KEY_B));
    const second = await verifier.verify(evidence('VERIFIED_OTHER_KEY', KEY_A));
    expect(first).toMatchObject({ attestedPublicKey: KEY_A });
    expect(second).toMatchObject({ attestedPublicKey: KEY_B });
  });
});
