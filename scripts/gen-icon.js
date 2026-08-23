/**
 * 生成插件图标 media/icon.png（128x128，蓝色圆角方块 + 白色对勾）
 * 纯 Node 实现 PNG 编码，无第三方依赖
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 128;
const RADIUS = 26;

// 颜色
const BLUE = [79, 140, 255]; // #4F8CFF
const WHITE = [255, 255, 255];

function insideRoundedRect(x, y) {
  const cx = Math.max(RADIUS, Math.min(SIZE - RADIUS, x));
  const cy = Math.max(RADIUS, Math.min(SIZE - RADIUS, y));
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= RADIUS * RADIUS;
}

/** 点到线段距离 */
function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  const ddx = px - cx;
  const ddy = py - cy;
  return Math.sqrt(ddx * ddx + ddy * ddy);
}

/** 对勾笔画（两条线段） */
function onCheckmark(px, py, thickness) {
  const seg1 = distToSegment(px, py, 30, 66, 52, 88);
  const seg2 = distToSegment(px, py, 52, 88, 98, 34);
  return Math.min(seg1, seg2) <= thickness;
}

// 生成像素（RGBA）
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  const rowStart = y * (SIZE * 4 + 1);
  raw[rowStart] = 0; // filter: None
  for (let x = 0; x < SIZE; x++) {
    const off = rowStart + 1 + x * 4;
    if (!insideRoundedRect(x + 0.5, y + 0.5)) {
      raw[off] = 0;
      raw[off + 1] = 0;
      raw[off + 2] = 0;
      raw[off + 3] = 0;
      continue;
    }
    if (onCheckmark(x + 0.5, y + 0.5, 7)) {
      raw[off] = WHITE[0];
      raw[off + 1] = WHITE[1];
      raw[off + 2] = WHITE[2];
    } else {
      raw[off] = BLUE[0];
      raw[off + 1] = BLUE[1];
      raw[off + 2] = BLUE[2];
    }
    raw[off + 3] = 255;
  }
}

// PNG 编码
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
]);

const out = path.join(__dirname, '..', 'media', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log(`icon generated: ${out} (${png.length} bytes)`);
