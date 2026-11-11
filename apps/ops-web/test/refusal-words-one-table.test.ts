import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { ApiError } from '@melarc/api-client/browser';
import { OperationFailure } from '../src/platform/api/api-response';
import {
  CAPABILITY_KEYS,
  OUTSIDE_HUBS_SENTENCES,
  cannotAllText,
  cannotText,
  refusalText,
} from '../src/platform/problem/capability-words';
import { problemOf } from '../src/platform/problem/problem-copy';
import { REPOSITORY_ROOT } from './support/permission-catalogue';

/**
 * **A page writes no sentence of a refusal of authority** (PRODUCT_DESIGN_DIRECTION section 6.5; the review of f6cf02b found six pages that each wrote "These … are at a hub your account does not
 * work in."): the words of a refusal are one table's, `platform/problem/capability-words.ts` (`refusalText`), and a page names what it holds and passes the kind of refusal. This reads the syntax
 * tree of every file of `src/app/` (the pages and the shell, which are the screens) and fails on the words that tell a hub or a higher authority in a string, a template or the text of an element.
 * The kit's refusal components and the copy of `platform/problem/` are not screens: they take their words from the table too, and their own sentences are held by their tests.
 */
const SRC = join(REPOSITORY_ROOT, 'apps', 'ops-web', 'src');

/**
 * How each refusal the table can tell is worded, one pattern for each: a hub (in either of the two ways it used to be said), a higher authority, a different approver deciding, an act the record
 * does not allow, and a missing key (what the account cannot do, and the way out). A page that writes any of them is writing the table's sentence again. The pattern for a sentence is the
 * words that make it that sentence and no others, so that a page's own prose about approvers ("A different approver is needed, unless you are a Platform Admin") is not one; a test below holds
 * that **every sentence the table can give is matched by one**, so a refusal added to the table that no pattern names fails here (run 7, Stage 2.4: two patterns were all there were).
 */
const REFUSAL_WORDS = [
  /\bhub your (account|session)\b/i,
  /\bhigher authority\b/i,
  /\bdifferent approver (decides|is required)\b/i,
  /\bcannot be done for this record\b/i,
  /\bnot available here\b/i,
  /\bYour account can[’']t\b/i,
  /\bAsk an administrator for access\b/i,
];

/** Every sentence of a refusal of authority the table can give, whatever the page: each kind, each hub sentence, and a missing key in the words of each key of the table. */
function everySentenceOfTheTable(): string[] {
  const kinds = [
    'permission-missing',
    'insufficient-authority',
    'outside-hubs',
    'approval-required',
    'unavailable-here',
  ] as const;
  return [
    ...kinds.map((kind) => refusalText(kind, undefined)),
    ...OUTSIDE_HUBS_SENTENCES,
    ...CAPABILITY_KEYS.map((key) => cannotText(key)),
    cannotText(undefined),
    cannotAllText(CAPABILITY_KEYS.slice(0, 3)),
  ];
}

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

describe('the words of a refusal are one table’s (run 7, Stage 2.4)', () => {
  // Break caught: a sentence of the table that no pattern of this test names, so that a page could write it again and nothing would see it.
  it('are each matched by a pattern of this test', () => {
    const sentences = everySentenceOfTheTable();
    expect(sentences.length).toBeGreaterThan(40);
    expect(
      sentences.filter((sentence) => !REFUSAL_WORDS.some((pattern) => pattern.test(sentence))),
    ).toEqual([]);
  });

  // Break caught: the hub told two ways, "a hub your account does not work in" by the lists and "a hub your session does not act in" by the pages that name no list.
  it('tell a hub in one wording, whatever the page holds', () => {
    const hubSentences = [...OUTSIDE_HUBS_SENTENCES, refusalText('outside-hubs', undefined)];
    expect(hubSentences.length).toBeGreaterThan(8);
    for (const sentence of hubSentences)
      expect(sentence).toMatch(/\bhub your account does not work in\b/);
    expect(hubSentences.join(' ')).not.toMatch(/\bsession does not act\b/);
  });

  // Break caught: the per-operation copy ("This pickup run belongs to a hub your session does not act in.") keeping the older wording beside the table's, which is how the two came to be mixed.
  it('tell a hub in the same wording in the copy of every operation', () => {
    const files = [
      ...appSources(join(SRC, 'platform', 'problem')),
      ...appSources(join(SRC, 'components', 'ui', 'forbidden-state')),
    ];
    expect(files.length).toBeGreaterThan(8);
    const old = files.flatMap((path) =>
      wordsOf(readFileSync(path, 'utf8'), relative(SRC, path).replaceAll('\\', '/'))
        .filter(({ text }) => /\bsession does not act\b/.test(text))
        .map(({ text, line }) => `${relative(SRC, path)}:${String(line)} ${text}`),
    );
    expect(old).toEqual([]);
  });

  // Break caught: the message a refusal carries on the problem (what a dialog draws for a refused act) worded again by the copy, so that "A different approver is required." and "A different
  // approver decides this." were two ways to tell one refusal.
  it('are the message of every kind of refusal a problem carries', () => {
    const codes = [
      ['PERMISSION_DENIED', 'permission-missing'],
      ['INSUFFICIENT_AUTHORITY', 'insufficient-authority'],
      ['HUB_SCOPE_VIOLATION', 'outside-hubs'],
      ['SELF_APPROVAL_FORBIDDEN', 'approval-required'],
    ] as const;
    for (const [code, kind] of codes) {
      const problem = problemOf(
        new OperationFailure(new ApiError({ kind: 'http', status: 403, code }), []),
        {},
      );
      expect(problem.forbidden).toBe(kind);
      expect(problem.message).toBe(refusalText(kind, undefined));
    }
  });
});

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
