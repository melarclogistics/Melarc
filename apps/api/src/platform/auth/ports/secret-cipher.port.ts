import type { PortDescriptor } from './port-descriptor.js';

/** What a sealed value is for. Each purpose has its own versioned key, so one key's exposure opens nothing else. */
export type CipherPurpose = 'TOTP_SEED' | 'DELIVERY_PAYLOAD' | 'REPLAY_SECRET';

/** An AES-GCM envelope: the ciphertext with the version of the key that made it and the nonce, all that is stored. */
export interface SealedSecret {
  readonly keyVersion: number;
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
}

/**
 * Authenticated encryption of a secret that must be recovered later (a TOTP seed, a queued message, a replayable enrolment
 * answer). The authenticated data binds the envelope to the row or record it belongs to, so a ciphertext moved to another row
 * does not open. Key material comes from configuration, one versioned key per purpose.
 */
export interface SecretCipher {
  seal(
    purpose: CipherPurpose,
    plaintext: Uint8Array,
    authenticatedData: Uint8Array,
  ): Promise<SealedSecret>;
  open(
    purpose: CipherPurpose,
    sealed: SealedSecret,
    authenticatedData: Uint8Array,
  ): Promise<Uint8Array>;
}

export const SECRET_CIPHER = Symbol('SECRET_CIPHER');

export const SECRET_CIPHER_DESCRIPTOR: PortDescriptor<SecretCipher> = {
  port: 'SecretCipher',
  owner: { kind: 'platform', area: 'auth/crypto' },
  operations: {
    seal: {
      inputs: 'the purpose, the plaintext and the authenticated data that ties it to its row',
      outputs: 'a sealed envelope: the key version, the nonce and the ciphertext',
      outcomes: 'none',
      raises: ['PURPOSE_KEY_ABSENT'],
      transaction: 'independent',
    },
    open: {
      inputs: 'the purpose, the sealed envelope and the authenticated data it was sealed with',
      outputs: 'the plaintext',
      outcomes: 'none',
      raises: ['PURPOSE_KEY_ABSENT', 'KEY_VERSION_UNKNOWN', 'AUTHENTICATION_FAILED'],
      transaction: 'independent',
    },
  },
};
