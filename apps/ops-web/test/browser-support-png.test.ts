import { crc32, inflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { onePixelPng } from './browser/support/png';

/**
 * The photo the browser specs hand to a file input (`test/browser/support/png.ts`): a PNG of one opaque pixel, made in the test. **A preview drawn from the file is proved only by a file that decodes**, and a browser's
 * decoder refuses a PNG whose chunk fails its check (a wrong CRC): the CI run of the photo kit's specs found the preview blank because the first version of this file computed the CRC with a table whose parity test
 * was wrong for a negative number (`-3 % 2` is `-1`, not `1`). This reads the bytes the way a decoder does, with the CRC of the platform's own `zlib`, so that the bytes are right before a browser is asked.
 */
interface Chunk {
  readonly type: string;
  readonly data: Buffer;
  readonly crc: number;
}

function chunksOf(png: Buffer): { readonly signature: Buffer; readonly chunks: Chunk[] } {
  const chunks: Chunk[] = [];
  let at = 8;
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const type = png.subarray(at + 4, at + 8).toString('latin1');
    const data = png.subarray(at + 8, at + 8 + length);
    chunks.push({ type, data, crc: png.readUInt32BE(at + 8 + length) });
    at += 12 + length;
  }
  return { signature: png.subarray(0, 8), chunks };
}

describe('the one-pixel PNG of the browser specs', () => {
  const { signature, chunks } = chunksOf(onePixelPng());

  // Break caught: bytes that are not a PNG at all (a wrong signature), or chunks out of the order a decoder needs.
  it('has the PNG signature, then a header, the pixels and an end, in that order', () => {
    expect([...signature]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(chunks.map((chunk) => chunk.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(chunks[2]?.data.length).toBe(0);
  });

  // Break caught: a chunk whose check is wrong, which a browser's decoder refuses (the preview stays blank and the spec says that nothing was drawn): the check of each chunk is the CRC-32 of its type and data.
  it('has the right check on every chunk', () => {
    for (const chunk of chunks) {
      const expected = crc32(Buffer.concat([Buffer.from(chunk.type, 'latin1'), chunk.data]));
      expect(chunk.crc, chunk.type).toBe(expected);
    }
  });

  // Break caught: a header that is not one pixel of 8-bit RGB, which the specs read back as one colour.
  it('is one pixel of 8-bit colour', () => {
    const header = chunks[0]?.data;

    expect(header?.readUInt32BE(0)).toBe(1);
    expect(header?.readUInt32BE(4)).toBe(1);
    expect(header?.[8]).toBe(8);
    expect(header?.[9]).toBe(2);
  });

  // Break caught: the pixel the specs read back (`200,48,32,255`) not the one in the file.
  it('has the pixel it was asked for, after a filter byte of 0', () => {
    expect([...inflateSync(chunks[1]?.data ?? Buffer.alloc(0))]).toEqual([0, 200, 48, 32]);
    const other = chunksOf(onePixelPng(1, 2, 3)).chunks[1]?.data ?? Buffer.alloc(0);

    expect([...inflateSync(other)]).toEqual([0, 1, 2, 3]);
  });
});
