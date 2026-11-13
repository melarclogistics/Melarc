import { describe, expect, it } from 'vitest';

import { EICAR_TEST_FILE } from './eicar-test-file.js';
import { ENCRYPTED_PDF_SIGNATURE, ENCRYPTED_PDF_TEST_FILE } from './encrypted-pdf-test-file.js';
import {
  EICAR_SIGNATURE,
  InProcessContentScanner,
  STAND_IN_SIGNATURE_VERSION,
} from './in-process.content-scanner.adapter.js';

/**
 * The in-process stand-in of the content scanner (Run A2; D-A6): it flags the EICAR test file, the way ClamAV's own signature for it is anchored, and calls everything else clean,
 * which is why production refuses it (`production-refusals.test.ts`). It reads the whole stream, as the real adapter does, so that the verification of the bytes finishes.
 */
async function* framesOf(...parts: readonly (string | Uint8Array)[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) {
    await Promise.resolve();
    yield typeof part === 'string' ? Buffer.from(part, 'latin1') : part;
  }
}

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const scanner = new InProcessContentScanner();

describe('the stand-in content scanner', () => {
  it('knows the EICAR test file for what it is: 68 characters, a standard that harms nothing', () => {
    expect(EICAR_TEST_FILE).toHaveLength(68);
    expect(
      EICAR_TEST_FILE.startsWith('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE'),
    ).toBe(true);
  });

  // Break caught: a stand-in that calls the EICAR file clean, so that no test could meet a flagged file without a malicious byte.
  it('flags the EICAR test file, whole or split across frames, with trailing white space allowed', async () => {
    for (const frames of [
      [EICAR_TEST_FILE],
      [EICAR_TEST_FILE.slice(0, 20), EICAR_TEST_FILE.slice(20)],
      [EICAR_TEST_FILE, '\r\n'],
      [EICAR_TEST_FILE + '  \n'],
    ]) {
      expect(await scanner.scan(framesOf(...frames))).toEqual({
        verdict: 'FLAGGED',
        scanner: 'stand-in',
        signatureVersion: STAND_IN_SIGNATURE_VERSION,
        signature: EICAR_SIGNATURE,
      });
    }
  });

  // Break caught: a stand-in that flags more than the real scanner would (an image that merely mentions the string), or that stops short of the end of the stream.
  it('calls everything else clean: a picture, an empty object, the EICAR text inside a file or followed by other text', async () => {
    for (const frames of [
      [JPEG],
      [],
      ['JFIF ' + EICAR_TEST_FILE],
      [EICAR_TEST_FILE + ' and more'],
      [EICAR_TEST_FILE.slice(0, 67)],
    ]) {
      const verdict = await scanner.scan(framesOf(...frames));
      expect(verdict).toEqual({
        verdict: 'CLEAN',
        scanner: 'stand-in',
        signatureVersion: STAND_IN_SIGNATURE_VERSION,
      });
    }
  });

  // Break caught (Run B, item 3): a stand-in that calls the encrypted PDF clean, so that a dry run of the smoke command would not ask the question the real daemon is asked.
  it('flags an encrypted PDF, whole or split across frames, as a daemon configured for the release gate does', async () => {
    for (const frames of [
      [ENCRYPTED_PDF_TEST_FILE],
      [ENCRYPTED_PDF_TEST_FILE.slice(0, 100), ENCRYPTED_PDF_TEST_FILE.slice(100)],
    ]) {
      expect(await scanner.scan(framesOf(...frames))).toEqual({
        verdict: 'FLAGGED',
        scanner: 'stand-in',
        signatureVersion: STAND_IN_SIGNATURE_VERSION,
        signature: ENCRYPTED_PDF_SIGNATURE,
      });
    }
  });

  // Break caught: a stand-in that flags every PDF, or any file that merely names the word.
  it('calls a PDF that is not encrypted clean, and a file that is not a PDF', async () => {
    const plain = ENCRYPTED_PDF_TEST_FILE.replace('/Encrypt 4 0 R ', '');
    expect(plain).not.toContain('/Encrypt');
    for (const frames of [[plain], ['JFIF /Encrypt ' + plain], ['%PDF-1.4\n%%EOF\n']]) {
      expect((await scanner.scan(framesOf(...frames))).verdict).toBe('CLEAN');
    }
  });

  it('reads the stream to its end, whatever it finds', async () => {
    let finished = false;
    async function* watched(): AsyncGenerator<Uint8Array> {
      yield Buffer.from(EICAR_TEST_FILE, 'latin1');
      await Promise.resolve();
      yield Buffer.alloc(100_000);
      finished = true;
    }
    await scanner.scan(watched());
    expect(finished).toBe(true);
  });

  it('lets a failure of the source pass as it was', async () => {
    const broken = new Error('the store stopped sending');
    async function* failing(): AsyncGenerator<Uint8Array> {
      await Promise.resolve();
      yield JPEG;
      throw broken;
    }
    await expect(scanner.scan(failing())).rejects.toBe(broken);
  });
});
