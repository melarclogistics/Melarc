import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const APP_ROOT = resolve(import.meta.dirname, '..');
const SRC = join(APP_ROOT, 'src');
/** The one place that imports TanStack Table: the kit's DataTable (COMPONENT_PATTERNS section 37; task R5.2, M12). */
const MAY_IMPORT_TABLE = 'components/ui/data-table/';

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

/** TanStack Table, or the core it is made of, named by an import, an export-from, a dynamic import or a require. */
const LIBRARY =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]@tanstack\/(?:react-table|table-core)(?:\/[^'"]*)?['"]/i;

describe('TanStack Table (COMPONENT_PATTERNS section 37)', () => {
  // Break caught: a second door to TanStack Table, so that a screen builds a grid of its own (its own sorting, its own selection, its own keys and states) beside the
  // DataTable. ESLint refuses it too (`scripts/eslint-rules.test.ts`); this reads the sources, so that a rule that was loosened is still caught here.
  it('is imported by the DataTable alone', () => {
    const outside = applicationSources()
      .filter((source) => LIBRARY.test(source.text))
      .map(relativePath)
      .filter((path) => !path.startsWith(MAY_IMPORT_TABLE));

    expect(outside).toEqual([]);
  });

  // Break caught: a dependency installed and never used (the DataTable rebuilt without it, the package left in package.json), which the audit and the licence list
  // would go on carrying.
  it('is used by the DataTable, so that it is not installed for nothing', () => {
    const manifest = JSON.parse(readFileSync(join(APP_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };

    expect(manifest.dependencies?.['@tanstack/react-table']).toMatch(/^\d+\.\d+\.\d+$/);
    expect(
      applicationSources()
        .filter((source) => LIBRARY.test(source.text))
        .map(relativePath),
    ).toContain('components/ui/data-table/DataTable.tsx');
  });

  // Break caught: a check that reads one way of naming the library and misses the next.
  it('reads every way of naming the library', () => {
    for (const code of [
      "import { useReactTable } from '@tanstack/react-table';",
      "import type { ColumnDef } from '@tanstack/react-table';",
      "import { createTable } from '@tanstack/table-core';",
      "export { flexRender } from '@tanstack/react-table';",
      "const table = await import('@tanstack/react-table');",
      "const table = require('@tanstack/table-core');",
      "import { x } from '@tanstack/react-table/dist/index';",
    ]) {
      expect(LIBRARY.test(code), code).toBe(true);
    }
    for (const code of [
      "import { useQuery } from '@tanstack/react-query';",
      "import { Other } from './react-table-helpers';",
      "import { Other } from '@tanstack/react-tables';",
    ]) {
      expect(LIBRARY.test(code), code).toBe(false);
    }
  });
});
