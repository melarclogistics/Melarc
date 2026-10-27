import type { Locator, Page } from '@playwright/test';

import { decodePixels } from '../../../src/test-support/qr-decode';

/**
 * What the browser painted for an element, decoded by the independent decoder (jsQR, a development dependency), in Node, from a screenshot. A
 * screenshot taken here is held in memory and written nowhere. The picture a camera would see is the one decoded, not the one the component meant
 * to draw.
 */
export async function decodePainted(page: Page, element: Locator): Promise<string | null> {
  const png = await element.screenshot();
  const painted = await page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('No canvas context.');
    context.drawImage(image, 0, 0);
    const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
    return { data: Array.from(data), width, height };
  }, png.toString('base64'));
  return decodePixels({
    data: Uint8ClampedArray.from(painted.data),
    width: painted.width,
    height: painted.height,
  });
}
