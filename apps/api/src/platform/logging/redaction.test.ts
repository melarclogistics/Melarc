import { describe, expect, it } from 'vitest';

import { REDACTED, describeError, redactValue, scrubText } from './redaction.js';

const SECRET = 'S3cr3t-Value-123';

// The categories OBSERVABILITY_AND_RECOVERY.md §2.3 says are redacted everywhere, by the names they
// travel under: headers, cookies, request-body fields and bearer capabilities.
const SENSITIVE_KEYS = [
  'authorization',
  'Authorization',
  'cookie',
  'Cookie',
  'set-cookie',
  'Set-Cookie',
  'x-csrf-token',
  'X-CSRF-Token',
  'melarc_csrf',
  'password',
  'newPassword',
  'current_password',
  'pin',
  'PIN',
  'otp',
  'totp',
  'totp_seed',
  'seed',
  'secret',
  'client_secret',
  'token',
  'access_token',
  'refreshToken',
  'setup_grant',
  'SetupGrantToken',
  'recovery_token',
  'melarc_vendor_device',
  'device_credential',
  'session_token',
  'private_key',
  'api_key',
  'apiKey',
  'signed_url',
  'signature',
];

describe('redactValue: sensitive keys', () => {
  // Break caught: a secret category missing from the key list, so it is logged in clear.
  it.each(SENSITIVE_KEYS)('redacts the value of %s', (key) => {
    expect(redactValue({ [key]: SECRET })).toEqual({ [key]: REDACTED });
  });

  // Break caught: redaction applied only at the top level, so a nested header map still leaks.
  it('redacts at any depth, including inside arrays', () => {
    const input = {
      req: { headers: [{ authorization: SECRET }], body: { user: { password: SECRET } } },
    };
    expect(redactValue(input)).toEqual({
      req: { headers: [{ authorization: REDACTED }], body: { user: { password: REDACTED } } },
    });
  });

  // Break caught: a whole credential object logged because only its leaf names were checked.
  it('redacts a whole subtree under a sensitive key', () => {
    expect(redactValue({ credentials: { user: 'ama', pass: SECRET } })).toEqual({
      credentials: REDACTED,
    });
  });

  // Break caught: substring matching on short words, which would destroy useful fields
  // ("shipping" contains "pin", "footprint" contains "otp").
  it('keeps ordinary fields, including ones that merely contain a short sensitive word', () => {
    const input = {
      method: 'GET',
      status: 200,
      route: '/orders/:id',
      request_id: 'abc',
      duration_ms: 12,
      shipping_address: 'Osu',
      mapping: 'x',
      spinning: true,
      footprint: 3,
      speeded: 1,
    };
    expect(redactValue(input)).toEqual(input);
  });

  // Break caught: the logger mutating the caller's object, which is often the live request headers.
  it('does not modify its input', () => {
    const input = { headers: { authorization: SECRET }, list: [{ password: SECRET }] };
    const before = structuredClone(input);
    redactValue(input);
    expect(input).toEqual(before);
  });

  // Break caught: a logging call throwing or hanging on a circular or very deep object.
  it('survives circular and very deep objects', () => {
    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;
    expect(redactValue(circular)).toEqual({ name: 'loop', self: '[Circular]' });

    let deep: Record<string, unknown> = { leaf: true };
    for (let level = 0; level < 50; level += 1) deep = { next: deep };
    expect(JSON.stringify(redactValue(deep))).toContain('[Truncated]');
  });

  // Break caught: binary payloads (an uploaded file, a key) written into a log.
  it('replaces binary data with a size placeholder', () => {
    expect(redactValue({ file: Buffer.from('top secret bytes') })).toEqual({
      file: '[Binary 16 bytes]',
    });
  });
});

describe('scrubText: secrets embedded in free text', () => {
  // Break caught: a pattern that is missing, or so greedy it swallows the text after the secret.
  it.each([
    [
      'a bearer credential',
      'rejected Bearer abc.DEF-123_x for user',
      'rejected Bearer [REDACTED] for user',
    ],
    ['a basic credential', 'sent Basic dXNlcjpwYXNz now', 'sent Basic [REDACTED] now'],
    [
      'credentials inside a connection string',
      'connect ECONNREFUSED postgres://melarc:hunter2@db.internal:5432/melarc',
      'connect ECONNREFUSED postgres://[REDACTED]@db.internal:5432/melarc',
    ],
    [
      'a token in a query string',
      'GET /recover?token=abc123&next=/home',
      'GET /recover?token=[REDACTED]&next=/home',
    ],
    [
      'a signed-URL signature',
      'https://files.example/o?X-Amz-Signature=deadbeef&X-Amz-Expires=300',
      'https://files.example/o?X-Amz-Signature=[REDACTED]&X-Amz-Expires=300',
    ],
    [
      'a password pair',
      'login failed password=hunter2 user=ama',
      'login failed password=[REDACTED] user=ama',
    ],
    [
      'a JSON-style secret',
      '{"password":"hunter2","user":"ama"}',
      '{"password":"[REDACTED]","user":"ama"}',
    ],
    ['a short-word pair', 'otp=123456 pin=4321', 'otp=[REDACTED] pin=[REDACTED]'],
    ['nothing sensitive', 'order 42 accepted at hub 7', 'order 42 accepted at hub 7'],
    ['a similar word that is not a secret', 'shipping=express', 'shipping=express'],
  ])('handles %s', (_label, input, expected) => {
    expect(scrubText(input)).toBe(expected);
  });

  // Break caught: free-text scrubbing skipped for string fields, so a URL in a message leaks.
  it('scrubs string values nested in logged objects', () => {
    expect(redactValue({ msg: 'GET /x?token=abc', nested: ['cb?signature=zzz'] })).toEqual({
      msg: 'GET /x?token=[REDACTED]',
      nested: ['cb?signature=[REDACTED]'],
    });
  });
});

describe('describeError', () => {
  // Break caught: an exception payload carrying the request (headers, body) into the log.
  it('describes an error by type, message and stack only', () => {
    const error = new TypeError('connect failed postgres://melarc:hunter2@db/melarc');
    Object.assign(error, {
      config: { headers: { Authorization: `Bearer ${SECRET}` } },
      request: { body: { password: SECRET } },
    });
    const described = describeError(error);
    expect(Object.keys(described).toSorted()).toEqual(['message', 'stack', 'type']);
    expect(described.type).toBe('TypeError');
    const serialised = JSON.stringify(described);
    expect(serialised).not.toContain(SECRET);
    expect(serialised).not.toContain('hunter2');
  });

  // Break caught: a secret in an error message or in the stack's first line.
  it('scrubs the message and the stack', () => {
    const described = describeError(new Error('bad request token=abc123'));
    expect(described.message).toBe('bad request token=[REDACTED]');
    expect(described.stack).not.toContain('abc123');
  });

  // Break caught: the cause chain skipped (loses the real failure) or serialised unscrubbed.
  it('describes the cause chain, scrubbed', () => {
    const error = new Error('outer', { cause: new Error('inner password=hunter2') });
    expect(describeError(error).cause).toMatchObject({
      type: 'Error',
      message: 'inner password=[REDACTED]',
    });
  });

  // Break caught: a thrown non-Error (string, object) stringified wholesale into the log.
  it('never stringifies a thrown object', () => {
    expect(describeError({ password: SECRET })).toEqual({
      type: 'NonError',
      message: 'a non-error value of type object was thrown',
    });
    expect(describeError('password=hunter2')).toEqual({
      type: 'NonError',
      message: 'password=[REDACTED]',
    });
  });

  // Break caught: errors nested in logged objects skipping the safe serializer.
  it('is applied to errors found inside logged objects', () => {
    const error = new Error('x');
    Object.assign(error, { body: { password: SECRET } });
    const result = redactValue({ err: error }) as { err: { type: string } };
    expect(result.err.type).toBe('Error');
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});
