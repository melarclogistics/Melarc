import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The Ops Portal's navigation and its guards decide from permission keys and from nothing else: no role name, no bundle (surfaces/ops-portal.md
 * section 4: "no bundle contents, credential or role name is returned or inferred", and the stop condition of S0.42, "Navigation would need a role
 * name"). A test can say what a Senior Ops person would see, because it is a test and has the keys of that bundle written out beside the name
 * (`src/test-support/bundle-key-sets.ts`); production code cannot, and this reads the production code to be sure.
 */
const APP_SRC = resolve(import.meta.dirname, '../src');

/** The bundles of the permission catalogue (contracts/permissions.md section 8), as a person would write them in a menu or a condition. */
const BUNDLE_NAMES = [
  'Ops Staff',
  'Senior Ops',
  'Platform Admin',
  'Finance/Reconciliation',
  'Auditor',
  'Executive',
  'Fleet Manager',
  'Customer Support',
  'Warehouse Supervisor',
];

/** What decides what a person may see: the registry, the shell, the navigation, and the guards of the session. */
const DECIDERS = [
  'app/navigation',
  'app/AuthenticatedOpsShell.tsx',
  'app/routes.tsx',
  'components/PrimaryNavigation.tsx',
  'components/side-menu',
  'platform/session',
];

function sourceFiles(path: string): string[] {
  const absolute = join(APP_SRC, path);
  let entries;
  try {
    entries = readdirSync(absolute, { withFileTypes: true });
  } catch {
    return [absolute];
  }
  return entries.flatMap((entry) => {
    const child = join(absolute, entry.name);
    return entry.isDirectory() ? sourceFiles(relative(APP_SRC, child)) : [child];
  });
}

const production = (file: string): boolean =>
  /\.(ts|tsx)$/.test(file) && !/\.test\.(ts|tsx)$/.test(file);

/** The code with its comments taken out, so that a sentence about roles in a comment is not mistaken for a role in a condition. */
function codeOf(text: string): string {
  return text.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('navigation and guards name no role', () => {
  const files = DECIDERS.flatMap(sourceFiles).filter(production);

  it('reads the files that decide, and not a scan over nothing', () => {
    const names = files.map((file) => relative(APP_SRC, file).split(sep).join('/'));

    expect(names).toEqual(
      expect.arrayContaining([
        'app/AuthenticatedOpsShell.tsx',
        'app/navigation/route-registry.tsx',
        'components/PrimaryNavigation.tsx',
        'platform/session/RequirePermission.tsx',
      ]),
    );
    expect(files.length).toBeGreaterThan(8);
  });

  // Break caught: a role name in a condition or a menu label, which makes the menu a statement about a kind of person and not about a key.
  it.each(BUNDLE_NAMES)('does not mention %s in code', (bundle) => {
    const mentions = files
      .filter((file) => codeOf(readFileSync(file, 'utf8')).includes(bundle))
      .map((file) => relative(APP_SRC, file).split(sep).join('/'));

    expect(mentions).toEqual([]);
  });

  // Break caught: the test-only key sets leaking into production code, where they would be a second description of the bundles.
  it('is not given the bundles’ key sets by any production file', () => {
    const everything = sourceFiles('.')
      .filter(production)
      .filter((file) => !relative(APP_SRC, file).startsWith(`test-support${sep}`));
    const importers = everything
      .filter((file) => readFileSync(file, 'utf8').includes('bundle-key-sets'))
      .map((file) => relative(APP_SRC, file).split(sep).join('/'));

    expect(importers).toEqual([]);
  });

  it('finds a role name when there is one, so the scan can fail', () => {
    expect(codeOf("const menu = isSenior ? 'Senior Ops' : 'none';")).toContain('Senior Ops');
    expect(codeOf('// Senior Ops see this\nconst x = 1;')).not.toContain('Senior Ops');
    expect(codeOf('/* Platform Admin */ const y = 2;')).not.toContain('Platform Admin');
  });
});
