/**
 * An answer of the attestation verifier that breaks its own interface (SECURITY_DESIGN.md §15.2.3: "a verifier answer that breaks its own
 * interface is a defect — the platform's generic operational failure, alerted — and never a device refusal"): a verdict the port does not
 * know, a `VERIFIED` that carries no key or a key other than the one it was asked about, a cause outside the closed set. It is **thrown**,
 * not returned, so it is never mistaken for a verdict about the device, and its message names the field and never a value (the evidence is
 * a certificate chain and the answer may carry a key).
 */
export class AttestationInterfaceError extends Error {
  constructor(readonly field: string) {
    super(`The attestation verifier broke its interface: ${field}`);
    this.name = 'AttestationInterfaceError';
  }
}
