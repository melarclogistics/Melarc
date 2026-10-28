import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const APP_ROOT = resolve(import.meta.dirname, '..');
const SRC = join(APP_ROOT, 'src');
const DOOR = 'components/ui/';

interface Source {
  readonly path: string;
  readonly text: string;
}

/** The application's own sources: not tests (which may look inside a component) and not test support. The dev-only showcase is included. */
function applicationSources(): Source[] {
  const found: Source[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'test-support') walk(path);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        found.push({ path, text: readFileSync(path, 'utf8') });
      }
    }
  };
  walk(SRC);
  return found;
}

const relativePath = (source: Source): string => relative(SRC, source.path).replaceAll('\\', '/');

/** A module of the library, or of what it is made of, named by an import or an export-from. */
const LIBRARY =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](?:react-aria-components|react-aria|react-stately|@react-aria|@react-stately|@react-types|@internationalized)(?:\/[^'"]*)?['"]/i;

/** A native date or time input, however its type is written: an attribute, an object, a condition, in any case. */
const NATIVE_DATE =
  /\btype\s*[=:]\s*[^;\n]{0,80}['"`](?:date|datetime-local|time|month|week)['"`]/i;

describe('React Aria Components and the design system (DESIGN_SYSTEM section 24a)', () => {
  // Break caught: a second door to the library, so that a page draws a widget in the library's own terms and the one look and the one API of
  // the design system drift. The components of components/ui are the one place that imports it, and the lint rule says so too.
  it('is imported by the components of the design system alone', () => {
    const outside = applicationSources()
      .filter((source) => LIBRARY.test(source.text))
      .map(relativePath)
      .filter((path) => !path.startsWith(DOOR));

    expect(outside).toEqual([]);
  });

  it('is imported by at least one component, so that the dependency is used', () => {
    const inside = applicationSources()
      .filter((source) => LIBRARY.test(source.text))
      .map(relativePath);

    expect(inside.length).toBeGreaterThan(0);
    expect(inside.every((path) => path.startsWith(DOOR))).toBe(true);
  });

  // Break caught: a second door to dates: a page that draws the browser's own date input beside the one the design system built, so that one
  // screen takes a date in the browser's language and order and the next in the portal's (DATE_LOCALE).
  it('is the one way a page takes a date: no native date or time input anywhere else', () => {
    const drawn = applicationSources()
      .filter((source) => NATIVE_DATE.test(source.text))
      .map(relativePath);

    expect(drawn).toEqual([]);
  });

  // Break caught: a check that only reads the one way of naming the library that was thought of (`from`), so that a dynamic import, a
  // require, a side-effect import or the other case slips past it; and a date input spelled so that the plain attribute form misses it.
  it('reads every way of naming the library and of drawing a native date input', () => {
    for (const code of [
      "import { Calendar } from 'react-aria-components';",
      "export { Button } from 'react-aria-components/Button';",
      "import 'react-aria';",
      "const library = await import('react-stately');",
      "const library = await import ( '@react-aria/button' );",
      "const library = require('@internationalized/date');",
      "import { Calendar } from 'REACT-ARIA-COMPONENTS';",
    ]) {
      expect(LIBRARY.test(code), code).toBe(true);
    }
    for (const code of [
      "import { Other } from './react-aria-helpers';",
      "const other = await import('other-library');",
    ]) {
      expect(LIBRARY.test(code), code).toBe(false);
    }
    for (const code of [
      '<input type="date" />',
      '<input type="Date" />',
      "<input type={wide ? 'date' : 'text'} />",
      "const props = { type: 'datetime-local' };",
      "<input type='month' />",
    ]) {
      expect(NATIVE_DATE.test(code), code).toBe(true);
    }
    for (const code of [
      '<input type="text" />',
      "const kind = { type: 'dates' };",
      'type="password"',
    ]) {
      expect(NATIVE_DATE.test(code), code).toBe(false);
    }
  });

  // Break caught: the one door left open by a name that is not in the list the lint rule and this test share, such as the library's own
  // sub-packages, which a page could import by their short names.
  it('names the library in the lint rule as the test does', () => {
    const config = readFileSync(resolve(APP_ROOT, '../../eslint.config.mjs'), 'utf8');

    for (const name of [
      'react-aria-components',
      'react-aria',
      'react-stately',
      '@react-aria/*',
      '@react-stately/*',
      '@react-types/*',
      '@internationalized/*',
    ]) {
      expect(config, name).toContain(`'${name}'`);
    }
  });
});
