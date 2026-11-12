import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { STATUS_PAIRS } from '../../components/ui/status-badge/StatusBadge';
import { RECORD_LOOKUP_KINDS } from '../../platform/lookup/record-lookup-shape';
import { stateWords } from '../shell/record-line';
import { LOOKUP_DOMAINS, STATUS_ROWS, STATUS_TABLE, statusTableMarkdown } from './status-table';

/**
 * The one table of statuses (COMPONENT_PATTERNS, *StatusBadge v2*) is held to three things: the contract, which says which states the search of records can return; the search's
 * own words; and the document, which carries the same table for people. A state added to a domain, a pair changed or a word reworded has to be changed in all of them, here.
 */
const CONTRACT = resolve(import.meta.dirname, '../../../../../contracts/openapi.yaml');
const PATTERNS = resolve(import.meta.dirname, '../../../../../design/COMPONENT_PATTERNS.md');

const TABLE_HEADER = '| Domain | State | Pair | Words |';

interface Schema {
  readonly properties?: Record<string, { readonly enum?: readonly string[] }>;
}

const document = parse(readFileSync(CONTRACT, 'utf8')) as {
  components: { schemas: Record<string, Schema> };
};

/** The enumeration each kind of record found carries as its `state` (the description of `RecordLookupResult.state` names them). */
const LOOKUP_ENUMERATION = {
  PICKUP_REQUEST: ['PickupRequest', 'state'],
  PICKUP_MANIFEST: ['PickupManifest', 'state'],
  VENDOR_ACCOUNT: ['VendorAccountSummary', 'status'],
  RIDER: ['RiderSummary', 'status'],
  STAFF_IDENTITY: ['StaffIdentity', 'status'],
} as const satisfies Record<(typeof RECORD_LOOKUP_KINDS)[number], readonly [string, string]>;

function enumerationOf(schema: string, property: string): readonly string[] {
  const values = document.components.schemas[schema]?.properties?.[property]?.enum;
  if (values === undefined) {
    throw new Error(`The contract has no enumeration at ${schema}.${property}.`);
  }
  return values;
}

interface DocumentedRow {
  readonly domain: string;
  readonly state: string;
  readonly pair: string;
  readonly label: string;
}

/** The rows of the table in the document: the one table under the header above, up to the first line that is not a row of it. */
function documentedRows(): readonly DocumentedRow[] {
  const lines = readFileSync(PATTERNS, 'utf8').split(/\r?\n/);
  const headers = lines.flatMap((line, index) => (line.trim() === TABLE_HEADER ? [index] : []));
  const [start] = headers;
  if (start === undefined || headers.length !== 1) {
    throw new Error(
      `COMPONENT_PATTERNS holds ${String(headers.length)} tables headed ${TABLE_HEADER}; it must hold exactly one.`,
    );
  }
  const rows: DocumentedRow[] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith('|')) break;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim().replaceAll('`', ''));
    const [domain, state, pair, label] = cells;
    if (
      cells.length !== 4 ||
      domain === undefined ||
      state === undefined ||
      pair === undefined ||
      label === undefined
    ) {
      throw new Error(`A row of the status table does not have four cells: ${line}`);
    }
    rows.push({ domain, state, pair, label });
  }
  return rows;
}

describe('the one table of statuses', () => {
  // Break caught: a page that declares a mapping of its own (a new `StatusMap`) which is not in the table: its states would be drawn, and the document and the search would never
  // hear of them.
  it('has every mapping that a page declares', () => {
    const pages = resolve(import.meta.dirname, '../pages');
    const declared = readdirSync(pages, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('-presentation.ts'))
      .flatMap((file) =>
        [
          ...readFileSync(resolve(pages, file), 'utf8').matchAll(/export const (\w+): StatusMap</g),
        ].flatMap((found) => (found[1] === undefined ? [] : [found[1]])),
      );
    const table = readFileSync(resolve(import.meta.dirname, 'status-table.ts'), 'utf8');

    expect(declared.length).toBeGreaterThan(0);
    for (const name of declared) {
      expect(table, name).toContain(name);
    }
  });

  // Break caught: a kind added to the search of records with no decision here: the table has to name every kind the search can return a state of.
  it('names every kind of record that the search can find, and no other', () => {
    expect([...LOOKUP_DOMAINS].sort()).toEqual([...RECORD_LOOKUP_KINDS].sort());
  });

  // Break caught: a state that the search can return, which the contract's enumeration names, with no row in the table: the portal would show it as an unknown status.
  it.each(RECORD_LOOKUP_KINDS)(
    'has a row for each state of a %s that the contract names',
    (kind) => {
      const [schema, property] = LOOKUP_ENUMERATION[kind];

      expect(Object.keys(STATUS_TABLE[kind]).sort()).toEqual(
        [...enumerationOf(schema, property)].sort(),
      );
    },
  );

  // Break caught: a state called one thing on its page and another in the search of records: both take their words from the same mapping, and this holds them to the table.
  it.each(RECORD_LOOKUP_KINDS)('writes the states of a %s in the words of the table', (kind) => {
    for (const [state, presentation] of Object.entries(STATUS_TABLE[kind])) {
      expect(stateWords(kind, state)).toBe(presentation.label);
    }
  });

  // Break caught: a row in a pair that does not exist (a sixth colour), the same state twice in a domain, or a raw value of the enumeration shown as words.
  it('has rows that are one of the five pairs, once each, in plain words', () => {
    const seen = new Set<string>();
    for (const row of STATUS_ROWS) {
      expect(STATUS_PAIRS).toContain(row.pair);
      const key = `${row.domain}/${row.state}`;
      expect(seen.has(key), `${key} appears twice`).toBe(false);
      seen.add(key);
      expect(row.label, `${key}: words`).toMatch(/^[A-Z][a-z]/);
      expect(row.label, `${key}: words`).not.toMatch(/[_.]/);
    }
    expect(STATUS_ROWS.length).toBeGreaterThan(0);
  });

  // Break caught: a table in the document that was written once and has drifted from the code (a state added, a pair changed, a word reworded) so that people read one table and the badge draws another.
  it('is the table in COMPONENT_PATTERNS, row for row', () => {
    expect(documentedRows()).toEqual(
      STATUS_ROWS.map((row) => ({
        domain: row.domain,
        state: row.state,
        pair: row.pair,
        label: row.label,
      })),
    );
  });

  // Break caught: the text that is pasted into the document drawn from something other than the rows (so that the paste and the check disagree).
  it('writes the Markdown that the document holds, one line for each row', () => {
    const lines = statusTableMarkdown().split('\n');

    expect(lines[0]).toBe(TABLE_HEADER);
    expect(lines[1]).toBe('|---|---|---|---|');
    expect(lines).toHaveLength(STATUS_ROWS.length + 2);
    expect(lines.slice(2)).toEqual(
      STATUS_ROWS.map(
        (row) => `| \`${row.domain}\` | \`${row.state}\` | ${row.pair} | ${row.label} |`,
      ),
    );
  });
});
