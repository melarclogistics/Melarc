import { describe, expect, it } from 'vitest';

import { policyClauseProblems, systemBranchProblems } from './system-branch.js';

/** Expressions as `pg_get_expr` prints them, and as a migration spells them: both must be read the same way. */
describe('systemBranchProblems: a SYSTEM branch that names exactly one capability (GBT-E7)', () => {
  // Break caught: the analyser flagging the shape the design prescribes (SECURITY_DESIGN.md §14.4).
  it.each([
    [
      'a CASE arm that tests the capability, as the migration writes it',
      `CASE melarc.principal_type()
         WHEN 'STAFF' THEN melarc.hub_scope_mode() = 'ALL' OR hub_id = ANY (melarc.authorized_hub_ids())
         WHEN 'SYSTEM' THEN melarc.task_capability() = 'seed'
         ELSE false
       END`,
    ],
    [
      'a CASE arm as pg_get_expr prints it',
      `CASE melarc.principal_type() WHEN 'STAFF'::text THEN ((melarc.hub_scope_mode() = 'ALL'::text) OR (hub_id = ANY (melarc.authorized_hub_ids()))) WHEN 'SYSTEM'::text THEN (melarc.task_capability() = 'authentication'::text) ELSE false END`,
    ],
    [
      'a capability test joined to a further condition by AND',
      `CASE melarc.principal_type() WHEN 'SYSTEM' THEN melarc.task_capability() = 'bootstrap' AND created_by = melarc.current_principal_id() ELSE false END`,
    ],
    [
      'the capability test written the other way round',
      `CASE melarc.principal_type() WHEN 'SYSTEM' THEN 'rate_limit' = melarc.task_capability() ELSE false END`,
    ],
    [
      'an Outbox-derived arm',
      `CASE melarc.principal_type() WHEN 'SYSTEM' THEN responsible_hub_id = melarc.outbox_hub_id() AND melarc.outbox_task_permits('order') ELSE false END`,
    ],
    [
      'an expression with no SYSTEM in it',
      `CASE melarc.principal_type() WHEN 'STAFF' THEN true ELSE false END`,
    ],
    ['an empty expression', ''],
  ])('accepts %s', (_label, expression) => {
    expect(systemBranchProblems(expression)).toEqual([]);
  });

  // Break caught: the blanket policy the design replaces. SYSTEM alone opens the table to every task.
  it.each([
    [
      'a CASE arm that opens the table',
      `CASE melarc.principal_type() WHEN 'SYSTEM' THEN true ELSE false END`,
    ],
    [
      'a CASE arm that tests the hub scope and no capability',
      `CASE melarc.principal_type() WHEN 'SYSTEM' THEN melarc.hub_scope_mode() = 'ALL' ELSE false END`,
    ],
    [
      'a capability test somewhere else in the policy, not in the SYSTEM arm',
      `CASE melarc.principal_type() WHEN 'STAFF' THEN melarc.task_capability() = 'seed' WHEN 'SYSTEM' THEN true ELSE false END`,
    ],
    [
      'an arm of SYSTEM followed by another arm',
      `CASE melarc.principal_type() WHEN 'SYSTEM' THEN true WHEN 'STAFF' THEN melarc.task_capability() = 'seed' ELSE false END`,
    ],
    [
      'a SYSTEM arm as the last before END, with the capability test in an earlier arm',
      `CASE melarc.principal_type() WHEN 'STAFF' THEN melarc.task_capability() = 'seed' WHEN 'SYSTEM' THEN responsible_hub_id IS NOT NULL END`,
    ],
  ])('refuses %s', (_label, expression) => {
    expect(systemBranchProblems(expression).join('\n')).toMatch(/SYSTEM arm .*capability/);
  });

  // Break caught: SYSTEM added with an OR to a policy that already admits someone, which is the blanket widening.
  it.each([
    [
      'an OR against the SYSTEM principal type',
      `hub_id = ANY (melarc.authorized_hub_ids()) OR melarc.principal_type() = 'SYSTEM'`,
    ],
    [
      'pg_get_expr’s form of the same OR',
      `((hub_id = ANY (melarc.authorized_hub_ids())) OR (melarc.principal_type() = 'SYSTEM'::text))`,
    ],
    ['the SYSTEM literal on the left', `'SYSTEM' = melarc.principal_type()`],
    ['an IN list', `melarc.principal_type() IN ('STAFF', 'SYSTEM')`],
    ['an ANY list', `melarc.principal_type() = ANY (ARRAY['STAFF', 'SYSTEM'])`],
    [
      'a SYSTEM literal in a CASE condition and not in a WHEN',
      `CASE WHEN melarc.principal_type() = 'SYSTEM' THEN melarc.task_capability() = 'seed' ELSE false END`,
    ],
  ])('refuses %s', (_label, expression) => {
    expect(systemBranchProblems(expression).join('\n')).toMatch(/outside a WHEN arm/);
  });

  // Break caught: a capability test that a disjunction undoes. `capability OR true` tests nothing.
  it.each([
    [
      'an OR in the arm',
      `CASE melarc.principal_type() WHEN 'SYSTEM' THEN melarc.task_capability() = 'seed' OR true ELSE false END`,
    ],
    [
      'an OR in the arm, in parentheses',
      `CASE melarc.principal_type() WHEN 'SYSTEM' THEN (melarc.task_capability() = 'seed') OR (hub_id IS NOT NULL) ELSE false END`,
    ],
    [
      'an OR in the arm wrapped as a whole',
      `CASE melarc.principal_type() WHEN 'SYSTEM'::text THEN ((melarc.task_capability() = 'seed'::text) OR (true)) ELSE false END`,
    ],
  ])('refuses %s', (_label, expression) => {
    expect(systemBranchProblems(expression).join('\n')).toMatch(/SYSTEM arm .*OR/);
  });

  // Break caught: an OR that sits inside parentheses further in, which narrows and is fine.
  it('accepts an OR inside the capability’s own conjunct, which cannot widen the capability test', () => {
    const expression = `CASE melarc.principal_type() WHEN 'SYSTEM' THEN melarc.task_capability() = 'seed' AND (a IS NULL OR b IS NULL) ELSE false END`;
    expect(systemBranchProblems(expression)).toEqual([]);
  });

  // Break caught: a capability outside the closed list, which no context can carry and which a typo or an unlisted
  // label would make a branch no test reaches.
  it.each([
    [
      `CASE melarc.principal_type() WHEN 'SYSTEM' THEN melarc.task_capability() = 'admin' ELSE false END`,
      'admin',
    ],
    [
      `CASE melarc.principal_type() WHEN 'SYSTEM'::text THEN (melarc.task_capability() = 'Seed'::text) ELSE false END`,
      'Seed',
    ],
    [
      `CASE melarc.principal_type() WHEN 'SYSTEM' THEN 'worker:notification' = melarc.task_capability() ELSE false END`,
      'worker:notification',
    ],
  ])('refuses a capability outside the closed list: %#', (expression, name) => {
    expect(systemBranchProblems(expression).join('\n')).toContain(
      `outside the closed list: ${name}`,
    );
  });

  // Break caught: more than one capability named by an arm. A branch serves one capability (§14.1).
  it('refuses an arm that names two capabilities', () => {
    const expression = `CASE melarc.principal_type() WHEN 'SYSTEM' THEN melarc.task_capability() = 'seed' AND melarc.task_capability() = 'bootstrap' ELSE false END`;
    expect(systemBranchProblems(expression).join('\n')).toMatch(/more than one capability/);
  });

  // Break caught: the keywords being read inside a string, or in a nested CASE, so that a capability test in a
  // string literal, or a WHEN of an inner CASE, ends the arm early or satisfies it.
  it('does not take a capability named in a string literal for a test', () => {
    const expression = `CASE melarc.principal_type() WHEN 'SYSTEM' THEN note = 'melarc.task_capability() = ''seed''' ELSE false END`;
    expect(systemBranchProblems(expression).join('\n')).toMatch(/SYSTEM arm .*capability/);
  });

  it('keeps reading the arm through a nested CASE', () => {
    const expression = `CASE melarc.principal_type()
        WHEN 'SYSTEM' THEN (CASE WHEN a THEN true ELSE false END) AND melarc.task_capability() = 'seed'
        ELSE false END`;
    expect(systemBranchProblems(expression)).toEqual([]);
  });

  // Break caught: a SYSTEM literal that is not a top-level arm of the one principal CASE. A nested CASE inside another
  // arm, or the ELSE, is a SYSTEM branch this reader does not support, so it is refused.
  it('refuses a SYSTEM arm of a nested CASE, which is not a top-level arm', () => {
    const expression = `CASE melarc.principal_type() WHEN 'STAFF' THEN (CASE melarc.principal_type() WHEN 'SYSTEM' THEN true ELSE false END) WHEN 'SYSTEM' THEN melarc.task_capability() = 'seed' ELSE false END`;
    expect(systemBranchProblems(expression)).toEqual([
      expect.stringContaining('outside a WHEN arm'),
    ]);
  });
});

/**
 * The capability test must be mandatory: access succeeds only when it is true, and nothing around it can bypass it. The
 * first three are the predicates the review of S0.4 and S0.5 reproduced as accepted; each now has a finding. The reader
 * supports one structure only, and refuses the rest rather than trying to read arbitrary SQL.
 */
describe('systemBranchProblems: the capability test is mandatory (review of S0.4 and S0.5)', () => {
  const arm = (body: string) =>
    `CASE melarc.principal_type() WHEN 'SYSTEM' THEN ${body} ELSE false END`;

  // Break caught: a comparison the arm does not require to be true. Each of these is satisfied by a context under the
  // wrong capability, or under none, so SYSTEM would reach the table.
  it.each([
    ['a negated capability test', `NOT (melarc.task_capability() = 'seed')`],
    ['a negation without parentheses', `NOT melarc.task_capability() = 'seed'`],
    [
      'a disjunction that is true anyway, and a literal true',
      `(melarc.task_capability() = 'seed' OR true) AND true`,
    ],
    ['an inequality', `melarc.task_capability() <> 'seed'`],
    ['a negated equality', `melarc.task_capability() != 'seed'`],
    ['a range comparison', `melarc.task_capability() >= 'seed'`],
    ['a null test', `melarc.task_capability() IS NOT NULL`],
    [
      'a capability test inside a function call',
      `coalesce(melarc.task_capability() = 'seed', true)`,
    ],
    ['a capability test the arm may skip', `(melarc.task_capability() = 'seed') IS NOT FALSE`],
    ['a list of capabilities', `melarc.task_capability() IN ('seed', 'bootstrap')`],
    ['the pg_get_expr form of a negation', `(NOT (melarc.task_capability() = 'seed'::text))`],
  ])('refuses %s as the whole arm', (_label, body) => {
    expect(systemBranchProblems(arm(body)).join('\n')).toMatch(
      /does not require a positive capability test/,
    );
  });

  it('refuses a negated test even when another conjunct is true for everyone', () => {
    const body = `NOT (melarc.task_capability() = 'seed') AND hub_id IS NOT NULL`;
    expect(systemBranchProblems(arm(body)).join('\n')).toMatch(
      /does not require a positive capability test/,
    );
  });

  // Break caught: the CASE being wrapped in an expression that undoes it. The whole policy expression must be the one
  // CASE on the principal type.
  it.each([
    [
      'an OR true around the CASE',
      `(CASE melarc.principal_type() WHEN 'SYSTEM' THEN melarc.task_capability() = 'seed' ELSE false END) OR true`,
    ],
    [
      'the pg_get_expr form of the same OR',
      `((CASE melarc.principal_type() WHEN 'SYSTEM'::text THEN (melarc.task_capability() = 'seed'::text) ELSE false END) OR true)`,
    ],
    [
      'a NOT around the CASE',
      `NOT (CASE melarc.principal_type() WHEN 'SYSTEM' THEN melarc.task_capability() = 'seed' ELSE false END)`,
    ],
    [
      'an AND around the CASE, which narrows but is not the supported structure',
      `(CASE melarc.principal_type() WHEN 'SYSTEM' THEN melarc.task_capability() = 'seed' ELSE false END) AND hub_id IS NOT NULL`,
    ],
    [
      'a CASE on something other than the principal type',
      `CASE melarc.surface() WHEN 'SYSTEM' THEN melarc.task_capability() = 'seed' ELSE false END`,
    ],
    [
      'a CASE with an operand that only starts like the principal type',
      `CASE melarc.principal_type_x() WHEN 'SYSTEM' THEN melarc.task_capability() = 'seed' ELSE false END`,
    ],
  ])('refuses %s', (_label, expression) => {
    expect(systemBranchProblems(expression).join('\n')).toMatch(/outside a WHEN arm/);
  });

  // Break caught: an ELSE that admits a principal the CASE does not name, which includes a SYSTEM context under a
  // capability no arm lists. The ELSE is false or absent (SECURITY_DESIGN.md §14.4a).
  it.each([
    ['true', 'true'],
    ['a comparison', `melarc.task_capability() = 'seed'`],
    ['a hub test', `hub_id IS NOT NULL`],
  ])('refuses an ELSE that is %s', (_label, otherwise) => {
    const expression = `CASE melarc.principal_type() WHEN 'SYSTEM' THEN melarc.task_capability() = 'seed' ELSE ${otherwise} END`;
    expect(systemBranchProblems(expression).join('\n')).toMatch(
      /ELSE of the principal CASE must be false/,
    );
  });

  // Break caught: the structure being refused when it is the prescribed one in any of its forms.
  it.each([
    [
      'an arm with several mandatory conjuncts',
      arm(`melarc.task_capability() = 'seed' AND a IS NULL AND (b OR c)`),
    ],
    ['the capability test not first', arm(`a IS NULL AND melarc.task_capability() = 'seed'`)],
    ['the capability test in parentheses', arm(`((melarc.task_capability() = 'seed'))`)],
    ['the whole CASE in parentheses', `(${arm(`melarc.task_capability() = 'seed'`)})`],
    [
      'an ELSE-less CASE',
      `CASE melarc.principal_type() WHEN 'SYSTEM' THEN melarc.task_capability() = 'seed' END`,
    ],
    [
      'the same capability twice',
      arm(`melarc.task_capability() = 'seed' AND 'seed' = melarc.task_capability()`),
    ],
    [
      'pg_get_expr with casts and parentheses everywhere',
      `CASE melarc.principal_type() WHEN 'STAFF'::text THEN ((hub_id IS NOT NULL) AND (a OR b)) WHEN 'SYSTEM'::text THEN (((melarc.task_capability() = 'seed'::text) AND (x IS NULL))) ELSE false END`,
    ],
    [
      'an Outbox arm as a mandatory conjunct',
      arm(`a IS NULL AND melarc.outbox_task_permits('order')`),
    ],
  ])('accepts %s', (_label, expression) => {
    expect(systemBranchProblems(expression)).toEqual([]);
  });

  // Break caught: an Outbox call that is not the plain mandatory form: negated, or in a disjunction.
  it.each([
    ['a negated Outbox call', arm(`NOT melarc.outbox_task_permits('order')`)],
    ['an Outbox call with an OR', arm(`melarc.outbox_task_permits('order') OR true`)],
    ['an Outbox call with a second argument', arm(`melarc.outbox_task_permits('order', 'x')`)],
    ['an Outbox call of something that is not a literal', arm(`melarc.outbox_task_permits(name)`)],
  ])('refuses %s', (_label, expression) => {
    expect(systemBranchProblems(expression)).not.toEqual([]);
  });
});

/**
 * Precedence (second review of S0.4 and S0.5). `AND` binds tighter than `OR`, so `a AND b OR c` is `(a AND b) OR c` and nothing
 * inside it is mandatory: `(melarc.task_capability() = 'seed' AND false OR true) AND true` is true for every capability. A
 * conjunct is taken as mandatory only from a level that has no `OR` of its own, at every depth of parentheses.
 */
describe('systemBranchProblems: nothing inside a disjunction is mandatory', () => {
  const arm = (body: string) =>
    `CASE melarc.principal_type() WHEN 'SYSTEM' THEN ${body} ELSE false END`;
  // A disjunction that is the whole arm is refused for the OR itself; one inside a conjunction, for the missing mandatory test.
  const NOT_MANDATORY = /does not require a positive capability test|with OR, which can undo it/;

  // The expression of the review, as written and as the same grouping spelled out with more parentheses. Each is true whatever
  // the capability, and each is refused.
  it.each([
    ['as reviewed', `(melarc.task_capability() = 'seed' AND false OR true) AND true`],
    [
      'with the grouping spelled out',
      `((melarc.task_capability() = 'seed' AND false) OR true) AND true`,
    ],
    [
      'with every operand parenthesized',
      `(((melarc.task_capability() = 'seed') AND (false)) OR (true)) AND (true)`,
    ],
    [
      'with extra parentheses around each level',
      `((((melarc.task_capability() = 'seed' AND false) OR true))) AND ((true))`,
    ],
    ['with the disjunction last', `true AND (melarc.task_capability() = 'seed' AND false OR true)`],
    ['with the disjunction alone', `(melarc.task_capability() = 'seed' AND false OR true)`],
    [
      'with the capability test last in the disjunction',
      `(false AND true OR melarc.task_capability() = 'seed') AND true`,
    ],
    [
      'with the capability test second in a three-way disjunction',
      `(a OR melarc.task_capability() = 'seed' OR b) AND true`,
    ],
    ['nested a level deeper', `((melarc.task_capability() = 'seed' AND x OR y) AND z) AND true`],
    ['reversed comparison', `('seed' = melarc.task_capability() AND false OR true) AND true`],
    [
      'an Outbox call in the same place',
      `(melarc.outbox_task_permits('order') AND false OR true) AND true`,
    ],
  ])('refuses the disjunction %s', (_label, body) => {
    expect(systemBranchProblems(arm(body)).join('\n')).toMatch(NOT_MANDATORY);
  });

  // What pg_get_expr prints for those: casts after the literals, parentheses around every operand and every level.
  it.each([
    [
      'the reviewed expression',
      `CASE melarc.principal_type() WHEN 'SYSTEM'::text THEN ((((melarc.task_capability() = 'seed'::text) AND false) OR true) AND true) ELSE false END`,
    ],
    [
      'the same with the disjunction as the whole arm',
      `CASE melarc.principal_type() WHEN 'SYSTEM'::text THEN (((melarc.task_capability() = 'seed'::text) AND false) OR true) ELSE false END`,
    ],
    [
      'a three-way disjunction',
      `CASE melarc.principal_type() WHEN 'SYSTEM'::text THEN ((a OR (melarc.task_capability() = 'seed'::text)) OR b) AND true ELSE false END`,
    ],
  ])('refuses %s as pg_get_expr prints it', (_label, expression) => {
    expect(systemBranchProblems(expression).join('\n')).toMatch(
      /OR|does not require a positive capability test/,
    );
    expect(systemBranchProblems(expression)).not.toEqual([]);
  });

  // The other side of the line: a capability test that really is mandatory, next to a disjunction that has nothing to do with
  // it, is the supported structure and stays accepted, wherever the disjunction is and however it is parenthesized.
  it.each([
    [
      'a parenthesized OR after it',
      `melarc.task_capability() = 'seed' AND (a IS NULL OR b IS NULL)`,
    ],
    [
      'a parenthesized OR before it',
      `(a IS NULL OR b IS NULL) AND melarc.task_capability() = 'seed'`,
    ],
    [
      'a parenthesized OR on both sides',
      `(a OR b) AND melarc.task_capability() = 'seed' AND (c OR d)`,
    ],
    [
      'the OR holding a false in its own group',
      `melarc.task_capability() = 'seed' AND (false OR true)`,
    ],
    [
      'the test in parentheses beside a nested group',
      `((melarc.task_capability() = 'seed') AND ((a OR b) AND c))`,
    ],
    [
      'an AND group that holds the test inside a longer AND',
      `(x AND (melarc.task_capability() = 'seed' AND y)) AND (p OR q)`,
    ],
    ['the Outbox call beside a disjunction', `melarc.outbox_task_permits('order') AND (a OR b)`],
  ])('accepts a mandatory capability test with %s', (_label, body) => {
    expect(systemBranchProblems(arm(body))).toEqual([]);
  });

  it.each([
    [
      'a mandatory test and an unrelated parenthesized OR',
      `CASE melarc.principal_type() WHEN 'SYSTEM'::text THEN (((melarc.task_capability() = 'seed'::text) AND ((a IS NULL) OR (b IS NULL)))) ELSE false END`,
    ],
    [
      'the same with the OR first',
      `CASE melarc.principal_type() WHEN 'SYSTEM'::text THEN (((a IS NULL) OR (b IS NULL)) AND (melarc.task_capability() = 'seed'::text)) ELSE false END`,
    ],
    [
      'the same behind a STAFF arm that has its own OR',
      `CASE melarc.principal_type() WHEN 'STAFF'::text THEN ((melarc.hub_scope_mode() = 'ALL'::text) OR (hub_id = ANY (melarc.authorized_hub_ids()))) WHEN 'SYSTEM'::text THEN ((melarc.task_capability() = 'seed'::text) AND ((a) OR (b))) ELSE false END`,
    ],
  ])('accepts %s as pg_get_expr prints it', (_label, expression) => {
    expect(systemBranchProblems(expression)).toEqual([]);
  });

  // A disjunction directly in the arm is refused for the OR itself, as before.
  it('still refuses an OR at the level of the arm, for the OR', () => {
    expect(
      systemBranchProblems(arm(`melarc.task_capability() = 'seed' OR true`)).join('\n'),
    ).toMatch(/with OR, which can undo it/);
  });

  // The other word that carries an AND which is not a conjunction: `x BETWEEN a AND b`. A capability comparison after it is
  // not a conjunct of the arm (comparison binds looser than BETWEEN), so the arm is refused instead of read.
  it('refuses an arm that uses BETWEEN, whose AND is not a conjunction', () => {
    const body = `x BETWEEN 1 AND melarc.task_capability() = 'seed'`;
    expect(systemBranchProblems(arm(body)).join('\n')).toMatch(/BETWEEN/);
  });

  it('accepts BETWEEN nowhere in an arm that does not use it, whatever the other words', () => {
    expect(
      systemBranchProblems(arm(`melarc.task_capability() = 'seed' AND between_hubs IS NOT NULL`)),
    ).toEqual([]);
  });
});

describe('policyClauseProblems: the clauses of a CREATE POLICY statement', () => {
  const policy = (clauses: string) => `CREATE POLICY p ON melarc.orders ${clauses}`;
  const bypass = `(CASE melarc.principal_type() WHEN 'SYSTEM' THEN melarc.task_capability() = 'seed' ELSE false END) OR true`;
  const good = `CASE melarc.principal_type() WHEN 'SYSTEM' THEN melarc.task_capability() = 'seed' ELSE false END`;

  // Break caught: the clauses of a statement being read as one expression, so that USING and WITH CHECK together look like
  // a structure that is not a single CASE, or a bypass in one is hidden by the other.
  it('judges USING and WITH CHECK each as an expression of its own', () => {
    expect(policyClauseProblems(policy(`USING (${good}) WITH CHECK (${good})`))).toEqual([]);
    expect(
      policyClauseProblems(policy(`FOR ALL USING (${good}) WITH CHECK (${bypass})`)),
    ).toHaveLength(1);
    expect(policyClauseProblems(policy(`USING (${bypass}) WITH CHECK (${good})`))).toHaveLength(1);
    expect(policyClauseProblems(policy(`USING (${bypass}) WITH CHECK (${bypass})`))).toHaveLength(
      2,
    );
  });

  it('reads the clauses of a statement with other words around them', () => {
    expect(
      policyClauseProblems(
        policy(
          `AS PERMISSIVE FOR UPDATE USING (hub_id = ANY (melarc.authorized_hub_ids())) WITH CHECK (${bypass})`,
        ),
      ),
    ).toHaveLength(1);
  });

  it('finds nothing in a statement with no clause, and does not read the rest of a statement as a clause', () => {
    expect(policyClauseProblems('ALTER POLICY p ON melarc.orders RENAME TO q')).toEqual([]);
    expect(policyClauseProblems(`${policy('USING (true)')} -- 'SYSTEM' x`)).toEqual([]);
  });
});
