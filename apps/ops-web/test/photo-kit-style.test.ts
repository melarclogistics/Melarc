import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { after, ruleOf } from './support/css-rule';

const UI = join(resolve(import.meta.dirname, '..'), 'src', 'components', 'ui');
const css = (file: string): string => readFileSync(join(UI, file), 'utf8');

/**
 * The look of the rest of the photo kit (COMPONENT_PATTERNS, *PhotoViewer*, *ConnectionBanner*, *EvidenceUpload*; the grid's and the picture's are in `photo-grid-style.test.ts`): jsdom sees the class and not
 * the pixels, so the sheets are read here for what the behaviour depends on or the decisions name, and the showcase's browser spec measures what they draw.
 */
describe('the stylesheet of the wide dialog', () => {
  // Break caught: a photo shown whole in the 32rem window of a question, or a wide window that is wider than the screen on a phone.
  it('is 56rem and never wider than the screen', () => {
    expect(ruleOf(css('dialog/dialog.css'), '.ui-dialog--wide')).toMatch(
      /width:\s*min\(56rem,\s*calc\(100vw - 2 \* var\(--space-4\)\)\)\s*;/,
    );
  });

  // Break caught (the pictures of the receiving screens, defect 1): a window as tall as its content, which a photo shown whole makes as tall as the screen and more, so that its controls are reached by scrolling.
  // A window that fills is as tall as the screen lets it be (the same margin as every dialog's, and never taller than 56rem), and what is in it is a column that fills it, which may shrink to nothing.
  it('fills the height of the screen when it is asked to, and its content is a column that gives way', () => {
    const sheet = css('dialog/dialog.css');
    const window = ruleOf(sheet, '.ui-dialog--fill[open]');
    const panel = ruleOf(sheet, '.ui-dialog--fill .ui-dialog__panel');

    expect(window).toMatch(/display:\s*flex\s*;/);
    expect(window).toMatch(/flex-direction:\s*column\s*;/);
    expect(window).toMatch(/height:\s*min\(calc\(100dvh - 2 \* var\(--space-4\)\),\s*56rem\)\s*;/);
    expect(panel).toMatch(/display:\s*flex\s*;/);
    expect(panel).toMatch(/flex-direction:\s*column\s*;/);
    expect(panel).toMatch(/flex:\s*1 1 auto\s*;/);
    expect(panel).toMatch(/min-height:\s*0\s*;/);
  });
});

describe('the stylesheet of the photo viewer', () => {
  const sheet = css('photo-viewer/photo-viewer.css');

  // Break caught (Run G2, the viewer's zoom and turn; before it the stage left the vertical scroll to the browser, `pan-y`): a stage that leaves a gesture to the browser, so that a pinch zooms the page behind the viewer
  // and not the photo, a drag scrolls the page and never looks around a zoomed photo, and a double tap zooms the page. The stage is the whole of the viewer's room and has nothing to scroll.
  it('gives every touch on the stage to the viewer: the pinch, the drag and the double tap', () => {
    expect(ruleOf(sheet, '.ui-photo-viewer__stage')).toMatch(/touch-action:\s*none\s*;/);
  });

  // Break caught: a change of photo that moves by a duration or an easing of its own, or the wrong way (a photo that comes in from the side it is going to).
  it('brings the next photo in from the right and the previous one from the left, on the tokens', () => {
    const next = ruleOf(sheet, ".ui-photo-viewer__photo[data-way='next']");
    const previous = ruleOf(sheet, ".ui-photo-viewer__photo[data-way='previous']");

    expect(next).toMatch(
      /animation:\s*ui-photo-viewer-next var\(--motion-fast\) var\(--motion-ease-enter\)\s*;/,
    );
    expect(previous).toMatch(
      /animation:\s*ui-photo-viewer-previous var\(--motion-fast\) var\(--motion-ease-enter\)\s*;/,
    );
    expect(sheet).toMatch(
      /@keyframes ui-photo-viewer-next\s*\{\s*from\s*\{[^}]*translateX\(var\(--space-4\)\)/,
    );
    expect(sheet).toMatch(
      /@keyframes ui-photo-viewer-previous\s*\{\s*from\s*\{[^}]*translateX\(calc\(-1 \* var\(--space-4\)\)\)/,
    );
  });

  // Break caught: a viewer that still animates when the person asked for less motion.
  it('does not animate a change of photo for a person who asks for less motion', () => {
    const reduced = after(sheet, '@media (prefers-reduced-motion: reduce)');

    expect(reduced).toBeDefined();
    expect(ruleOf(reduced ?? '', ".ui-photo-viewer__photo[data-way='next']")).toMatch(
      /animation:\s*none\s*;/,
    );
    expect(ruleOf(reduced ?? '', ".ui-photo-viewer__photo[data-way='previous']")).toMatch(
      /animation:\s*none\s*;/,
    );
  });

  // Break caught (the pictures of the receiving screens, defect 1): a viewer as tall as its content, so that at 1280 x 800 the controls began below the screen and the viewer went back to the top after every Next.
  // The viewer is a column in a window of a height of its own: the photo's stage is the part that gives way (a basis of nothing, and it may shrink to nothing), and the controls are the part that does not.
  it('is a column whose stage takes the room that the controls leave, and gives way to them', () => {
    const root = ruleOf(sheet, '.ui-photo-viewer');
    const stage = ruleOf(sheet, '.ui-photo-viewer__stage');
    const controls = ruleOf(sheet, '.ui-photo-viewer__controls');

    expect(root).toMatch(/display:\s*flex\s*;/);
    expect(root).toMatch(/flex-direction:\s*column\s*;/);
    expect(root).toMatch(/flex:\s*1 1 auto\s*;/);
    expect(root).toMatch(/min-height:\s*0\s*;/);
    expect(stage).toMatch(/flex:\s*1 1 0\s*;/);
    expect(stage).toMatch(/min-height:\s*0\s*;/);
    expect(stage).toMatch(/position:\s*relative\s*;/);
    expect(controls).toMatch(/flex:\s*none\s*;/);
  });

  // Break caught: a photo that is laid out by what it is (its own height, the page's 70vh) and not by the room it is given: the photo's box fills the stage, and what the page draws in it is a column whose first child,
  // the picture, takes the room that is left and whose others, a button of the page's, keep their size. The picture is told how much room it has (`--ui-photo-room`), which is the whole of its box here.
  it('gives the picture of a photo the room that is left, and the page’s button under it its own size', () => {
    const photo = ruleOf(sheet, '.ui-photo-viewer__photo');
    const first = ruleOf(sheet, '.ui-photo-viewer__photo > :first-child');
    const others = ruleOf(sheet, '.ui-photo-viewer__photo > :not(:first-child)');

    expect(photo).toMatch(/position:\s*absolute\s*;/);
    expect(photo).toMatch(/inset:\s*0\s*;/);
    expect(photo).toMatch(/display:\s*flex\s*;/);
    expect(photo).toMatch(/flex-direction:\s*column\s*;/);
    expect(photo).toMatch(/--ui-photo-room:\s*100%\s*;/);
    expect(first).toMatch(/flex:\s*1 1 0\s*;/);
    expect(first).toMatch(/min-height:\s*0\s*;/);
    expect(first).toMatch(/display:\s*flex\s*;/);
    expect(first).toMatch(/flex-direction:\s*column\s*;/);
    expect(first).toMatch(/align-items:\s*center\s*;/);
    expect(first).toMatch(/justify-content:\s*center\s*;/);
    expect(first).toMatch(/width:\s*100%\s*;/);
    expect(others).toMatch(/flex:\s*none\s*;/);
  });

  // Break caught (defect 11): Previous alone on a row at 390 px, with the place under it and Next and Close sharing the next: Previous, the place and Next are one row that does not break, and Close is a control of its
  // own that wraps to its own row where the row of the other three leaves it no room, and sits at the end of the same row where there is room.
  it('puts previous, the place and next in one row, and wraps close apart from it', () => {
    const controls = ruleOf(sheet, '.ui-photo-viewer__controls');
    const nav = ruleOf(sheet, '.ui-photo-viewer__nav');
    const position = ruleOf(sheet, '.ui-photo-viewer__position');

    expect(controls).toMatch(/display:\s*flex\s*;/);
    expect(controls).toMatch(/flex-wrap:\s*wrap\s*;/);
    expect(controls).toMatch(/align-items:\s*center\s*;/);
    expect(controls).toMatch(/gap:\s*var\(--space-3\)\s*;/);
    expect(nav).toMatch(/display:\s*flex\s*;/);
    expect(nav).not.toMatch(/flex-wrap/);
    expect(nav).toMatch(/flex:\s*1 1 18rem\s*;/);
    expect(nav).toMatch(/align-items:\s*center\s*;/);
    expect(nav).toMatch(/gap:\s*var\(--space-3\)\s*;/);
    expect(position).toMatch(/flex:\s*1 1 auto\s*;/);
  });

  // Break caught: two buttons that say "Previous photo" and "Next photo" in full beside the place, which do not fit in the 326 px of a 390 px phone (nor the 296 px of a 360 px one); they keep the floor's target
  // (56 px high, and at least as wide), a padding that leaves the room, and where even that is too much (a phone of 320 px) they show their icon and are named in full by their label.
  it('keeps the floor’s target on the two buttons that move, with less padding, and only their icons on the narrowest phone', () => {
    const buttons = ruleOf(sheet, '.ui-photo-viewer__nav .ui-button');
    const narrow = after(sheet, '@media (max-width: 22.5rem)');

    expect(buttons).toMatch(/min-width:\s*var\(--control-height-lg\)\s*;/);
    expect(buttons).toMatch(/padding-inline:\s*var\(--space-4\)\s*;/);
    expect(narrow).toBeDefined();
    expect(ruleOf(narrow ?? '', '.ui-photo-viewer__label')).toMatch(/display:\s*none\s*;/);
  });

  // Break caught: the place ("3 of 12") drawn at the edge or in a colour the tokens do not own.
  it('says where the person is, centred, in the secondary text', () => {
    const position = ruleOf(sheet, '.ui-photo-viewer__position');

    expect(position).toMatch(/text-align:\s*center\s*;/);
    expect(position).toMatch(/color:\s*var\(--color-text-secondary\)\s*;/);
  });
});

describe('the stylesheet of the connection banner', () => {
  const sheet = css('connection-banner/connection-banner.css');
  const message = ruleOf(sheet, '.ui-connection-banner__message');

  // Break caught: a banner in a colour that is not the warning tokens' (and so has no dark form), or one whose words have no background of their own.
  it('is drawn in the warning status tokens, which have their dark form', () => {
    expect(message).toMatch(/background:\s*var\(--color-status-warning-background\)\s*;/);
    expect(message).toMatch(/color:\s*var\(--color-status-warning-foreground\)\s*;/);
    expect(message).toMatch(/border:\s*1px solid var\(--color-status-warning-border\)\s*;/);
  });

  // Break caught: a banner that is a layer over the page (fixed, absolute or sticky), which can cover what a person is typing into, instead of a line of the page.
  it('is a line of the page and never a layer over it', () => {
    // What the sheet says, and not what its comments say (they name the very things it does not do).
    const code = sheet.replace(/\/\*[\s\S]*?\*\//g, '');

    expect(message).not.toMatch(/position\s*:/);
    expect(code).not.toMatch(/position\s*:\s*(?:fixed|absolute|sticky)/);
    expect(code).not.toMatch(/z-index/);
  });

  // Break caught: an icon that sits above the words, or words that are not centred on it.
  it('puts the icon beside the words', () => {
    expect(message).toMatch(/display:\s*flex\s*;/);
    expect(message).toMatch(/align-items:\s*center\s*;/);
    expect(message).toMatch(/gap:\s*var\(--space-2\)\s*;/);
  });

  // Break caught: a banner that forced colours leave without a border, once the fill is dropped.
  it('has a border of its own when colours are forced', () => {
    const forced = after(sheet, '@media (forced-colors: active)');

    expect(forced).toBeDefined();
    expect(ruleOf(forced ?? '', '.ui-connection-banner__message')).toMatch(
      /border-color:\s*CanvasText\s*;/,
    );
  });
});

describe('the stylesheet of the evidence upload’s photo mode', () => {
  const sheet = css('evidence-upload/evidence-upload.css');

  // Break caught: two floor buttons that cannot wrap on a phone, or that touch.
  it('puts the two ways in side by side, wrapping, with room between them', () => {
    const sources = ruleOf(sheet, '.ui-evidence-upload__sources');

    expect(sources).toMatch(/display:\s*flex\s*;/);
    expect(sources).toMatch(/flex-wrap:\s*wrap\s*;/);
    expect(sources).toMatch(/gap:\s*var\(--space-3\)\s*;/);
  });

  // Break caught: a preview whose size follows the photo (a column of rows of different heights), or one that stretches the photo instead of cropping it.
  it('shows each photo back in a square of one size, cropped to it, beside its words', () => {
    const preview = ruleOf(sheet, '.ui-evidence-upload__preview');
    const row = ruleOf(sheet, '.ui-evidence-upload__file--photo');

    expect(preview).toMatch(/width:\s*5rem\s*;/);
    expect(preview).toMatch(/height:\s*5rem\s*;/);
    expect(preview).toMatch(/object-fit:\s*cover\s*;/);
    expect(preview).toMatch(/flex:\s*none\s*;/);
    expect(row).toMatch(/display:\s*flex\s*;/);
    expect(row).toMatch(/gap:\s*var\(--space-3\)\s*;/);
  });

  // Break caught: the words of a photo that cannot shrink beside its preview (a long failure that pushes the row off the screen).
  it('lets the words beside a preview shrink and wrap', () => {
    const details = ruleOf(sheet, '.ui-evidence-upload__details');

    expect(details).toMatch(/min-width:\s*0\s*;/);
    expect(details).toMatch(/flex:\s*1 1 auto\s*;/);
  });

  // Break caught: the gate's words drawn with a margin that pushes the submit away, or in a colour the tokens do not own.
  it('draws the gate’s words as a quiet line of the page', () => {
    const words = ruleOf(sheet, '.ui-evidence-upload__gate p');

    expect(words).toMatch(/margin:\s*0\s*;/);
    expect(words).toMatch(/color:\s*var\(--color-text-secondary\)\s*;/);
  });
});
