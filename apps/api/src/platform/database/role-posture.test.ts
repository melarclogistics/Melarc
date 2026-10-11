import { describe, expect, it } from 'vitest';

import { POSTURE_FLAGS, ROLE_POSTURE_SQL, unsafeFlags } from './role-posture.js';

const SAFE = Object.fromEntries(POSTURE_FLAGS.map((flag) => [flag, false]));

describe('unsafeFlags: what a runtime login may not be (SECURITY_DESIGN.md §14.6)', () => {
  // Break caught: a safe role reported as unsafe, which would keep every instance from starting.
  it('reports nothing for a role with no power', () => {
    expect(unsafeFlags({ role: 'melarc_api_runtime', ...SAFE })).toEqual([]);
  });

  // Break caught: a flag the list does not check, so a power can be granted and nothing notices. Every flag, alone,
  // makes the role unsafe and is the one reported.
  it.each(POSTURE_FLAGS)('reports %s, and only it', (flag) => {
    expect(unsafeFlags({ role: 'melarc_api_runtime', ...SAFE, [flag]: true })).toEqual([flag]);
  });

  // Break caught: a flag that reads as safe because the inspection did not return it (a renamed column, a query that
  // gained a case and lost a field). Absent, null or not a boolean is not "false": an inspection that could not say is
  // not a clean bill, and the role is refused.
  it.each([
    ['absent', undefined],
    ['null', null],
    ['the text false', 'false'],
    ['zero', 0],
  ])('treats a flag that is %s as unsafe', (_label, value) => {
    const posture = { role: 'melarc_api_runtime', ...SAFE, owns_schema: value };
    expect(unsafeFlags(posture)).toEqual(['owns_schema']);
  });

  it('lists every flag it checks in the order of the list', () => {
    const everything = Object.fromEntries(POSTURE_FLAGS.map((flag) => [flag, true]));
    expect(unsafeFlags({ role: 'x', ...everything })).toEqual([...POSTURE_FLAGS]);
  });
});

describe('ROLE_POSTURE_SQL', () => {
  // Break caught: a flag in the list that the query does not compute, so that it can never be true (and, with the
  // fail-closed reading above, can never be false either: the role would be refused for ever).
  it.each(POSTURE_FLAGS)('computes %s', (flag) => {
    expect(ROLE_POSTURE_SQL).toMatch(new RegExp(`\\b${flag}\\b`));
  });

  // Break caught: a query that inspects the pool's login only, which would leave the worker and provisioning logins to
  // the catalogue check with nothing to run. The role is a parameter, and the connected one when it is null.
  it('inspects the named role, or the connected one when none is named', () => {
    expect(ROLE_POSTURE_SQL).toMatch(/coalesce\(\$1::text, current_user\)/);
  });
});
