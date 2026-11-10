import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { REPOSITORY_ROOT } from './support/permission-catalogue';

/**
 * **A page writes no sentence of a refusal of authority** (PRODUCT_DESIGN_DIRECTION section 6.5; the review of f6cf02b found six pages that each wrote "These … are at a hub your account does not
 * work in."): the words of a refusal are one table's, `platform/problem/capability-words.ts` (`refusalText`), and a page names what it holds and passes the kind of refusal. This reads the syntax
 * tree of every file of `src/app/` (the pages and the shell, which are the screens) and fails on the words that tell a hub or a higher authority in a string, a template or the text of an element.
 * The kit's refusal components and the copy of `platform/problem/` are not screens: they take their words from the table too, and their own sentences are held by their tests.
 */
const SRC = join(REPOSITORY_ROOT, 'apps', 'ops-web', 'src');

/** How a refusal for a hub, and a refusal for a higher authority, are worded: a page that writes either is writing the table's sentence again. */
const REFUSAL_WORDS = [/\bhub your (account|session)\b/i, /\bhigher authority\b/i];

function appSources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return appSources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

/** The places in a source where a screen's words are written: strings, templates and the text of elements. */
function wordsOf(
  text: string,
  fileName: string,
): { readonly text: string; readonly line: number }[] {
  const tree = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: { text: string; line: number }[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node)
    ) {
      found.push({
        text: node.text,
        line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}

function refusalWordsIn(text: string, fileName = 'snippet.tsx'): string[] {
  return wordsOf(text, fileName)
    .filter(({ text: words }) => REFUSAL_WORDS.some((pattern) => pattern.test(words)))
    .map(({ text: words, line }) => `${fileName}:${String(line)} ${words}`);
}

describe('the screens and the words of a refusal', () => {
  // Break caught: a page that writes the sentence of a refusal for a hub or for a higher authority itself, so that two screens tell one refusal in two ways.
  it('write none of them: they ask the table', () => {
    const files = appSources(join(SRC, 'app'));
    expect(files.length).toBeGreaterThan(60);
    const offending = files.flatMap((path) =>
      refusalWordsIn(readFileSync(path, 'utf8'), relative(SRC, path).replaceAll('\\', '/')),
    );
    expect(offending).toEqual([]);
  });

  // Break caught: a check that cannot see the sentence it is for, in a string, a template, an element or a conditional.
  it('sees the words of a refusal in a string, a template and the text of an element', () => {
    expect(
      refusalWordsIn(`const a = 'These riders are at a hub your account does not work in.';`),
    ).toHaveLength(1);
    expect(
      refusalWordsIn('const a = `This is at a hub your session does not act in.`;'),
    ).toHaveLength(1);
    expect(refusalWordsIn('const a = `Needs ${who}: a higher authority.`;')).toHaveLength(1);
    expect(refusalWordsIn(`const a = <p>A higher authority is needed.</p>;`)).toHaveLength(1);
    expect(
      refusalWordsIn(
        `const a = cond ? 'It belongs to a hub your session does not act in.' : null;`,
      ),
    ).toHaveLength(1);
  });

  // Break caught: a check so loose that it flags what a page is allowed to say: a place's description ("at your hubs"), and a sentence that is not a refusal.
  it('lets a page say its hubs, and its words that are no refusal', () => {
    expect(refusalWordsIn(`const a = 'Requests booked at your hubs appear here.';`)).toEqual([]);
    expect(
      refusalWordsIn(`const a = 'The riders at your hubs, and whether each is ready to sign in.';`),
    ).toEqual([]);
    expect(refusalWordsIn(`const a = 'This role needs a Platform Admin to decide.';`)).toEqual([]);
    expect(refusalWordsIn(`// a hub your account does not work in\nconst a = 1;`)).toEqual([]);
  });
});
