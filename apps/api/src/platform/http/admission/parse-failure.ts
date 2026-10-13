import type { IncomingMessage } from 'node:http';

/**
 * A small, bounded JSON syntax error is not refused when the body is read. It is carried to the validation step of the refusal
 * order (permission-enforcement.md §5.1, step 8; `AC-SLICE-000-130`), so a caller who is not signed in, or may not use the
 * operation, meets steps 1 to 7 first and learns nothing about the schema. The body is within the size limit by the time it is
 * parsed, so carrying it on costs nothing unbounded.
 *
 * The marker is a fact about one request and nothing else: a set of the requests whose body could not be parsed, which forgets
 * a request when the request itself is gone.
 */
const failed = new WeakSet<IncomingMessage>();

/** Records that this request's body was not valid JSON (or named a key the platform refuses). */
export function markBodyParseFailure(request: IncomingMessage): void {
  failed.add(request);
}

/** Whether this request's body could not be parsed. The validation step answers it; nothing earlier does. */
export function bodyParseFailed(request: IncomingMessage): boolean {
  return failed.has(request);
}
