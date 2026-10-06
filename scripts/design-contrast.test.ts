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

  // Break caught: a check that passes because it found nothing to check.
  it('check the whole of §4.5 and §4.6', () => {
    const { checked } = checkDesignContrast(document);
    assert.equal(checked.baseline, 9, 'the nine pairs of §4.5');
    // Text: 6 rows by 5 surfaces; control boundary: 4 by 4; focus: 2 by 5.
    assert.equal(checked.matrixCells, 6 * 5 + 4 * 4 + 2 * 5);
    assert.equal(checked.matrices, 3, 'text, control boundary and focus');
    assert.ok(checked.tokens >= 40, 'the token values of §4.2 and §4.3');
    assert.ok(checked.colours >= 30, 'the colours defined in §4.2 to §4.4');
  });

  // Each change below is a single wrong figure that a tired edit could make; every one must be reported.
  const tampered: [description: string, find: string, replace: string][] = [
    [
      'a ratio in the baseline table',
      '| `#667085` | `#FFFFFF` | 4.97:1 |',
      '| `#667085` | `#FFFFFF` | 4.98:1 |',
    ],
    [
      'a colour in the baseline table',
      '| `#667085` | `#FFFFFF` | 4.97:1 |',
      '| `#667086` | `#FFFFFF` | 4.97:1 |',
    ],
    [
      'a ratio in the text matrix',
      '| `text.muted` `#667085` | 4.97 |',
      '| `text.muted` `#667085` | 4.96 |',
    ],
    ['a fail mark dropped', '✗ 4.32', '4.32'],
    ['a pass shown as a fail', '| 4.68 thin |', '| ✗ 4.68 |'],
    ['a thin flag dropped', '4.51 thin', '4.51'],
    [
      'a thin flag added to a wide margin',
      '| `text.link` `#971B26` | 8.40 |',
      '| `text.link` `#971B26` | 8.40 thin |',
    ],
    [
      'a foreground colour in a matrix row',
      '| `text.muted` `#667085` |',
      '| `text.muted` `#667086` |',
    ],
    [
      'a surface colour in a matrix header',
      '`surface.selected` `#FCEBED`',
      '`surface.selected` `#FCEBEE`',
    ],
    [
      'a token value in §4.3',
      '| `color.text.muted` | `#667085` |',
      '| `color.text.muted` | `#667086` |',
    ],
    [
      'a border ratio',
      '| `border.control` `#7C879B` | 3.62 |',
      '| `border.control` `#7C879B` | 3.63 |',
    ],
    ['a focus ratio', '| `focus.ring` `#2563A6` | 6.15 |', '| `focus.ring` `#2563A6` | 6.16 |'],
  ];
  for (const [description, find, replace] of tampered) {
    it(`reports ${description}`, () => {
      assert.equal(document.split(find).length - 1, 1, `the probe text must occur once: ${find}`);
      const { problems } = checkDesignContrast(document.replace(find, replace));
      assert.ok(problems.length > 0, 'the change went unnoticed');
    });
  }

  it('reports a document with no tables rather than passing', () => {
    const { problems } = checkDesignContrast('# Nothing here\n');
    assert.ok(problems.length > 0);
  });
});
