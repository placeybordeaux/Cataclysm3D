// Compile the UltiCa tileset (CDDA "compositing" source form: one PNG per sprite + JSON tile
// entries, see ~/code/Cataclysm-DDA/doc/TILESET.md) into GPU-friendly atlas pages plus
// public/atlas/atlas.json (format documented in src/render/atlasTypes.ts).
//
// Semantics follow ~/code/Cataclysm-DDA/tools/gfx_tools/compose.py (run with --use-all):
//  - tile_info.json lists sheets; sheet "foo.png" of WxH reads directory pngs_foo_WxH/.
//  - Sheets are walked in tile_info order, files sorted; a sprite name (PNG stem) is global.
//    Non-filler sheets win over filler sheets; the first definition of a PNG name wins.
//  - Tile entries are converted main sheets first, then filler sheets; the first entry to
//    define an id wins (later duplicates are dropped, as compose.py does).
//  - With use-all (default), PNGs no entry references become tiles named after themselves.
// Offsets: CDDA applies the offset of the sheet that holds the tile *entry*, not of the sheet
// holding the PNG; frames therefore carry the entry sheet's offset.
//
// Usage: npm run atlas -- [--dry-run] [--tileset-dir DIR] [--out DIR] [--page-size N]
//                         [--exclude a,b] [--no-use-all]

import { PNG } from 'pngjs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { join, relative, resolve, basename } from 'node:path';
import type { AtlasFrame, AtlasIndex, AtlasPage, SubtileDef, TileDef, VariantList } from '../../src/render/atlasTypes';
import { MULTITILE_KEYS } from '../../src/render/atlasTypes';

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`atlas: compile the UltiCa tileset into public/atlas/
  --tileset-dir DIR  tileset source (default $TILESET_DIR or
                     /home/peter/code/CDDA-3d/vendor/tilesets/gfx/UltimateCataclysm)
  --out DIR          output directory (default public/atlas)
  --page-size N      atlas page size, power of two (default 4096)
  --exclude a,b      top-level sub-directories of every sheet dir to skip
                     (default: none; e.g. overmap,mods to drop overmap / mod-only sprites)
  --no-use-all       don't turn unreferenced PNGs into tiles named after the PNG
  --dry-run          compile and report, but write nothing`);
  process.exit(0);
}
function arg(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
const DRY = argv.includes('--dry-run');
const USE_ALL = !argv.includes('--no-use-all');
const SRC = resolve(
  arg('--tileset-dir') ?? process.env.TILESET_DIR ?? '/home/peter/code/CDDA-3d/vendor/tilesets/gfx/UltimateCataclysm',
);
const OUT = resolve(arg('--out') ?? 'public/atlas');
const PAGE = Number(arg('--page-size') ?? 4096);
const EXCLUDE = new Set((arg('--exclude') ?? '').split(',').filter(Boolean));
const PAD = 1;
if (!Number.isInteger(Math.log2(PAGE))) throw new Error(`--page-size must be a power of two, got ${PAGE}`);
if (!existsSync(join(SRC, 'tile_info.json'))) throw new Error(`no tile_info.json in ${SRC}`);

// ---------------------------------------------------------------- read sheets & entries

interface Sheet {
  name: string;
  w: number;
  h: number;
  ox: number;
  oy: number;
  filler: boolean;
  dir: string;
}
interface Png {
  name: string;
  path: string;
  sheet: Sheet;
}
type RawLayer = string | (string | { weight?: number; sprite?: string | string[] })[];
interface RawEntry {
  id?: string | string[];
  fg?: RawLayer;
  bg?: RawLayer;
  multitile?: boolean;
  rotates?: boolean;
  animated?: boolean;
  height_3d?: number;
  additional_tiles?: RawEntry[];
}

const problems: Record<string, string[]> = {};
function problem(kind: string, msg: string): void {
  (problems[kind] ??= []).push(msg);
}

const info = JSON.parse(readFileSync(join(SRC, 'tile_info.json'), 'utf8')) as Record<string, any>[];
const base = info[0];
const TILE_W: number = base.width ?? 16;
const TILE_H: number = base.height ?? 16;
if (TILE_W !== TILE_H) throw new Error(`non-square tiles (${TILE_W}x${TILE_H}) not supported`);

const sheets: Sheet[] = [];
let fallbackFile: string | undefined;
for (const conf of info.slice(1)) {
  const name = Object.keys(conf)[0];
  const spec = conf[name] ?? {};
  if (spec.fallback) {
    fallbackFile = name;
    continue;
  }
  const w = spec.sprite_width ?? TILE_W;
  const h = spec.sprite_height ?? TILE_H;
  const dir = join(SRC, `pngs_${name.split('.png')[0]}_${w}x${h}`);
  if (!existsSync(dir)) {
    problem('missing sheet dir', dir);
    continue;
  }
  sheets.push({ name, w, h, ox: spec.sprite_offset_x ?? 0, oy: spec.sprite_offset_y ?? 0, filler: !!spec.filler, dir });
}
// compose.py processes main sheets before fillers regardless of tile_info order.
const ordered = [...sheets.filter((s) => !s.filler), ...sheets.filter((s) => s.filler)];

const pngs = new Map<string, Png>();
const entries: { sheet: Sheet; entry: RawEntry; file: string }[] = [];
let excludedPngs = 0;

// Same traversal order as compose.py: directories sorted by full path, files sorted by name.
function walk(sheet: Sheet): void {
  const dirs: string[] = [];
  const rec = (d: string) => {
    dirs.push(d);
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (!statSync(p).isDirectory()) continue;
      const rel = relative(sheet.dir, p);
      if (!rel.includes('/') && EXCLUDE.has(rel)) {
        excludedPngs += countPngs(p);
        continue;
      }
      if (existsSync(join(p, '.scratch'))) continue;
      rec(p);
    }
  };
  rec(sheet.dir);
  dirs.sort();
  for (const d of dirs) {
    const files = readdirSync(d)
      .filter((f) => !statSync(join(d, f)).isDirectory())
      .sort();
    for (const f of files) {
      const p = join(d, f);
      // compose.py matches on suffixes == ['.png'], i.e. "a.b.png" is ignored.
      if (/^[^.]+\.png$/.test(f)) {
        const stem = f.slice(0, -4);
        const prev = pngs.get(stem);
        if (prev) {
          if (!sheet.filler) problem('duplicate png name', `${stem}: ${p} (kept ${prev.path})`);
          continue;
        }
        pngs.set(stem, { name: stem, path: p, sheet });
      } else if (/^[^.]+\.json$/.test(f)) {
        let data: unknown;
        try {
          data = JSON.parse(readFileSync(p, 'utf8'));
        } catch (e) {
          throw new Error(`bad JSON in ${p}: ${e}`);
        }
        for (const entry of Array.isArray(data) ? data : [data]) entries.push({ sheet, entry: entry as RawEntry, file: p });
      }
    }
  }
}
function countPngs(d: string): number {
  let n = 0;
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) n += countPngs(p);
    else if (e.endsWith('.png')) n++;
  }
  return n;
}
for (const s of ordered) walk(s);

// ---------------------------------------------------------------- convert entries

// Every distinct (PNG, offset) pair that ends up referenced gets one frame; frame ids are
// assigned lazily. The offset is the one of the sheet holding the tile *entry* (that's what
// CDDA draws with), so a PNG referenced from a sheet with other offsets gets a second frame
// sharing the same packed pixels.
const frameOfPng = new Map<string, number>();
const framePngs: { png: Png; ox: number; oy: number }[] = [];
const referenced = new Set<string>();
let crossSheetRefs = 0;

function spriteIndex(name: string, entrySheet: Sheet, ctx: string): number | undefined {
  if (!name) return undefined;
  const png = pngs.get(name);
  if (!png) {
    problem('missing png', `${name} (${ctx})`);
    return undefined;
  }
  referenced.add(name);
  if (png.sheet.ox !== entrySheet.ox || png.sheet.oy !== entrySheet.oy) crossSheetRefs++;
  const key = `${name}|${entrySheet.ox},${entrySheet.oy}`;
  let idx = frameOfPng.get(key);
  if (idx === undefined) {
    idx = framePngs.length;
    framePngs.push({ png, ox: entrySheet.ox, oy: entrySheet.oy });
    frameOfPng.set(key, idx);
  }
  return idx;
}

function convertLayer(layer: RawLayer | undefined, sheet: Sheet, ctx: string): VariantList | undefined {
  if (layer === undefined || layer === '' || (Array.isArray(layer) && layer.length === 0)) return undefined;
  const out: VariantList = [];
  if (typeof layer === 'string') {
    const i = spriteIndex(layer, sheet, ctx);
    if (i !== undefined) out.push({ weight: 1, sprites: [i] });
  } else if (layer.every((p) => typeof p === 'string')) {
    // A plain list of names is one variant holding pre-drawn rotations.
    const sprites = (layer as string[]).map((n) => spriteIndex(n, sheet, ctx)).filter((i): i is number => i !== undefined);
    if (sprites.length) out.push({ weight: 1, sprites });
  } else {
    for (const part of layer) {
      if (typeof part === 'string') {
        problem('mixed variant list', ctx);
        const i = spriteIndex(part, sheet, ctx);
        if (i !== undefined) out.push({ weight: 1, sprites: [i] });
        continue;
      }
      const names = Array.isArray(part.sprite) ? part.sprite : [part.sprite ?? ''];
      const sprites = names.map((n) => spriteIndex(n, sheet, ctx)).filter((i): i is number => i !== undefined);
      if (!sprites.length) continue;
      if (![1, 2, 4].includes(sprites.length)) problem('bad rotation count', `${ctx}: ${sprites.length}`);
      const weight = part.weight ?? 1;
      if (weight < 0) throw new Error(`negative weight in ${ctx}`);
      out.push({ weight, sprites });
    }
  }
  return out.length ? out : undefined;
}

const tiles: Record<string, TileDef> = {};
const processedIds = new Set<string>();
let dupIds = 0;

for (const { sheet, entry, file } of entries) {
  const ids = entry.id === undefined ? [] : Array.isArray(entry.id) ? entry.id : [entry.id];
  const ctx = `${relative(SRC, file)} ${ids[0] ?? '?'}`;
  if (!ids.length || (!entry.fg && !entry.bg)) {
    problem('empty entry', ctx);
    continue;
  }
  const fresh = ids.filter((id) => {
    if (processedIds.has(id)) {
      dupIds++;
      if (!sheet.filler) problem('duplicate id', `${id} in ${relative(SRC, file)}`);
      return false;
    }
    return true;
  });
  // Convert even if every id was a duplicate so PNG references are counted like compose.py.
  const def: TileDef = {};
  const fg = convertLayer(entry.fg, sheet, ctx);
  const bg = convertLayer(entry.bg, sheet, ctx);
  if (fg) def.fg = fg;
  if (bg) def.bg = bg;
  const multi = entry.multitile === true;
  if (entry.rotates ?? multi) def.rotates = true;
  if (entry.animated) def.animated = true;
  if (entry.height_3d) def.height3d = entry.height_3d;
  if (multi) {
    def.multitile = {};
    for (const sub of entry.additional_tiles ?? []) {
      const key = sub.id as string;
      if (!(MULTITILE_KEYS as readonly string[]).includes(key)) {
        problem('unknown subtile', `${ctx}: ${key}`);
        continue;
      }
      const s: SubtileDef = {};
      const sfg = convertLayer(sub.fg, sheet, `${ctx}_${key}`);
      const sbg = convertLayer(sub.bg, sheet, `${ctx}_${key}`);
      if (sfg) s.fg = sfg;
      if (sbg) s.bg = sbg;
      if (sub.animated) s.animated = true;
      if (!sfg && !sbg) continue;
      def.multitile[key as keyof typeof def.multitile] = s;
      for (const id of ids) processedIds.add(`${id}_${key}`);
    }
  } else if (entry.additional_tiles?.length) {
    problem('additional_tiles without multitile', ctx);
  }
  for (const id of fresh) {
    processedIds.add(id);
    if (def.fg || def.bg) tiles[id] = def;
  }
}

let useAllTiles = 0;
if (USE_ALL) {
  // Main-sheet PNGs first, then fillers, matching compose.py's two passes.
  const all = [...pngs.values()];
  for (const filler of [false, true]) {
    for (const png of all) {
      if (png.sheet.filler !== filler || referenced.has(png.name) || processedIds.has(png.name)) continue;
      const i = spriteIndex(png.name, png.sheet, 'use-all')!;
      tiles[png.name] = { fg: [{ weight: 1, sprites: [i] }] };
      processedIds.add(png.name);
      useAllTiles++;
    }
  }
}

// ---------------------------------------------------------------- load & dedupe pixels

interface Img {
  w: number;
  h: number;
  data: Buffer;
}
function readPng(path: string): Img {
  let p: PNG;
  try {
    p = PNG.sync.read(readFileSync(path));
  } catch (e) {
    // A handful of tileset PNGs have stray chunk data libpng tolerates but pngjs rejects;
    // let ImageMagick (in shell.nix) re-encode them.
    problem('png re-encoded via imagemagick', `${relative(SRC, path)}: ${(e as Error).message}`);
    p = PNG.sync.read(execFileSync('magick', [path, 'PNG32:-'], { maxBuffer: 1 << 26 }));
  }
  return { w: p.width, h: p.height, data: p.data };
}

// Identical pixels share one packed rect (offsets live on frames, not rects). PNGs are read
// once even when several frames (offset variants) reference them.
const uniq: { img: Img; frames: number[] }[] = [];
const byHash = new Map<string, number>();
const rectOfPng = new Map<string, number>();
const t0 = Date.now();
for (let f = 0; f < framePngs.length; f++) {
  const { png } = framePngs[f];
  let u = rectOfPng.get(png.name);
  if (u === undefined) {
    const img = readPng(png.path);
    if (img.w !== png.sheet.w || img.h !== png.sheet.h)
      problem('wrong sprite size', `${relative(SRC, png.path)} is ${img.w}x${img.h}, sheet wants ${png.sheet.w}x${png.sheet.h}`);
    const key = createHash('sha1').update(img.data).update(`${img.w},${img.h}`).digest('hex');
    u = byHash.get(key);
    if (u === undefined) {
      u = uniq.length;
      byHash.set(key, u);
      uniq.push({ img, frames: [] });
    }
    rectOfPng.set(png.name, u);
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

const frames: AtlasFrame[] = new Array(framePngs.length);
for (let u = 0; u < uniq.length; u++) {
  const { img } = uniq[u];
  for (const f of uniq[u].frames) {
    const { ox, oy } = framePngs[f];
    frames[f] = { page: placed[u].page, x: placed[u].x, y: placed[u].y, w: img.w, h: img.h, ox, oy };
  }
}

// ---------------------------------------------------------------- report

const mb = (n: number) => (n / 1048576).toFixed(1);
console.log(`tileset     ${SRC}`);
console.log(`sheets      ${ordered.map((s) => basename(s.dir)).join(' ')}`);
console.log(`excluded    ${[...EXCLUDE].join(',') || '-'} (${excludedPngs} pngs skipped)`);
console.log(`pngs        ${pngs.size} found, ${framePngs.length} referenced, ${uniq.length} unique after dedupe (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
console.log(`tiles       ${Object.keys(tiles).length} ids (${useAllTiles} from --use-all), ${dupIds} duplicate ids dropped`);
console.log(`cross-sheet ${crossSheetRefs} references to a PNG from a sheet with other offsets (own frame each)`);
console.log(`pages       ${pages.map((p) => `${p.w}x${p.h}`).join(' ')}`);
for (const [k, v] of Object.entries(problems)) {
  console.log(`  ! ${k}: ${v.length}${v.length ? `  e.g. ${v.slice(0, 3).join(' | ')}` : ''}`);
}

// ---------------------------------------------------------------- glyphs (ASCII fallback)

// fallback.png holds 16 colour blocks of 256 CP437 glyphs (compose.py FALLBACK "ascii" table);
// block 1 (offset 256) is bold WHITE: white fill, black outline, so it can be tinted at runtime.
const GLYPH_COLUMNS = 16;
function buildGlyphs(): PNG {
  if (!fallbackFile) throw new Error('tile_info.json has no fallback sheet');
  const fb = readPng(join(SRC, fallbackFile));
  const cell = TILE_W;
  const across = Math.floor(fb.w / cell);
  const out = new PNG({ width: GLYPH_COLUMNS * cell, height: (256 / GLYPH_COLUMNS) * cell });
  for (let g = 0; g < 256; g++) {
    const src = 256 + g;
    const sx = (src % across) * cell, sy = Math.floor(src / across) * cell;
    const dx = (g % GLYPH_COLUMNS) * cell, dy = Math.floor(g / GLYPH_COLUMNS) * cell;
    for (let yy = 0; yy < cell; yy++)
      fb.data.copy(out.data, ((dy + yy) * out.width + dx) * 4, ((sy + yy) * fb.w + sx) * 4, ((sy + yy) * fb.w + sx + cell) * 4);
  }
  return out;
}

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

const glyphBuf = PNG.sync.write(buildGlyphs(), { colorType: 6, deflateLevel: 9 });
writeFileSync(join(OUT, 'glyphs.png'), glyphBuf);
totalBytes += glyphBuf.length;

const layeringPath = join(SRC, 'layering.json');
const index: AtlasIndex = {
  version: 1,
  tileset: basename(SRC),
  tileSize: TILE_W,
  pages,
  padding: PAD,
  frames,
  tiles: Object.fromEntries(Object.keys(tiles).sort().map((k) => [k, tiles[k]])),
  glyphs: { file: 'glyphs.png', cell: TILE_W, columns: GLYPH_COLUMNS, codepage: 'cp437' },
  layering: existsSync(layeringPath) ? JSON.parse(readFileSync(layeringPath, 'utf8')) : undefined,
};
const json = JSON.stringify(index);
writeFileSync(join(OUT, 'atlas.json'), json);
totalBytes += json.length;
console.log(`wrote atlas.json ${mb(json.length)} MB; total ${mb(totalBytes)} MB in ${OUT}`);
