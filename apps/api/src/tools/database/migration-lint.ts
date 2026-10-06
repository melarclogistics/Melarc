/**
 * Migration lint (K7). Reads a migration's SQL and reports what would leave a table less protected than
 * the security design requires, so the mistake fails in the pull request and not in review.
 *
 * Every table a migration creates must, in the same migration, be owned by `melarc_owner` and have
 * row-level security both enabled and forced (SECURITY_DESIGN.md sections 14.2 and 14.17a;
 * MIGRATION_AND_SEEDING.md section 5.1). No migration may switch that protection off again, and no policy
 * may name a role: policies decide on the request context alone.
 *
 * This is a text check over the SQL, not a parser. It matches whole statements after comments are removed,
 * which is enough for the statements Drizzle and the migration authors write; it is the first line of
 * defence, and the database tests assert the resulting catalog state.
 */

const OWNER_ROLE = 'melarc_owner';

const IDENTIFIER = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const QUALIFIED_NAME = String.raw`(${IDENTIFIER}(?:\s*\.\s*${IDENTIFIER})?)`;
const ALTER_TABLE = String.raw`\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${QUALIFIED_NAME}\s+`;

const CREATED_TABLE = new RegExp(
  String.raw`\bcreate\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?${QUALIFIED_NAME}`,
  'gi',
);
const OWNED_BY = new RegExp(`${ALTER_TABLE}owner\\s+to\\s+(${IDENTIFIER})`, 'gi');
const ENABLED = new RegExp(`${ALTER_TABLE}enable\\s+row\\s+level\\s+security`, 'gi');
const FORCED = new RegExp(`${ALTER_TABLE}force\\s+row\\s+level\\s+security`, 'gi');
const PROTECTION_REMOVED =
  /\b(disable\s+row\s+level\s+security|no\s+force\s+row\s+level\s+security)/gi;
const POLICY = new RegExp(
  String.raw`\bcreate\s+policy\s+(${IDENTIFIER})\s+on\s+${QUALIFIED_NAME}([^;]*?)(?=\busing\b|\bwith\s+check\b|;|$)`,
  'gi',
);

function stripComments(sql: string): string {
  return sql.replaceAll(/\/\*[\s\S]*?\*\//g, ' ').replaceAll(/--[^\n]*/g, ' ');
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

function tablesMatching(sql: string, pattern: RegExp): Set<string> {
  const tables = new Set<string>();
  for (const match of sql.matchAll(pattern)) {
    if (match[1] !== undefined) tables.add(normaliseTable(match[1]));
  }
  return tables;
}

/** Problems found in one migration's SQL; empty when it satisfies the rules. */
export function lintMigrationSql(sql: string): string[] {
  const text = stripComments(sql);
  const problems: string[] = [];

  const ownedByOwner = new Set<string>();
  for (const match of text.matchAll(OWNED_BY)) {
    if (match[1] !== undefined && match[2] !== undefined && unquote(match[2]) === OWNER_ROLE) {
      ownedByOwner.add(normaliseTable(match[1]));
    }
  }
  const enabled = tablesMatching(text, ENABLED);
  const forced = tablesMatching(text, FORCED);

  for (const created of tablesMatching(text, CREATED_TABLE)) {
    if (!ownedByOwner.has(created)) {
      problems.push(`table ${created}: missing ALTER TABLE ... OWNER TO ${OWNER_ROLE}`);
    }
    if (!enabled.has(created)) {
      problems.push(`table ${created}: missing ALTER TABLE ... ENABLE ROW LEVEL SECURITY`);
    }
    if (!forced.has(created)) {
      problems.push(`table ${created}: missing ALTER TABLE ... FORCE ROW LEVEL SECURITY`);
    }
  }

  for (const match of text.matchAll(PROTECTION_REMOVED)) {
    problems.push(`migration runs ${(match[1] ?? '').replaceAll(/\s+/g, ' ').toUpperCase()}`);
  }

  for (const match of text.matchAll(POLICY)) {
    if (/\bto\b/i.test(match[3] ?? '')) {
      problems.push(
        `policy ${unquote(match[1] ?? '')} on ${normaliseTable(match[2] ?? '')} names a role: policies decide on the request context, never on the connecting role`,
      );
    }
  }

  return problems;
}
