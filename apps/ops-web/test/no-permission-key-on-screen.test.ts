import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { catalogueKeys, REPOSITORY_ROOT } from './support/permission-catalogue';

/**
 * **A permission key is on no screen** (PRODUCT_DESIGN_DIRECTION section 6.5, the Product Owner's decision of 5 November 2026; the review of 499399c found "waits for a holder of
 * pickup.exception.approve" on a page, and the review of f6cf02b found the guard itself had holes). A refusal names the capability in plain words, from the one table
 * `platform/problem/capability-words.ts`. This reads the syntax tree of every source file of the portal, that table included, and fails on a key of the catalogue
 * (`contracts/permissions.md`) wherever a screen could show it: in a string, a template, the text of an element, a name put together from parts (`'pickup.' + 'read'`,
 * `` `pickup.${'read'}` ``, `['pickup', 'read'].join('.')`, a constant of parts), or a constant that holds one (under whatever name it is imported). A key is let through in **its own place
 * only**: the key argument of `holds(`, `cannotText(` and `refusalText(` (the words after it are the table's, and a type keeps them so), the `permission` or `decidedBy` of the kit components that read a key to
 * look its words up ({@link KEY_CONSUMERS}, listed so that a new one is a choice), the `permission` and `decidedBy` of a route's `access`, and the keys of the table of words. A comment is
 * not a node, so it may name a key; a test, the showcase and the stand-ins of `test-support` are not screens. What reading cannot see (a name built from a variable, a value an answer
 * carried) is caught by the runtime half: the render helpers of the page tests (`src/test-support/permission-keys.ts`) and the page watcher of the browser tests (`test/browser/support/page.ts`).
 */
const SRC = join(REPOSITORY_ROOT, 'apps', 'ops-web', 'src');
const WORDS_FILE = 'platform/problem/capability-words.ts';

/** The calls that take a key to ask about, and which argument it is (counted from 0): `refusalText(kind, key, …)` has the kind of refusal before it. Any other argument is drawn as written. */
const KEY_CALLS: ReadonlyMap<string, number> = new Map([
  ['holds', 0],
  ['cannotText', 0],
  ['cannotAllText', 0],
  ['lackedText', 1],
  ['refusalText', 1],
]);

/** The attributes and properties that name the key a guard, a refusal or a route asks for. */
const NAMES: ReadonlySet<string> = new Set(['permission', 'decidedBy']);

/**
 * The components that take a key as `permission` or `decidedBy` and only look its words up (`cannotText`) or ask a question of it, drawing none of it. A key given to any other
 * component is shown, as far as a reader of the source can tell.
 */
const KEY_CONSUMERS: ReadonlySet<string> = new Set([
  'ForbiddenState',
  'ForbiddenPage',
  'ReadState',
  'RefusalOrFailure',
  'RequirePermission',
  'Picker',
  'ActBlock',
]);

/** The files that are screens' code: not a test, not the showcase, not the test stand-ins. The table of words is one: it is read, with its own keys let through. */
function screenSources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      return name === 'showcase' || name === 'test-support' ? [] : screenSources(path);
    }
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

const KEY_SHAPE = /(?<![\w.])[a-z]+(?:\.[a-z_]+){1,3}(?![\w])/g;

function keysIn(text: string, keys: ReadonlySet<string>): string[] {
  return (text.match(KEY_SHAPE) ?? []).filter((candidate) => keys.has(candidate));
}

function parse(text: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/** Visits a node and what is below it; a visit that answers `false` is not entered. */
function walk(node: ts.Node, visit: (node: ts.Node) => boolean | undefined): void {
  if (visit(node) === false) return;
  ts.forEachChild(node, (child) => {
    walk(child, visit);
  });
}

/** The node itself, or the outermost expression that only wraps it (parentheses, `as`, `satisfies`, `!`). */
function outward(node: ts.Node): ts.Node {
  let current = node;
  while (
    ts.isParenthesizedExpression(current.parent) ||
    ts.isAsExpression(current.parent) ||
    ts.isSatisfiesExpression(current.parent) ||
    ts.isNonNullExpression(current.parent)
  ) {
    current = current.parent;
  }
  return current;
}

function calleeName(call: ts.CallExpression): string | undefined {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  return ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
}

function nameOf(name: ts.Node): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
}

/** The name of the element an attribute is on (`ForbiddenPage` for `<ForbiddenPage permission="…" />`). */
function elementOf(attribute: ts.JsxAttribute): string | undefined {
  const element = attribute.parent.parent;
  if (!ts.isJsxOpeningElement(element) && !ts.isJsxSelfClosingElement(element)) return undefined;
  const tag = element.tagName;
  return ts.isIdentifier(tag) ? tag.text : tag.getText();
}

/** Whether `permission`/`decidedBy` is a property of the `access` of a route. */
function isRouteAccess(property: ts.PropertyAssignment): boolean {
  const literal = property.parent;
  const holder = outward(literal).parent;
  return ts.isPropertyAssignment(holder) && nameOf(holder.name) === 'access';
}

/** Whether the string is a key of the table of words (a property name of `CAPABILITY`, in the table's own file). */
function isKeyOfTheTable(node: ts.Node, file: string): boolean {
  if (!file.endsWith(WORDS_FILE)) return false;
  const property = node.parent;
  if (!ts.isPropertyAssignment(property) || property.name !== node) return false;
  const declaration = outward(property.parent).parent;
  return (
    ts.isVariableDeclaration(declaration) &&
    ts.isIdentifier(declaration.name) &&
    declaration.name.text === 'CAPABILITY'
  );
}

/** Whether the expression sits where a key is asked about and not shown. */
function isKeyPosition(node: ts.Node): boolean {
  const at = outward(node);
  const parent = at.parent;
  // The keys of a list handed to a call that takes keys (`lackedText(holds, ['a.b', 'c.d'])`) are each in the key's place.
  if (ts.isArrayLiteralExpression(parent)) return isKeyPosition(parent);
  if (ts.isCallExpression(parent)) {
    const name = calleeName(parent);
    const place = name === undefined ? undefined : KEY_CALLS.get(name);
    return place !== undefined && parent.arguments[place] === at;
  }
  const attribute = ts.isJsxAttribute(parent)
    ? parent
    : ts.isJsxExpression(parent) && ts.isJsxAttribute(parent.parent)
      ? parent.parent
      : undefined;
  if (attribute !== undefined) {
    return NAMES.has(nameOf(attribute.name) ?? '') && KEY_CONSUMERS.has(elementOf(attribute) ?? '');
  }
  if (ts.isPropertyAssignment(parent)) {
    return (
      parent.initializer === at && NAMES.has(nameOf(parent.name) ?? '') && isRouteAccess(parent)
    );
  }
  return false;
}

/** The `const` declarations of a file whose name is declared once: what an identifier in a name put together can be read as. */
function constantsOf(tree: ts.SourceFile): ReadonlyMap<string, ts.Expression> {
  const declared = new Map<string, ts.Expression[]>();
  walk(tree, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      (ts.getCombinedNodeFlags(node) & ts.NodeFlags.Const) !== 0
    ) {
      declared.set(node.name.text, [...(declared.get(node.name.text) ?? []), node.initializer]);
    }
    return undefined;
  });
  const once = new Map<string, ts.Expression>();
  for (const [name, initializers] of declared) {
    if (initializers.length === 1 && initializers[0] !== undefined) once.set(name, initializers[0]);
  }
  return once;
}

/**
 * The text an expression of literals comes to, when reading is enough to know it: string literals, templates and `+` of them, `.join(separator)` of an array of them, `.concat(…)`,
 * and a `const` of the same file that is one. `undefined` when any part is not known (a variable, a call, an argument), which is the runtime half's.
 */
function fold(
  node: ts.Node,
  constants: ReadonlyMap<string, ts.Expression>,
  seen: ReadonlySet<string> = new Set(),
): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return node.text;
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    return fold(node.expression, constants, seen);
  }
  if (ts.isIdentifier(node)) {
    const initializer = constants.get(node.text);
    if (initializer === undefined || seen.has(node.text)) return undefined;
    return fold(initializer, constants, new Set([...seen, node.text]));
  }
  if (ts.isTemplateExpression(node)) {
    let text = node.head.text;
    for (const span of node.templateSpans) {
      const inner = fold(span.expression, constants, seen);
      if (inner === undefined) return undefined;
      text += inner + span.literal.text;
    }
    return text;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = fold(node.left, constants, seen);
    const right = fold(node.right, constants, seen);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const method = node.expression.name.text;
    const target = outwardDown(node.expression.expression);
    if (method === 'join' && ts.isArrayLiteralExpression(target)) {
      const separator =
        node.arguments[0] === undefined ? ',' : fold(node.arguments[0], constants, seen);
      const parts = target.elements.map((element) => fold(element, constants, seen));
      return separator === undefined || parts.some((part) => part === undefined)
        ? undefined
        : parts.join(separator);
    }
    if (method === 'concat') {
      const head = fold(target, constants, seen);
      const tail = node.arguments.map((argument) => fold(argument, constants, seen));
      return head === undefined || tail.some((part) => part === undefined)
        ? undefined
        : head + tail.join('');
    }
  }
  return undefined;
}

/** The expression inside any wrapping parentheses, `as`, `satisfies` and `!`. */
function outwardDown(node: ts.Node): ts.Node {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** A name put together out of parts: a template with substitutions, a `+`, a `.join(` or a `.concat(`. */
function isComposite(node: ts.Node): boolean {
  if (ts.isTemplateExpression(node)) return true;
  if (ts.isBinaryExpression(node)) return node.operatorToken.kind === ts.SyntaxKind.PlusToken;
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    (node.expression.name.text === 'join' || node.expression.name.text === 'concat')
  );
}

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly what: string;
}

/** What the text of the sources says of a key: every place one is written where a screen could show it, and the constants that hold one. */
function scan(
  sources: readonly { readonly file: string; readonly text: string }[],
  keys: ReadonlySet<string>,
): { readonly found: Finding[]; readonly allowed: number } {
  const found: Finding[] = [];
  const parsed = sources.map(({ file, text }) => {
    const tree = parse(text, file);
    return { file, tree, constants: constantsOf(tree) };
  });
  /** The names that hold a key: by their declaration, and under every name they are imported, exported or copied as. */
  const holders = new Set<string>();
  const aliases: (readonly [string, string])[] = [];
  let allowed = 0;
  const lineOf = (tree: ts.SourceFile, node: ts.Node) =>
    tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;

  for (const { file, tree, constants } of parsed) {
    walk(tree, (node) => {
      if (ts.isImportSpecifier(node) || ts.isExportSpecifier(node)) {
        if (node.propertyName !== undefined) aliases.push([node.propertyName.text, node.name.text]);
        return undefined;
      }
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined &&
        ts.isIdentifier(outwardDown(node.initializer))
      ) {
        aliases.push([(outwardDown(node.initializer) as ts.Identifier).text, node.name.text]);
      }

      // A name put together out of parts, read as the whole it comes to.
      if (isComposite(node)) {
        const value = fold(node, constants);
        if (value === undefined) return undefined;
        const named = keysIn(value, keys);
        if (named.length > 0) {
          const whole = named.length === 1 && named[0] === value;
          const at = outward(node);
          if (whole && isKeyPosition(node)) {
            allowed += 1;
          } else if (
            whole &&
            ts.isVariableDeclaration(at.parent) &&
            ts.isIdentifier(at.parent.name) &&
            at.parent.initializer === at
          ) {
            holders.add(at.parent.name.text);
            allowed += 1;
          } else {
            found.push({
              file,
              line: lineOf(tree, node),
              what: `${named.join(', ')} put together from parts in ${ts.SyntaxKind[node.kind]}`,
            });
          }
        }
        return false;
      }

      const isWhole = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
      const isPart =
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node) ||
        ts.isJsxText(node);
      if (!isWhole && !isPart) return undefined;
      const named = keysIn(node.text, keys);
      if (named.length === 0) return undefined;
      const whole = isWhole && named.length === 1 && named[0] === node.text;
      if (whole && (isKeyPosition(node) || isKeyOfTheTable(node, file))) {
        allowed += 1;
        return undefined;
      }
      const at = outward(node).parent;
      if (
        whole &&
        ts.isVariableDeclaration(at) &&
        ts.isIdentifier(at.name) &&
        at.initializer === outward(node)
      ) {
        holders.add(at.name.text);
        allowed += 1;
        return undefined;
      }
      found.push({
        file,
        line: lineOf(tree, node),
        what: `${named.join(', ')} written in ${ts.SyntaxKind[node.kind]}`,
      });
      return undefined;
    });
  }

  // A name a key is copied or imported under holds the key too, however many steps it is passed on in.
  for (let changed = true; changed;) {
    changed = false;
    for (const [from, to] of aliases) {
      if (holders.has(from) && !holders.has(to)) {
        holders.add(to);
        changed = true;
      }
    }
  }

  // A constant that holds a key is no screen text while it is only ever used to ask about the key.
  if (holders.size > 0) {
    for (const { file, tree } of parsed) {
      walk(tree, (node) => {
        if (!ts.isIdentifier(node) || !holders.has(node.text)) return undefined;
        const parent = node.parent;
        const declares = ts.isVariableDeclaration(parent) && parent.name === node;
        const imports =
          ts.isImportSpecifier(parent) ||
          ts.isExportSpecifier(parent) ||
          ts.isImportClause(parent) ||
          ts.isNamespaceImport(parent);
        const isPropertyName = ts.isPropertyAssignment(parent) && parent.name === node;
        // `const COPY = QUEUE`: the copy is another name that holds the key, and is judged by its own uses.
        const copied =
          ts.isVariableDeclaration(outward(node).parent) &&
          (outward(node).parent as ts.VariableDeclaration).initializer === outward(node);
        if (declares || imports || isPropertyName || copied) return undefined;
        // `keys.READ`: the member is the constant, and it is used as the whole access is.
        const used = ts.isPropertyAccessExpression(parent) && parent.name === node ? parent : node;
        if (isKeyPosition(used)) return undefined;
        found.push({
          file,
          line: lineOf(tree, node),
          what: `the name ${node.text}, which holds a permission key, used other than to ask about it`,
        });
        return undefined;
      });
    }
  }
  return { found, allowed };
}

const sourceOf = (text: string, file = 'snippet.tsx') => [{ file, text }];

describe('the source of the portal', () => {
  const keys = catalogueKeys();
  const files = screenSources(SRC);
  const sources = files.map((path) => ({
    file: relative(SRC, path).replaceAll('\\', '/'),
    text: readFileSync(path, 'utf8'),
  }));

  // Break caught: a screen that tells a person the key (the review of 499399c: "waits for a holder of pickup.exception.approve"), in a sentence, a template, an element or an attribute,
  // or a table of words that holds one in its words.
  it('writes no permission key where a screen could show it', () => {
    expect(keys.size).toBeGreaterThan(100);
    const { found, allowed } = scan(sources, keys);
    expect(found.map(({ file, line, what }) => `${file}:${String(line)} ${what}`)).toEqual([]);
    // The check read the files and met the keys the guards, the routes and the table ask about: a scan that reads nothing finds nothing.
    expect(sources.length).toBeGreaterThan(200);
    expect(sources.some(({ file }) => file === WORDS_FILE)).toBe(true);
    expect(allowed).toBeGreaterThan(100);
  });

  // Break caught: the table of words was left out of the scan (it named every key, so it was skipped), and a key in its words would have passed.
  it('reads the table of words as well, and lets through only the keys that name its entries', () => {
    const table = sources.find(({ file }) => file === WORDS_FILE);
    expect(table).toBeDefined();
    const text = table?.text ?? '';
    const withKey = (words: string) =>
      scan(sourceOf(text.replace("'see pickup requests'", `'${words}'`), WORDS_FILE), keys).found
        .length;
    expect(withKey('see pickup requests')).toBe(0);
    expect(withKey('needs pickup.read')).toBe(1);
    expect(withKey('pickup.read')).toBe(1);
  });

  // Break caught: a scanner that lets a key through in some form: each of these is a screen showing a key, and each must be found.
  it('finds a key in a sentence, in a template, in the text of an element, in an attribute and in a constant that is shown', () => {
    const wrong = (code: string) => scan(sourceOf(code), keys).found.length;
    expect(
      wrong(`const a = 'waits for a holder of pickup.exception.approve to approve it.';`),
    ).toBe(1);
    expect(wrong('const a = `waits for ${who} with pickup.read to see it`;')).toBe(1);
    expect(wrong('const a = `${who} pickup.read`;')).toBe(1);
    expect(wrong(`const a = <p>pickup.read</p>;`)).toBe(1);
    expect(wrong(`const a = <Alert title="pickup.read" />;`)).toBe(1);
    expect(wrong(`console.log('pickup.read');`)).toBe(1);
    expect(wrong(`const labels = { name: 'pickup.read' };`)).toBe(1);
    expect(wrong(`const KEY = 'pickup.read'; const a = <p>{KEY}</p>;`)).toBe(1);
    expect(wrong(`const KEY = 'pickup.read'; const a = shown(KEY);`)).toBe(1);
    expect(wrong(`const a = holds('pickup.read') ? 'needs pickup.read' : null;`)).toBe(1);
  });

  // Break caught (the review of f6cf02b): every argument of cannotText was let through, and the second one, `doing`, is drawn as written, so `cannotText(k, 'pickup.read')` put a key on
  // screen and passed. Only the key argument of a call that asks about a key is the key's place: the first of holds and cannotText, the second of refusalText (after the kind).
  it('finds a key in the words of cannotText and refusalText, and in any argument of a call but the key’s', () => {
    const wrong = (code: string) => scan(sourceOf(code), keys).found.length;
    expect(wrong(`const t = refusalText(kind, 'pickup.read', { doing: 'pickup.read' });`)).toBe(1);
    expect(wrong(`const t = refusalText('pickup.read', undefined);`)).toBe(1);
    expect(wrong(`const t = refusalText(kind, undefined, { of: 'staff.read' });`)).toBe(1);
    // A list of keys is in the key's place only as the list a key-taking call is given; anywhere else each is drawn as written.
    expect(
      wrong(`const t = lackedText(holds, ['pickup.read', 'staff.read'], ['pickup.read']);`),
    ).toBe(1);
    expect(wrong(`const t = lackedText(['pickup.read'], holds);`)).toBe(1);
    expect(wrong(`const t = shown(['pickup.read']);`)).toBe(1);
    expect(wrong(`const t = [cannotAllText(['pickup.read']), 'staff.read'];`)).toBe(1);
    expect(wrong(`const t = cannotText('pickup.read', 'pickup.read');`)).toBe(1);
    expect(wrong(`const t = cannotText(key, 'needs pickup.read');`)).toBe(1);
    expect(wrong(`const t = cannotText(undefined, 'staff.read');`)).toBe(1);
    expect(wrong(`const ok = me.holds(other, 'pickup.read');`)).toBe(1);
    expect(
      wrong(
        `const a = <ForbiddenPage kind="permission-missing" permission="pickup.read" capability="staff.read" />;`,
      ),
    ).toBe(1);
    expect(
      wrong(`const a = <ReadState permission="pickup.read" capability={'staff.read'} />;`),
    ).toBe(1);
  });

  // Break caught (the review of f6cf02b): a key built by concatenation or join, which has no literal in it, was not seen. Each of these, shown or kept, is a screen showing a key.
  it('finds a key put together from parts: a +, a template of literals, a join, a concat, a constant of parts', () => {
    const wrong = (code: string) => scan(sourceOf(code), keys).found.length;
    expect(wrong(`const a = <p>{'pickup.' + 'read'}</p>;`)).toBe(1);
    expect(wrong('const a = <p>{`pickup.${"read"}`}</p>;')).toBe(1);
    expect(wrong('const a = <p>{`${"pickup"}.${"read"}`}</p>;')).toBe(1);
    expect(wrong(`const a = <p>{['pickup', 'read'].join('.')}</p>;`)).toBe(1);
    expect(wrong(`const a = <p>{'pickup.'.concat('read')}</p>;`)).toBe(1);
    expect(wrong(`const a = <p title={'staff' + '.' + 'read'} />;`)).toBe(1);
    expect(wrong(`const HEAD = 'pickup'; const a = <p>{HEAD + '.read'}</p>;`)).toBe(1);
    expect(wrong(`const KEY = 'pickup.' + 'read'; const a = <p>{KEY}</p>;`)).toBe(1);
    expect(wrong(`const t = cannotText(who, ['pickup', 'read'].join('.'));`)).toBe(1);
    // Put together and asked about is the key's own place.
    expect(wrong(`if (me.holds('pickup.' + 'read')) run();`)).toBe(0);
    // A name with a part that cannot be read is the runtime half's, and a literal part of it is still read.
    expect(wrong('const a = `pickup.${what}`;')).toBe(0);
    expect(wrong(`const a = 'needs pickup.read' + who;`)).toBe(1);
  });

  // Break caught (the review of f6cf02b): a constant imported under an alias, or copied, or reached through a namespace, was a different name from the one that was known to hold a key.
  it('finds a key held by a constant that is imported under another name, copied, or reached through a namespace', () => {
    const wrong = (...files: readonly { file: string; text: string }[]) =>
      scan(files, keys).found.length;
    const keyFile = { file: 'keys.ts', text: `export const QUEUE = 'pickup.read';` };
    expect(
      wrong(keyFile, {
        file: 'a.tsx',
        text: `import { QUEUE as Q } from './keys'; const a = <p>{Q}</p>;`,
      }),
    ).toBe(1);
    expect(
      wrong(keyFile, {
        file: 'a.tsx',
        text: `import { QUEUE } from './keys'; const COPY = QUEUE; const a = <p>{COPY}</p>;`,
      }),
    ).toBe(1);
    expect(
      wrong(keyFile, {
        file: 'a.tsx',
        text: `import * as keys from './keys'; const a = <p>{keys.QUEUE}</p>;`,
      }),
    ).toBe(1);
    expect(
      wrong(
        keyFile,
        { file: 'b.ts', text: `export { QUEUE as ASKED } from './keys';` },
        { file: 'a.tsx', text: `import { ASKED as X } from './b'; const a = shown(X);` },
      ),
    ).toBe(1);
    // Used to ask about it, under any of these names, it is fine.
    expect(
      wrong(keyFile, {
        file: 'a.tsx',
        text: `import { QUEUE as Q } from './keys'; const ok = me.holds(Q); const a = <ForbiddenPage permission={Q} />;`,
      }),
    ).toBe(0);
    expect(
      wrong(keyFile, {
        file: 'a.tsx',
        text: `import { QUEUE } from './keys'; const COPY = QUEUE; const ok = me.holds(COPY);`,
      }),
    ).toBe(0);
    expect(
      wrong(keyFile, {
        file: 'a.tsx',
        text: `import * as keys from './keys'; const ok = me.holds(keys.QUEUE);`,
      }),
    ).toBe(0);
  });

  // Break caught (the review of f6cf02b): a value given to a prop named `permission` or `decidedBy` on ANY component was let through, so a card that draws what it is given could be handed a key.
  it('lets `permission` and `decidedBy` through only on the components that look a key up, and in a route’s access', () => {
    const wrong = (code: string) => scan(sourceOf(code), keys).found.length;
    for (const component of KEY_CONSUMERS) {
      expect(
        wrong(
          `const a = <${component} permission="pickup.read" decidedBy={'pickup.exception.approve'} />;`,
        ),
        component,
      ).toBe(0);
    }
    expect(wrong(`const a = <Card permission="pickup.read" />;`)).toBe(1);
    expect(wrong(`const a = <Tile decidedBy={'pickup.read'} />;`)).toBe(1);
    expect(wrong(`const a = <Ui.Card permission="pickup.read" />;`)).toBe(1);
    expect(
      wrong(
        `const r = { access: { permission: 'pickup.exception.request', decidedBy: 'pickup.exception.approve' } };`,
      ),
    ).toBe(0);
    expect(wrong(`const r = { permission: 'pickup.read' };`)).toBe(1);
    expect(wrong(`const r = { access: { capability: 'pickup.read' } };`)).toBe(1);
  });

  // Break caught: a scanner so strict that the guards cannot name the key they ask for, or so loose that it is fooled by a comment.
  it('lets a key be asked about: holds, cannotText, permission, decidedBy, a constant used only so, and a comment', () => {
    const fine = (code: string) => scan(sourceOf(code), keys).found;
    expect(
      fine(`if (me.holds('pickup.read')) run(); if (me?.holds('pickup.read')) run();`),
    ).toEqual([]);
    expect(fine(`const t = cannotText('pickup.exception.approve');`)).toEqual([]);
    expect(fine(`const t = cannotText('pickup.read', 'see pickup runs');`)).toEqual([]);
    expect(
      fine(
        `const t = lackedText(me.holds, ['pickup.read', 'staff.read']) ?? cannotAllText(['pickup.read']);`,
      ),
    ).toEqual([]);
    expect(
      fine(`const t = refusalText(problem.forbidden, 'pickup.read', { of: 'pickup requests' });`),
    ).toEqual([]);
    expect(
      fine(`const a = <ForbiddenPage kind="permission-missing" permission="pickup.read" />;`),
    ).toEqual([]);
    expect(
      fine(
        `const a = <RequirePermission permission={'pickup.read'} decidedBy="pickup.exception.approve" />;`,
      ),
    ).toEqual([]);
    expect(
      fine(
        `const r = { access: { permission: 'pickup.exception.request', decidedBy: 'pickup.exception.approve' } };`,
      ),
    ).toEqual([]);
    expect(
      fine(
        `export const QUEUE = 'pickup.read'; const ok = me.holds(QUEUE); const a = <ReadState permission={QUEUE} />;`,
      ),
    ).toEqual([]);
    expect(fine(`// a holder of pickup.read\n/* pickup.exception.approve */ const a = 1;`)).toEqual(
      [],
    );
    expect(fine(`const a = 'made.up.key'; const b = 'see pickup requests';`)).toEqual([]);
  });
});
