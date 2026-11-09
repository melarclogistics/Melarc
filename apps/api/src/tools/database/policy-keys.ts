/**
 * The policy keys a migration names, read from its text (run 4, Stage 1, item 3).
 *
 * A migration that changes a bundle or a fixed permission policy, or that locks the ledger or a table the application writes after one that does, takes the
 * policy keys with `melarc.lock_policy_keys` (SECURITY_DESIGN.md section 13.10a). The application takes them first and writes after, in the opposite order of
 * a migrator that holds a table lock (an `ALTER TABLE audit_event`, an index build on `pickup_request`) and then asks for a key: with every migration of a run
 * applied in one transaction, a later file's key request waits for an application transaction that holds the key and is waiting for the table, and neither
 * gives way. The runner therefore takes **every key the migrations of its run name, before its first statement** (`run-migrations.ts`); this module says
 * which they are. The calls inside the files stay as they are and are then taken again, which waits for nobody.
 *
 * What it reads: a call of `melarc.lock_policy_keys(ARRAY[<uuid>, ...]::uuid[], ARRAY['RIDER', 'VENDOR']::text[])` (and of `lock_policy_bundle` and
 * `lock_policy_fixed`) names its keys by literal. The statements that define a function or a procedure run nothing and are not read, and comments are not read.
 * What it says it cannot read (`unresolved`): a key named by a variable or a query, and a change of a bundle or of a fixed policy (`change_role_bundle`,
 * `change_fixed_policy`) in a file that has not named, by literal, a key of that kind to take first, because the primitive would then take its own key in the
 * middle of the run. The runner refuses such a run before it applies anything. It reads text, so a call written another way (without `melarc.`, a name built at
 * run time) is invisible to it; the runner also checks, after each file, that the file took no key the run had not taken first.
 */

export type FixedPolicyType = 'RIDER' | 'VENDOR';

export interface PolicyKeys {
  /** The bundles, as lower-case identifiers, each once, in the order they are first named. */
  readonly bundleIds: readonly string[];
  /** The fixed permission policies, each once, in the order they are first named. */
  readonly fixedTypes: readonly FixedPolicyType[];
}

export interface PolicyKeyScan extends PolicyKeys {
  /** One line for each use of the keys that the text does not say, naming the call. Empty when every key is named. */
  readonly unresolved: readonly string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIXED_TYPES: readonly string[] = ['RIDER', 'VENDOR'];

/** A call of one of the five functions that take or change a policy key, as a migration writes it: always in the `melarc` schema. */
const KEY_CALL =
  /\bmelarc\s*\.\s*(lock_policy_keys|lock_policy_bundle|lock_policy_fixed|change_role_bundle|change_fixed_policy)\s*\(/gi;

/** What stands before a routine's name in a statement about it (`ALTER FUNCTION`, `ON FUNCTION`, `DROP FUNCTION`): its signature, not a call. */
const NAMES_A_ROUTINE = /\b(?:function|procedure)\s*$/i;

/** A statement that defines a routine: its body runs when the routine is called, not when the migration is. */
const DEFINES_A_ROUTINE = /^\s*create\s+(?:or\s+replace\s+)?(?:function|procedure)\b/i;

/**
 * The text with its comments taken out: `--` to the end of the line, and block comments (which nest, as PostgreSQL's do). A comment marker inside a quoted string is
 * part of the string. Strings are kept as they are, because the keys are strings.
 */
export function withoutComments(sql: string): string {
  let out = '';
  let index = 0;
  while (index < sql.length) {
    const character = sql[index];
    const next = sql[index + 1];
    if (character === "'") {
      const end = endOfString(sql, index);
      out += sql.slice(index, end);
      index = end;
    } else if (character === '-' && next === '-') {
      while (index < sql.length && sql[index] !== '\n') index += 1;
    } else if (character === '/' && next === '*') {
      let depth = 1;
      index += 2;
      while (index < sql.length && depth > 0) {
        if (sql[index] === '/' && sql[index + 1] === '*') {
          depth += 1;
          index += 2;
        } else if (sql[index] === '*' && sql[index + 1] === '/') {
          depth -= 1;
          index += 2;
        } else index += 1;
      }
      out += ' ';
    } else {
      out += character ?? '';
      index += 1;
    }
  }
  return out;
}

/** The index just past the single-quoted string that starts at `start` (a doubled quote is one quote inside it). */
function endOfString(sql: string, start: number): number {
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] === "'") {
      if (sql[index + 1] === "'") index += 2;
      else return index + 1;
    } else index += 1;
  }
  return sql.length;
}

/** The text between the parenthesis at `open` and its partner, or undefined when it is never closed. Quoted strings are skipped. */
function argumentsFrom(sql: string, open: number): string | undefined {
  let depth = 0;
  for (let index = open; index < sql.length; index += 1) {
    const character = sql[index];
    if (character === "'") {
      index = endOfString(sql, index) - 1;
    } else if (character === '(') depth += 1;
    else if (character === ')') {
      depth -= 1;
      if (depth === 0) return sql.slice(open + 1, index);
    }
  }
  return undefined;
}

/** The first argument of a call: the text up to the first comma that is not inside a string, a parenthesis or a bracket. */
function firstArgument(args: string): string {
  let depth = 0;
  for (let index = 0; index < args.length; index += 1) {
    const character = args[index];
    if (character === "'") index = endOfString(args, index) - 1;
    else if (character === '(' || character === '[') depth += 1;
    else if (character === ')' || character === ']') depth -= 1;
    else if (character === ',' && depth === 0) return args.slice(0, index);
  }
  return args;
}

/** The single-quoted strings of a piece of text, and what is left when they and the plain words of an array of literals are taken out. */
function literalsOf(text: string): { readonly strings: string[]; readonly rest: string } {
  const strings: string[] = [];
  let rest = '';
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "'") {
      const end = endOfString(text, index);
      strings.push(text.slice(index + 1, end - 1).replaceAll("''", "'"));
      index = end - 1;
    } else rest += text[index] ?? '';
  }
  const plain = rest
    .replaceAll(/::\s*(?:uuid|text)\s*(?:\[\s*\])?/gi, '')
    .replaceAll(/\barray\b/gi, '')
    .replaceAll(/[\s,[\]]/g, '');
  return { strings, rest: plain };
}

function describe(name: string, args: string): string {
  const flat = args.replaceAll(/\s+/g, ' ').trim();
  return `melarc.${name}(${flat.length > 70 ? `${flat.slice(0, 67)}...` : flat})`;
}

/**
 * The policy keys named by the statements of one migration file (the chunks the migrator splits it into: `readMigrationFiles(...).sql`).
 */
export function scanPolicyKeys(statements: readonly string[]): PolicyKeyScan {
  const bundleIds: string[] = [];
  const fixedTypes: FixedPolicyType[] = [];
  const unresolved: string[] = [];
  let changesABundle: string | undefined;
  let changesAFixedPolicy: string | undefined;

  const addBundle = (id: string): void => {
    const canonical = id.toLowerCase();
    if (!bundleIds.includes(canonical)) bundleIds.push(canonical);
  };
  const addFixed = (type: string): void => {
    if (!FIXED_TYPES.includes(type)) return;
    if (!fixedTypes.includes(type as FixedPolicyType)) fixedTypes.push(type as FixedPolicyType);
  };
  /** One literal of the right kind, or nothing: the caller says it is unresolved. */
  const literal = (argument: string): string | undefined => {
    const { strings, rest } = literalsOf(argument);
    return strings.length === 1 && rest === '' ? strings[0] : undefined;
  };

  for (const statement of statements) {
    const code = withoutComments(statement);
    if (DEFINES_A_ROUTINE.test(code)) continue;
    for (const match of code.matchAll(KEY_CALL)) {
      // `ALTER FUNCTION melarc.x(...)`, a GRANT, a REVOKE and a DROP name the function's signature: they call nothing.
      if (NAMES_A_ROUTINE.test(code.slice(0, match.index))) continue;
      const name = (match[1] ?? '').toLowerCase();
      const open = match.index + match[0].length - 1;
      const args = argumentsFrom(code, open);
      if (args === undefined) {
        unresolved.push(`melarc.${name}( that is never closed`);
        continue;
      }
      if (name === 'lock_policy_keys') {
        const { strings, rest } = literalsOf(args);
        const known = strings.every((text) => UUID.test(text) || FIXED_TYPES.includes(text));
        if (rest !== '' || !known) {
          unresolved.push(describe(name, args));
          continue;
        }
        for (const text of strings) {
          if (UUID.test(text)) addBundle(text);
          else addFixed(text);
        }
      } else if (name === 'lock_policy_bundle') {
        const text = literal(args);
        if (text !== undefined && UUID.test(text)) addBundle(text);
        else unresolved.push(describe(name, args));
      } else if (name === 'lock_policy_fixed') {
        const text = literal(args);
        if (text !== undefined && FIXED_TYPES.includes(text)) addFixed(text);
        else unresolved.push(describe(name, args));
      } else if (name === 'change_role_bundle') {
        changesABundle ??= describe(name, args);
        const text = literal(firstArgument(args));
        if (text !== undefined && UUID.test(text)) addBundle(text);
      } else {
        changesAFixedPolicy ??= describe(name, args);
        const text = literal(firstArgument(args));
        if (text !== undefined && FIXED_TYPES.includes(text)) addFixed(text);
      }
    }
  }

  // The primitive takes its own key, in the middle of the run, unless the file named one of that kind to be taken first.
  if (changesABundle !== undefined && bundleIds.length === 0) {
    unresolved.push(
      `${changesABundle}: no bundle is named by literal in a lock_policy_keys call of the file`,
    );
  }
  if (changesAFixedPolicy !== undefined && fixedTypes.length === 0) {
    unresolved.push(
      `${changesAFixedPolicy}: no fixed policy is named by literal in a lock_policy_keys call of the file`,
    );
  }
  return { bundleIds, fixedTypes, unresolved };
}

/** The keys of a run: those of its files together, each once. */
export function policyKeysOfRun(scans: readonly PolicyKeys[]): PolicyKeys {
  const bundleIds: string[] = [];
  const fixedTypes: FixedPolicyType[] = [];
  for (const scan of scans) {
    for (const id of scan.bundleIds) if (!bundleIds.includes(id)) bundleIds.push(id);
    for (const type of scan.fixedTypes) if (!fixedTypes.includes(type)) fixedTypes.push(type);
  }
  return { bundleIds, fixedTypes };
}

/**
 * A run that does not take its policy keys first: a file names a key it cannot say (so that the file would take it in the middle of the run), or took a key the run had
 * not taken before its first statement. Nothing of the run is kept.
 */
export class MigrationLockOrderError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(
      `The policy keys of the run are not all taken before its first statement:\n${problems.map((line) => `  ${line}`).join('\n')}\nName the keys by literal in a melarc.lock_policy_keys call at the start of the file (the existing files from 0043 on show the form), so that the runner can take them first.`,
    );
    this.name = 'MigrationLockOrderError';
  }
}
