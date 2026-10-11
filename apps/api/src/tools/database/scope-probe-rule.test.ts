import { describe, expect, it } from 'vitest';

import { scopeProbePolicyProblem } from './scope-probe-rule.js';

const PROBE = "melarc.principal_type() = 'STAFF' AND id = melarc.scope_probe_id()";

describe('scopeProbePolicyProblem: the probe predicate belongs to a FOR SELECT policy only (SECURITY_DESIGN.md §14.4b)', () => {
  // Break caught: the rule refusing the one place the predicate is meant to be.
  it('accepts the predicate in a policy for SELECT', () => {
    expect(scopeProbePolicyProblem('select', [PROBE])).toBeUndefined();
  });

  it('accepts a policy that does not mention the predicate, for any command', () => {
    for (const command of ['all', 'select', 'insert', 'update', 'delete'] as const) {
      expect(
        scopeProbePolicyProblem(command, ['hub_id = ANY (melarc.authorized_hub_ids())', null]),
      ).toBeUndefined();
    }
  });

  // Break caught: the predicate in a policy that also governs another command. For UPDATE it admits an old row the staff
  // does not hold, and for DELETE it removes one; for ALL it does both, because the clause of a policy for ALL is the
  // clause of every command.
  it.each(['all', 'insert', 'update', 'delete'] as const)(
    'refuses the predicate in a policy for %s',
    (command) => {
      expect(scopeProbePolicyProblem(command, [PROBE])).toMatch(
        /belongs in a policy FOR SELECT only/,
      );
    },
  );

  it('refuses it in either clause, and as the pg_get_expr form', () => {
    expect(scopeProbePolicyProblem('all', [null, PROBE])).toMatch(/FOR SELECT only/);
    expect(
      scopeProbePolicyProblem('all', [
        '((hub_id = ANY (melarc.authorized_hub_ids())) OR (id = melarc.scope_probe_id()))',
      ]),
    ).toMatch(/FOR SELECT only/);
  });

  // Break caught: the command not being known (ALTER POLICY does not show it), which must not be read as SELECT.
  it('refuses it when the command is not known', () => {
    expect(scopeProbePolicyProblem(undefined, [PROBE])).toMatch(/FOR SELECT only/);
  });

  // Break caught: a mention in a string that is data being read as the predicate.
  it('does not read the name inside a string', () => {
    expect(scopeProbePolicyProblem('all', ["note = 'melarc.scope_probe_id()'"])).toBeUndefined();
  });
});
