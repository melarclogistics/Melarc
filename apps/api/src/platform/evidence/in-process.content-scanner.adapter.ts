import type {
  ContentScanner,
  ObjectBytes,
  ScanVerdict,
} from '../auth/ports/content-scanner.port.js';
import { EICAR_TEST_FILE } from './eicar-test-file.js';

/** The name ClamAV gives the EICAR file, which the stand-in gives it too, so that a test reads the same word. */
export const EICAR_SIGNATURE = 'Eicar-Test-Signature';

/** What the stand-in reports as its signatures: it has none to age. */
export const STAND_IN_SIGNATURE_VERSION = 'stand-in/1';

const EICAR = Buffer.from(EICAR_TEST_FILE, 'latin1');

/**
 * The in-process stand-in for the content scanner (Run A2; D-A6): for development and CI, **refused in production** (`adapter-refusals.ts`), as the store's stand-in is. It reaches no
 * network and has no signatures. It reads the object to its end, exactly as the real adapter does, so that the platform's verification of the bytes finishes, and it flags a file that
 * **begins** with the EICAR test file (the way ClamAV's own signature for it is anchored, trailing white space allowed): that is how a test makes the platform meet a flagged file
 * without a malicious byte in the repository. Everything else is `CLEAN`, which is why production refuses it.
 */
export class InProcessContentScanner implements ContentScanner {
  async scan(object: ObjectBytes): Promise<ScanVerdict> {
    // Only the leading bytes are kept: enough to compare with the EICAR file and its trailing white space.
    const wanted = EICAR.length + 8;
    let head = Buffer.alloc(0);
    for await (const chunk of object) {
      if (head.length < wanted) {
        head = Buffer.concat([head, chunk.subarray(0, wanted - head.length)]);
      }
    }
    const flagged =
      head.length >= EICAR.length &&
      head.subarray(0, EICAR.length).equals(EICAR) &&
      /^[ \t\r\n]*$/.test(head.subarray(EICAR.length).toString('latin1'));
    return {
      verdict: flagged ? 'FLAGGED' : 'CLEAN',
      scanner: 'stand-in',
      signatureVersion: STAND_IN_SIGNATURE_VERSION,
      ...(flagged ? { signature: EICAR_SIGNATURE } : {}),
    };
  }
}
