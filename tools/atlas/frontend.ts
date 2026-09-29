// Shared contract between the two tileset readers (source.ts: CDDA "compositing" source form,
// compiled.ts: a compiled tile_config.json + sheet PNGs such as BN's gfx/UltimateCataclysm)
// and the packer/writer in index.ts.

import { PNG } from 'pngjs';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { TileDef } from '../../src/render/atlasTypes';

export interface Img {
  w: number;
  h: number;
  data: Buffer;
}

/** One distinct (sprite pixels, draw offset) pair the index references. */
export interface FrameSrc {
  /** Identifies the pixels: frames with the same key share one packed rect without hashing. */
  key: string;
  load: () => Img;
  ox: number;
  oy: number;
}

export interface Problems {
  (kind: string, msg: string): void;
}

export interface Compiled {
  tileset: string;
  tileSize: number;
  tiles: Record<string, TileDef>;
  frames: FrameSrc[];
  /** 256 cp437 glyphs, white fill + black outline, `cell` px square, `columns` per row. */
  glyphs: () => Img;
  layering?: unknown;
  /** Human-readable lines for the report. */
  report: string[];
}

export function readPng(path: string, problem: Problems, label = path): Img {
  let p: PNG;
  try {
    p = PNG.sync.read(readFileSync(path));
  } catch (e) {
    // A handful of tileset PNGs have stray chunk data libpng tolerates but pngjs rejects;
    // let ImageMagick (in shell.nix) re-encode them.
    problem('png re-encoded via imagemagick', `${label}: ${(e as Error).message}`);
    p = PNG.sync.read(execFileSync('magick', [path, 'PNG32:-'], { maxBuffer: 1 << 26 }));
  }
  return { w: p.width, h: p.height, data: p.data };
}

export function crop(src: Img, x: number, y: number, w: number, h: number): Img {
  const out = Buffer.alloc(w * h * 4);
  for (let yy = 0; yy < h; yy++) src.data.copy(out, yy * w * 4, ((y + yy) * src.w + x) * 4, ((y + yy) * src.w + x + w) * 4);
  return { w, h, data: out };
}

export const GLYPH_COLUMNS = 16;

/** CDDA fallback.png holds 16 colour blocks of 256 cp437 glyphs (compose.py FALLBACK "ascii"
 *  table); `block` 1 (offset 256) is bold WHITE: white fill, black outline, so it can be tinted
 *  at runtime. */
export function glyphsFromFallback(fb: Img, cell: number, block = 1): Img {
  const across = Math.floor(fb.w / cell);
  const w = GLYPH_COLUMNS * cell, h = (256 / GLYPH_COLUMNS) * cell;
  const out = Buffer.alloc(w * h * 4);
  for (let g = 0; g < 256; g++) {
    const src = block * 256 + g;
    const sx = (src % across) * cell, sy = Math.floor(src / across) * cell;
    const dx = (g % GLYPH_COLUMNS) * cell, dy = Math.floor(g / GLYPH_COLUMNS) * cell;
    for (let yy = 0; yy < cell; yy++)
      fb.data.copy(out, ((dy + yy) * w + dx) * 4, ((sy + yy) * fb.w + sx) * 4, ((sy + yy) * fb.w + sx + cell) * 4);
  }
  return { w, h, data: out };
}
