import { readFileSync } from 'node:fs';

import { ModulesContainer } from '@nestjs/core';
import type { OpenAPIObject } from '@nestjs/swagger';
import { parse } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { JsonEditor } from '../../test-support/json-edit.js';
import { startTestApp, type TestApp } from '../../test-support/test-app.js';
import { takesSession } from '../../test-support/takes-session.js';
import { listBoundOperations } from '../contract/contract-operation.js';
import { isJsonObject, type JsonObject } from '../contract/json.js';
import { locateContract } from '../contract/locate-contract.js';
import { buildOpenApiDocument } from '../openapi/build-openapi-document.js';
import { operationsOf } from '../openapi/operation-statements.js';
import { needsSession } from './access-declaration.js';
import { listDeclaredRoutes } from './route-inventory.js';

/**
 * The 429 of the authenticated limiter is declared on every operation it covers (A2 of the audit, 7 November 2026; `AC-SLICE-000-131`;
 * errors-and-enums.md section 4). The authentication guard counts every request of a route that needs a session in the session's one bucket
 * (`rate_limit_authenticated_api`) and refuses the one past the limit with `429 RATE_LIMITED` and a `Retry-After`; an operation that
 * leaves the response out of the contract is one a client cannot be told to expect it from, and in a development or test run is turned into
 * a defect `500` by `declared-refusals.ts`.
 *
 * **The covered set is derived from the real application, and never listed here**: the route inventory (`listDeclaredRoutes`) says how
 * each served route is reached, `needsSession` is the one question the guard itself asks of that answer, and `listBoundOperations` names the
 * operation of each route. A new operation that needs a session joins the set by being written, and this test then requires of it, in three places:
 *
 * - **the contract** declares `'429': { $ref: '#/components/responses/RateLimited' }` (the shared response for a session, whose `Retry-After` is the
 *   contract's `RetryAfter`) and `RATE_LIMITED` in its `x-error-codes`;
 * - **the application's own description** states the same, with the header (`platform/openapi/rate-limit-statement.ts`), which
 *   `pnpm run contract:check` compares with the contract;
 * - **the contract's reading of which operations take a session** (`takesSession`, from `security`) agrees with the access declaration of
 *   every operation the application serves, so the operations the contract lists and the application does not serve yet are held to the
 *   same rule by the contract's own check (`contract-consistency.test.ts`, section g).
 */

let running: TestApp | undefined;

beforeAll(async () => {
  running = await startTestApp();
});

afterAll(async () => {
  await running?.stop();
});

const CONTRACT = parse(readFileSync(locateContract(import.meta.dirname), 'utf8')) as JsonObject;
const SHARED = '#/components/responses/RateLimited';
const METHODS = ['get', 'put', 'post', 'patch', 'delete'] as const;

interface Served {
  readonly operationId: string;
  /** Whether the route needs a session, as its access declaration says. */
  readonly covered: boolean;
}

/** Every operation the running application serves, with how its route is reached. */
function served(): Served[] {
  if (running === undefined) throw new Error('the application did not start');
  const bound = listBoundOperations(running.app.get(ModulesContainer, { strict: false }));
  return listDeclaredRoutes(running.app).flatMap((route) => {
    const operation = bound.find(
      (each) => each.method === route.method && each.path === route.path,
    );
    return operation === undefined
      ? []
      : [{ operationId: operation.operationId, covered: needsSession(route.access) }];
  });
}

const coveredOperations = (): string[] =>
  served()
    .filter((each) => each.covered)
    .map((each) => each.operationId)
    .toSorted();

/** Where an operation is in the contract: `['paths', path, method]`. */
function pathOf(operationId: string): readonly string[] {
  if (isJsonObject(CONTRACT.paths)) {
    for (const [path, item] of Object.entries(CONTRACT.paths)) {
      if (!isJsonObject(item)) continue;
      for (const method of METHODS) {
        const operation = item[method];
        if (isJsonObject(operation) && operation.operationId === operationId) {
          return ['paths', path, method];
        }
      }
    }
  }
  throw new Error(`The contract has no operation ${operationId}`);
}

/** The operations of a contract by `operationId`. */
function contractOperations(contract: JsonObject): Map<string, JsonObject> {
  const found = new Map<string, JsonObject>();
  if (!isJsonObject(contract.paths)) return found;
  for (const item of Object.values(contract.paths)) {
    if (!isJsonObject(item)) continue;
    for (const method of METHODS) {
      const operation = item[method];
      if (isJsonObject(operation) && typeof operation.operationId === 'string') {
        found.set(operation.operationId, operation);
      }
    }
  }
  return found;
}

const codesOf = (operation: Record<string, unknown>): readonly unknown[] =>
  Array.isArray(operation['x-error-codes']) ? (operation['x-error-codes'] as unknown[]) : [];

/** What the contract fails to say of the operations the limiter covers. */
function contractProblems(contract: JsonObject, covered: readonly string[]): string[] {
  const operations = contractOperations(contract);
  const problems: string[] = [];
  for (const id of covered) {
    const operation = operations.get(id);
    if (operation === undefined) {
      problems.push(`${id} is served and the contract has no such operation`);
      continue;
    }
    const answer = isJsonObject(operation.responses) ? operation.responses['429'] : undefined;
    if (!isJsonObject(answer) || answer.$ref !== SHARED) {
      problems.push(`${id} does not answer 429 with the shared RateLimited response`);
    }
    if (!codesOf(operation).includes('RATE_LIMITED')) {
      problems.push(`${id} does not list RATE_LIMITED in its x-error-codes`);
    }
  }
  return problems;
}

/** What the application's own description fails to say of the operations the limiter covers. */
function descriptionProblems(document: OpenAPIObject, covered: readonly string[]): string[] {
  const operations = operationsOf(document);
  const problems: string[] = [];
  for (const id of covered) {
    const operation = operations.get(id);
    if (operation === undefined) {
      problems.push(`${id} is served and the application does not describe it`);
      continue;
    }
    const responses = (operation.responses ?? {}) as Record<string, { headers?: object }>;
    const headers = responses['429']?.headers as Record<string, unknown> | undefined;
    if (headers === undefined || !('Retry-After' in headers)) {
      problems.push(`${id} is described without a 429 that carries Retry-After`);
    }
    if (!codesOf(operation).includes('RATE_LIMITED')) {
      problems.push(`${id} is described without RATE_LIMITED in its x-error-codes`);
    }
  }
  return problems;
}

describe('the authenticated limiter’s 429 is declared on every operation it covers (AC-SLICE-000-131)', () => {
  // Break caught: a covered set that is empty or tiny because the route inventory read nothing, which would make every check below pass for having
  // checked nothing; and an operation served by a route of no known kind.
  it('derives a large covered set from the running application, and nothing outside the four kinds of route', () => {
    const every = served();

    expect(every.length).toBeGreaterThan(60);
    expect(coveredOperations().length).toBeGreaterThan(40);
    expect(coveredOperations().length).toBeLessThan(every.length);
  });

  // Break caught: a new operation that needs a session and leaves the 429 out of the contract (or points it at the response that carries no
  // wait). It is read from the application, so a new operation cannot be left off a list.
  it('has the shared RateLimited response and RATE_LIMITED in the contract, for each', () => {
    expect(contractProblems(CONTRACT, coveredOperations())).toEqual([]);
  });

  // Break caught: the limiter's 429 left out of what the application says of itself, so that the conformance check has nothing to compare
  // with the contract, and a new operation could be served without the contract being made to declare it.
  it('states the 429 with Retry-After and the code in the application’s own description, for each', () => {
    if (running === undefined) throw new Error('the application did not start');

    expect(descriptionProblems(buildOpenApiDocument(running.app), coveredOperations())).toEqual([]);
  });

  // Break caught: the contract's reading of `security` drifting from the access declaration the limiter acts on (an operation the contract
  // calls anonymous that the guard counts, or the reverse), which would exempt the contract's own check from the operations it should hold.
  it('reads the operations that take a session in the contract as the application declares them', () => {
    const operations = contractOperations(CONTRACT);
    const disagreeing = served()
      .filter((each) => {
        const operation = operations.get(each.operationId);
        return operation === undefined || takesSession(operation) !== each.covered;
      })
      .map((each) => each.operationId);

    expect(disagreeing).toEqual([]);
  });

  // Break caught: a limiter that is not applied to a kind of route the description leaves out, or the reverse: an operation reached before a session exists
  // that is described with a wait, which the server never sends it.
  it('describes no wait for an operation that is reached before a session exists', () => {
    if (running === undefined) throw new Error('the application did not start');
    const operations = operationsOf(buildOpenApiDocument(running.app));
    const withWait = served()
      .filter((each) => !each.covered)
      .filter((each) => {
        const responses = (operations.get(each.operationId)?.responses ?? {}) as Record<
          string,
          { headers?: Record<string, unknown> }
        >;
        return responses['429']?.headers?.['Retry-After'] !== undefined;
      })
      .map((each) => each.operationId);

    expect(withWait).toEqual([]);
  });

  // Break caught (the test cannot pass for having checked nothing): each way to leave the declaration out is found, by name, in a copy changed in
  // exactly one way. The contract itself is never edited here.
  it('finds an operation that leaves the 429, its code or the shared response out, in the contract and in the description', () => {
    const covered = coveredOperations();
    const [first, second, third] = covered;
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error('too few covered operations to change one in three ways');
    }
    const copy = new JsonEditor(CONTRACT);
    copy.remove([...pathOf(first), 'responses', '429']);
    copy.update<string[]>([...pathOf(second), 'x-error-codes'], (codes) =>
      codes.filter((code) => code !== 'RATE_LIMITED'),
    );
    copy.set([...pathOf(third), 'responses', '429'], {
      $ref: '#/components/responses/RateLimitedAnonymous',
    });

    expect(contractProblems(copy.document, covered)).toEqual([
      `${first} does not answer 429 with the shared RateLimited response`,
      `${second} does not list RATE_LIMITED in its x-error-codes`,
      `${third} does not answer 429 with the shared RateLimited response`,
    ]);

    if (running === undefined) throw new Error('the application did not start');
    const document = buildOpenApiDocument(running.app);
    const described = operationsOf(document);
    const withoutAnswer = described.get(first);
    const withoutCode = described.get(second);
    if (withoutAnswer === undefined || withoutCode === undefined) {
      throw new Error('the application does not describe the operations to change');
    }
    Reflect.deleteProperty(withoutAnswer.responses as object, '429');
    withoutCode['x-error-codes'] = [];

    expect(descriptionProblems(document, covered)).toEqual([
      `${first} is described without a 429 that carries Retry-After`,
      `${second} is described without RATE_LIMITED in its x-error-codes`,
    ]);
  });
});
