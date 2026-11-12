import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const root = resolve(import.meta.dirname, '..');
const patterns = readFileSync(resolve(root, 'design/COMPONENT_PATTERNS.md'), 'utf8');

/** The lifecycle of a pattern (COMPONENT_PATTERNS section 2): the only words a status line may begin with. */
const STATES = ['PROPOSED', 'IMPLEMENTING', 'ACTIVE', 'DEPRECATED'];

/** What a status line says, without its mark: `> **Status:** BUILT · ...` is `BUILT · ...`. */
function statusLines(text: string): { line: number; says: string }[] {
  return text.split(/\r?\n/).flatMap((raw, index) => {
    const match = /^> \*\*Status:\*\* (.*)$/.exec(raw);
    return match?.[1] === undefined ? [] : [{ line: index + 1, says: match[1] }];
  });
}

/**
 * A pattern is in one of the four states of the lifecycle and in no word of its own (task R5.2, M15c: the kit's rows said BUILT, which is none of them): "BUILT" and its likes
 * hide that a component no screen uses yet is IMPLEMENTING, and that ACTIVE needs a screen and the Product Owner's acceptance.
 */
describe('the status of every pattern (COMPONENT_PATTERNS section 2)', () => {
  const lines = statusLines(patterns);

  // Break caught: a status line that names a state of its own (BUILT, DONE, READY), so that a reader cannot tell what the pattern may be relied on for.
  it('begins with one of the four states, or with a sentence that names them', () => {
    assert.ok(lines.length > 40, 'the document has a status line for each pattern');
    const bad = lines.filter(
      ({ says }) =>
        !STATES.some((state) => says.startsWith(state)) &&
        !(says.startsWith('the ') && STATES.some((state) => says.includes(state))),
    );
    assert.deepEqual(
      bad.map(({ line, says }) => `${String(line)}: ${says.slice(0, 60)}`),
      [],
    );
  });

  it('says BUILT as a state nowhere', () => {
    assert.deepEqual(
      lines.filter(({ says }) => /\bBUILT\b/.test(says.split(' · ')[0] ?? '')),
      [],
    );
  });

  // The check proved on text it must refuse and text it must accept.
  it('finds a status line that is not a state', () => {
    const text = [
      '> **Status:** BUILT · **Code:** x',
      '> **Status:** IMPLEMENTING · **Code:** y',
      '> **Status:** ACTIVE',
      '> **Status:** the neutral frame is ACTIVE; the shell is IMPLEMENTING',
      '> **Status:** the thing is done',
    ].join('\n');
    const bad = statusLines(text).filter(
      ({ says }) =>
        !STATES.some((state) => says.startsWith(state)) &&
        !(says.startsWith('the ') && STATES.some((state) => says.includes(state))),
    );
    assert.deepEqual(
      bad.map(({ line }) => line),
      [1, 5],
    );
  });
});
