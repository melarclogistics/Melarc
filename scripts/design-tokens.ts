/**
 * Holds the Ops Portal's token file to design/DESIGN_SYSTEM.md. The document says there is one executable source of
 * the tokens (§29.1: CSS custom properties in apps/ops-web/src/styles/tokens.css) and that components consume only that
 * file. A document and a file that are each right on their own can still disagree, so this reads both:
 *
 *   - every token the document defines (§4.2 to §4.4, §5.2, §6 to §9 and §11) exists in the file, with the same value;
 *   - the pairings the initial components use meet their contrast threshold, computed from the file's own values;
 *   - no colour is written outside the file, and a focus indicator is drawn with `outline`, which forced-colours mode
 *     keeps (§4.6).
 *
 * A custom property is named from the dotted token by §29.1: dots become hyphens and camelCase becomes kebab-case, so
 * `color.action.primaryHover` is `--color-action-primary-hover`. It uses only Node built-ins.
 */

import { contrastRatio } from './design-contrast.ts';

export type TokenKind = 'colour' | 'length' | 'time' | 'weight' | 'shadow';

export interface DocumentedToken {
  /** The dotted name in the document, such as `color.action.primaryHover`. */
  token: string;
  /** The custom property the file must define, such as `--color-action-primary-hover`. */
  property: string;
  /** The value as the document writes it. */
  value: string;
  kind: TokenKind;
}

export interface TokenCheck {
  problems: string[];
  checked: Record<TokenKind, number>;
}

/** `color.action.primaryHover` is `--color-action-primary-hover` (DESIGN_SYSTEM §29.1). */
export function propertyName(token: string): string {
  const kebab = token
    .split('.')
    .map((part) => part.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase())
    .join('-');
  return `--${kebab}`;
}

/** The text of a `## ` section, from its heading to the next `## ` heading. */
function section(markdown: string, heading: RegExp): string {
  const start = heading.exec(markdown);
  if (start === null) return '';
  const rest = markdown.slice(start.index + start[0].length);
  const end = /\n## /.exec(rest);
  return end === null ? rest : rest.slice(0, end.index);
}

const cellsOf = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());

const unticked = (cell: string): string => cell.replace(/^`|`$/g, '').trim();
const isTableRow = (line: string): boolean => line.trim().startsWith('|');

/** Every token the document defines, in the order it defines them. */
export function documentedTokens(markdown: string): DocumentedToken[] {
  const tokens: DocumentedToken[] = [];
  const add = (token: string, value: string, kind: TokenKind): void => {
    tokens.push({ token, property: propertyName(token), value, kind });
  };

  // §4.2 palette and §4.3 semantic colours: `| `crimson.600` | `#B4232E` | ... |`, also `white` and `black`.
  const colourRows = [
    ...section(markdown, /^## 4\.2 /m).split('\n'),
    ...section(markdown, /^## 4\.3 /m).split('\n'),
  ].filter(isTableRow);
  for (const row of colourRows) {
    const [name = '', value = ''] = cellsOf(row).map(unticked);
    if (/^#[0-9a-fA-F]{6}$/.test(value) && /^[a-z][A-Za-z0-9.]*$/.test(name)) {
      add(name, value, 'colour');
    }
  }

  // §4.3 focus widths: `| `focus.width` | `2px` |`.
  for (const row of section(markdown, /^## 4\.3 /m)
    .split('\n')
    .filter(isTableRow)) {
    const [name = '', value = ''] = cellsOf(row).map(unticked);
    if (/^focus\.(width|offsetWidth)$/.test(name)) add(name, value, 'length');
  }

  // §4.4 status colours, written as `color.status.success.foreground = #0F5D42`.
  for (const match of section(markdown, /^## 4\.4 /m).matchAll(
    /^(color\.status\.[a-z]+\.[a-z]+)\s*=\s*(#[0-9a-fA-F]{6})\s*$/gm,
  )) {
    if (match[1] !== undefined && match[2] !== undefined) add(match[1], match[2], 'colour');
  }

  // §4.6 inverse focus tokens, approved on 6 October 2026. Their values must still be where the document says them.
  const supported = section(markdown, /^## 4\.6 /m);
  for (const [token, value] of [
    ['focus.ringInverse', '#FFFFFF'],
    ['focus.offsetInverse', '#172033'],
  ] as const) {
    // The name and its value sit within a few characters of each other, possibly across a line break.
    if (new RegExp(`\`${token}\`[\\s\\S]{0,24}${value}`, 'i').test(supported)) {
      add(token, value, 'colour');
    }
  }

  // §5.2 typography: `| `text.heading.xl` | 28px | 36px | 600 | page title |`.
  for (const row of section(markdown, /^## 5\.2 /m)
    .split('\n')
    .filter(isTableRow)) {
    const [name = '', size = '', line = '', weight = ''] = cellsOf(row).map(unticked);
    if (/^text\.[a-z]+(\.[a-z]+)?$/.test(name) && size.endsWith('px')) {
      add(`${name}.size`, size, 'length');
      add(`${name}.lineHeight`, line, 'length');
      add(`${name}.weight`, weight, 'weight');
    }
  }

  // §6 spacing, §7 radius, §8 shadows, §9 motion.
  const scale = (heading: RegExp, prefix: string, kind: TokenKind): void => {
    for (const row of section(markdown, heading).split('\n').filter(isTableRow)) {
      const [name = '', value = ''] = cellsOf(row).map(unticked);
      if (name.startsWith(`${prefix}.`) && value !== '') add(name, value, kind);
    }
  };
  scale(/^## 6\. /m, 'space', 'length');
  scale(/^## 7\. /m, 'radius', 'length');
  scale(/^## 8\. /m, 'shadow', 'shadow');
  scale(/^## 9\. /m, 'motion', 'time');

  // §11 web control heights: `| `md` | `40px` | default web control |`.
  for (const row of section(markdown, /^## 11\. /m)
    .split('\n')
    .filter(isTableRow)) {
    const [size = '', height = ''] = cellsOf(row).map(unticked);
    if (/^(sm|md|lg)$/.test(size) && height.endsWith('px'))
      add(`control.height.${size}`, height, 'length');
  }

  return tokens;
}

/** The custom properties declared in a stylesheet, comments removed. A later declaration wins, as in CSS. */
export function parseCustomProperties(css: string): Map<string, string> {
  const properties = new Map<string, string>();
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of withoutComments.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;{}]+);/gi)) {
    if (match[1] !== undefined && match[2] !== undefined) {
      properties.set(match[1], match[2].replace(/\s+/g, ' ').trim());
    }
  }
  return properties;
}

/** A property's value with `var(--other)` references followed, or undefined when it is missing or loops. */
export function resolveProperty(
  name: string,
  properties: ReadonlyMap<string, string>,
  seen: readonly string[] = [],
): string | undefined {
  const value = properties.get(name);
  if (value === undefined || seen.includes(name)) return undefined;
  const reference = /^var\(\s*(--[a-z0-9-]+)\s*\)$/i.exec(value);
  return reference?.[1] === undefined
    ? value
    : resolveProperty(reference[1], properties, [...seen, name]);
}

/** A length in pixels (1rem is 16px), or undefined when it is not one. */
function pixels(value: string): number | undefined {
  const match = /^(-?\d+(?:\.\d+)?)(px|rem)?$/.exec(value.trim());
  if (match?.[1] === undefined) return undefined;
  const number = Number(match[1]);
  if (match[2] === 'rem') return number * 16;
  if (match[2] === 'px' || number === 0) return number;
  return undefined;
}

/** Whitespace and trailing zeros do not change a shadow: `0.10` and `0.1` are the same opacity. */
const normaliseShadow = (value: string): string =>
  value
    .replace(/\d+\.\d+/g, (number) => String(Number(number)))
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

export function checkTokenFile(markdown: string, css: string): TokenCheck {
  const problems: string[] = [];
  const checked: Record<TokenKind, number> = {
    colour: 0,
    length: 0,
    time: 0,
    weight: 0,
    shadow: 0,
  };
  const properties = parseCustomProperties(css);
  const tokens = documentedTokens(markdown);
  if (tokens.length === 0) problems.push('no tokens were found in the document');

  for (const { token, property, value, kind } of tokens) {
    checked[kind] += 1;
    const actual = resolveProperty(property, properties);
    if (actual === undefined) {
      problems.push(`${token}: the token file does not define ${property}`);
      continue;
    }
    if (!sameValue(kind, actual, value)) {
      problems.push(`${token}: the document says ${value}, ${property} is ${actual}`);
    }
  }
  return { problems, checked };
}

/** Whether the file's value is the document's, by the rules of the kind of value it is. */
function sameValue(kind: TokenKind, actual: string, documented: string): boolean {
  if (kind === 'colour') return actual.toUpperCase() === documented.toUpperCase();
  if (kind === 'length') {
    const wanted = pixels(documented);
    const have = pixels(actual);
    return wanted !== undefined && have !== undefined && Math.abs(wanted - have) < 0.001;
  }
  if (kind === 'shadow') return normaliseShadow(actual) === normaliseShadow(documented);
  return actual === documented;
}

export interface Pairing {
  /** Where the pairing comes from, for the failure message. */
  use: string;
  foreground: string;
  background: string;
  /** 4.5 for text, 3 for a control boundary, a state cue or a focus indicator. */
  threshold: number;
}

/** The pairings that fail their threshold, with the ratio the file's own values give. Never rounded up. */
export function failingPairings(pairings: readonly Pairing[], css: string): string[] {
  const properties = parseCustomProperties(css);
  const problems: string[] = [];
  for (const { use, foreground, background, threshold } of pairings) {
    const front = resolveProperty(foreground, properties);
    const back = resolveProperty(background, properties);
    if (front === undefined || back === undefined) {
      problems.push(`${use}: ${front === undefined ? foreground : background} is not defined`);
      continue;
    }
    const ratio = contrastRatio(front, back);
    if (ratio < threshold) {
      problems.push(
        `${use}: ${foreground} on ${background} is ${ratio.toFixed(2)}:1, below ${String(threshold)}:1`,
      );
    }
  }
  return problems;
}

export interface SourceFile {
  path: string;
  text: string;
}

/**
 * Hex colours and colour functions: the ways a colour is written as a value. `color-mix` and `light-dark` derive a colour
 * that no token defines, so a component that needs one adds it to the token file. System keywords such as `Canvas` are not
 * colours of the design.
 */
const RAW_COLOUR =
  /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\(/g;

/** A hex colour that is the whole of a string: `'#b4232e'`, `"#fff"`. A fragment such as `"#main"` is not all hex digits. */
const QUOTED_HEX = /(["'`])#[0-9a-fA-F]{3,8}\1/g;

/** The CSS named colours (Color Module Level 4). `transparent`, `currentColor` and the system colours are not among them. */
const NAMED_COLOURS = new Set(
  (
    'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood ' +
    'cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray ' +
    'darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen ' +
    'darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue ' +
    'firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew ' +
    'hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan ' +
    'lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray ' +
    'lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue ' +
    'mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred ' +
    'midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid ' +
    'palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple ' +
    'rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue ' +
    'slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white ' +
    'whitesmoke yellow yellowgreen'
  ).split(' '),
);

/** Colours written outside the token file. Comments are ignored; a hex inside a CSS id selector is not a colour. */
export function rawColourProblems(files: readonly SourceFile[], tokenFile: string): string[] {
  const problems: string[] = [];
  for (const { path, text } of files) {
    if (path === tokenFile) continue;
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const match of code.matchAll(RAW_COLOUR)) {
      const before = code.slice(Math.max(0, match.index - 1), match.index);
      // `#abc` after a letter, digit, hyphen or underscore is an id or a fragment (`a#top`, `href="#main"`), not a colour.
      if (match[0].startsWith('#') && /["'\w-]/.test(before)) continue;
      problems.push(`${path}: writes the colour ${match[0]}; use a token from the token file`);
    }
    if (path.endsWith('.css')) {
      // A named colour as the value of a declaration. `var()` and `url()` are removed first, so a token called `--white`
      // is not read as the colour white.
      for (const declaration of code.matchAll(/(?:^|[;{\s])([a-z-]+)\s*:\s*([^;{}]+)(?=[;}])/gi)) {
        const value = (declaration[2] ?? '')
          .replace(/(?:var|url)\([^)]*\)/gi, '')
          .replace(/(["']).*?\1/g, '');
        for (const word of value.toLowerCase().match(/[a-z]+/g) ?? []) {
          if (NAMED_COLOURS.has(word)) {
            problems.push(
              `${path}: writes the colour ${word} in ${declaration[1] ?? 'a declaration'}; use a token`,
            );
          }
        }
      }
    } else {
      // In code: a hex that is a whole string, and a named colour given to a colour attribute or property.
      for (const match of code.matchAll(QUOTED_HEX)) {
        const lead = code.slice(Math.max(0, match.index - 12), match.index);
        if (/(?:href|to|id|htmlFor|hash)\s*=\s*\{?$/.test(lead)) continue;
        problems.push(`${path}: writes the colour ${match[0]}; use a token from the token file`);
      }
      for (const match of code.matchAll(
        /\b(?:fill|stroke|color|stopColor|floodColor|background|backgroundColor)\s*[=:]\s*["']([a-z]+)["']/gi,
      )) {
        if (NAMED_COLOURS.has((match[1] ?? '').toLowerCase())) {
          problems.push(
            `${path}: writes the colour ${match[1] ?? ''}; use a token from the token file`,
          );
        }
      }
    }
  }
  return problems;
}

/**
 * An outline removed by any rule. The global `:focus-visible` rule draws the ring, and a component rule of the same
 * specificity that loads later (`.ui-input { outline: none }`) would silently take it away, so no rule may. Only the
 * mouse-only pattern `:focus:not(:focus-visible)` may, because the keyboard ring stays.
 */
export function outlineRemovalProblems(files: readonly SourceFile[]): string[] {
  const problems: string[] = [];
  for (const { path, text } of files) {
    if (!path.endsWith('.css')) continue;
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const match of code.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = (match[1] ?? '').trim().replace(/\s+/g, ' ');
      const body = match[2] ?? '';
      if (selector.includes(':focus:not(:focus-visible)')) continue;
      if (/\boutline(?:-style)?\s*:\s*(?:none|0)(?![\w.%-])/i.test(body)) {
        problems.push(`${path}: "${selector}" removes the outline`);
      }
    }
  }
  return problems;
}

/**
 * Custom properties the token file defines that the document does not. A colour the document never approved enters the
 * system this way, so every such property is named in `recorded`, with its reason, or reported.
 */
export function undocumentedTokenProblems(
  markdown: string,
  css: string,
  recorded: readonly string[],
): string[] {
  const documented = new Set(documentedTokens(markdown).map((token) => token.property));
  const problems: string[] = [];
  for (const name of parseCustomProperties(css).keys()) {
    if (!documented.has(name) && !recorded.includes(name)) {
      problems.push(
        `${name}: the token file defines it, and neither the document nor the recorded tokens do`,
      );
    }
  }
  return problems;
}

/**
 * What a stylesheet may not do, whatever else it does. The content security policy lets the page load only its own
 * styles, so an `@import` or a `url()` that names another origin would fail there and is wrong anywhere. An
 * `!important` is a way round the cascade that the tokens and the components are ordered by. And a documented token
 * declared again outside the token file is a second value for it: the document and the checks above see the file.
 */
export function unsafeStyleProblems(
  files: readonly SourceFile[],
  tokenFile: string,
  documentedProperties: readonly string[],
): string[] {
  const documented = new Set(documentedProperties);
  const problems: string[] = [];
  for (const { path, text } of files) {
    if (!path.endsWith('.css')) continue;
    // Comments and the text of strings are not code: a `content: "!important"` does nothing.
    const code = text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(["'])(?:(?!\1)[^\\]|\\.)*\1/g, '""');
    if (/@import\b/i.test(code)) {
      problems.push(`${path}: uses @import; the page loads only its own styles`);
    }
    for (const match of text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .matchAll(/url\(\s*(["']?)([^)"']*)\1\s*\)/gi)) {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(match[2] ?? '')) {
        problems.push(`${path}: loads ${match[2] ?? ''} from another origin`);
      }
    }
    if (/!\s*important\b/i.test(code)) problems.push(`${path}: uses !important`);
    if (path !== tokenFile) {
      for (const match of code.matchAll(/(--[a-z0-9-]+)\s*:/gi)) {
        if (documented.has(match[1] ?? '')) {
          problems.push(
            `${path}: declares ${match[1] ?? ''} again; a token has one value, in the token file`,
          );
        }
      }
    }
  }
  return problems;
}

/**
 * `var(--x)` references that no stylesheet defines. CSS gives an undefined property no value and no error, so a mistyped
 * token name quietly leaves the browser default in place. A reference with a fallback, `var(--x, red)`, is the author's
 * choice and is not reported.
 */
export function undefinedVariableProblems(files: readonly SourceFile[]): string[] {
  const stylesheets = files
    .filter((file) => file.path.endsWith('.css'))
    .map((file) => ({ path: file.path, code: file.text.replace(/\/\*[\s\S]*?\*\//g, '') }));
  const defined = new Set(
    stylesheets.flatMap(({ code }) =>
      [...code.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((match) => match[1]),
    ),
  );
  const problems: string[] = [];
  for (const { path, code } of stylesheets) {
    for (const match of code.matchAll(/var\(\s*(--[a-z0-9-]+)\s*([,)])/gi)) {
      const [, name = '', after = ''] = match;
      if (after === ',' || defined.has(name)) continue;
      problems.push(`${path}: uses var(${name}), which no stylesheet defines`);
    }
  }
  return problems;
}

/**
 * Focus must be drawn with `outline`, which forced-colours mode keeps (DESIGN_SYSTEM §4.6); `box-shadow` is dropped.
 * Returns every rule that styles `:focus` or `:focus-visible` and sets no outline.
 */
export function focusRulesWithoutOutline(files: readonly SourceFile[]): string[] {
  const problems: string[] = [];
  for (const { path, text } of files) {
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const match of code.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = match[1]?.trim() ?? '';
      const body = match[2] ?? '';
      if (!/:focus(-visible)?\b/.test(selector) || selector.includes(':focus-within')) continue;
      // `outline` or `outline-style` with a value that draws something: an offset alone draws nothing, and `none` or `0`
      // removes the ring.
      if (!/\boutline(?:-style)?\s*:\s*(?!none\b|0\s*[;}]|0\s*$)[^;}\s]/.test(body)) {
        problems.push(
          `${path}: "${selector.replace(/\s+/g, ' ')}" styles focus without an outline`,
        );
      }
    }
  }
  return problems;
}
