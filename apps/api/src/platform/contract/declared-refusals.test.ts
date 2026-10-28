import { Controller, Get, Module } from '@nestjs/common';
import { afterEach, describe, expect, it } from 'vitest';

import { appWith, startTestApp, type TestApp } from '../../test-support/test-app.js';
import { ApiException } from '../http/api-exception.js';
import { ErrorCode } from '../http/error-codes.js';
import { TechnicalEndpoint } from '../routes/access-declaration.js';
import { ContractOperation } from './contract-operation.js';
import { fileContractSource } from './contract-source.js';
import { AWAITING_DECLARATION, refusalCheckOf } from './declared-refusals.js';
import type { JsonObject } from './json.js';

/** A request as the filter sees it once Express has routed it. */
const routed = (method: string, path: string) => ({ method, route: { path } });

const ERROR = {
  content: { 'application/json': { schema: { type: 'object' } } },
  description: 'Refused',
};

/** Three operations: one addressed by an identifier, one that is not, and one that states no list (as a test's fixture does). */
const CONTRACT: JsonObject = {
  openapi: '3.1.0',
  info: { title: 'Refusals', version: '1' },
  servers: [{ url: '/api/v1' }],
  security: [],
  paths: {
    '/gadgets/{id}': {
      get: {
        operationId: 'getGadget',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        'x-error-codes': ['STATE_CONFLICT'],
        responses: { '200': { description: 'OK' }, '409': ERROR },
      },
    },
    '/gadgets': {
      get: {
        operationId: 'listGadgets',
        'x-error-codes': ['VALIDATION_FAILED'],
        responses: { '200': { description: 'OK' }, '400': ERROR },
      },
    },
    '/plain': { get: { operationId: 'plain', responses: { '200': { description: 'OK' } } } },
  },
};

const thrown: { code: ErrorCode } = { code: ErrorCode.StateConflict };

@Controller()
@TechnicalEndpoint()
class GadgetsController {
  @Get('gadgets/:id')
  @ContractOperation('getGadget')
  read(): never {
    throw ApiException.of(thrown.code, 'refused');
  }

  @Get('gadgets')
  @ContractOperation('listGadgets')
  list(): never {
    throw ApiException.of(thrown.code, 'refused');
  }

  @Get('plain')
  @ContractOperation('plain')
  plain(): never {
    throw ApiException.of(thrown.code, 'refused');
  }
}

@Module({ controllers: [GadgetsController] })
class GadgetsModule {}

describe('the contract a refusal is held to (S0.67; AC-SLICE-000-131, "every refusal the tests provoke")', () => {
  const check = refusalCheckOf(
    {
      errorCodesOf: (operationId) =>
        ({ getGadget: ['STATE_CONFLICT'], listGadgets: ['VALIDATION_FAILED'] })[operationId],
    },
    [
      { operationId: 'getGadget', method: 'GET', path: '/api/v1/gadgets/:id' },
      { operationId: 'listGadgets', method: 'GET', path: '/api/v1/gadgets' },
      { operationId: 'plain', method: 'GET', path: '/api/v1/plain' },
    ],
  );
  const refusal = (code: ErrorCode) => ApiException.of(code, 'refused');

  // Break caught: an operation answering a code its contract does not list, which no response check saw because refusals leave
  // through the exception filter and not through the validation interceptor.
  it('finds a code the operation does not list, and admits one it does', () => {
    expect(
      check.undeclared(routed('GET', '/api/v1/gadgets'), refusal(ErrorCode.StateConflict)),
    ).toEqual({
      operationId: 'listGadgets',
      code: 'STATE_CONFLICT',
    });
    expect(
      check.undeclared(routed('GET', '/api/v1/gadgets'), refusal(ErrorCode.ValidationFailed)),
    ).toBeUndefined();
  });

  // Break caught: the two contract-wide rules of errors-and-enums.md section 4 read as violations, or read too widely.
  it('admits SESSION_SUPERSEDED everywhere and NOT_FOUND only where the operation is addressed by an identifier', () => {
    expect(
      check.undeclared(routed('GET', '/api/v1/gadgets'), refusal(ErrorCode.SessionSuperseded)),
    ).toBeUndefined();
    expect(
      check.undeclared(routed('GET', '/api/v1/gadgets/:id'), refusal(ErrorCode.NotFound)),
    ).toBeUndefined();
    expect(check.undeclared(routed('GET', '/api/v1/gadgets'), refusal(ErrorCode.NotFound))).toEqual(
      {
        operationId: 'listGadgets',
        code: 'NOT_FOUND',
      },
    );
  });

  it('judges nothing it cannot place: an operation with no list, an unrouted request, another method, a failure with no code', () => {
    expect(
      check.undeclared(routed('GET', '/api/v1/plain'), refusal(ErrorCode.StateConflict)),
    ).toBeUndefined();
    expect(
      check.undeclared({ method: 'GET', route: undefined }, refusal(ErrorCode.StateConflict)),
    ).toBeUndefined();
    expect(
      check.undeclared(routed('POST', '/api/v1/gadgets'), refusal(ErrorCode.StateConflict)),
    ).toBeUndefined();
    expect(
      check.undeclared(routed('GET', '/api/v1/gadgets'), new Error('a database outage')),
    ).toBeUndefined();
  });

  // Break caught: an omission admitted for good after the contract was corrected, or one admitted for an operation that is not there.
  it('admits only omissions the contract still has, each of an operation it holds', () => {
    const contract = fileContractSource.load();
    const listed = new Map<string, readonly unknown[]>();
    for (const item of Object.values(contract.paths as Record<string, Record<string, unknown>>)) {
      for (const operation of Object.values(item)) {
        const { operationId, 'x-error-codes': codes } = (operation ?? {}) as Record<
          string,
          unknown
        >;
        if (typeof operationId === 'string' && Array.isArray(codes)) listed.set(operationId, codes);
      }
    }
    for (const [operationId, codes] of Object.entries(AWAITING_DECLARATION)) {
      expect(listed.has(operationId), operationId).toBe(true);
      for (const code of codes)
        expect(listed.get(operationId), `${operationId} ${code}`).not.toContain(code);
    }
    expect(Object.values(AWAITING_DECLARATION).flat()).toHaveLength(3);
  });

  // Break caught: an operation of the product's contract escaping the check by stating no list.
  it('has a list on every operation of the product contract', () => {
    const contract = fileContractSource.load();
    const unlisted: string[] = [];
    for (const item of Object.values(contract.paths as Record<string, Record<string, unknown>>)) {
      for (const operation of Object.values(item)) {
        const { operationId, 'x-error-codes': listed } = (operation ?? {}) as Record<
          string,
          unknown
        >;
        if (typeof operationId === 'string' && !Array.isArray(listed)) unlisted.push(operationId);
      }
    }
    expect(unlisted).toEqual([]);
  });
});

describe('an application that answers a refusal its contract does not list', () => {
  let running: TestApp | undefined;
  afterEach(async () => {
    await running?.stop();
    running = undefined;
  });

  // Break caught: the check built and never asked, or asked and ignored: the client still receives the undeclared code.
  it('answers the plain server error, says which operation and code in the log, and answers a listed code as it is', async () => {
    running = await startTestApp({
      rootModule: appWith(GadgetsModule),
      contractSource: { load: () => CONTRACT },
    });

    thrown.code = ErrorCode.StateConflict;
    const undeclared = await fetch(`${running.baseUrl}/api/v1/gadgets`);
    expect(undeclared.status).toBe(500);
    expect(await undeclared.json()).toEqual({
      message: 'Internal server error',
      request_id: expect.any(String) as unknown,
    });
    expect(running.logs.text()).toContain('"operationId":"listGadgets"');
    expect(running.logs.text()).toContain('"code":"STATE_CONFLICT"');

    const listed = await fetch(`${running.baseUrl}/api/v1/gadgets/0190d7c2`);
    expect(listed.status).toBe(409);
    expect(((await listed.json()) as { code?: string }).code).toBe('STATE_CONFLICT');

    const unjudged = await fetch(`${running.baseUrl}/api/v1/plain`);
    expect(unjudged.status).toBe(409);
  });
});
