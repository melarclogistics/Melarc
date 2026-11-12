import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';

import { contrastRatio } from './design-contrast.ts';
import {
  checkTokenFile,
  documentedTokens,
  failingPairings,
  FOCUS_EXCEPTIONS,
  focusRulesWithoutOutline,
  parseCustomProperties,
  parseThemes,
  propertyName,
  outlineRemovalProblems,
  rawColourProblems,
  resolveProperty,
  themeStructureProblems,
  THEMES,
  undefinedVariableProblems,
  undocumentedTokenProblems,
  unsafeStyleProblems,
  type Pairing,
  type SourceFile,
} from './design-tokens.ts';

/**
 * The Ops Portal's token file is the one executable source of the design tokens (DESIGN_SYSTEM §29.1), so it is held to
 * the document, and the rules the components rely on are held to the file: the two themes (§31), the supported pairings
 * in each, no colour written outside the file, and a focus indicator that forced-colours mode keeps.
 */
const root = resolve(import.meta.dirname, '..');
const TOKEN_FILE = 'apps/ops-web/src/styles/tokens.css';
/** The stylesheet Tailwind builds from (DESIGN_SYSTEM §29): the one whose package imports belong to the build. */
const TAILWIND_ENTRY = 'apps/ops-web/src/styles/tailwind.css';
const document = readFileSync(join(root, 'design', 'DESIGN_SYSTEM.md'), 'utf8');
const tokenCss = readFileSync(join(root, TOKEN_FILE), 'utf8');
const baseCss = readFileSync(join(root, 'apps/ops-web/src/styles/base.css'), 'utf8');

// Each change a test makes to the token file is one wrong value that a tired edit could make.
const replaceProperty = (css: string, name: string, value: string): string =>
  css.replace(new RegExp(`(${name}\\s*:\\s*)[^;]+;`), `$1${value};`);
/** Changes a property inside the one block that opens with `opening`, leaving the same property elsewhere alone. */
const replaceInBlock = (css: string, opening: string, name: string, value: string): string => {
  const start = css.indexOf(opening);
  assert.notEqual(start, -1, `the token file has no block ${opening}`);
  const end = css.indexOf('}', start);
  const block = css.slice(start, end);
  const changed = block.replace(new RegExp(`(${name}\\s*:\\s*)[^;]+;`), `$1${value};`);
  assert.notEqual(changed, block, `${name} is not set in ${opening}`);
  return css.slice(0, start) + changed + css.slice(end);
};
const DARK_MEDIA = "@media (prefers-color-scheme: dark) {\n  :root:not([data-theme='light']) {";
const DARK_ATTRIBUTE = ":root[data-theme='dark'] {";

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
    const { checked, dark } = checkTokenFile(document, tokenCss);
    // Colours: 2 fixed, 45 semantic (7 surfaces, 7 text, 5 borders, 1 brand, 12 actions, 4 focus, 9 sidebar) and 15 status,
    // each of the 60 semantic and status ones in both themes. Lengths: 12 space steps, 6 radii, 22 type sizes and line
    // heights, 2 focus widths, 3 control heights and 3 row heights. Shadows: 2, each in both themes.
    assert.equal(checked.colour, 2 + 60 + 60, 'colours, light and dark');
    assert.equal(checked.length, 12 + 6 + 22 + 2 + 3 + 3, 'lengths');
    assert.equal(checked.time, 4, 'the four motion durations');
    assert.equal(checked.easing, 2, 'the two easings');
    assert.equal(checked.weight, 11, 'the eleven typography weights');
    assert.equal(checked.shadow, 4, 'the two shadows, each in both themes');
    assert.equal(dark, 60 + 2, 'the values the document gives for the dark theme');
    const names = new Set(documentedTokens(document).map((token) => token.token));
    for (const expected of [
      'color.action.primary',
      'color.action.new',
      'color.border.control',
      'color.brand.default',
      'color.surface.raised',
      'color.status.danger.foreground',
      'focus.ring',
      'focus.ringInverse',
      'shell.active',
      'space.20',
      'radius.md',
      'control.height.md',
      'density.row.touch',
      'motion.easeEnter',
      'shadow.floating',
      'text.body.md.size',
      'white',
    ]) {
      assert.ok(names.has(expected), `the document no longer defines ${expected}`);
    }
  });

  // Break caught: a token added to the file with no place in the document, which is how a colour the document never
  // approved enters the system. The few tokens the document does not define are named, with the reason.
  it('defines nothing the document does not, except the recorded component and layout tokens', () => {
    const recorded = [
      '--font-family-sans', // the fallback stack of section 5.1, written once for components
      '--font-family-mono', // the same for operational codes, set in JetBrains Mono (section 5.1)
      '--button-pressed-background', // the pressed fill of the Secondary and Danger recipes, section 4.6; themed, checked below
      '--layout-content-width', // the width the frame has always given the main landmark
      // The two widths of the sidebar and the height of the top bar: layout and not design-system tokens (section 13.2).
      '--sidebar-width',
      '--sidebar-width-collapsed',
      '--topbar-height',
      // The pill of a count on the crimson current entry: white at 18% (at 22% the white figure is 4.32:1, below the 4.5:1 of section 14).
      '--shell-active-badge',
      // The sizes the signed-in shell sets outside the type and spacing scales (the Product Owner's brief of 6 November 2026, recorded in section 5.2 and
      // decided on 7 November 2026 to be tokens): component tokens (section 3.3), each used by the one component it is named for, in rem.
      '--text-nav-entry-size',
      '--text-group-label-size',
      '--text-group-label-line-height',
      '--text-section-label-size',
      '--text-section-label-line-height',
      '--sidebar-icon-size',
      '--sidebar-heading-space-before',
      '--sidebar-heading-space-after',
      '--hub-mark-size',
      // The sizes the kit of redesign step R5 sets outside the scales (task R5.2, 8 November 2026): component tokens, each named for the component that uses it.
      '--text-page-title-line-height',
      '--text-record-title-size',
      '--text-stat-figure-size',
      '--text-stat-figure-line-height',
      '--density-row-two-line',
      '--motion-pulse',
      // The three sizes of an icon (section 24), in rem so that enlarged text enlarges them.
      '--icon-size-sm',
      '--icon-size-md',
      '--icon-size-lg',
    ];
    assert.deepEqual(undocumentedTokenProblems(document, tokenCss, recorded), []);
  });

  // The one recorded token that differs by theme. It is a component token (section 3.3) and not in a table, so its two values are
  // held here and to the sentence of section 4.3 that gives them.
  it('gives the recorded pressed fill the values section 4.3 states, in both themes', () => {
    const themes = parseThemes(tokenCss);
    assert.equal(themes.light.get('--button-pressed-background')?.toUpperCase(), '#E2E5EB');
    assert.equal(
      resolveProperty('--button-pressed-background', themes.dark)?.toUpperCase(),
      '#090D16',
    );
    assert.match(
      document,
      /`--button-pressed-background`[\s\S]{0,120}`#E2E5EB`[\s\S]{0,40}light theme[\s\S]{0,40}`#090D16`[\s\S]{0,20}dark/,
    );
  });

  it('reports a token that is neither documented nor recorded', () => {
    const css = tokenCss.replace(':root {', ':root {\n  --color-brand-extra: #123456;');
    assert.match(
      undocumentedTokenProblems(document, css, ['--font-family-sans']).join('\n'),
      /--color-brand-extra/,
    );
  });

  // Each change below is one wrong value that a tired edit could make; every one must be reported.

  it('reports a colour that differs from the document', () => {
    const css = replaceProperty(tokenCss, property('color.text.muted'), '#667086');
    assert.match(checkTokenFile(document, css).problems.join('\n'), /color\.text\.muted/);
  });

  it('reports a token that the file leaves out', () => {
    const css = tokenCss.replace(new RegExp(`${property('space.4')}\\s*:[^;]+;`), '');
    assert.match(checkTokenFile(document, css).problems.join('\n'), /space\.4.*does not define/);
  });

  it('reports a length that differs, whatever unit the file uses', () => {
    const css = replaceProperty(tokenCss, property('radius.md'), '0.375rem');
    assert.match(checkTokenFile(document, css).problems.join('\n'), /radius\.md/);
    const same = replaceProperty(tokenCss, property('radius.md'), '8px');
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

  // The themes (DESIGN_SYSTEM §31, decided 5 November 2026): the light values on :root, the dark values by the system setting unless
  // the root says data-theme="light" and by data-theme="dark", so that a later toggle wins both ways; and a reduced-motion rule.
  it('has the light theme on :root and the dark theme where the system setting and a toggle will reach it', () => {
    assert.deepEqual(themeStructureProblems(parseThemes(tokenCss)), []);
  });

  it('resolves a token that follows another to the value that theme gives the other', () => {
    const themes = parseThemes(tokenCss);
    // `color.surface.disabled` is the sunken surface: it must follow it into the dark theme and not stay light.
    assert.equal(
      resolveProperty('--color-surface-disabled', themes.light)?.toUpperCase(),
      '#EEF0F4',
    );
    assert.equal(
      resolveProperty('--color-surface-disabled', themes.dark)?.toUpperCase(),
      '#0C111A',
    );
    assert.equal(resolveProperty('--color-action-new', themes.dark)?.toUpperCase(), '#F04B59');
  });

  it('gives the dark theme only colours and shadows, and every one the document gives a dark value', () => {
    const documentedDark = new Set(
      documentedTokens(document)
        .filter((token) => token.theme === 'dark')
        .map((token) => token.property),
    );
    const { darkMedia } = parseThemes(tokenCss);
    assert.ok(
      darkMedia !== undefined && darkMedia.size > 40,
      'the dark theme overrides the colours',
    );
    for (const name of darkMedia.keys()) {
      assert.ok(
        documentedDark.has(name) || name === '--button-pressed-background',
        `${name} is overridden for the dark theme and the document gives it no dark value`,
      );
    }
  });

  it('reports a dark value that differs from the document', () => {
    const css = replaceInBlock(tokenCss, DARK_ATTRIBUTE, '--color-text-muted', '#8e98ad');
    const css2 = replaceInBlock(css, DARK_MEDIA, '--color-text-muted', '#8e98ad');
    assert.match(
      checkTokenFile(document, css2).problems.join('\n'),
      /color\.text\.muted.*dark theme/,
    );
    // The light value of the same token is untouched, so the light check is still clean of it.
    assert.doesNotMatch(
      checkTokenFile(document, css2).problems.join('\n'),
      /color\.text\.muted: the document says #626B81/,
    );
  });

  it('reports a dark value that only one of the two dark blocks changed', () => {
    const css = replaceInBlock(tokenCss, DARK_ATTRIBUTE, '--color-text-muted', '#8e98ad');
    assert.match(
      themeStructureProblems(parseThemes(css)).join('\n'),
      /--color-text-muted: the two dark blocks differ/,
    );
    const other = replaceInBlock(tokenCss, DARK_MEDIA, '--color-text-muted', '#8e98ad');
    assert.match(
      themeStructureProblems(parseThemes(other)).join('\n'),
      /the two dark blocks differ/,
    );
  });

  it('reports a token whose dark value the file does not set', () => {
    // Remove the dark selected surface from both dark blocks: the dark theme then inherits the light value, which the document does not say.
    const stripped = tokenCss.replace(/\n\s*--color-surface-selected: #16202f;/g, '');
    assert.notEqual(stripped, tokenCss, 'the dark selected surface is set in the dark blocks');
    assert.match(
      checkTokenFile(document, stripped).problems.join('\n'),
      /color\.surface\.selected.*dark theme/,
    );
  });

  it('reports a file without the dark theme, without its toggle, or without color-scheme', () => {
    const noMedia = tokenCss.replace(/@media \(prefers-color-scheme: dark\) \{[\s\S]*?\n\}\n/, '');
    assert.notEqual(noMedia, tokenCss);
    assert.match(
      themeStructureProblems(parseThemes(noMedia)).join('\n'),
      /no dark theme for the system setting/,
    );
    const noAttribute = tokenCss.replace(/:root\[data-theme='dark'\] \{[\s\S]*?\n\}\n/, '');
    assert.notEqual(noAttribute, tokenCss);
    assert.match(
      themeStructureProblems(parseThemes(noAttribute)).join('\n'),
      /no dark theme for :root\[data-theme='dark'\]/,
    );
    const lightScheme = replaceInBlock(tokenCss, DARK_ATTRIBUTE, 'color-scheme', 'light');
    assert.match(themeStructureProblems(parseThemes(lightScheme)).join('\n'), /color-scheme: dark/);
  });

  // Break caught: a dark block that applies when the person chose light. `:not([data-theme='light'])` is what lets a toggle override
  // the system setting in that direction.
  it('keeps the system dark theme from applying when the root says data-theme="light"', () => {
    const widened = tokenCss.replace(":root:not([data-theme='light']) {", ':root {');
    assert.notEqual(widened, tokenCss);
    assert.match(
      themeStructureProblems(parseThemes(widened)).join('\n'),
      /no dark theme for the system setting|differ/,
    );
  });

  it('takes the durations away under reduced motion, and only the durations', () => {
    const themes = parseThemes(tokenCss);
    for (const name of [
      '--motion-fast',
      '--motion-normal',
      '--motion-slow',
      '--motion-highlight',
    ]) {
      assert.equal(themes.reducedMotion?.get(name), '0ms', name);
    }
    assert.equal(themes.reducedMotion?.has('--motion-ease-enter'), false);
    const without = tokenCss.replace(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}\n/,
      '',
    );
    assert.notEqual(without, tokenCss);
    assert.match(
      themeStructureProblems(parseThemes(without)).join('\n'),
      /reduced-motion rule must set it to 0ms/,
    );
    const extra = tokenCss.replace(
      /(@media \(prefers-reduced-motion: reduce\) \{\s*:root \{)/,
      '$1\n    --space-4: 0;',
    );
    assert.match(
      themeStructureProblems(parseThemes(extra)).join('\n'),
      /--space-4.*not a duration/,
    );
  });

  it('sets numbers in tabular figures in the base type', () => {
    const body = /(?:^|\n)body\s*\{([^}]*)\}/.exec(baseCss)?.[1] ?? '';
    assert.match(body, /font-variant-numeric:\s*tabular-nums/);
  });
});

/**
 * The pairings the components use (DESIGN_SYSTEM §4.6). Text is 4.5:1; boundaries, cues and focus are 3:1. The same list is held to
 * both themes, because a pairing the system supports is supported on a light ground and on a dark one.
 */
const surfaces = ['default', 'page', 'raised', 'subtle', 'selected'] as const;
const surface = (name: string): string => property(`color.surface.${name}`);
const shell = (name: string): string => `--shell-${name}`;

const PAIRINGS: Pairing[] = [
  // Text on the surfaces it is supported on. Muted text and the control boundary are not supported on the selected tint of the light
  // theme (4.22 and 2.93), so they are not listed there; the strong boundary is.
  ...(['primary', 'secondary'] as const).flatMap((text) =>
    surfaces.map((on) => ({
      use: `${text} text`,
      foreground: property(`color.text.${text}`),
      background: surface(on),
      threshold: 4.5,
    })),
  ),
  ...(['default', 'page', 'raised', 'subtle'] as const).map((on) => ({
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
  // Primary and New: the text of each on its fill, resting, hovered and pressed.
  ...(['primary', 'primaryHover', 'primaryPressed'] as const).map((fill) => ({
    use: `Primary button ${fill}`,
    foreground: property('color.action.primaryText'),
    background: property(`color.action.${fill}`),
    threshold: 4.5,
  })),
  ...(['new', 'newHover', 'newPressed'] as const).map((fill) => ({
    use: `New button ${fill}`,
    foreground: property('color.action.newText'),
    background: property(`color.action.${fill}`),
    threshold: 4.5,
  })),
  // Secondary (§4.6): its text on the fill, the hover fill (the sunken surface) and the pressed fill.
  ...[surface('default'), surface('subtle'), '--button-pressed-background'].map((fill) => ({
    use: 'Secondary button',
    foreground: property('color.action.secondaryText'),
    background: fill,
    threshold: 4.5,
  })),
  // A tertiary action is link text on the hover and pressed fills.
  ...[surface('subtle'), '--button-pressed-background'].map((fill) => ({
    use: 'Tertiary button',
    foreground: property('color.text.linkHover'),
    background: fill,
    threshold: 4.5,
  })),
  // The Danger button (§4.6, the outline recipe): the danger text on its fill, hovered and pressed. On white it is the `danger text`
  // pairing below, and on its soft fill the `danger alert` pairing.
  {
    use: 'Danger button pressed',
    foreground: property('color.status.danger.foreground'),
    background: '--button-pressed-background',
    threshold: 4.5,
  },
  {
    use: 'inverse text',
    foreground: property('color.text.inverse'),
    background: surface('inverse'),
    threshold: 4.5,
  },
  {
    // The initials in the avatar of the account button of the top bar, when the button is hovered (`.ui-account:hover .ui-account__avatar` fills it
    // with `color.border.default`; at rest the fill is the selected surface, which the secondary text on `selected` above holds): 5.10 in the light
    // theme and 5.12 in the dark (review of 7 November 2026: the pairing was in no list).
    use: 'the initials of the account avatar when its button is hovered',
    foreground: property('color.text.secondary'),
    background: property('color.border.default'),
    threshold: 4.5,
  },
  ...(['success', 'warning', 'danger', 'info', 'neutral'] as const).map((status) => ({
    use: `${status} alert`,
    foreground: property(`color.status.${status}.foreground`),
    background: property(`color.status.${status}.background`),
    threshold: 4.5,
  })),
  ...(['success', 'danger'] as const).flatMap((status) =>
    (['default', 'page', 'raised'] as const).map((on) => ({
      use: `${status} text`,
      foreground: property(`color.status.${status}.foreground`),
      background: surface(on),
      threshold: 4.5,
    })),
  ),
  {
    use: 'danger text on the selected tint',
    foreground: property('color.status.danger.foreground'),
    background: surface('selected'),
    threshold: 4.5,
  },
  ...surfaces.flatMap((on) => [
    {
      use: 'focus ring',
      foreground: property('focus.ring'),
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
  ...(['default', 'page', 'raised', 'subtle'] as const).flatMap((on) => [
    {
      use: 'control boundary',
      foreground: property('color.border.control'),
      background: surface(on),
      threshold: 3,
    },
    {
      // The brand square that marks the active hub and the current step is a graphical cue.
      use: 'brand square',
      foreground: property('color.brand.default'),
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
  // The sidebar (§4.6): the item text on Ink, hovered and pressed, the current item, and the focus ring on each of them.
  ...(['text-muted', 'text-subtle'] as const).map((foreground) => ({
    use: `shell ${foreground}`,
    foreground: shell(foreground),
    background: surface('inverse'),
    threshold: 4.5,
  })),
  ...(['surface-hover', 'surface-pressed'] as const).flatMap((background) => [
    {
      use: `shell text on ${background}`,
      foreground: shell('text'),
      background: shell(background),
      threshold: 4.5,
    },
    {
      use: `shell muted text on ${background}`,
      foreground: shell('text-muted'),
      background: shell(background),
      threshold: 4.5,
    },
  ]),
  {
    use: 'shell subtle text on hover',
    foreground: shell('text-subtle'),
    background: shell('surface-hover'),
    threshold: 4.5,
  },
  ...(['active', 'active-hover'] as const).map((fill) => ({
    use: `shell current item ${fill}`,
    foreground: shell('active-text'),
    background: shell(fill),
    threshold: 4.5,
  })),
  ...(['surface-hover', 'surface-pressed', 'active', 'active-hover'] as const).map(
    (background) => ({
      use: `inverse focus ring on ${background}`,
      foreground: property('focus.ringInverse'),
      background: shell(background),
      threshold: 3,
    }),
  ),
  {
    use: 'selected row bar',
    foreground: property('color.action.primary'),
    background: surface('selected'),
    threshold: 3,
  },
];

describe('the pairings the components use', () => {
  for (const theme of THEMES) {
    it(`all meet their threshold, from the values in the token file (${theme} theme)`, () => {
      assert.deepEqual(failingPairings(PAIRINGS, tokenCss, theme), []);
    });
  }

  it('are numerous enough that the list was not emptied', () => {
    assert.ok(PAIRINGS.length >= 80, `pairings: ${String(PAIRINGS.length)}`);
  });

  // Break caught: a token change that quietly breaks a supported pairing. §4.6 says an unsupported one is not allowed. A change to the
  // light value must not be reported for the dark theme, nor the reverse: each theme is held on its own values.
  it('report a pairing that a changed token no longer meets, in the theme it was changed in', () => {
    const lighter = replaceProperty(tokenCss, property('color.text.muted'), '#98a2b3');
    assert.match(failingPairings(PAIRINGS, lighter).join('\n'), /muted text.*below 4\.5:1/);
    assert.deepEqual(failingPairings(PAIRINGS, lighter, 'dark'), []);

    const dimmer = replaceInBlock(
      replaceInBlock(tokenCss, DARK_ATTRIBUTE, property('color.text.muted'), '#4f586b'),
      DARK_MEDIA,
      property('color.text.muted'),
      '#4f586b',
    );
    assert.match(
      failingPairings(PAIRINGS, dimmer, 'dark').join('\n'),
      /muted text \(dark theme\).*below 4\.5:1/,
    );
    assert.deepEqual(failingPairings(PAIRINGS, dimmer, 'light'), []);
  });

  it('report a pairing that names a token the file does not define', () => {
    const problems = failingPairings(
      [{ use: 'x', foreground: '--no-such', background: surface('default'), threshold: 3 }],
      tokenCss,
    );
    assert.match(problems.join('\n'), /--no-such is not defined/);
  });
});

describe('the pill of a count on the current entry of the sidebar', () => {
  /** White at `alpha` laid over an opaque hex `fill`, as the browser composites it. */
  const whiteOver = (fill: string, alpha: number): string =>
    `#${[1, 3, 5]
      .map((at) => {
        const channel = Number.parseInt(fill.slice(at, at + 2), 16);
        return Math.round(255 * alpha + channel * (1 - alpha))
          .toString(16)
          .padStart(2, '0');
      })
      .join('')}`;

  // Break caught: the pill raised to the 22% of white that the first brief named. The white figure then measures 4.32:1 on the crimson, below the
  // 4.5:1 that text of that size needs (DESIGN_SYSTEM section 14), and axe fails it in a browser; the pill is the strongest white that passes.
  for (const theme of THEMES) {
    it(`keeps its white figure at 4.5:1 on both fills of the current entry (${theme} theme)`, () => {
      const properties = parseThemes(tokenCss)[theme];
      const pill = resolveProperty('--shell-active-badge', properties) ?? '';
      const alpha = Number(/\/\s*([\d.]+)\s*\)/.exec(pill)?.[1]);
      assert.ok(alpha > 0 && alpha < 1, `the pill is a white with an opacity: ${pill}`);
      const figure = resolveProperty('--shell-active-text', properties) ?? '';
      for (const fill of ['--shell-active', '--shell-active-hover']) {
        const ground = resolveProperty(fill, properties) ?? '';
        const ratio = contrastRatio(figure, whiteOver(ground, alpha));
        assert.ok(ratio >= 4.5, `${fill} with the pill is ${ratio.toFixed(2)}:1, below 4.5:1`);
      }
    });
  }

  // The reason for the deviation, kept where it can be checked: if the crimson ever changes so that 22% passes, this fails and the decision of
  // 6 November 2026 is to be looked at again.
  it('would not keep it at 22%, the opacity the first brief named', () => {
    const properties = parseThemes(tokenCss).light;
    const ground = resolveProperty('--shell-active', properties) ?? '';
    const figure = resolveProperty('--shell-active-text', properties) ?? '';

    assert.ok(contrastRatio(figure, whiteOver(ground, 0.22)) < 4.5);
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

  // Break caught: the review of 5edada2 (8 November 2026) asked that a heading that takes focus so that focus lands on what is new draw no ring, and that the date field draw one ring and
  // not two. Each is one named rule with its exact selector: the exception is neither a pattern that a control could fall under nor a rule that is missing from the styles it is named for.
  it('allow the named exceptions to the ring, by their exact selectors, and no rule like them', () => {
    const probe = (text: string): string[] => outlineRemovalProblems([{ path: 'a.css', text }]);
    const noRing = (selector: string): string => `${selector} { outline: none; box-shadow: none; }`;
    assert.equal(FOCUS_EXCEPTIONS.length, 2);
    for (const exception of FOCUS_EXCEPTIONS) {
      assert.deepEqual(probe(noRing(exception.selector)), [], exception.selector);
      assert.deepEqual(
        focusRulesWithoutOutline([{ path: 'a.css', text: noRing(exception.selector) }]),
        [],
        exception.selector,
      );
      assert.ok(exception.reason.length > 40, `${exception.selector} says why it is an exception`);
    }
    // What is not them: the same removal by another selector, for a heading with a class, a bare focus target, a control, or the heading rule with another state.
    for (const selector of [
      'h2:focus',
      "[tabindex='-1']:focus",
      '.ui-side-panel__heading:focus-visible',
      ":is(h1, h2, h3, h4, h5, h6)[tabindex='-1']:focus-visible",
      ":is(h1, h2)[tabindex='-1']:focus",
      '.ui-date-picker__button:focus-visible',
      '.ui-date-picker__input',
      '.ui-input:focus-visible',
    ]) {
      assert.equal(probe(noRing(selector)).length, 1, `${selector} is not an exception`);
    }
    // The exceptions are in the styles they are named for, so that one that has gone is not left allowed.
    const styles = applicationSources()
      .filter((file) => file.path.endsWith('.css'))
      .map((file) => file.text)
      .join('\n')
      .replace(/\s+/g, ' ');
    for (const exception of FOCUS_EXCEPTIONS) {
      assert.ok(
        styles.includes(`${exception.selector} {`),
        `no stylesheet has ${exception.selector}`,
      );
    }
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
    assert.deepEqual(unsafeStyleProblems(sources, TOKEN_FILE, documented, [TAILWIND_ENTRY]), []);
  });

  // Break caught: the one stylesheet that Tailwind builds from being held to the rule it cannot keep (its imports are packages, resolved by the
  // build, and the built stylesheet has none: test/build.test.ts), or, the other way, the exemption widening to a path, an address or any other file.
  it('let the Tailwind entry import packages, and nothing else import anything', () => {
    const probe = (text: string, path = TAILWIND_ENTRY): string[] =>
      unsafeStyleProblems([{ path, text }], TOKEN_FILE, [], [TAILWIND_ENTRY]);
    assert.equal(probe("@import 'tailwindcss/theme.css' layer(theme);").length, 0);
    assert.equal(
      probe("@import 'tailwindcss/utilities.css' layer(utilities) source(none);").length,
      0,
    );
    assert.equal(probe("@import 'tw-animate-css';").length, 0);
    assert.equal(probe('@import "@scope/package/styles.css";').length, 0);
    assert.equal(probe("@import './other.css';").length, 1);
    assert.equal(probe("@import '/other.css';").length, 1);
    assert.equal(probe("@import 'https://example.test/x.css';").length, 1);
    assert.equal(probe("@import '//example.test/x.css';").length, 1);
    assert.equal(probe("@import url('tailwindcss');").length, 1);
    assert.equal(probe("@import 'tw-animate-css'; a { color: red !important; }").length, 1);
    assert.equal(
      probe("@import 'tailwindcss/theme.css';", 'apps/ops-web/src/styles/other.css').length,
      1,
    );
    assert.equal(
      unsafeStyleProblems(
        [{ path: TAILWIND_ENTRY, text: "@import 'tw-animate-css';" }],
        TOKEN_FILE,
        [],
      ).length,
      1,
    );
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
