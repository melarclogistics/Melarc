/**
 * A small PDF that names an `/Encrypt` dictionary, for the one thing a scanner's default configuration gets wrong (Run B, Part 1, item 3 of the review of Run A2). ClamAV does not look into an
 * encrypted document unless `AlertEncrypted yes` is set, and with the default `no` it answers `stream: OK` for a file it did not read: a file nobody called clean, stored as clean. With the
 * setting the daemon answers `FOUND` (a heuristic signature, `Heuristics.Encrypted.PDF`), which the platform refuses as malicious content and removes.
 *
 * The file is made here from text, so that nothing binary is kept in the repository. It is a *document* with a security handler whose user password is not empty (the two 32-byte strings
 * are made up and open nothing), so a scanner cannot decrypt it and look inside; it carries no script, no link and no object that does anything. It is the file the owner's smoke command
 * (`evidence:smoke`) puts through the real daemon, and the one the in-process stand-in recognises, so that a dry run and a real run ask the same question.
 */
const HEX_32_BYTES = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

export const ENCRYPTED_PDF_TEST_FILE = [
  '%PDF-1.4',
  '1 0 obj',
  '<< /Type /Catalog /Pages 2 0 R >>',
  'endobj',
  '2 0 obj',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  'endobj',
  '3 0 obj',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 3 3] >>',
  'endobj',
  '4 0 obj',
  `<< /Filter /Standard /V 1 /R 2 /Length 40 /P -4 /O <${HEX_32_BYTES}> /U <${HEX_32_BYTES}> >>`,
  'endobj',
  'trailer',
  '<< /Size 5 /Root 1 0 R /Encrypt 4 0 R /ID [<5ff0f0d1a3c7b2e4486d9a0c11f2e8b3> <5ff0f0d1a3c7b2e4486d9a0c11f2e8b3>] >>',
  'startxref',
  '0',
  '%%EOF',
  '',
].join('\n');

/** The name ClamAV gives an encrypted PDF it flags, which the stand-in gives too, so that a test reads the same word. */
export const ENCRYPTED_PDF_SIGNATURE = 'Heuristics.Encrypted.PDF';
