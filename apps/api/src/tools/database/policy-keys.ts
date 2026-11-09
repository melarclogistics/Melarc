/**
 * The policy keys a migration names, read from its text (run 4, Stage 1, item 3; fail-closed in run 5, Stage 1.5).
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
 *
 * **It fails closed.** The text is read by a lexer of SQL's own quoting (comments, which nest; strings, with the backslashes of an `E''` string; quoted identifiers;
 * dollar-quoted bodies, which are read again as code, because a `DO` block is one, and in which a `--` or a block comment marker is a comment of that code and not
 * of the file), and cut into statements at the semicolons that are not inside any of them, so that a function being defined and a call in the same chunk are two
 * statements. Then every mention of the five functions that is left is accounted for or refused: it is a call written `melarc.<name>(` whose keys are literals; or a
 * statement about the function's signature (`ALTER`, `GRANT`, `REVOKE`, `DROP`, `COMMENT ON FUNCTION`); or it is in a comment or in a string that nothing executes.
 * Anything else (`unresolved`) is a mention the runner cannot place and the run is refused with the file's name: a key named by a variable or a query, a call with
 * no `melarc.` before it or with another schema, a quoted identifier (`"melarc"."lock_policy_keys"`), a name inside a string of a statement that `EXECUTE`s, a
 * string, a comment or a dollar quote that is never closed. A change of a bundle or of a fixed policy (`change_role_bundle`, `change_fixed_policy`) in a file that
 * has not named, by literal, a key of that kind to take first is refused as well, because the primitive would take its own key in the middle of the run. The runner
 * also checks, after each file, that the file took no key the run had not taken first.
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

/** The five functions that take or change a policy key. */
const FUNCTIONS = [
  'lock_policy_keys',
  'lock_policy_bundle',
  'lock_policy_fixed',
  'change_role_bundle',
  'change_fixed_policy',
] as const;
const NAME_PATTERN = FUNCTIONS.join('|');

/** Any mention of one of the five, as a word. */
const MENTION = new RegExp(`\\b(${NAME_PATTERN})\\b`, 'gi');

/** A call of one of the five, as a migration writes it: always in the `melarc` schema, unquoted. The `d` flag gives the index of the name. */
const KEY_CALL = new RegExp(`\\bmelarc\\s*\\.\\s*(${NAME_PATTERN})\\s*\\(`, 'dgi');

/** What stands before a routine's name in a statement about it (`ALTER FUNCTION`, `ON FUNCTION`, `DROP FUNCTION [IF EXISTS]`): its signature, not a call. */
const NAMES_A_ROUTINE = /\b(?:function|procedure)\s+(?:if\s+exists\s+)?$/i;

/** A statement that defines a routine: its body runs when the routine is called, not when the migration is. */
const DEFINES_A_ROUTINE = /^\s*create\s+(?:or\s+replace\s+)?(?:function|procedure)\b/i;

// ------------------------------------------------------------------------------------------------ the lexer

type Piece =
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'comment'; readonly text: string; readonly closed: boolean }
  | { readonly kind: 'string'; readonly text: string; readonly closed: boolean }
  | { readonly kind: 'identifier'; readonly text: string; readonly closed: boolean }
  | {
      readonly kind: 'dollar';
      readonly tag: string;
      readonly body: string;
      readonly closed: boolean;
    };

const IDENTIFIER_CHARACTER = /[\p{L}\p{N}_$]/u;
const DOLLAR_OPEN = /\$([\p{L}_][\p{L}\p{N}_]*)?\$/uy;

/** The index of the end of the line comment that starts at `start`: the newline is not part of it. */
function lineCommentEnd(sql: string, start: number): number {
  const newline = sql.indexOf('\n', start);
  return newline < 0 ? sql.length : newline;
}

/** The index just past the block comment that starts at `start` (they nest, as PostgreSQL's do), and whether it was closed. */
function blockCommentEnd(sql: string, start: number): { end: number; closed: boolean } {
  let depth = 1;
  let index = start + 2;
  while (index < sql.length) {
    if (sql[index] === '/' && sql[index + 1] === '*') {
      depth += 1;
      index += 2;
    } else if (sql[index] === '*' && sql[index + 1] === '/') {
      depth -= 1;
      index += 2;
      if (depth === 0) return { end: index, closed: true };
    } else index += 1;
  }
  return { end: sql.length, closed: false };
}

/** The index just past the single-quoted string that starts at `start`: `''` is a quote inside it, and in an `E''` string a backslash takes the next character. */
function stringEnd(sql: string, start: number, escapes: boolean): { end: number; closed: boolean } {
  let index = start + 1;
  while (index < sql.length) {
    const character = sql[index];
    if (escapes && character === '\\') index += 2;
    else if (character === "'") {
      if (sql[index + 1] === "'") index += 2;
      else return { end: index + 1, closed: true };
    } else index += 1;
  }
  return { end: sql.length, closed: false };
}

/** The index just past the quoted identifier that starts at `start` (`""` is a quote inside it). */
function identifierEnd(sql: string, start: number): { end: number; closed: boolean } {
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] === '"') {
      if (sql[index + 1] === '"') index += 2;
      else return { end: index + 1, closed: true };
    } else index += 1;
  }
  return { end: sql.length, closed: false };
}

/**
 * The text cut into its pieces: code, comments, strings (of both kinds), quoted identifiers and dollar-quoted bodies. Nothing is lost: the pieces, joined, are the text.
 * A body is kept whole; the caller reads it again as SQL (`render`).
 */
function lexSql(sql: string): Piece[] {
  const pieces: Piece[] = [];
  let code = '';
  const flush = (): void => {
    if (code !== '') pieces.push({ kind: 'code', text: code });
    code = '';
  };
  let index = 0;
  while (index < sql.length) {
    const character = sql[index];
    const next = sql[index + 1];
    if (character === '-' && next === '-') {
      flush();
      const end = lineCommentEnd(sql, index);
      pieces.push({ kind: 'comment', text: sql.slice(index, end), closed: true });
      index = end;
    } else if (character === '/' && next === '*') {
      flush();
      const { end, closed } = blockCommentEnd(sql, index);
      pieces.push({ kind: 'comment', text: sql.slice(index, end), closed });
      index = end;
    } else if (character === "'") {
      // `E'...'`: the E is the last character of the code before the quote, and stands alone (it is not the end of a longer word).
      const before = code.at(-1);
      const escapes =
        (before === 'E' || before === 'e') &&
        (code.length === 1 || !IDENTIFIER_CHARACTER.test(code.at(-2) ?? ''));
      flush();
      const { end, closed } = stringEnd(sql, index, escapes);
      pieces.push({ kind: 'string', text: sql.slice(index, end), closed });
      index = end;
    } else if (character === '"') {
      flush();
      const { end, closed } = identifierEnd(sql, index);
      pieces.push({ kind: 'identifier', text: sql.slice(index, end), closed });
      index = end;
    } else if (character === '$' && !IDENTIFIER_CHARACTER.test(code.at(-1) ?? '')) {
      DOLLAR_OPEN.lastIndex = index;
      const opening = DOLLAR_OPEN.exec(sql);
      if (opening === null) {
        code += character;
        index += 1;
      } else {
        flush();
        const delimiter = opening[0];
        const bodyStart = index + delimiter.length;
        const close = sql.indexOf(delimiter, bodyStart);
        pieces.push({
          kind: 'dollar',
          tag: opening[1] ?? '',
          body: sql.slice(bodyStart, close < 0 ? sql.length : close),
          closed: close >= 0,
        });
        index = close < 0 ? sql.length : close + delimiter.length;
      }
    } else {
      code += character ?? '';
      index += 1;
    }
  }
  flush();
  return pieces;
}

/** What a run of pieces reads as: the code with the comments gone, the same with strings and quoted identifiers blanked, and what was found on the way. */
interface Rendered {
  /** The text with comments taken out (a block comment leaves one space); strings and identifiers kept. */
  readonly text: string;
  /** The same text, of the same length, with the inside of every string and quoted identifier blanked: what is left is code. */
  readonly blank: string;
  /** The quoted identifiers, unquoted. */
  readonly identifiers: readonly string[];
  /** The strings, as they were written. */
  readonly strings: readonly string[];
  /** One line for each string, comment, identifier or dollar quote that is never closed. */
  readonly open: readonly string[];
}

/** Dollar-quoted bodies are read again as SQL: a `DO` block's is code, and a comment in it is a comment. */
function render(pieces: readonly Piece[]): Rendered {
  let text = '';
  let blank = '';
  const identifiers: string[] = [];
  const strings: string[] = [];
  const open: string[] = [];
  for (const piece of pieces) {
    if (piece.kind === 'code') {
      text += piece.text;
      blank += piece.text;
    } else if (piece.kind === 'comment') {
      const gap = piece.text.startsWith('/*') ? ' ' : '';
      text += gap;
      blank += gap;
      if (!piece.closed) open.push('a block comment that is never closed');
    } else if (piece.kind === 'string' || piece.kind === 'identifier') {
      text += piece.text;
      blank += piece.text.replaceAll(/[^\n]/g, ' ');
      if (piece.kind === 'identifier') {
        identifiers.push(piece.text.slice(1, piece.closed ? -1 : undefined).replaceAll('""', '"'));
      } else strings.push(piece.text);
      if (!piece.closed) {
        open.push(
          `${piece.kind === 'string' ? 'a string' : 'a quoted identifier'} that is never closed`,
        );
      }
    } else {
      const delimiter = `$${piece.tag}$`;
      const inner = render(lexSql(piece.body));
      const close = piece.closed ? delimiter : '';
      text += delimiter + inner.text + close;
      blank += delimiter + inner.blank + close;
      identifiers.push(...inner.identifiers);
      strings.push(...inner.strings);
      open.push(...inner.open);
      if (!piece.closed) open.push(`a dollar quote ${delimiter} that is never closed`);
    }
  }
  return { text, blank, identifiers, strings, open };
}

/** The text with its comments taken out, at every level (the body of a dollar quote is read again). A comment marker inside a string is part of the string. */
export function withoutComments(sql: string): string {
  return render(lexSql(sql)).text;
}

/** The pieces cut into statements at the semicolons that are not inside a comment, a string, an identifier or a dollar quote. */
function statementsOf(pieces: readonly Piece[]): Piece[][] {
  const statements: Piece[][] = [];
  let current: Piece[] = [];
  for (const piece of pieces) {
    if (piece.kind !== 'code' || !piece.text.includes(';')) {
      current.push(piece);
      continue;
    }
    piece.text.split(';').forEach((part, index) => {
      if (index > 0) {
        statements.push(current);
        current = [];
      }
      if (part !== '') current.push({ kind: 'code', text: part });
    });
  }
  if (current.length > 0) statements.push(current);
  return statements;
}

// ------------------------------------------------------------------------------------------------ reading a call

/** The index of the parenthesis that closes the one at `open` in `code` (strings are blanked there, so none of them interferes), or undefined when it is never closed. */
function closingParenthesis(code: string, open: number): number | undefined {
  let depth = 0;
  for (let index = open; index < code.length; index += 1) {
    if (code[index] === '(') depth += 1;
    else if (code[index] === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return undefined;
}

/** The first argument of a call: the text up to the first comma that is not inside a string, a parenthesis or a bracket. */
function firstArgument(args: string): string {
  let depth = 0;
  for (let index = 0; index < args.length; index += 1) {
    const character = args[index];
    if (character === "'") {
      index = stringEnd(args, index, false).end - 1;
    } else if (character === '(' || character === '[') depth += 1;
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
      const { end } = stringEnd(text, index, false);
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
 * The policy keys named by the statements of one migration file (the chunks the migrator splits it into: `readMigrationFiles(...).sql`), and every mention of the
 * five functions that the runner cannot place (`unresolved`).
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

  for (const chunk of statements) {
    for (const statement of statementsOf(lexSql(chunk))) {
      const { text, blank, identifiers, strings, open } = render(statement);
      for (const line of open) unresolved.push(`${line}, so the rest of the text cannot be read`);
      if (DEFINES_A_ROUTINE.test(blank)) continue;

      /** Where, in the blanked code, a mention of the five has been placed. */
      const placed = new Set<number>();
      for (const match of blank.matchAll(KEY_CALL)) {
        const name = (match[1] ?? '').toLowerCase();
        placed.add(match.indices?.[1]?.[0] ?? match.index);
        // `ALTER FUNCTION melarc.x(...)`, a GRANT, a REVOKE and a DROP name the function's signature: they call nothing.
        if (NAMES_A_ROUTINE.test(blank.slice(0, match.index))) continue;
        const parenthesis = match.index + match[0].length - 1;
        const close = closingParenthesis(blank, parenthesis);
        if (close === undefined) {
          unresolved.push(`melarc.${name}( that is never closed`);
          continue;
        }
        const args = text.slice(parenthesis + 1, close);
        if (name === 'lock_policy_keys') {
          const { strings: found, rest } = literalsOf(args);
          const known = found.every((item) => UUID.test(item) || FIXED_TYPES.includes(item));
          if (rest !== '' || !known) {
            unresolved.push(describe(name, args));
            continue;
          }
          for (const item of found) {
            if (UUID.test(item)) addBundle(item);
            else addFixed(item);
          }
        } else if (name === 'lock_policy_bundle') {
          const item = literal(args);
          if (item !== undefined && UUID.test(item)) addBundle(item);
          else unresolved.push(describe(name, args));
        } else if (name === 'lock_policy_fixed') {
          const item = literal(args);
          if (item !== undefined && FIXED_TYPES.includes(item)) addFixed(item);
          else unresolved.push(describe(name, args));
        } else if (name === 'change_role_bundle') {
          changesABundle ??= describe(name, args);
          const item = literal(firstArgument(args));
          if (item !== undefined && UUID.test(item)) addBundle(item);
        } else {
          changesAFixedPolicy ??= describe(name, args);
          const item = literal(firstArgument(args));
          if (item !== undefined && FIXED_TYPES.includes(item)) addFixed(item);
        }
      }

      // Fail closed: every other mention of the five in the code of the statement is one the runner cannot place, unless the statement is about the function's signature.
      for (const mention of blank.matchAll(MENTION)) {
        if (placed.has(mention.index)) continue;
        const name = (mention[1] ?? '').toLowerCase();
        const before = blank.slice(0, mention.index);
        if (NAMES_A_ROUTINE.test(before)) continue;
        unresolved.push(
          /\.\s*$/.test(before)
            ? `${name} is called with a qualifier other than an unquoted melarc.`
            : `${name} is called with no melarc. before it (an unqualified call)`,
        );
      }
      // A quoted identifier that is one of the five (`"melarc"."lock_policy_keys"(...)`) is a call written in a form the runner does not read.
      for (const identifier of identifiers) {
        if ((FUNCTIONS as readonly string[]).includes(identifier.toLowerCase())) {
          unresolved.push(
            `"${identifier}" is a quoted identifier, a call in a form the runner does not read`,
          );
        }
      }
      // A name inside a string is text, unless the statement executes strings (`EXECUTE format(...)`): then it may be the call.
      if (/\bexecute\b/i.test(blank)) {
        for (const string of strings) {
          for (const mention of string.matchAll(MENTION)) {
            unresolved.push(
              `${(mention[1] ?? '').toLowerCase()} is named in a string of a statement that EXECUTEs`,
            );
          }
        }
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
 * The keys of the files of a run, or the refusal of the run: every mention the runner cannot place, in any file, is named with the file (`<tag>: ...`) in one
 * `MigrationLockOrderError`, before anything is applied. This is where "it fails closed" is decided (run 5, Stage 1.5).
 */
export function policyKeysOfFiles(
  files: readonly { readonly tag: string; readonly sql: readonly string[] }[],
): PolicyKeys {
  const scans = files.map(({ tag, sql }) => ({ tag, scan: scanPolicyKeys(sql) }));
  const unsaid = scans.flatMap(({ tag, scan }) => scan.unresolved.map((line) => `${tag}: ${line}`));
  if (unsaid.length > 0) throw new MigrationLockOrderError(unsaid);
  return policyKeysOfRun(scans.map(({ scan }) => scan));
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
