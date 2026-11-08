import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

/**
 * The rule of standards/security-test-matrix.md section 31.2a: "a row is listed here when a test that runs cites it by its identifier".
 * The rows it lists are read from the table, and each must be cited as `GBT-<row>` in a test file of the repository. A row the section
 * says is owed, and every remark, is written in parentheses: outside them the cell names only the rows that run, comma or semicolon
 * apart, and a range as `B4 to B6`. Anything else outside parentheses is refused, so that prose cannot hide a row from the check.
 */
const root = resolve(import.meta.dirname, '..');

/** The rows the status table lists as running, expanded from their ranges. */
export function rowsThatRun(matrix: string): string[] {
  const start = matrix.indexOf('### 31.2a');
  const end = matrix.indexOf('**Not run here, and why.**', start);
  if (start < 0 || end < 0) throw new Error('section 31.2a is not where it was');
  const rows: string[] = [];
  for (const line of matrix.slice(start, end).split('\n')) {
    if (!line.startsWith('| ') || line.startsWith('| Family') || line.startsWith('|---')) continue;
    const cell = (line.split('|')[2] ?? '').trim().replace(/\([^)]*\)/g, '');
    for (const part of cell.split(/[,;]/)) {
      const token = part.trim();
      const range = /^([A-Z]+)(\d+) to [A-Z]*(\d+)$/.exec(token);
      if (range !== null) {
        for (let number = Number(range[2]); number <= Number(range[3]); number += 1) {
          rows.push(`${range[1] ?? ''}${String(number)}`);
        }
      } else if (/^[A-Z]+\d+$/.test(token)) {
        rows.push(token);
      } else if (token !== '') {
        throw new Error(
          `section 31.2a: "${token}" is neither a row nor a range; put a remark in parentheses`,
        );
      }
    }
  }
  return rows;
}

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const SKIPPED = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'tmp',
  'test-results',
]);

function testText(): string {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || SKIPPED.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (TEST_FILE.test(entry.name) || path.includes(join('e2e', 'harness', 'journeys'))) {
        found.push(readFileSync(path, 'utf8'));
      }
    }
  };
  for (const folder of ['apps', 'e2e', 'scripts', 'packages']) walk(join(root, folder));
  return found.join('\n');
}

describe('the rows the security matrix lists as running (section 31.2a)', () => {
  it('reads ranges, commas and semicolons, and leaves what is in parentheses alone', () => {
    const table = [
      '### 31.2a',
      '| Family| Rows that run| Where| Run|',
      '|---|---|---|---|',
      '| A — x| A1 to A3, A7 (a note, B9)| `a.test.ts`| D|',
      '| C — y| C4, C5 (x); C6 to C8 (y) (C9, a row carrying nothing, is owed)| `b.test.ts`| D|',
      '',
      '**Not run here, and why.**',
    ].join('\n');
    assert.deepEqual(rowsThatRun(table), ['A1', 'A2', 'A3', 'A7', 'C4', 'C5', 'C6', 'C7', 'C8']);
  });

  // Break caught: prose outside parentheses that swallows a row ("D12 . D11" read as one token, so as no row), which the check would not see.
  it('refuses prose outside parentheses', () => {
    const table = [
      '### 31.2a',
      '| A — x| A1, A2 are the rows and A3 is owed| `a.test.ts`| D|',
      '**Not run here, and why.**',
    ].join('\n');
    assert.throws(() => rowsThatRun(table), /neither a row nor a range/);
  });

  // Break caught: a row listed as running that no test cites by its identifier, which reads as a guarantee and proves nothing.
  it('are each cited by a test of the repository by their identifier', () => {
    const rows = rowsThatRun(
      readFileSync(join(root, 'standards', 'security-test-matrix.md'), 'utf8'),
    );
    assert.ok(rows.length > 60, `the table lists ${String(rows.length)} rows`);
    const text = testText();
    const missing = rows.filter((row) => !new RegExp(`GBT-${row}(?![0-9])`).test(text));
    assert.deepEqual(missing, []);
  });
});
