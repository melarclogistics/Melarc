import { isJsonObject, type Json, type JsonObject } from '../../platform/contract/json.js';
import { takesSession } from '../../platform/contract/takes-session.js';
import type { Finding } from './findings.js';

/**
 * The rate limit, declared (task A2 of the audit, 7 November 2026; `AC-SLICE-000-131`; contracts/errors-and-enums.md section 4). **Every
 * operation of the contract that takes a session** is counted in the session's bucket of authenticated API requests, so it answers `429
 * RATE_LIMITED` with the contract's shared response `RateLimited`, which carries `Retry-After`, and lists the code in `x-error-codes`. **Every
 * operation reached before a session exists** and limited by a bucket of its own answers it with `RateLimitedAnonymous`, which carries none (a
 * wait told to a caller who is not signed in tells an attacker how long to wait). The Product Owner confirmed the two responses on 7 November
 * 2026.
 *
 * This reads the contract alone, for every operation in it, built or not: `contract:check` runs it beside the comparison of the application with
 * the contract, so it runs in the precheck. The application's own account of which routes the limiter covers is held to the contract's by
 * `routes/rate-limit-coverage.test.ts`, for the routes the application serves. A new operation cannot leave the 429 out.
 */
const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

const SESSION_RESPONSE = '#/components/responses/RateLimited';
const ANONYMOUS_RESPONSE = '#/components/responses/RateLimitedAnonymous';
const WAIT_HEADER = '#/components/headers/RetryAfter';

/**
 * The operations reached before a session exists that no bucket limits, with the reason: they state no 429 and are the only ones that may not.
 * An operation here is a decision to be revisited when it is built, never a place to hide a new one: the check fails when an operation that is
 * not listed here has no 429, and when one that is listed has one.
 */
export const PRE_SESSION_WITHOUT_A_LIMITER: Readonly<Record<string, string>> = {
  receiveHubtelPaymentCallback:
    'a callback of the payment provider, authenticated by its signature, not built; none of the six buckets covers it (the task that builds it decides)',
};

function sharedResponses(contract: JsonObject): JsonObject {
  return isJsonObject(contract.components) && isJsonObject(contract.components.responses)
    ? contract.components.responses
    : {};
}

function codesOf(operation: JsonObject): readonly string[] {
  const codes: Json | undefined = operation['x-error-codes'];
  return Array.isArray(codes)
    ? codes.filter((code): code is string => typeof code === 'string')
    : [];
}

function finding(at: string, message: string, expected?: Json, actual?: Json): Finding {
  return {
    code: 'RATE_LIMIT_DECLARATION',
    at,
    message,
    ...(expected === undefined ? {} : { expected }),
    ...(actual === undefined ? {} : { actual }),
  };
}

/** The two shared responses themselves: the first declares `Retry-After` through the shared header, the second declares no header. */
function sharedResponseFindings(contract: JsonObject): Finding[] {
  const responses = sharedResponses(contract);
  const findings: Finding[] = [];
  const session = responses.RateLimited;
  const anonymous = responses.RateLimitedAnonymous;
  if (!isJsonObject(session)) {
    findings.push(
      finding(
        'components > responses > RateLimited',
        'The contract has no shared RateLimited response.',
      ),
    );
  } else {
    const wait = isJsonObject(session.headers) ? session.headers['Retry-After'] : undefined;
    if (!isJsonObject(wait) || wait.$ref !== WAIT_HEADER) {
      findings.push(
        finding(
          'components > responses > RateLimited > headers',
          'RateLimited does not declare Retry-After through the shared RetryAfter header.',
          { 'Retry-After': { $ref: WAIT_HEADER } },
          wait ?? null,
        ),
      );
    }
  }
  if (!isJsonObject(anonymous)) {
    findings.push(
      finding(
        'components > responses > RateLimitedAnonymous',
        'The contract has no shared RateLimitedAnonymous response.',
      ),
    );
  } else if (anonymous.headers !== undefined) {
    findings.push(
      finding(
        'components > responses > RateLimitedAnonymous > headers',
        'RateLimitedAnonymous declares a header, and a 429 told before a session exists carries none (errors-and-enums.md section 4).',
        undefined,
        anonymous.headers,
      ),
    );
  }
  return findings;
}

/** Every operation of the contract, with where it is, for a finding. */
function operationsOf(
  contract: JsonObject,
): { readonly at: string; readonly id: string; readonly operation: JsonObject }[] {
  const paths = isJsonObject(contract.paths) ? contract.paths : {};
  const operations: { at: string; id: string; operation: JsonObject }[] = [];
  for (const [path, item] of Object.entries(paths)) {
    if (!isJsonObject(item)) continue;
    for (const method of METHODS) {
      const operation = item[method];
      if (!isJsonObject(operation)) continue;
      const id =
        typeof operation.operationId === 'string' ? operation.operationId : '(no operationId)';
      operations.push({ at: `${method.toUpperCase()} ${path} (${id})`, id, operation });
    }
  }
  return operations;
}

/** What the operation names for its 429: the reference of the response, or undefined when it has none. */
function referenceOf429(operation: JsonObject): string | undefined {
  const responses = isJsonObject(operation.responses) ? operation.responses : {};
  const answer = responses['429'];
  return isJsonObject(answer) && typeof answer.$ref === 'string' ? answer.$ref : undefined;
}

/**
 * The findings of the rate-limit declarations of the contract, all of them. Empty when every operation that takes a session answers 429 with
 * `RateLimited` and lists `RATE_LIMITED`, every other operation that a bucket limits answers it with `RateLimitedAnonymous`, the only
 * operations without a 429 are the ones {@link PRE_SESSION_WITHOUT_A_LIMITER} names, and the two shared responses are as they must be.
 */
export function checkRateLimitDeclarations(contract: JsonObject): Finding[] {
  const findings = sharedResponseFindings(contract);
  const operations = operationsOf(contract);
  for (const { at, id, operation } of operations) {
    const reference = referenceOf429(operation);
    const codes = codesOf(operation);
    if (takesSession(operation)) {
      if (reference !== SESSION_RESPONSE) {
        findings.push(
          finding(
            `${at} > response 429`,
            'The operation takes a session, so the authenticated limiter covers it, and it must answer 429 with the shared RateLimited response (which carries Retry-After).',
            { $ref: SESSION_RESPONSE },
            reference === undefined ? null : { $ref: reference },
          ),
        );
      }
      if (!codes.includes('RATE_LIMITED')) {
        findings.push(
          finding(
            `${at} > x-error-codes`,
            'The operation takes a session and must list RATE_LIMITED.',
          ),
        );
      }
      continue;
    }
    const exempt = Object.hasOwn(PRE_SESSION_WITHOUT_A_LIMITER, id);
    if (exempt) {
      if (reference !== undefined || codes.includes('RATE_LIMITED')) {
        findings.push(
          finding(
            `${at} > response 429`,
            `The operation is listed as limited by no bucket (${PRE_SESSION_WITHOUT_A_LIMITER[id] ?? ''}) and states a 429: it is limited now, so take it off the list of operations without a limiter and declare RateLimitedAnonymous.`,
          ),
        );
      }
      continue;
    }
    if (reference !== ANONYMOUS_RESPONSE) {
      findings.push(
        finding(
          `${at} > response 429`,
          'The operation is reached before a session exists, so a bucket of its own limits it, and it must answer 429 with the shared RateLimitedAnonymous response (which carries no wait).',
          { $ref: ANONYMOUS_RESPONSE },
          reference === undefined ? null : { $ref: reference },
        ),
      );
    }
    if (!codes.includes('RATE_LIMITED')) {
      findings.push(
        finding(
          `${at} > x-error-codes`,
          'The operation is limited by a bucket and must list RATE_LIMITED.',
        ),
      );
    }
  }
  for (const id of Object.keys(PRE_SESSION_WITHOUT_A_LIMITER)) {
    if (!operations.some((candidate) => candidate.id === id)) {
      findings.push(
        finding(
          `paths > ${id}`,
          'The list of operations without a limiter names an operation the contract no longer has: take it off the list.',
        ),
      );
    }
  }
  return findings;
}

/** How many operations the check read, for the line it prints. */
export function countOperations(contract: JsonObject): number {
  return operationsOf(contract).length;
}
