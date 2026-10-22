import { randomBytes, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startIntegrationKit, type IntegrationKit } from './support/integration.js';
import { seedReferenceData } from './support/seeded.js';
import { createTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * The five routes of the product contract so far (the three credential setup operations, the staff sign-in and its second step)
 * answer **every** hostile input with a client error and a body in the error envelope, never with a server error. They are reachable
 * with no account and no session, so a text that makes one of them fail inside (a control character PostgreSQL will not store, a
 * lone surrogate, an enormous string, a wrong type, a body that is not JSON, a content type nobody declared) would be a
 * status that tells an anonymous caller something the refusal of an unknown address never does, and a line in the operator's log for
 * each. Found by review: an address with a NUL byte made `staffSignIn` answer `500`.
 *
 * Nothing here needs an account: an unknown address, token or challenge is the common case, and it must be answered like any other
 * refusal. Each request carries a fresh address, token or challenge reference, so no rate limit decides the answer instead of the
 * input. Every value is a throwaway of a disposable database.
 */

const OPS = 'http://127.0.0.1:5173';
const NUL = String.fromCharCode(0);

let database: TestDatabase;
let kit: IntegrationKit;

beforeAll(async () => {
  database = await createTestDatabase();
  await seedReferenceData(database);
  kit = await startIntegrationKit(database, { poolMax: 4 });
});

afterAll(async () => {
  await kit.stop();
  await database.drop();
});

const token = (): string => randomBytes(32).toString('base64url');
let counter = 0;

interface Route {
  readonly name: string;
  readonly path: string;
  /** A body that is valid in shape, with fresh values for whatever a rate limit is keyed on. */
  readonly valid: () => Record<string, unknown>;
  /** The members that are text. */
  readonly strings: readonly string[];
}

const ROUTES: readonly Route[] = [
  {
    name: 'staffSignIn',
    path: '/api/v1/auth/staff/sign-in',
    valid: () => ({
      email: `user${String((counter += 1))}@example.com`,
      password: 'a password that is long enough',
    }),
    strings: ['email', 'password'],
  },
  {
    name: 'completeStaffMfaSignIn',
    path: '/api/v1/auth/staff/sign-in/mfa',
    valid: () => ({ challenge_id: randomUUID(), code: '123456' }),
    strings: ['challenge_id', 'code'],
  },
  {
    name: 'completeStaffCredentialSetup',
    path: '/api/v1/auth/staff/setup/credential',
    valid: () => ({ setup_token: token(), password: 'a password that is long enough' }),
    strings: ['setup_token', 'password'],
  },
  {
    name: 'completeMfaEnrolment',
    path: '/api/v1/auth/staff/setup/mfa',
    valid: () => ({ setup_token: token(), totp_code: '123456' }),
    strings: ['setup_token', 'totp_code'],
  },
  {
    name: 'beginMfaReenrolment',
    path: '/api/v1/auth/staff/setup/mfa/begin',
    valid: () => ({ setup_token: token() }),
    strings: ['setup_token'],
  },
];

/** Values a text member may be given: what a person or a program could send, none of which is a valid member. */
const HOSTILE_VALUES: readonly unknown[] = [
  NUL,
  `a${NUL}b@example.com`,
  `${'a'.repeat(30)}${NUL}`,
  NUL.repeat(500),
  '\uD800',
  `ab\uDC00cd`,
  'x'.repeat(100_000),
  '',
  ' ',
  '‮',
  '😀',
  '\r\n',
  'ﬃ'.repeat(500),
  '𝒜'.repeat(3000),
  '%00',
  "'; drop table staff_identity; --",
  '{{7*7}}',
  '../../etc/passwd',
  '\u0085  ',
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

/** A text that says what a value was, short enough to read in a failure. */
function describeValue(value: unknown): string {
  const text = JSON.stringify(value);
  return text.length > 48 ? `${text.slice(0, 45)}... (${String(text.length)} chars)` : text;
}

async function send(
  path: string,
  body: string,
  headers: Readonly<Record<string, string>> = { 'content-type': 'application/json' },
): Promise<{ status: number; text: string }> {
  const response = await fetch(new URL(path, kit.app.baseUrl), {
    method: 'POST',
    headers: { origin: OPS, ...headers },
    body,
    redirect: 'manual',
  });
  return { status: response.status, text: await response.text() };
}

/**
 * What a refusal must look like: a client error whose body is JSON and carries the request's identifier, whatever was sent. The
 * answers of the application's own operations also carry a `code`; the two refusals of the transport itself (`413`, `415`) do not
 * (error-handling.test.ts pins their body), and they are refusals all the same.
 */
function refusalOf(answer: { status: number; text: string }): string | null {
  if (answer.status < 400 || answer.status > 499) return `status ${String(answer.status)}`;
  try {
    const parsed = JSON.parse(answer.text) as { request_id?: unknown };
    if (typeof parsed.request_id !== 'string') {
      return `a body with no request_id (${String(answer.status)}: ${answer.text.slice(0, 160)})`;
    }
  } catch {
    return `a body that is not JSON (${String(answer.status)}: ${answer.text.slice(0, 160)})`;
  }
  return null;
}

describe.each(ROUTES)(
  '$name answers hostile input with a client error and never a server error',
  (route) => {
    // Break caught: any text a member can hold that makes the application fail inside (a NUL byte in a lookup, an unbounded text in a
    // statement, a lone surrogate in a digest): the status says so to an anonymous caller.
    it('refuses every hostile value of every text member', async () => {
      const failures: string[] = [];
      for (const member of route.strings) {
        for (const value of HOSTILE_VALUES) {
          const answer = await send(
            route.path,
            JSON.stringify({ ...route.valid(), [member]: value }),
          );
          const refused = refusalOf(answer);
          if (refused !== null) failures.push(`${member} = ${describeValue(value)}: ${refused}`);
        }
      }
      expect(failures).toEqual([]);
    }, 180_000);

    // Break caught: a body that is not the object the contract describes reaching a handler, or a parser failure that is not a 4xx.
    it('refuses a body that is not the object of the contract', async () => {
      const [first = 'a'] = route.strings;
      const valid = JSON.stringify(route.valid());
      const bodies: readonly [string, string][] = [
        ['an empty body', ''],
        ['null', 'null'],
        ['true', 'true'],
        ['a number', '1'],
        ['an array', '[]'],
        ['a string', '"x"'],
        ['an unclosed object', '{'],
        ['a truncated member', `{"${first}":`],
        ['a __proto__ member', `{"__proto__":{"x":1}}`],
        ['a constructor member', `{"constructor":{"prototype":{"x":1}}}`],
        ['a repeated member', `{"${first}":"a","${first}":"b"}`],
        ['an out-of-range number', `{"${first}":1e999}`],
        ['five thousand nested arrays', `${'['.repeat(5000)}${']'.repeat(5000)}`],
        ['a byte-order mark before the object', `${String.fromCharCode(0xfeff)}${valid}`],
        ['a body of 300 000 characters', `{"${first}":"${'x'.repeat(300_000)}"}`],
        ['a NUL byte outside any string', `${valid}${NUL}`],
      ];
      const failures: string[] = [];
      for (const [label, body] of bodies) {
        const refused = refusalOf(await send(route.path, body));
        if (refused !== null) failures.push(`${label}: ${refused}`);
      }
      expect(failures).toEqual([]);
    }, 180_000);

    // Break caught: a body read as JSON whatever its declared type, or a parser of another type that fails with a 5xx.
    it('refuses a valid object sent under a content type the contract does not declare', async () => {
      const failures: string[] = [];
      for (const type of [
        'text/plain',
        'application/x-www-form-urlencoded',
        'multipart/form-data; boundary=x',
        'application/xml',
        'application/octet-stream',
      ]) {
        const refused = refusalOf(
          await send(route.path, JSON.stringify(route.valid()), { 'content-type': type }),
        );
        if (refused !== null) failures.push(`${type}: ${refused}`);
      }
      // A charset the server cannot read is a refusal or a request it understands anyway; it is never a server error.
      const odd = await send(route.path, JSON.stringify(route.valid()), {
        'content-type': 'application/json; charset=utf-16',
      });
      if (odd.status >= 500) failures.push(`a utf-16 charset: status ${String(odd.status)}`);
      expect(failures).toEqual([]);
    }, 180_000);
  },
);
