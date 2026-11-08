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

/** The text of a call from its opening parenthesis to the one that closes it. */
function balanced(text: string, open: number): string {
  let depth = 0;
  for (let at = open; at < text.length; at += 1) {
    if (text[at] === '(') depth += 1;
    if (text[at] === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(open, at + 1);
    }
  }
  return text.slice(open);
}

/** The permission keys each bundle variable is granted, from the three ways the seed writes a grant. */
function grantedKeys(text: string): Map<string, string[]> {
  const keys = new Map<string, string[]>();
  const add = (variable: string, key: string): void => {
    keys.set(variable, [...(keys.get(variable) ?? []), key]);
  };
  // SLICE-001 names its keys in lists (`OPS_STAFF_KEYS_001`) and composes a bundle's grants from them: `...staff(BUNDLE_IDS.seniorOps, 'S',
  // own([...OPS_STAFF_KEYS_001, ...SENIOR_ONLY_KEYS_001]))`. A bundle holds every list its call names.
  const lists = new Map<string, string[]>();
  for (const list of text.matchAll(/const ([A-Z][A-Z0-9_]*_001) = \[([\s\S]*?)\] as const;/g)) {
    const [, name, inner] = list;
    if (name === undefined || inner === undefined) continue;
    lists.set(
      name,
      [...inner.matchAll(/'([a-z0-9_.]+)'/g)].flatMap((each) =>
        each[1] === undefined ? [] : [each[1]],
      ),
    );
  }
  for (const call of text.matchAll(/\.\.\.staff\(/g)) {
    const body = balanced(text, call.index + '...staff'.length);
    const variable = /BUNDLE_IDS\.(\w+)/.exec(body)?.[1];
    if (variable === undefined) continue;
    const named = new Set(
      [...body.matchAll(/\b([A-Z][A-Z0-9_]*_001)\b/g)].flatMap((each) =>
        each[1] === undefined ? [] : [each[1]],
      ),
    );
    for (const name of named) for (const key of lists.get(name) ?? []) add(variable, key);
    // The grants written out one by one (`['staff.read', 'own']`) are read from the call's own text. A pattern that ran on to the first
    // `])` after it would take a later call's grants for this bundle's when this call ends in `.map(...)` (the Platform Admin's SLICE-001
    // call did, and swallowed the message log's `NOTIFICATION_READ_GRANTS` that follow it).
    for (const grant of body.matchAll(/\['([a-z0-9_.]+)',\s*'(?:own|all|none)'\]/g)) {
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
    // The keys of SLICE-001 are written as named lists composed into each bundle's call, and are read too: Ops Staff hold the approval, and
    // the extension of the attempt cap starts at Senior Ops.
    assert.ok((seeded.get('Ops Staff') ?? []).includes('pickup.exception.approve'));
    assert.ok(!(seeded.get('Ops Staff') ?? []).includes('pickup.attempt.extend'));
    assert.ok((seeded.get('Senior Ops') ?? []).includes('pickup.attempt.extend'));
    assert.ok((seeded.get('Finance/Reconciliation') ?? []).includes('pricing.read'));
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
