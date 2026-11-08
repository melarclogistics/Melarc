import { describe, expect, it } from 'vitest';

import { presentedTrustedBrowser } from './trusted-browser-credential.js';

const TOKEN = 'A'.repeat(43);

describe('the trusted-browser credential of a request', () => {
  // Break caught: a credential read from another cookie's name or from a prefix, or trimmed into a different value.
  it('reads the cookie by its exact name and leaves the value as sent', () => {
    expect(presentedTrustedBrowser({ cookie: `melarc_trusted_browser=${TOKEN}` })).toBe(TOKEN);
    expect(
      presentedTrustedBrowser({
        cookie: `melarc_session=x; melarc_trusted_browser= ${TOKEN} ; melarc_csrf=y`,
      }),
    ).toBe(TOKEN);
    expect(
      presentedTrustedBrowser({ cookie: `melarc_trusted_browser_2=${TOKEN}` }),
    ).toBeUndefined();
    expect(
      presentedTrustedBrowser({ cookie: `x_melarc_trusted_browser=${TOKEN}` }),
    ).toBeUndefined();
    expect(presentedTrustedBrowser({ cookie: `Melarc_Trusted_Browser=${TOKEN}` })).toBeUndefined();
    expect(presentedTrustedBrowser({ cookie: `melarc_trusted_browser="${TOKEN}"` })).toBe(
      `"${TOKEN}"`,
    );
  });

  // Break caught: a request with two credentials being resolved in favour of one of them.
  it('is no credential when it is sent twice, however alike, and when there is none', () => {
    expect(
      presentedTrustedBrowser({
        cookie: `melarc_trusted_browser=${TOKEN}; melarc_trusted_browser=${TOKEN}`,
      }),
    ).toBeUndefined();
    expect(presentedTrustedBrowser({})).toBeUndefined();
    expect(presentedTrustedBrowser({ cookie: 'melarc_session=x' })).toBeUndefined();
    expect(presentedTrustedBrowser({ cookie: 'melarc_trusted_browser' })).toBeUndefined();
  });

  it('reads an empty value as an empty credential, which matches nothing', () => {
    expect(presentedTrustedBrowser({ cookie: 'melarc_trusted_browser=' })).toBe('');
  });
});
