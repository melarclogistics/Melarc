import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import {
  API,
  HUB_A,
  OPS,
  startStaffRoutes,
  versionOf,
  type Actor,
  type StaffRoutes,
} from './support/staff-routes.js';

/**
 * The operations of S0.36 and S0.37 that take a body (`createStaffIdentity`, `approveStaffIdentity`, `reissueStaffCredentialSetup`,
 * `resetStaffMfa`) answer **every** hostile text with a status below 500 and, when they refuse it, a client error in the error envelope.
 * They need a session, but the person holding one is not trusted with the text of a field either: a control character PostgreSQL will not
 * store, a lone surrogate, an enormous string or a wrong type that makes the application fail inside would be a server error and a line
 * in the operator's log for an act of a maker (the same defect as the NUL byte an address once made `staffSignIn` answer `500` with).
 * A value that is valid text is accepted or refused on its merits; the one thing it may not be is a failure.
 */

const STAFF = `${API}/staff-identities`;
const NUL = String.fromCharCode(0);

/** Values a text member may be given: what a person or a program could send. Some are valid text; none may make the application fail. */
const HOSTILE_VALUES: readonly unknown[] = [
  NUL,
  `a${NUL}b`,
  `a${NUL}b@example.com`,
  `${'a'.repeat(30)}${NUL}`,
  NUL.repeat(500),
  '\uD800',
  `ab\uDC00cd`,
  'x'.repeat(100_000),
  '',
  ' ',
  '\u202E',
  '😀',
  '\r\n',
  'ﬃ'.repeat(500),
  '𝒜'.repeat(3000),
  '%00',
  "'; drop table staff_identity; --",
  '{{7*7}}',
  '../../etc/passwd',
  '\u0085  ',
  '+233200000000',
  '+23320000000000000000000',
  0,
  -1,
  1.5,
  1e308,
  true,
  false,
  null,
  [],
  ['x'],
  [NUL],
  {},
  { a: { b: { c: 1 } } },
];

/** Bodies that are not the object of the contract at all. */
const NOT_OBJECTS: readonly unknown[] = [null, true, 1, 'x', [], [{}], ''];

let routes: StaffRoutes;
/**
 * A session may make 120 requests a minute (the setting rate_limit_authenticated_api, keyed on the session), so a loop of hostile values
 * takes a session of its own for each eighty requests; and a throttled answer is a failure of the test, since the value never reached the
 * operation.
 */
const SESSION_BUDGET = 80;
function rotating(make: () => Promise<Actor>): () => Promise<Actor> {
  let current: Actor | undefined;
  let used = SESSION_BUDGET;
  return async () => {
    if (current === undefined || used >= SESSION_BUDGET) {
      current = await make();
      used = 0;
    }
    used += 1;
    return current;
  };
}

let checker: () => Promise<Actor>;
let maker: () => Promise<Actor>;

beforeAll(async () => {
  routes = await startStaffRoutes();
  checker = rotating(() => routes.platformAdmin());
  maker = rotating(() => routes.opsStaff(HUB_A));
});

afterAll(async () => {
  await routes.stop();
});

/** A text that says what a value was, short enough to read in a failure. */
function describeValue(value: unknown): string {
  const text = JSON.stringify(value);
  return text.length > 48 ? `${text.slice(0, 45)}... (${String(text.length)} chars)` : text;
}

/** What an answer to hostile input must be: not a server error, and a body in the error envelope when it is a refusal. */
function failureOf(response: TestResponse): string | null {
  if (response.status === 429) return 'throttled: the value never reached the operation';
  if (response.status >= 500)
    return `status ${String(response.status)}: ${response.text.slice(0, 160)}`;
  if (response.status >= 400) {
    const parsed = response.json() as { request_id?: unknown; code?: unknown };
    if (typeof parsed.request_id !== 'string' || typeof parsed.code !== 'string') {
      return `a refusal outside the error envelope (${String(response.status)}: ${response.text.slice(0, 160)})`;
    }
  }
  return null;
}

const validProfile = (): Record<string, unknown> => ({
  work_email: `hostile.${randomUUID()}@example.com`,
  full_name: 'Efua Asante',
  phone: '+233200000001',
  role_bundle_id: BUNDLE_IDS.opsStaff,
  primary_hub_id: HUB_A,
});

const createHeaders = () => ({ origin: OPS, headers: { 'idempotency-key': randomUUID() } });

/** A fresh pending profile made by the maker, with the version a reader sees. */
async function pending(): Promise<{ id: string; version: string }> {
  const made = await (await maker()).client.post(STAFF, validProfile(), createHeaders());
  expect(made.status).toBe(200);
  const { id } = made.json() as { id: string };
  return { id, version: await versionOf(await checker(), id) };
}

/** A fresh profile approved by the checker, so that it holds no credential yet and its grant can be re-issued. */
async function approved(): Promise<{ id: string; version: string }> {
  const { id, version } = await pending();
  const settled = await (
    await checker()
  ).client.post(
    `${STAFF}/${id}/approve`,
    { approved: true },
    { origin: OPS, headers: { 'if-match': version } },
  );
  expect(settled.status).toBe(200);
  return { id, version: await versionOf(await checker(), id) };
}

describe('createStaffIdentity answers hostile input without a server error', () => {
  // Break caught: a text a member can hold that makes the application fail inside (a NUL byte stored in a text column, a lone surrogate
  // in a digest, an unbounded text in a statement): a maker's request answered with a status that is the operator's, not the caller's.
  it('refuses or accepts every hostile value of every text member, and never fails on one', async () => {
    const failures: string[] = [];
    for (const member of ['work_email', 'full_name', 'phone', 'role_bundle_id', 'primary_hub_id']) {
      for (const value of HOSTILE_VALUES) {
        const answer = await (
          await checker()
        ).client.post(STAFF, { ...validProfile(), [member]: value }, createHeaders());
        const failure = failureOf(answer);
        if (failure !== null) failures.push(`${member} = ${describeValue(value)}: ${failure}`);
      }
    }
    expect(failures).toEqual([]);
  }, 300_000);

  // Break caught: a body that is not an object reaching the service, or a member the contract does not name being read.
  it('refuses a body that is not the object of the contract', async () => {
    const failures: string[] = [];
    for (const body of NOT_OBJECTS) {
      const failure = failureOf(await (await checker()).client.post(STAFF, body, createHeaders()));
      if (failure !== null) failures.push(`${describeValue(body)}: ${failure}`);
    }
    const stray = await (
      await checker()
    ).client.post(
      STAFF,
      { ...validProfile(), status: 'ACTIVE', created_by: randomUUID(), mfa_enrolled: true },
      createHeaders(),
    );
    expect(stray.status).toBe(400);
    expect(failures).toEqual([]);
  }, 120_000);
});

describe('approveStaffIdentity answers hostile input without a server error', () => {
  // Break caught: a reason or a note that fails inside the reason validator or the statement that records the decision.
  it('refuses or accepts every hostile value of the reason and the note, for a rejection', async () => {
    const failures: string[] = [];
    for (const member of ['reason_code', 'note', 'approved']) {
      for (const value of HOSTILE_VALUES) {
        const { id, version } = await pending();
        const answer = await (
          await checker()
        ).client.post(
          `${STAFF}/${id}/approve`,
          { approved: false, reason_code: 'STAFF_DETAILS_INCORRECT', [member]: value },
          { origin: OPS, headers: { 'if-match': version } },
        );
        const failure = failureOf(answer);
        if (failure !== null) failures.push(`${member} = ${describeValue(value)}: ${failure}`);
      }
    }
    expect(failures).toEqual([]);
  }, 600_000);

  // Break caught: an If-Match that is not a validator reaching the comparison, or a path identifier that is not an identifier.
  it('refuses a hostile If-Match, a hostile identifier in the path and a body that is not an object', async () => {
    const failures: string[] = [];
    const { id } = await pending();
    for (const version of [NUL, '', ' ', '*', '"', 'W/"x"', 'x'.repeat(10_000), '"1"', '😀']) {
      const answer = await (
        await checker()
      ).client
        .post(
          `${STAFF}/${id}/approve`,
          { approved: true },
          { origin: OPS, headers: { 'if-match': version } },
        )
        .catch((error: unknown) => ({ status: 0, error }));
      // A header the transport itself refuses is not a response of the application.
      if ('error' in answer) continue;
      const failure = failureOf(answer);
      if (failure !== null) failures.push(`If-Match ${describeValue(version)}: ${failure}`);
    }
    for (const path of ['not-a-uuid', '%00', 'x'.repeat(5000), '0'.repeat(36), '..%2f..', '😀']) {
      const answer = await (
        await checker()
      ).client.post(
        `${STAFF}/${path}/approve`,
        { approved: true },
        { origin: OPS, headers: { 'if-match': '"1"' } },
      );
      const failure = failureOf(answer);
      if (failure !== null) failures.push(`path ${describeValue(path)}: ${failure}`);
    }
    for (const body of NOT_OBJECTS) {
      const answer = await (
        await checker()
      ).client.post(`${STAFF}/${id}/approve`, body, {
        origin: OPS,
        headers: { 'if-match': '"1"' },
      });
      const failure = failureOf(answer);
      if (failure !== null) failures.push(`body ${describeValue(body)}: ${failure}`);
    }
    expect(failures).toEqual([]);
  }, 300_000);
});

describe('reissueStaffCredentialSetup answers hostile input without a server error', () => {
  const REISSUE = (id: string) => `${API}/ops/staff/${id}/credential/setup/reissue`;

  // Break caught: a reason or a note that fails inside the validator, or in the statement that issues the grant and queues its message.
  it('refuses or accepts every hostile value of the reason and the note', async () => {
    const failures: string[] = [];
    for (const member of ['reason_code', 'note']) {
      for (const value of HOSTILE_VALUES) {
        const { id, version } = await approved();
        const answer = await (
          await checker()
        ).client.post(
          REISSUE(id),
          { reason_code: 'CREDENTIAL_SETUP_LINK_UNUSABLE', [member]: value },
          { origin: OPS, headers: { 'if-match': version } },
        );
        const failure = failureOf(answer);
        if (failure !== null) failures.push(`${member} = ${describeValue(value)}: ${failure}`);
      }
    }
    expect(failures).toEqual([]);
  }, 900_000);

  it('refuses a body that is not the object of the contract', async () => {
    const failures: string[] = [];
    const { id, version } = await approved();
    for (const body of NOT_OBJECTS) {
      const failure = failureOf(
        await (
          await checker()
        ).client.post(REISSUE(id), body, {
          origin: OPS,
          headers: { 'if-match': version },
        }),
      );
      if (failure !== null) failures.push(`${describeValue(body)}: ${failure}`);
    }
    expect(failures).toEqual([]);
  }, 120_000);
});

describe('resetStaffMfa and revokeSession answer hostile input without a server error', () => {
  const RESET = (id: string) => `${API}/ops/staff/${id}/mfa/reset`;
  const REVOKE = (id: string) => `${API}/auth/sessions/${id}/revoke`;

  // Break caught: a reason or a note, or an identifier in the path, that fails the request before the eligibility rule has its say.
  it('refuses or accepts every hostile value of the reason and the note, and every hostile identifier', async () => {
    const failures: string[] = [];
    const { id, version } = await approved();
    for (const member of ['reason_code', 'note']) {
      for (const value of HOSTILE_VALUES) {
        const answer = await (
          await checker()
        ).client.post(
          RESET(id),
          { reason_code: 'MFA_AUTHENTICATOR_UNAVAILABLE', [member]: value },
          { origin: OPS, headers: { 'if-match': version } },
        );
        const failure = failureOf(answer);
        if (failure !== null)
          failures.push(`reset ${member} = ${describeValue(value)}: ${failure}`);
      }
    }
    for (const body of NOT_OBJECTS) {
      const failure = failureOf(
        await (
          await checker()
        ).client.post(RESET(id), body, {
          origin: OPS,
          headers: { 'if-match': version },
        }),
      );
      if (failure !== null) failures.push(`reset body ${describeValue(body)}: ${failure}`);
    }
    for (const path of ['not-a-uuid', '%00', 'x'.repeat(5000), '0'.repeat(36), '😀']) {
      for (const target of [RESET(path), REVOKE(path)]) {
        const answer = await (
          await checker()
        ).client.post(
          target,
          { reason_code: 'MFA_AUTHENTICATOR_UNAVAILABLE' },
          { origin: OPS, headers: { 'if-match': '"1"' } },
        );
        const failure = failureOf(answer);
        if (failure !== null) failures.push(`${target.slice(0, 40)}: ${failure}`);
      }
    }
    expect(failures).toEqual([]);
  }, 300_000);

  // Break caught: the list's query parameters reaching a statement unchecked.
  it('refuses a hostile principal type, principal id and page size of the session list', async () => {
    const failures: string[] = [];
    const base = `${API}/auth/sessions`;
    for (const value of ['', ' ', NUL, '%00', 'x'.repeat(5000), '😀', 'STAFF%00', "' or 1=1 --"]) {
      for (const query of [
        `principal_type=${encodeURIComponent(value)}&principal_id=${randomUUID()}`,
        `principal_type=STAFF&principal_id=${encodeURIComponent(value)}`,
        `principal_type=STAFF&principal_id=${randomUUID()}&page_size=${encodeURIComponent(value)}`,
      ]) {
        const failure = failureOf(await (await checker()).client.get(`${base}?${query}`));
        if (failure !== null) failures.push(`${query.slice(0, 60)}: ${failure}`);
      }
    }
    expect(failures).toEqual([]);
  }, 120_000);
});
