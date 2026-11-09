import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * A page asks the kit for what it needs through the component's own props and handle (`QueueWorkspaceHandle`, `DataTableHandle`) and never by a class of the kit's markup: the kit
 * changes its markup, and a page that looked for `.ui-data-table__scroller` would then fail without a word (the review of 5edada2, M4). This holds every file under `src/app/` to it:
 * no string in it names a class of the kit (`.ui-…`), as a selector, as a query or as a constant. There is no exception: the manifest list, the last page that knew the markup
 * of the old table, is drawn by the queue workspace since redesign step R7a.
 */
const APP = resolve(import.meta.dirname, '../src/app');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

/** What the source says outside its comments and the text of its strings: the strings themselves, with the comments taken out first. */
function stringsOf(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
  return [...code.matchAll(/(['"`])((?:(?!\1)[^\\\n]|\\.)*)\1/g)].map((match) => match[2] ?? '');
}

/** The strings of a source that name a class of the kit: a dot, `ui-`, and a letter. */
function kitClassesNamed(source: string): string[] {
  return stringsOf(source).filter((text) => /\.ui-[a-z]/.test(text));
}

describe('the pages of the application', () => {
  // Break caught: a page that finds a row, a box or a region of the kit by its class, as `queue-return.ts` and two pages did before the queue workspace gave them a handle.
  it('name no class of the kit in a string, so that they ask the component and never its markup', () => {
    const found = sourceFiles(APP)
      .map((path) => ({
        file: relative(APP, path).replaceAll('\\', '/'),
        named: kitClassesNamed(readFileSync(path, 'utf8')),
      }))
      .filter(({ named }) => named.length > 0);

    expect(found).toEqual([]);
  });

  // Break caught: the check that finds nothing because it reads nothing, or that is fooled by a comment or by a string that only looks like a class.
  it('read the strings of a source: a query by a class is found, a comment and a name without a dot are not', () => {
    expect(kitClassesNamed(`const box = root.querySelector('.ui-data-table__scroller');`)).toEqual([
      '.ui-data-table__scroller',
    ]);
    expect(kitClassesNamed('const selector = `button.ui-data-table__open`;')).toEqual([
      'button.ui-data-table__open',
    ]);
    expect(kitClassesNamed(`closest("[data-row-id], .ui-queue-table__card")`)).toHaveLength(1);
    expect(kitClassesNamed(`// the .ui-data-table__scroller of the kit\nconst a = 1;`)).toEqual([]);
    expect(kitClassesNamed(`/* a '.ui-read-state' in a comment */ const a = 1;`)).toEqual([]);
    expect(
      kitClassesNamed(`const own = 'pickup-queue'; const url = 'https://a.example/ui-kit';`),
    ).toEqual([]);
    expect(kitClassesNamed(`const own = '.pickup-queue .pickup-nowrap';`)).toEqual([]);
  });
});
