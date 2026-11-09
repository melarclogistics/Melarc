import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * **A permission key is on no screen** (PRODUCT_DESIGN_DIRECTION section 6.5, the Product Owner's decision of 5 November 2026; the review of 499399c found "waits for a holder of
 * pickup.exception.approve" on a page). A refusal names the capability in plain words, from the one table `platform/problem/capability-words.ts`. This reads the syntax tree of every
 * source file of the portal and fails on a key of the catalogue (`contracts/permissions.md`) in a string, in a template or in the text of an element, unless the key is
 * the argument of `holds(` or `cannotText(`, the value of a `permission` or `decidedBy` attribute or property (the guards and the route registry name the key they ask for), or a
 * constant whose every use is one of those. A comment is not a node, so it may name a key; a test, the showcase and the stand-ins of `test-support` are not screens.
 */
const ROOT = resolve(import.meta.dirname, '../../..');
const SRC = join(ROOT, 'apps', 'ops-web', 'src');

/** The calls that take a key to ask a question about it, and the attributes and properties that name the key a guard or a route asks for. */
const CALLS: ReadonlySet<string> = new Set(['holds', 'cannotText']);
const NAMES: ReadonlySet<string> = new Set(['permission', 'decidedBy']);

/** The permission keys of the catalogue: the first cell of each row of `contracts/permissions.md`'s tables that is a key. */
function catalogueKeys(): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const line of readFileSync(join(ROOT, 'contracts', 'permissions.md'), 'utf8').split('\n')) {
    const cell = /^\|\s*`([a-z]+(?:\.[a-z_]+){1,3})`/.exec(line);
    if (cell?.[1] !== undefined) keys.add(cell[1]);
  }
  return keys;
}

/** The files that are screens' code: not a test, not the showcase, not the test stand-ins, and not the table of words that is keyed by the keys. */
function screenSources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      return name === 'showcase' || name === 'test-support' ? [] : screenSources(path);
    }
    const isSource = /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name);
    return isSource && name !== 'capability-words.ts' ? [path] : [];
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

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
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

/** Whether the expression sits where a key is asked about and not shown: an argument of `holds(`/`cannotText(`, or the value of `permission`/`decidedBy`. */
function isKeyPosition(node: ts.Node): boolean {
  const at = outward(node);
  const parent = at.parent;
  if (ts.isCallExpression(parent)) {
    const name = calleeName(parent);
    return name !== undefined && CALLS.has(name) && parent.arguments.some((item) => item === at);
  }
  if (ts.isJsxAttribute(parent)) return NAMES.has(nameOf(parent.name) ?? '');
  if (ts.isJsxExpression(parent) && ts.isJsxAttribute(parent.parent)) {
    return NAMES.has(nameOf(parent.parent.name) ?? '');
  }
  if (ts.isPropertyAssignment(parent)) {
    return parent.initializer === at && NAMES.has(nameOf(parent.name) ?? '');
  }
  return false;
}

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly what: string;
}

/** What the text of a source says of a key: every place it is written where a screen could show it, and the constants that hold a key. */
function scan(
  sources: readonly { readonly file: string; readonly text: string }[],
  keys: ReadonlySet<string>,
): { readonly found: Finding[]; readonly allowed: number } {
  const found: Finding[] = [];
  const parsed = sources.map(({ file, text }) => ({ file, tree: parse(text, file) }));
  const constants = new Set<string>();
  let allowed = 0;
  const lineOf = (tree: ts.SourceFile, node: ts.Node) =>
    tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;

  for (const { file, tree } of parsed) {
    walk(tree, (node) => {
      const isWhole = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
      const isPart =
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node) ||
        ts.isJsxText(node);
      if (!isWhole && !isPart) return;
      const named = keysIn(node.text, keys);
      if (named.length === 0) return;
      const whole = isWhole && named.length === 1 && named[0] === node.text;
      if (whole && isKeyPosition(node)) {
        allowed += 1;
        return;
      }
      const at = outward(node).parent;
      if (
        whole &&
        ts.isVariableDeclaration(at) &&
        ts.isIdentifier(at.name) &&
        at.initializer === outward(node)
      ) {
        constants.add(at.name.text);
        allowed += 1;
        return;
      }
      found.push({
        file,
        line: lineOf(tree, node),
        what: `${named.join(', ')} written in ${ts.SyntaxKind[node.kind]}`,
      });
    });
  }

  // A constant that holds a key is no screen text while it is only ever used to ask about the key.
  if (constants.size > 0) {
    for (const { file, tree } of parsed) {
      walk(tree, (node) => {
        if (!ts.isIdentifier(node) || !constants.has(node.text)) return;
        const parent = node.parent;
        const declares = ts.isVariableDeclaration(parent) && parent.name === node;
        const imports =
          ts.isImportSpecifier(parent) ||
          ts.isExportSpecifier(parent) ||
          ts.isImportClause(parent) ||
          ts.isNamespaceImport(parent);
        const isMember = ts.isPropertyAccessExpression(parent) && parent.name === node;
        const isPropertyName = ts.isPropertyAssignment(parent) && parent.name === node;
        if (declares || imports || isMember || isPropertyName) return;
        if (ts.isShorthandPropertyAssignment(parent) && NAMES.has(node.text)) return;
        if (isKeyPosition(node)) return;
        found.push({
          file,
          line: lineOf(tree, node),
          what: `the constant ${node.text}, which holds a permission key, used other than to ask about it`,
        });
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

  // Break caught: a screen that tells a person the key (the review of 499399c: "waits for a holder of pickup.exception.approve"), in a sentence, a template, an element or an attribute.
  it('writes no permission key where a screen could show it', () => {
    expect(keys.size).toBeGreaterThan(100);
    const { found, allowed } = scan(sources, keys);
    expect(found.map(({ file, line, what }) => `${file}:${String(line)} ${what}`)).toEqual([]);
    // The check read the files and met the keys the guards and the route registry ask about: a scan that reads nothing finds nothing.
    expect(sources.length).toBeGreaterThan(200);
    expect(allowed).toBeGreaterThan(80);
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

  // Break caught: a scanner so strict that the guards cannot name the key they ask for, or so loose that it is fooled by a comment.
  it('lets a key be asked about: holds, cannotText, permission, decidedBy, a constant used only so, and a comment', () => {
    const fine = (code: string) => scan(sourceOf(code), keys).found;
    expect(
      fine(`if (me.holds('pickup.read')) run(); if (me?.holds('pickup.read')) run();`),
    ).toEqual([]);
    expect(fine(`const t = cannotText('pickup.exception.approve');`)).toEqual([]);
    expect(
      fine(`const a = <ForbiddenPage kind="permission-missing" permission="pickup.read" />;`),
    ).toEqual([]);
    expect(
      fine(`const a = <Guard permission={'pickup.read'} decidedBy="pickup.exception.approve" />;`),
    ).toEqual([]);
    expect(
      fine(
        `const r = { access: { permission: 'pickup.exception.request', decidedBy: 'pickup.exception.approve' } };`,
      ),
    ).toEqual([]);
    expect(
      fine(
        `export const QUEUE = 'pickup.read'; const ok = me.holds(QUEUE); const a = <G permission={QUEUE} />;`,
      ),
    ).toEqual([]);
    expect(fine(`// a holder of pickup.read\n/* pickup.exception.approve */ const a = 1;`)).toEqual(
      [],
    );
    expect(fine(`const a = 'made.up.key'; const b = 'see pickup requests';`)).toEqual([]);
  });
});
