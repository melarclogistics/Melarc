import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = join(resolve(import.meta.dirname, '..'), 'src');
/** The one place that writes into the cache: it lets go of a read already on its way first (`platform/query/write-answer.ts`). */
const THE_DOOR = 'platform/query/write-answer.ts';

interface Source {
  readonly path: string;
  readonly text: string;
}

/** The application's own sources: not tests and not test support. */
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

describe('the answer of an act is written into the cache through one door (run 7, Stage 2.2)', () => {
  // Break caught: a page that writes an act's answer into the cache with `setQueryData` while a read of the same key is on its way, so that the read, sent before the act and answered after
  // it, puts the version before the act back and the next act is refused with 412.
  it('is written by `writeAnswer` alone, and no other file calls `setQueryData`', () => {
    const writing = applicationSources()
      .filter((source) => /\bsetQueryData\b/.test(source.text))
      .map(relativePath);

    expect(writing).toEqual([THE_DOOR]);
  });

  // Break caught: the door left unused, or one of the three places that keep an answer writing around it in another way.
  it('is used by the three places that keep an act’s answer', () => {
    const using = applicationSources()
      .filter((source) => /\bwriteAnswer\s*(?:<[^>(]*>)?\s*\(/.test(source.text))
      .map(relativePath)
      .filter((path) => path !== THE_DOOR)
      .sort();

    expect(using).toEqual([
      'app/pages/manifests/CustodySection.tsx',
      'app/pages/manifests/ManifestDetailPage.tsx',
      'app/pages/pickup/PickupRequestListPage.tsx',
    ]);
  });

  // Break caught: the door writing without letting go of the read first.
  it('lets go of the reads of the key before it writes', () => {
    const door = readFileSync(join(SRC, THE_DOOR), 'utf8');
    const cancelled = door.indexOf('queryClient.cancelQueries');
    const written = door.indexOf('queryClient.setQueryData');

    expect(cancelled).toBeGreaterThan(-1);
    expect(written).toBeGreaterThan(cancelled);
  });
});
