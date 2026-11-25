// Makes the sample parcel label of the photo viewer's showcase: a synthetic 4 x 6 inch label at 200 dots per inch (800 x 1200), portrait, the shape of a real parcel label,
// with an asymmetric mark so that a turn of the photo can be told from its pixels. It is drawn, never photographed: no real parcel, person, address or code is in it.
// Usage (from this folder): node make-label-sample.mjs label-sample.png. The same bytes come out every time, and the file is held to its size by test/showcase-label-sample.test.ts.
import { Buffer } from 'node:buffer';
import { writeFileSync } from 'node:fs';
import process from 'node:process';
import { deflateSync } from 'node:zlib';

const W = 800;
const H = 1200;
const pixels = Buffer.alloc(W * H * 3, 255);

function rect(x, y, w, h, [r, g, b]) {
  for (let yy = Math.max(0, y); yy < Math.min(H, y + h); yy += 1) {
    for (let xx = Math.max(0, x); xx < Math.min(W, x + w); xx += 1) {
      const at = (yy * W + xx) * 3;
      pixels[at] = r;
      pixels[at + 1] = g;
      pixels[at + 2] = b;
    }
  }
}
const BLACK = [20, 20, 20];
const GREY = [110, 110, 110];
const RED = [200, 30, 30];
const BLUE = [30, 70, 190];

// A steady pseudo-random, so that the file is the same every time it is made.
let seed = 20261124;
const next = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0x100000000;
};

// The border, and the mark: a red square in the top-left corner and a blue bar along the right-hand edge, so that no turn of the photo looks like another.
rect(0, 0, W, 8, BLACK);
rect(0, H - 8, W, 8, BLACK);
rect(0, 0, 8, H, BLACK);
rect(W - 8, 0, 8, H, BLACK);
rect(24, 24, 140, 140, RED);
rect(W - 60, 200, 36, 600, BLUE);

// Lines of "text": rows of short dark bars, as small print is when it is photographed, at three sizes.
function lines(top, count, height, gap, indent) {
  for (let i = 0; i < count; i += 1) {
    let x = indent;
    const y = top + i * (height + gap);
    while (x < W - 120) {
      const bar = 14 + Math.floor(next() * 70);
      rect(x, y, Math.min(bar, W - 120 - x), height, i % 4 === 0 ? BLACK : GREY);
      x += bar + 10 + Math.floor(next() * 14);
    }
  }
}
lines(200, 3, 56, 24, 190); // the big print: the destination
lines(420, 6, 26, 18, 40); // the address
lines(700, 8, 14, 12, 40); // the small print

// The barcode: bars of two widths along the bottom, as a label carries one.
let x = 40;
while (x < W - 120) {
  const w = next() < 0.5 ? 6 : 14;
  rect(x, 940, w, 180, BLACK);
  x += w + (next() < 0.5 ? 6 : 12);
}

// PNG: signature, header, one compressed image part (each row led by filter type 0), end.
const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buffer) => {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}
const header = Buffer.alloc(13);
header.writeUInt32BE(W, 0);
header.writeUInt32BE(H, 4);
header[8] = 8; // bit depth
header[9] = 2; // colour type: truecolour
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y += 1) {
  raw[y * (W * 3 + 1)] = 0;
  pixels.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
const out = process.argv[2];
if (out === undefined) throw new Error('give the output path');
writeFileSync(out, png);
process.stdout.write(`${out}: ${String(png.length)} bytes, ${String(W)} x ${String(H)}
`);
