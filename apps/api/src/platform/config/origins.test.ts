import { describe, expect, it } from 'vitest';

import { linkTemplates, parseOrigin, renderLink } from './origins.js';

describe('parseOrigin', () => {
  it.each([
    'https://ops.melarc.example',
    'https://vendor.melarc.example',
    'http://127.0.0.1:5173',
    'http://localhost:3000',
    'https://ops.melarc.example:8443',
    'https://[::1]:8443',
  ])('accepts %s', (origin) => {
    expect(parseOrigin(origin)).toBe(origin);
  });

  // Break caught: an origin that is not the string a browser sends in `Origin`, so the exact comparison the design requires
  // would never match, or would match something it was not meant to (SECURITY_DESIGN.md §14.8).
  it.each([
    ['empty', ''],
    ['a trailing slash', 'https://ops.melarc.example/'],
    ['a path', 'https://ops.melarc.example/app'],
    ['a query', 'https://ops.melarc.example?x=1'],
    ['a fragment', 'https://ops.melarc.example#x'],
    ['user information', 'https://user:pass@ops.melarc.example'],
    ['an explicit default port', 'https://ops.melarc.example:443'],
    ['an upper-case host', 'https://OPS.melarc.example'],
    ['an upper-case scheme', 'HTTPS://ops.melarc.example'],
    ['a scheme that is not http or https', 'ftp://ops.melarc.example'],
    ['a script scheme', 'javascript:alert(1)'],
    ['the opaque origin', 'null'],
    ['a wildcard', '*'],
    ['no scheme', 'ops.melarc.example'],
    ['a space', 'https://ops melarc.example'],
    ['two origins', 'https://a.example https://b.example'],
  ])('refuses %s', (_label, origin) => {
    expect(parseOrigin(origin)).toBeUndefined();
  });
});

describe('link templates', () => {
  const templates = linkTemplates({
    ops: 'https://ops.melarc.example',
    vendor: 'https://vendor.melarc.example',
  });

  // Break caught: a link whose token travels in the path or the query, where it reaches logs, referrers and history
  // (surfaces/ops-portal.md: the token arrives in the URL fragment).
  it('put the token in the fragment of the page the surface owns, on the configured origin', () => {
    expect(templates).toEqual({
      ops: {
        setupCredential: 'https://ops.melarc.example/setup/credential#token={token}',
        setupMfa: 'https://ops.melarc.example/setup/mfa#token={token}',
        recovery: 'https://ops.melarc.example/recovery/complete#token={token}',
      },
      vendor: {
        setupCredential: 'https://vendor.melarc.example/setup/credential#token={token}',
        setupDevice: 'https://vendor.melarc.example/setup/device#token={token}',
        recovery: 'https://vendor.melarc.example/recovery/complete#token={token}',
      },
    });
  });

  it('renders a token into the fragment and nowhere else', () => {
    const token = 'abcDEF0123456789abcDEF0123456789abcDEF01234';

    expect(renderLink(templates.ops.recovery, token)).toBe(
      `https://ops.melarc.example/recovery/complete#token=${token}`,
    );
  });

  // Break caught: a token with characters that change where the link points or what it carries.
  it.each([
    ['empty', ''],
    ['a slash', 'abc/def'],
    ['a hash', 'abc#def'],
    ['a query mark', 'abc?x=1'],
    ['an ampersand', 'abc&token=other'],
    ['a space', 'abc def'],
    ['a percent escape', 'abc%2Fdef'],
    ['padding', 'abc='],
    ['a brace', '{token}'],
    ['129 characters', 'a'.repeat(129)],
  ])('refuses to render %s as a token', (_label, token) => {
    expect(() => renderLink(templates.ops.recovery, token)).toThrow(/is not a link token/);
  });

  it('refuses a template without exactly one placeholder in its fragment', () => {
    for (const template of [
      'https://ops.melarc.example/recovery/complete',
      'https://ops.melarc.example/recovery/complete#token=fixed',
      'https://ops.melarc.example/recovery/complete?token={token}',
      'https://ops.melarc.example/{token}#token={token}',
      'https://ops.melarc.example/recovery/complete#token={token}{token}',
    ]) {
      expect(() => renderLink(template, 'abc')).toThrow(/is not a link template/);
    }
  });
});
