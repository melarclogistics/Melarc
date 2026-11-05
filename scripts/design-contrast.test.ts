import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

import { checkDesignContrast, contrastRatio } from './design-contrast.ts';

/**
 * The colour tables in design/DESIGN_SYSTEM.md are numbers an implementation will encode, so they are held to the
 * hex values they name: a ratio, a pass or fail mark and a "thin" flag that do not follow from the colours fail
 * here. Only the tables are checked; the sentences around them quote the same figures and are reviewed with them.
 */
const root = resolve(import.meta.dirname, '..');
const document = readFileSync(join(root, 'design', 'DESIGN_SYSTEM.md'), 'utf8');

describe('contrastRatio', () => {
  // Known values from the WCAG definition: black on white is 21:1, a colour on itself is 1:1.
  it('follows the WCAG relative-luminance definition', () => {
    assert.equal(contrastRatio('#000000', '#FFFFFF'), 21);
    assert.equal(contrastRatio('#FFFFFF', '#000000'), 21);
    assert.equal(contrastRatio('#777777', '#777777'), 1);
    assert.equal(contrastRatio('#767676', '#FFFFFF').toFixed(2), '4.54');
    // 4.6075 exactly: 1.05 / (0.1779 + 0.05).
    assert.equal(contrastRatio('#757575', '#FFFFFF').toFixed(2), '4.61');
  });

  it('reads lower-case hex the same as upper-case', () => {
    assert.equal(contrastRatio('#b4232e', '#ffffff'), contrastRatio('#B4232E', '#FFFFFF'));
  });

  it('refuses anything that is not a six-digit hex colour', () => {
    for (const bad of ['#FFF', 'FFFFFF', '#GGGGGG', '#FFFFFFF', '']) {
      assert.throws(() => contrastRatio(bad, '#000000'), /hex/);
    }
  });
});

describe('the Design System contrast tables', () => {
  it('match the colours they name', () => {
    const { problems } = checkDesignContrast(document);
    assert.deepEqual(problems, []);
  });

  // Break caught: a check that passes because it found nothing to check, or because one theme was left out.
  it('check the whole of §4.5 and §4.6, for both themes', () => {
    const { checked } = checkDesignContrast(document);
    assert.equal(checked.baseline, 18, 'the nine pairs of §4.5 for each theme');
    // Per theme, text: 6 rows by 6 surfaces; control boundary: 4 by 5; focus: 2 by 6.
    assert.equal(checked.matrixCells, 2 * (6 * 6 + 4 * 5 + 2 * 6));
    assert.equal(checked.matrices, 6, 'text, control boundary and focus, for each theme');
    assert.ok(checked.tokens >= 60, 'the token values of §4.2 to §4.4');
    assert.ok(checked.colours >= 60, 'the colours defined in §4.2 to §4.4, both themes');
  });

  // Each change below is a single wrong figure that a tired edit could make; every one must be reported. A probe that names a
  // table header occurs in several tables: the first occurrence is the one changed.
  const tampered: [description: string, find: string, replace: string, repeats?: true][] = [
    [
      'a ratio in the light baseline table',
      '| `#626B81` | `#FFFFFF` | 5.33:1 |',
      '| `#626B81` | `#FFFFFF` | 5.34:1 |',
    ],
    [
      'a colour in the light baseline table',
      '| `#626B81` | `#FFFFFF` | 5.33:1 |',
      '| `#626B82` | `#FFFFFF` | 5.33:1 |',
    ],
    [
      'a ratio in the dark baseline table',
      '| `#F04B59` | `#10151F` | 5.10:1 |',
      '| `#F04B59` | `#10151F` | 5.11:1 |',
    ],
    [
      'a ratio in the light text matrix',
      '| `text.muted` `#626B81` | 5.33 |',
      '| `text.muted` `#626B81` | 5.32 |',
    ],
    [
      'a ratio in the dark text matrix',
      '| `text.muted` `#8E98AC` | 6.30 |',
      '| `text.muted` `#8E98AC` | 6.31 |',
    ],
    ['a fail mark dropped', '✗ 4.22', '4.22'],
    ['a pass shown as a fail', '| 4.67 thin |', '| ✗ 4.67 |'],
    ['a thin flag dropped', '4.57 thin', '4.57'],
    [
      'a thin flag added to a wide margin',
      '| `text.linkHover` `#BE1E2D` | 6.15 |',
      '| `text.linkHover` `#BE1E2D` | 6.15 thin |',
    ],
    [
      'a foreground colour in a matrix row',
      '| `text.muted` `#626B81` |',
      '| `text.muted` `#626B82` |',
    ],
    [
      'a surface colour in a matrix header',
      '`surface.selected` `#E2E5EB`',
      '`surface.selected` `#E2E5EC`',
      true,
    ],
    [
      'a dark surface colour in a matrix header',
      '`surface.selected` `#16202F`',
      '`surface.selected` `#16202E`',
      true,
    ],
    [
      'a light token value in §4.3',
      '| `color.text.muted` | `#626B81` | `#8E98AC` |',
      '| `color.text.muted` | `#626B82` | `#8E98AC` |',
    ],
    [
      'a dark token value in §4.3',
      '| `color.text.muted` | `#626B81` | `#8E98AC` |',
      '| `color.text.muted` | `#626B81` | `#8E98AD` |',
    ],
    [
      'a border ratio',
      '| `border.control` `#7C859A` | 3.70 |',
      '| `border.control` `#7C859A` | 3.71 |',
    ],
    ['a focus ratio', '| `focus.ring` `#2563A6` | 6.15 |', '| `focus.ring` `#2563A6` | 6.16 |'],
    ['a theme left out', '### Text on surfaces, dark theme', '### Text on surfaces, night theme'],
  ];
  for (const [description, find, replace, repeats] of tampered) {
    it(`reports ${description}`, () => {
      if (repeats !== true) {
        assert.equal(document.split(find).length - 1, 1, `the probe text must occur once: ${find}`);
      }
      assert.ok(document.includes(find), `the probe text must occur: ${find}`);
      const { problems } = checkDesignContrast(document.replace(find, replace));
      assert.ok(problems.length > 0, 'the change went unnoticed');
    });
  }

  it('reports a document with no tables rather than passing', () => {
    const { problems } = checkDesignContrast('# Nothing here\n');
    assert.ok(problems.length > 0);
  });
});
