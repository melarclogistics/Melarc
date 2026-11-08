import jsQR from 'jsqr';

/**
 * The independent decoder of the QR evidence (plan S0.39c, SLICE-000-FINAL-DECISIONS section 14): a decoder written by
 * someone else (jsQR) reads what was *drawn*, not what the encoder meant to draw. It is test-only; nothing in the
 * application imports it, and the dependency is a devDependency.
 *
 * Two entry points: {@link decodePixels} for pixels a browser painted, and {@link decodeRenderedSvg} for the SVG the
 * component renders, which is read back from its own path (the only thing a screen would show) and rasterised here.
 */

export interface Pixels {
  /** RGBA, row by row. */
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

/** The text of the code in the image, or null if the decoder found no code or could not read it. */
export function decodePixels(pixels: Pixels): string | null {
  // `inversionAttempts: 'dontInvert'`: a code is dark on light, and a decoder that also reads light on dark would say
  // yes to a code a real scanner may refuse.
  const found = jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: 'dontInvert' });
  return found === null ? null : found.data;
}

interface Run {
  readonly x: number;
  readonly y: number;
  readonly length: number;
}

/** Reads the runs of dark modules out of the component's path: `M x,y h n v 1 h -n z`, repeated. */
function runsOf(path: string): Run[] {
  const runs: Run[] = [];
  const segment = /M(\d+),(\d+)h(\d+)v1h-\d+z/gy;
  let match: RegExpExecArray | null;
  let consumed = 0;
  while ((match = segment.exec(path)) !== null) {
    runs.push({ x: Number(match[1]), y: Number(match[2]), length: Number(match[3]) });
    consumed = segment.lastIndex;
  }
  if (consumed !== path.length)
    throw new Error('The QR path is not made of the runs the component draws.');
  return runs;
}

/** Rasterises the SVG of a `QrCode`: white background, black modules, `scale` pixels to a module. */
export function rasteriseQrSvg(svg: SVGSVGElement, scale = 6): Pixels {
  const viewBox = svg.getAttribute('viewBox')?.split(' ').map(Number);
  const [x0, y0, size, height] = viewBox ?? [];
  if (x0 !== 0 || y0 !== 0 || size === undefined || size !== height) {
    throw new Error('The QR viewBox is not a square from the origin.');
  }
  const path = svg.querySelector('path')?.getAttribute('d');
  if (path === null || path === undefined) throw new Error('The QR has no modules.');

  const width = size * scale;
  const data = new Uint8ClampedArray(width * width * 4).fill(255);
  for (const run of runsOf(path)) {
    for (let row = run.y * scale; row < (run.y + 1) * scale; row += 1) {
      for (let column = run.x * scale; column < (run.x + run.length) * scale; column += 1) {
        const at = (row * width + column) * 4;
        data[at] = 0;
        data[at + 1] = 0;
        data[at + 2] = 0;
      }
    }
  }
  return { data, width, height: width };
}

export function decodeRenderedSvg(svg: SVGSVGElement, scale = 6): string | null {
  return decodePixels(rasteriseQrSvg(svg, scale));
}
