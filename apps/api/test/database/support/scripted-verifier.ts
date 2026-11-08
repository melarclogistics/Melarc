import { SubstituteAttestationVerifier } from '../../../src/platform/auth/attestation/substitute.attestation-verifier.adapter.js';
import type {
  AttestationEvidence,
  AttestationVerdict,
  AttestationVerifier,
} from '../../../src/platform/auth/ports/attestation-verifier.port.js';

/**
 * The application's **substitute** attestation verifier behind a recorder, which can hold the next call until the test lets it go (S0.57): a
 * verifier that is slow, while the world moves. It yields each verdict a directive of the chain asks for (`substituteChain`), deterministically,
 * and remembers what it was asked, so a test can say that evidence was, or was not, evaluated. Test support; the substitute itself is
 * refused by every production configuration.
 */
export class ScriptedVerifier implements AttestationVerifier {
  readonly calls: AttestationEvidence[] = [];
  #held: Promise<void> | null = null;
  #arrived: (() => void) | null = null;
  readonly #inner = new SubstituteAttestationVerifier();

  /** The next call waits for `release`, and `arrived` says it has reached the verifier. */
  holdNext(): { readonly arrived: Promise<void>; readonly release: () => void } {
    let release = (): void => undefined;
    this.#held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const arrived = new Promise<void>((resolve) => {
      this.#arrived = resolve;
    });
    return { arrived, release };
  }

  async verify(evidence: AttestationEvidence): Promise<AttestationVerdict> {
    this.calls.push(evidence);
    const held = this.#held;
    this.#held = null;
    if (held !== null) {
      this.#arrived?.();
      await held;
    }
    return this.#inner.verify(evidence);
  }
}
