import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  applyChanges,
  RELEASE_2,
  RELEASE_2_REVISION,
  type SourceChange,
} from './policy-release.js';

const SOURCE_ROOT = resolve(import.meta.dirname, '../../src');
const read = (file: string) =>
  readFileSync(join(SOURCE_ROOT, file), 'utf8').replaceAll('\r\n', '\n');

/**
 * The second build of S0.63 is the repository's source with the release's changes, so the changes are held to the source here, without
 * compiling: a source edit that moves one of them fails this test (and the proof would refuse to build) instead of compiling a release
 * that no longer says what the proof claims.
 */
describe('the release the two-build proof compiles (S0.63)', () => {
  // Break caught: a change that silently stops applying (the source moved) or applies twice, leaving a second build that differs from
  // the first in something other than what the proof says, or in nothing.
  it('changes each file in exactly the one place it names, and nothing else', () => {
    const changed = applyChanges(RELEASE_2);
    for (const change of RELEASE_2) {
      const original = read(change.file);
      const [after] = [...changed.entries()].filter(
        ([path]) =>
          path.endsWith(
            change.file.replaceAll('/', process.platform === 'win32' ? '\\' : '/').toLowerCase(),
          ) || path.endsWith(change.file),
      );
      expect(after?.[1]).toBe(original.replace(change.from, change.to));
      expect(after?.[1]).not.toBe(original);
    }
    expect(changed.size).toBe(RELEASE_2.length);
  });

  it('raises both compiled revisions above the current build’s, and changes a predicate of each audience', () => {
    expect(read('app.module.ts')).toContain('Object.freeze({ VENDOR: 1, RIDER: 1 })');
    expect(RELEASE_2_REVISION).toEqual({ VENDOR: 2, RIDER: 2 });
    expect(RELEASE_2.map((change) => change.file).toSorted()).toEqual([
      'app.module.ts',
      'settings/reason-definitions.controller.ts',
      'settings/rider-assigned-work.ts',
    ]);
  });

  // Break caught: a replacement read as a pattern (`$&` stands for the text it replaces), which would put the replaced text, and not the
  // release's, into the second build.
  it('puts the replacement in as it is written, whatever characters it holds', () => {
    const [first] = RELEASE_2;
    if (first === undefined) throw new Error('the release changes something');
    const [after] = [...applyChanges([{ ...first, to: 'A$&B$1C$$D' }]).values()];
    expect(after).toContain('A$&B$1C$$D');
    expect(after).not.toContain(`A${first.from}B`);
  });

  it('refuses a change that is not in the source, or is there more than once', () => {
    const absent: SourceChange = {
      file: 'app.module.ts',
      from: 'no such text in the module',
      to: 'x',
    };
    const twice: SourceChange = { file: 'app.module.ts', from: 'import', to: 'x' };
    expect(() => applyChanges([absent])).toThrow(/0 times, not once/);
    expect(() => applyChanges([twice])).toThrow(/times, not once/);
  });
});
