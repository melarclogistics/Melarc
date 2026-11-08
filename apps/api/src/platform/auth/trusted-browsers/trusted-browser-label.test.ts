import { describe, expect, it } from 'vitest';

import { trustedBrowserLabel, UNRECOGNISED_BROWSER_LABEL } from './trusted-browser-label.js';

const CHROME_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const EDGE_WINDOWS = `${CHROME_WINDOWS} Edg/126.0.0.0`;
const FIREFOX_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0';
const SAFARI_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const CHROME_ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

describe('the label of a trusted browser', () => {
  // Break caught: a browser that also says "Chrome" or "Safari" being named for the wrong one (the order of the list).
  it.each([
    [CHROME_WINDOWS, 'Chrome on Windows'],
    [EDGE_WINDOWS, 'Edge on Windows'],
    [FIREFOX_LINUX, 'Firefox on Linux'],
    [SAFARI_MAC, 'Safari on macOS'],
    [SAFARI_IPHONE, 'Safari on iOS'],
    [CHROME_ANDROID, 'Chrome on Android'],
    [`${CHROME_WINDOWS} OPR/110.0.0.0`, 'Opera on Windows'],
    [
      'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 Chrome/126.0.0.0',
      'Chrome on ChromeOS',
    ],
  ])('names %# from its closed lists', (header, label) => {
    expect(trustedBrowserLabel(header)).toBe(label);
  });

  it('names a browser alone, or a system alone, when only one is on the lists', () => {
    expect(trustedBrowserLabel('Firefox/127.0')).toBe('Firefox');
    expect(trustedBrowserLabel('SomeApp/1.0 (Windows)')).toBe('Browser on Windows');
  });

  // Break caught: a header that is absent, repeated or unknown reaching the label, or the label being empty.
  it.each([undefined, '', 'curl/8.4.0', ['a', 'b'] as readonly string[]])(
    'says it did not recognise %#',
    (header) => {
      expect(trustedBrowserLabel(header)).toBe(UNRECOGNISED_BROWSER_LABEL);
    },
  );

  // Break caught: the client's own text reaching a stored description (a control character, an address, a very long string).
  it('puts nothing the client typed into the label', () => {
    const hostile = `Chrome/1 Windows <script>alert(1)</script>\u0000\n 203.0.113.9 ${'x'.repeat(10_000)}`;
    const label = trustedBrowserLabel(hostile);
    expect(label).toBe('Chrome on Windows');
    expect(label.length).toBeGreaterThanOrEqual(1);
    expect(label.length).toBeLessThanOrEqual(40);
    // eslint-disable-next-line no-control-regex
    expect(label).not.toMatch(/[\u0000-\u001f\u007f<>.]/);
  });

  it('reads only the start of an enormous header', () => {
    expect(trustedBrowserLabel(`${'x'.repeat(600)} Chrome/1 Windows`)).toBe(
      UNRECOGNISED_BROWSER_LABEL,
    );
  });

  it('is within the table check for every list entry combined', () => {
    const outputs = new Set<string>();
    for (const header of [
      CHROME_WINDOWS,
      EDGE_WINDOWS,
      FIREFOX_LINUX,
      SAFARI_MAC,
      SAFARI_IPHONE,
      CHROME_ANDROID,
      '',
    ]) {
      outputs.add(trustedBrowserLabel(header));
    }
    for (const label of outputs) {
      expect(label.length).toBeGreaterThanOrEqual(1);
      expect(label.length).toBeLessThanOrEqual(80);
    }
  });
});
