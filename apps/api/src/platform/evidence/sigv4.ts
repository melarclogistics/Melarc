import { createHash, createHmac } from 'node:crypto';

/**
 * AWS Signature Version 4, made by hand with `node:crypto` (S1.11; the owner's decision of 29 October 2026: no dependency is added). It is the signature of
 * Cloudflare R2's S3-compatible API, and it is proved against the worked examples AWS publishes for Amazon S3 ("Signature Calculations for the Authorization
 * Header" and "Authenticating Requests: Using Query Parameters"; `sigv4.test.ts` carries each with its source), so that no bucket and no network call is needed to
 * know that the signing is right.
 *
 * Pure functions: nothing here reads the clock, the environment or the network, writes a log or keeps a credential. The secret access key is a parameter of the
 * call and is not held by anything in this file; the caller (the R2 adapter) reveals it at the edge, for the one call.
 */

export const SIGV4_ALGORITHM = 'AWS4-HMAC-SHA256';
/** The payload hash of a request whose body is not part of the signature: a presigned URL's (the client sends the body, and the signed headers constrain it). */
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
/** The hash of an empty body, which every request without one states (`x-amz-content-sha256`). */
export const EMPTY_PAYLOAD_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export interface SigV4Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/** The place a request is signed for: the region and the service of the credential scope (`auto` and `s3` for R2). */
export interface SigV4Scope {
  readonly region: string;
  readonly service: string;
}

export const sha256Hex = (data: string | Uint8Array): string =>
  createHash('sha256').update(data).digest('hex');

const hmac = (key: string | Uint8Array, data: string): Buffer =>
  createHmac('sha256', key).update(data, 'utf8').digest();

const UNRESERVED = /[A-Za-z0-9\-_.~]/;

/**
 * The percent-encoding Signature Version 4 specifies: every byte but `A-Z a-z 0-9 - _ . ~` is encoded as `%XX` in upper case, and `/` is encoded unless the caller
 * is encoding a path (`encodeSlash` false). A space is `%20`, never `+`.
 */
export function uriEncode(value: string, encodeSlash = true): string {
  let encoded = '';
  for (const byte of Buffer.from(value, 'utf8')) {
    const character = String.fromCharCode(byte);
    if (UNRESERVED.test(character)) encoded += character;
    else if (character === '/' && !encodeSlash) encoded += '/';
    else encoded += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return encoded;
}

/** `20130524T000000Z`: the instant in the form of `x-amz-date` and `X-Amz-Date`. */
export function amzDateOf(instant: Date): string {
  return instant
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

/** `20130524`: the day of the credential scope, in UTC. */
export const shortDateOf = (instant: Date): string => amzDateOf(instant).slice(0, 8);

export const credentialScopeOf = (instant: Date, scope: SigV4Scope): string =>
  `${shortDateOf(instant)}/${scope.region}/${scope.service}/aws4_request`;

/** The query as the canonical request states it: each name and value encoded, sorted by name and then by value. A name with no value keeps its `=`. */
export function canonicalQueryOf(query: Readonly<Record<string, string>>): string {
  return Object.entries(query)
    .map(([name, value]) => [uriEncode(name), uriEncode(value)] as const)
    .sort(([nameA, valueA], [nameB, valueB]) =>
      nameA === nameB ? (valueA < valueB ? -1 : valueA > valueB ? 1 : 0) : nameA < nameB ? -1 : 1,
    )
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
}

/** The path of an object as Amazon S3 states it: each segment encoded once (S3 does not encode twice), the slashes kept. */
export const canonicalPathOf = (path: string): string =>
  path
    .split('/')
    .map((segment) => uriEncode(segment))
    .join('/');

interface CanonicalHeaders {
  readonly block: string;
  readonly signed: string;
}

/** The headers, lower-cased and sorted by name, with each value trimmed and its runs of spaces made one; and the list of their names. */
export function canonicalHeadersOf(headers: Readonly<Record<string, string>>): CanonicalHeaders {
  const entries = Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, ' ')] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    block: entries.map(([name, value]) => `${name}:${value}\n`).join(''),
    signed: entries.map(([name]) => name).join(';'),
  };
}

export interface CanonicalRequestInput {
  readonly method: string;
  /** The object path as it is, for example `/test$file.text`: it is encoded here. */
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
  readonly payloadHash: string;
}

export function canonicalRequestOf(input: CanonicalRequestInput): {
  readonly text: string;
  readonly signedHeaders: string;
} {
  const { block, signed } = canonicalHeadersOf(input.headers);
  return {
    text: [
      input.method.toUpperCase(),
      canonicalPathOf(input.path),
      canonicalQueryOf(input.query),
      block,
      signed,
      input.payloadHash,
    ].join('\n'),
    signedHeaders: signed,
  };
}

export const stringToSignOf = (
  instant: Date,
  scope: SigV4Scope,
  canonicalRequest: string,
): string =>
  [
    SIGV4_ALGORITHM,
    amzDateOf(instant),
    credentialScopeOf(instant, scope),
    sha256Hex(canonicalRequest),
  ].join('\n');

/** The signing key: the secret, folded through the day, the region, the service and the word `aws4_request`. */
export function signingKeyOf(secretAccessKey: string, instant: Date, scope: SigV4Scope): Buffer {
  const day = hmac(`AWS4${secretAccessKey}`, shortDateOf(instant));
  const region = hmac(day, scope.region);
  const service = hmac(region, scope.service);
  return hmac(service, 'aws4_request');
}

export const signatureOf = (
  credentials: SigV4Credentials,
  instant: Date,
  scope: SigV4Scope,
  canonicalRequest: string,
): string =>
  hmac(
    signingKeyOf(credentials.secretAccessKey, instant, scope),
    stringToSignOf(instant, scope, canonicalRequest),
  ).toString('hex');

export interface AuthorizedRequest {
  /** The value of the `Authorization` header. */
  readonly authorization: string;
  readonly signature: string;
  readonly canonicalRequest: string;
}

/**
 * The `Authorization` header of a request whose headers are signed (the form a server-side call uses): every header in `input.headers` is signed, so the caller gives
 * `host`, `x-amz-date` and `x-amz-content-sha256` among them as the service requires.
 */
export function authorizeRequest(
  credentials: SigV4Credentials,
  instant: Date,
  scope: SigV4Scope,
  input: CanonicalRequestInput,
): AuthorizedRequest {
  const canonical = canonicalRequestOf(input);
  const signature = signatureOf(credentials, instant, scope, canonical.text);
  return {
    authorization: `${SIGV4_ALGORITHM} Credential=${credentials.accessKeyId}/${credentialScopeOf(instant, scope)},SignedHeaders=${canonical.signedHeaders},Signature=${signature}`,
    signature,
    canonicalRequest: canonical.text,
  };
}

export interface PresignInput {
  readonly method: string;
  /** The host of the endpoint (`<account>.r2.cloudflarestorage.com`): the one header every presigned URL signs. */
  readonly host: string;
  readonly path: string;
  /** Query parameters of the operation itself (for example `response-content-type`), signed with the rest. */
  readonly query?: Readonly<Record<string, string>>;
  /**
   * Further headers the client must send exactly as given (for example `content-type` and `x-amz-checksum-sha256` of an upload): they are signed, so a request that
   * differs in any of them is refused by the store. The caller hands them to the client.
   */
  readonly signedHeaders?: Readonly<Record<string, string>>;
  /** How long the URL lives, in seconds, from `instant`. */
  readonly expiresSeconds: number;
}

export interface PresignedUrl {
  readonly url: string;
  readonly signature: string;
}

/** A URL that grants one operation on one object until it expires (Signature Version 4 in the query string, `UNSIGNED-PAYLOAD`). */
export function presignRequest(
  credentials: SigV4Credentials,
  instant: Date,
  scope: SigV4Scope,
  input: PresignInput,
): PresignedUrl {
  if (!Number.isInteger(input.expiresSeconds) || input.expiresSeconds < 1) {
    throw new RangeError('A presigned URL lives a whole number of seconds, at least one');
  }
  const headers: Record<string, string> = { ...(input.signedHeaders ?? {}), host: input.host };
  const { signed } = canonicalHeadersOf(headers);
  const query: Record<string, string> = {
    ...(input.query ?? {}),
    'X-Amz-Algorithm': SIGV4_ALGORITHM,
    'X-Amz-Credential': `${credentials.accessKeyId}/${credentialScopeOf(instant, scope)}`,
    'X-Amz-Date': amzDateOf(instant),
    'X-Amz-Expires': String(input.expiresSeconds),
    'X-Amz-SignedHeaders': signed,
  };
  const canonical = canonicalRequestOf({
    method: input.method,
    path: input.path,
    query,
    headers,
    payloadHash: UNSIGNED_PAYLOAD,
  });
  const signature = signatureOf(credentials, instant, scope, canonical.text);
  return {
    url: `https://${input.host}${canonicalPathOf(input.path)}?${canonicalQueryOf(query)}&X-Amz-Signature=${signature}`,
    signature,
  };
}
