import { describe, expect, it } from 'vitest';

import {
  contentSecurityPolicy,
  EVIDENCE_STORE_ORIGIN_VARIABLE,
  evidenceOriginFromEnvironment,
  evidenceOriginOf,
} from '../config/content-security-policy';

/**
 * The Content-Security-Policy of the browser surfaces, built from configuration (architecture/SECURITY_DESIGN.md section 14; OB-S1-107). The evidence store is another origin that the browser itself sends photos to
 * (`connect-src`) and draws them from (`img-src`); those two directives take its origin when one is configured and stay `'self'` when none is. Nothing else moves.
 */
const WITHOUT =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const STORE = 'https://evidence.example';
const WITH =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https://evidence.example; font-src 'self'; connect-src 'self' https://evidence.example; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

describe('contentSecurityPolicy', () => {
  // Break caught: a policy that changed for a deployment with no store (a directive widened, or a space left after `'self'`), which the edge would send to every browser.
  it("is the strict policy, with `connect-src` and `img-src` at `'self'`, when no store is configured", () => {
    expect(contentSecurityPolicy()).toBe(WITHOUT);
    expect(contentSecurityPolicy({})).toBe(WITHOUT);
    expect(contentSecurityPolicy({ evidenceOrigin: undefined })).toBe(WITHOUT);
  });

  // Break caught: the store's origin missing from the upload (`connect-src`) or from the picture (`img-src`), so that photos are sent and cannot be shown, or shown and cannot be sent.
  it("adds the store’s origin to `connect-src` and `img-src`, after `'self'`", () => {
    expect(contentSecurityPolicy({ evidenceOrigin: STORE })).toBe(WITH);
  });

  // Break caught: the store's origin leaking into another directive (above all `script-src`, which is the protection against injected code acting as the officer).
  it('puts the store’s origin in those two directives and in no other', () => {
    const directives = contentSecurityPolicy({ evidenceOrigin: STORE }).split('; ');
    const holding = directives.filter((directive) => directive.includes('evidence.example'));

    expect(holding.map((directive) => directive.split(' ')[0])).toEqual(['img-src', 'connect-src']);
    expect(directives.filter((directive) => directive.startsWith('script-src'))).toEqual([
      "script-src 'self'",
    ]);
    // Every other directive is exactly what it is without a store.
    const strip = (policy: string): string[] =>
      policy.split('; ').filter((d) => !d.startsWith('img-src') && !d.startsWith('connect-src'));
    expect(strip(contentSecurityPolicy({ evidenceOrigin: STORE }))).toEqual(strip(WITHOUT));
  });

  // Break caught: a policy that is wider than the origin it was given (a wildcard, a scheme, an eval), whatever the configuration says.
  it('never has a wildcard, an eval, a bare scheme or an origin other than the one given', () => {
    const policy = contentSecurityPolicy({ evidenceOrigin: 'https://evidence.example:9000' });

    expect(policy).toContain("connect-src 'self' https://evidence.example:9000;");
    expect(policy).not.toMatch(/\*|unsafe-eval|\bhttps:(?!\/\/)|\bdata:|\bblob:/);
  });

  // Break caught: a policy built from a malformed origin that was let through (the person who set it would think the store is allowed, or the policy would hold more than they wrote).
  it('refuses a malformed origin and does not build a policy from it', () => {
    expect(() => contentSecurityPolicy({ evidenceOrigin: 'http://evidence.example' })).toThrow(
      /https/,
    );
  });
});

describe('evidenceOriginOf', () => {
  // Break caught: an origin taken as typed (upper case, a trailing slash, the default port written out), so that the policy holds a spelling the browser does not match.
  it.each([
    ['https://evidence.example', 'https://evidence.example'],
    ['https://evidence.example/', 'https://evidence.example'],
    ['HTTPS://Evidence.Example', 'https://evidence.example'],
    ['https://evidence.example:443', 'https://evidence.example'],
    ['https://evidence.example:9000', 'https://evidence.example:9000'],
    ['https://eu-west.store.example', 'https://eu-west.store.example'],
    ['https://xn--bcher-kva.example', 'https://xn--bcher-kva.example'],
  ])('takes %s as the origin %s', (given, origin) => {
    expect(evidenceOriginOf(given)).toBe(origin);
  });

  // Break caught: each of the ways a value is not an origin, taken for one: a scheme that is not https, a path (the policy would then allow a bucket and not the origin the browser checks), a query, a fragment,
  // credentials, a wildcard (every subdomain), a character that ends a directive or a source (a second directive written into the policy), a blank value and a value with white space round it.
  it.each([
    ['a plain http scheme', 'http://evidence.example'],
    ['no scheme', 'evidence.example'],
    ['a scheme alone', 'https:'],
    ['another scheme', 'ftp://evidence.example'],
    ['a path', 'https://evidence.example/bucket'],
    ['a path of dots', 'https://evidence.example/..'],
    ['a query', 'https://evidence.example/?x=1'],
    ['an empty query', 'https://evidence.example?'],
    ['a fragment', 'https://evidence.example/#x'],
    ['an empty fragment', 'https://evidence.example#'],
    ['credentials', 'https://user:secret@evidence.example'],
    ['a wildcard host', 'https://*.evidence.example'],
    ['a wildcard alone', '*'],
    ['a directive end', 'https://evidence.example;script-src https://evil.example'],
    ['a directive end without a space', 'https://evidence.example;x'],
    ['a second source', 'https://evidence.example,https://evil.example'],
    ['a second source with a space', 'https://evidence.example https://evil.example'],
    ['a quote', "https://evidence.example'"],
    ['an IPv6 literal', 'https://[::1]'],
    ['a host with an underscore', 'https://evidence_store.example'],
    ['a trailing dot', 'https://evidence.example.'],
    ['a blank value', ''],
    ['white space only', '   '],
    ['white space before', ' https://evidence.example'],
    ['white space after', 'https://evidence.example '],
    ['a percent-encoded separator', 'https://evidence.example%3Bx'],
  ])('refuses %s', (_name, value) => {
    expect(() => evidenceOriginOf(value)).toThrow(/https origin/);
  });
});

describe('evidenceOriginFromEnvironment', () => {
  const named = (value: string | undefined) => ({ [EVIDENCE_STORE_ORIGIN_VARIABLE]: value });

  // Break caught: a deployment with no store given a store, or a blank variable (an empty line of an env file) taken as a malformed one that stops the start.
  it('names no origin when the variable is unset or blank', () => {
    expect(evidenceOriginFromEnvironment({})).toBeUndefined();
    expect(evidenceOriginFromEnvironment(named(undefined))).toBeUndefined();
    expect(evidenceOriginFromEnvironment(named(''))).toBeUndefined();
    expect(evidenceOriginFromEnvironment(named('   '))).toBeUndefined();
  });

  it('names the origin the variable holds, as the policy takes it', () => {
    expect(evidenceOriginFromEnvironment(named('https://Evidence.Example/'))).toBe(STORE);
    expect(evidenceOriginFromEnvironment(named(` ${STORE}\n`))).toBe(STORE);
  });

  // Break caught: a mistyped variable that is ignored (the portal then cannot show a photo and nobody knows why), or an error that does not say which variable is wrong.
  it('fails, naming the variable, when it is set and is not an origin', () => {
    expect(() => evidenceOriginFromEnvironment(named('http://evidence.example'))).toThrow(
      new RegExp(`^${EVIDENCE_STORE_ORIGIN_VARIABLE}: .*https origin`),
    );
    expect(() => evidenceOriginFromEnvironment(named('https://*.example'))).toThrow(
      EVIDENCE_STORE_ORIGIN_VARIABLE,
    );
  });

  it('is the variable the deployment document names', () => {
    expect(EVIDENCE_STORE_ORIGIN_VARIABLE).toBe('MELARC_EVIDENCE_STORE_ORIGIN');
  });
});
