import type { PortDescriptor } from './port-descriptor.js';

/**
 * What the verifier is asked (SECURITY_DESIGN.md §15.2.1, §15.2.3): the certificate chain the handset produced for this enrolment, the key it
 * claims, and the one thing of the grant the evidence must carry. The API **holds only the SHA-256 of the attestation challenge**
 * (`SetupGrant.attestation_challenge_hash`; the challenge itself went to the handset in the QR and is kept nowhere), so the verifier is given
 * that hash and compares it, in constant time, with the SHA-256 of the 32 challenge bytes the attestation extension carries. The accepted
 * roots, the package, the approved signing-certificate digests and the trust data are the verifier's own configuration and loaded data, never
 * this request's.
 */
export interface AttestationEvidence {
  /** The SHA-256 (32 bytes) of the 32 challenge bytes issued with the grant. */
  readonly expectedChallengeSha256: Uint8Array;
  /** The certificate chain, leaf first, each certificate as base64 DER; 1 to 10 certificates. */
  readonly certificateChain: readonly string[];
  /** The device public key being enrolled, as the canonical base64 of its 91-byte DER SubjectPublicKeyInfo (`canonicalDevicePublicKey`). */
  readonly devicePublicKey: string;
}

/**
 * The closed classes of an integrity failure, one for each step of the policy that can end in `DEVICE_INTEGRITY_FAILED` (§15.2.1). They are
 * recorded on `auth.device.attestation_failed` and as a metric label, and never in the response.
 */
export const ATTESTATION_INTEGRITY_CAUSES = [
  /** Step 1: the chain does not parse, is oversized, or carries a malformed or duplicate extension, or none. */
  'EVIDENCE_MALFORMED',
  /** Step 3: a certificate does not sign the next, or one is outside its validity period (the factory certificate's expiry alone excepted). */
  'CHAIN_INVALID',
  /** Step 4: the chain does not end at an accepted Android attestation root. */
  'ROOT_NOT_TRUSTED',
  /** Step 5: a certificate of the chain is on the attestation revocation list. */
  'CERTIFICATE_REVOKED',
  /** Step 6: the attested challenge is not the one issued with the grant. */
  'CHALLENGE_MISMATCH',
  /** Step 7: the attested package is not the Melarc Rider package. */
  'PACKAGE_NOT_APPROVED',
  /** Step 7: a signing-certificate digest the extension reports is not in the approved set. */
  'SIGNER_NOT_APPROVED',
  /** Step 8: the device is not locked (hardware-enforced root of trust). */
  'DEVICE_NOT_LOCKED',
  /** Step 8: the verified boot state is not `Verified` (hardware-enforced root of trust). */
  'BOOT_STATE_NOT_VERIFIED',
  /** Step 9: the key was not generated on the device, is not a signing key, or is not an EC P-256 key with SHA-256. */
  'KEY_PROPERTIES_REJECTED',
  /** Step 10: the attested public key is not the public key submitted for registration. */
  'KEY_MISMATCH',
] as const;
export type AttestationIntegrityCause = (typeof ATTESTATION_INTEGRITY_CAUSES)[number];

/**
 * The six closed causes of `TRUST_DATA_UNAVAILABLE` (§15.2.3): they go to the structured log and to the bounded `cause` label of
 * `attestation_verifier_unavailable_total`, and **never into the response**. No `auth.device.attestation_failed` event is written for one,
 * because nothing was decided about the device.
 */
export const ATTESTATION_UNAVAILABLE_CAUSES = [
  'TRUST_DATA_STALE',
  'TRUST_DATA_NOT_LOADED',
  'TRUST_ROOTS_UNLOADABLE',
  'VERIFIER_UNREACHABLE',
  'VERIFIER_TIMEOUT',
  'VERIFIER_OVERLOADED',
] as const;
export type AttestationUnavailableCause = (typeof ATTESTATION_UNAVAILABLE_CAUSES)[number];

/** `Verified` is the one boot state that passes step 8; the others are named so that a summary cannot say a thing the policy forbids. */
export interface AttestationSummary {
  /** The hardware security level of the attestation and of the key: `TrustedEnvironment` or `StrongBox`, never `Software`. */
  readonly securityLevel: 'TRUSTED_ENVIRONMENT' | 'STRONG_BOX';
  /** The attestation extension's version and the key-management version, as numbers, for diagnosis. */
  readonly attestationVersion: number;
  readonly keyMintVersion: number;
  /** The package the extension named (it equals the configured Melarc Rider package, or the evidence was refused). */
  readonly packageName: string;
  /**
   * The signing-certificate digests the extension reported, each as lower-case hexadecimal SHA-256 (every one is in the approved set, or the
   * evidence was refused). Recorded and never compared with anything else.
   */
  readonly signerDigests: readonly string[];
}

/**
 * What the verifier decided. `VERIFIED` carries the key it attested and a non-secret summary; the two refusals carry the closed cause of
 * their step; `TRUST_DATA_UNAVAILABLE` carries one of the six closed causes and says **nothing about the device**. A verdict the verifier
 * gave is never relabelled by the caller.
 */
export type AttestationVerdict =
  | {
      readonly verdict: 'VERIFIED';
      /** The attested public key, as the canonical base64 of its DER SubjectPublicKeyInfo: the caller compares it with the submitted one. */
      readonly attestedPublicKey: string;
      readonly summary: AttestationSummary;
    }
  | { readonly verdict: 'DEVICE_INTEGRITY_FAILED'; readonly cause: AttestationIntegrityCause }
  | { readonly verdict: 'DEVICE_SECURITY_UNSUPPORTED' }
  | { readonly verdict: 'TRUST_DATA_UNAVAILABLE'; readonly cause: AttestationUnavailableCause };

/**
 * The verdict of a handset's Android key attestation (SECURITY_DESIGN.md §15.2). The verifier is a private service; it holds
 * no database credentials, and the API calls it **outside any transaction**, then locks and re-reads the grant, its expiry and
 * the device state before one atomic change. `TRUST_DATA_UNAVAILABLE` says the evidence could not be evaluated now, which
 * says nothing about the device, and is distinct from `DEVICE_INTEGRITY_FAILED`. An adapter never throws for a verifier that cannot answer:
 * unreachable, overloaded and late are the verdict `TRUST_DATA_UNAVAILABLE` with their cause; an answer that breaks the interface is a defect
 * and is thrown (`AttestationInterfaceError`).
 */
export interface AttestationVerifier {
  verify(evidence: AttestationEvidence): Promise<AttestationVerdict>;
}

export const ATTESTATION_VERIFIER = Symbol('ATTESTATION_VERIFIER');

export const ATTESTATION_VERIFIER_DESCRIPTOR: PortDescriptor<AttestationVerifier> = {
  port: 'AttestationVerifier',
  owner: { kind: 'platform', area: 'auth/attestation' },
  operations: {
    verify: {
      inputs:
        'the SHA-256 of the attestation challenge issued with the grant, the certificate chain and the device public key',
      outputs:
        'VERIFIED with the attested key and a summary, or the reason the evidence was not accepted (the closed cause of an integrity failure, or of an unavailable verifier)',
      outcomes: [
        'DEVICE_INTEGRITY_FAILED',
        'DEVICE_SECURITY_UNSUPPORTED',
        'TRUST_DATA_UNAVAILABLE',
      ],
      raises: ['ATTESTATION_INTERFACE_BROKEN'],
      transaction: 'outside-any-transaction',
    },
  },
};
