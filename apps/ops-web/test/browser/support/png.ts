import { crc32, deflateSync } from 'node:zlib';

/**
 * A photo that a browser can really decode and draw, made without a file on disk: a PNG of one opaque pixel. The photo kit's browser specs hand it to a file input (`setInputFiles`), because a preview that is drawn
 * on a canvas from the file can only be proved with a file that decodes: a made-up byte string would be refused by the decoder, and the proof would be that nothing was drawn. **The check of each chunk is the
 * platform's own CRC-32** (`zlib.crc32`), and `test/browser-support-png.test.ts` reads the bytes the way a decoder does: the first version computed the CRC by a table of its own and got it wrong, which a browser
 * answers by refusing the file (CI run 43884891843: the preview stayed blank).
 */
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const name = Buffer.from(type, 'latin1');
  const check = Buffer.alloc(4);
  check.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([length, name, data, check]);
}

/** The bytes of a 1 x 1 PNG whose one pixel is opaque and has the colour given (red, green, blue: 0 to 255). */
export function onePixelPng(red = 200, green = 48, blue = 32): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); // width
  header.writeUInt32BE(1, 4); // height
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: RGB
  // Compression, filter and interlace methods are 0, as the buffer starts.
  const row = Buffer.from([0, red, green, blue]); // filter type 0, then the pixel
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(row)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
