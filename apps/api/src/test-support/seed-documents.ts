/**
 * The documents the reference seeds are compared with (S0.9; security test matrix Family Z: the authority is read, not copied):
 * the permission catalogue (permissions.md section 7), the settings inventory (settings.md section 7) and the identity reason
 * table (domain-model.md section 3.9). Each reader returns what the document says, so a test can fail when the seed and the
 * document differ. Test support: the deployed API does not read the documents.
 */

export class SeedDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedDocumentError';
  }
}

const strip = (cell: string): string => cell.replaceAll('**', '').replaceAll('`', '').trim();
const cellsOf = (line: string): string[] =>
  line
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim());

export interface CatalogueRow {
  readonly key: string;
  /**
   * Who holds the key, as the document's "Holders" cell names them, normalised: `A` Ops Staff, `S` Senior Ops, `P` Platform
   * Admin, `V` Vendor, `R` Rider, and the named bundles `Finance`, `Auditor`, `Executive` and `Fleet Manager`.
   */
  readonly holders: readonly string[];
  readonly scope: string;
  readonly notes: string;
}

const KEY_ROW = /^\| `([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)`(?: \/ `\.([a-z_]+)`)?\|/;

/** The holders in a "Holders" cell. Prose in the cell ("for staff and vendors") adds none. */
export function holdersIn(cell: string): string[] {
  const text = strip(cell);
  const holders = new Set<string>();
  for (const match of text.matchAll(/(?<![A-Za-z])([ASPVR])(?![A-Za-z])/g))
    holders.add(match[1] ?? '');
  for (const [word, holder] of [
    ['Finance', 'Finance'],
    ['Auditor', 'Auditor'],
    ['Executive', 'Executive'],
    ['Fleet Manager', 'Fleet Manager'],
    ['Rider', 'R'],
    ['Vendor', 'V'],
  ] as const) {
    if (new RegExp(`\\b${word}\\b`).test(text)) holders.add(holder);
  }
  return [...holders];
}

/** Every key of section 7, with its holders. A row that declares two keys (`.enable` / `.disable`) is two rows. */
export function parsePermissionCatalogue(markdown: string): CatalogueRow[] {
  const start = markdown.indexOf('## 7. Action permission catalogue');
  const end = markdown.indexOf('## 8. Bundles');
  if (start < 0 || end < start)
    throw new SeedDocumentError('permissions.md section 7 was not found');
  const rows: CatalogueRow[] = [];
  for (const line of markdown.slice(start, end).split('\n')) {
    const match = KEY_ROW.exec(line);
    if (match === null) continue;
    const cells = cellsOf(line);
    const row = {
      holders: holdersIn(cells[1] ?? ''),
      scope: strip(cells[2] ?? ''),
      notes: strip(cells[3] ?? ''),
    };
    const first = match[1] ?? '';
    rows.push({ key: first, ...row });
    if (match[2] !== undefined) {
      rows.push({ key: `${first.slice(0, first.lastIndexOf('.'))}.${match[2]}`, ...row });
    }
  }
  return rows;
}

/** The total the document states for the grantable keys (its own count, the one that matters: keys, not rows). */
export function statedGrantableKeys(markdown: string): number {
  const match = /\| \*\*Total grantable keys\*\*\| \*\*(\d+)\*\*\|/.exec(markdown);
  if (match === null)
    throw new SeedDocumentError('permissions.md does not state its total of grantable keys');
  return Number(match[1]);
}

export interface SettingRow {
  readonly key: string;
  readonly status: string;
  /** The "Value" cell as written, bold markers removed. */
  readonly value: string;
  /** The section of settings.md, `7.1`, `7.5`, `7.7`... */
  readonly section: string;
}

/** Every keyed row of settings.md section 7 with its status. A row without a key (a catalogue, a per-category row) is skipped. */
export function parseSettings(markdown: string): SettingRow[] {
  const rows: SettingRow[] = [];
  let section = '';
  for (const line of markdown.split('\n')) {
    const heading = /^### (7\.\d+)/.exec(line);
    if (heading !== null) section = heading[1] ?? '';
    if (section === '') continue;
    const match = /^\| `([A-Za-z][A-Za-z0-9_]*)`\| *`([A-Z]+)`/.exec(line);
    if (match === null) continue;
    const cells = cellsOf(line);
    rows.push({
      key: match[1] ?? '',
      status: match[2] ?? '',
      value: strip(cells[2] ?? ''),
      section,
    });
  }
  return rows;
}

export interface ReasonRow {
  readonly code: string;
  readonly domain: string;
  readonly label: string;
  readonly permittedOperations: readonly string[];
}

/** The twelve identity reasons of domain-model.md section 3.9: code, domain, label and permitted operations. */
export function parseIdentityReasons(markdown: string): ReasonRow[] {
  const rows: ReasonRow[] = [];
  for (const line of markdown.split('\n')) {
    const match =
      /^\| `([A-Z][A-Z0-9_]*)`\| `([A-Z_]+)`\| ([^|]+)\| ((?:`[A-Za-z#_]+`(?:, )?)+)\|$/.exec(line);
    if (match === null) continue;
    rows.push({
      code: match[1] ?? '',
      domain: match[2] ?? '',
      label: (match[3] ?? '').trim(),
      permittedOperations: [...(match[4] ?? '').matchAll(/`([A-Za-z#_]+)`/g)].map(
        (each) => each[1] ?? '',
      ),
    });
  }
  return rows;
}

export interface StopSkipReasonRow {
  readonly code: string;
  readonly attribution: string;
  readonly requiresNote: boolean;
}

/**
 * The four `PICKUP_STOP_SKIP` rows of domain-model.md section 3.9: code, attribution and whether a note is required. Read between the
 * sentence that says the contents are seeded and the next domain's, because the `HANDOFF_FAILURE` table has the same shape.
 */
export function parseStopSkipReasons(markdown: string): StopSkipReasonRow[] {
  const start = markdown.indexOf('**The `PICKUP_STOP_SKIP` contents are seeded**');
  const end = markdown.indexOf('**The `HANDOFF_FAILURE` contents are seeded**');
  if (start < 0 || end < start) return [];
  const rows: StopSkipReasonRow[] = [];
  for (const line of markdown.slice(start, end).split('\n')) {
    const match =
      /^\| `([A-Z][A-Z0-9_]*)`\| [^|]+\| `(CUSTOMER|MELARC|EXTERNAL)`\| (\*\*yes\*\*|yes|no)\|$/.exec(
        line,
      );
    if (match === null) continue;
    rows.push({
      code: match[1] ?? '',
      attribution: match[2] ?? '',
      requiresNote: (match[3] ?? '').includes('yes'),
    });
  }
  return rows;
}

export interface PickupCatalogueReasonRow {
  readonly code: string;
  readonly domain: 'PICKUP_CANCELLATION' | 'PICKUP_FAILURE' | 'PICKUP_SHORT_COUNT';
  readonly attribution: string;
  readonly requiresNote: boolean;
  readonly requiresContactAttempt: boolean;
  readonly requiresPhoto: boolean;
  /** The failure category the table binds a `PICKUP_FAILURE` reason to (D-A4); null for the other two catalogues, whose tables have no such column. */
  readonly failureCategory: string | null;
}

export interface CarryoverReasonRow {
  readonly code: string;
  readonly attribution: string;
  readonly requiresNote: boolean;
  readonly label: string;
}

/**
 * The rows of the `PICKUP_CARRYOVER` table of domain-model.md section 3.9 (the decision of 2 November 2026): code, attribution, whether a note
 * is required and the label, which this table gives because five of its codes carry a prefix their words do not. Read from the sentence that
 * says the contents are seeded up to the next such sentence.
 */
export function parseCarryoverReasons(markdown: string): CarryoverReasonRow[] {
  const start = markdown.indexOf('**The `PICKUP_CARRYOVER` contents are seeded**');
  if (start < 0) return [];
  const rest = markdown.slice(start + 1);
  const next = rest.search(/\*\*The `[A-Z_]+` contents are seeded\*\*/);
  const region = next < 0 ? rest : rest.slice(0, next);
  const rows: CarryoverReasonRow[] = [];
  for (const line of region.split('\n')) {
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    const code = /^`([A-Z][A-Z0-9_]*)`$/.exec(cells[0] ?? '')?.[1];
    const attribution = /^`(CUSTOMER|MELARC|EXTERNAL)`$/.exec(cells[1] ?? '')?.[1];
    const label = cells[3];
    if (code === undefined || attribution === undefined || label === undefined || label === '')
      continue;
    rows.push({ code, attribution, requiresNote: (cells[2] ?? '').includes('yes'), label });
  }
  return rows;
}

/** The requirement columns each pickup catalogue's table has after its code and attribution, in order. */
const CATALOGUE_COLUMNS = {
  PICKUP_CANCELLATION: ['requiresNote'],
  PICKUP_FAILURE: ['requiresNote', 'requiresContactAttempt', 'requiresPhoto'],
  PICKUP_SHORT_COUNT: ['requiresNote', 'requiresPhoto'],
} as const;

/**
 * The rows of the three pickup catalogues of domain-model.md section 3.9, approved by the Product Owner on 29 October 2026 (SLICE-001,
 * D-05): code, attribution and the requirements each table gives. Each table follows its own sentence ("The `PICKUP_FAILURE` contents are
 * seeded"), read up to the next such sentence, so the tables of the other domains are never mixed in.
 */
export function parsePickupCatalogueReasons(markdown: string): PickupCatalogueReasonRow[] {
  const rows: PickupCatalogueReasonRow[] = [];
  for (const domain of Object.keys(CATALOGUE_COLUMNS) as (keyof typeof CATALOGUE_COLUMNS)[]) {
    const start = markdown.indexOf(`**The \`${domain}\` contents are seeded**`);
    if (start < 0) continue;
    const rest = markdown.slice(start + 1);
    const next = rest.search(/\*\*The `[A-Z_]+` contents are seeded\*\*/);
    const region = next < 0 ? rest : rest.slice(0, next);
    for (const line of region.split('\n')) {
      const cells = line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim());
      const code = /^`([A-Z][A-Z0-9_]*)`$/.exec(cells[0] ?? '')?.[1];
      const attribution = /^`(CUSTOMER|MELARC|EXTERNAL)`$/.exec(cells[1] ?? '')?.[1];
      if (code === undefined || attribution === undefined) continue;
      const flags = { requiresNote: false, requiresContactAttempt: false, requiresPhoto: false };
      CATALOGUE_COLUMNS[domain].forEach((name, index) => {
        flags[name] = (cells[2 + index] ?? '').includes('yes');
      });
      // The failure table's last cell is the category the reason belongs to (D-A4); the other two tables have none.
      const failureCategory =
        domain === 'PICKUP_FAILURE'
          ? (/^`([A-Z][A-Z_]*)`$/.exec(cells[2 + CATALOGUE_COLUMNS[domain].length] ?? '')?.[1] ??
            null)
          : null;
      rows.push({ code, domain, attribution, ...flags, failureCategory });
    }
  }
  return rows;
}
