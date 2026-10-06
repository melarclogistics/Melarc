import { afterEach, describe, expect, it } from 'vitest';

import { loadContract } from '../../test-support/contract.js';
import { FixtureModule } from '../../test-support/fixtures.js';
import { appWith, startTestApp, type TestApp } from '../../test-support/test-app.js';
import { ErrorCode } from './error-codes.js';

let running: TestApp | undefined;

async function start(): Promise<TestApp> {
  running = await startTestApp({ rootModule: appWith(FixtureModule) });
  return running;
}

afterEach(async () => {
  await running?.stop();
  running = undefined;
});

interface Answer {
  status: number;
  requestId: string | null;
  contentType: string | null;
  text: string;
  body: Record<string, unknown>;
}

async function answer(response: Response): Promise<Answer> {
  const text = await response.text();
  return {
    status: response.status,
    requestId: response.headers.get('x-request-id'),
    contentType: response.headers.get('content-type'),
    text,
    body: JSON.parse(text) as Record<string, unknown>,
  };
}

describe('unknown routes', () => {
  // Break caught: the framework's own 404 body (which echoes the path and method) reaching clients.
  it('answer 404 NOT_FOUND in the contract envelope and echo nothing back', async () => {
    const { baseUrl } = await start();
    const result = await answer(await fetch(`${baseUrl}/api/v1/no-such-thing-xyz`));

    expect(result.status).toBe(404);
    expect(result.contentType).toContain('application/json');
    expect(Object.keys(result.body).toSorted()).toEqual(['code', 'message', 'request_id']);
    expect(result.body.code).toBe('NOT_FOUND');
    expect(result.body.request_id).toBe(result.requestId);
    expect(result.text).not.toContain('no-such-thing-xyz');
  });
});

describe('malformed request bodies', () => {
  // Break caught: the framework's 400 echoing the body. Nest 12 maps body-parser's SyntaxError to a
  // BadRequestException whose message, Node's JSON error text, can quote the request body.
  it('answer 400 VALIDATION_FAILED without repeating any of the body', async () => {
    const { baseUrl } = await start();
    const result = await answer(
      await fetch(`${baseUrl}/api/v1/anything`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"password": "BODY-SECRET", "broken": ',
      }),
    );

    expect(result.status).toBe(400);
    expect(result.body).toEqual({
      code: 'VALIDATION_FAILED',
      message: 'The request is not valid',
      request_id: result.requestId,
    });
    expect(result.text).not.toContain('BODY-SECRET');
  });
});

describe('request bodies that are not JSON', () => {
  // Break caught: a form-encoded body being parsed and handed to a handler. Every request body in the contract is
  // application/json, and a cross-site HTML form can send a form-encoded POST without a preflight, so a parser the
  // contract never asked for is a way to reach a handler that the JSON-only rule was meant to close.
  it('are not parsed: the handler sees no body', async () => {
    const { baseUrl } = await start();
    const result = await answer(
      await fetch(`${baseUrl}/api/v1/fixture/body/form`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'role=admin&amount=1',
      }),
    );

    expect(result.status).toBe(201);
    expect(result.body).toEqual({ label: 'form' });
  });

  // Break caught: the rule above switching JSON parsing off with the form parser.
  it('still parses a JSON body', async () => {
    const { baseUrl } = await start();
    const result = await answer(
      await fetch(`${baseUrl}/api/v1/fixture/body/json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: 1 }),
      }),
    );

    expect(result.body).toEqual({ label: 'json', received: { amount: 1 } });
  });
});

describe('client errors that have no catalogue code', () => {
  // Break caught: an oversized body reported as a server fault (500, alerting) instead of a client
  // error. The catalogue has no code for it, so the body carries a reason phrase and no `code`.
  it('keep their own status, answer without a code, and are not logged as server faults', async () => {
    const { baseUrl, logs } = await start();
    const result = await answer(
      await fetch(`${baseUrl}/api/v1/anything`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filler: 'x'.repeat(200_000) }),
      }),
    );

    expect(result.status).toBe(413);
    expect(result.body).toEqual({ message: 'Payload Too Large', request_id: result.requestId });
    expect(logs.records().filter((record) => record.msg === 'unhandled error')).toEqual([]);
  });
});

describe('unexpected failures', () => {
  // Break caught: a 5xx that carries a stack, a message from the fault, or a code outside the contract.
  // The specification answers infrastructure failures "by the platform, outside the operation contract"
  // (errors-and-enums.md §4; SECURITY_DESIGN.md §15.3), so this body deliberately has no `code`.
  it('answer 500 with only a generic message and the request id', async () => {
    const { baseUrl } = await start();
    const result = await answer(await fetch(`${baseUrl}/api/v1/fixture/throw-secret`));

    expect(result.status).toBe(500);
    expect(result.body).toEqual({
      message: 'Internal server error',
      request_id: result.requestId,
    });
    for (const secret of ['hunter2', 'abc123', 'HEADER-SECRET', 'BODY-SECRET', 'connect failed']) {
      expect(result.text).not.toContain(secret);
    }
  });

  // Break caught: the exception payload, the likeliest leak (OBSERVABILITY_AND_RECOVERY.md §2.3), reaching
  // the log through the failure path. Every redaction check must run on a failing request as well.
  it('are logged once, with the credentials and request data removed', async () => {
    const { baseUrl, logs } = await start();
    await (await fetch(`${baseUrl}/api/v1/fixture/throw-secret`)).text();

    const failures = logs.records().filter((record) => record.msg === 'unhandled error');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      level: 'error',
      err: { type: 'Error', message: expect.stringContaining('[REDACTED]') as string },
    });
    for (const secret of ['hunter2', 'abc123', 'HEADER-SECRET', 'BODY-SECRET']) {
      expect(logs.text()).not.toContain(secret);
    }
  });
});

describe('a failure after the answer has been sent', () => {
  // Break caught: the filter writing a second answer over one that has already left. That throws out of the
  // filter itself (ERR_HTTP_HEADERS_SENT), so a failure that should have been logged becomes an unhandled
  // error. The client keeps the answer it was given, the failure is logged once, and nothing is written twice.
  it('is logged, and the answer that was sent stands', async () => {
    const { baseUrl, logs } = await start();

    const response = await fetch(`${baseUrl}/api/v1/fixture/fails-after-answering`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ answered: true });
    const failures = logs.records().filter((record) => record.msg === 'unhandled error');
    expect(failures).toHaveLength(1);
    expect(logs.text()).not.toContain('ERR_HTTP_HEADERS_SENT');
  });
});

describe('error codes the platform emits', () => {
  // Break caught: the platform emitting a code the contract does not define, or the contract withdrawing
  // one the platform relies on. The contract's Error.code enumeration is closed on purpose.
  it('all exist in the Error.code enumeration of contracts/openapi.yaml', () => {
    const contractCodes = loadContract().components.schemas.Error.properties.code.enum;

    expect(Object.values(ErrorCode).length).toBeGreaterThan(0);
    for (const code of Object.values(ErrorCode)) {
      expect(contractCodes).toContain(code);
    }
  });
});
