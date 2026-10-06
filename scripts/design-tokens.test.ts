import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';

import {
  checkTokenFile,
  documentedTokens,
  failingPairings,
  focusRulesWithoutOutline,
  parseCustomProperties,
  propertyName,
  outlineRemovalProblems,
  rawColourProblems,
  resolveProperty,
  undefinedVariableProblems,
  undocumentedTokenProblems,
  unsafeStyleProblems,
  type Pairing,
  type SourceFile,
} from './design-tokens.ts';

/**
 * The Ops Portal's token file is the one executable source of the design tokens (DESIGN_SYSTEM §29.1), so it is held to
 * the document, and the rules the components rely on are held to the file: the supported pairings, no colour written
 * outside the file, and a focus indicator that forced-colours mode keeps.
 */
const root = resolve(import.meta.dirname, '..');
const TOKEN_FILE = 'apps/ops-web/src/styles/tokens.css';
const document = readFileSync(join(root, 'design', 'DESIGN_SYSTEM.md'), 'utf8');
const tokenCss = readFileSync(join(root, TOKEN_FILE), 'utf8');

/** The application's own sources: styles and components, not their tests. */
function applicationSources(): SourceFile[] {
  const base = join(root, 'apps', 'ops-web', 'src');
  const found: SourceFile[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const name = relative(root, path).replaceAll('\\', '/');
      if (entry.isDirectory()) {
        if (entry.name !== 'test-support') walk(path);
      } else if (/\.(css|tsx?)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        found.push({ path: name, text: readFileSync(path, 'utf8') });
      }
    }
  };
  walk(base);
  return found;
}

const property = (token: string): string => propertyName(token);

describe('propertyName', () => {
  // DESIGN_SYSTEM §29.1: dots become hyphens and camelCase becomes kebab-case.
  it('follows the naming rule of the document', () => {
    assert.equal(propertyName('color.action.primaryHover'), '--color-action-primary-hover');
    assert.equal(propertyName('focus.ring'), '--focus-ring');
    assert.equal(propertyName('focus.offsetWidth'), '--focus-offset-width');
    assert.equal(propertyName('space.4'), '--space-4');
    assert.equal(propertyName('text.heading.xl.lineHeight'), '--text-heading-xl-line-height');
    assert.equal(propertyName('crimson.600'), '--crimson-600');
    assert.equal(propertyName('white'), '--white');
  });
});

describe('the token file against DESIGN_SYSTEM', () => {
  it('defines every documented token with the documented value', () => {
    assert.deepEqual(checkTokenFile(document, tokenCss).problems, []);
  });

  // Break caught: a check that passes because it found nothing to compare.
  it('compares the whole of the document, not a sample', () => {
    const { checked } = checkTokenFile(document, tokenCss);
    // 23 palette colours, 28 semantic, 15 status and the 2 inverse focus colours; 12 space steps, 6 radii, 22 type
    // sizes and line heights, 2 focus widths and 3 control heights.
    assert.equal(checked.colour, 68, 'colours');
    assert.equal(checked.length, 45, 'lengths');
    assert.equal(checked.time, 3, 'the three motion durations');
    assert.equal(checked.weight, 11, 'the eleven typography weights');
    assert.equal(checked.shadow, 4, 'the four shadows');
    const names = new Set(documentedTokens(document).map((token) => token.token));
    for (const expected of [
      'color.action.primary',
      'color.border.control',
      'color.status.danger.foreground',
      'focus.ring',
      'focus.ringInverse',
      'space.20',
      'radius.md',
      'control.height.md',
      'text.body.md.size',
      'gray.550',
    ]) {
      assert.ok(names.has(expected), `the document no longer defines ${expected}`);
    }
  });

  // Break caught: a token added to the file with no place in the document, which is how a colour the document never
  // approved enters the system. The few tokens the document does not define are named, with the reason.
  it('defines nothing the document does not, except the recorded component and layout tokens', () => {
    const recorded = [
      '--font-family-sans', // the fallback stack of section 5.1, written once for components
      '--button-pressed-background', // the bare #EAECF0 of the Secondary pressed recipe, section 4.6
      '--layout-content-width', // the width the frame has always given the main landmark
    ];
    assert.deepEqual(undocumentedTokenProblems(document, tokenCss, recorded), []);
  });

  it('reports a token that is neither documented nor recorded', () => {
    const css = tokenCss.replace(':root {', ':root {\n  --color-brand-extra: #123456;');
    assert.match(
      undocumentedTokenProblems(document, css, ['--font-family-sans']).join('\n'),
      /--color-brand-extra/,
    );
  });

  // Each change below is one wrong value that a tired edit could make; every one must be reported.
  const replaceProperty = (css: string, name: string, value: string): string =>
    css.replace(new RegExp(`(${name}\\s*:\\s*)[^;]+;`), `$1${value};`);

  it('reports a colour that differs from the document', () => {
    const css = replaceProperty(tokenCss, property('color.text.muted'), '#667086');
    assert.match(checkTokenFile(document, css).problems.join('\n'), /color\.text\.muted/);
  });

  it('reports a token that the file leaves out', () => {
    const css = tokenCss.replace(new RegExp(`${property('space.4')}\\s*:[^;]+;`), '');
    assert.match(checkTokenFile(document, css).problems.join('\n'), /space\.4.*does not define/);
  });

  it('reports a length that differs, whatever unit the file uses', () => {
    const css = replaceProperty(tokenCss, property('radius.md'), '0.5rem');
    assert.match(checkTokenFile(document, css).problems.join('\n'), /radius\.md/);
    const same = replaceProperty(tokenCss, property('radius.md'), '6px');
    assert.deepEqual(checkTokenFile(document, same).problems, []);
  });

  it('reports a value that the document changed and the file did not', () => {
    const changed = document.replace('| `space.4` | `16px` |', '| `space.4` | `18px` |');
    assert.notEqual(changed, document);
    assert.match(checkTokenFile(changed, tokenCss).problems.join('\n'), /space\.4/);
  });

  it('follows a token that is an alias of another, and reports one that loops or points nowhere', () => {
    const properties = parseCustomProperties(
      ':root { --a: var(--b); --b: #112233; --c: var(--d); --d: var(--c); --e: var(--missing); }',
    );
    assert.equal(resolveProperty('--a', properties), '#112233');
    assert.equal(resolveProperty('--c', properties), undefined);
    assert.equal(resolveProperty('--e', properties), undefined);
  });
});

/** The pairings the initial components use (DESIGN_SYSTEM §4.6). Text is 4.5:1; boundaries, cues and focus are 3:1. */
const surfaces = ['default', 'page', 'subtle', 'selected'] as const;
const surface = (name: string): string => property(`color.surface.${name}`);

const PAIRINGS: Pairing[] = [
  ...(['primary', 'secondary'] as const).flatMap((text) =>
    (['default', 'page', 'subtle'] as const).map((on) => ({
      use: `${text} text`,
      foreground: property(`color.text.${text}`),
      background: surface(on),
      threshold: 4.5,
    })),
  ),
  ...(['default', 'page'] as const).map((on) => ({
    use: 'muted text',
    foreground: property('color.text.muted'),
    background: surface(on),
    threshold: 4.5,
  })),
  ...(['link', 'linkHover'] as const).flatMap((text) =>
    surfaces.map((on) => ({
      use: `${text} text`,
      foreground: property(`color.text.${text}`),
      background: surface(on),
      threshold: 4.5,
    })),
  ),
  ...(['primary', 'primaryHover', 'primaryPressed'] as const).map((fill) => ({
    use: `Primary button ${fill}`,
    foreground: property('color.action.primaryText'),
    background: property(`color.action.${fill}`),
    threshold: 4.5,
  })),
  ...[surface('default'), surface('subtle'), '--button-pressed-background'].map((fill) => ({
    use: 'Secondary button',
    foreground: property('color.action.secondaryText'),
    background: fill,
    threshold: 4.5,
  })),
  {
    use: 'inverse text',
    foreground: property('color.text.inverse'),
    background: surface('inverse'),
    threshold: 4.5,
  },
  ...(['success', 'warning', 'danger', 'info', 'neutral'] as const).map((status) => ({
    use: `${status} alert`,
    foreground: property(`color.status.${status}.foreground`),
    background: property(`color.status.${status}.background`),
    threshold: 4.5,
  })),
  ...(['success', 'danger'] as const).flatMap((status) =>
    (['default', 'page'] as const).map((on) => ({
      use: `${status} text`,
      foreground: property(`color.status.${status}.foreground`),
      background: surface(on),
      threshold: 4.5,
    })),
  ),
  ...surfaces.flatMap((on) => [
    {
      use: 'focus ring',
      foreground: property('focus.ring'),
      background: surface(on),
      threshold: 3,
    },
    {
      use: 'control boundary',
      foreground: property('color.border.control'),
      background: surface(on),
      threshold: 3,
    },
    {
      use: 'strong boundary',
      foreground: property('color.border.strong'),
      background: surface(on),
      threshold: 3,
    },
  ]),
  {
    use: 'invalid field boundary',
    foreground: property('color.status.danger.foreground'),
    background: surface('default'),
    threshold: 3,
  },
  {
    use: 'inverse focus ring',
    foreground: property('focus.ringInverse'),
    background: surface('inverse'),
    threshold: 3,
  },
  {
    use: 'selected row bar',
    foreground: property('color.action.primary'),
    background: surface('selected'),
    threshold: 3,
  },
];

describe('the pairings the components use', () => {
  it('all meet their threshold, from the values in the token file', () => {
    assert.deepEqual(failingPairings(PAIRINGS, tokenCss), []);
  });

  it('are numerous enough that the list was not emptied', () => {
    assert.ok(PAIRINGS.length >= 45, `pairings: ${String(PAIRINGS.length)}`);
  });

  // Break caught: a token change that quietly breaks a supported pairing. §4.6 says an unsupported one is not allowed.
  it('report a pairing that a changed token no longer meets', () => {
    const lighter = tokenCss.replace(
      new RegExp(`(${property('color.text.muted')}\\s*:\\s*)[^;]+;`),
      '$1#98a2b3;',
    );
    assert.match(failingPairings(PAIRINGS, lighter).join('\n'), /muted text.*below 4\.5:1/);
  });

  it('report a pairing that names a token the file does not define', () => {
    const problems = failingPairings(
      [{ use: 'x', foreground: '--no-such', background: surface('default'), threshold: 3 }],
      tokenCss,
    );
    assert.match(problems.join('\n'), /--no-such is not defined/);
  });
});

describe('colours and focus in the application sources', () => {
  const sources = applicationSources();

  it('finds the sources it is meant to scan', () => {
    const paths = sources.map((file) => file.path);
    assert.ok(paths.includes(TOKEN_FILE));
    assert.ok(paths.some((path) => path.endsWith('.tsx')));
    assert.ok(sources.length >= 10, `sources: ${String(sources.length)}`);
  });

  it('write no colour outside the token file', () => {
    assert.deepEqual(rawColourProblems(sources, TOKEN_FILE), []);
  });

  it('are caught when one does: a hex, a colour function, and nothing for a keyword or an id', () => {
    const probe = (text: string): string[] =>
      rawColourProblems([{ path: 'a.css', text }], TOKEN_FILE);
    assert.equal(probe('a { color: #b4232e; }').length, 1);
    assert.equal(probe('a { color: #fff; }').length, 1);
    assert.equal(probe('a { color: rgb(1 2 3); }').length, 1);
    assert.equal(probe('a { color: rgba(0, 0, 0, 0.5); }').length, 1);
    assert.equal(probe('a { color: hsl(10 20% 30%); }').length, 1);
    assert.equal(
      probe('a { border-color: transparent; color: currentColor; outline: Highlight; }').length,
      0,
    );
    assert.equal(probe('a { color: var(--color-text-primary); }').length, 0);
    assert.equal(probe('/* #b4232e is crimson */ a { color: inherit; }').length, 0);
    assert.equal(probe('<a href="#main-content">').length, 0);
    assert.equal(probe('const x = "a#top";').length, 0);
  });

  // Break caught: a colour written in a way the simple pattern misses: a quoted hex in code, a named colour, or a colour
  // derived from tokens in a component (a derived colour is a new colour, so it is defined in the token file).
  it('are caught when a colour is quoted, named or derived, and not when a token, a keyword or an anchor is used', () => {
    const tsx = (text: string): string[] =>
      rawColourProblems([{ path: 'a.tsx', text }], TOKEN_FILE);
    const css = (text: string): string[] =>
      rawColourProblems([{ path: 'a.css', text }], TOKEN_FILE);
    assert.equal(tsx("const c = '#b4232e';").length, 1);
    assert.equal(tsx('<path fill="#B4232E" />').length, 1);
    assert.equal(tsx('<path fill="red" />').length, 1);
    assert.equal(tsx('<a href="#main-content">x</a>').length, 0);
    assert.equal(tsx('<a href="#add">x</a>').length, 0);
    assert.equal(tsx('<path fill="currentColor" stroke="none" />').length, 0);
    assert.equal(css('a { background: white; }').length, 1);
    assert.equal(css('a { border: 1px solid black; }').length, 1);
    assert.equal(css('a { color: color-mix(in srgb, var(--a) 50%, var(--b)); }').length, 1);
    assert.equal(css('a { color: light-dark(var(--a), var(--b)); }').length, 1);
    assert.equal(
      css(
        'a { color: var(--white); background: transparent; border-color: ButtonText; outline: 2px solid Highlight; }',
      ).length,
      0,
    );
    assert.equal(
      css(
        'a { font-family: var(--font-family-sans); border: 1px solid var(--color-border-default); }',
      ).length,
      0,
    );
  });

  it('remove no outline anywhere', () => {
    assert.deepEqual(outlineRemovalProblems(sources), []);
  });

  // Break caught: a focus ring removed by a rule that is not about focus. `.ui-input { outline: none }` has the same
  // specificity as the global :focus-visible rule and, loading later, wins: the ring is gone and nothing says so.
  it('refuse to remove an outline anywhere, except for a mouse-only focus', () => {
    const probe = (text: string): string[] => outlineRemovalProblems([{ path: 'a.css', text }]);
    assert.equal(probe('.x { outline: none; }').length, 1);
    assert.equal(probe('.x { outline: 0; }').length, 1);
    assert.equal(probe('.x { outline-style: none; }').length, 1);
    assert.equal(probe('.x:focus-visible { outline: none; }').length, 1);
    assert.equal(probe('.x:focus:not(:focus-visible) { outline: none; }').length, 0);
    assert.equal(probe('.x { outline: 2px solid var(--focus-ring); }').length, 0);
  });

  // Break caught: a mistyped token name. CSS gives `var(--color-text-prmary)` no value and no error, so the text
  // quietly takes the browser default.
  it('use no custom property that no stylesheet defines', () => {
    assert.deepEqual(undefinedVariableProblems(sources), []);
  });

  it('are caught when one does: an undefined property, but not a defined one, a fallback or a comment', () => {
    const probe = (text: string): string[] =>
      undefinedVariableProblems([
        { path: 'tokens.css', text: ':root { --defined: #112233; }' },
        { path: 'a.css', text },
      ]);
    assert.equal(probe('a { color: var(--undefined); }').length, 1);
    assert.equal(probe('a { color: var( --undefined ); }').length, 1);
    assert.equal(probe('a { color: var(--defined); }').length, 0);
    assert.equal(probe('a { color: var(--undefined, red); }').length, 0);
    assert.equal(probe('/* var(--undefined) */ a { color: inherit; }').length, 0);
    assert.equal(probe('a { --local: 1px; margin: var(--local); }').length, 0);
  });

  // Break caught: a stylesheet that reaches outside the application or takes a decision away from the tokens. The
  // content security policy allows only the application's own styles, so an import or a remote url() would break
  // there; an `!important` is a way round the order the tokens and components rely on; and a documented token
  // declared again outside the token file is a second value for it that the document and the checks above never see.
  it('import nothing, load nothing from another origin, use no !important and redeclare no token', () => {
    const documented = documentedTokens(document).map((token) => token.property);
    assert.deepEqual(unsafeStyleProblems(sources, TOKEN_FILE, documented), []);
  });

  it('are caught when a stylesheet does any of those, and not when it does not', () => {
    const probe = (text: string, path = 'a.css'): string[] =>
      unsafeStyleProblems([{ path, text }], TOKEN_FILE, ['--color-border-control']);
    assert.equal(probe('@import "other.css";').length, 1);
    assert.equal(probe("@import url('other.css');").length, 1);
    assert.equal(probe('a { background: url(https://example.test/x.png); }').length, 1);
    assert.equal(probe('a { background: url("//example.test/x.png"); }').length, 1);
    assert.equal(probe('a { color: var(--c) !important; }').length, 1);
    assert.equal(probe('a { color: var(--c) ! important; }').length, 1);
    assert.equal(probe('a { --color-border-control: #000; }').length, 1);
    assert.equal(probe('a { --color-border-control : var(--x); }').length, 1);
    // What is fine: the file's own path, its own tokens, a local property, a comment, a path-relative url.
    assert.equal(probe('a { --color-border-control: #000; }', TOKEN_FILE).length, 0);
    assert.equal(probe('a { --local: 1px; }').length, 0);
    assert.equal(probe('a { background: url(/icons/x.svg); }').length, 0);
    assert.equal(
      probe('/* @import "x.css"; !important; url(https://x.test) */ a { margin: 0; }').length,
      0,
    );
    assert.equal(probe('a::before { content: "!important and @import"; }').length, 0);
  });

  // Break caught: a focus indicator drawn with box-shadow alone, which forced-colours mode removes.
  it('draw every focus indicator with an outline', () => {
    assert.deepEqual(focusRulesWithoutOutline(sources), []);
  });

  it('are caught when a focus rule has no outline', () => {
    const probe = (text: string): string[] => focusRulesWithoutOutline([{ path: 'a.css', text }]);
    assert.equal(probe('.x:focus-visible { box-shadow: 0 0 0 2px red; }').length, 1);
    assert.equal(probe('.x:focus { background: white; }').length, 1);
    assert.equal(probe('.x:focus-visible { outline: 2px solid var(--focus-ring); }').length, 0);
    assert.equal(probe('.x:focus-visible { outline-style: solid; outline-width: 2px; }').length, 0);
    // An offset alone draws nothing, and "none" or "0" removes the ring: neither is an outline.
    assert.equal(
      probe('.x:focus-visible { outline-offset: 2px; box-shadow: 0 0 0 2px red; }').length,
      1,
    );
    assert.equal(probe('.x:focus-visible { outline: none; box-shadow: 0 0 0 2px red; }').length, 1);
    assert.equal(probe('.x:focus-visible { outline: 0; }').length, 1);
    assert.equal(probe('.x:focus-visible { outline-style: none; }').length, 1);
    assert.equal(probe('.x:hover { background: white; }').length, 0);
  });
});
