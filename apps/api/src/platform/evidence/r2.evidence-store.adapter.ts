import type {
  EvidenceStore,
  ObjectCapability,
  RetrievalCapabilityRequest,
  StoredObjectFacts,
  UploadCapabilityRequest,
} from '../auth/ports/evidence-store.port.js';
import type { Secret } from '../config/secret.js';
import { currentBudget } from '../execution/execution-budget.js';
import { EvidenceStoreError } from './evidence-store-error.js';
import { checksumHexOf, expiryOf, objectPathOf, uploadHeadersOf } from './object-capability.js';
import {
  amzDateOf,
  authorizeRequest,
  EMPTY_PAYLOAD_SHA256,
  presignRequest,
  type SigV4Scope,
} from './sigv4.js';

/**
 * The Cloudflare R2 adapter of the evidence store (S1.11; the owner's decision of 29 October 2026). R2 speaks the S3 API: the capabilities are Signature Version 4 presigned URLs,
 * made by the platform's own signer (`sigv4.ts`, proved against the worked examples AWS publishes), so **no dependency is added**; region `auto`, service `s3`, path-style
 * `https://<account>.r2.cloudflarestorage.com/<bucket>/<key>`.
 *
 * **No bucket exists yet, and this build makes no network call**: the signing is pure, and `inspect` reaches the store through a transport the composition gives it (a test gives
 * a fake). The owner's R2 credential is held as a `Secret` and revealed to sign, once for each signing, in this file only; it is never logged, put in an error, a metric or an
 * event, and no test, command or file of this repository holds a real one. The adapter is selected by configuration (`EVIDENCE_STORE=r2`), which a deployed environment requires and
 * a local run and CI never set.
 *
 * - **An upload is constrained by what it signs**: the type, the exact size (`content-length`) and the SHA-256 of the bytes (`x-amz-checksum-sha256`, which R2 verifies on receipt and
 *   keeps), so the store itself refuses an upload that is not the one the platform authorised. The signature covers the one path: another key is another signature (GBT-N9), and no
 *   capability lists a bucket (GBT-N10).
 * - **What arrived is read back** (`inspect`): a `HEAD` for the size, the type and the checksum the store recorded, and a ranged `GET` for the first bytes, each signed in the header form;
 *   the platform compares them with what was declared and with the signature of the declared type before a record is stored.
 */
export type R2Transport = (request: {
  readonly method: 'HEAD' | 'GET';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}) => Promise<{
  readonly status: number;
  /** Header names in lower case. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}>;

export interface R2EvidenceStoreOptions {
  readonly accountId: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: Secret;
  /** Where the store answers; `<accountId>.r2.cloudflarestorage.com` unless a test or a jurisdiction says another. */
  readonly host?: string;
  readonly transport: R2Transport;
  /** The clock a server-side call is signed at (the real clock; a test gives a fixed one). */
  readonly now?: () => Date;
}

const SCOPE: SigV4Scope = { region: 'auto', service: 's3' };
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;

export class R2EvidenceStore implements EvidenceStore {
  readonly #options: R2EvidenceStoreOptions;
  readonly #host: string;
  readonly #now: () => Date;

  constructor(options: R2EvidenceStoreOptions) {
    if (
      !IDENTIFIER.test(options.accountId) ||
      !IDENTIFIER.test(options.bucket) ||
      options.accessKeyId === ''
    ) {
      throw new EvidenceStoreError(
        'STORE_NOT_CONFIGURED',
        'The R2 evidence store needs an account, a bucket and an access key',
      );
    }
    this.#options = options;
    this.#host = options.host ?? `${options.accountId}.r2.cloudflarestorage.com`;
    this.#now = options.now ?? (() => new Date());
  }

  #credentials(): { readonly accessKeyId: string; readonly secretAccessKey: string } {
    return {
      accessKeyId: this.#options.accessKeyId,
      secretAccessKey: this.#options.secretAccessKey.reveal(),
    };
  }

  presignUpload(request: UploadCapabilityRequest): ObjectCapability {
    const headers = uploadHeadersOf(request);
    const presigned = presignRequest(this.#credentials(), request.issuedAt, SCOPE, {
      method: 'PUT',
      host: this.#host,
      path: objectPathOf(this.#options.bucket, request.key),
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
    const presigned = presignRequest(this.#credentials(), request.issuedAt, SCOPE, {
      method: 'GET',
      host: this.#host,
      path: objectPathOf(this.#options.bucket, request.key),
      expiresSeconds: request.ttlSeconds,
    });
    return {
      method: 'GET',
      url: presigned.url,
      headers: {},
      expiresAt: expiryOf(request.issuedAt, request.ttlSeconds),
    };
  }

  /** A server-side call, signed in the header form. */
  async #call(
    method: 'HEAD' | 'GET',
    key: string,
    extra: Readonly<Record<string, string>> = {},
  ): ReturnType<R2Transport> {
    const instant = this.#now();
    const path = objectPathOf(this.#options.bucket, key);
    const headers: Record<string, string> = {
      host: this.#host,
      'x-amz-content-sha256': EMPTY_PAYLOAD_SHA256,
      'x-amz-date': amzDateOf(instant),
      ...extra,
    };
    const authorized = authorizeRequest(this.#credentials(), instant, SCOPE, {
      method,
      path,
      query: {},
      headers,
      payloadHash: EMPTY_PAYLOAD_SHA256,
    });
    const sent = Object.fromEntries(Object.entries(headers).filter(([name]) => name !== 'host'));
    const exchange = (): ReturnType<R2Transport> =>
      this.#options.transport({
        method,
        url: `https://${this.#host}${path}`,
        headers: { ...sent, authorization: authorized.authorization },
      });
    try {
      // An outbound call runs under the request's budget when there is one, so that a late answer is refused or recorded (apps/api/CLAUDE.md, "Time is bounded and enforced").
      const budget = currentBudget();
      return await (budget === undefined ? exchange() : budget.effect('evidence_store', exchange));
    } catch (error) {
      // The cause is kept for the process's own diagnosis and is never put in an answer: it may name the address.
      throw new EvidenceStoreError('STORE_UNAVAILABLE', 'The evidence store did not answer', {
        cause: error,
      });
    }
  }

  async inspect(key: string, headBytes: number): Promise<StoredObjectFacts | undefined> {
    const head = await this.#call('HEAD', key, { 'x-amz-checksum-mode': 'ENABLED' });
    if (head.status === 404) return undefined;
    if (head.status !== 200) {
      throw new EvidenceStoreError(
        'STORE_UNAVAILABLE',
        `The evidence store answered ${String(head.status)} to a look at an object`,
      );
    }
    const size = Number(head.headers['content-length']);
    if (!Number.isInteger(size) || size < 0) {
      throw new EvidenceStoreError(
        'STORE_UNAVAILABLE',
        'The evidence store gave no size for an object',
      );
    }
    let leading = new Uint8Array();
    if (size > 0 && headBytes > 0) {
      const last = Math.min(size, headBytes) - 1;
      const ranged = await this.#call('GET', key, { range: `bytes=0-${String(last)}` });
      if (ranged.status !== 206 && ranged.status !== 200) {
        throw new EvidenceStoreError(
          'STORE_UNAVAILABLE',
          `The evidence store answered ${String(ranged.status)} to a read of an object`,
        );
      }
      leading = ranged.body.slice(0, headBytes);
    }
    return {
      byteSize: size,
      checksumSha256: checksumHexOf(head.headers['x-amz-checksum-sha256']),
      contentType: head.headers['content-type'],
      head: leading,
    };
  }
}

/**
 * The transport of a running deployment: Node's own `fetch`, bounded, following no redirect. It is built by the composition when `EVIDENCE_STORE=r2` selects this adapter and is
 * called by nothing in this build's tests (the adapter is tested through a fake transport), so no network call is made until an environment is given a bucket and a credential.
 */
export const fetchTransport: R2Transport = async (request) => {
  const response = await fetch(request.url, {
    method: request.method,
    headers: { ...request.headers },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  const headers: Record<string, string> = {};
  for (const [name, value] of response.headers.entries()) headers[name.toLowerCase()] = value;
  return {
    status: response.status,
    headers,
    body:
      request.method === 'HEAD' ? new Uint8Array() : new Uint8Array(await response.arrayBuffer()),
  };
};
