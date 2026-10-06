/**
 * Holds the colour tables of design/DESIGN_SYSTEM.md to the colours they name. A table of contrast ratios is what an
 * implementation will encode, so each figure is recomputed here from the hex values in the same document:
 *
 *   §4.2 and §4.3   the token values, which every later table must agree with
 *   §4.5            the nine verified pairs: `#foreground` | `#background` | ratio:1
 *   §4.6            the matrices of foreground, border and focus colour against each surface: a ratio, a ✗ where it is
 *                   below the threshold of that table, and "thin" where it passes by less than 0.25
 *
 * Only the tables are checked. The sentences around them quote the same figures and are reviewed with the tables.
 * It uses only Node built-ins.
 */

const HEX = /^#[0-9a-fA-F]{6}$/;
const THIN_MARGIN = 0.25;

function luminance(hex: string): number {
  if (!HEX.test(hex)) throw new Error(`not a six-digit hex colour: ${JSON.stringify(hex)}`);
  const channels = [1, 3, 5].map((start) => {
    const value = parseInt(hex.slice(start, start + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const [red = 0, green = 0, blue = 0] = channels;
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** The WCAG 2.x contrast ratio of two #RRGGBB colours, from 1 to 21. */
export function contrastRatio(first: string, second: string): number {
  const [lighter = 0, darker = 0] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

export interface ContrastCheck {
  problems: string[];
  checked: {
    tokens: number;
    colours: number;
    baseline: number;
    matrices: number;
    matrixCells: number;
  };
}

/** The text of a `## ` or `### ` section: from its heading to the next heading of the same or a higher level. */
function section(markdown: string, heading: RegExp, level: 2 | 3): string {
  const start = heading.exec(markdown);
  if (start === null) return '';
  const rest = markdown.slice(start.index + start[0].length);
  const end = (level === 2 ? /\n## / : /\n#{2,3} /).exec(rest);
  return end === null ? rest : rest.slice(0, end.index);
}

const cellsOf = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());

const isTableRow = (line: string): boolean => line.trim().startsWith('|');
const isSeparator = (line: string): boolean => /^\|[\s:|-]+\|$/.test(line.trim());

/** Every #RRGGBB colour in §4.2 to §4.4, upper-cased: the palette, the semantic tokens and the status colours. */
function definedColours(markdown: string): Set<string> {
  const from = markdown.search(/^## 4\.2 /m);
  const to = markdown.search(/^## 4\.5 /m);
  if (from === -1 || to === -1 || to < from) return new Set();
  return new Set(
    [...markdown.slice(from, to).matchAll(/#[0-9a-fA-F]{6}\b/g)].map((match) =>
      match[0].toUpperCase(),
    ),
  );
}

/** The token values of §4.2 and §4.3: `| \`color.text.muted\` | \`#667085\` | ...`. */
function tokenValues(markdown: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of markdown.split('\n')) {
    const match = /^\|\s*`([A-Za-z]+(?:\.[A-Za-z0-9]+)+)`\s*\|\s*`(#[0-9a-fA-F]{6})`/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined)
      values.set(match[1], match[2].toUpperCase());
  }
  return values;
}

export function checkDesignContrast(markdown: string): ContrastCheck {
  const problems: string[] = [];
  const checked = { tokens: 0, colours: 0, baseline: 0, matrices: 0, matrixCells: 0 };

  const tokens = tokenValues(markdown);
  checked.tokens = tokens.size;
  if (tokens.size === 0) problems.push('no token values were found in §4.2 or §4.3');
  const tokenFor = (name: string): string | undefined =>
    tokens.get(`color.${name}`) ?? tokens.get(name);

  // A colour used in a later table must be one the document defines, so a mistyped hex that happens to round to the
  // same ratio is still caught.
  const colours = definedColours(markdown);
  checked.colours = colours.size;
  if (colours.size === 0) problems.push('no colours were found in §4.2 to §4.4');

  // §4.5: the nine verified pairs.
  const baseline = section(markdown, /^## 4\.5 .*$/m, 2);
  for (const line of baseline.split('\n').filter(isTableRow)) {
    const match =
      /^\|\s*`(#[0-9a-fA-F]{6})`\s*\|\s*`(#[0-9a-fA-F]{6})`\s*\|\s*(\d+\.\d\d):1\s*\|/.exec(line);
    if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) continue;
    checked.baseline += 1;
    for (const hex of [match[1], match[2]]) {
      if (!colours.has(hex.toUpperCase())) {
        problems.push(`§4.5 ${hex} is not a colour defined in §4.2 to §4.4`);
      }
    }
    const actual = contrastRatio(match[1], match[2]);
    if (actual.toFixed(2) !== match[3]) {
      problems.push(
        `§4.5 ${match[1]} on ${match[2]}: the table says ${match[3]}:1, the colours give ${actual.toFixed(2)}:1`,
      );
    }
    if (actual < 4.5)
      problems.push(
        `§4.5 ${match[1]} on ${match[2]} is ${actual.toFixed(2)}:1, below the 4.5:1 of a verified pair`,
      );
  }
  if (checked.baseline === 0) problems.push('no verified pairs were found in §4.5');

  // §4.6: the matrices, each under a heading that fixes its threshold.
  const supported = section(markdown, /^## 4\.6 .*$/m, 2);
  const kinds: [heading: RegExp, name: string, threshold: number][] = [
    [/^### Text on surfaces$/m, 'text', 4.5],
    [/^### Control boundary$/m, 'control boundary', 3],
    [/^### Focus$/m, 'focus', 3],
  ];
  for (const [heading, name, threshold] of kinds) {
    const lines = section(supported, heading, 3).split('\n').filter(isTableRow);
    const header = lines[0];
    if (header === undefined) {
      problems.push(`§4.6 has no ${name} table`);
      continue;
    }
    checked.matrices += 1;

    // The surfaces: a name, and a hex that must agree with the token table when the header gives one.
    const surfaces = cellsOf(header)
      .slice(1)
      .map((cell) => {
        const surface = /`(surface\.[A-Za-z]+)`/.exec(cell)?.[1];
        const given = /`(#[0-9a-fA-F]{6})`/.exec(cell)?.[1]?.toUpperCase();
        const expected = surface === undefined ? undefined : tokenFor(surface);
        if (surface === undefined || expected === undefined) {
          problems.push(`§4.6 ${name} table: no token for the surface in "${cell}"`);
        } else if (given !== undefined && given !== expected) {
          problems.push(
            `§4.6 ${name} table: ${surface} is ${given} in the header but ${expected} in §4.3`,
          );
        }
        return { surface, hex: expected };
      });

    for (const line of lines.slice(1).filter((candidate) => !isSeparator(candidate))) {
      const [label = '', ...cells] = cellsOf(line);
      const token = /`([A-Za-z]+\.[A-Za-z]+)`/.exec(label)?.[1];
      const hex = /`(#[0-9a-fA-F]{6})`/.exec(label)?.[1]?.toUpperCase();
      if (token === undefined || hex === undefined) {
        problems.push(`§4.6 ${name} table: no token and colour in "${label}"`);
        continue;
      }
      const expected = tokenFor(token);
      if (expected !== undefined && expected !== hex) {
        problems.push(`§4.6 ${name} table: ${token} is ${hex} in the row but ${expected} in §4.3`);
      } else if (expected === undefined && !/proposed/i.test(label)) {
        problems.push(
          `§4.6 ${name} table: ${token} is not a token in §4.3, and the row does not say it is proposed`,
        );
      }
      if (!colours.has(hex)) {
        problems.push(
          `§4.6 ${name} table: ${hex} (${token}) is not a colour defined in §4.2 to §4.4`,
        );
      }

      cells.forEach((cell, index) => {
        const surface = surfaces[index];
        const stated = /^(✗ )?(\d+\.\d\d)( thin)?$/.exec(cell);
        if (surface?.hex === undefined || stated?.[2] === undefined) {
          problems.push(
            `§4.6 ${name} table: cannot read "${cell}" for ${token} on ${surface?.surface ?? `column ${String(index + 1)}`}`,
          );
          return;
        }
        checked.matrixCells += 1;
        const where = `${token} on ${surface.surface ?? '?'}`;
        const actual = contrastRatio(hex, surface.hex);
        if (actual.toFixed(2) !== stated[2]) {
          problems.push(
            `§4.6 ${name} table, ${where}: the table says ${stated[2]}, the colours give ${actual.toFixed(2)}`,
          );
        }
        const fails = actual < threshold;
        if ((stated[1] !== undefined) !== fails) {
          problems.push(
            `§4.6 ${name} table, ${where}: ${actual.toFixed(2)} ${fails ? 'is below' : 'meets'} ${String(threshold)}:1 but the cell is marked ${stated[1] === undefined ? 'as a pass' : 'as a failure'}`,
          );
        }
        const thin = !fails && actual - threshold < THIN_MARGIN;
        if ((stated[3] !== undefined) !== thin) {
          problems.push(
            `§4.6 ${name} table, ${where}: ${actual.toFixed(2)} ${thin ? 'passes by less than 0.25 and must say "thin"' : 'does not pass narrowly, so it must not say "thin"'}`,
          );
        }
      });
    }
  }
  return { problems, checked };
}
