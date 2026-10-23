// 生成 128x128 icon.png：暗金主题 CW32L012 芯片图标（纯 Node，无依赖）
const zlib = require('zlib');
const fs = require('fs');

const W = 128, H = 128;
const px = Buffer.alloc(W * H * 4); // RGBA

function set(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
}
function fillRect(x0, y0, x1, y1, r, g, b, a = 255) {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y, r, g, b, a);
}
function fillRoundRect(x0, y0, x1, y1, rad, r, g, b, a = 255) {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const dx = Math.max(x0 + rad - x, x - (x1 - rad), 0);
    const dy = Math.max(y0 + rad - y, y - (y1 - rad), 0);
    if (dx * dx + dy * dy <= rad * rad) set(x, y, r, g, b, a);
  }
}

// 背景：深色渐变（左上 #101010 → 右下 #050505）
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const t = (x + y) / (W + H);
  const v = Math.round(16 - 11 * t);
  set(x, y, v, v - 1, v - 4);
}

// 芯片主体（中央圆角方块 #1a150c，金边 #d4a549）
const cx0 = 34, cy0 = 34, cx1 = 94, cy1 = 94, rad = 8;
fillRoundRect(cx0, cy0, cx1, cy1, rad, 0xd4, 0xa5, 0x49);        // 金边
fillRoundRect(cx0 + 2, cy0 + 2, cx1 - 2, cy1 - 2, rad - 1, 0x1a, 0x15, 0x0c); // 芯体
// 引脚：四边各 4 根（金色 #f3d78c）
const pinColor = [0xf3, 0xd7, 0x8c];
for (let i = 0; i < 4; i++) {
  const off = 42 + i * 14;
  fillRect(18, off, 32, off + 6, ...pinColor);   // 左
  fillRect(96, off, 110, off + 6, ...pinColor);  // 右
  fillRect(off, 18, off + 6, 32, ...pinColor);   // 上
  fillRect(off, 96, off + 6, 110, ...pinColor);  // 下
}
// 中央 "CW" 字样（点阵，5x7 简化字形，金色亮色）
const glyph = {
  C: ["01110","10001","10000","10000","10000","10001","01110"],
  W: ["10001","10001","10001","10101","10101","11011","10001"]
};
function drawGlyph(ch, ox, oy, scale) {
  const rows = glyph[ch];
  for (let y = 0; y < rows.length; y++) for (let x = 0; x < rows[y].length; x++) {
    if (rows[y][x] === '1') fillRect(ox + x * scale, oy + y * scale, ox + x * scale + scale - 1, oy + y * scale + scale - 1, 0xf3, 0xd7, 0x8c);
  }
}
drawGlyph('C', 44, 52, 3);
drawGlyph('W', 64, 52, 3);
// 中心点缀：左上角状态点（绿 #5ad46a）
fillRect(40, 40, 44, 44, 0x5a, 0xd4, 0x6a);

// PNG 编码
function crc32(buf) {
  let c, table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  c = 0xffffffff;
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
const raw = Buffer.alloc(H * (1 + W * 4));
for (let y = 0; y < H; y++) {
  raw[y * (1 + W * 4)] = 0; // filter none
  px.copy(raw, y * (1 + W * 4) + 1, y * W * 4, (y + 1) * W * 4);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
]);
fs.writeFileSync(__dirname + '/icon.png', png);
console.log('icon.png written:', png.length, 'bytes');
