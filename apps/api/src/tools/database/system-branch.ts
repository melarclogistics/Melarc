import { TASK_CAPABILITIES } from '../../platform/database/task-capabilities.js';
import type { PolicyCommand } from './scope-probe-rule.js';

/**
 * The rule for the expressions of a row-level-security policy (SECURITY_DESIGN.md §14.1, §14.4; security-test-matrix
 * Family E, `GBT-E7`): `SYSTEM` alone is never a condition, the capability test is never optional, and **an expression this
 * reader does not support is refused, not passed**. It supports two structures and nothing else:
 *
 * 1. the principal CASE of §14.4, below, which every ordinary policy is;
 * 2. the scope probe policy of §14.4b, the one named exception: in the USING of a policy FOR SELECT, exactly
 *    `melarc.principal_type() = 'STAFF' AND <column> = melarc.scope_probe_id()` (the two conjuncts in either order, either side
 *    of each comparison). It is judged by its own check, here, and not by the absence of a SYSTEM literal.
 *
 * Anything else (`true`, `melarc.principal_type() <> 'VENDOR'`, `... NOT IN ('VENDOR', 'RIDER')`, a hub test, a call) is refused,
 * whether it names `SYSTEM` or not: such an expression admits every principal it does not exclude, a SYSTEM context under any
 * capability included. A policy that needs another form changes this reader, with the test that shows the form safe.
 *
 * A policy expression that is the principal CASE is read as one supported structure:
 *
 *     CASE melarc.principal_type()
 *       WHEN '<type>' THEN <expression>        -- any number of arms, each a literal of STAFF, VENDOR, RIDER or SYSTEM
 *       WHEN 'SYSTEM' THEN <conjunct> AND <conjunct> AND ...
 *       ELSE false                             -- or no ELSE: a principal the CASE does not name is denied
 *     END
 *
 * - the whole expression is that one CASE, optionally in parentheses; an `OR`, `AND` or `NOT` around it is refused, because
 *   `(CASE ... END) OR true` admits everyone;
 * - the `SYSTEM` arm is a conjunction at its own level (no top-level `OR`), and at least one conjunct is exactly
 *   `melarc.task_capability() = '<capability>'` (either way round) of the closed list, or exactly
 *   `melarc.outbox_task_permits('<table>')`, so that the access succeeds only when the capability test is true. A negated,
 *   inverted, ranged or disjunctive comparison is not that conjunct, and an arm without one is refused. `AND` binds tighter
 *   than `OR`, so at every depth of parentheses a level that has an `OR` of its own is one disjunction and nothing is taken
 *   out of it as mandatory (`(test AND false OR true) AND true` is true for every capability); an arm that uses `BETWEEN`,
 *   whose `AND` is not a conjunction, is refused rather than read;
 * - the capabilities an arm names are one, and in the closed list;
 * - `SYSTEM` is not named anywhere else (a nested CASE, the ELSE, an arm for another type, a list, an equality);
 * - an arm names a principal type: `NONE` is what a missing context reads as, and an arm for it (or for any literal no context
 *   carries) is refused;
 * - the ELSE is false or absent, whether or not any arm names `SYSTEM`, because an `ELSE true` admits a `SYSTEM` context that no
 *   arm mentions.
 *
 * The same reader judges the clauses of a migration's `CREATE POLICY` (`policyClauseProblems`) and what `pg_get_expr` prints
 * for a policy in the migrated database (`policyProblems`, used by the catalogue check), each clause for the command its policy
 * is for: the two differ in casts and parentheses, which are skipped, and are otherwise the same tokens. It is a reader of
 * tokens, not a parser. It does not try to understand arbitrary SQL: an expression outside the structures above is refused and
 * the author writes the plain form. What an arm of a human principal does (the hub test, the vendor test) is the policy
 * template's to say (S0.8) and is not judged here.
 */

type Token =
  | { readonly kind: 'string'; readonly text: string }
  | { readonly kind: 'word'; readonly text: string }
  | { readonly kind: 'open' | 'close' | 'other'; readonly text: string };

function tokenise(expression: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  while (at < expression.length) {
    const char = expression.charAt(at);
    if (/\s/.test(char)) {
      at += 1;
    } else if (char === "'") {
      let text = '';
      at += 1;
      while (at < expression.length) {
        if (expression.charAt(at) === "'" && expression.charAt(at + 1) === "'") {
          text += "'";
          at += 2;
        } else if (expression.charAt(at) === "'") {
          at += 1;
          break;
        } else {
          text += expression.charAt(at);
          at += 1;
        }
      }
      tokens.push({ kind: 'string', text });
    } else if (/[A-Za-z_]/.test(char)) {
      const start = at;
      while (at < expression.length && /[A-Za-z0-9_$.]/.test(expression.charAt(at))) at += 1;
      tokens.push({ kind: 'word', text: expression.slice(start, at) });
    } else if (char === '(') {
      tokens.push({ kind: 'open', text: char });
      at += 1;
    } else if (char === ')') {
      tokens.push({ kind: 'close', text: char });
      at += 1;
    } else if (char === ':' && expression.charAt(at + 1) === ':') {
      tokens.push({ kind: 'other', text: '::' });
      at += 2;
    } else {
      tokens.push({ kind: 'other', text: char });
      at += 1;
    }
  }
  return tokens;
}

const isWord = (token: Token | undefined, word: string): boolean =>
  token?.kind === 'word' && token.text.toUpperCase() === word;

const isCall = (token: Token | undefined, name: string): boolean =>
  token?.kind === 'word' && token.text.toLowerCase() === name;

/** The index after a `::type` cast that starts at `at`, or `at` when there is none. */
function skipCast(tokens: readonly Token[], at: number): number {
  return tokens[at]?.text === '::' && tokens[at + 1]?.kind === 'word' ? at + 2 : at;
}

/** The index of the parenthesis that closes the one opened at `open`, or -1. */
function matchingClose(tokens: readonly Token[], open: number): number {
  let depth = 0;
  for (let at = open; at < tokens.length; at += 1) {
    if (tokens[at]?.kind === 'open') depth += 1;
    else if (tokens[at]?.kind === 'close') {
      depth -= 1;
      if (depth === 0) return at;
    }
  }
  return -1;
}

/** The tokens with every pair of parentheses that wraps all of them removed. */
function stripOuterParens(tokens: readonly Token[]): readonly Token[] {
  let current = tokens;
  while (current[0]?.kind === 'open' && matchingClose(current, 0) === current.length - 1) {
    current = current.slice(1, -1);
  }
  return current;
}

/** The pieces of the tokens between the occurrences of `word` that sit at the tokens' own level. */
function splitTopLevel(tokens: readonly Token[], word: string): Token[][] {
  const pieces: Token[][] = [[]];
  let depth = 0;
  for (const token of tokens) {
    if (token.kind === 'open' || isWord(token, 'CASE')) depth += 1;
    else if (token.kind === 'close' || isWord(token, 'END')) depth -= 1;
    if (depth === 0 && isWord(token, word)) pieces.push([]);
    else pieces.at(-1)?.push(token);
  }
  return pieces;
}

/** The tokens of the arm that follows `THEN`, up to the next `WHEN`, `ELSE` or `END` of the same CASE. */
function armBody(tokens: readonly Token[], from: number): Token[] {
  const body: Token[] = [];
  let depth = 0;
  for (let at = from; at < tokens.length; at += 1) {
    const token = tokens[at];
    if (token === undefined) break;
    if (depth === 0 && (isWord(token, 'WHEN') || isWord(token, 'ELSE') || isWord(token, 'END')))
      break;
    if (token.kind === 'open' || isWord(token, 'CASE')) depth += 1;
    else if (token.kind === 'close' || isWord(token, 'END')) depth -= 1;
    body.push(token);
  }
  return body;
}

interface PrincipalCase {
  readonly arms: readonly { readonly literal: string; readonly body: readonly Token[] }[];
  readonly otherwise: readonly Token[] | undefined;
}

/** The tokens as one `CASE melarc.principal_type() WHEN '<literal>' THEN ... [ELSE ...] END`, or undefined. */
function parsePrincipalCase(tokens: readonly Token[]): PrincipalCase | undefined {
  if (!isWord(tokens[0], 'CASE')) return undefined;
  if (!isCall(tokens[1], 'melarc.principal_type')) return undefined;
  if (tokens[2]?.kind !== 'open' || tokens[3]?.kind !== 'close') return undefined;
  if (!isWord(tokens.at(-1), 'END')) return undefined;

  const arms: { literal: string; body: readonly Token[] }[] = [];
  let otherwise: readonly Token[] | undefined;
  let at = 4;
  while (at < tokens.length - 1) {
    if (isWord(tokens[at], 'WHEN') && otherwise === undefined) {
      const literal = tokens[at + 1];
      if (literal?.kind !== 'string') return undefined;
      const then = skipCast(tokens, at + 2);
      if (!isWord(tokens[then], 'THEN')) return undefined;
      const body = armBody(tokens, then + 1);
      arms.push({ literal: literal.text, body });
      at = then + 1 + body.length;
    } else if (isWord(tokens[at], 'ELSE') && otherwise === undefined) {
      otherwise = armBody(tokens, at + 1);
      at += 1 + otherwise.length;
    } else return undefined;
  }
  return at === tokens.length - 1 && arms.length > 0 ? { arms, otherwise } : undefined;
}

/**
 * The literal of `<call>() = '<literal>'` or `'<literal>' = <call>()` (a cast on the literal skipped), when the tokens are exactly
 * that comparison of the no-argument call `name` with a string; otherwise undefined.
 */
function callEqualsLiteral(tokens: readonly Token[], name: string): string | undefined {
  // <call>() = 'x' [::text]
  if (
    isCall(tokens[0], name) &&
    tokens[1]?.kind === 'open' &&
    tokens[2]?.kind === 'close' &&
    tokens[3]?.text === '=' &&
    tokens[4]?.kind === 'string' &&
    skipCast(tokens, 5) === tokens.length
  ) {
    return tokens[4].text;
  }
  // 'x' [::text] = <call>()
  const literal = tokens[0];
  if (literal?.kind === 'string') {
    const equals = skipCast(tokens, 1);
    if (
      tokens[equals]?.text === '=' &&
      isCall(tokens[equals + 1], name) &&
      tokens[equals + 2]?.kind === 'open' &&
      tokens[equals + 3]?.kind === 'close' &&
      tokens.length === equals + 4
    ) {
      return literal.text;
    }
  }
  return undefined;
}

/** What one conjunct of a `SYSTEM` arm is, when it is exactly a positive capability test. */
type CapabilityTest =
  { readonly kind: 'capability'; readonly name: string } | { readonly kind: 'outbox' };

function capabilityTest(conjunct: readonly Token[]): CapabilityTest | undefined {
  // melarc.task_capability() = 'x' [::text], or the other way round
  const capability = callEqualsLiteral(conjunct, 'melarc.task_capability');
  if (capability !== undefined) return { kind: 'capability', name: capability };
  // melarc.outbox_task_permits('table')
  if (
    isCall(conjunct[0], 'melarc.outbox_task_permits') &&
    conjunct[1]?.kind === 'open' &&
    conjunct[2]?.kind === 'string' &&
    conjunct[3]?.kind === 'close' &&
    conjunct.length === 4
  ) {
    return { kind: 'outbox' };
  }
  return undefined;
}

/** The conjuncts of an expression: its pieces joined by `AND`, through any parentheses that wrap a whole piece. */
function conjuncts(tokens: readonly Token[]): (readonly Token[])[] {
  const stripped = stripOuterParens(tokens);
  // `AND` binds tighter than `OR`: `a AND b OR c` is `(a AND b) OR c`, so a level that has an `OR` of its own is one
  // disjunction, and nothing inside it is mandatory. It is kept whole, as a conjunct that is not a capability test, instead of
  // being split on its `AND` (which would take `a` out of `(a AND false) OR true` as if it had to be true).
  if (splitTopLevel(stripped, 'OR').length > 1) return [stripped];
  const pieces = splitTopLevel(stripped, 'AND');
  if (pieces.length === 1) return [stripped];
  return pieces.flatMap((piece) => conjuncts(piece));
}

function armProblems(body: readonly Token[]): string[] {
  // The `AND` of `x BETWEEN a AND b` is not a conjunction, and splitting on it would take the end of a range for a conjunct.
  // Rather than read it, the arm is refused (the author writes the two comparisons).
  if (body.some((token) => isWord(token, 'BETWEEN'))) {
    return [
      'a SYSTEM arm uses BETWEEN, whose AND is not a conjunction: write the comparisons it stands for',
    ];
  }
  const stripped = stripOuterParens(body);
  if (splitTopLevel(stripped, 'OR').length > 1) {
    return [
      'a SYSTEM arm joins its capability test to another condition with OR, which can undo it',
    ];
  }

  const tests = conjuncts(stripped)
    .map(capabilityTest)
    .filter((test): test is CapabilityTest => test !== undefined);
  if (tests.length === 0) {
    return [
      'a SYSTEM arm does not require a positive capability test: one AND conjunct must be exactly melarc.task_capability() = a capability of the closed list, or melarc.outbox_task_permits(a table)',
    ];
  }

  const problems: string[] = [];
  const names = new Set(tests.flatMap((test) => (test.kind === 'capability' ? [test.name] : [])));
  for (const name of names) {
    if (!(TASK_CAPABILITIES as readonly string[]).includes(name)) {
      problems.push(`a SYSTEM arm tests a capability outside the closed list: ${name}`);
    }
  }
  if (names.size > 1) {
    problems.push('a SYSTEM arm names more than one capability: a branch serves one');
  }
  return problems;
}

const OUTSIDE_ARM =
  'names SYSTEM outside a WHEN arm of a single CASE on melarc.principal_type() (an OR, a list or any other expression around it can admit SYSTEM without its capability)';

const UNSUPPORTED =
  'is not a supported policy expression: it must be one CASE on melarc.principal_type() with an arm for each principal type it admits and an ELSE that is false (or none), or, for a policy FOR SELECT, the scope probe policy; any other expression (true, a comparison, an IN list, a NOT) admits every principal it does not exclude, a SYSTEM context under any capability included';

/** The principal types a context can carry. `NONE` is what the accessor reads when there is no context, and is not one. */
const PRINCIPAL_TYPES: readonly string[] = ['STAFF', 'VENDOR', 'RIDER', 'SYSTEM'];

/** Words that are not a column name, so that `true = melarc.scope_probe_id()` is not read as the probe comparison. */
const NOT_A_COLUMN = new Set([
  'TRUE',
  'FALSE',
  'NULL',
  'NOT',
  'AND',
  'OR',
  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
  'IS',
  'IN',
  'ANY',
  'ALL',
  'EXISTS',
  'SELECT',
]);

const isColumn = (token: Token | undefined): boolean =>
  token?.kind === 'word' && !NOT_A_COLUMN.has(token.text.toUpperCase());

/**
 * The name of the probe accessor, matched as a pattern and not written as a quoted name: this file reads policies and writes no
 * setting, and `architecture.test.ts` keeps the quoted name out of every production file but the probe's own.
 */
const PROBE_CALL = /^melarc\.scope_probe_id$/i;

/** `<column> = melarc.scope_probe_id()` or `melarc.scope_probe_id() = <column>`: exactly that, with nothing around it. */
function isProbeComparison(piece: readonly Token[]): boolean {
  if (piece.length !== 5) return false;
  const probeCallAt = (at: number): boolean => {
    const name = piece[at];
    return (
      name?.kind === 'word' &&
      PROBE_CALL.test(name.text) &&
      piece[at + 1]?.kind === 'open' &&
      piece[at + 2]?.kind === 'close'
    );
  };
  if (isColumn(piece[0]) && piece[1]?.text === '=' && probeCallAt(2)) return true;
  return probeCallAt(0) && piece[3]?.text === '=' && isColumn(piece[4]);
}

/**
 * The scope probe policy of SECURITY_DESIGN.md §14.4b, exactly: the staff guard and the probe comparison, two conjuncts in either
 * order. Not the probe alone, not another guard, not a third conjunct.
 */
function isStaffProbe(tokens: readonly Token[]): boolean {
  const pieces = conjuncts(tokens).map(stripOuterParens);
  const [first, second] = pieces;
  if (pieces.length !== 2 || first === undefined || second === undefined) return false;
  const guard = (piece: readonly Token[]): boolean =>
    callEqualsLiteral(piece, 'melarc.principal_type') === 'STAFF';
  return (guard(first) && isProbeComparison(second)) || (guard(second) && isProbeComparison(first));
}

/** Where an expression sits: the command of its policy (undefined when the statement does not show it) and which clause it is. */
export interface PolicyClauseSite {
  readonly command: PolicyCommand | undefined;
  readonly clause: 'using' | 'check';
}

function judge(tokens: readonly Token[], site: PolicyClauseSite): string[] {
  const mentionsSystem = tokens.some((token) => token.kind === 'string' && token.text === 'SYSTEM');
  const expression = stripOuterParens(tokens);
  const parsed = parsePrincipalCase(expression);
  if (parsed === undefined) {
    // The one named exception, in the one place it is allowed. A command that is not shown is not read as SELECT.
    if (site.command === 'select' && site.clause === 'using' && isStaffProbe(expression)) return [];
    return [mentionsSystem ? OUTSIDE_ARM : UNSUPPORTED];
  }

  const problems: string[] = [];
  for (const arm of parsed.arms) {
    if (!PRINCIPAL_TYPES.includes(arm.literal)) {
      problems.push(
        `the principal CASE has an arm for '${arm.literal}', which is not a principal type (STAFF, VENDOR, RIDER, SYSTEM): NONE is what a missing context reads as, and an arm for it, or for any other literal, would admit a context that was never established`,
      );
    }
  }
  const otherwiseIsFalse =
    parsed.otherwise === undefined ||
    (parsed.otherwise.length === 1 && isWord(parsed.otherwise[0], 'FALSE'));
  if (!otherwiseIsFalse) {
    problems.push(
      'the ELSE of the principal CASE must be false: a principal the CASE does not name, a SYSTEM context included, is denied',
    );
  }

  // SYSTEM is named by a top-level arm and nowhere else: not in another arm, not in the ELSE, not in a nested CASE.
  const named = (body: readonly Token[]) =>
    body.some((token) => token.kind === 'string' && token.text === 'SYSTEM');
  if (parsed.arms.some((arm) => named(arm.body)) || named(parsed.otherwise ?? [])) {
    problems.push(OUTSIDE_ARM);
  }
  for (const arm of parsed.arms) {
    if (arm.literal === 'SYSTEM') problems.push(...armProblems(arm.body));
  }
  return problems;
}

/**
 * What is wrong with one policy expression (a `USING` or `WITH CHECK` as `pg_get_expr` prints it, or written in a migration):
 * empty only when it is the principal CASE with its ELSE closed, arms for principal types and a mandatory capability test in
 * every `SYSTEM` arm, or the scope probe policy in the USING of a policy FOR SELECT. `site` says which clause it is and what
 * command its policy is for (undefined when the statement does not show it).
 */
export function policyExpressionProblems(expression: string, site: PolicyClauseSite): string[] {
  return judge(tokenise(expression), site);
}

/**
 * What is wrong with one policy as the catalogue holds it: each clause that is present, judged for the command the policy is
 * for. A clause that is absent is not judged (a policy with no expression for a command adds no permission).
 */
export function policyProblems(policy: {
  readonly command: PolicyCommand | undefined;
  readonly using: string | null;
  readonly check: string | null;
}): string[] {
  const problems: string[] = [];
  if (policy.using !== null) {
    problems.push(
      ...policyExpressionProblems(policy.using, { command: policy.command, clause: 'using' }),
    );
  }
  if (policy.check !== null) {
    problems.push(
      ...policyExpressionProblems(policy.check, { command: policy.command, clause: 'check' }),
    );
  }
  return problems;
}

/**
 * The same rule over the `USING (...)` and `WITH CHECK (...)` clauses of one `CREATE POLICY` or `ALTER POLICY` statement, each
 * judged as an expression of its own, for the command the statement is for (undefined for an `ALTER POLICY`, which does not say).
 * Nothing outside those parentheses is read.
 */
export function policyClauseProblems(
  statement: string,
  command: PolicyCommand | undefined,
): string[] {
  const tokens = tokenise(statement);
  const problems: string[] = [];
  for (let at = 0; at < tokens.length; at += 1) {
    const isUsing = isWord(tokens[at], 'USING');
    const clause = isUsing
      ? at + 1
      : isWord(tokens[at], 'WITH') && isWord(tokens[at + 1], 'CHECK')
        ? at + 2
        : -1;
    if (clause === -1 || tokens[clause]?.kind !== 'open') continue;
    const close = matchingClose(tokens, clause);
    if (close === -1) continue;
    problems.push(
      ...judge(tokens.slice(clause + 1, close), { command, clause: isUsing ? 'using' : 'check' }),
    );
    at = close;
  }
  return problems;
}
