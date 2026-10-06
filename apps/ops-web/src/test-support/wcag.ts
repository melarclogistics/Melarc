import axe from 'axe-core';

/**
 * Runs the automated checks that map to WCAG 2.1 levels A and AA, the working target in
 * surfaces/ops-portal.md §11, and returns one line per violation. Automated checks find only part of
 * the problems; they do not replace the keyboard and focus tests.
 */
export async function wcagViolations(container: HTMLElement): Promise<string[]> {
  const results = await axe.run(container, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    // jsdom has no layout, so contrast cannot be computed here; the browser smoke test checks it.
    rules: { 'color-contrast': { enabled: false } },
  });
  return results.violations.map((violation) => `${violation.id}: ${violation.help}`);
}
