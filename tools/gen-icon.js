#!/usr/bin/env node
// Generate images/icon.png: a pixel-art owl in the spirit of the BBC Micro era
// (an original homage, not the BBC's trademarked owl logo), 16x16 pixels scaled
// crisply to 128x128. Pure node - a minimal PNG encoder over zlib.
//
//   node tools/gen-icon.js

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---- the artwork ----
// Legend: . background, Y amber body, E eye white, P pupil, O orange beak/chevron/feet
const GRID = [
  '................',
  '..Y..........Y..',
  '..YY........YY..',
  '..YYYYYYYYYYYY..',
  '.YYEEEYYYYEEEYY.',
  '.YYEPEYYYYEPEYY.',
  '.YYEEEYOOYEEEYY.',
  '.YYYYYYOOYYYYYY.',
  '.YOYYYYYYYYYYOY.',
  '.YOYYYYYYYYYYOY.',
  '.YOYYYYYYYYYYOY.',
  '.YYOYYYYYYYYOYY.',
  '..YOYYYYYYYYOY..',
  '...YYYYYYYYYY...',
  '....OO....OO....',
  '................',
];

const PALETTE = {
  '.': [0x12, 0x12, 0x20, 0xff], // deep navy-black background
  'Y': [0xf0, 0xb4, 0x29, 0xff], // amber body
  'E': [0xf8, 0xf4, 0xe3, 0xff], // eye white
  'P': [0x12, 0x12, 0x20, 0xff], // pupil (background colour)
  'O': [0xe0, 0x4f, 0x1f, 0xff], // orange-red beak / chevrons / feet
};

const SCALE = 8; // 16 * 8 = 128
const SIZE = GRID.length * SCALE;

// ---- raster ----

const raw = Buffer.alloc(SIZE * (1 + SIZE * 4)); // filter byte + RGBA per scanline
let o = 0;
for (let y = 0; y < SIZE; y++) {
  raw[o++] = 0; // filter: none
  const row = GRID[Math.floor(y / SCALE)];
  for (let x = 0; x < SIZE; x++) {
    const px = PALETTE[row[Math.floor(x / SCALE)]] ?? PALETTE['.'];
    raw[o++] = px[0];
    raw[o++] = px[1];
    raw[o++] = px[2];
    raw[o++] = px[3];
  }
}

// ---- PNG encoding ----

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[n] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) {
    c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // colour type: RGBA
ihdr[10] = 0; // compression
ihdr[11] = 0; // filter
ihdr[12] = 0; // interlace

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = path.join(__dirname, '..', 'images', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes, ${SIZE}x${SIZE})`);
