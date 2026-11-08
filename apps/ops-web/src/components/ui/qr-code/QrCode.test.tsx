import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { decodePixels, decodeRenderedSvg, rasteriseQrSvg } from '../../../test-support/qr-decode';
import { wcagViolations } from '../../../test-support/wcag';
import { QrCode } from './QrCode';
import { QR_QUIET_ZONE } from './qr-matrix';

const LABEL = 'QR code for your authenticator app';

/** A provisioning URI of the length the plan names for the Rider enrolment payload: 127 characters. */
const PAYLOAD_127 = `otpauth://totp/Melarc:${'a'.repeat(41)}?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Melarc&period=30`;

const TOTP_URI =
  'otpauth://totp/Melarc:ama.mensah%40melarc.example?secret=JBSWY3DPEHPK3PXP&issuer=Melarc&algorithm=SHA1&digits=6&period=30';

function svgOf(container: HTMLElement): SVGSVGElement {
  const svg = container.querySelector('svg');
  if (svg === null) throw new Error('No SVG was rendered.');
  return svg;
}

describe('QrCode: the output is a code that an independent decoder reads', () => {
  // Break caught: the encoder, or our drawing of its matrix, producing something that looks like a code and is not one:
  // transposed, mirrored, shifted by a module, or with a format that no scanner reads. A decoder written by someone else
  // reads the picture, and what it finds must be the whole payload, character for character.
  it.each([
    ['a TOTP provisioning URI', TOTP_URI],
    ['the 127-character enrolment payload', PAYLOAD_127],
    ['a short text', 'hello'],
    ['text with characters outside ASCII', 'Melarc Logistics · Accra · Ghana · café'],
  ])('decodes %s from the picture, in full', (_label, payload) => {
    const { container } = render(<QrCode payload={payload} label={LABEL} />);

    expect(decodeRenderedSvg(svgOf(container))).toBe(payload);
  });

  it.each(['L', 'M', 'Q', 'H'] as const)('decodes at error correction %s', (level) => {
    const { container } = render(
      <QrCode payload={TOTP_URI} label={LABEL} errorCorrection={level} />,
    );

    expect(decodeRenderedSvg(svgOf(container))).toBe(TOTP_URI);
  });

  it('is 127 characters of payload', () => {
    expect(PAYLOAD_127).toHaveLength(127);
  });

  // Break caught: the decoder agreeing with anything. If it reads a picture with a module changed, or a different picture,
  // as the original, the check above proves nothing.
  it('is not fooled: a picture with modules flipped does not decode to the payload', () => {
    const { container } = render(<QrCode payload={TOTP_URI} label={LABEL} />);
    const pixels = rasteriseQrSvg(svgOf(container));
    const scale = 6;
    // Whiten the whole top-left finder pattern: a code without one of its three finders cannot be located.
    for (let row = 0; row < 7 * scale; row += 1) {
      for (let column = 0; column < 7 * scale; column += 1) {
        const at =
          ((QR_QUIET_ZONE * scale + row) * pixels.width + QR_QUIET_ZONE * scale + column) * 4;
        pixels.data[at] = 255;
        pixels.data[at + 1] = 255;
        pixels.data[at + 2] = 255;
      }
    }

    expect(decodePixels(pixels)).not.toBe(TOTP_URI);
  });

  it('is not fooled: another payload decodes to that payload and not this one', () => {
    const { container } = render(<QrCode payload="another payload" label={LABEL} />);

    expect(decodeRenderedSvg(svgOf(container))).not.toBe(TOTP_URI);
  });
});

describe('QrCode: the picture', () => {
  // Break caught: a quiet zone narrower than the four modules the standard requires, which scanners refuse or read badly
  // when the code sits against a busy edge.
  it('has a quiet zone of four modules of background on every side', () => {
    const { container } = render(<QrCode payload={TOTP_URI} label={LABEL} />);
    const svg = svgOf(container);
    const pixels = rasteriseQrSvg(svg, 1);

    const dark = (column: number, row: number): boolean =>
      pixels.data[(row * pixels.width + column) * 4] === 0;
    let first = pixels.width;
    let last = 0;
    for (let row = 0; row < pixels.height; row += 1) {
      for (let column = 0; column < pixels.width; column += 1) {
        if (!dark(column, row)) continue;
        first = Math.min(first, column, row);
        last = Math.max(last, column, row);
      }
    }
    expect(first).toBe(QR_QUIET_ZONE);
    expect(pixels.width - 1 - last).toBe(QR_QUIET_ZONE);
  });

  it('has a quiet zone constant of four modules', () => {
    expect(QR_QUIET_ZONE).toBe(4);
  });

  // Break caught: a code drawn smaller than a handset's camera can resolve. Four pixels to a module is the smallest the
  // component draws, so the 127-character payload (version 8 at error correction M, 49 modules, 57 with the quiet zone) is
  // 228 pixels wide.
  it('is drawn at least four pixels to a module, and large enough to scan', () => {
    const { container } = render(<QrCode payload={PAYLOAD_127} label={LABEL} />);
    const svg = svgOf(container);
    const modules = Number(svg.getAttribute('viewBox')?.split(' ')[2]);

    expect(Number(svg.getAttribute('width'))).toBeGreaterThanOrEqual(modules * 4);
    expect(Number(svg.getAttribute('width'))).toBeGreaterThanOrEqual(180);
    expect(svg.getAttribute('width')).toBe(svg.getAttribute('height'));
  });

  // Break caught: a stretched code (modules are square), or a viewBox that does not match the drawing.
  it('draws square modules: the viewBox is a square and the picture is as tall as it is wide', () => {
    const { container } = render(<QrCode payload={TOTP_URI} label={LABEL} />);
    const svg = svgOf(container);
    const [x, y, width, height] = (svg.getAttribute('viewBox') ?? '').split(' ').map(Number);

    expect([x, y]).toEqual([0, 0]);
    expect(width).toBe(height);
    expect(svg.getAttribute('preserveAspectRatio')).toBe('xMidYMid meet');
  });

  it('draws a light background over the whole picture, so the quiet zone is light on any page', () => {
    const { container } = render(<QrCode payload={TOTP_URI} label={LABEL} />);
    const background = container.querySelector('rect.ui-qr__background');
    const viewBox = svgOf(container).getAttribute('viewBox') ?? '';

    expect(background).not.toBeNull();
    expect(
      `0 0 ${background?.getAttribute('width') ?? ''} ${background?.getAttribute('height') ?? ''}`,
    ).toBe(viewBox);
  });
});

describe('QrCode: what it exposes', () => {
  // Break caught: the payload written into the page as text, an attribute, a title or a link. The payload is a bearer
  // credential; the picture is the only form of it on the screen, and the picture is what a camera reads.
  it('has the payload nowhere in the page as text: not in a name, a title, an attribute or a link', () => {
    const { container } = render(<QrCode payload={TOTP_URI} label={LABEL} />);

    expect(container.textContent).not.toContain('otpauth');
    expect(container.textContent).not.toContain('JBSWY3DP');
    const attributes = [...container.querySelectorAll('*')].flatMap((element) =>
      [...element.attributes].map((attribute) => attribute.value),
    );
    expect(attributes.join('\n')).not.toMatch(/otpauth|JBSWY3DP|melarc\.example/);
    expect(
      container.querySelector(
        'a, [href], [xlink\\:href], title, desc, image, use, foreignObject, script',
      ),
    ).toBeNull();
  });

  // Break caught: a code with no accessible name, or one a screen reader reads out as a string of shapes.
  it('is an image with the name it is given, and its parts are hidden from assistive technology', () => {
    render(<QrCode payload={TOTP_URI} label={LABEL} />);

    const image = screen.getByRole('img', { name: LABEL });
    expect(image.tagName.toLowerCase()).toBe('svg');
    expect(image.querySelectorAll('[role="img"]')).toHaveLength(0);
  });

  it('is not keyboard focusable: a picture is not a control', () => {
    const { container } = render(<QrCode payload={TOTP_URI} label={LABEL} />);

    expect(svgOf(container).getAttribute('focusable')).toBe('false');
    expect(svgOf(container)).not.toHaveAttribute('tabindex');
  });

  it('has no WCAG 2.1 A or AA violations that can be checked without a layout engine', async () => {
    const { container } = render(<QrCode payload={TOTP_URI} label={LABEL} />);

    expect(await wcagViolations(container)).toEqual([]);
  });
});

describe('QrCode: what it refuses', () => {
  // Break caught: a code that is silently blank or wrong because the payload could not be encoded. A screen that cannot
  // show the code must say so; it must not show nothing, or a code for something else.
  it.each([
    ['an empty payload', ''],
    ['a payload too long to draw at a size a camera can read', 'x'.repeat(3000)],
  ])(
    'throws for %s, so that the screen shows its error state and not an empty picture',
    (_label, payload) => {
      expect(() => render(<QrCode payload={payload} label={LABEL} />)).toThrow(/QR/i);
    },
  );
});
