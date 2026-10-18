import { deflateSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([length, name, data, crc]);
}

export function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function mix(a, b, t) {
  return a + (b - a) * t;
}

function mixColor(a, b, t) {
  return [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
}

function roundedRect(x, y, left, top, width, height, radius) {
  const cx = left + width / 2;
  const cy = top + height / 2;
  const qx = Math.abs(x - cx) - width / 2 + radius;
  const qy = Math.abs(y - cy) - height / 2 + radius;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - radius <= 0;
}

function pointInTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

function renderIcon(size) {
  const buffer = Buffer.alloc(size * size * 4);
  const samples = 4;
  const top = [47, 107, 255];
  const bottom = [123, 77, 255];
  const deep = [76, 58, 220];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let bgCount = 0;
      let bubbleCount = 0;
      let barOneCount = 0;
      let barTwoCount = 0;
      let sparkCount = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const px = x + (sx + 0.5) / samples;
          const py = y + (sy + 0.5) / samples;
          if (roundedRect(px, py, 8, 8, size - 16, size - 16, size * 0.22)) bgCount += 1;
          const inBubble =
            roundedRect(px, py, size * 0.2, size * 0.25, size * 0.6, size * 0.38, size * 0.11) ||
            pointInTriangle(px, py, size * 0.33, size * 0.56, size * 0.5, size * 0.56, size * 0.35, size * 0.75);
          if (inBubble) bubbleCount += 1;
          if (roundedRect(px, py, size * 0.3, size * 0.35, size * 0.4, size * 0.055, size * 0.0275)) barOneCount += 1;
          if (roundedRect(px, py, size * 0.3, size * 0.45, size * 0.28, size * 0.05, size * 0.025)) barTwoCount += 1;
          const dx = px - size * 0.79;
          const dy = py - size * 0.2;
          const star = Math.abs(dx) < size * 0.015 || Math.abs(dy) < size * 0.015;
          if ((dx * dx + dy * dy < (size * 0.035) ** 2) || (star && dx * dx + dy * dy < (size * 0.075) ** 2)) sparkCount += 1;
        }
      }
      const total = samples * samples;
      const bgAlpha = bgCount / total;
      if (bgAlpha <= 0) continue;
      const gradientT = clamp01((x / size) * 0.45 + (y / size) * 0.55);
      let color = mixColor(top, bottom, gradientT);
      const highlight = clamp01(1 - Math.hypot(x - size * 0.28, y - size * 0.18) / (size * 0.55));
      color = mixColor(color, [255, 255, 255], highlight * 0.12);
      const bubble = bubbleCount / total;
      if (bubble > 0) color = mixColor(color, [255, 255, 255], bubble);
      const barColor = mixColor(deep, bottom, 0.45);
      const bars = Math.max(barOneCount, barTwoCount) / total;
      if (bars > 0) color = mixColor(color, barColor, bars * 0.95);
      const spark = sparkCount / total;
      if (spark > 0) color = mixColor(color, [255, 255, 255], spark);
      const offset = (y * size + x) * 4;
      buffer[offset] = Math.round(color[0]);
      buffer[offset + 1] = Math.round(color[1]);
      buffer[offset + 2] = Math.round(color[2]);
      buffer[offset + 3] = Math.round(bgAlpha * 255);
    }
  }
  return buffer;
}

export async function generateIcon(target) {
  const size = 256;
  const png = encodePng(size, size, renderIcon(size));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, png);
  return { path: target, bytes: png.length, size };
}

const invokedDirectly = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  const here = dirname(fileURLToPath(import.meta.url));
  const target = resolve(here, "..", "assets", "icon.png");
  const result = await generateIcon(target);
  console.log("icon generated: " + result.path + " (" + result.bytes + " bytes)");
}
