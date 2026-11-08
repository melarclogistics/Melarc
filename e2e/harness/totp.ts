import { createHmac } from 'node:crypto';
import { inspect } from 'node:util';

/**
 * The authenticator app of a journey (S0.45): the codes a person's phone would show for the setup key the screen displayed. RFC 6238
 * with the settings the API fixes (SECURITY_DESIGN.md §13.5): HMAC-SHA-1, 30-second steps from the Unix epoch, six digits.
 *
 * **It works out what the server will take.** The server accepts the current step and the one either side of it, keeps the last step
 * it accepted for a factor, and takes only a later one (`rfc6238.totp-verifier.adapter.ts`). A journey that signs in twice in half a
 * minute therefore cannot present the same code twice: `next()` offers the earliest step that is later than the last it offered and no
 * later than the step after the present one, and when there is none it waits for the clock. A test of a refusal asks for `wrong()`.
 *
 * The key is a secret of the run. An `Authenticator` prints as nothing at all, so it cannot reach a log or a failed assertion; the
 * code it returns is one a page is about to be given, and is used at once.
 */

export const STEP_MS = 30_000;
const DIGITS = 6;
/** The step before the present one is used only while at least this much of the present one is left: a code in flight must not cross into a step that makes it two behind. */
const SAFE_LEFT_MS = 5_000;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, as an authenticator reads a key: upper or lower case, groups of any size, padding optional. */
export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=]/g, '').toUpperCase();
  if (clean === '') throw new Error('A base32 key has at least one character.');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of clean) {
    const index = ALPHABET.indexOf(character);
    if (index === -1)
      throw new Error('The key is not base32: it holds a character outside A-Z and 2-7.');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET.charAt((value << (5 - bits)) & 31);
  return out;
}

/** RFC 4226: the code of one counter. */
export function hotp(secret: Uint8Array, counter: number, digits: number = DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', secret).update(message).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    ((digest[offset + 1] ?? 0) << 16) |
    ((digest[offset + 2] ?? 0) << 8) |
    (digest[offset + 3] ?? 0);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** RFC 6238: the code for the step that holds `milliseconds` (milliseconds since the Unix epoch). */
export function totp(secret: Uint8Array, milliseconds: number): string {
  return hotp(secret, Math.floor(milliseconds / STEP_MS));
}

export type Sleep = (milliseconds: number) => Promise<void>;

const realSleep: Sleep = (milliseconds) =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

export interface AuthenticatorTime {
  readonly now: () => number;
  readonly sleep: Sleep;
}

export class Authenticator {
  readonly #secret: Buffer;
  readonly #time: AuthenticatorTime;
  #lastOffered = -1;

  constructor(
    setupKey: string,
    time: AuthenticatorTime = { now: () => Date.now(), sleep: realSleep },
  ) {
    this.#secret = base32Decode(setupKey);
    this.#time = time;
  }

  /**
   * A code the server will take now, and that no earlier call of this authenticator offered: the earliest step that is later than the
   * last offered. That is the step before the present one while the present step has seconds left to run (the server takes it, and a
   * journey gets three codes in a half-minute without waiting), and the present step near the end of it, when the server's clock may be
   * a step ahead by the time the code arrives and the step before would be two behind.
   */
  async next(): Promise<string> {
    for (;;) {
      const now = this.#time.now();
      const current = Math.floor(now / STEP_MS);
      const secondsLeft = (current + 1) * STEP_MS - now;
      const earliest = secondsLeft > SAFE_LEFT_MS ? current - 1 : current;
      const step = Math.max(earliest, this.#lastOffered + 1);
      if (step <= current + 1) {
        this.#lastOffered = step;
        return hotp(this.#secret, step);
      }
      // Every step the server takes has been used: wait for the next one to begin.
      await this.#time.sleep(secondsLeft);
    }
  }

  /** Six digits that no step near the present accepts. */
  wrong(): string {
    const current = Math.floor(this.#time.now() / STEP_MS);
    const valid = new Set<string>();
    for (let step = current - 3; step <= current + 3; step += 1)
      valid.add(hotp(this.#secret, step));
    for (let candidate = 0; candidate < 1_000_000; candidate += 1) {
      const code = String(candidate).padStart(DIGITS, '0');
      if (!valid.has(code)) return code;
    }
    throw new Error('Every six-digit code is valid, which cannot be.');
  }

  toString(): string {
    return '[Authenticator]';
  }

  toJSON(): string {
    return '[Authenticator]';
  }

  [inspect.custom](): string {
    return '[Authenticator]';
  }
}
