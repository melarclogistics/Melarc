/**
 * Migration lint (K7). Reads a migration's SQL and reports what would leave a table less protected than
 * the security design requires, so the mistake fails in the pull request and not in review.
 *
 * Every table a migration creates must, in the same migration, be owned by `melarc_owner` and have
 * row-level security both enabled and forced (SECURITY_DESIGN.md sections 14.2 and 14.17a;
 * MIGRATION_AND_SEEDING.md section 5.1). No migration may switch that protection off again, hand a table to
 * another owner, name a role in a policy, or open anything to PUBLIC. A cascade, a TRUNCATE or a DELETE grant is
 * refused unless a comment on the statement gives the reason (`-- allow-delete: <reason>`). A policy may admit `SYSTEM`
 * only through a `WHEN 'SYSTEM'` arm that names one task capability (system-branch.ts), never `SYSTEM` alone.
 *
 * This is a text check, not a parser: it splits the SQL into statements (comments, strings, quoted names and
 * dollar-quoted bodies are read as such, so neither a `--` inside a string nor a `;` inside a body confuses it) and
 * matches the statements it knows. It is the first line of defence and it is meant to fail early with a message.
 * It cannot see a statement that is built at run time, in an `EXECUTE`; what the database ends up with is checked
 * by catalog-invariants.ts, which does not read SQL at all.
 */

import { scopeProbePolicyProblem, type PolicyCommand } from './scope-probe-rule.js';
import { policyClauseProblems } from './system-branch.js';

const OWNER_ROLE = 'melarc_owner';

const IDENTIFIER = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const QUALIFIED_NAME = String.raw`(${IDENTIFIER}(?:\s*\.\s*${IDENTIFIER})?)`;

const CREATED_TABLE = new RegExp(
  String.raw`^create\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?${QUALIFIED_NAME}`,
  'i',
);
const ALTER_TABLE = new RegExp(
  String.raw`^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${QUALIFIED_NAME}\s+([\s\S]*)$`,
  'i',
);
const OWNER_ACTION = new RegExp(String.raw`^owner\s+to\s+(${IDENTIFIER})\s*$`, 'i');
const ENABLE_ACTION = /^enable\s+row\s+level\s+security$/i;
const FORCE_ACTION = /^force\s+row\s+level\s+security$/i;
const PROTECTION_REMOVED =
  /\b(disable\s+row\s+level\s+security|no\s+force\s+row\s+level\s+security)/gi;
const CREATE_POLICY = new RegExp(
  String.raw`^create\s+policy\s+(${IDENTIFIER})\s+on\s+${QUALIFIED_NAME}([\s\S]*?)(?=\busing\b|\bwith\s+check\b|$)`,
  'i',
);
const ALTER_POLICY = new RegExp(
  String.raw`^alter\s+policy\s+(${IDENTIFIER})\s+on\s+${QUALIFIED_NAME}([\s\S]*?)(?=\busing\b|\bwith\s+check\b|$)`,
  'i',
);
/**
 * Statements that remove data. Delete behaviour is explicit and never a framework default, and operational data is
 * never hard-deleted by accident (Product Owner, 6 October 2026): each needs a comment on the statement that records why.
 */
const CASCADE = /\bon\s+delete\s+cascade\b/i;
const TRUNCATE = /^truncate\b/i;
const GRANT_PRIVILEGES = /^grant\s+(.*?)\s+on\s/i;
const REMOVING_PRIVILEGE = /\b(?:delete|truncate|all)\b/i;
const DELETE_REASON = /allow-delete:[ \t]*\S/i;

function removesData(statement: string): string | undefined {
  if (CASCADE.test(statement)) return 'ON DELETE CASCADE';
  if (TRUNCATE.test(statement)) return 'TRUNCATE';
  const privileges = GRANT_PRIVILEGES.exec(statement)?.[1];
  if (privileges !== undefined && REMOVING_PRIVILEGE.test(privileges)) {
    return 'a grant of DELETE, TRUNCATE or ALL';
  }
  return undefined;
}

/** The command a `CREATE POLICY` is for: the one it says, or ALL when it says none. */
function policyCommand(afterTable: string): PolicyCommand {
  const written = /\bfor\s+(all|select|insert|update|delete)\b/i.exec(afterTable)?.[1];
  return (written?.toLowerCase() as PolicyCommand | undefined) ?? 'all';
}

/**
 * Roles and role membership (MIGRATION_AND_SEEDING.md §5.1). A migration that creates or alters a role, or grants a role
 * to a role, changes who can do what outside any table's policy, so it is flagged and reviewed: a comment on the statement
 * records the reason, written `-- allow-role: <reason>`. An `ALTER ROLE ... SET` is not a change to the role's powers
 * (the stored-context rule below reads it). A grant of a role is a `GRANT` with no `ON`: every object privilege has one.
 */
const ROLE_STATEMENT = /^(create|alter)\s+(role|user|group)\b/i;
const ROLE_SETTING =
  /^alter\s+(?:role|user|group)\s+\S+(?:\s+in\s+database\s+\S+)?\s+(?:set|reset)\b/i;
const ROLE_GRANT = /^grant\b(?![\s\S]*\bon\b)[\s\S]*\bto\b/i;
const ROLE_REASON = /allow-role:[ \t]*\S/i;

function changesRoles(statement: string): string | undefined {
  const role = ROLE_STATEMENT.exec(statement);
  if (role !== null && !ROLE_SETTING.test(statement)) {
    return `${(role[1] ?? '').toUpperCase()} ${(role[2] ?? '').toUpperCase()}`;
  }
  if (ROLE_GRANT.test(statement)) return 'GRANT of a role to a role';
  return undefined;
}

/**
 * SECURITY DEFINER functions (SECURITY_DESIGN.md §14.6): such a function runs with its owner's powers, so it fixes its own
 * `search_path`, is revoked from PUBLIC and granted `EXECUTE` to named roles, and builds no statement from what it is
 * given. All four are read from the migration that creates it, and a function is made a definer only by its CREATE.
 */
const CREATE_FUNCTION = new RegExp(
  String.raw`^create\s+(?:or\s+replace\s+)?(?:function|procedure)\s+${QUALIFIED_NAME}`,
  'i',
);
const DEFINER = /\bsecurity\s+definer\b/i;
const FIXED_SEARCH_PATH = /\bset\s+search_path\s*(?:=|\bto\b)/i;
const ALTER_TO_DEFINER = /^alter\s+(?:function|procedure)\b[\s\S]*\bsecurity\s+definer\b/i;
const REVOKE_FROM_PUBLIC = new RegExp(
  String.raw`^revoke\b[\s\S]*?\bon\s+(?:function|procedure)\s+${QUALIFIED_NAME}[\s\S]*\bfrom\b[\s\S]*\bpublic\b`,
  'i',
);
const GRANT_EXECUTE = new RegExp(
  String.raw`^grant\s+(?:execute|all)\b[\s\S]*?\bon\s+(?:function|procedure)\s+${QUALIFIED_NAME}[\s\S]*?\bto\s+([\s\S]+)$`,
  'i',
);
const DYNAMIC_SQL = /\bexecute\b/i;
/** A dollar-quoted body, which is code and not part of the function's attributes. */
const DOLLAR_BODY = /(\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$)[\s\S]*?\1/g;

const GRANT_TO_PUBLIC = /^grant\b[\s\S]*\bto\s+(?:[^;]*,\s*)?public\b/i;
const DEFAULT_PRIVILEGES = /^alter\s+default\s+privileges\b/i;
const STORED_CONTEXT_SETTING = /^alter\s+(?:database|role|user)\b[\s\S]*\bset\s+["']?melarc\./i;

interface Statement {
  /** The statement with its comments removed and its white space collapsed. */
  readonly text: string;
  /** The comments inside it, and those before it that follow the previous statement. */
  readonly comments: string;
}

/**
 * The statements of the SQL, comments removed and kept apart. A comment is not read inside a string, a quoted name or a
 * dollar-quoted body, and a `;` does not end a statement there either.
 */
function statementsOf(sql: string): Statement[] {
  const statements: Statement[] = [];
  let comments = '';
  let current = '';
  let at = 0;
  const end = sql.length;

  while (at < end) {
    const char = sql.charAt(at);
    const next = sql.charAt(at + 1);

    if (char === '-' && next === '-') {
      const start = at;
      while (at < end && sql.charAt(at) !== '\n') at += 1;
      comments += `${sql.slice(start, at)}\n`;
      current += ' ';
    } else if (char === '/' && next === '*') {
      const start = at;
      let depth = 1;
      at += 2;
      while (at < end && depth > 0) {
        if (sql.startsWith('/*', at)) {
          depth += 1;
          at += 2;
        } else if (sql.startsWith('*/', at)) {
          depth -= 1;
          at += 2;
        } else at += 1;
      }
      comments += `${sql.slice(start, at)}\n`;
      current += ' ';
    } else if (char === "'") {
      // An E'...' string reads a backslash as an escape; any other string does not.
      const before = current.at(-2);
      const escapes = /[eE]/.test(current.at(-1) ?? '') && !/[A-Za-z0-9_$]/.test(before ?? '');
      const start = at;
      at += 1;
      while (at < end) {
        if (escapes && sql.charAt(at) === '\\') at += 2;
        else if (sql.charAt(at) === "'" && sql.charAt(at + 1) === "'") at += 2;
        else if (sql.charAt(at) === "'") break;
        else at += 1;
      }
      at = Math.min(at + 1, end);
      current += sql.slice(start, at);
    } else if (char === '"') {
      const start = at;
      at += 1;
      while (at < end) {
        if (sql.charAt(at) === '"' && sql.charAt(at + 1) === '"') at += 2;
        else if (sql.charAt(at) === '"') break;
        else at += 1;
      }
      at = Math.min(at + 1, end);
      current += sql.slice(start, at);
    } else if (char === '$' && !/[A-Za-z0-9_]/.test(current.at(-1) ?? '')) {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(at, at + 66))?.[0];
      if (tag === undefined) {
        current += char;
        at += 1;
      } else {
        const close = sql.indexOf(tag, at + tag.length);
        const stop = close === -1 ? end : close + tag.length;
        current += sql.slice(at, stop);
        at = stop;
      }
    } else if (char === ';') {
      statements.push({ text: current, comments });
      current = '';
      comments = '';
      at += 1;
    } else {
      current += char;
      at += 1;
    }
  }
  statements.push({ text: current, comments });
  return statements
    .map((statement) => ({ ...statement, text: statement.text.replaceAll(/\s+/g, ' ').trim() }))
    .filter((statement) => statement.text !== '');
}

/** Splits at the commas that are not inside parentheses or quotes: the actions of one ALTER TABLE. */
function splitActions(text: string): string[] {
  const actions: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let from = 0;
  for (let at = 0; at < text.length; at += 1) {
    const char = text.charAt(at);
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
    } else if (char === "'" || char === '"') quote = char;
    else if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    else if (char === ',' && depth === 0) {
      actions.push(text.slice(from, at).trim());
      from = at + 1;
    }
  }
  actions.push(text.slice(from).trim());
  return actions.filter(Boolean);
}

function unquote(identifier: string): string {
  const quoted = /^"([\s\S]*)"$/.exec(identifier);
  return quoted ? (quoted[1] ?? '').replaceAll('""', '"') : identifier.toLowerCase();
}

/** `schema.table` with quotes resolved and an unqualified name placed in `public`, as PostgreSQL does. */
function normaliseTable(name: string): string {
  const parts = name.split(/\s*\.\s*/);
  const table = unquote(parts[parts.length - 1] ?? name);
  const schema = parts.length > 1 ? unquote(parts[0] ?? 'public') : 'public';
  return `${schema}.${table}`;
}

/** Problems found in one migration's SQL; empty when it satisfies the rules. */
export function lintMigrationSql(sql: string): string[] {
  const statements = statementsOf(sql);
  const problems: string[] = [];

  const created = new Set<string>();
  const enabled = new Set<string>();
  const forced = new Set<string>();
  /** The owner each table is left with: the last `OWNER TO` of the migration decides. */
  const owners = new Map<string, string>();
  /** The SECURITY DEFINER functions the migration creates, and what it does about each one's EXECUTE. */
  const definers = new Set<string>();
  const revokedFromPublic = new Set<string>();
  const grantedToNamed = new Set<string>();

  for (const { text: statement, comments } of statements) {
    // The text of an ordinary string is data, not a statement; a dollar-quoted body is kept, because it can run.
    const removes = removesData(statement.replaceAll(/'(?:[^']|'')*'/g, "''"));
    if (removes !== undefined && !DELETE_REASON.test(comments)) {
      problems.push(
        `${removes} has no recorded reason: add a comment "-- allow-delete: <reason>" on the statement`,
      );
    }

    const roleChange = changesRoles(statement.replaceAll(/'(?:[^']|'')*'/g, "''"));
    if (roleChange !== undefined && !ROLE_REASON.test(comments)) {
      problems.push(
        `${roleChange} has no recorded reason: add a comment "-- allow-role: <reason>" on the statement`,
      );
    }

    const createsFunction = CREATE_FUNCTION.exec(statement);
    const attributes = statement.replaceAll(DOLLAR_BODY, '$$$$');
    if (createsFunction?.[1] !== undefined && DEFINER.test(attributes)) {
      const name = normaliseTable(createsFunction[1]);
      definers.add(name);
      if (!FIXED_SEARCH_PATH.test(attributes)) {
        problems.push(
          `function ${name} is SECURITY DEFINER but does not fix its search_path (add SET search_path = ...)`,
        );
      }
      if (DYNAMIC_SQL.test(statement)) {
        problems.push(
          `function ${name} is SECURITY DEFINER and uses EXECUTE, so an argument could become dynamic SQL run with its owner's powers`,
        );
      }
    }
    if (ALTER_TO_DEFINER.test(statement)) {
      problems.push(
        'ALTER FUNCTION ... SECURITY DEFINER: make a function SECURITY DEFINER only in its CREATE statement, which carries its search_path',
      );
    }
    const revokes = REVOKE_FROM_PUBLIC.exec(statement);
    if (revokes?.[1] !== undefined) revokedFromPublic.add(normaliseTable(revokes[1]));
    const grantsExecute = GRANT_EXECUTE.exec(statement);
    if (grantsExecute?.[1] !== undefined) {
      const named = (grantsExecute[2] ?? '')
        .split(',')
        .map((role) => role.replace(/\bwith\s+grant\s+option\b/i, '').trim())
        .filter((role) => role !== '' && role.toLowerCase() !== 'public');
      if (named.length > 0) grantedToNamed.add(normaliseTable(grantsExecute[1]));
    }

    const creates = CREATED_TABLE.exec(statement);
    if (creates?.[1] !== undefined) created.add(normaliseTable(creates[1]));

    const alters = ALTER_TABLE.exec(statement);
    if (alters?.[1] !== undefined) {
      const table = normaliseTable(alters[1]);
      for (const action of splitActions(alters[2] ?? '')) {
        const owner = OWNER_ACTION.exec(action);
        if (owner?.[1] !== undefined) owners.set(table, unquote(owner[1]));
        else if (ENABLE_ACTION.test(action)) enabled.add(table);
        else if (FORCE_ACTION.test(action)) forced.add(table);
      }
    }

    const createdPolicy = CREATE_POLICY.exec(statement);
    const policy = createdPolicy ?? ALTER_POLICY.exec(statement);
    if (policy !== null && /\bto\b/i.test((policy[3] ?? '').replace(/\brename\s+to\b/gi, ''))) {
      problems.push(
        `policy ${unquote(policy[1] ?? '')} on ${normaliseTable(policy[2] ?? '')} names a role: policies decide on the request context, never on the connecting role`,
      );
    }
    // SYSTEM alone is never a condition: each SYSTEM branch of a policy names one capability (GBT-E7). The scope probe
    // predicate is read-only: it belongs in a policy FOR SELECT, and an ALTER POLICY does not show the command.
    if (policy !== null) {
      const command = createdPolicy === null ? undefined : policyCommand(createdPolicy[3] ?? '');
      const probeProblem = scopeProbePolicyProblem(command, [statement]);
      if (probeProblem !== undefined) {
        problems.push(
          `policy ${unquote(policy[1] ?? '')} on ${normaliseTable(policy[2] ?? '')}: ${probeProblem}`,
        );
      }
      for (const problem of policyClauseProblems(statement)) {
        problems.push(
          `policy ${unquote(policy[1] ?? '')} on ${normaliseTable(policy[2] ?? '')}: ${problem}`,
        );
      }
    }
    if (GRANT_TO_PUBLIC.test(statement)) problems.push('migration grants a privilege to PUBLIC');
    if (DEFAULT_PRIVILEGES.test(statement)) {
      problems.push(
        'migration sets default privileges, which would apply to objects nobody reviewed',
      );
    }
    if (STORED_CONTEXT_SETTING.test(statement)) {
      problems.push(
        'migration stores a melarc.* setting on the database or a role, outside any transaction',
      );
    }
  }

  for (const name of definers) {
    if (!revokedFromPublic.has(name)) {
      problems.push(
        `function ${name} is SECURITY DEFINER but the migration does not revoke EXECUTE from PUBLIC`,
      );
    }
    if (!grantedToNamed.has(name)) {
      problems.push(
        `function ${name} is SECURITY DEFINER but the migration grants EXECUTE to no named role`,
      );
    }
  }

  for (const table of created) {
    if (owners.get(table) !== OWNER_ROLE) {
      problems.push(`table ${table}: missing ALTER TABLE ... OWNER TO ${OWNER_ROLE}`);
    }
    if (!enabled.has(table)) {
      problems.push(`table ${table}: missing ALTER TABLE ... ENABLE ROW LEVEL SECURITY`);
    }
    if (!forced.has(table)) {
      problems.push(`table ${table}: missing ALTER TABLE ... FORCE ROW LEVEL SECURITY`);
    }
  }

  // A table given to any other owner, created here or not, is a way out of the policies that forcing closed.
  for (const [table, owner] of owners) {
    if (owner !== OWNER_ROLE && !created.has(table)) {
      problems.push(
        `table ${table}: ALTER TABLE ... OWNER TO ${owner} (only ${OWNER_ROLE} may own a table)`,
      );
    }
  }

  // Said once for the whole text, so that it is found inside a `DO` body or a string as well.
  for (const match of statements
    .map((statement) => statement.text)
    .join(';\n')
    .matchAll(PROTECTION_REMOVED)) {
    problems.push(`migration runs ${(match[1] ?? '').replaceAll(/\s+/g, ' ').toUpperCase()}`);
  }

  return problems;
}
