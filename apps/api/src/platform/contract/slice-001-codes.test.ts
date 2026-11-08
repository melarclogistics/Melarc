import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { isJsonObject, type JsonObject } from './json.js';
import { locateContract } from './locate-contract.js';

/**
 * The slice's criteria against the contract (SLICE-001 Gate 0; the screen S1.52 later extends into the full sweep).
 *
 * A criterion that names an error code it expects is a promise: the code is in the catalogue, and some operation the
 * feature serves it with declares it. The 28 October readiness check found nine places where that was false (a code the
 * operation never declared, so the test that provoked it would have met an undeclared refusal), and the contract was
 * reconciled on 29 October 2026. This reads the feature documents and the contract and fails when a criterion promises a
 * code nothing can deliver, so the gap cannot come back unseen.
 *
 * Both sides are read, not copied: the criteria from `features/`, the catalogue from `errors-and-enums.md`, the declarations
 * from `openapi.yaml`.
 */
const CONTRACT_FILE = locateContract(import.meta.dirname);
const ROOT = dirname(dirname(CONTRACT_FILE));
const read = (...segments: string[]): string =>
  readFileSync(join(ROOT, ...segments), 'utf8').replaceAll('\r', '');

const FEATURES = [
  ['features', 'pickup', 'pickup-request.md'],
  ['features', 'pickup', 'pickup-manifest.md'],
  ['features', 'pickup', 'pickup-collection.md'],
  ['features', 'pickup', 'pickup-failure.md'],
  ['features', 'hub', 'hub-intake.md'],
  ['features', 'hub', 'itemization.md'],
] as const;

/**
 * Codes every operation can answer with and no criterion needs declared on a particular one: the authentication, CSRF and
 * authorization refusals and the rules of the shared headers. A criterion naming one of these is checked against the
 * catalogue only.
 */
const GENERIC = new Set([
  'PERMISSION_DENIED',
  'HUB_SCOPE_VIOLATION',
  'NOT_FOUND',
  'SESSION_INVALID',
  'CSRF_VALIDATION_FAILED',
  'IDEMPOTENCY_KEY_CONFLICT',
  'STATE_CONFLICT',
]);

interface Criterion {
  readonly id: string;
  readonly codes: readonly string[];
}

const CONTRACT = parse(read('contracts', 'openapi.yaml')) as JsonObject;

/** operationId -> its x-error-codes, for every operation of the contract. */
function declaredCodes(): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  const paths = isJsonObject(CONTRACT.paths) ? CONTRACT.paths : {};
  for (const item of Object.values(paths)) {
    if (!isJsonObject(item)) continue;
    for (const method of ['get', 'put', 'post', 'delete', 'patch'] as const) {
      const operation = item[method];
      if (!isJsonObject(operation) || typeof operation.operationId !== 'string') continue;
      const codes = Array.isArray(operation['x-error-codes']) ? operation['x-error-codes'] : [];
      found.set(
        operation.operationId,
        new Set(codes.filter((code): code is string => typeof code === 'string')),
      );
    }
  }
  return found;
}

/** The live codes of the catalogue: a row `| `CODE`|` that is not struck through. */
function catalogue(): Set<string> {
  const live = new Set<string>();
  for (const line of read('contracts', 'errors-and-enums.md').split('\n')) {
    const match = /^\| `([A-Z][A-Z0-9_]+)`\|/.exec(line);
    if (match?.[1] !== undefined) live.add(match[1]);
  }
  return live;
}

function criteriaOf(markdown: string): Criterion[] {
  const blocks = markdown.split(/^### `(AC-SLICE-001-\d+)`/m);
  const found: Criterion[] = [];
  for (let at = 1; at < blocks.length; at += 2) {
    const id = blocks[at] ?? '';
    const body = (blocks[at + 1] ?? '').split(/^(?:## |---$)/m)[0] ?? '';
    const codes = [
      ...body.matchAll(/\*\*(?:Code|Expected code on rejection):\*\*([^\n]*)/g),
    ].flatMap((line) =>
      [...(line[1] ?? '').matchAll(/`([A-Z][A-Z0-9_]+)`/g)].map((code) => code[1] ?? ''),
    );
    found.push({ id, codes });
  }
  return found;
}

/** The operations of the contract that a feature document names anywhere in its text: in backticks, or plain inside a criterion. */
function operationsNamedIn(markdown: string, operations: ReadonlySet<string>): Set<string> {
  const named = new Set<string>();
  for (const match of markdown.matchAll(/\b([a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+)\b/g)) {
    if (operations.has(match[1] ?? '')) named.add(match[1] ?? '');
  }
  return named;
}

const DECLARED = declaredCodes();
const CATALOGUE = catalogue();

describe('SLICE-001: every code a criterion names can be delivered', () => {
  for (const segments of FEATURES) {
    const markdown = read(...segments);
    const criteria = criteriaOf(markdown);
    const served = operationsNamedIn(markdown, new Set(DECLARED.keys()));

    // Break caught: a feature whose criteria the reader no longer finds (a heading changed), which would pass vacuously.
    it(`${segments.at(-1) ?? ''} has its criteria and names the operations that serve them`, () => {
      expect(criteria.length).toBeGreaterThan(5);
      expect(served.size).toBeGreaterThan(0);
    });

    for (const criterion of criteria) {
      for (const code of criterion.codes) {
        // Break caught: a criterion expecting a code the catalogue does not have, or has withdrawn.
        it(`${criterion.id} expects ${code}, which the catalogue holds`, () => {
          expect(CATALOGUE.has(code), `${code} is not a live code of errors-and-enums.md`).toBe(
            true,
          );
        });

        if (GENERIC.has(code)) continue;
        // Break caught: a criterion expecting a code that no operation its feature names declares. An undeclared refusal is a
        // 500 outside production, so the test that provoked it would fail for a reason the criterion does not give.
        it(`${criterion.id} expects ${code}, which an operation of its feature declares`, () => {
          const declaring = [...served].filter((operation) => DECLARED.get(operation)?.has(code));
          expect(
            declaring,
            `${code} is declared by none of: ${[...served].toSorted().join(', ')}`,
          ).not.toEqual([]);
        });
      }
    }
  }
});
