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
  /** The `x-error-codes` the operation declares. */
  readonly errorCodes: readonly string[];
  /** Whether the operation names hosts of its own (the dedicated Rider host). */
  readonly hasServers: boolean;
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
        errorCodes: Array.isArray(operation['x-error-codes'])
          ? operation['x-error-codes'].filter((code): code is string => typeof code === 'string')
          : [],
        hasServers: Array.isArray(operation.servers),
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

/**
 * The client of every anonymous operation (S0.25; SECURITY_DESIGN.md §13.8 "Client policy"; the readiness audit's C-10): the
 * contract classifies each pre-authentication operation by the client it serves, by declaring `CSRF_VALIDATION_FAILED` for the
 * browser operations (their `Origin` is refused when missing, `null` or unlisted) and by not declaring it for the native ones. The
 * application states the same fact in `Anonymous(limit, client)`; the task that builds each operation passes the client this
 * partition gives it, and the conformance check holds the two together. The partition is pinned here by name, so a new operation
 * (or a changed declaration) is a deliberate edit of this list and not a silent drift.
 */
describe('which anonymous operations are browser pre-session mutations (S0.25)', () => {
  const anonymous = operations().filter((op) => op.permission === 'none');
  const browser = anonymous.filter((op) => op.errorCodes.includes('CSRF_VALIDATION_FAILED'));
  const notBrowser = anonymous.filter((op) => !op.errorCodes.includes('CSRF_VALIDATION_FAILED'));

  // Break caught: a browser pre-session mutation dropped from the Origin rule (or a native one added to it) without anyone deciding.
  it('holds exactly the sign-in, setup, recovery and enrolment operations of the browser surfaces to the Origin rule', () => {
    expect(browser.map((op) => op.id).toSorted()).toEqual([
      'beginMfaReenrolment',
      'completeAdditionalDeviceEnrolment',
      'completeCredentialRecovery',
      'completeMfaEnrolment',
      'completeStaffCredentialSetup',
      'completeStaffMfaSignIn',
      'completeVendorCredentialSetup',
      'requestCredentialRecovery',
      'staffSignIn',
      'vendorSignIn',
    ]);
  });

  // Break caught: a native Rider operation made subject to the browser rule, which would refuse the app for lacking an Origin it
  // does not send; or a browser operation declared native.
  it('leaves the Rider app’s operations, and the provider’s callback, out of it', () => {
    expect(notBrowser.map((op) => op.id).toSorted()).toEqual([
      'completeRiderDeviceEnrolment',
      'receiveHubtelPaymentCallback',
      'requestRiderSignInChallenge',
      'riderSignIn',
    ]);
  });

  it('names the dedicated Rider host for every Rider operation and for no browser one', () => {
    const rider = anonymous.filter((op) => op.hasServers);

    expect(rider.map((op) => op.id).toSorted()).toEqual([
      'completeRiderDeviceEnrolment',
      'requestRiderSignInChallenge',
      'riderSignIn',
    ]);
    for (const op of browser) expect(op.hasServers, op.id).toBe(false);
  });

  // Break caught: the browser rule resting on the operation being anonymous alone. No authenticated operation is a pre-session
  // mutation, and none of them declares the origin refusal as its own: an authenticated unsafe operation declares it for the
  // synchronizer token and the session's Origin, which is the cookie rule, not this one.
  it('is a list of anonymous operations only', () => {
    expect(browser.every((op) => op.permission === 'none')).toBe(true);
  });
});
