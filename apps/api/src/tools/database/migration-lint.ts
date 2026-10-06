/**
 * Migration lint (K7). Reads a migration's SQL and reports what would leave a table less protected than
 * the security design requires, so the mistake fails in the pull request and not in review.
 *
 * Every table a migration creates must, in the same migration, be owned by `melarc_owner` and have
 * row-level security both enabled and forced (SECURITY_DESIGN.md sections 14.2 and 14.17a;
 * MIGRATION_AND_SEEDING.md section 5.1). No migration may switch that protection off again, hand a table to
 * another owner, name a role in a policy, or open anything to PUBLIC.
 *
 * This is a text check, not a parser: it splits the SQL into statements (comments, strings, quoted names and
 * dollar-quoted bodies are read as such, so neither a `--` inside a string nor a `;` inside a body confuses it) and
 * matches the statements it knows. It is the first line of defence and it is meant to fail early with a message.
 * It cannot see a statement that is built at run time, in an `EXECUTE`; what the database ends up with is checked
 * by catalog-invariants.ts, which does not read SQL at all.
 */

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
const GRANT_TO_PUBLIC = /^grant\b[\s\S]*\bto\s+(?:[^;]*,\s*)?public\b/i;
const DEFAULT_PRIVILEGES = /^alter\s+default\s+privileges\b/i;
const STORED_CONTEXT_SETTING = /^alter\s+(?:database|role|user)\b[\s\S]*\bset\s+["']?melarc\./i;

/**
 * The statements of the SQL, comments removed. A comment is not read inside a string, a quoted name or a
 * dollar-quoted body, and a `;` does not end a statement there either.
 */
function statementsOf(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let at = 0;
  const end = sql.length;

  while (at < end) {
    const char = sql.charAt(at);
    const next = sql.charAt(at + 1);

    if (char === '-' && next === '-') {
      while (at < end && sql.charAt(at) !== '\n') at += 1;
      current += ' ';
    } else if (char === '/' && next === '*') {
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
      statements.push(current);
      current = '';
      at += 1;
    } else {
      current += char;
      at += 1;
    }
  }
  statements.push(current);
  return statements.map((statement) => statement.replaceAll(/\s+/g, ' ').trim()).filter(Boolean);
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

  for (const statement of statements) {
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

    const policy = CREATE_POLICY.exec(statement) ?? ALTER_POLICY.exec(statement);
    if (policy !== null && /\bto\b/i.test((policy[3] ?? '').replace(/\brename\s+to\b/gi, ''))) {
      problems.push(
        `policy ${unquote(policy[1] ?? '')} on ${normaliseTable(policy[2] ?? '')} names a role: policies decide on the request context, never on the connecting role`,
      );
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
  for (const match of statements.join(';\n').matchAll(PROTECTION_REMOVED)) {
    problems.push(`migration runs ${(match[1] ?? '').replaceAll(/\s+/g, ' ').toUpperCase()}`);
  }

  return problems;
}
