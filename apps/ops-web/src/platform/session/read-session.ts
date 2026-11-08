import { ApiError, type BrowserApiClient } from '@melarc/api-client/browser';

import { answerOf } from '../api/api-response';
import { parseCurrentSession } from './session-shape';
import type { SessionView } from './session-store';

/**
 * `getCurrentSession`: who is signed in, asked of the API. The session cookie is `HttpOnly`, so the page cannot read
 * it and could not tell a live session from a dead one by itself; the API is the only source. A `401` fails with the
 * API's answer (`OperationFailure`, `endsSession` true), which the store reads as "nobody is signed in".
 *
 * A success is judged before it is believed (`session-shape.ts`, U05 of 23 October 2026): the send boundary guarantees JSON, not that it
 * is a session, and a body that is not one (a proxy's `{}`, a malformed hub list, a session of another kind of principal or one that has
 * ended) is an answer that is not the API's. It fails as `unexpected-response`, so the store makes the session *unavailable* with a retry,
 * and no signed-in content is ever rendered from it.
 */
export async function readCurrentSession(
  client: BrowserApiClient,
  signal?: AbortSignal,
): Promise<SessionView> {
  const answer = answerOf(
    await client.GET('/auth/session', signal === undefined ? {} : { signal }),
  );
  const session = parseCurrentSession(answer.data);
  if (session === undefined) {
    throw new ApiError({ kind: 'unexpected-response', status: answer.status });
  }
  return session;
}
