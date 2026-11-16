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
});

describe('the stylesheet of the photo viewer', () => {
  const sheet = css('photo-viewer/photo-viewer.css');

  // Break caught: a stage that takes the vertical scroll away from the browser (a photo that cannot be scrolled past on a phone), or one that leaves a drag across to the browser (a swipe that never arrives).
  it('leaves the vertical scroll to the browser and the drag across to the swipe', () => {
    expect(ruleOf(sheet, '.ui-photo-viewer__stage')).toMatch(/touch-action:\s*pan-y\s*;/);
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

  // Break caught: three floor buttons that run off a phone's width instead of wrapping.
  it('lets its buttons wrap on a narrow screen, with room between them', () => {
    const actions = ruleOf(sheet, '.ui-photo-viewer__actions');

    expect(actions).toMatch(/display:\s*flex\s*;/);
    expect(actions).toMatch(/flex-wrap:\s*wrap\s*;/);
    expect(actions).toMatch(/gap:\s*var\(--space-3\)\s*;/);
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
