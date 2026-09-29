// Compile a UltiCa tileset into GPU-friendly atlas pages plus public/atlas/atlas.json (format
// documented in src/render/atlasTypes.ts). Two readers feed the same packer:
//   compiled.ts  tile_config.json + sheet PNGs (default: BN's gfx/UltimateCataclysm)
//   source.ts    CDDA "compositing" source form (per-sprite PNGs + tile_info.json), v1's input
//
// Usage: npm run atlas -- [--dry-run] [--tileset-dir DIR] [--source-form] [--fill-from DIR]
//                         [--out DIR] [--page-size N] [--exclude a,b] [--no-use-all]

import { PNG } from 'pngjs';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AtlasFrame, AtlasIndex, AtlasPage, SubtileDef, SubtileKey, TileDef, VariantList } from '../../src/render/atlasTypes';
import { compileCompiled, isCompiled } from './compiled';
import { type Compiled, type Img, GLYPH_COLUMNS } from './frontend';
import { compileSource } from './source';

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`atlas: compile the UltiCa tileset into public/atlas/
  --tileset-dir DIR  tileset directory (default $TILESET_DIR or
                     ~/code/Cataclysm-BN/gfx/UltimateCataclysm)
  --source-form      read DIR as the CDDA compositing *source* form (tile_info.json + pngs_*
                     directories, e.g. /home/peter/code/CDDA-3d/vendor/tilesets/gfx/UltimateCataclysm);
                     otherwise DIR must hold a compiled tile_config.json
  --out DIR          output directory (default public/atlas)
  --page-size N      atlas page size, power of two (default 4096)
  --fill-from DIR    also read DIR (a compositing *source* tileset, e.g. v1's DDA UltiCa in
                     /home/peter/code/CDDA-3d/vendor/tilesets/gfx/UltimateCataclysm) and add
                     the tiles whose ids the main tileset lacks (off by default: mixes UltiCa
                     revisions, grows the atlas)
  --exclude a,b      (source form) top-level sub-directories of every sheet dir to skip
  --no-use-all       (source form) don't turn unreferenced PNGs into tiles named after the PNG
  --dry-run          compile and report, but write nothing`);
  process.exit(0);
}
function arg(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
const DRY = argv.includes('--dry-run');
const SOURCE_FORM = argv.includes('--source-form');
const SRC = resolve(
  arg('--tileset-dir') ?? process.env.TILESET_DIR ?? join(process.env.HOME ?? '', 'code/Cataclysm-BN/gfx/UltimateCataclysm'),
);
const OUT = resolve(arg('--out') ?? 'public/atlas');
const PAGE = Number(arg('--page-size') ?? 4096);
const PAD = 1;
if (!Number.isInteger(Math.log2(PAGE))) throw new Error(`--page-size must be a power of two, got ${PAGE}`);
if (!SOURCE_FORM && !isCompiled(SRC))
  throw new Error(`${SRC} has no tile_config.json; pass --source-form for a tile_info.json source tileset`);
if (!SOURCE_FORM && (arg('--exclude') || argv.includes('--no-use-all')))
  throw new Error('--exclude / --no-use-all only apply to --source-form');

const problems: Record<string, string[]> = {};
const problem = (kind: string, msg: string) => void (problems[kind] ??= []).push(msg);

const t0 = Date.now();
const compiled: Compiled = SOURCE_FORM
  ? compileSource(
      SRC,
      { exclude: new Set((arg('--exclude') ?? '').split(',').filter(Boolean)), useAll: !argv.includes('--no-use-all') },
      problem,
    )
  : compileCompiled(SRC, problem);
const TILE_W = compiled.tileSize;

const FILL = arg('--fill-from');
if (FILL) {
  // Only ids the main tileset doesn't define (subtiles live inside their TileDef). Frames are
  // appended, so the filler's sprite indices shift by the main tileset's frame count.
  const extra = compileSource(resolve(FILL), { exclude: new Set(), useAll: false }, (k, m) => problem(`fill: ${k}`, m));
  if (extra.tileSize !== TILE_W) throw new Error(`--fill-from tile size ${extra.tileSize} != ${TILE_W}`);
  const base = compiled.frames.length;
  const used = new Map<number, number>();
  const remap = (vl: VariantList | undefined): VariantList | undefined =>
    vl?.map((v) => ({
      weight: v.weight,
      sprites: v.sprites.map((f) => {
        let n = used.get(f);
        if (n === undefined) {
          n = base + used.size;
          used.set(f, n);
          compiled.frames.push({ ...extra.frames[f], key: `fill:${extra.frames[f].key}` });
        }
        return n;
      }),
    }));
  let added = 0;
  for (const [id, def] of Object.entries(extra.tiles)) {
    if (compiled.tiles[id]) continue;
    const out: TileDef = { ...def, fg: remap(def.fg), bg: remap(def.bg) };
    if (!out.fg) delete out.fg;
    if (!out.bg) delete out.bg;
    if (def.multitile) {
      out.multitile = {};
      for (const [k, sub] of Object.entries(def.multitile)) {
        const s2: SubtileDef = { ...sub, fg: remap(sub!.fg), bg: remap(sub!.bg) };
        if (!s2.fg) delete s2.fg;
        if (!s2.bg) delete s2.bg;
        out.multitile[k as SubtileKey] = s2;
      }
    }
    compiled.tiles[id] = out;
    added++;
  }
  compiled.report.push(`fill-from   ${FILL}: +${added} tile ids, +${used.size} frames`);
}

// ---------------------------------------------------------------- load & dedupe pixels

// Identical pixels share one packed rect (offsets live on frames, not rects). Each source is
// loaded once even when several frames (offset variants) reference it.
const uniq: { img: Img; frames: number[] }[] = [];
const byHash = new Map<string, number>();
const rectOfKey = new Map<string, number>();
for (let f = 0; f < compiled.frames.length; f++) {
  const src = compiled.frames[f];
  let u = rectOfKey.get(src.key);
  if (u === undefined) {
    const img = src.load();
    const key = createHash('sha1').update(img.data).update(`${img.w},${img.h}`).digest('hex');
    u = byHash.get(key);
    if (u === undefined) {
      u = uniq.length;
      byHash.set(key, u);
      uniq.push({ img, frames: [] });
    }
    rectOfKey.set(src.key, u);
  }
  uniq[u].frames.push(f);
}

// ---------------------------------------------------------------- pack (shelf, tallest first)

const order = uniq.map((_, i) => i).sort((a, b) => uniq[b].img.h - uniq[a].img.h || uniq[b].img.w - uniq[a].img.w);
const placed: { page: number; x: number; y: number }[] = new Array(uniq.length);
const pageUsedH: number[] = [];
{
  let page = 0, x = 0, y = 0, shelfH = 0;
  pageUsedH[0] = 0;
  for (const u of order) {
    const cw = uniq[u].img.w + 2 * PAD, ch = uniq[u].img.h + 2 * PAD;
    if (cw > PAGE || ch > PAGE) throw new Error(`sprite ${cw}x${ch} larger than page`);
    if (x + cw > PAGE) {
      y += shelfH;
      x = 0;
      shelfH = 0;
    }
    if (y + ch > PAGE) {
      page++;
      x = 0;
      y = 0;
      shelfH = 0;
      pageUsedH[page] = 0;
    }
    placed[u] = { page, x: x + PAD, y: y + PAD };
    x += cw;
    shelfH = Math.max(shelfH, ch);
    pageUsedH[page] = Math.max(pageUsedH[page], y + ch);
  }
}
const pages: AtlasPage[] = pageUsedH.map((used, i) => {
  let h = 1;
  while (h < used) h *= 2;
  return { file: `atlas_${i}.png`, w: PAGE, h: Math.min(PAGE, Math.max(h, 64)) };
});

const frames: AtlasFrame[] = new Array(compiled.frames.length);
for (let u = 0; u < uniq.length; u++) {
  const { img } = uniq[u];
  for (const f of uniq[u].frames) {
    const { ox, oy } = compiled.frames[f];
    frames[f] = { page: placed[u].page, x: placed[u].x, y: placed[u].y, w: img.w, h: img.h, ox, oy };
  }
}

// ---------------------------------------------------------------- report

const mb = (n: number) => (n / 1048576).toFixed(1);
console.log(`tileset     ${SRC} (${SOURCE_FORM ? 'source form' : 'compiled'})`);
for (const line of compiled.report) console.log(line);
console.log(`frames      ${frames.length} referenced, ${uniq.length} unique rects after dedupe (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
console.log(`pages       ${pages.map((p) => `${p.w}x${p.h}`).join(' ')}`);
for (const [k, v] of Object.entries(problems)) {
  console.log(`  ! ${k}: ${v.length}${v.length ? `  e.g. ${v.slice(0, 3).join(' | ')}` : ''}`);
}

const glyphImg = compiled.glyphs();
if (DRY) {
  console.log('dry run: nothing written');
  process.exit(0);
}

// ---------------------------------------------------------------- write

mkdirSync(OUT, { recursive: true });
for (const f of readdirSync(OUT)) if (/^atlas_\d+\.png$/.test(f)) rmSync(join(OUT, f));

// Copy a sprite into the page and extrude its border PAD px outward, so nearest sampling at
// a UV exactly on the rect edge (or slightly outside after float error) still hits sprite
// colour instead of a neighbour.
function blit(page: PNG, img: Img, x: number, y: number): void {
  const W = page.width;
  for (let yy = -PAD; yy < img.h + PAD; yy++) {
    const sy = Math.min(img.h - 1, Math.max(0, yy));
    for (let xx = -PAD; xx < img.w + PAD; xx++) {
      const sx = Math.min(img.w - 1, Math.max(0, xx));
      const si = (sy * img.w + sx) * 4, di = ((y + yy) * W + (x + xx)) * 4;
      page.data[di] = img.data[si];
      page.data[di + 1] = img.data[si + 1];
      page.data[di + 2] = img.data[si + 2];
      page.data[di + 3] = img.data[si + 3];
    }
  }
}

let totalBytes = 0;
for (let p = 0; p < pages.length; p++) {
  const page = new PNG({ width: pages[p].w, height: pages[p].h });
  page.data.fill(0);
  for (let u = 0; u < uniq.length; u++) if (placed[u].page === p) blit(page, uniq[u].img, placed[u].x, placed[u].y);
  const buf = PNG.sync.write(page, { colorType: 6, deflateLevel: 9 });
  writeFileSync(join(OUT, pages[p].file), buf);
  totalBytes += buf.length;
  console.log(`wrote ${pages[p].file} ${pages[p].w}x${pages[p].h} ${mb(buf.length)} MB`);
}

const glyphPng = new PNG({ width: glyphImg.w, height: glyphImg.h });
glyphImg.data.copy(glyphPng.data);
const glyphBuf = PNG.sync.write(glyphPng, { colorType: 6, deflateLevel: 9 });
writeFileSync(join(OUT, 'glyphs.png'), glyphBuf);
totalBytes += glyphBuf.length;

const index: AtlasIndex = {
  version: 1,
  tileset: compiled.tileset,
  tileSize: TILE_W,
  pages,
  padding: PAD,
  frames,
  tiles: Object.fromEntries(Object.keys(compiled.tiles).sort().map((k) => [k, compiled.tiles[k]])),
  glyphs: { file: 'glyphs.png', cell: TILE_W, columns: GLYPH_COLUMNS, codepage: 'cp437' },
  layering: compiled.layering,
};
const json = JSON.stringify(index);
writeFileSync(join(OUT, 'atlas.json'), json);
totalBytes += json.length;
console.log(`wrote atlas.json ${mb(json.length)} MB; total ${mb(totalBytes)} MB in ${OUT}`);
