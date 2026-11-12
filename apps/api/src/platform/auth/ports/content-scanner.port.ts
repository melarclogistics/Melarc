import type { PortDescriptor } from './port-descriptor.js';

/**
 * The malicious-content check of an uploaded object (Run A2; the Product Owner's decision D-A6 of 12 November 2026; SECURITY_DESIGN.md sections 14.18 and 14.18b; finding H1 of the
 * review of Run A). **A record of evidence becomes `STORED` only when this port has answered `CLEAN` for the very bytes the record declared**, and a scanner that cannot answer leaves
 * the record as it was: there is no "scan skipped", and no environment but a local run or CI may bind an adapter that does not look at the bytes (`adapter-refusals.ts`).
 *
 * - **The object is streamed, never kept.** The platform reads the object from the store (`EvidenceStore.read`) and hands the bytes to the scanner as they arrive; no adapter writes
 *   them to a disk, and none keeps them past the call.
 * - **What is asked is the bytes, and nothing about whose they are.** The port is given no key, no owner, no name and no address: it cannot log or leak what it does not receive.
 * - **A verdict names the scanner and the version of its signatures**, because the record keeps both (`evidence.scanner`, `scanner_signature_version`): a file judged clean by a
 *   scanner whose signatures are a week old is not the same fact as one judged by yesterday's. The version is read at or before the scan, so it never claims more freshness than
 *   the scan had.
 * - **`FLAGGED` is an answer and not a failure.** The scanner decided, and the platform refuses the file and removes its object. A failure to decide is raised
 *   (`SCANNER_UNAVAILABLE`, `SCANNER_NOT_CONFIGURED`), and the platform answers it as a retryable `503` and leaves the record `PENDING_UPLOAD`.
 */
export type ObjectBytes = AsyncIterable<Uint8Array>;

export interface ScanVerdict {
  readonly verdict: 'CLEAN' | 'FLAGGED';
  /** The scanner that decided, as a short token (`clamav`, `stand-in`). */
  readonly scanner: string;
  /** The version line of the scanner's signature database as the scanner reported it (`ClamAV 1.4.2/27836/Wed Nov 12 08:05:44 2026`), bounded in length. */
  readonly signatureVersion: string;
  /** For a `FLAGGED` verdict, the name of the signature that matched, as a bounded token. It is for the process's own diagnosis and is in no answer. */
  readonly signature?: string;
}

export interface ContentScanner {
  /** Reads the object to its end and answers. Calls a scanner: never inside a transaction. */
  scan(object: ObjectBytes): Promise<ScanVerdict>;
}

export const CONTENT_SCANNER = Symbol('CONTENT_SCANNER');

export const CONTENT_SCANNER_DESCRIPTOR: PortDescriptor<ContentScanner> = {
  port: 'ContentScanner',
  owner: { kind: 'platform', area: 'evidence' },
  operations: {
    scan: {
      inputs: 'the bytes of one object, streamed once and in order',
      outputs: 'the verdict (CLEAN or FLAGGED), the scanner and the version of its signatures',
      outcomes: ['FLAGGED'],
      raises: ['SCANNER_UNAVAILABLE', 'SCANNER_NOT_CONFIGURED'],
      transaction: 'outside-any-transaction',
    },
  },
};
