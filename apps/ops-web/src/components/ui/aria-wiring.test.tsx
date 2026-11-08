import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { DatePicker } from './date-picker/DatePicker';

/*
 * How React Aria Components is held to the portal's security policy, which allows no inline style (SECURITY_DESIGN, the shell's compatibility
 * baseline). The library inserts one `<style>` of its own the first time a pressable thing mounts, unless an element with its id exists. The
 * portal gives it that element (index.html) and writes the library's rule itself (base.css). These tests hold the three together: the
 * element, the rule, and the library's own behaviour. The real browsers, under the policy, are test/browser/date-picker-policy.spec.ts.
 */
const APP_ROOT = resolve(import.meta.dirname, '../../..');
const STYLE_ID = 'react-aria-pressable-style';

const withoutComments = (text: string): string =>
  text.replace(/<!--[\s\S]*?-->|\/\*[\s\S]*?\*\//g, '');
const html = withoutComments(readFileSync(resolve(APP_ROOT, 'index.html'), 'utf8'));
const baseCss = withoutComments(readFileSync(resolve(APP_ROOT, 'src/styles/base.css'), 'utf8'));
const squeezed = (text: string): string => text.replace(/\s+/g, ' ').trim();

const originalEnvironment = process.env.NODE_ENV;

/** The library inserts its style only outside a test run, so a test that wants to see it says it is not one. */
function mountOutsideATest(): void {
  process.env.NODE_ENV = 'production';
  render(<DatePicker aria-label="Date" value={null} onChange={() => undefined} />);
}

afterEach(() => {
  process.env.NODE_ENV = originalEnvironment;
  document.getElementById(STYLE_ID)?.remove();
});

describe('React Aria Components under a policy without inline styles', () => {
  // Break caught: the element removed or renamed, so that the library inserts its style into every page and the policy refuses it, in the
  // console of every user and, where the policy is enforced, with the library's one rule not applied.
  it('has its marker element in the page, which is not itself a style', () => {
    const marker = /<([a-z]+)\b[^>]*\bid="react-aria-pressable-style"[^>]*>/.exec(html);

    expect(marker?.[1]).toBe('meta');
    expect(html).not.toMatch(/<style\b/i);
  });

  // Break caught: the rule left out of the portal's own stylesheet, or changed by an upgrade of the library: the marker keeps the library
  // from inserting it, so nothing else would notice that a pressable thing no longer behaves as the library meant.
  it("writes the library's own rule in the portal's stylesheet, as the installed library writes it", () => {
    document.getElementById(STYLE_ID)?.remove();
    mountOutsideATest();

    const inserted = document.getElementById(STYLE_ID);
    expect(
      inserted?.tagName,
      'the library inserted no style: its rule, and our copy of it, may be obsolete',
    ).toBe('STYLE');
    const rule = /@layer\s*\{\s*\[data-react-aria-pressable\]\s*\{[^}]*\}\s*\}/.exec(baseCss);
    expect(rule, 'base.css has no @layer rule for [data-react-aria-pressable]').not.toBeNull();
    expect(squeezed(rule?.[0] ?? '')).toBe(squeezed(inserted?.textContent ?? ''));
  });

  // Break caught: a version of the library that no longer honours the marker, which would put an inline style back into a page that
  // is served under the policy.
  it('inserts no style of its own where the marker is', () => {
    const marker = document.createElement('meta');
    marker.id = STYLE_ID;
    marker.name = STYLE_ID;
    document.head.append(marker);
    const styles = document.head.querySelectorAll('style').length;

    mountOutsideATest();

    expect(document.getElementById(STYLE_ID)).toBe(marker);
    expect(document.head.querySelectorAll('style')).toHaveLength(styles);
    marker.remove();
  });
});
