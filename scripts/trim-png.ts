#!/usr/bin/env bun
// Trim transparent or near-white padding around PNGs
import { readFileSync, writeFileSync, renameSync, statSync } from 'fs';
import { PNG } from 'pngjs';

function trimPng(path: string, thresh = 248) {
  const buf = readFileSync(path);
  const png = PNG.sync.read(buf);
  const { width, height, data } = png; // RGBA
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (width * y + x) << 2;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const a = data[idx + 3];
      const notNearWhite = (r < thresh || g < thresh || b < thresh);
      const visible = a > 0;
      if (visible && notNearWhite) { // treat near-white as background
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  // If nothing found (all white), fall back to any visible pixels
  if (maxX < 0 || maxY < 0) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (width * y + x) << 2;
        const a = data[idx + 3];
        if (a > 0) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0 || maxY < 0) {
      console.warn(`No visible pixels found in ${path}; skipping.`);
      return;
    }
  }
  // Expand by a small padding to avoid tight crop (2px)
  const pad = 2;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad);
  maxY = Math.min(height - 1, maxY + pad);
  const cropW = maxX - minX + 1;
  const cropH = maxY - minY + 1;
  if (cropW === width && cropH === height) {
    console.log(`${path}: already tightly cropped.`);
    return;
  }
  const out = new PNG({ width: cropW, height: cropH });
  for (let y = 0; y < cropH; y++) {
    for (let x = 0; x < cropW; x++) {
      const srcIdx = ((width * (y + minY)) + (x + minX)) << 2;
      const dstIdx = ((cropW * y) + x) << 2;
      out.data[dstIdx] = data[srcIdx];
      out.data[dstIdx + 1] = data[srcIdx + 1];
      out.data[dstIdx + 2] = data[srcIdx + 2];
      out.data[dstIdx + 3] = data[srcIdx + 3];
    }
  }
  const backup = `${path}.bak`;
  try { statSync(backup); } catch { writeFileSync(backup, buf); }
  const outBuf = PNG.sync.write(out);
  writeFileSync(path, outBuf);
  console.log(`${path}: trimmed to ${cropW}x${cropH} (from ${width}x${height})`);
}

const args = process.argv.slice(2);
let threshold = 248;
const paths: string[] = [];
for (const a of args) {
  if (a.startsWith('--threshold=')) threshold = parseInt(a.split('=')[1] || '248', 10) || 248;
  else paths.push(a);
}
if (!paths.length) {
  console.error('Usage: bun scripts/trim-png.ts <path1> [path2 ...]');
  process.exit(1);
}
for (const p of paths) {
  try { trimPng(p, threshold); } catch (e) { console.error(`Failed to trim ${p}:`, (e as Error).message); }
}
