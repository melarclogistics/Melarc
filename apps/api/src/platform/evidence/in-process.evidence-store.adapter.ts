import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { ObjectBytes } from '../auth/ports/content-scanner.port.js';
import type {
  EvidenceStore,
  ObjectCapability,
  RetrievalCapabilityRequest,
  StoredObjectFacts,
  UploadCapabilityRequest,
} from '../auth/ports/evidence-store.port.js';
import { checksumHexOf, expiryOf, objectPathOf, uploadHeadersOf } from './object-capability.js';
import {
  canonicalRequestOf,
  presignRequest,
  sha256Hex,
  signatureOf,
  UNSIGNED_PAYLOAD,
  type SigV4Credentials,
  type SigV4Scope,
} from './sigv4.js';

/**
 * The in-process stand-in for the evidence store (S1.11; the owner's decision of 29 October 2026): for development and CI, **refused in production** (`adapter-refusals.ts`). It reaches
 * no bucket and no network. It keeps the objects in the process's memory, makes capabilities with the platform's own Signature Version 4 under a credential made at random for the
 * process (the same signing the Cloudflare R2 adapter uses), and `redeem` is the stand-in's counterpart of the store's own checks, so that a test can redeem a capability the way a
 * handset would and see what a real store would refuse: a capability past its life, an address changed to another object, a header that is not the signed one, a body that is not
 * the declared size or hash.
 *
 * It is not a route: nothing in the application serves it. `plant` exists to arrange an object a test says the store holds (a size or a hash the platform did not expect); nothing
 * but a test calls it.
 */
export const STAND_IN_HOST = 'evidence.stand-in.invalid';
const BUCKET = 'evidence';
/** The size of a frame of an object read from the stand-in: small, so that a test of a stream sees more than one. */
const READ_FRAME_BYTES = 8192;
const SCOPE: SigV4Scope = { region: 'auto', service: 's3' };

export interface InProcessEvidenceStoreOptions {
  /** The clock the stand-in judges a redemption by: the real clock of a running process, a manual one in a test. */
  readonly now?: () => Date;
}

interface HeldObject {
  readonly bytes: Uint8Array;
  readonly contentType: string | undefined;
  readonly checksumSha256: string | undefined;
}

export interface Redemption {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
}

export type RedemptionResult =
  | { readonly status: 200; readonly body: Uint8Array }
  | {
      readonly status: 400 | 403 | 404;
      readonly reason:
        | 'MALFORMED'
        | 'EXPIRED'
        | 'SIGNATURE_MISMATCH'
        | 'HEADER_NOT_SIGNED'
        | 'CHECKSUM_MISMATCH'
        | 'SIZE_MISMATCH'
        | 'NOT_FOUND';
    };

const stamp = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;
function instantOf(amzDate: string): Date | undefined {
  const match = stamp.exec(amzDate);
  if (match === null) return undefined;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  return new Date(
    Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1, hour ?? 0, minute ?? 0, second ?? 0),
  );
}

export class InProcessEvidenceStore implements EvidenceStore {
  readonly #credentials: SigV4Credentials = {
    accessKeyId: `STANDIN${randomBytes(6).toString('hex').toUpperCase()}`,
    secretAccessKey: randomBytes(32).toString('hex'),
  };
  readonly #objects = new Map<string, HeldObject>();
  readonly #now: () => Date;

  constructor(options: InProcessEvidenceStoreOptions = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  presignUpload(request: UploadCapabilityRequest): ObjectCapability {
    const headers = uploadHeadersOf(request);
    const presigned = presignRequest(this.#credentials, request.issuedAt, SCOPE, {
      method: 'PUT',
      host: STAND_IN_HOST,
      path: objectPathOf(BUCKET, request.key),
      signedHeaders: headers.signed,
      expiresSeconds: request.ttlSeconds,
    });
    return {
      method: 'PUT',
      url: presigned.url,
      headers: headers.echoed,
      expiresAt: expiryOf(request.issuedAt, request.ttlSeconds),
    };
  }

  presignRetrieval(request: RetrievalCapabilityRequest): ObjectCapability {
    const presigned = presignRequest(this.#credentials, request.issuedAt, SCOPE, {
      method: 'GET',
      host: STAND_IN_HOST,
      path: objectPathOf(BUCKET, request.key),
      expiresSeconds: request.ttlSeconds,
    });
    return {
      method: 'GET',
      url: presigned.url,
      headers: {},
      expiresAt: expiryOf(request.issuedAt, request.ttlSeconds),
    };
  }

  inspect(key: string, headBytes: number): Promise<StoredObjectFacts | undefined> {
    const held = this.#objects.get(key);
    if (held === undefined) return Promise.resolve(undefined);
    return Promise.resolve({
      byteSize: held.bytes.length,
      checksumSha256: held.checksumSha256,
      contentType: held.contentType,
      head: held.bytes.slice(0, headBytes),
    });
  }

  /** The bytes of the object, in frames, so that a reader sees them arrive as it would from a store; nothing when nothing is held at the key. */
  read(key: string): Promise<ObjectBytes | undefined> {
    const held = this.#objects.get(key);
    if (held === undefined) return Promise.resolve(undefined);
    const { bytes } = held;
    return Promise.resolve(
      (async function* frames(): AsyncGenerator<Uint8Array, void, undefined> {
        for (let at = 0; at < bytes.length; at += READ_FRAME_BYTES) {
          yield bytes.subarray(at, at + READ_FRAME_BYTES);
        }
      })(),
    );
  }

  /** Takes the object away; what is not there stays not there. */
  remove(key: string): Promise<void> {
    this.#objects.delete(key);
    return Promise.resolve();
  }

  /** Arranges an object the store holds, as a test says it is (a size or a hash the platform did not expect). Nothing but a test calls it. */
  plant(
    key: string,
    bytes: Uint8Array,
    facts: { readonly contentType?: string; readonly checksumSha256?: string | null } = {},
  ): void {
    this.#objects.set(key, {
      bytes,
      contentType: facts.contentType,
      checksumSha256:
        facts.checksumSha256 === null ? undefined : (facts.checksumSha256 ?? sha256Hex(bytes)),
    });
  }

  /** Whether the stand-in holds an object at the key. */
  has(key: string): boolean {
    return this.#objects.has(key);
  }

  /**
   * What the store does with a client's redemption of a capability: the signature over the method, the address and the signed headers is checked, the life of the capability is
   * judged on the stand-in's clock, and an upload's body must be the declared size and hash. The key is read from the address, so an address changed to another object is not
   * the one that was signed.
   */
  redeem(call: Redemption): RedemptionResult {
    let url: URL;
    try {
      url = new URL(call.url);
    } catch {
      return { status: 400, reason: 'MALFORMED' };
    }
    const query = Object.fromEntries(url.searchParams.entries());
    const given = query['X-Amz-Signature'];
    const issuedAt = instantOf(query['X-Amz-Date'] ?? '');
    const expires = Number(query['X-Amz-Expires']);
    const signedNames = (query['X-Amz-SignedHeaders'] ?? '').split(';');
    if (
      url.host !== STAND_IN_HOST ||
      given === undefined ||
      issuedAt === undefined ||
      !Number.isInteger(expires) ||
      signedNames.length === 0 ||
      !url.pathname.startsWith(`/${BUCKET}/`) ||
      query['X-Amz-Credential']?.split('/')[0] !== this.#credentials.accessKeyId
    ) {
      return { status: 400, reason: 'MALFORMED' };
    }
    // The headers the signature covers are taken from the call (case-insensitively); one that was signed and is not sent is a signature that does not hold.
    const sent = new Map(
      Object.entries(call.headers).map(([name, value]) => [name.toLowerCase(), value]),
    );
    const headers: Record<string, string> = { host: STAND_IN_HOST };
    for (const name of signedNames) {
      if (name === 'host') continue;
      const value = sent.get(name);
      if (value === undefined) return { status: 403, reason: 'HEADER_NOT_SIGNED' };
      headers[name] = value;
    }
    const unsigned = { ...query };
    delete unsigned['X-Amz-Signature'];
    const canonical = canonicalRequestOf({
      method: call.method,
      path: decodeURIComponent(url.pathname),
      query: unsigned,
      headers,
      payloadHash: UNSIGNED_PAYLOAD,
    });
    const expected = signatureOf(this.#credentials, issuedAt, SCOPE, canonical.text);
    const same =
      expected.length === given.length &&
      timingSafeEqual(Buffer.from(expected), Buffer.from(given));
    if (!same) return { status: 403, reason: 'SIGNATURE_MISMATCH' };
    // The life of the capability: from the instant it was made, for the seconds it was given.
    if (this.#now().getTime() >= issuedAt.getTime() + expires * 1000) {
      return { status: 403, reason: 'EXPIRED' };
    }
    const key = decodeURIComponent(url.pathname).slice(`/${BUCKET}/`.length);
    if (call.method.toUpperCase() === 'GET') {
      const held = this.#objects.get(key);
      return held === undefined
        ? { status: 404, reason: 'NOT_FOUND' }
        : { status: 200, body: held.bytes };
    }
    // An upload: the body is exactly the declared size and hashes to the declared value, as the store would verify on receipt.
    const body = call.body ?? new Uint8Array();
    if (headers['content-length'] !== String(body.length)) {
      return { status: 400, reason: 'SIZE_MISMATCH' };
    }
    const declared = checksumHexOf(headers['x-amz-checksum-sha256']);
    if (declared === undefined || createHash('sha256').update(body).digest('hex') !== declared) {
      return { status: 400, reason: 'CHECKSUM_MISMATCH' };
    }
    this.#objects.set(key, {
      bytes: body,
      contentType: headers['content-type'],
      checksumSha256: declared,
    });
    return { status: 200, body: new Uint8Array() };
  }
}

/** The instant a stand-in capability was made at, as the address states it (for a test that wants to read it). */
export const issuedAtOfStandInUrl = (url: string): Date | undefined =>
  instantOf(new URL(url).searchParams.get('X-Amz-Date') ?? '');
