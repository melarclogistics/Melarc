/**
 * The conditions an evidence store adapter throws (the descriptor's `raises`): `STORE_NOT_CONFIGURED` (an adapter that has no credential or no bucket to use) and
 * `STORE_UNAVAILABLE` (the store did not answer, or answered what it should not). Both say nothing of the object, and neither carries a credential, a signed address or a
 * response body: a message names the status the store gave and nothing more.
 */
export type EvidenceStoreErrorCode = 'STORE_NOT_CONFIGURED' | 'STORE_UNAVAILABLE';

export class EvidenceStoreError extends Error {
  readonly code: EvidenceStoreErrorCode;

  constructor(code: EvidenceStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'EvidenceStoreError';
    this.code = code;
  }
}
