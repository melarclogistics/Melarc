import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { BUNDLE_KEY_SETS } from '../apps/ops-web/src/test-support/bundle-key-sets.ts';

/**
 * The Ops Portal's navigation tests need to know what a person of each kind would see, and the only place that says which permission keys a
 * bundle holds is the seed (apps/api/src/tools/seed/bundles.ts), which the Ops Portal must not import: it names no role and decides from keys
 * (surfaces/ops-portal.md section 4). So the tests carry a copy of the keys, labelled with the bundle's name, in
 * `apps/ops-web/src/test-support/bundle-key-sets.ts`, and this holds that copy to the seed: a key granted or withdrawn in the seed without the
 * copy following fails here, and a navigation test cannot go on describing a person who no longer exists.
 *
 * The seed is read as text, not imported: it is the API's, and a root script has no business loading it.
 */
const SEED = readFileSync(
  resolve(import.meta.dirname, '../apps/api/src/tools/seed/bundles.ts'),
  'utf8',
);

const SORT = (keys: readonly string[]): string[] => [...keys].toSorted();

/** The staff bundles of the seed: the name by the identifier the grants refer to. */
function seededStaffBundles(text: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const match of text.matchAll(
    /id:\s*BUNDLE_IDS\.(\w+),\s*name:\s*'([^']+)',\s*audience:\s*'STAFF'/g,
  )) {
    const [, variable, name] = match;
    if (variable !== undefined && name !== undefined) names.set(variable, name);
  }
  return names;
}

/** The permission keys each bundle variable is granted, from the two ways the seed writes a grant. */
function grantedKeys(text: string): Map<string, string[]> {
  const keys = new Map<string, string[]>();
  const add = (variable: string, key: string): void => {
    keys.set(variable, [...(keys.get(variable) ?? []), key]);
  };
  for (const block of text.matchAll(
    /\.\.\.staff\(\s*BUNDLE_IDS\.(\w+),\s*'[ASP]',\s*\[([\s\S]*?)\]\s*\)/g,
  )) {
    const [, variable, inner] = block;
    if (variable === undefined || inner === undefined) continue;
    for (const grant of inner.matchAll(/\['([a-z0-9_.]+)',\s*'(?:own|all|none)'\]/g)) {
      const [, key] = grant;
      if (key !== undefined) add(variable, key);
    }
  }
  for (const grant of text.matchAll(
    /bundleId:\s*BUNDLE_IDS\.(\w+),\s*permissionKey:\s*'([a-z0-9_.]+)'/g,
  )) {
    const [, variable, key] = grant;
    if (variable !== undefined && key !== undefined) add(variable, key);
  }
  return keys;
}

describe('the bundle key sets of the navigation tests against the seed', () => {
  const staff = seededStaffBundles(SEED);
  const granted = grantedKeys(SEED);
  const seeded = new Map<string, readonly string[]>(
    [...staff].map(([variable, name]) => [name, SORT(granted.get(variable) ?? [])]),
  );

  // Break caught: a reader that finds nothing, which would let the comparison below pass over empty sets.
  it('reads the staff bundles and their grants out of the seed', () => {
    assert.ok(seeded.size >= 4, `staff bundles read: ${String(seeded.size)}`);
    for (const [name, keys] of seeded) {
      assert.ok(keys.length >= 1, `${name} has no grant read from the seed`);
    }
    assert.ok((seeded.get('Ops Staff') ?? []).includes('settings.reason.read'));
    assert.ok((seeded.get('Platform Admin') ?? []).includes('staff.mfa.reset'));
  });

  it('holds exactly the staff bundles the seed has', () => {
    assert.deepEqual([...seeded.keys()].toSorted(), Object.keys(BUNDLE_KEY_SETS).toSorted());
  });

  for (const [name, keys] of Object.entries(BUNDLE_KEY_SETS)) {
    it(`holds the keys the seed grants ${name}`, () => {
      assert.deepEqual(SORT(keys), seeded.get(name));
    });
  }

  // Break caught: the comparison being unable to fail because it compares a thing with itself.
  it('can fail: a copy with a key more or less is reported', () => {
    const real = SORT(BUNDLE_KEY_SETS['Ops Staff']);
    assert.notDeepEqual(SORT([...real, 'staff.read']), seeded.get('Ops Staff'));
    assert.notDeepEqual(real.slice(1), seeded.get('Ops Staff'));
  });

  it('reads nothing from a seed of another shape, so a change of the seed’s shape cannot pass quietly', () => {
    assert.equal(seededStaffBundles('const nothing = 1;').size, 0);
    assert.equal(grantedKeys('const nothing = 1;').size, 0);
  });
});
