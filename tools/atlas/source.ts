// Reader for the CDDA "compositing" source form of a tileset (one PNG per sprite + JSON tile
// entries, see ~/code/Cataclysm-DDA/doc/TILESET.md), which v1 used for DDA's UltiCa.
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

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import type { SubtileDef, TileDef, VariantList } from '../../src/render/atlasTypes';
import { MULTITILE_KEYS } from '../../src/render/atlasTypes';
import { type Compiled, type FrameSrc, type Problems, glyphsFromFallback, readPng } from './frontend';

export interface SourceOpts {
  exclude: Set<string>;
  useAll: boolean;
}

export function compileSource(SRC: string, opts: SourceOpts, problem: Problems): Compiled {
  const EXCLUDE = opts.exclude;
  const USE_ALL = opts.useAll;
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


  const frames: FrameSrc[] = framePngs.map(({ png, ox, oy }) => ({
    key: png.path,
    ox,
    oy,
    load: () => {
      const img = readPng(png.path, problem, relative(SRC, png.path));
      if (img.w !== png.sheet.w || img.h !== png.sheet.h)
        problem('wrong sprite size', `${relative(SRC, png.path)} is ${img.w}x${img.h}, sheet wants ${png.sheet.w}x${png.sheet.h}`);
      return img;
    },
  }));
  const layeringPath = join(SRC, 'layering.json');
  return {
    tileset: basename(SRC),
    tileSize: TILE_W,
    tiles,
    frames,
    glyphs: () => {
      if (!fallbackFile) throw new Error('tile_info.json has no fallback sheet');
      return glyphsFromFallback(readPng(join(SRC, fallbackFile), problem), TILE_W);
    },
    layering: existsSync(layeringPath) ? JSON.parse(readFileSync(layeringPath, 'utf8')) : undefined,
    report: [
      `sheets      ${ordered.map((s) => basename(s.dir)).join(' ')}`,
      `excluded    ${[...EXCLUDE].join(',') || '-'} (${excludedPngs} pngs skipped)`,
      `pngs        ${pngs.size} found, ${framePngs.length} referenced`,
      `tiles       ${Object.keys(tiles).length} ids (${useAllTiles} from --use-all), ${dupIds} duplicate ids dropped`,
      `cross-sheet ${crossSheetRefs} references to a PNG from a sheet with other offsets (own frame each)`,
    ],
  };
}
