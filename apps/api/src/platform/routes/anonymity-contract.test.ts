import { readFileSync } from 'node:fs';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { isJsonObject, type Json, type JsonObject } from '../contract/json.js';
import { locateContract } from '../contract/locate-contract.js';

/**
 * `AC-SLICE-000-43`, the contract half: anonymity is declared and never inferred. The declarations of the application
 * (`Anonymous`, `Self`, `RequiresPermission`, `access-declaration.ts`) state the same facts in the application's own description,
 * and the conformance check compares the two; this reads the contract and holds it to the rule the criterion states.
 */
const contract = parse(readFileSync(locateContract(import.meta.dirname), 'utf8')) as JsonObject;

interface Op {
  readonly id: string;
  readonly permission: Json | undefined;
  readonly hasOwnSecurity: boolean;
  readonly security: Json | undefined;
}

function operations(): Op[] {
  const found: Op[] = [];
  const paths = contract.paths;
  if (!isJsonObject(paths)) throw new Error('no paths');
  for (const item of Object.values(paths)) {
    if (!isJsonObject(item)) continue;
    for (const [method, operation] of Object.entries(item)) {
      if (!['get', 'post', 'put', 'delete', 'patch'].includes(method)) continue;
      if (!isJsonObject(operation)) continue;
      found.push({
        id: typeof operation.operationId === 'string' ? operation.operationId : '(no operationId)',
        permission: operation['x-permission'],
        hasOwnSecurity: 'security' in operation,
        security: operation.security,
      });
    }
  }
  return found;
}

const names = (security: Json | undefined): string[] =>
  Array.isArray(security)
    ? security.flatMap((requirement) => (isJsonObject(requirement) ? Object.keys(requirement) : []))
    : [];

describe('anonymity is declared, never inferred (AC-SLICE-000-43)', () => {
  const all = operations();
  const anonymous = all.filter((op) => op.permission === 'none');

  // Break caught: the contract's default being open, so an operation that forgets to say it needs a session is served to anyone.
  it('has a default security that requires an authenticated session scheme', () => {
    expect(contract.security).toEqual([
      { browserSession: [], csrfToken: [] },
      { riderSession: [] },
    ]);
  });

  // Break caught: an operation that is anonymous only because its permission says none, with no security statement of its own,
  // which would inherit the authenticated default and be anonymous by nothing but a word.
  it('has every operation with permission none declare its security itself, as no requirement or the registered browser alone', () => {
    expect(anonymous.length).toBeGreaterThan(10);
    for (const op of anonymous) {
      expect(op.hasOwnSecurity, op.id).toBe(true);
      const security = op.security;
      const open = Array.isArray(security) && security.length === 0;
      const deviceOnly =
        Array.isArray(security) &&
        security.length === 1 &&
        names(security).join() === 'vendorDevice';
      expect(open || deviceOnly, op.id).toBe(true);
    }
  });

  it('gives the registered browser alone to vendorSignIn and no other operation', () => {
    const device = all.filter((op) => names(op.security).includes('vendorDevice'));

    expect(device.map((op) => op.id)).toEqual(['vendorSignIn']);
    expect(device[0]?.security).toEqual([{ vendorDevice: [] }]);
  });

  // Break caught: an operation open to anyone that still names a permission to hold, or that names one that is not none: the two
  // statements would disagree about whether a caller is needed.
  it('declares an empty security only for an operation whose permission is none', () => {
    const open = all.filter((op) => Array.isArray(op.security) && op.security.length === 0);

    expect(open.length).toBeGreaterThan(10);
    for (const op of open) expect(op.permission, op.id).toBe('none');
  });

  // Break caught: an authenticated operation that names none, or an operation with no permission at all.
  it('gives every other operation a permission key or self, and an authenticated requirement', () => {
    for (const op of all.filter((each) => each.permission !== 'none')) {
      expect(typeof op.permission, op.id).toBe('string');
      if (op.hasOwnSecurity) {
        expect(names(op.security).length, op.id).toBeGreaterThan(0);
        expect(
          names(op.security).every((scheme) =>
            ['browserSession', 'csrfToken', 'riderSession'].includes(scheme),
          ),
          op.id,
        ).toBe(true);
      }
    }
  });
});
