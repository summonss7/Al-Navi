// Generates the Al-Navi brand icon (duotone compass) as a 1024px PNG.
// Pure JS: polygon rasterizer + PNG encoder (zlib). No native deps.
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

const W = 1024, H = 1024;
const LIME = [0x8e, 0xe5, 0x3f, 255];
const ORANGE = [0xf9, 0x73, 0x16, 255];
const BG = [0x17, 0x19, 0x1c, 255];

const px = new Uint8Array(W * H * 4);

function setPixel(x, y, c) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  // alpha blend
  const a = c[3] / 255;
  px[i] = Math.round(px[i] * (1 - a) + c[0] * a);
  px[i + 1] = Math.round(px[i + 1] * (1 - a) + c[1] * a);
  px[i + 2] = Math.round(px[i + 2] * (1 - a) + c[2] * a);
  px[i + 3] = Math.max(px[i + 3], c[3]);
}

function fillPoly(pts, color) {
  let minY = Infinity, maxY = -Infinity;
  for (const [, y] of pts) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  for (let y = Math.floor(minY); y <= Math.ceil(maxY); y++) {
    const xs = [];
    for (let i = 0; i < pts.length; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[(i + 1) % pts.length];
      if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
        xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      for (let x = Math.round(xs[k]); x <= Math.round(xs[k + 1]); x++) setPixel(x, y, color);
    }
  }
}

// antialiased thick ring segment (annulus sector), gap at lower-right
function fillRing(cx, cy, rOuter, rInner, a0, a1, color, samples = 3) {
  for (let y = Math.floor(cy - rOuter); y <= Math.ceil(cy + rOuter); y++) {
    for (let x = Math.floor(cx - rOuter); x <= Math.ceil(cx + rOuter); x++) {
      let hit = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const px_ = x + (sx + 0.5) / samples - cx;
          const py = y + (sy + 0.5) / samples - cy;
          const r = Math.hypot(px_, py);
          if (r < rInner || r > rOuter) continue;
          let ang = Math.atan2(py, px_); // -PI..PI, 0 = east, positive = down
          // normalize into a0..a0+2PI window
          while (ang < a0) ang += 2 * Math.PI;
          if (ang >= a0 && ang <= a1) hit++;
        }
      }
      const cov = hit / (samples * samples);
      if (cov > 0) setPixel(x, y, [color[0], color[1], color[2], Math.round(cov * 255)]);
    }
  }
}

function roundedRect(x0, y0, x1, y1, r, color) {
  const pts = [];
  const seg = 24;
  const corners = [
    [x1 - r, y1 - r, 0, Math.PI / 2],          // BR
    [x1 - r, y0 + r, Math.PI / 2, Math.PI],    // TR
    [x0 + r, y0 + r, Math.PI, 3 * Math.PI / 2],// TL
    [x0 + r, y1 - r, 3 * Math.PI / 2, 2 * Math.PI], // BL
  ];
  for (const [cx, cy, a0, a1] of corners) {
    for (let i = 0; i <= seg; i++) {
      const a = a0 + ((a1 - a0) * i) / seg;
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  }
  fillPoly(pts, color);
}

const CX = 512, CY = 512;

// 1) dark rounded-square background
roundedRect(32, 32, W - 32, H - 32, 224, BG);

// 2) broken ring: gap at lower-right (from -10° to 55°)
const a0 = (55 * Math.PI) / 180;
const a1 = (350 * Math.PI) / 180;
fillRing(CX, CY, 400, 342, a0, a1, LIME);

// 3) compass star: 4 kites; north = orange (long), others lime (shorter)
function kite(tipAngle, tipR, halfW, color) {
  const tip = [CX + tipR * Math.cos(tipAngle), CY + tipR * Math.sin(tipAngle)];
  const leftA = tipAngle - Math.PI / 2;
  const rightA = tipAngle + Math.PI / 2;
  const left = [CX + halfW * Math.cos(leftA), CY + halfW * Math.sin(leftA)];
  const right = [CX + halfW * Math.cos(rightA), CY + halfW * Math.sin(rightA)];
  const tailR = halfW * 0.62;
  const tail = [CX + tailR * Math.cos(tipAngle + Math.PI), CY + tailR * Math.sin(tipAngle + Math.PI)];
  fillPoly([tip, right, tail, left], color);
}

const N = -Math.PI / 2; // up
kite(N, 300, 52, ORANGE);          // north — long orange needle
kite(N + Math.PI / 2, 205, 46, LIME);
kite(N + Math.PI, 205, 46, LIME);
kite(N - Math.PI / 2, 205, 46, LIME);

// 4) center hub
fillRing(CX, CY, 34, 0, 0, 2 * Math.PI, [23, 25, 28, 255]);
fillRing(CX, CY, 22, 0, 0, 2 * Math.PI, ORANGE);

// ---- encode PNG ----
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const t = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crcInput = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput));
  return Buffer.concat([len, t, data, crc]);
}

const raw = Buffer.alloc((W * 4 + 1) * H);
for (let y = 0; y < H; y++) {
  raw[y * (W * 4 + 1)] = 0; // filter none
  Buffer.from(px.buffer, y * W * 4, W * 4).copy(raw, y * (W * 4 + 1) + 1);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

mkdirSync("src-tauri/icons", { recursive: true });
writeFileSync("src-tauri/icons/source.png", png);
console.log("written src-tauri/icons/source.png", png.length, "bytes");
