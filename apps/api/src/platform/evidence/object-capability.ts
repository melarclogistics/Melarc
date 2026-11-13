import type { UploadCapabilityRequest } from '../auth/ports/evidence-store.port.js';

/**
 * What both adapters of the evidence store say an upload must carry (S1.11). The capability signs three headers, so that the store itself refuses an upload that is not the
 * one that was declared and authorised: the type, the exact size (`content-length`) and the SHA-256 of the bytes (`x-amz-checksum-sha256`, which S3 and R2 verify on receipt and
 * keep). The client is told the first and the last to send; `content-length` it cannot set (a browser and a handset set it from the body), and the signature holds it.
 */
export interface UploadHeaders {
  /** Every header the signature covers besides `host`. */
  readonly signed: Readonly<Record<string, string>>;
  /** The headers the client is told to send; `content-length` is its own and is not among them. */
  readonly echoed: Readonly<Record<string, string>>;
}

/** 64 lower-case hex digits as the base64 of the 32 bytes they stand for: the form `x-amz-checksum-sha256` carries. */
export const checksumBase64Of = (hex: string): string => {
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new RangeError('A SHA-256 is 64 lower-case hex digits');
  return Buffer.from(hex, 'hex').toString('base64');
};

/** The reverse: the base64 of 32 bytes as 64 hex digits, or nothing when the text is not that. */
export function checksumHexOf(base64: string | undefined): string | undefined {
  if (base64 === undefined) return undefined;
  const bytes = Buffer.from(base64, 'base64');
  return bytes.length === 32 && bytes.toString('base64') === base64
    ? bytes.toString('hex')
    : undefined;
}

export function uploadHeadersOf(request: UploadCapabilityRequest): UploadHeaders {
  if (!Number.isInteger(request.byteSize) || request.byteSize < 1) {
    throw new RangeError('An upload has a size of at least one byte');
  }
  const checksum = checksumBase64Of(request.checksumSha256);
  return {
    signed: {
      'content-type': request.contentType,
      'content-length': String(request.byteSize),
      'x-amz-checksum-sha256': checksum,
    },
    echoed: { 'Content-Type': request.contentType, 'x-amz-checksum-sha256': checksum },
  };
}

/** The moment a capability stops working. */
export const expiryOf = (issuedAt: Date, ttlSeconds: number): Date =>
  new Date(Math.floor(issuedAt.getTime() / 1000) * 1000 + ttlSeconds * 1000);

/** The path of an object in the bucket (path-style: `/<bucket>/<key>`). */
export const objectPathOf = (bucket: string, key: string): string => `/${bucket}/${key}`;
