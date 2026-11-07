import { readFileSync } from 'node:fs';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { isJsonObject, type JsonObject } from '../../platform/contract/json.js';
import { locateContract } from '../../platform/contract/locate-contract.js';
import {
  PRE_SESSION_WITHOUT_A_LIMITER,
  checkRateLimitDeclarations,
  countOperations,
} from './check-rate-limit-declarations.js';

/**
 * The rate limit, declared, read from the contract alone (errors-and-enums.md section 4; `AC-SLICE-000-131`): the real contract passes, and a
 * copy changed in exactly one way, held in memory, does not. The contract itself is never edited here.
 */
const CONTRACT = parse(readFileSync(locateContract(import.meta.dirname), 'utf8')) as JsonObject;

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

/** A copy of the contract that a test may change (the parsed contract is read-only in its type). */
type Editable = Record<string, unknown>;

function copy(): Editable {
  return structuredClone(CONTRACT);
}

const asContract = (editable: Editable): JsonObject => editable as unknown as JsonObject;

function operationById(contract: Editable, id: string): Editable {
  const paths = contract.paths as Editable;
  for (const item of Object.values(paths)) {
    if (typeof item !== 'object' || item === null) continue;
    for (const method of METHODS) {
      const operation = (item as Editable)[method];
      if (
        typeof operation === 'object' &&
        operation !== null &&
        (operation as Editable).operationId === id
      ) {
        return operation as Editable;
      }
    }
  }
  throw new Error(`The contract has no operation ${id}.`);
}

function responsesOf(operation: Editable): Editable {
  return operation.responses as Editable;
}

function messages(contract: Editable): string[] {
  return checkRateLimitDeclarations(asContract(contract)).map(
    (found) => `${found.at}: ${found.message}`,
  );
}

describe('the rate limit declared in the contract', () => {
  it('is declared on every operation of the real contract', () => {
    expect(checkRateLimitDeclarations(CONTRACT)).toEqual([]);
  });

  it('reads every operation of the contract, built or not', () => {
    const paths = CONTRACT.paths as JsonObject;
    let expected = 0;
    for (const item of Object.values(paths)) {
      if (!isJsonObject(item)) continue;
      for (const method of METHODS) if (isJsonObject(item[method])) expected += 1;
    }
    expect(countOperations(CONTRACT)).toBe(expected);
    expect(expected).toBeGreaterThan(150);
  });

  // Break caught: an operation that takes a session and answers no 429 (a new operation that forgets the rate limit).
  it('fails when an operation that takes a session has no 429', () => {
    const changed = copy();
    delete responsesOf(operationById(changed, 'listPickupRequests'))['429'];
    expect(messages(changed).join('\n')).toMatch(
      /listPickupRequests.*response 429.*shared RateLimited response/,
    );
  });

  // Break caught: a session operation that answers with the response that carries no wait.
  it('fails when an operation that takes a session answers with the response that has no Retry-After', () => {
    const changed = copy();
    responsesOf(operationById(changed, 'listPickupRequests'))['429'] = {
      $ref: '#/components/responses/RateLimitedAnonymous',
    };
    expect(messages(changed).join('\n')).toMatch(/listPickupRequests.*response 429/);
  });

  it('fails when an operation that takes a session does not list RATE_LIMITED', () => {
    const changed = copy();
    const operation = operationById(changed, 'listPickupRequests');
    operation['x-error-codes'] = (operation['x-error-codes'] as string[]).filter(
      (code) => code !== 'RATE_LIMITED',
    );
    expect(messages(changed).join('\n')).toMatch(/listPickupRequests.*x-error-codes.*RATE_LIMITED/);
  });

  // Break caught: a sign-in (a bucket of its own, no session yet) that tells the caller how long to wait.
  it('fails when an operation reached before a session answers with the response that carries a wait', () => {
    const changed = copy();
    responsesOf(operationById(changed, 'staffSignIn'))['429'] = {
      $ref: '#/components/responses/RateLimited',
    };
    expect(messages(changed).join('\n')).toMatch(/staffSignIn.*response 429.*RateLimitedAnonymous/);
  });

  it('fails when a limited operation reached before a session has no 429', () => {
    const changed = copy();
    delete responsesOf(operationById(changed, 'staffSignIn'))['429'];
    expect(messages(changed).join('\n')).toMatch(/staffSignIn.*response 429/);
  });

  // Break caught: a NEW operation before a session that nobody limits and nobody listed.
  it('fails when a new operation reached before a session states no 429 and is not on the list of operations without a limiter', () => {
    const changed = copy();
    (changed.paths as Editable)['/auth/something-new'] = {
      post: {
        operationId: 'somethingNew',
        security: [],
        responses: { '200': { description: 'Done' } },
        'x-error-codes': [],
      },
    };
    expect(messages(changed).join('\n')).toMatch(/somethingNew.*response 429/);
  });

  // The operations without a limiter are a decision, not a hiding place.
  it('lists the operations reached before a session that no bucket limits, and each one states no 429', () => {
    expect(Object.keys(PRE_SESSION_WITHOUT_A_LIMITER)).toEqual(['receiveHubtelPaymentCallback']);
    const operation = operationById(structuredClone(CONTRACT), 'receiveHubtelPaymentCallback');
    expect(responsesOf(operation)['429']).toBeUndefined();
  });

  it('fails when an operation on the list of operations without a limiter is limited after all', () => {
    const changed = copy();
    responsesOf(operationById(changed, 'receiveHubtelPaymentCallback'))['429'] = {
      $ref: '#/components/responses/RateLimitedAnonymous',
    };
    expect(messages(changed).join('\n')).toMatch(/receiveHubtelPaymentCallback.*limited now/);
  });

  it('fails when the list of operations without a limiter names an operation the contract no longer has', () => {
    const changed = copy();
    delete (changed.paths as Editable)['/provider-callbacks/hubtel'];
    expect(messages(changed).join('\n')).toMatch(/receiveHubtelPaymentCallback.*no longer has/);
  });

  // Break caught: the shared responses lose or gain a header.
  it('fails when RateLimited does not declare Retry-After through the shared header', () => {
    const changed = copy();
    const shared = ((changed.components as Editable).responses as Editable).RateLimited as Editable;
    delete shared.headers;
    expect(messages(changed).join('\n')).toMatch(/RateLimited does not declare Retry-After/);
  });

  it('fails when RateLimitedAnonymous declares a header', () => {
    const changed = copy();
    const anonymous = ((changed.components as Editable).responses as Editable)
      .RateLimitedAnonymous as Editable;
    anonymous.headers = { 'Retry-After': { $ref: '#/components/headers/RetryAfter' } };
    expect(messages(changed).join('\n')).toMatch(/RateLimitedAnonymous declares a header/);
  });
});
