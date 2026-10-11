/**
 * The data scope registry (contracts/data-scope-registry.md) as the tests read it (S0.8; security test matrix Family S: GBT-S1
 * to S3 and Family Z). The document owns the classification of every persistent table and the technical identities that read
 * and write it; this reads its tables so that a test can compare them with the database, instead of a second list that could drift
 * from the document. It is test support: the deployed API does not read the document.
 */

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryError';
  }
}

export interface RegistryRow {
  /** The table by the registry's name, in Pascal case. */
  readonly table: string;
  /** `PLATFORM`, `HUB`, `VENDOR`, `RIDER_ASSIGNMENT`, `AUDIT` or `SYSTEM`: the section of the document the row is in. */
  readonly scopeClass: string;
  /** Every cell, by its header, with bold markers removed from the header and the cell kept as written. */
  readonly cells: Readonly<Record<string, string>>;
  /** The technical identities in the "Read identity" cell: `api`, `worker`, `worker:settlement`, `seed`, `migration`... */
  readonly readIdentities: readonly string[];
  /** The technical identities in the "Write identity" cell. */
  readonly writeIdentities: readonly string[];
}

const SECTION = /^### 4\.\d+ `([A-Z_]+)` — \d+ tables?\s*$/;
const HEADER_START = '| Table|';
const ROW = /^\| `([A-Za-z]+)`\|/;

function cellsOf(line: string): string[] {
  // A row is `| a| b| c|`: drop the leading pipe and the empty cell after the last.
  return line
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim());
}

function identitiesIn(cell: string | undefined): string[] {
  return [...(cell ?? '').matchAll(/`([a-z_]+(?::[a-z_]+)?)`/g)].map((match) => match[1] ?? '');
}

/** Every table of section 4, with its class and its cells. Refuses a row whose cells do not match its section's header. */
export function parseRegistry(markdown: string): RegistryRow[] {
  const rows: RegistryRow[] = [];
  let scopeClass: string | undefined;
  let header: string[] | undefined;
  for (const line of markdown.split('\n')) {
    const section = SECTION.exec(line);
    if (section !== null) {
      scopeClass = section[1];
      header = undefined;
      continue;
    }
    if (scopeClass === undefined) continue;
    if (line.startsWith('## ')) {
      scopeClass = undefined;
      continue;
    }
    // A header row names its columns; the registry's own starts with "Table". Another table in the section (the Vendor
    // reconciliation) has a header of its own, whose rows are not registry rows.
    if (line.startsWith('| ') && !line.startsWith('| `')) {
      header = line.startsWith(HEADER_START)
        ? cellsOf(line).map((cell) => cell.replaceAll('**', ''))
        : undefined;
      continue;
    }
    const row = ROW.exec(line);
    if (row === null || header === undefined) continue;
    const cells = cellsOf(line);
    if (cells.length !== header.length) {
      throw new RegistryError(
        `${row[1] ?? '?'} has ${String(cells.length)} cells where the header of ${scopeClass} has ${String(header.length)}`,
      );
    }
    const byHeader = Object.fromEntries(
      header.map((name, at) => [name, cells[at] ?? '']),
    ) as Record<string, string>;
    rows.push({
      table: (row[1] ?? '').trim(),
      scopeClass,
      cells: byHeader,
      readIdentities: identitiesIn(byHeader['Read identity']),
      writeIdentities: identitiesIn(byHeader['Write identity']),
    });
  }
  if (rows.length === 0) throw new RegistryError('no registry tables were found in section 4');
  return rows;
}

const INVENTORY_BEGIN = '<!-- TECHNICAL-TABLE-INVENTORY:BEGIN -->';
const INVENTORY_END = '<!-- TECHNICAL-TABLE-INVENTORY:END -->';

/** The technical tables of section 6, between the parse markers. */
export function parseTechnicalInventory(markdown: string): string[] {
  const start = markdown.indexOf(INVENTORY_BEGIN);
  const end = markdown.indexOf(INVENTORY_END);
  if (start < 0 || end < start)
    throw new RegistryError('the technical-table inventory markers are missing');
  return markdown
    .slice(start, end)
    .split('\n')
    .map((line) => ROW.exec(line)?.[1])
    .filter((name): name is string => name !== undefined);
}

/** `RoleBundleGrant` is `role_bundle_grant`: the registry names a table in Pascal case, the database in snake case. */
export function snakeCaseOf(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}
