import type { PortDescriptor } from './port-descriptor.js';

export interface AttestationEvidence {
  /** The base64url challenge (32 bytes) the handset's key attestation was bound to. */
  readonly challenge: string;
  /** The certificate chain, leaf first, each certificate as base64 DER. */
  readonly certificateChain: readonly string[];
  /** The device public key being enrolled, as canonical base64 SPKI. */
  readonly devicePublicKey: string;
}

export type AttestationVerdict =
  | { readonly verdict: 'VERIFIED' }
  | { readonly verdict: 'DEVICE_INTEGRITY_FAILED' }
  | { readonly verdict: 'DEVICE_SECURITY_UNSUPPORTED' }
  | { readonly verdict: 'TRUST_DATA_UNAVAILABLE' };

/**
 * The verdict of a handset's Android key attestation (SECURITY_DESIGN.md §15.2). The verifier is a private service; it holds
 * no database credentials, and the API calls it **outside any transaction**, then locks and re-reads the grant, its expiry and
 * the device state before one atomic change. `TRUST_DATA_UNAVAILABLE` says the evidence could not be evaluated now, which
 * says nothing about the device, and is distinct from `DEVICE_INTEGRITY_FAILED`.
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
      inputs: 'the challenge, the certificate chain and the device public key',
      outputs: 'VERIFIED, or the reason the evidence was not accepted',
      outcomes: [
        'DEVICE_INTEGRITY_FAILED',
        'DEVICE_SECURITY_UNSUPPORTED',
        'TRUST_DATA_UNAVAILABLE',
      ],
      raises: 'none',
      transaction: 'outside-any-transaction',
    },
  },
};
