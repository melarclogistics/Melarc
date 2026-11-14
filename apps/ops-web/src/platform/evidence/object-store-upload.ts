import type { UploadInstruction } from './evidence-shape';

/**
 * **The one place the Ops Portal sends bytes anywhere but to its own API**, and the one file of the application that may call `fetch` (named in `eslint.config.mjs` and held by
 * `scripts/eslint-rules.test.ts`): the bytes of a file of evidence go straight to the object store, to the address the platform issued for that one object (the instruction `createEvidence`
 * answered with), because the platform's API does not carry a file. The request is the instruction's and nothing else: a `PUT` of the file's bytes with the headers it lists, **no credentials and
 * no cookie** (`credentials: 'omit'`: the store is not the API and must never be sent the session), no referrer, no cache and no redirect. The address is a bearer capability: it is not logged,
 * not kept after the request, and is in no message of an error.
 *
 * Whether a page may reach an address that is not its own origin is the deployment's: the production policy is `connect-src 'self'` (SECURITY_DESIGN.md section 14) and the bucket's own CORS
 * rule decides what the store answers, so until the owner allows the bucket's origin in the first and the portal's in the second, an upload to a store of another origin is refused by the
 * browser and told as an upload that could not be sent (the bucket does not exist yet: OB-S1-05).
 */
export class ObjectStoreError extends Error {
  override name = 'ObjectStoreError';
  /** `refused`: the store answered and declined (its status is kept); `unreachable`: nothing answered, or the browser refused to send. The message never holds the address. */
  readonly kind: 'refused' | 'unreachable';
  readonly status: number | undefined;

  constructor(kind: 'refused' | 'unreachable', status?: number) {
    super(kind === 'refused' ? 'The store declined the file.' : 'The store could not be reached.');
    this.kind = kind;
    this.status = status;
  }
}

export async function putBytes(
  instruction: UploadInstruction,
  bytes: Blob,
  signal?: AbortSignal,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(instruction.url, {
      method: 'PUT',
      headers: instruction.headers,
      body: bytes,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      redirect: 'error',
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    // The error of a failed request can carry the address (a browser's message names it): it is dropped here and never repeated.
    throw new ObjectStoreError('unreachable');
  }
  if (!response.ok) throw new ObjectStoreError('refused', response.status);
}
