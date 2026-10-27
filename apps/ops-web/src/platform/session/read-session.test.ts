import { ApiError, createBrowserApiClient } from '@melarc/api-client/browser';
import { afterEach, describe, expect, it } from 'vitest';

import { OperationFailure } from '../api/api-response';
import { errorResponse, installFakeApi, json } from '../../test-support/fake-api';
import { sessionFixture } from '../../test-support/session-fixture';
import { readCurrentSession } from './read-session';

afterEach(() => {
  // The fake is installed in each test; restoring is idempotent.
  installFakeApi().restore();
});

describe('readCurrentSession', () => {
  // Break caught: the session read from somewhere other than the API (a cookie, storage), or asked of another address.
  // The cookie is HttpOnly: the page cannot read it, so the API is the only source of who is signed in.
  it('asks the API who is signed in, on this origin, and returns what it says', async () => {
    const session = sessionFixture();
    const api = installFakeApi({ 'GET /auth/session': () => json(200, session) });

    const read = await readCurrentSession(createBrowserApiClient());

    // What the foundation reads of it, judged: the fields it did not judge (the moments of activity) are not carried through.
    expect(read).toEqual({
      id: session.id,
      principal_type: session.principal_type,
      state: session.state,
      expires_at: session.expires_at,
      principal_display_name: session.principal_display_name,
      authorized_hubs: session.authorized_hubs,
      permissions: session.permissions,
      principal_id: session.principal_id,
    });
    expect(api.requests).toHaveLength(1);
    const [request] = api.requests;
    expect(request?.method).toBe('GET');
    expect(request?.url).toBe(`${location.origin}/api/v1/auth/session`);
    expect(request?.headers.get('Accept')).toBe('application/json');
    expect(api.unhandled).toEqual([]);
  });

  // Break caught: a 401 read as a fault, so the sign-in redirect never happens; its code is the API's, kept as it is.
  it('fails with the API’s answer when nobody is signed in', async () => {
    installFakeApi({ 'GET /auth/session': () => errorResponse(401, 'SESSION_INVALID') });

    const failure = await readCurrentSession(createBrowserApiClient()).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(OperationFailure);
    expect(failure).toMatchObject({ status: 401, code: 'SESSION_INVALID', endsSession: true });
  });

  // Break caught: a 200 that is not a session (a proxy's `null`, an empty object) being handed to the landing as one.
  it.each([
    null,
    'text',
    7,
    [],
    {},
    { ...sessionFixture(), authorized_hubs: [{ id: 'accra' }] },
    { ...sessionFixture(), authorized_hubs: 'Accra' },
    { ...sessionFixture(), permissions: [7] },
    { ...sessionFixture(), principal_type: 'ROBOT' },
    { ...sessionFixture(), principal_type: 'VENDOR' },
    { ...sessionFixture(), state: 'TERMINATED' },
  ])('refuses a success whose body is %j', async (body) => {
    installFakeApi({ 'GET /auth/session': () => json(200, body) });

    const failure = await readCurrentSession(createBrowserApiClient()).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ kind: 'unexpected-response', status: 200 });
  });

  // Break caught: the guard dropping a valid null name, which the contract allows, so that such a person could not sign in.
  it('accepts a session whose display name is null', async () => {
    installFakeApi({
      'GET /auth/session': () => json(200, sessionFixture({ principal_display_name: null })),
    });

    const read = await readCurrentSession(createBrowserApiClient());

    expect(read.principal_display_name).toBeNull();
  });

  it('passes the abort signal on to the request', async () => {
    const api = installFakeApi({ 'GET /auth/session': () => json(200, sessionFixture()) });
    const controller = new AbortController();

    await readCurrentSession(createBrowserApiClient(), controller.signal);

    expect(api.requests[0]?.signal.aborted).toBe(false);
    controller.abort();
    expect(api.requests[0]?.signal.aborted).toBe(true);
  });
});
