import type {
  ContentScanner,
  ObjectBytes,
  ScanVerdict,
} from '../auth/ports/content-scanner.port.js';
import { EICAR_TEST_FILE } from './eicar-test-file.js';
import { ENCRYPTED_PDF_SIGNATURE } from './encrypted-pdf-test-file.js';
import {
  ARCHIVE_LIMIT_SIGNATURE,
  DAEMON_DEFAULT_MAX_RECURSION,
  archiveNestingOf,
} from './nested-archive-test-file.js';

/** The name ClamAV gives the EICAR file, which the stand-in gives it too, so that a test reads the same word. */
export const EICAR_SIGNATURE = 'Eicar-Test-Signature';

/** What the stand-in reports as its signatures: it has none to age. */
export const STAND_IN_SIGNATURE_VERSION = 'stand-in/1';

const EICAR = Buffer.from(EICAR_TEST_FILE, 'latin1');

/** How much of a file the stand-in looks at for what it recognises beyond the EICAR file: a PDF's security handler (the trailer that names it is at the end of a small file) and the headers of nested archives (they follow one another from the start). */
const PDF_LOOK_BYTES = 64 * 1024;

/**
 * The in-process stand-in for the content scanner (Run A2; D-A6): for development and CI, **refused in production** (`adapter-refusals.ts`), as the store's stand-in is. It reaches no
 * network and has no signatures. It reads the object to its end, exactly as the real adapter does, so that the platform's verification of the bytes finishes, and it flags three things:
 * a file that **begins** with the EICAR test file (the way ClamAV's own signature for it is anchored, trailing white space allowed), which is how a test makes the platform meet a flagged
 * file without a malicious byte in the repository; (Run B, item 3 of the review of Run A2) **an encrypted PDF**, a file that begins `%PDF-` and names an `/Encrypt` dictionary, which
 * a daemon configured as the release gate requires (`AlertEncrypted yes`) flags too; and (Run D, finding F3) **an archive nested deeper than the daemon's default limit** (`MaxRecursion`, 17),
 * which a daemon told to alert on a limit it crossed (`AlertExceedsMax yes`) flags too, so that a dry run of the smoke command asks the questions the real daemon is asked. Everything else
 * is `CLEAN`, which is why production refuses it.
 */
export class InProcessContentScanner implements ContentScanner {
  async scan(object: ObjectBytes): Promise<ScanVerdict> {
    // Only the leading bytes are kept: enough to compare with the EICAR file and its trailing white space, and a bounded look at a PDF.
    const wanted = EICAR.length + 8;
    let head = Buffer.alloc(0);
    let pdf = Buffer.alloc(0);
    for await (const chunk of object) {
      if (head.length < wanted) {
        head = Buffer.concat([head, chunk.subarray(0, wanted - head.length)]);
      }
      if (pdf.length < PDF_LOOK_BYTES) {
        pdf = Buffer.concat([pdf, chunk.subarray(0, PDF_LOOK_BYTES - pdf.length)]);
      }
    }
    const eicar =
      head.length >= EICAR.length &&
      head.subarray(0, EICAR.length).equals(EICAR) &&
      /^[ \t\r\n]*$/.test(head.subarray(EICAR.length).toString('latin1'));
    const encrypted = pdf.subarray(0, 5).toString('latin1') === '%PDF-' && pdf.includes('/Encrypt');
    const tooDeep = archiveNestingOf(pdf) > DAEMON_DEFAULT_MAX_RECURSION;
    const signature = eicar
      ? EICAR_SIGNATURE
      : encrypted
        ? ENCRYPTED_PDF_SIGNATURE
        : tooDeep
          ? ARCHIVE_LIMIT_SIGNATURE
          : undefined;
    return {
      verdict: signature === undefined ? 'CLEAN' : 'FLAGGED',
      scanner: 'stand-in',
      signatureVersion: STAND_IN_SIGNATURE_VERSION,
      ...(signature === undefined ? {} : { signature }),
    };
  }
}
