/**
 * What keeps the database tests that run at the same time apart (vitest.config.ts: the `database` project runs several files at once,
 * `database-alone` runs one file at a time once the others are done). A file of `test/database/` makes, uses and drops a database of its
 * own. What the whole server shares is not its own: roles, their passwords and memberships, other databases, the server's settings, and
 * what every session of the server is doing. A statement that changes one of those, or watches the server without naming its own database
 * or its own session, belongs in `test/database/alone/`, and so does a test whose time bounds need the machine to itself.
 *
 * This reads the text of the files: the SQL inside their string literals, and the names of the provisioning functions and tools that act on
 * the whole server. The sanctioned uses are the support files that make each test its database and hold the server for it. It cannot see a
 * statement assembled from parts at run time or one a helper of `src/` issues; review still matters.
 */

export interface IsolationFinding {
  readonly path: string;
  readonly line: number;
  readonly rule: string;
  readonly text: string;
}

interface Rule {
  readonly name: string;
  readonly matches: (literal: string) => boolean;
}

const sql =
  (pattern: RegExp): Rule['matches'] =>
  (literal) =>
    pattern.test(literal);

/** A filter to the file's own database or its own session: the database by name or by a parameter, a session by its process id. */
const OWN_SCOPE =
  /\bdatname\s*=\s*(current_database\(\)|\$\d+)|\bdatabase\s*=\s*\(\s*select\s+oid\s+from\s+pg_database\s+where\s+datname\s*=\s*(current_database\(\)|\$\d+)\s*\)|\bpid\s*=\s*(\$\d+|pg_backend_pid\(\))|\bpid\s*=\s*(any|coalesce)\s*\(\s*\$\d+/i;

/** Statements about what the whole server shares, judged inside one string literal. */
const STATEMENT_RULES: readonly Rule[] = [
  { name: 'changes a role', matches: sql(/\b(create|alter|drop)\s+(role|user|group)\b/i) },
  // A statement at the start of the text or after another, granting or revoking roles, which has no ON (an object's privileges do):
  // "a grant issued to a rider" in a test's title is not one.
  { name: 'grants a role to a role', matches: sql(/(^|;)\s*grant\s+(?:(?!\bon\b)[^;])*?\bto\b/i) },
  {
    name: 'revokes a role from a role',
    matches: sql(/(^|;)\s*revoke\s+(?:(?!\bon\b)[^;])*?\bfrom\b/i),
  },
  {
    name: 'creates, changes or drops a database',
    matches: sql(/\b(create|alter|drop)\s+database\b/i),
  },
  { name: "changes the server's settings", matches: sql(/\balter\s+system\b|\bpg_reload_conf\b/i) },
  {
    name: 'watches every session of the server',
    // A query of the server's sessions or locks that keeps neither to its own database nor to a session it knows by its process id. An
    // advisory lock's key is the same in every database, so a look at `pg_locks` by key alone can find a neighbour's.
    matches: (literal) =>
      /\b(from|join)\s+pg_(stat_activity|locks)\b|\bpg_stat_get_activity\s*\(/i.test(literal) &&
      !OWN_SCOPE.test(literal),
  },
  {
    name: 'ends or cancels a session of the server',
    matches: (literal) =>
      /\bpg_(terminate|cancel)_backend\b/i.test(literal) &&
      !OWN_SCOPE.test(literal) &&
      !/_backend\(\s*\$\d+\s*\)/i.test(literal),
  },
  {
    name: 'lists the databases of the server',
    matches: (literal) =>
      /\b(from|join)\s+pg_database\b/i.test(literal) && !OWN_SCOPE.test(literal),
  },
];

/**
 * Names that act on the whole server, wherever they appear in code: the provisioning functions (src/tools/database/provisioning.ts,
 * orphans.ts), the administrator's connection to the server, and the tools a test starts as a process (test/support/api-process.ts).
 */
const SERVER_NAMES =
  /\b(provisionRoles|createDisposableDatabase|dropDisposableDatabase|listTestDatabases|removeNamed|connectLocalAdmin|DB_BOOTSTRAP|DB_RESET|DB_ORPHANS|E2E_DATABASE)\b/g;

/**
 * The files that may use those names: the one that makes each test its database, the one that holds the server for it, and the global
 * setup, which only asks the server whether it answers.
 */
export const SANCTIONED: ReadonlyMap<string, readonly string[]> = new Map([
  [
    'test/database/support/test-database.ts',
    ['provisionRoles', 'createDisposableDatabase', 'dropDisposableDatabase', 'connectLocalAdmin'],
  ],
  ['test/database/support/server-hold.ts', ['connectLocalAdmin']],
  ['test/database/support/global-setup.ts', ['connectLocalAdmin']],
]);

/** The first line every file of `test/database/alone/` starts with, followed by its reason. */
export const ALONE_MARK = '// Runs alone: ';

interface Literal {
  readonly text: string;
  readonly offset: number;
}

/**
 * The string literals of a TypeScript text, comments left out: quoted strings and template literals (the text of a `${...}` part is kept
 * with its template, which is where an interpolated statement lives).
 */
export function stringLiterals(source: string): Literal[] {
  const literals: Literal[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', index);
      index = end === -1 ? source.length : end;
    } else if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end === -1 ? source.length : end + 2;
    } else if (char === "'" || char === '"' || char === '`') {
      const start = index;
      index += 1;
      let depth = 0;
      while (index < source.length) {
        const current = source[index];
        if (current === '\\') {
          index += 2;
          continue;
        }
        if (char === '`' && current === '$' && source[index + 1] === '{') {
          depth += 1;
          index += 2;
          continue;
        }
        if (depth > 0 && current === '}') {
          depth -= 1;
        } else if (depth === 0 && current === char) {
          break;
        } else if (char !== '`' && current === '\n') {
          break;
        }
        index += 1;
      }
      literals.push({ text: source.slice(start + 1, index), offset: start });
      index += 1;
    } else {
      index += 1;
    }
  }
  return literals;
}

const lineOf = (source: string, offset: number): number =>
  source.slice(0, offset).split('\n').length;

const shortText = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 120 ? `${flat.slice(0, 117)}...` : flat;
};

/** What a file that runs beside others does to the state the whole server shares. Paths are relative to `apps/api`. */
export function findSharedStateStatements(
  files: readonly { readonly path: string; readonly text: string }[],
): IsolationFinding[] {
  const findings: IsolationFinding[] = [];
  for (const file of files) {
    for (const literal of stringLiterals(file.text)) {
      for (const rule of STATEMENT_RULES) {
        if (rule.matches(literal.text)) {
          findings.push({
            path: file.path,
            line: lineOf(file.text, literal.offset),
            rule: rule.name,
            text: shortText(literal.text),
          });
        }
      }
    }
    const allowed = SANCTIONED.get(file.path) ?? [];
    const code = withoutCommentsAndStrings(file.text);
    for (const use of code.matchAll(SERVER_NAMES)) {
      const name = use[1] ?? '';
      if (allowed.includes(name)) continue;
      findings.push({
        path: file.path,
        line: lineOf(file.text, use.index),
        rule: 'names a provisioning function or a tool that acts on the whole server',
        text: name,
      });
    }
  }
  return findings;
}

/** The text with every comment and string literal blanked, offsets kept, so that a name inside either is not taken for code. */
function withoutCommentsAndStrings(source: string): string {
  // UTF-16 units, as `indexOf` counts them: a spread would count a character outside the basic plane once and shift every offset after it.
  const characters = source.split('');
  let index = 0;
  const blank = (from: number, to: number): void => {
    for (let at = from; at < to && at < characters.length; at += 1) {
      if (characters[at] !== '\n') characters[at] = ' ';
    }
  };
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', index);
      const stop = end === -1 ? source.length : end;
      blank(index, stop);
      index = stop;
    } else if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(index, stop);
      index = stop;
    } else if (char === "'" || char === '"' || char === '`') {
      const literal = stringLiterals(source.slice(index))[0];
      const stop = index + (literal === undefined ? 1 : literal.text.length + 2);
      blank(index, stop);
      index = stop;
    } else {
      index += 1;
    }
  }
  return characters.join('');
}

/** The files of `test/database/alone/` that do not say, on their first line, why they run alone. */
export function unexplainedAloneFiles(
  files: readonly { readonly path: string; readonly text: string }[],
): string[] {
  return files
    .filter((file) => {
      const first = file.text.split('\n')[0] ?? '';
      return !first.startsWith(ALONE_MARK) || first.slice(ALONE_MARK.length).trim().length < 20;
    })
    .map((file) => file.path);
}
