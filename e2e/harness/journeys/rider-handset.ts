import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';

import type { Page } from '@playwright/test';
import jsQR from 'jsqr';

/**
 * The Rider app's half of the rider rows (S0.62; SLICE-000 section 5, rows 7, 8, 9 and 13): the handset is not built (the Rider Android
 * slice builds it), so its operations are driven at API level, as the slice says, by a client that does what the handset does and no
 * more: it reads the enrolment code from the QR the officer's screen draws, makes a P-256 key of its own, submits it with the PIN the
 * rider chose and its attestation, and signs each sign-in challenge with that key. It sends no `Origin` and keeps no cookie: it is a
 * native client, and its credential is the bearer token the sign-in returns once.
 *
 * **The attestation is the substitute's** (`ATTESTATION_VERIFIER=substitute` in the stack: api-environment.ts): the chain is one directive,
 * `substitute:VERIFIED`, standing for a hardware-backed key whose evidence the verifier accepted. A real chain from a real handset is
 * S0.61's, on the owner's hardware.
 */

const QR_NAME = 'QR code for the rider’s handset';
const URI_PREFIX = 'melarc-rider://enrol/v1#token=';
const URI_SEPARATOR = '&challenge=';
const WELL_FORMED = /^[A-Za-z0-9_-]{43}$/;

/** The enrolment code the screen draws as a QR, read from the picture itself: its modules, rasterised and decoded. */
export async function readEnrolmentCode(
  page: Page,
): Promise<{ readonly token: string; readonly challenge: string }> {
  const picture = page.getByRole('img', { name: QR_NAME });
  await picture.waitFor();
  const drawn = await picture.evaluate((element) => ({
    viewBox: element.getAttribute('viewBox'),
    path: element.querySelector('path')?.getAttribute('d') ?? null,
  }));
  const text = decode(drawn.viewBox, drawn.path);
  if (!text.startsWith(URI_PREFIX) || !text.includes(URI_SEPARATOR)) {
    throw new Error('The QR does not carry an enrolment code.');
  }
  const [token = '', challenge = ''] = text.slice(URI_PREFIX.length).split(URI_SEPARATOR);
  // Both are 32 random bytes in their canonical base64url text (43 characters): a code that carries anything else is not one a handset
  // could use, and a journey that went on with it would fail later and elsewhere.
  if (!WELL_FORMED.test(token) || !WELL_FORMED.test(challenge)) {
    throw new Error('The QR carries an enrolment code that is not well formed.');
  }
  return { token, challenge };
}

/** The runs the component draws (`M x,y h n v1 h-n z`), painted dark on light at six pixels a module, and read by a real decoder. */
function decode(viewBox: string | null, path: string | null): string {
  const [x0, y0, size, height] = (viewBox ?? '').split(' ').map(Number);
  if (x0 !== 0 || y0 !== 0 || size === undefined || size !== height || path === null) {
    throw new Error('The QR is not drawn as the component draws it.');
  }
  const scale = 6;
  const width = size * scale;
  const data = new Uint8ClampedArray(width * width * 4).fill(255);
  const segment = /M(\d+),(\d+)h(\d+)v1h-\d+z/gy;
  let consumed = 0;
  for (let match = segment.exec(path); match !== null; match = segment.exec(path)) {
    const [x, y, length] = [Number(match[1]), Number(match[2]), Number(match[3])];
    for (let row = y * scale; row < (y + 1) * scale; row += 1) {
      for (let column = x * scale; column < (x + length) * scale; column += 1) {
        const at = (row * width + column) * 4;
        data[at] = 0;
        data[at + 1] = 0;
        data[at + 2] = 0;
      }
    }
    consumed = segment.lastIndex;
  }
  if (consumed !== path.length)
    throw new Error('The QR path is not made of the runs the component draws.');
  const found = jsQR(data, width, width, { inversionAttempts: 'dontInvert' });
  if (found === null) throw new Error('The QR could not be read.');
  return found.data;
}

export interface HandsetAnswer {
  readonly status: number;
  readonly code: string | undefined;
  readonly body: Record<string, unknown>;
  /** The version the answer carried (`ETag`), for the act that takes it back as `If-Match`. */
  readonly etag?: string;
}

export class RiderHandset {
  readonly #api: string;
  readonly #key: KeyObject;
  /** The canonical standard base64 of the DER SubjectPublicKeyInfo: what the handset registers. */
  readonly publicKey: string;

  constructor(apiOrigin: string) {
    this.#api = apiOrigin;
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    this.#key = pair.privateKey;
    this.publicKey = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  }

  async #send(
    method: string,
    path: string,
    body?: unknown,
    bearer?: string,
    extra: Readonly<Record<string, string>> = {},
  ): Promise<HandsetAnswer> {
    const headers: Record<string, string> = { accept: 'application/json', ...extra };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (bearer !== undefined) headers.authorization = `Bearer ${bearer}`;
    const response = await fetch(`${this.#api}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    const parsed = (text === '' ? {} : JSON.parse(text)) as Record<string, unknown>;
    const etag = response.headers.get('etag');
    return {
      status: response.status,
      code: typeof parsed.code === 'string' ? parsed.code : undefined,
      body: parsed,
      ...(etag === null ? {} : { etag }),
    };
  }

  /**
   * An operation of the Rider app, as the handset sends it: a bearer token, no `Origin`, no cookie, and the headers the operation declares
   * (`If-Match`, `Idempotency-Key`). The answer carries the `ETag` it was given.
   */
  call(
    method: 'GET' | 'POST',
    path: string,
    token: string,
    options: { body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<HandsetAnswer> {
    return this.#send(method, path, options.body, token, options.headers);
  }

  /** `completeRiderDeviceEnrolment`: this handset's key, the PIN the rider chose, and the attestation of the key. */
  enrol(setupToken: string, pin: string): Promise<HandsetAnswer> {
    return this.#send('POST', '/api/v1/auth/rider/device/enrol', {
      setup_token: setupToken,
      public_key: this.publicKey,
      pin,
      key_attestation: { certificate_chain: ['substitute:VERIFIED'] },
    });
  }

  /**
   * The sign-in as the handset makes it: a fresh challenge for the number, signed with this handset's key over the protocol's words
   * (`MELARC-RIDER-SIGNIN-V1`, a line feed, the challenge as issued), and the PIN. Returns the answer and, on success, the token.
   */
  async signIn(phone: string, pin: string): Promise<HandsetAnswer & { readonly token?: string }> {
    const asked = await this.#send('POST', '/api/v1/auth/rider/sign-in/challenge', { phone });
    const challenge = asked.body.challenge;
    if (asked.status !== 200 || typeof challenge !== 'string') return asked;
    const message = Buffer.concat([
      Buffer.from('MELARC-RIDER-SIGNIN-V1', 'utf8'),
      Buffer.from([0x0a]),
      Buffer.from(challenge, 'utf8'),
    ]);
    const answer = await this.#send('POST', '/api/v1/auth/rider/sign-in', {
      phone,
      pin,
      challenge,
      device_signature: sign('sha256', message, { key: this.#key, dsaEncoding: 'der' }).toString(
        'base64',
      ),
      client_root_signal: 'NOT_DETECTED',
    });
    const token = answer.body.access_token;
    return typeof token === 'string' ? { ...answer, token } : answer;
  }

  /** `getCurrentSession` with a bearer token this handset was given. */
  session(token: string): Promise<HandsetAnswer> {
    return this.#send('GET', '/api/v1/auth/session', undefined, token);
  }
}
