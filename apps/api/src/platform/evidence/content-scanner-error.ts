/**
 * The conditions a content scanner adapter throws (the descriptor's `raises`): `SCANNER_NOT_CONFIGURED` (no scanner is configured where one is required: a production start
 * without one is allowed, and every completion of evidence is then refused with this) and `SCANNER_UNAVAILABLE` (the scanner did not answer, answered what it should not, or ran
 * past its time). Both say nothing of the object, and neither carries an address, a credential or the scanner's reply: a message names the condition and nothing more.
 *
 * Both are the platform's failure and fail closed: the record stays `PENDING_UPLOAD`, the answer is the fixed retryable `503` (`operational-failure.ts`) and a metric and an alert say
 * it (`evidence_scans_total`). Neither is ever read as a clean verdict.
 */
export type ContentScannerErrorCode = 'SCANNER_NOT_CONFIGURED' | 'SCANNER_UNAVAILABLE';

export class ContentScannerError extends Error {
  readonly code: ContentScannerErrorCode;

  constructor(code: ContentScannerErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ContentScannerError';
    this.code = code;
  }
}
