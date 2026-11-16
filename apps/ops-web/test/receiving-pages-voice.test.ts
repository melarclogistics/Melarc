import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * **No page of the receiving screens writes words of its own** (OB-S1-111; the floor's voice is one table's, `src/platform/problem/receiving-copy.ts`, held word by word by `receiving-copy.test.ts`). A page of
 * `src/app/pages/receiving/` draws its words from that table: there is no text between its tags and no attribute that names what a person reads (a label, a title, a legend, a help, a description, an
 * alternative text) given a string written in the page. A sentence written in a page would escape the one test that reads every word for the words of the people who built the system (*intake*, *adjudicate*,
 * *itemise*, *reconciliation*, *advisory lock*, *the server*), so this reads the pages' own source, as a syntax tree, and fails on the first. It proves itself on a source that does it.
 */
const PAGES = join(import.meta.dirname, '../src/app/pages/receiving');

/** The attributes of a tag that a person reads: a string written in one of them is a word of the page's own. */
const WORDS_OF_A_TAG = new Set([
  'title',
  'label',
  'aria-label',
  'legend',
  'help',
  'description',
  'placeholder',
  'alt',
  'confirmLabel',
  'cancelLabel',
  'note',
  'loadingLabel',
]);

/** What a page writes of its own that a person would read: the text between tags, and a string in an attribute a person reads. */
export function wordsWrittenIn(name: string, text: string): string[] {
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node) && /[A-Za-z]/.test(node.text)) {
      found.push(`text between tags: "${node.text.trim().slice(0, 60)}"`);
    }
    if (
      ts.isJsxAttribute(node) &&
      WORDS_OF_A_TAG.has(node.name.getText(source)) &&
      node.initializer !== undefined &&
      ts.isStringLiteral(node.initializer) &&
      /[A-Za-z]/.test(node.initializer.text)
    ) {
      found.push(`${node.name.getText(source)}="${node.initializer.text.slice(0, 60)}"`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const pages = readdirSync(PAGES)
  .filter((file) => file.endsWith('.tsx') && !file.endsWith('.test.tsx'))
  .toSorted();

describe('the pages of the receiving screens write no words of their own', () => {
  it('reads the pages of the folder', () => {
    expect(pages.length).toBeGreaterThan(10);
    expect(pages).toContain('IntakeRecordPage.tsx');
    expect(pages).toContain('DecisionPage.tsx');
    expect(pages).toContain('MissingParcelsPage.tsx');
  });

  // Break caught: a sentence, a label or a title written in a page, which no test of the words would read.
  it.each(pages)('has no text of its own in %s', (page) => {
    expect(wordsWrittenIn(page, readFileSync(join(PAGES, page), 'utf8'))).toEqual([]);
  });

  // Break caught: a guard that reads nothing because its patterns match nothing: each kind of offence, written in a page, is found; a word drawn from the table is not.
  describe('finds each kind of offence', () => {
    it.each([
      ['text between tags', 'export const A = () => <p>The intake was counted.</p>;'],
      ['a label', 'export const A = () => <Field label="Parcels counted" />;'],
      ['an aria-label', 'export const A = () => <ul aria-label="Photos of the collection" />;'],
      ['a confirm label', 'export const A = () => <ActDialog confirmLabel="Record the count" />;'],
    ])('finds %s', (_name, text) => {
      expect(wordsWrittenIn('A.tsx', text)).not.toEqual([]);
    });

    it('finds nothing in a page that draws every word from the table', () => {
      expect(
        wordsWrittenIn(
          'A.tsx',
          'export const A = () => <Field label={WORDS.blindCount.fieldLabel}><p>{WORDS.record.waiting} · <b>{sentence}</b></p></Field>;',
        ),
      ).toEqual([]);
    });
  });
});
