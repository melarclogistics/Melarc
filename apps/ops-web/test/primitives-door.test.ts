import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const APP_ROOT = resolve(import.meta.dirname, '..');
const SRC = join(APP_ROOT, 'src');
/** The one place that imports Radix UI and the libraries beside it: the shadcn/ui primitives, generated source (DESIGN_SYSTEM section 24a, 29). */
const PRIMITIVES = 'components/primitives/';
/** The places that may import a primitive: the components of the design system, the dev-only showcase, and a primitive another. */
const MAY_IMPORT_A_PRIMITIVE = ['components/ui/', 'showcase/', PRIMITIVES];

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

/** A module of Radix UI, or of the libraries beside it, named by an import, an export-from, a dynamic import or a require. */
const LIBRARY =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](?:radix-ui|@radix-ui|cmdk|vaul|sonner|react-day-picker)(?:\/[^'"]*)?['"]/i;

/** A primitive, named by the alias (`@/components/primitives/button`) or by a relative path that goes through the folder of the primitives. */
const PRIMITIVE =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](?:@\/|(?:\.{1,2}\/)+)(?:[^'"]*\/)?primitives(?:\/[^'"]*)?['"]/;

describe('Radix UI and the shadcn/ui primitives (DESIGN_SYSTEM section 24a and 29)', () => {
  // Break caught: a second door to Radix UI, so that a page draws a widget in the library's own terms and the one look and the one API of the
  // design system drift. The primitives are the one place that imports it, and the lint rule says so too.
  it('are imported by the primitives alone', () => {
    const outside = applicationSources()
      .filter((source) => LIBRARY.test(source.text))
      .map(relativePath)
      .filter((path) => !path.startsWith(PRIMITIVES));

    expect(outside).toEqual([]);
  });

  // Break caught: a dependency installed and never used (a primitive removed, its library left in package.json), which the audit and the
  // licence list would go on carrying. Every one of the libraries the package names is imported by a primitive.
  it('are each imported by a primitive, so that no library is installed unused', () => {
    const manifest = JSON.parse(readFileSync(join(APP_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const installed = ['radix-ui', 'cmdk', 'vaul', 'sonner', 'react-day-picker'].filter(
      (name) => manifest.dependencies?.[name] !== undefined,
    );
    const primitives = applicationSources().filter((source) =>
      relativePath(source).startsWith(PRIMITIVES),
    );

    expect(installed).toContain('radix-ui');
    for (const name of installed) {
      const imports = new RegExp(`\\bfrom\\s*['"]${name}(?:/[^'"]*)?['"]`);
      expect(
        primitives.some((source) => imports.test(source.text)),
        name,
      ).toBe(true);
    }
  });

  // Break caught: a page that draws a primitive, so that the Melarc component (its words, its states, its tokens) is skipped and the primitive
  // is restyled for one screen. The components of components/ui import a primitive; a page imports the component.
  it('are imported as a primitive by the components of the design system, the showcase and the primitives alone', () => {
    const outside = applicationSources()
      .filter((source) => PRIMITIVE.test(source.text))
      .map(relativePath)
      .filter((path) => !MAY_IMPORT_A_PRIMITIVE.some((place) => path.startsWith(place)));

    expect(outside).toEqual([]);
  });

  // Break caught: a check that only reads the one way of naming the library that was thought of (`from`), so that a dynamic import, a
  // require, a side-effect import or a deep path slips past it; and one that takes a library file of the same name for a primitive.
  it('reads every way of naming the libraries and the primitives', () => {
    for (const code of [
      "import { Dialog } from 'radix-ui';",
      "import * as Dialog from '@radix-ui/react-dialog';",
      "export { Slot } from '@radix-ui/react-slot';",
      "import 'cmdk';",
      "import { Drawer } from 'vaul';",
      "import { Toaster } from 'sonner';",
      "import { DayPicker } from 'react-day-picker';",
      "import { DayPicker } from 'react-day-picker/locale';",
      "const library = await import('radix-ui');",
      "const library = await import ( '@radix-ui/react-popover' );",
      "const library = require('cmdk');",
      "import { Dialog } from 'RADIX-UI';",
    ]) {
      expect(LIBRARY.test(code), code).toBe(true);
    }
    for (const code of [
      "import { Other } from './radix-ui-helpers';",
      "import { Other } from '@radix-ui-helpers/other';",
      "import { Other } from 'sonner-utils';",
      "const other = await import('other-library');",
    ]) {
      expect(LIBRARY.test(code), code).toBe(false);
    }
    for (const code of [
      "import { Button } from '@/components/primitives/button';",
      "import { Button } from '../../primitives/button';",
      "import { Button } from '../primitives/button';",
      "export { Button } from './primitives/button';",
      "const sheet = await import('@/components/primitives/sheet');",
      "import { buttonVariants } from '../../../components/primitives/button';",
    ]) {
      expect(PRIMITIVE.test(code), code).toBe(true);
    }
    for (const code of [
      "import { Button } from '@/components/ui/button/Button';",
      "import { Button } from './Button';",
      "import { Other } from 'primitives';",
      "import { Other } from './primitives-helpers';",
    ]) {
      expect(PRIMITIVE.test(code), code).toBe(false);
    }
  });

  // Break caught: the one door left open by a name that is not in the list the lint rule and this test share, such as the sub-packages that a
  // page could import by their short names.
  it('names the libraries in the lint rule as the test does', () => {
    const config = readFileSync(resolve(APP_ROOT, '../../eslint.config.mjs'), 'utf8');

    for (const name of [
      'radix-ui',
      'cmdk',
      'vaul',
      'sonner',
      'react-day-picker',
      'radix-ui/*',
      '@radix-ui/*',
      'cmdk/*',
      'vaul/*',
      'sonner/*',
      'react-day-picker/*',
      '**/components/primitives',
      '**/components/primitives/*',
      '@/components/primitives',
      '@/components/primitives/*',
    ]) {
      expect(config, name).toContain(`'${name}'`);
    }
    // The dynamic import and the require are watched by the same list: a name between two bars (or a bar and a bracket) of DOOR_PACKAGES.
    for (const name of ['radix-ui', '@radix-ui', 'cmdk', 'vaul', 'sonner', 'react-day-picker']) {
      expect(config, name).toMatch(new RegExp(`DOOR_PACKAGES =[^;]*[(|]${name}[|)]`));
    }
  });
});
