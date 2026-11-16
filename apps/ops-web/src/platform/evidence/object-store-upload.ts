import type { UploadInstruction } from './evidence-shape';
import { afterQueuedEvents, watchPolicy } from './policy-violation';

/**
 * **The one place the Ops Portal sends bytes anywhere but to its own API**, and the one file of the application that may call `fetch` (named in `eslint.config.mjs` and held by
 * `scripts/eslint-rules.test.ts`): the bytes of a file of evidence go straight to the object store, to the address the platform issued for that one object (the instruction `createEvidence`
 * answered with), because the platform's API does not carry a file. The request is the instruction's and nothing else: a `PUT` of the file's bytes with the headers it lists, **no credentials and
 * no cookie** (`credentials: 'omit'`: the store is not the API and must never be sent the session), no referrer, no cache and no redirect. The address is a bearer capability: it is not logged,
 * not kept after the request, and is in no message of an error.
 *
 * Whether a page may reach an address that is not its own origin is the deployment's: the production policy is `connect-src 'self'` until the bucket's origin is configured
 * (`content-security-policy.ts`, SECURITY_DESIGN.md section 14, D-D7) and the bucket's own CORS rule decides what the store answers, so until the owner allows the bucket's origin in the first and the portal's
 * in the second, an upload to a store of another origin is refused by the browser. **That is told as blocked** (`blocked`: the browser reported a violation of the policy for this very address) and never as a
 * lost connection: the browser's report is watched for from before the request is sent to just after it fails (the bucket does not exist yet: OB-S1-05).
 */
export class ObjectStoreError extends Error {
  override name = 'ObjectStoreError';
  /**
   * `refused`: the store answered and declined (its status is kept); `unreachable`: nothing answered, or the request was abandoned; `blocked`: the browser's own policy did not allow the request. The
   * message never holds the address.
   */
  readonly kind: 'refused' | 'unreachable' | 'blocked';
  readonly status: number | undefined;

  constructor(kind: 'refused' | 'unreachable' | 'blocked', status?: number) {
    super(
      kind === 'refused'
        ? 'The store declined the file.'
        : kind === 'blocked'
          ? 'The browser blocked the request to the store.'
          : 'The store could not be reached.',
    );
    this.kind = kind;
    this.status = status;
  }
}

export async function putBytes(
  instruction: UploadInstruction,
  bytes: Blob,
  signal?: AbortSignal,
): Promise<void> {
  // Listening begins before the request is sent: the browser may report the violation as soon as it has decided, and stops when the request is over, whichever way.
  const policy = watchPolicy('connect-src', instruction.url);
  try {
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
      // A request that was abandoned (the person left the file out, or its time ran out) was not blocked by anything.
      if (signal?.aborted === true) throw new ObjectStoreError('unreachable');
      // The browser's report of a violation is a task of its own and can come just after the failure it explains.
      await afterQueuedEvents();
      // The error of a failed request can carry the address (a browser's message names it): it is dropped here and never repeated.
      throw new ObjectStoreError(policy.blocked() ? 'blocked' : 'unreachable');
    }
    // What the store says is not read for its content, but it is read to its end: a body left open is torn down, and reported as a request that failed, when the page moves on. A store answers a `PUT` with little or nothing.
    await response.arrayBuffer().catch(() => undefined);
    if (!response.ok) throw new ObjectStoreError('refused', response.status);
  } finally {
    policy.stop();
  }
}
