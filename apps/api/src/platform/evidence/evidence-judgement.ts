import type {
  ContentScanner,
  ObjectBytes,
  ScanVerdict,
} from '../auth/ports/content-scanner.port.js';
import type { EvidenceStore } from '../auth/ports/evidence-store.port.js';
import type { Metrics } from '../auth/ports/metrics.port.js';
import { ContentScannerError } from './content-scanner-error.js';
import {
  CONTENT_TYPE_SIGNATURE,
  SIGNATURE_BYTES,
  signatureOf,
  type SignatureKind,
} from './evidence-vocabulary.js';
import {
  lazyObject,
  MissingObjectError,
  StreamMismatchError,
  verifiedBytes,
} from './object-bytes.js';

/**
 * Whether the object the store holds for a record is the one the record declared, and clean (Run A2; SECURITY_DESIGN.md sections 14.18 and 14.18b). **The one place that decides it**:
 * `EvidenceService.complete` calls it to move a record to `STORED`, and the owner's smoke command (`evidence:smoke`) calls it to see the real bucket and the real scanner do the same
 * work on a clean file and on the EICAR test file, so what the owner sees is the path production takes.
 *
 * The order is the contract's and is deliberate: what the store *says* of the object (its size, the SHA-256 it recorded, the type it was sent with), then **the bytes themselves**,
 * streamed to the content scanner with their count and hash verified on the way (so the verdict is about the declared object, whatever the store's metadata claims), then the file
 * signature. The scan precedes the signature because a file that is malware and not an image is a flagged file, whatever it claims to be.
 *
 * It returns a refusal as an answer (the rule that failed) and raises what is not the object's fault: a store that does not answer (`EvidenceStoreError`), a scanner that does not
 * (`ContentScannerError`: the platform's fixed `503`, the record untouched). A flagged file is refused and its object removed; a failure to remove it is counted, and the refusal stands.
 */
export interface DeclaredObject {
  readonly storageRef: string;
  /** The declared type, without parameters, lower case. */
  readonly contentType: string;
  readonly byteSize: number;
  /** The declared SHA-256, 64 lower-case hex digits. */
  readonly checksumSha256: string;
}

export type RefusalRule =
  'missing' | 'byte_size' | 'checksum' | 'content_type' | 'malicious_content' | 'signature';

export type Judgement =
  | {
      readonly accepted: true;
      /** The kind of file the bytes were recognised as, which names the declared type. */
      readonly signature: SignatureKind;
      /** The clean verdict, whose scanner and signature version the record keeps. */
      readonly verdict: ScanVerdict;
    }
  | {
      readonly accepted: false;
      readonly rule: RefusalRule;
      /** For a flagged file (`malicious_content`) only: what the audit event of it says (Run B, D-B3). */
      readonly flagged?: FlaggedFacts;
    };

/** What a flagged upload leaves for the audit event: the name of the signature that matched, as the scanner gave it, and whether the object could be removed. */
export interface FlaggedFacts {
  readonly signature: string;
  readonly removed: boolean;
}

export interface JudgementPorts {
  readonly store: Pick<EvidenceStore, 'inspect' | 'read' | 'remove'>;
  readonly scanner: ContentScanner;
  readonly metrics: Metrics;
}

/** `application/pdf; charset=binary` is the type `application/pdf`: a parameter is not part of what the signature of the bytes is checked against. */
export function contentTypeOf(declared: string): string {
  return (declared.split(';')[0] ?? '').trim().toLowerCase();
}

const refused = (rule: RefusalRule): Judgement => ({ accepted: false, rule });

export async function judgeStoredObject(
  ports: JudgementPorts,
  declared: DeclaredObject,
): Promise<Judgement> {
  const { store, scanner, metrics } = ports;

  // 1. What the store says of the object, compared with what was declared.
  const facts = await store.inspect(declared.storageRef, SIGNATURE_BYTES);
  if (facts === undefined) return refused('missing');
  if (facts.byteSize !== declared.byteSize) return refused('byte_size');
  if (facts.checksumSha256 !== declared.checksumSha256) return refused('checksum');
  if (
    facts.contentType !== undefined &&
    contentTypeOf(facts.contentType) !== declared.contentType
  ) {
    return refused('content_type');
  }

  // 2. The bytes themselves, to the scanner, with their size and hash counted on the way. Only a clean verdict goes on; the scanner that cannot answer is raised. **The scanner is asked first**:
  // the store's body is opened when the scanner reads its first byte and not before (a scanner that is not configured, or whose version is not answered, never reads it), and it is let go of
  // whatever the scan does, so that no body is left holding the store's connection (Run B, Part 1, item 5 of the review of Run A2).
  const object = lazyObject(() => store.read(declared.storageRef));
  const verified = verifiedBytes(object.bytes, {
    byteSize: declared.byteSize,
    checksumSha256: declared.checksumSha256,
  });
  // A verdict is about the object only if the stream turned out to be the declared one, which is known at the stream's end: a scanner that answers without having read to it has not decided.
  const progress = { reachedEnd: false };
  const source: ObjectBytes = {
    [Symbol.asyncIterator]: () => {
      const iterator = verified[Symbol.asyncIterator]();
      return {
        next: async (): Promise<IteratorResult<Uint8Array>> => {
          const step = await iterator.next();
          if (step.done === true) progress.reachedEnd = true;
          return step;
        },
        return: (): Promise<IteratorResult<Uint8Array>> => iterator.return(undefined),
      };
    },
  };
  let verdict: ScanVerdict;
  try {
    verdict = await scanner.scan(source);
  } catch (error) {
    if (error instanceof MissingObjectError) return refused('missing');
    if (error instanceof StreamMismatchError) return refused(error.rule);
    if (error instanceof ContentScannerError) {
      metrics.increment('evidence_scans_total', {
        outcome: error.code === 'SCANNER_NOT_CONFIGURED' ? 'NOT_CONFIGURED' : 'UNAVAILABLE',
      });
    }
    throw error;
  } finally {
    object.release();
  }
  if (!progress.reachedEnd) {
    metrics.increment('evidence_scans_total', { outcome: 'UNAVAILABLE' });
    throw new ContentScannerError(
      'SCANNER_UNAVAILABLE',
      'The content scanner answered without reading the whole object',
    );
  }
  if (verdict.verdict === 'FLAGGED') {
    metrics.increment('evidence_scans_total', { outcome: 'FLAGGED' });
    // The refusal stands whether or not the object could be taken away; a failure to remove is counted, and the owner's lifecycle rule takes the object in the end.
    let removed = false;
    try {
      await store.remove(declared.storageRef);
      metrics.increment('evidence_object_removals_total', { outcome: 'REMOVED' });
      removed = true;
    } catch {
      metrics.increment('evidence_object_removals_total', { outcome: 'FAILED' });
    }
    // What the audit event of a flagged upload says (D-B3): the signature that matched and whether the object could be taken away. Never the object's key, which the platform alone holds.
    return {
      accepted: false,
      rule: 'malicious_content',
      flagged: { signature: verdict.signature ?? 'UNNAMED', removed },
    };
  }
  // Only `CLEAN` is a clean verdict, explicitly: a scanner that gave another word (a defect, or a verdict nobody here handles) did not decide, and nothing is stored on it.
  const word: string = verdict.verdict;
  if (word !== 'CLEAN') {
    metrics.increment('evidence_scans_total', { outcome: 'UNAVAILABLE' });
    throw new ContentScannerError(
      'SCANNER_UNAVAILABLE',
      'The content scanner gave a verdict the platform does not know',
    );
  }
  metrics.increment('evidence_scans_total', { outcome: 'CLEAN' });

  // 3. The bytes decide the type (GBT-N14): a declared image/jpeg whose bytes are not a JPEG is refused on the signature.
  const kind = signatureOf(facts.head);
  if (kind === undefined || CONTENT_TYPE_SIGNATURE[declared.contentType] !== kind) {
    return refused('signature');
  }
  return { accepted: true, signature: kind, verdict };
}
