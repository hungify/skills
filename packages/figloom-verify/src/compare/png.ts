import * as fs from "node:fs";
import * as path from "node:path";

import { PNG } from "pngjs";

export function readPng(filePath: string): PNG {
  const buf = fs.readFileSync(filePath);
  return PNG.sync.read(buf);
}

export function writePng(filePath: string, png: PNG): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, PNG.sync.write(png));
}

/** Solid RGBA PNG (fixtures / synthetic mutations). */
export function makeSolidPng(
  width: number,
  height: number,
  rgba: [number, number, number, number],
): PNG {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    const o = i << 2;
    png.data[o] = rgba[0];
    png.data[o + 1] = rgba[1];
    png.data[o + 2] = rgba[2];
    png.data[o + 3] = rgba[3];
  }
  return png;
}

/**
 * Detect dominant color from image borders.
 * Samples every Nth pixel along all 4 edges, returns average.
 */
export function detectBorderColor(png: PNG): [number, number, number, number] {
  const { width, height } = png
  const data = png.data
  let r = 0, g = 0, b = 0, a = 0, count = 0
  const step = Math.max(1, Math.floor(Math.min(width, height) / 50))
  
  // Top and bottom edges
  for (let x = 0; x < width; x += step) {
    for (const y of [0, height - 1]) {
      const i = (width * y + x) << 2
      r += data[i]!; g += data[i+1]!; b += data[i+2]!; a += data[i+3]!
      count++
    }
  }
  // Left and right edges (skip corners already counted)
  for (let y = step; y < height - 1; y += step) {
    for (const x of [0, width - 1]) {
      const i = (width * y + x) << 2
      r += data[i]!; g += data[i+1]!; b += data[i+2]!; a += data[i+3]!
      count++
    }
  }

  if (count === 0) return [255, 255, 255, 255]
  return [
    Math.round(r / count),
    Math.round(g / count),
    Math.round(b / count),
    Math.round(a / count),
  ]
}

/** Parse `#RGB` / `#RRGGBB` → RGB tuple. */
export function parseHexRgb(hex: string): [number, number, number] {
  const h = hex.trim().replace(/^#/, "");
  if (h.length === 3) {
    return [
      Number.parseInt(h[0]! + h[0]!, 16),
      Number.parseInt(h[1]! + h[1]!, 16),
      Number.parseInt(h[2]! + h[2]!, 16),
    ];
  }
  if (h.length !== 6) throw new Error(`Invalid hex color: ${hex}`);
  return [
    Number.parseInt(h.slice(0, 2), 16),
    Number.parseInt(h.slice(2, 4), 16),
    Number.parseInt(h.slice(4, 6), 16),
  ];
}

/**
 * Alpha-composite `src` onto a solid canvas fill (fixes Figma PNG transparency /
 * soft shadows vs opaque app captures).
 */
export function compositeOnCanvas(src: PNG, canvasHex: string): PNG {
  const [cr, cg, cb] = parseHexRgb(canvasHex);
  const out = new PNG({ width: src.width, height: src.height });
  for (let i = 0; i < src.width * src.height; i++) {
    const o = i << 2;
    const a = (src.data[o + 3] as number) / 255;
    out.data[o] = Math.round((src.data[o] as number) * a + cr * (1 - a));
    out.data[o + 1] = Math.round((src.data[o + 1] as number) * a + cg * (1 - a));
    out.data[o + 2] = Math.round((src.data[o + 2] as number) * a + cb * (1 - a));
    out.data[o + 3] = 255;
  }
  return out;
}

/** Nearest-neighbor resize to target w×h. */
export function resizeNearest(src: PNG, width: number, height: number): PNG {
  if (src.width === width && src.height === height) return src;
  const out = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    const sy = Math.min(src.height - 1, Math.floor((y * src.height) / height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(src.width - 1, Math.floor((x * src.width) / width));
      const si = (src.width * sy + sx) << 2;
      const di = (width * y + x) << 2;
      out.data[di] = src.data[si] as number;
      out.data[di + 1] = src.data[si + 1] as number;
      out.data[di + 2] = src.data[si + 2] as number;
      out.data[di + 3] = src.data[si + 3] as number;
    }
  }
  return out;
}

/** Pad to a canvas of exactly w×h, anchored top-left, auto-detected border fill. */
export function padTo(src: PNG, width: number, height: number, fillColor?: [number,number,number,number]): PNG {
  if (src.width === width && src.height === height) return src;
  const fill = fillColor ?? detectBorderColor(src)
  const out = makeSolidPng(width, height, fill);
  const copyW = Math.min(src.width, width);
  const copyH = Math.min(src.height, height);
  for (let y = 0; y < copyH; y++) {
    for (let x = 0; x < copyW; x++) {
      const si = (src.width * y + x) << 2;
      const di = (width * y + x) << 2;
      out.data[di] = src.data[si] as number;
      out.data[di + 1] = src.data[si + 1] as number;
      out.data[di + 2] = src.data[si + 2] as number;
      out.data[di + 3] = src.data[si + 3] as number;
    }
  }
  return out;
}
