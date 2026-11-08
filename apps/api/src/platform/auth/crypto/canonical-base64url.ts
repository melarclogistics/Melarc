const SHAPE = /^[A-Za-z0-9_-]{43}$/;

/**
 * The 32 bytes spelt by a canonical 43-character unpadded base64url string, or undefined for anything else
 * (SECURITY_DESIGN.md §14.9: a token, a grant, a recovery token, a challenge and a key are all this form).
 *
 * "Canonical" means the text is the one spelling of its bytes. The last character carries two spare bits and a decoder that only
 * decodes would take a spelling with them set, giving one value two texts: a presented token, its stored hash and the key it
 * is compared with could then disagree. So the bytes are encoded again and must give the text back. Padding, `+`, `/`, white
 * space and any other length are refused by the shape alone.
 */
export function decodeBase64Url32(text: unknown): Buffer | undefined {
  if (typeof text !== 'string' || !SHAPE.test(text)) return undefined;
  const bytes = Buffer.from(text, 'base64url');
  return bytes.length === 32 && bytes.toString('base64url') === text ? bytes : undefined;
}
