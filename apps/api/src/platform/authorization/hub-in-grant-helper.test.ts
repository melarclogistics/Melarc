import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { effectiveScope, scopeExcludesHub, scopeIncludesHub } from './effective-scope.js';

/**
 * "Is this hub in the grant" has one answer (task A3.6 of the audit follow-up, the Product Owner's decision of 7 November 2026): `scopeIncludesHub`, which the
 * booking of a request, the creation and change of a staff profile, the scope probe and the short answer of every list call. Four copies of the comparison
 * existed and could have come to disagree about a hub (one lower-cased, another not, one reading an empty set as "all").
 */
const HUB_A = '0191a4f8-6c2e-7a3e-8f10-5d6c7b8a9e0a';
const HUB_B = '0191a4f8-6c2e-7a3e-8f10-5d6c7b8a9e0b';

describe('scopeIncludesHub', () => {
  // Break caught: a set compared on the text of the identifier, so that a hub written in capitals (the same hub) is outside the grant.
  it('finds a hub of the set whatever the case of its identifier', () => {
    const own = effectiveScope({ hubScope: 'own' }, [HUB_A]);

    expect(scopeIncludesHub(own, HUB_A)).toBe(true);
    expect(scopeIncludesHub(own, HUB_A.toUpperCase())).toBe(true);
    expect(
      scopeIncludesHub(effectiveScope({ hubScope: 'own' }, [HUB_A.toUpperCase()]), HUB_A),
    ).toBe(true);
  });

  // Break caught: a hub that the set does not hold reached, or the empty set (a session with no hub, `GBT-B5`) read as every hub.
  it('does not find a hub the set lacks, and an empty set reaches no hub', () => {
    expect(scopeIncludesHub(effectiveScope({ hubScope: 'own' }, [HUB_A]), HUB_B)).toBe(false);
    expect(scopeIncludesHub(effectiveScope({ hubScope: 'own' }, []), HUB_A)).toBe(false);
    expect(scopeIncludesHub(effectiveScope({ hubScope: 'none' }, [HUB_A]), HUB_A)).toBe(false);
    expect(scopeIncludesHub(effectiveScope(undefined, [HUB_A]), HUB_A)).toBe(false);
  });

  // Break caught: the all-hub mode answered from its (empty, unused) set, which would turn the grant of every hub into one of none.
  it('reaches every hub for the all-hub mode, whatever its set holds', () => {
    const everywhere = effectiveScope({ hubScope: 'all' }, [HUB_A]);

    expect(scopeIncludesHub(everywhere, HUB_A)).toBe(true);
    expect(scopeIncludesHub(everywhere, HUB_B)).toBe(true);
    expect(scopeIncludesHub({ hubScopeMode: 'ALL' }, HUB_B)).toBe(true);
  });

  // Break caught: a security context (whose two members are optional) with no mode and no set reaching a hub, which a hand-written copy did by accident.
  it('treats a scope with no mode and no set as one that reaches no hub', () => {
    expect(scopeIncludesHub({}, HUB_A)).toBe(false);
    expect(scopeIncludesHub({ hubScopeMode: 'SET' }, HUB_A)).toBe(false);
  });
});

describe('scopeExcludesHub, which the short answer of a list calls', () => {
  // Break caught: the two answers drifting apart: the list answers empty for a hub the booking would accept, or the other way round.
  it('is scopeIncludesHub turned round, for every kind of scope', () => {
    const scopes = [
      effectiveScope({ hubScope: 'own' }, [HUB_A]),
      effectiveScope({ hubScope: 'own' }, []),
      effectiveScope({ hubScope: 'all' }, []),
      effectiveScope({ hubScope: 'none' }, [HUB_A]),
      effectiveScope(undefined, [HUB_A]),
    ];
    for (const scope of scopes) {
      for (const hub of [HUB_A, HUB_A.toUpperCase(), HUB_B]) {
        expect(scopeExcludesHub(scope, hub)).toBe(!scopeIncludesHub(scope, hub));
      }
    }
  });
});

describe('the comparison exists once', () => {
  // Break caught: a fifth copy of the comparison in a service or a guard, which is how the four before it could disagree. The scan reads the production source
  // for a hand-made search of a hub set (`authorizedHubIds` with `some`, `includes`, `indexOf`, `find` or `findIndex`); the helper's own file is the one place.
  it('is written in effective-scope.ts and nowhere else in the production source', () => {
    const root = join(import.meta.dirname, '..', '..');
    const files = readdirSync(root, { recursive: true, encoding: 'utf8' })
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .map((name) => name.replaceAll('\\', '/'))
      .filter((name) => name !== 'platform/authorization/effective-scope.ts');
    expect(files.length).toBeGreaterThan(100);

    const copies = files.filter((name) =>
      /authorizedHubIds[^;\n]{0,80}\.(some|includes|indexOf|find|findIndex)\(/.test(
        readFileSync(join(root, name), 'utf8'),
      ),
    );

    expect(copies).toEqual([]);
  });
});
