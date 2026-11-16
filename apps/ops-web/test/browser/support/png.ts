import { deflateSync } from 'node:zlib';

/**
 * A photo that a browser can really decode and draw, made without a file on disk: a PNG of one opaque pixel. The photo kit's browser specs hand it to a file input (`setInputFiles`), because a preview that is drawn
 * on a canvas from the file can only be proved with a file that decodes: a made-up byte string would be refused by the decoder, and the proof would be that nothing was drawn.
 */
const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value % 2 === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const name = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([length, name, data, crc]);
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
