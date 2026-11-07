import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const APP_ROOT = resolve(import.meta.dirname, '..');
const SRC = join(APP_ROOT, 'src');
/** The one place that imports Motion: the components of the design system, behind `components/ui/motion/motion.ts` (DESIGN_SYSTEM section 24a, 29.5). */
const MAY_IMPORT_MOTION = 'components/ui/';

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

/** Motion, or a package it is made of, named by an import, an export-from, a dynamic import or a require. */
const LIBRARY =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](?:motion|framer-motion|motion-dom|motion-utils)(?:\/[^'"]*)?['"]/i;

describe('Motion (DESIGN_SYSTEM section 24a and 29.5)', () => {
  // Break caught: a second door to Motion, so that a page animates in the library's own terms (a duration of its own, an easing of its own) and the motion
  // tokens stop being the one source. The components of components/ui are the one place that imports it.
  it('is imported by the components of the design system alone', () => {
    const outside = applicationSources()
      .filter((source) => LIBRARY.test(source.text))
      .map(relativePath)
      .filter((path) => !path.startsWith(MAY_IMPORT_MOTION));

    expect(outside).toEqual([]);
  });

  // Break caught: the components naming the library each in their own way, so that the one hook that reads the tokens and the preference for less motion
  // is skipped: they import it through `components/ui/motion/motion.ts`.
  it('is named by one file of the design system, and the components take it from there', () => {
    const naming = applicationSources()
      .filter((source) => LIBRARY.test(source.text))
      .map(relativePath);

    expect(naming.filter((path) => !path.startsWith('components/ui/motion/'))).toEqual([]);
    expect(naming).toContain('components/ui/motion/motion.ts');
    expect(naming).toContain('components/ui/motion/use-motion.ts');
  });

  // Break caught: a dependency installed and never used (the components that animate removed, the package left in package.json), which the audit and the
  // licence list would go on carrying.
  it('is used, so that it is not installed for nothing', () => {
    const manifest = JSON.parse(readFileSync(join(APP_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };

    expect(manifest.dependencies?.motion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(applicationSources().some((source) => LIBRARY.test(source.text))).toBe(true);
  });

  // Break caught: a component that writes a duration or an easing of its own to Motion instead of taking it from the tokens through the one hook.
  it('is given no duration and no easing but the tokens', () => {
    const own = applicationSources()
      .filter((source) => relativePath(source).startsWith(MAY_IMPORT_MOTION))
      .filter((source) => !relativePath(source).startsWith('components/ui/motion/'))
      .filter((source) =>
        /\b(?:duration|delay)\s*:\s*[\d.]+|\bease\s*:\s*(?:\[|['"])|\bstiffness\s*:|\bdamping\s*:|\btype\s*:\s*['"]spring['"]/.test(
          source.text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''),
        ),
      )
      .map(relativePath);

    expect(own).toEqual([]);
  });

  // Break caught: a check that reads one way of naming the library and misses the next.
  it('reads every way of naming the library', () => {
    for (const code of [
      "import { motion } from 'motion/react';",
      "import { animate } from 'motion';",
      "import { m } from 'framer-motion';",
      "export { AnimatePresence } from 'motion/react';",
      "const library = await import('motion/react');",
      "const library = require('framer-motion');",
      "import { frame } from 'motion-dom';",
    ]) {
      expect(LIBRARY.test(code), code).toBe(true);
    }
    for (const code of [
      "import { Other } from './motion-helpers';",
      "import { Other } from 'motionless';",
      "import { useMotion } from '../motion/motion';",
    ]) {
      expect(LIBRARY.test(code), code).toBe(false);
    }
  });
});
