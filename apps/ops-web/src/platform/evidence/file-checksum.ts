/**
 * The SHA-256 of a file's bytes, as the 64 hexadecimal digits the declaration of evidence states (`checksum_sha256`): computed in the browser, on the file the person chose, so that the platform can
 * refuse bytes that are not the ones declared. It needs a secure context (the portal's own origin is one); where there is none the file cannot be declared, and that is said and not worked around.
 */
export class ChecksumUnavailableError extends Error {
  override name = 'ChecksumUnavailableError';
  constructor() {
    super('This browser cannot compute the checksum of a file.');
  }
}

async function bytesOf(file: Blob): Promise<ArrayBuffer> {
  // `Blob.arrayBuffer` is the modern way; a `Response` reads the same bytes where an older engine lacks it.
  return typeof file.arrayBuffer === 'function'
    ? file.arrayBuffer()
    : new Response(file).arrayBuffer();
}

export async function sha256Hex(file: Blob): Promise<string> {
  const subtle = (globalThis.crypto as Crypto | undefined)?.subtle;
  if (subtle === undefined) throw new ChecksumUnavailableError();
  const digest = await subtle.digest('SHA-256', await bytesOf(file));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
