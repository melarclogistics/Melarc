import {
  ATTESTATION_INTEGRITY_CAUSES,
  ATTESTATION_UNAVAILABLE_CAUSES,
  type AttestationEvidence,
  type AttestationIntegrityCause,
  type AttestationSummary,
  type AttestationUnavailableCause,
  type AttestationVerdict,
  type AttestationVerifier,
} from '../ports/attestation-verifier.port.js';
import { AttestationInterfaceError } from './attestation-errors.js';

/**
 * The substitute attestation verifier (S0.54; SECURITY_DESIGN.md §15.2.1: "The substitute produces each outcome **deterministically** from a
 * controlled test input, so every row above is testable without a device and without production trust settings. **Production cannot select
 * it**"; `AC-SLICE-000-55`, `-75`). It is for a local run, for staging walks of the slice and for tests, and nowhere else: configuration that
 * selects it in production makes the application refuse to start (`adapter-refusals.ts`).
 *
 * **It parses no certificate.** The controlled input is the first element of the chain, a directive:
 *
 * | Directive | Verdict |
 * |---|---|
 * | `substitute:VERIFIED` | `VERIFIED`, attesting the key that was submitted |
 * | `substitute:UNSUPPORTED` | `DEVICE_SECURITY_UNSUPPORTED` |
 * | `substitute:INTEGRITY:<CAUSE>` | `DEVICE_INTEGRITY_FAILED` with one of the closed integrity causes |
 * | `substitute:UNAVAILABLE:<CAUSE>` | `TRUST_DATA_UNAVAILABLE` with one of the six closed unavailable causes |
 * | `substitute:VERIFIED_OTHER_KEY` | `VERIFIED`, attesting another key than the one submitted (a verifier that breaks its interface: the caller must refuse it) |
 * | `substitute:BROKEN` | an answer that breaks the interface (thrown as `AttestationInterfaceError`) |
 *
 * Anything else, a real certificate chain included, is **not** accepted: it is `DEVICE_INTEGRITY_FAILED` with the cause `EVIDENCE_MALFORMED`
 * ("unparseable input"), so the substitute can never wave through evidence it did not understand. The same evidence gives the same verdict
 * every time, and nothing is read from the environment, the clock or a file.
 */
export const SUBSTITUTE_DIRECTIVE_PREFIX = 'substitute:';

/** The summary a substitute `VERIFIED` carries: recognisably not a handset's (a package that is not a package, a digest of zeros). */
const SUBSTITUTE_SUMMARY: AttestationSummary = Object.freeze({
  securityLevel: 'TRUSTED_ENVIRONMENT',
  attestationVersion: 0,
  keyMintVersion: 0,
  packageName: 'substitute.attestation',
  signerDigests: Object.freeze(['0'.repeat(64)]),
});

/**
 * The key a `VERIFIED_OTHER_KEY` directive attests: the first of the published device-key vectors (`apps/api/test/vectors/device-key.v1.json`),
 * or, when that is the key submitted, the second. Both are canonical P-256 keys; neither is any rider's.
 */
const OTHER_KEYS: readonly [string, string] = [
  'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEJCK3trP2XRr259ACHQvweHCCG/GqM/3S2WzfcPoRwsm6Tdl4Zi3mrK7ZJe83p12yLQaZDuvVumFFOcl+454xsQ==',
  'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEF+cg+Qjtc7aRRd8JyzKHZiMXlqaXA6T+Xrpn8J4+3xBJcqHF6IFdT8J6ONrpukZP+D9XRKXQAcJ+Ll3piNslDA==',
];

const isIntegrityCause = (text: string): text is AttestationIntegrityCause =>
  (ATTESTATION_INTEGRITY_CAUSES as readonly string[]).includes(text);
const isUnavailableCause = (text: string): text is AttestationUnavailableCause =>
  (ATTESTATION_UNAVAILABLE_CAUSES as readonly string[]).includes(text);

const MALFORMED: AttestationVerdict = Object.freeze({
  verdict: 'DEVICE_INTEGRITY_FAILED',
  cause: 'EVIDENCE_MALFORMED',
});

/** The chain, as a test writes it: one directive stands for the whole chain. */
export function substituteChain(directive: string): readonly string[] {
  return [`${SUBSTITUTE_DIRECTIVE_PREFIX}${directive}`];
}

/** The verdict a directive gives. Pure: the same evidence, the same verdict. */
export function substituteVerdict(evidence: AttestationEvidence): AttestationVerdict {
  const first = evidence.certificateChain[0];
  if (first?.startsWith(SUBSTITUTE_DIRECTIVE_PREFIX) !== true) return MALFORMED;
  const [outcome, cause, ...extra] = first.slice(SUBSTITUTE_DIRECTIVE_PREFIX.length).split(':');
  if (extra.length > 0) return MALFORMED;
  switch (outcome) {
    case 'VERIFIED':
      if (cause !== undefined) return MALFORMED;
      return {
        verdict: 'VERIFIED',
        attestedPublicKey: evidence.devicePublicKey,
        summary: SUBSTITUTE_SUMMARY,
      };
    case 'VERIFIED_OTHER_KEY':
      if (cause !== undefined) return MALFORMED;
      return {
        verdict: 'VERIFIED',
        attestedPublicKey:
          evidence.devicePublicKey === OTHER_KEYS[0] ? OTHER_KEYS[1] : OTHER_KEYS[0],
        summary: SUBSTITUTE_SUMMARY,
      };
    case 'UNSUPPORTED':
      if (cause !== undefined) return MALFORMED;
      return { verdict: 'DEVICE_SECURITY_UNSUPPORTED' };
    case 'INTEGRITY':
      return cause !== undefined && isIntegrityCause(cause)
        ? { verdict: 'DEVICE_INTEGRITY_FAILED', cause }
        : MALFORMED;
    case 'UNAVAILABLE':
      return cause !== undefined && isUnavailableCause(cause)
        ? { verdict: 'TRUST_DATA_UNAVAILABLE', cause }
        : MALFORMED;
    case 'BROKEN':
      throw new AttestationInterfaceError('verdict');
    default:
      return MALFORMED;
  }
}

export class SubstituteAttestationVerifier implements AttestationVerifier {
  verify(evidence: AttestationEvidence): Promise<AttestationVerdict> {
    try {
      return Promise.resolve(substituteVerdict(evidence));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error('The substitute failed'));
    }
  }
}
