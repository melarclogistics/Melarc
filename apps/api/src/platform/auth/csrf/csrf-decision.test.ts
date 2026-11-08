import { describe, expect, it } from 'vitest';

import { Sha256TokenService } from '../crypto/sha256.token-service.adapter.js';
import { decideBrowserMutation, type SynchronizerCheck } from './csrf-decision.js';
import { judgeFetchMetadata } from './fetch-metadata.js';
import { headerLines, judgeOrigin } from './origin-policy.js';

/** Raw header lines as Node keeps them: names and values alternating, in the case and order they arrived. */
const raw = (...pairs: readonly [string, string][]): string[] => pairs.flat();

const OPS = 'https://ops.melarc.example';
const VENDOR = 'https://vendor.melarc.example';
const tokens = new Sha256TokenService();

describe('headerLines', () => {
  // Break caught: a header read from the parsed map, where Node joins repeated lines with a comma: two lines would read as one value.
  it('returns every line of the named header, in order, whatever the case of its name', () => {
    expect(headerLines(raw(['ORIGIN', 'a'], ['Host', 'h'], ['origin', 'b']), 'Origin')).toEqual([
      'a',
      'b',
    ]);
  });

  it('returns nothing for a header that is not there, and ignores an odd trailing name', () => {
    expect(headerLines(raw(['Host', 'h']), 'origin')).toEqual([]);
    expect(headerLines(['Origin'], 'origin')).toEqual([]);
  });
});

describe('judgeOrigin: the exact allowlist (permission-enforcement.md §5.1 step 3; GBT-W5, GBT-W11)', () => {
  const allowed = [OPS];

  // Break caught: a comparison that is looser than equality (a prefix, a suffix, "contains", case-folded, with the default port
  // dropped, or with a path allowed), each of which lets an origin the deployment never listed through.
  it('allows the listed origin', () => {
    expect(judgeOrigin(raw(['Origin', OPS]), allowed)).toEqual({ kind: 'ALLOWED', origin: OPS });
  });

  it.each<[string, string, string]>([
    ['another host', 'https://vendor.melarc.example', 'UNLISTED'],
    ['a longer host that starts with it', `${OPS}.evil.example`, 'UNLISTED'],
    ['a parent domain', 'https://melarc.example', 'UNLISTED'],
    ['a sub-domain of it', 'https://x.ops.melarc.example', 'UNLISTED'],
    ['the other scheme', 'http://ops.melarc.example', 'UNLISTED'],
    ['an explicit default port', 'https://ops.melarc.example:443', 'UNLISTED'],
    ['another port', 'https://ops.melarc.example:8443', 'UNLISTED'],
    ['upper case', 'HTTPS://OPS.MELARC.EXAMPLE', 'MALFORMED'],
    ['a different case of the host', 'https://OPS.melarc.example', 'UNLISTED'],
    ['a trailing slash', `${OPS}/`, 'MALFORMED'],
    ['a path', `${OPS}/app`, 'MALFORMED'],
    ['a query', `${OPS}?x=1`, 'MALFORMED'],
    ['user information', 'https://ops.melarc.example@evil.example', 'MALFORMED'],
    ['a space around it', ` ${OPS}`, 'MALFORMED'],
    ['a trailing space', `${OPS} `, 'MALFORMED'],
    ['an empty value', '', 'MALFORMED'],
    ['a scheme that is not http', 'ftp://ops.melarc.example', 'MALFORMED'],
    ['an extension page', 'chrome-extension://abcdefgh', 'MALFORMED'],
    ['a list of two origins', `${OPS}, ${VENDOR}`, 'MALFORMED'],
    ['the word null in another case', 'NULL', 'MALFORMED'],
    ['the word undefined', 'undefined', 'MALFORMED'],
  ])('refuses %s (%s)', (_label, value, cause) => {
    expect(judgeOrigin(raw(['Origin', value]), allowed)).toEqual({ kind: 'REFUSED', cause });
  });

  // Break caught: `null` accepted as an origin, or read as missing. It is a value a browser really sends from a sandboxed frame.
  it('refuses the null origin as its own cause', () => {
    expect(judgeOrigin(raw(['Origin', 'null']), allowed)).toEqual({
      kind: 'REFUSED',
      cause: 'NULL',
    });
  });

  it('refuses a request with no Origin as missing', () => {
    expect(judgeOrigin(raw(['Host', 'h']), allowed)).toEqual({ kind: 'REFUSED', cause: 'MISSING' });
  });

  // Break caught: two Origin lines read as the first, or as one joined value that a later check then accepts.
  it('refuses two Origin lines, whatever each says', () => {
    for (const lines of [
      [OPS, OPS],
      [OPS, VENDOR],
      [VENDOR, OPS],
    ] as const) {
      expect(judgeOrigin(raw(['Origin', lines[0]], ['origin', lines[1]]), [OPS, VENDOR])).toEqual({
        kind: 'REFUSED',
        cause: 'MALFORMED',
      });
    }
  });

  // Break caught: the allowlist being the union of both surfaces for a request that is for one, which would let a Vendor page act as
  // the Ops Portal. The list handed in is the list for this request.
  it('allows only the origins it is given', () => {
    expect(judgeOrigin(raw(['Origin', VENDOR]), [OPS])).toEqual({
      kind: 'REFUSED',
      cause: 'UNLISTED',
    });
    expect(judgeOrigin(raw(['Origin', VENDOR]), [VENDOR])).toEqual({
      kind: 'ALLOWED',
      origin: VENDOR,
    });
    expect(judgeOrigin(raw(['Origin', OPS]), [])).toEqual({ kind: 'REFUSED', cause: 'UNLISTED' });
  });
});

describe('judgeFetchMetadata: an unexpected cross-site browser mutation (GBT-W15)', () => {
  // Break caught: any other value read as acceptable, which is how a cross-site form or fetch gets through on a browser that sends
  // the header.
  it.each<[string, string]>([
    ['cross-site', 'cross-site'],
    ['same-site', 'same-site'],
    ['none', 'none'],
    ['another word', 'cross-origin'],
    ['another case', 'Same-Origin'],
    ['a padded value', ' same-origin'],
    ['an empty value', ''],
  ])('reads %s as unexpected', (_label, value) => {
    expect(judgeFetchMetadata(raw(['Sec-Fetch-Site', value]))).toBe('UNEXPECTED');
  });

  it('reads same-origin as expected', () => {
    expect(judgeFetchMetadata(raw(['Sec-Fetch-Site', 'same-origin']))).toBe('SAME_ORIGIN');
  });

  // Break caught: a repeated line read as its first value.
  it('reads two lines as unexpected even when both say same-origin', () => {
    expect(
      judgeFetchMetadata(raw(['Sec-Fetch-Site', 'same-origin'], ['sec-fetch-site', 'same-origin'])),
    ).toBe('UNEXPECTED');
  });

  // Break caught: a missing header taken for an attack (refusing every client that sends none) or for proof of a native client.
  it('reads no header as absent, which is the fallback to the Origin and the token, not a verdict', () => {
    expect(judgeFetchMetadata(raw(['Host', 'h']))).toBe('ABSENT');
  });
});

describe('decideBrowserMutation: the order of the checks and what each needs', () => {
  const issued = tokens.issue();
  const session: SynchronizerCheck = { storedHash: issued.hash, tokens };
  const good = (extra: readonly [string, string][] = []): string[] =>
    raw(['Origin', OPS], ['X-CSRF-Token', issued.token], ...extra);

  describe('before a session exists', () => {
    // Break caught: a pre-session mutation served on its Origin alone when the browser says it is cross-site, or refused for
    // having no token it cannot have.
    it('allows an exact Origin with no token', () => {
      expect(
        decideBrowserMutation({ allowedOrigins: [OPS], rawHeaders: raw(['Origin', OPS]) }),
      ).toEqual({
        allowed: true,
      });
    });

    it.each<[string, string[], string]>([
      ['no Origin', raw(['Host', 'h']), 'ORIGIN_MISSING'],
      ['the null origin', raw(['Origin', 'null']), 'ORIGIN_NULL'],
      ['a malformed Origin', raw(['Origin', 'ops']), 'ORIGIN_MALFORMED'],
      ['an unlisted Origin', raw(['Origin', 'https://evil.example']), 'ORIGIN_UNLISTED'],
      [
        'a cross-site request with the right Origin',
        raw(['Origin', OPS], ['Sec-Fetch-Site', 'cross-site']),
        'FETCH_METADATA',
      ],
    ])('refuses %s', (_label, rawHeaders, check) => {
      expect(decideBrowserMutation({ allowedOrigins: [OPS], rawHeaders })).toEqual({
        allowed: false,
        check,
      });
    });

    it('allows the right Origin with Fetch Metadata saying same-origin, and with none', () => {
      for (const extra of [raw(['Sec-Fetch-Site', 'same-origin']), []]) {
        expect(
          decideBrowserMutation({
            allowedOrigins: [OPS],
            rawHeaders: [...raw(['Origin', OPS]), ...extra],
          }),
        ).toEqual({ allowed: true });
      }
    });
  });

  describe('with a session (cookie-authenticated)', () => {
    it('allows the right Origin and the token the session stored', () => {
      expect(
        decideBrowserMutation({ allowedOrigins: [OPS], rawHeaders: good(), synchronizer: session }),
      ).toEqual({ allowed: true });
    });

    // Break caught (GBT-W6): a cookie-authenticated mutation served without the synchronizer token, or on a token that is not the
    // session's.
    it('refuses a missing token', () => {
      expect(
        decideBrowserMutation({
          allowedOrigins: [OPS],
          rawHeaders: raw(['Origin', OPS]),
          synchronizer: session,
        }),
      ).toEqual({ allowed: false, check: 'TOKEN_MISSING' });
    });

    it.each<[string, string]>([
      ['another well-formed token', tokens.issue().token],
      ['a malformed token', 'not-a-token'],
      ['an empty token', ''],
      ['the stored hash spelled out', Buffer.from(issued.hash).toString('base64url')],
    ])('refuses %s', (_label, token) => {
      expect(
        decideBrowserMutation({
          allowedOrigins: [OPS],
          rawHeaders: raw(['Origin', OPS], ['X-CSRF-Token', token]),
          synchronizer: session,
        }),
      ).toEqual({ allowed: false, check: 'TOKEN_MISMATCH' });
    });

    // Break caught: the right token on one line and a wrong one on another, taken as the first.
    it('refuses the token sent twice, even when both are right', () => {
      expect(
        decideBrowserMutation({
          allowedOrigins: [OPS],
          rawHeaders: raw(
            ['Origin', OPS],
            ['X-CSRF-Token', issued.token],
            ['x-csrf-token', issued.token],
          ),
          synchronizer: session,
        }),
      ).toEqual({ allowed: false, check: 'TOKEN_MISMATCH' });
    });

    // Break caught: a session that holds no hash matching an empty or any token. It matches nothing.
    it('refuses every token for a session that stored none', () => {
      expect(
        decideBrowserMutation({
          allowedOrigins: [OPS],
          rawHeaders: good(),
          synchronizer: { storedHash: null, tokens },
        }),
      ).toEqual({ allowed: false, check: 'TOKEN_MISMATCH' });
    });

    // Break caught: the right token excusing a wrong Origin, which is what makes a token read from the cookie by a page on
    // another origin enough.
    it('refuses the right token from the wrong Origin', () => {
      expect(
        decideBrowserMutation({
          allowedOrigins: [OPS],
          rawHeaders: raw(['Origin', VENDOR], ['X-CSRF-Token', issued.token]),
          synchronizer: session,
        }),
      ).toEqual({ allowed: false, check: 'ORIGIN_UNLISTED' });
    });

    it('refuses the right Origin and token when the browser says the request is cross-site', () => {
      expect(
        decideBrowserMutation({
          allowedOrigins: [OPS],
          rawHeaders: good([['Sec-Fetch-Site', 'same-site']]),
          synchronizer: session,
        }),
      ).toEqual({ allowed: false, check: 'FETCH_METADATA' });
    });

    // The order is Origin, Fetch Metadata, token: the first failure is the one the audit names.
    it('names the first failing check', () => {
      const wrongOrigin = raw(['Origin', 'null'], ['Sec-Fetch-Site', 'cross-site']);
      expect(
        decideBrowserMutation({
          allowedOrigins: [OPS],
          rawHeaders: wrongOrigin,
          synchronizer: session,
        }),
      ).toEqual({ allowed: false, check: 'ORIGIN_NULL' });
      const crossSite = raw(['Origin', OPS], ['Sec-Fetch-Site', 'cross-site']);
      expect(
        decideBrowserMutation({
          allowedOrigins: [OPS],
          rawHeaders: crossSite,
          synchronizer: session,
        }),
      ).toEqual({ allowed: false, check: 'FETCH_METADATA' });
    });
  });
});
