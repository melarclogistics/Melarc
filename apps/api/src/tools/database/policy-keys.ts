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
 * has not named, by literal, a key of that kind to take first is refused as well, because the primitive would take its own key in the middle of the run. **Run 6, Stage 1.7**
 * closed four more: a change whose key is a variable (a constant that the statement declares with a literal, as 0075 and 0077 do, is read as that literal; any other variable
 * takes the key of whatever it holds, which the text does not say; **run 7, Stage 3.6**: the file was accepted only when it named every bundle of the seed, which judged the frozen
 * 0043 and 0057 (loops over every row of the bundle table) against today's list, so that a seventh seeded bundle would have had both refused on every fresh database. A change by a
 * variable now makes the **run** take the key of every bundle there is at run time (`everyBundle`; `run-migrations.ts` reads them from the table before its first statement), whatever the
 * file names; a variable fixed policy is still accepted only when the file names both, there being no table to read them from); a routine defined in the file, other than the five themselves, whose body names
 * one of the five (a wrapper makes its call when it is called, which the files do not show); a name in a string that a function other than `EXECUTE` runs as SQL
 * (`query_to_xml`, `ts_stat`, `dblink_exec` and their kin); and a Unicode-escaped identifier (`U&"..."`), whose characters the text does not say. The runner also checks,
 * after each file, that the file took no key the run had not taken first.
 *
 * **What it does not read, accepted as documented by the Product Owner (run 7, Stage 3.6).** A string with backslash escapes (`E'\x6d...'`) that spells a name, a name put together
 * at run time (`'melarc.lock_policy_' || suffix`), a wrapper function defined in an **earlier** migration (a wrapper defined in the file itself is refused above), and a direct advisory
 * lock of a policy key are not seen in the text, and are not refused up front. A miss does not pass, though: the check after each file asks which policy keys the session holds, and a
 * file that took a key the run had not taken first takes the **whole run back** (`MigrationLockOrderError`), with nothing applied. The file is then written to name its keys by
 * literal at its start (MIGRATION_AND_SEEDING.md, "What the reader of the files does not see").
 */

export type FixedPolicyType = 'RIDER' | 'VENDOR';

export interface PolicyKeys {
  /** The bundles, as lower-case identifiers, each once, in the order they are first named. */
  readonly bundleIds: readonly string[];
  /** The fixed permission policies, each once, in the order they are first named. */
  readonly fixedTypes: readonly FixedPolicyType[];
  /**
   * A change of a bundle by a variable (a loop over the bundle table, as 0043 and 0057 write): the key it takes is the key of whatever bundle the variable holds, which the text
   * does not say. The run takes the keys of **every bundle there is at run time**, besides the ones named. Present only when it is so.
   */
  readonly everyBundle?: true;
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

/** The name a routine is defined under, as written (schema-qualified or not, each part quoted or not). */
const DEFINED_ROUTINE_NAME =
  /^\s*create\s+(?:or\s+replace\s+)?(?:function|procedure)\s+(?:if\s+not\s+exists\s+)?((?:"[^"]*"|[a-z_][a-z0-9_$]*)(?:\s*\.\s*(?:"[^"]*"|[a-z_][a-z0-9_$]*))*)/i;

/**
 * What runs a string as SQL: `EXECUTE` of a `DO` block or a function, and the functions that take a query as text (`query_to_xml` and its two kin, `cursor_to_xml`, `ts_stat`, the
 * `dblink` family). A name inside a string of a statement that has one of these may be the call (run 6, Stage 1.7: the reader looked for `EXECUTE` alone).
 */
const RUNS_STRINGS =
  /\b(execute|query_to_xml_and_xmlschema|query_to_xmlschema|query_to_xml|cursor_to_xml|ts_stat|dblink_send_query|dblink_exec|dblink)\b/i;

/** A constant of a `DECLARE` section, with the literal it is given: `platform_admin constant uuid := '5eed...'`. A variable that is not a constant can be assigned again, and is never resolved. */
const CONSTANT_DECLARATION =
  /\b([a-z_][a-z0-9_]*)\s+constant\s+(?:pg_catalog\.)?(?:uuid|text|varchar)\s*(?::=|=|default)\s*'((?:[^']|'')*)'/gi;

/** The name a routine is defined under, unquoted and in lower case (`CREATE FUNCTION melarc.change_role_bundle(...)` is `change_role_bundle`). */
function definedRoutineOf(text: string): string | undefined {
  const written = DEFINED_ROUTINE_NAME.exec(text)?.[1];
  const last = written?.split('.').at(-1)?.trim();
  return last === undefined ? undefined : last.replace(/^"|"$/g, '').toLowerCase();
}

/** The literal a constant of the text is given, when the text declares it once, or the same way each time; otherwise nothing. */
function constantValue(text: string, name: string): string | undefined {
  const values = new Set<string>();
  for (const match of text.matchAll(CONSTANT_DECLARATION)) {
    if ((match[1] ?? '').toLowerCase() === name.toLowerCase()) {
      values.add((match[2] ?? '').replaceAll("''", "'"));
    }
  }
  return values.size === 1 ? [...values][0] : undefined;
}

// ------------------------------------------------------------------------------------------------ the lexer

type Piece =
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'comment'; readonly text: string; readonly closed: boolean }
  /** `unicode`: written `U&'...'`, whose backslash escapes name characters the text does not show (run 6, Stage 1.7). */
  | {
      readonly kind: 'string';
      readonly text: string;
      readonly closed: boolean;
      readonly unicode?: boolean;
    }
  /** `unicode`: written `U&"..."`, a name whose characters may be escaped, so that the text does not say which name it is. */
  | {
      readonly kind: 'identifier';
      readonly text: string;
      readonly closed: boolean;
      readonly unicode?: boolean;
    }
  | {
      readonly kind: 'dollar';
      readonly tag: string;
      readonly body: string;
      readonly closed: boolean;
    };

const IDENTIFIER_CHARACTER = /[\p{L}\p{N}_$]/u;
/** The code before a quote ends in `U&` that stands alone (it is not the end of a longer word): the quote opens a Unicode-escaped string or identifier. */
const UNICODE_ESCAPE_PREFIX = /(?:^|[^\p{L}\p{N}_$])u&$/iu;
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
      const unicode = UNICODE_ESCAPE_PREFIX.test(code);
      flush();
      const { end, closed } = stringEnd(sql, index, escapes);
      pieces.push({
        kind: 'string',
        text: sql.slice(index, end),
        closed,
        ...(unicode ? { unicode } : {}),
      });
      index = end;
    } else if (character === '"') {
      const unicode = UNICODE_ESCAPE_PREFIX.test(code);
      flush();
      const { end, closed } = identifierEnd(sql, index);
      pieces.push({
        kind: 'identifier',
        text: sql.slice(index, end),
        closed,
        ...(unicode ? { unicode } : {}),
      });
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
  /** The Unicode-escaped identifiers (`U&"..."`) as written: names the text does not say. */
  readonly escapedIdentifiers: readonly string[];
  /** The Unicode-escaped strings (`U&'...'`) as written. */
  readonly escapedStrings: readonly string[];
  /** One line for each string, comment, identifier or dollar quote that is never closed. */
  readonly open: readonly string[];
}

/** Dollar-quoted bodies are read again as SQL: a `DO` block's is code, and a comment in it is a comment. */
function render(pieces: readonly Piece[]): Rendered {
  let text = '';
  let blank = '';
  const identifiers: string[] = [];
  const strings: string[] = [];
  const escapedIdentifiers: string[] = [];
  const escapedStrings: string[] = [];
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
        if (piece.unicode === true) escapedIdentifiers.push(piece.text);
      } else {
        strings.push(piece.text);
        if (piece.unicode === true) escapedStrings.push(piece.text);
      }
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
      escapedIdentifiers.push(...inner.escapedIdentifiers);
      escapedStrings.push(...inner.escapedStrings);
      open.push(...inner.open);
      if (!piece.closed) open.push(`a dollar quote ${delimiter} that is never closed`);
    }
  }
  return { text, blank, identifiers, strings, escapedIdentifiers, escapedStrings, open };
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

const IDENTIFIER_WORD = /^[a-z_][a-z0-9_]*$/i;

/** A piece of the text as a line of a refusal: whole when short, cut with an ellipsis when long. */
const shortened = (text: string): string => (text.length > 40 ? `${text.slice(0, 37)}...` : text);

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
  let changesAFixedPolicy: string | undefined;
  /** A change of a bundle, and the first change of a fixed policy, whose key is a variable (not a literal, nor a constant declared with one): judged at the end of the file. */
  let variableBundleChange = false;
  let variableFixedChange: string | undefined;

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
      const { text, blank, identifiers, strings, escapedIdentifiers, escapedStrings, open } =
        render(statement);
      for (const line of open) unresolved.push(`${line}, so the rest of the text cannot be read`);
      // A Unicode-escaped identifier (`U&"..."`) names its characters by escape, so the text does not say which name it is: it may be the schema or one of the five (run 6, Stage 1.7).
      for (const written of escapedIdentifiers) {
        unresolved.push(
          `${shortened(written)} is a Unicode-escaped identifier (U&"..."), a name the runner does not read`,
        );
      }
      if (DEFINES_A_ROUTINE.test(blank)) {
        const defined = definedRoutineOf(text);
        // The five's own definitions (0017 makes them, 0078 and 0079 replace two) call each other and run nothing now.
        if (defined !== undefined && (FUNCTIONS as readonly string[]).includes(defined)) continue;
        // Any other routine whose body names one of the five is a wrapper: the call is made when it is called, which the runner cannot see from the files (run 6, Stage 1.7).
        const named = [
          ...new Set(
            [
              ...blank.matchAll(MENTION),
              ...strings.flatMap((string) => [...string.matchAll(MENTION)]),
            ].map((mention) => (mention[1] ?? '').toLowerCase()),
          ),
        ];
        if (named.length > 0) {
          unresolved.push(
            `${defined ?? 'a routine'} is defined here and its body names ${named.join(', ')}: the runner reads calls, not a routine that makes one when it is called later`,
          );
        }
        continue;
      }

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
          // The key the primitive takes is the bundle it is given: a literal, or a constant the statement declares with one (0075 and 0077 write `platform_admin constant uuid := '...'`).
          // A variable that is not a constant, a field, a query: the runner cannot say which bundle it is, and a bundle that another key of the file names is not that one (run 6, Stage 1.7).
          const first = firstArgument(args).trim();
          const item =
            literal(first) ??
            (IDENTIFIER_WORD.test(first) ? constantValue(text, first) : undefined);
          if (item !== undefined && UUID.test(item)) addBundle(item);
          else variableBundleChange = true;
        } else {
          changesAFixedPolicy ??= describe(name, args);
          const first = firstArgument(args).trim();
          const item =
            literal(first) ??
            (IDENTIFIER_WORD.test(first) ? constantValue(text, first) : undefined);
          if (item !== undefined && FIXED_TYPES.includes(item)) addFixed(item);
          else variableFixedChange ??= describe(name, args);
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
      // A name inside a string is text, unless the statement runs strings as SQL (`EXECUTE format(...)`, `query_to_xml('...')`, `ts_stat('...')`, `dblink_exec`...): then it may be the
      // call, and a string whose characters are escaped (`U&'...'`) is not read at all.
      const runner = RUNS_STRINGS.exec(blank)?.[1];
      if (runner !== undefined) {
        const how =
          runner.toLowerCase() === 'execute'
            ? 'a statement that EXECUTEs'
            : `a statement that runs it as SQL (${runner.toLowerCase()})`;
        for (const string of strings) {
          for (const mention of string.matchAll(MENTION)) {
            unresolved.push(`${(mention[1] ?? '').toLowerCase()} is named in a string of ${how}`);
          }
        }
        for (const written of escapedStrings) {
          unresolved.push(
            `${shortened(written)} is a Unicode-escaped string (U&'...') in ${how}: its text is not read`,
          );
        }
      }
    }
  }

  // A change whose key is a variable (a loop over the bundle table, as 0043 and 0057 write) takes the key of whatever bundle or fixed policy the variable holds, which the text
  // does not say. For a bundle the run takes the key of every bundle there is at run time (run 7, Stage 3.6: `everyBundle`); there is no table to read the fixed policies from, so a
  // variable fixed policy is read as safe only when the file has named both, so that whatever it holds was taken first. Any other variable is the case that was accepted when the
  // file had named some other key (run 6, Stage 1.7).
  let refusedAChange = false;
  if (variableFixedChange !== undefined) {
    const missing = FIXED_TYPES.filter((type) => !fixedTypes.includes(type as FixedPolicyType));
    if (missing.length > 0) {
      refusedAChange = true;
      unresolved.push(
        `${variableFixedChange}: the fixed policy is a variable, and the file does not name both fixed policies by literal (${missing.join(' and ')} missing), so the runner cannot say that the keys it takes first are all the keys the variable can hold`,
      );
    }
  }
  // The primitive takes its own key, in the middle of the run, unless the file named one of that kind to be taken first. (A change of a bundle needs no such check since run 7,
  // Stage 3.6: its bundle is a literal, which is taken first, or a variable, and then the run takes every bundle there is.)
  if (!refusedAChange && changesAFixedPolicy !== undefined && fixedTypes.length === 0) {
    unresolved.push(
      `${changesAFixedPolicy}: no fixed policy is named by literal in a lock_policy_keys call of the file`,
    );
  }
  return {
    bundleIds,
    fixedTypes,
    unresolved,
    ...(variableBundleChange ? { everyBundle: true as const } : {}),
  };
}

/** The keys of a run: those of its files together, each once. */
export function policyKeysOfRun(scans: readonly PolicyKeys[]): PolicyKeys {
  const bundleIds: string[] = [];
  const fixedTypes: FixedPolicyType[] = [];
  let everyBundle = false;
  for (const scan of scans) {
    for (const id of scan.bundleIds) if (!bundleIds.includes(id)) bundleIds.push(id);
    for (const type of scan.fixedTypes) if (!fixedTypes.includes(type)) fixedTypes.push(type);
    if (scan.everyBundle === true) everyBundle = true;
  }
  return { bundleIds, fixedTypes, ...(everyBundle ? { everyBundle: true as const } : {}) };
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
