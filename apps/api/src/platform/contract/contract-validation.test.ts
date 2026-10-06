import http from 'node:http';

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Module,
  Next,
  Param,
  Post,
  Query,
  Redirect,
  Render,
  Req,
  Res,
  Sse,
  type Type,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FIXTURE_CONTRACT } from '../../test-support/contract-fixtures.js';
import { TEST_CONFIG } from '../../test-support/test-config.js';
import { appWith, startTestApp, type TestApp } from '../../test-support/test-app.js';
import { buildOpenApiDocument } from '../openapi/build-openapi-document.js';
import { TechnicalEndpoint } from '../routes/access-declaration.js';
import { declareAnswerPrincipal } from './answer-context.js';
import { ContractOperation } from './contract-operation.js';
import type { ContractSource } from './contract-source.js';
import { ContractValidationService } from './contract-validation.service.js';
import type { JsonObject } from './json.js';

const UUID = '0190d7c2-7a3e-7c1e-9d2a-3f4b5c6d7e8f';

/** The matchers return `any`; these hand them on as what they are, a value to compare against. */
const arrayContaining = (items: unknown[]): unknown => expect.arrayContaining(items);
const anyString: unknown = expect.any(String);
const CANARY = 'CANARY-must-never-come-back-7f3a';

/** What the fixture handlers do, set by each test. Handlers count their calls so a refusal can be seen to stop at the door. */
const behaviour: { calls: number; widget: unknown } = { calls: 0, widget: undefined };

const GOOD_WIDGET = { id: UUID, state: 'ACTIVE', note: null };

@Controller('widgets')
@TechnicalEndpoint()
class ValidatedWidgetsController {
  @Get(':id')
  @ContractOperation('getWidget')
  read(@Param('id') id: string): unknown {
    behaviour.calls += 1;
    return behaviour.widget ?? { ...GOOD_WIDGET, id };
  }

  @Post()
  @HttpCode(201)
  @ContractOperation('createWidget')
  create(): unknown {
    behaviour.calls += 1;
    return behaviour.widget ?? GOOD_WIDGET;
  }

  /** Not bound to any operation: nothing about it is validated. */
  @Post('unbound')
  @HttpCode(200)
  unbound(@Body() body: unknown): unknown {
    behaviour.calls += 1;
    return { echoed: body };
  }
}

@Module({ controllers: [ValidatedWidgetsController] })
class ValidatedWidgetsModule {}

@Controller('ghosts')
@TechnicalEndpoint()
class GhostController {
  @Get()
  @ContractOperation('thisOperationIsNotInTheContract')
  list(): unknown {
    return [];
  }
}

@Module({ controllers: [GhostController] })
class GhostModule {}

/** Two operations that differ only in how their success status is chosen. */
const OK_BODY = {
  description: 'OK',
  content: {
    'application/json': {
      schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
    },
  },
};
const STATUS_CONTRACT = {
  openapi: '3.1.0',
  paths: {
    '/statuses/created': {
      post: { operationId: 'createdByDefault', responses: { '201': OK_BODY } },
    },
    '/statuses/ok': { post: { operationId: 'okByHttpCode', responses: { '200': OK_BODY } } },
  },
} as unknown as JsonObject;

@Controller('statuses')
@TechnicalEndpoint()
class StatusController {
  /** No @HttpCode: the router answers a POST with 201. */
  @Post('created')
  @ContractOperation('createdByDefault')
  created(): unknown {
    return { ok: true };
  }

  /** @HttpCode(200) overrides the default. */
  @Post('ok')
  @HttpCode(200)
  @ContractOperation('okByHttpCode')
  ok(): unknown {
    return { ok: true };
  }
}

@Module({ controllers: [StatusController] })
class StatusModule {}

/** The real contract's `getPickupRequest`, bound to a route, to show the default wiring reads the real file. */
@Controller('pickup-requests')
@TechnicalEndpoint()
class PickupController {
  @Get(':id')
  @ContractOperation('getPickupRequest')
  read(): unknown {
    behaviour.calls += 1;
    return {};
  }
}

@Module({ controllers: [PickupController] })
class PickupModule {}

function fixtureSource(): ContractSource & { loads: number } {
  const source = {
    loads: 0,
    load: (): JsonObject => {
      source.loads += 1;
      return FIXTURE_CONTRACT;
    },
  };
  return source;
}

let running: TestApp | undefined;

afterEach(async () => {
  await running?.stop();
  running = undefined;
  behaviour.calls = 0;
  behaviour.widget = undefined;
});

async function start(options: Parameters<typeof startTestApp>[0] = {}): Promise<TestApp> {
  running = await startTestApp(options);
  return running;
}

const post = (app: TestApp, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${app.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

describe('a request that breaks the contract', () => {
  // Break caught: a handler running on input the contract forbids. The refusal is the contract's own
  // VALIDATION_FAILED, and the handler is never called.
  it('is refused with VALIDATION_FAILED, naming each violation, before the handler runs', async () => {
    const source = fixtureSource();
    const app = await start({
      rootModule: appWith(ValidatedWidgetsModule),
      contractSource: source,
    });

    const response = await post(app, '/api/v1/widgets', { label: 5, price: 1 }, {});

    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.message).toBe('The request is not valid');
    expect(typeof body.request_id).toBe('string');
    expect(body.details).toEqual({
      violations: arrayContaining([
        { in: 'body', pointer: '/label', rule: 'type' },
        { in: 'body', pointer: '', rule: 'additionalProperties' },
        { in: 'header', pointer: 'idempotency-key', rule: 'required' },
      ]),
    });
    expect(behaviour.calls).toBe(0);
  });

  // Break caught: the answer repeating what the caller sent. The violation names a rule and a place from the
  // contract, never the value or an unknown property the caller chose.
  it('never repeats what the caller sent', async () => {
    const app = await start({
      rootModule: appWith(ValidatedWidgetsModule),
      contractSource: fixtureSource(),
    });

    const response = await post(
      app,
      `/api/v1/widgets?dry_run=${CANARY}`,
      { label: CANARY, [CANARY]: CANARY },
      { 'idempotency-key': 'k' },
    );

    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(CANARY);
  });

  it('is refused for a path parameter that is not the format the contract says', async () => {
    const app = await start({
      rootModule: appWith(ValidatedWidgetsModule),
      contractSource: fixtureSource(),
    });

    const response = await fetch(`${app.baseUrl}/api/v1/widgets/not-a-uuid`);

    expect(response.status).toBe(400);
    expect(((await response.json()) as { details: unknown }).details).toEqual({
      violations: [{ in: 'path', pointer: 'id', rule: 'format' }],
    });
    expect(behaviour.calls).toBe(0);
  });

  // Break caught: a body that is not JSON at all reaching the check as something it can pass.
  it('is refused when the body is not valid JSON', async () => {
    const app = await start({
      rootModule: appWith(ValidatedWidgetsModule),
      contractSource: fixtureSource(),
    });

    const response = await fetch(`${app.baseUrl}/api/v1/widgets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'k' },
      body: '{"label":',
    });

    expect(response.status).toBe(400);
    expect(behaviour.calls).toBe(0);
  });

  // Break caught: a request with no body at all counted as carrying one. It would then be judged as a value
  // (undefined) and fail on its type, so the caller is told the body is the wrong type when it is missing.
  it('is refused as missing its body, not as a body of the wrong type, when none is sent', async () => {
    const app = await start({
      rootModule: appWith(ValidatedWidgetsModule),
      contractSource: fixtureSource(),
    });

    const response = await fetch(`${app.baseUrl}/api/v1/widgets`, {
      method: 'POST',
      headers: { 'idempotency-key': 'k' },
    });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { details: unknown }).details).toEqual({
      violations: [{ in: 'body', pointer: '', rule: 'required' }],
    });
    expect(behaviour.calls).toBe(0);
  });
});

describe('a body that is empty but is not absent', () => {
  // Break caught: an empty chunked body counted as the object {}. The body parser answers {} for a JSON request
  // whose body is empty, and a request with chunked encoding has no length to say so, so a body-less request to an
  // operation that requires a body passed as an empty object, and a required body whose fields are all optional
  // passed as valid.
  it('is refused as missing its body when the request is chunked and has no bytes', async () => {
    const app = await start({
      rootModule: appWith(ValidatedWidgetsModule),
      contractSource: fixtureSource(),
    });

    const status = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = http.request(
        {
          host: '127.0.0.1',
          port: new URL(app.baseUrl).port,
          method: 'POST',
          path: '/api/v1/widgets',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': 'k',
            'transfer-encoding': 'chunked',
          },
        },
        (response) => {
          let body = '';
          response.on('data', (chunk: Buffer) => {
            body += chunk.toString();
          });
          response.on('end', () => {
            resolve({ status: response.statusCode ?? 0, body });
          });
        },
      );
      request.on('error', reject);
      request.end();
    });

    expect(status.status).toBe(400);
    expect((JSON.parse(status.body) as { details: unknown }).details).toEqual({
      violations: [{ in: 'body', pointer: '', rule: 'required' }],
    });
    expect(behaviour.calls).toBe(0);
  });

  // Break caught: the same rule refusing a chunked body that has bytes in it.
  it('accepts a chunked request that has a body', async () => {
    const app = await start({
      rootModule: appWith(ValidatedWidgetsModule),
      contractSource: fixtureSource(),
    });

    const response = await fetch(`${app.baseUrl}/api/v1/widgets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'k' },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"label":"Widget"}'));
          controller.close();
        },
      }),
      // Node's fetch needs this to send a stream body.
      duplex: 'half',
    });

    expect(response.status).toBe(201);
  });
});

describe('a request the contract accepts', () => {
  it("reaches the handler, and the answer is the handler's", async () => {
    const app = await start({
      rootModule: appWith(ValidatedWidgetsModule),
      contractSource: fixtureSource(),
    });

    const created = await post(
      app,
      '/api/v1/widgets?dry_run=true',
      { label: 'Widget' },
      { 'idempotency-key': 'k' },
    );
    const read = await fetch(`${app.baseUrl}/api/v1/widgets/${UUID}`);

    expect(created.status).toBe(201);
    expect(await created.json()).toEqual(GOOD_WIDGET);
    expect(read.status).toBe(200);
    expect(behaviour.calls).toBe(2);
  });

  // Break caught: a route nobody bound to an operation being validated, or refused. Only what is bound is checked.
  it('is not checked on a route that is not bound to an operation', async () => {
    const app = await start({
      rootModule: appWith(ValidatedWidgetsModule),
      contractSource: fixtureSource(),
    });

    const response = await post(app, '/api/v1/widgets/unbound', { anything: [1, 'two'] });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ echoed: { anything: [1, 'two'] } });
  });
});

describe('a response that breaks the contract', () => {
  // Break caught: a handler that returns something the contract does not describe, reaching a client that
  // trusts the contract. Outside production it is a failure, and the body is not sent.
  it('is replaced by a plain server error outside production, and is logged', async () => {
    behaviour.widget = { id: UUID, state: 'NOT_A_STATE', secret: CANARY };
    const app = await start({
      rootModule: appWith(ValidatedWidgetsModule),
      contractSource: fixtureSource(),
    });

    const response = await fetch(`${app.baseUrl}/api/v1/widgets/${UUID}`);

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      message: 'Internal server error',
      request_id: anyString,
    });
    expect(text).not.toContain(CANARY);
    const logged = app.logs.text();
    expect(logged).toContain('getWidget');
    expect(logged).toContain('/state');
    expect(logged).not.toContain(CANARY);
  });

  // Break caught: response checking being on in production, where it costs time on every answer and can turn
  // an answer that was merely different into an outage. Requests are still validated.
  it('is not checked in production, though requests still are', async () => {
    behaviour.widget = { id: UUID, state: 'NOT_A_STATE' };
    const app = await start({
      rootModule: appWith(ValidatedWidgetsModule),
      contractSource: fixtureSource(),
      config: { ...TEST_CONFIG, nodeEnv: 'production' },
    });

    const answer = await fetch(`${app.baseUrl}/api/v1/widgets/${UUID}`);
    const refused = await fetch(`${app.baseUrl}/api/v1/widgets/not-a-uuid`);

    expect(answer.status).toBe(200);
    expect(refused.status).toBe(400);
  });

  // Break caught: the status the answer will have being guessed wrongly, so a correct answer is judged as an
  // undeclared status. The status is what the router will send: @HttpCode if there is one, else 201 for a
  // POST. Each of the two rules is tested alone, on an operation that declares only the status it produces.
  it('is judged against the status the router will send', async () => {
    const app = await start({
      rootModule: appWith(StatusModule),
      contractSource: { load: () => STATUS_CONTRACT },
    });

    const byDefault = await post(app, '/api/v1/statuses/created', undefined);
    const byHttpCode = await post(app, '/api/v1/statuses/ok', undefined);

    expect(byDefault.status).toBe(201);
    expect(byHttpCode.status).toBe(200);
  });
});

const jsonResponse = (schema: object, description = 'OK'): object => ({
  description,
  content: { 'application/json': { schema } },
});

/** One operation with two successful outcomes, as staff sign-in has: signed in, or a second factor is needed. */
const OUTCOME_CONTRACT = {
  openapi: '3.1.0',
  paths: {
    '/dynamic/sign-in': {
      post: {
        operationId: 'dynamicSignIn',
        responses: {
          '200': jsonResponse({
            type: 'object',
            required: ['ok'],
            additionalProperties: false,
            properties: { ok: { type: 'boolean' } },
          }),
          '202': jsonResponse({
            type: 'object',
            required: ['challenge'],
            additionalProperties: false,
            properties: { challenge: { type: 'string' } },
          }),
        },
      },
    },
  },
} as unknown as JsonObject;

@Controller('dynamic')
@TechnicalEndpoint()
class OutcomeController {
  /** `@HttpCode(200)` names the usual outcome. The handler picks the real one, as the framework allows. */
  @Post('sign-in')
  @HttpCode(200)
  @ContractOperation('dynamicSignIn')
  signIn(
    @Query('outcome') outcome: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): unknown {
    if (outcome === 'challenge') {
      response.status(202);
      return { challenge: 'enter the code' };
    }
    if (outcome === 'challenge-with-signed-in-body') {
      response.status(202);
      return { ok: true };
    }
    if (outcome === 'signed-in-with-challenge-body') return { challenge: 'enter the code' };
    if (outcome === 'teapot') {
      response.status(418);
      return { ok: true };
    }
    return { ok: true };
  }
}

@Module({ controllers: [OutcomeController] })
class OutcomeModule {}

const startOutcome = (): Promise<TestApp> =>
  start({ rootModule: appWith(OutcomeModule), contractSource: { load: () => OUTCOME_CONTRACT } });

const signIn = (app: TestApp, outcome?: string) =>
  fetch(
    `${app.baseUrl}/api/v1/dynamic/sign-in${outcome === undefined ? '' : `?outcome=${outcome}`}`,
    {
      method: 'POST',
    },
  );

describe('the status a handler really sends (audit F04)', () => {
  // Break caught: the status taken from `@HttpCode` or the method, not from the response. A handler may choose
  // another with `@Res({ passthrough: true })`, and staff sign-in must: 200 when signed in, 202 when a second
  // factor is needed. The 202 was judged by the 200 schema and became a 500.
  it('judges a 202 chosen at run time by the 202 response, and a 200 by the 200 response', async () => {
    const app = await startOutcome();

    const challenged = await signIn(app, 'challenge');
    const signedIn = await signIn(app);

    expect(challenged.status).toBe(202);
    expect(await challenged.json()).toEqual({ challenge: 'enter the code' });
    expect(signedIn.status).toBe(200);
    expect(await signedIn.json()).toEqual({ ok: true });
  });

  // Break caught: the other half of the same defect. A 202 that carries the 200 body sailed through, because
  // it was judged as the 200 it was declared to be.
  it('refuses a 202 that carries the body of the 200, and a 200 that carries the body of the 202', async () => {
    const app = await startOutcome();

    const wrongBodyOn202 = await signIn(app, 'challenge-with-signed-in-body');
    const wrongBodyOn200 = await signIn(app, 'signed-in-with-challenge-body');

    for (const response of [wrongBodyOn202, wrongBodyOn200]) {
      expect(response.status).toBe(500);
      expect(JSON.parse(await response.text())).toEqual({
        message: 'Internal server error',
        request_id: anyString,
      });
    }
    const logged = app.logs.text();
    expect(logged).toContain('dynamicSignIn');
    expect(logged).toContain('/challenge');
  });

  // Break caught: a status the contract never lists for the operation reaching the client.
  it('refuses a status the operation does not declare, and says which', async () => {
    const app = await startOutcome();

    const response = await signIn(app, 'teapot');

    expect(response.status).toBe(500);
    expect(app.logs.text()).toContain('status 418 undeclared');
  });

  // Break caught: the status that was validated differing from the status that was sent, in either mode.
  it('validates exactly the status the client receives', async () => {
    const app = await startOutcome();
    const validator = app.app.get(ContractValidationService).validator();
    const validated = vi.spyOn(validator, 'validateResponse');

    const received = [await signIn(app, 'challenge'), await signIn(app)].map(
      (response) => response.status,
    );

    expect(validated.mock.calls.map(([, parts]) => parts.status)).toEqual(received);
    expect(received).toEqual([202, 200]);
  });
});

/** A handler that takes the response out of the framework's hands cannot be validated, so it cannot be bound. */
const BYPASS_CONTRACT = OUTCOME_CONTRACT;

@Controller('bypass')
@TechnicalEndpoint()
class DirectResponseController {
  @Post('res')
  @ContractOperation('dynamicSignIn')
  direct(@Res() response: Response): void {
    response.json({ ok: true });
  }
}

@Controller('bypass')
@TechnicalEndpoint()
class NextController {
  @Post('next')
  @ContractOperation('dynamicSignIn')
  forward(@Next() next: () => void): void {
    next();
  }
}

@Controller('bypass')
@TechnicalEndpoint()
class StreamController {
  @Sse('events')
  @ContractOperation('dynamicSignIn')
  events(): Observable<{ data: unknown }> {
    return of({ data: { ok: true } });
  }
}

@Controller('bypass')
@TechnicalEndpoint()
class RedirectController {
  @Post('go')
  @Redirect('/elsewhere')
  @ContractOperation('dynamicSignIn')
  go(): void {
    return undefined;
  }
}

@Controller('bypass')
@TechnicalEndpoint()
class RenderController {
  @Post('page')
  @Render('page')
  @ContractOperation('dynamicSignIn')
  page(): unknown {
    return { ok: true };
  }
}

/** Takes the response over while it is not bound: not the validator's business. */
@Controller('bypass')
@TechnicalEndpoint()
class UnboundDirectController {
  @Post('free')
  free(@Res() response: Response): void {
    response.json({ free: true });
  }
}

/** Binds an operation and writes the answer itself from a passthrough handler, which the decorators cannot see. */
@Controller('bypass')
@TechnicalEndpoint()
class SelfSentController {
  @Post('self-sent')
  @HttpCode(200)
  @ContractOperation('dynamicSignIn')
  selfSent(@Res({ passthrough: true }) response: Response): void {
    response.status(200).json({ ok: true });
  }
}

describe('a handler that takes the response over (audit F04)', () => {
  const rejects = (controller: Type<unknown>) => {
    @Module({ controllers: [controller] })
    class BypassModule {}
    return start({
      rootModule: appWith(BypassModule),
      contractSource: { load: () => BYPASS_CONTRACT },
    });
  };

  // Break caught: a bound handler that sends its own answer, forwards to another handler, streams, redirects
  // or renders. The validator never sees what such a handler sends, so a binding to it validates nothing; the
  // application refuses to start, naming the operation and the reason.
  it.each([
    [
      '@Res() without passthrough',
      DirectResponseController,
      /POST \/api\/v1\/bypass\/res\): @Res\(\)/,
    ],
    ['@Next()', NextController, /POST \/api\/v1\/bypass\/next\): @Next\(\)/],
    ['@Sse()', StreamController, /GET \/api\/v1\/bypass\/events\): @Sse\(\)/],
    ['@Redirect()', RedirectController, /POST \/api\/v1\/bypass\/go\): @Redirect\(\)/],
    ['@Render()', RenderController, /POST \/api\/v1\/bypass\/page\): @Render\(\)/],
  ])('makes the application refuse to start for %s', async (_label, controller, where) => {
    await expect(rejects(controller)).rejects.toThrow(
      /Handlers bound to an operation must leave the response to the framework/,
    );
    await expect(rejects(controller)).rejects.toThrow(/dynamicSignIn/);
    await expect(rejects(controller)).rejects.toThrow(where);
  });

  // Break caught: the new rule reaching handlers it has no business with.
  it('leaves a handler that is not bound free to send its own answer', async () => {
    const app = await rejects(UnboundDirectController);

    const response = await fetch(`${app.baseUrl}/api/v1/bypass/free`, { method: 'POST' });

    expect(await response.json()).toEqual({ free: true });
  });

  // Break caught: a passthrough handler that sends the answer itself, which the decorators allow and cannot
  // show. Outside production the validator sees that the answer left before it could look at it, and says so.
  it('reports an answer the handler sent itself, which could not be validated', async () => {
    const app = await rejects(SelfSentController);

    const response = await fetch(`${app.baseUrl}/api/v1/bypass/self-sent`, { method: 'POST' });

    expect(await response.json()).toEqual({ ok: true });
    expect(app.logs.text()).toContain('sent-by-handler');
    expect(app.logs.text()).toContain('dynamicSignIn');
  });
});

/** Dictionaries, whose keys are the caller's. */
const LABELS_CONTRACT = {
  openapi: '3.1.0',
  paths: {
    '/labels': {
      post: {
        operationId: 'putLabels',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['labels'],
                properties: {
                  labels: { type: 'object', additionalProperties: { type: 'integer' } },
                },
              },
            },
          },
        },
        responses: {
          '200': jsonResponse({
            type: 'object',
            properties: { labels: { type: 'object', additionalProperties: { type: 'integer' } } },
          }),
        },
      },
    },
  },
} as unknown as JsonObject;

let labelsAnswer: unknown;

@Controller('labels')
@TechnicalEndpoint()
class LabelsController {
  @Post()
  @HttpCode(200)
  @ContractOperation('putLabels')
  put(): unknown {
    behaviour.calls += 1;
    return labelsAnswer;
  }
}

@Module({ controllers: [LabelsController] })
class LabelsModule {}

describe('a dictionary key never comes back (audit F05)', () => {
  const FAKE_KEY = 'FAKE-PRIVATE-CANARY';
  const startLabels = (): Promise<TestApp> =>
    start({ rootModule: appWith(LabelsModule), contractSource: { load: () => LABELS_CONTRACT } });

  // Break caught: the key being echoed in a 400. The old rule trusted any key made of letters, digits, `_`,
  // `.` and `-`, and this one is made of nothing else.
  it('is not in the refusal of a request, which still says where', async () => {
    const app = await startLabels();

    const response = await post(app, '/api/v1/labels', {
      labels: { [FAKE_KEY]: 'not-an-integer' },
    });

    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).not.toContain(FAKE_KEY);
    expect(JSON.parse(text)).toMatchObject({
      details: { violations: [{ in: 'body', pointer: '/labels/*', rule: 'type' }] },
    });
    expect(behaviour.calls).toBe(0);
  });

  // Break caught: the key reaching the log through the message of the response violation, which is written
  // out whole, outside production.
  it('is not in the plain error of a response, or in the log, which still names the place', async () => {
    labelsAnswer = { labels: { [FAKE_KEY]: 'not-an-integer' } };
    const app = await startLabels();

    const response = await post(app, '/api/v1/labels', { labels: { fine: 1 } });

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(FAKE_KEY);
    const logged = app.logs.text();
    expect(logged).not.toContain(FAKE_KEY);
    expect(logged).toContain('putLabels');
    expect(logged).toContain('/labels/*');
  });
});

/** Cookies as the real contract declares them: attributes once at the root, the cookies a response sets per response. */
const SESSION_CONTRACT = {
  openapi: '3.1.0',
  'x-cookies': {
    melarc_session: {
      attributes: 'HttpOnly; Secure; SameSite=Lax; Path=/',
      host_only: true,
      read_by_javascript: false,
    },
    melarc_csrf: {
      attributes: 'Secure; SameSite=Lax; Path=/',
      host_only: true,
      read_by_javascript: true,
    },
    melarc_vendor_device: {
      attributes: 'HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=34560000',
      host_only: true,
      read_by_javascript: false,
    },
  },
  components: {
    securitySchemes: {
      browserSession: { type: 'apiKey', in: 'cookie', name: 'melarc_session' },
      riderSession: { type: 'http', scheme: 'bearer' },
    },
  },
  paths: {
    '/session': {
      delete: {
        operationId: 'closeSession',
        responses: {
          // Cookies are cleared for a browser caller and not for a Rider's bearer one.
          '204': {
            description: 'Signed out',
            'x-set-cookies': ['melarc_session', 'melarc_csrf'],
            'x-set-cookies-for': 'browserSession',
            headers: { 'Set-Cookie': { schema: { type: 'string' } } },
          },
        },
      },
      post: {
        operationId: 'openSession',
        responses: {
          '200': {
            ...jsonResponse({
              type: 'object',
              required: ['ok'],
              properties: { ok: { type: 'boolean' } },
            }),
            'x-set-cookies': ['melarc_session', 'melarc_csrf'],
            headers: { 'Set-Cookie': { schema: { type: 'string' } } },
          },
          '202': jsonResponse({
            type: 'object',
            required: ['challenge'],
            properties: { challenge: { type: 'string' } },
          }),
        },
      },
    },
    '/recovery': {
      post: {
        operationId: 'completeRecovery',
        responses: {
          // One answer, two principals: a vendor's browser is given its device credential and a staff member's is not.
          '204': {
            description: 'Credential set',
            'x-set-cookies': ['melarc_vendor_device'],
            'x-set-cookies-when': { principal_type: 'VENDOR' },
            headers: { 'Set-Cookie': { schema: { type: 'string' } } },
          },
        },
      },
    },
    '/preferences': {
      get: {
        operationId: 'readPreferences',
        parameters: [
          {
            name: 'melarc_theme',
            in: 'cookie',
            required: true,
            schema: { type: 'string', enum: ['light', 'dark'] },
          },
        ],
        responses: { '200': { description: 'OK' } },
      },
    },
  },
} as unknown as JsonObject;

@Controller()
@TechnicalEndpoint()
class SessionController {
  /** Opens a session the way the identity slice will: cookies set through the framework's response. */
  @Post('session')
  @HttpCode(200)
  @ContractOperation('openSession')
  open(
    @Query('mode') mode: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): unknown {
    if (mode === 'challenge') {
      // A second factor is still needed, and the answer says so. It must not establish a session.
      response.status(202).cookie('melarc_session', 'SESSION-VALUE-CANARY', {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
      });
      return { challenge: 'enter the code' };
    }
    const session = { secure: true, sameSite: 'lax' as const, httpOnly: mode !== 'weak' };
    response.cookie('melarc_session', 'SESSION-VALUE-CANARY', session);
    response.cookie('melarc_csrf', 'CSRF-VALUE-CANARY', { secure: true, sameSite: 'lax' });
    return { ok: true };
  }

  /** Closes a session the way the identity slice will: the cookies are expired only when `mode=clear`. */
  @Delete('session')
  @HttpCode(204)
  @ContractOperation('closeSession')
  close(
    @Query('mode') mode: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): void {
    if (mode !== 'clear') return;
    response.clearCookie('melarc_session', {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
    });
    response.clearCookie('melarc_csrf', { path: '/', secure: true, sameSite: 'lax' });
  }

  /**
   * Completes a recovery the way the identity slice will: the answer says whose it is (`as`), and the device cookie
   * is set only when `cookie=set`, the way a handler that is right or wrong about the branch would.
   */
  @Post('recovery')
  @HttpCode(204)
  @ContractOperation('completeRecovery')
  recover(
    @Query('as') as: string | undefined,
    @Query('cookie') cookie: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): void {
    if (as !== undefined) declareAnswerPrincipal(request, as);
    if (cookie === 'set') {
      response.cookie('melarc_vendor_device', 'DEVICE-VALUE-CANARY', {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 34_560_000_000,
      });
    }
  }

  @Get('preferences')
  @ContractOperation('readPreferences')
  read(): unknown {
    behaviour.calls += 1;
    return undefined;
  }
}

@Module({ controllers: [SessionController] })
class SessionModule {}

describe('headers and cookies, over real HTTP (audit F04)', () => {
  const startSession = (): Promise<TestApp> =>
    start({ rootModule: appWith(SessionModule), contractSource: { load: () => SESSION_CONTRACT } });
  const open = (app: TestApp, mode?: string) =>
    fetch(`${app.baseUrl}/api/v1/session${mode === undefined ? '' : `?mode=${mode}`}`, {
      method: 'POST',
    });

  it('lets a sign-in set exactly its declared cookies, as declared', async () => {
    const app = await startSession();

    const response = await open(app);

    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toHaveLength(2);
  });

  // Break caught: the answer that says a second factor is needed (202) establishing a session. The cookie is
  // not declared on that response, so the answer is a defect, whatever the framework allowed the handler to do.
  it('refuses a session cookie on the answer that asks for a second factor, naming the cookie and not its value', async () => {
    const app = await startSession();

    const response = await open(app, 'challenge');

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('CANARY');
    const logged = app.logs.text();
    expect(logged).toContain('response-cookie melarc_session undeclared');
    expect(logged).not.toContain('CANARY');
  });

  // Break caught: a session cookie a script on the page can read. Its attributes are the contract's to state.
  it('refuses a session cookie that is not HttpOnly', async () => {
    const app = await startSession();

    const response = await open(app, 'weak');

    expect(response.status).toBe(500);
    expect(app.logs.text()).toContain('response-cookie melarc_session httponly');
  });

  // Break caught (sign-out): the cookies a response owes being decided without looking at how the caller
  // authenticated. A browser sign-out must expire the cookies; a bearer sign-out must set none. The request's own
  // credentials reach the validator from the interceptor, and the handler never says which kind of caller it had.
  describe('a sign-out whose cookies depend on the credential the caller presented', () => {
    const BROWSER = { cookie: 'melarc_session=S; melarc_csrf=C' };
    const RIDER = { authorization: 'Bearer R' };
    const close = (app: TestApp, headers: Record<string, string>, mode?: string) =>
      fetch(`${app.baseUrl}/api/v1/session${mode === undefined ? '' : `?mode=${mode}`}`, {
        method: 'DELETE',
        headers,
      });

    it('lets a browser sign-out expire the cookies, and a bearer sign-out set none', async () => {
      const app = await startSession();

      const browser = await close(app, BROWSER, 'clear');
      const rider = await close(app, RIDER);

      expect(browser.status).toBe(204);
      expect(browser.headers.getSetCookie()).toHaveLength(2);
      expect(rider.status).toBe(204);
      expect(rider.headers.getSetCookie()).toEqual([]);
    });

    it('refuses a browser sign-out that leaves the cookies in place', async () => {
      const app = await startSession();

      const response = await close(app, BROWSER);

      expect(response.status).toBe(500);
      const logged = app.logs.text();
      expect(logged).toContain('response-cookie melarc_session required');
      expect(logged).toContain('response-cookie melarc_csrf required');
    });

    it('refuses a bearer sign-out that sets cookies', async () => {
      const app = await startSession();

      const response = await close(app, RIDER, 'clear');

      expect(response.status).toBe(500);
      expect(app.logs.text()).toContain('response-cookie melarc_session undeclared');
    });
  });

  // Break caught (recovery): the cookies a response owes being decided without knowing whose answer it is. A
  // vendor recovery must give the browser its device credential and a staff recovery must set none, and the
  // handler, not the request, knows which it did.
  describe('a recovery whose cookies depend on whose answer it is', () => {
    const complete = (app: TestApp, query: string) =>
      fetch(`${app.baseUrl}/api/v1/recovery?${query}`, { method: 'POST' });

    it('lets a vendor recovery set the device credential, and a staff recovery set none', async () => {
      const app = await startSession();

      const vendor = await complete(app, 'as=VENDOR&cookie=set');
      const staff = await complete(app, 'as=STAFF');

      expect(vendor.status).toBe(204);
      expect(vendor.headers.getSetCookie()).toHaveLength(1);
      expect(staff.status).toBe(204);
      expect(staff.headers.getSetCookie()).toEqual([]);
    });

    it('refuses a vendor recovery that leaves the browser without the credential', async () => {
      const app = await startSession();

      const response = await complete(app, 'as=VENDOR');

      expect(response.status).toBe(500);
      expect(app.logs.text()).toContain('response-cookie melarc_vendor_device required');
    });

    it('refuses a staff recovery that sets a vendor’s credential, never printing its value', async () => {
      const app = await startSession();

      const response = await complete(app, 'as=STAFF&cookie=set');

      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain('CANARY');
      const logged = app.logs.text();
      expect(logged).toContain('response-cookie melarc_vendor_device undeclared');
      expect(logged).not.toContain('CANARY');
    });

    // Break caught: a handler that does not say whose answer it is being let through, which would turn the rule off
    // for exactly the handler that forgot.
    it('refuses an answer that does not say whose it is, naming the condition', async () => {
      const app = await startSession();

      const response = await complete(app, 'cookie=set');

      expect(response.status).toBe(500);
      expect(app.logs.text()).toContain('x-set-cookies-when');
    });

    // Break caught: the principal one request declared being seen by the next, so that a vendor answer is judged
    // as the staff answer before it.
    it('judges each answer by its own principal', async () => {
      const app = await startSession();

      const first = await complete(app, 'as=STAFF');
      const second = await complete(app, 'as=VENDOR&cookie=set');
      const third = await complete(app, 'as=STAFF');

      expect([first.status, second.status, third.status]).toEqual([204, 204, 204]);
    });
  });

  // Break caught: a cookie parameter the operation declares being skipped, so a request without it reaches the
  // handler. (Whether the cookie is a valid session is the guard's to decide, not this check's.)
  it('refuses a request without a cookie the operation declares', async () => {
    const app = await startSession();

    const missing = await fetch(`${app.baseUrl}/api/v1/preferences`);
    const present = await fetch(`${app.baseUrl}/api/v1/preferences`, {
      headers: { cookie: 'melarc_theme=dark' },
    });

    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { details: unknown }).details).toEqual({
      violations: [{ in: 'cookie', pointer: 'melarc_theme', rule: 'required' }],
    });
    expect(present.status).toBe(200);
    expect(behaviour.calls).toBe(1);
  });
});

describe('the contract is read only when something is bound to it', () => {
  // Break caught: every start paying for a 700 KB parse of a document nothing uses. With no bound operation,
  // which is today's application, the contract is never read.
  it('is not loaded at all when no operation is bound', async () => {
    const source = fixtureSource();

    await start({ contractSource: source });

    expect(source.loads).toBe(0);
  });

  it('is loaded once, however many requests there are', async () => {
    const source = fixtureSource();
    const app = await start({
      rootModule: appWith(ValidatedWidgetsModule),
      contractSource: source,
    });

    for (let index = 0; index < 3; index += 1) await fetch(`${app.baseUrl}/api/v1/widgets/${UUID}`);

    expect(source.loads).toBe(1);
  });

  // Break caught: an operation bound by a mistyped id, which would otherwise validate nothing, forever. The
  // application refuses to start, naming the operation.
  it('makes the application refuse to start when a bound operation is not in the contract', async () => {
    await expect(
      start({ rootModule: appWith(GhostModule), contractSource: fixtureSource() }),
    ).rejects.toThrow(
      'bound to operations that are not in the contract:\n  thisOperationIsNotInTheContract (GET /api/v1/ghosts)',
    );
  });

  it('describes a bound operation under the id it is bound to', async () => {
    const app = await start({
      rootModule: appWith(ValidatedWidgetsModule),
      contractSource: fixtureSource(),
    });

    const document = buildOpenApiDocument(app.app);
    const ids = Object.values(document.paths).flatMap((item) =>
      Object.values(item).map((operation) => (operation as { operationId?: string }).operationId),
    );

    expect(ids).toEqual(expect.arrayContaining(['getWidget', 'createWidget']));
  });
});

describe('the real contract, with the default wiring', () => {
  // Break caught: the shipped wiring not reading contracts/openapi.yaml. With no source given, a bound real
  // operation is validated against the real file.
  it('validates a bound real operation against contracts/openapi.yaml', async () => {
    const app = await start({ rootModule: appWith(PickupModule) });

    const refused = await fetch(`${app.baseUrl}/api/v1/pickup-requests/not-a-uuid`);

    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { details: unknown }).details).toEqual({
      violations: [{ in: 'path', pointer: 'id', rule: 'format' }],
    });
    expect(behaviour.calls).toBe(0);
  });
});
