// Reader for a *compiled* tileset: tile_config.json + sheet PNGs, the form the game itself
// loads (BN ships UltiCa like this in gfx/UltimateCataclysm; compose.py produces it).
//
// Semantics follow BN src/cata_tiles.cpp tileset_loader::load_internal / load_tilejson_from_file:
//  - `tiles-new` sheets are loaded in order. A sheet of WxH px cut into sprite_width x
//    sprite_height cells holds (W/sw)*(H/sh) sprites, numbered row-major; its first sprite's
//    global index is the total sprite count of all earlier sheets. Sprite 0 is compose.py's
//    null image and never referenced.
//  - A tile entry's sprite indices may point into any sheet (pixel size = that sheet's cell), but
//    it is drawn with the sprite_offset of the sheet whose `tiles` list holds the entry.
//  - `rotates` defaults to `multitile`; subtiles (`additional_tiles`) register as `<id>_<key>`.
//  - A later entry for the same id overwrites an earlier one (create_tile_type).
//  - The sheet with an `ascii` list (fallback.png) holds 16 colour blocks of 256 cp437 glyphs.

import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { SubtileDef, TileDef, VariantList } from '../../src/render/atlasTypes';
import { MULTITILE_KEYS } from '../../src/render/atlasTypes';
import { type Compiled, type FrameSrc, type Img, type Problems, crop, glyphsFromFallback, readPng } from './frontend';

type RawLayer = number | (number | { weight?: number; sprite?: number | number[] })[];
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
interface RawSheet {
  file: string;
  sprite_width?: number;
  sprite_height?: number;
  sprite_offset_x?: number;
  sprite_offset_y?: number;
  tiles?: RawEntry[];
  ascii?: { offset: number; bold?: boolean; color?: string }[];
}
interface Sheet {
  file: string;
  sw: number;
  sh: number;
  ox: number;
  oy: number;
  first: number;
  count: number;
  across: number;
  raw: RawSheet;
}

export function isCompiled(dir: string): boolean {
  return existsSync(join(dir, 'tile_config.json'));
}

export function compileCompiled(SRC: string, problem: Problems): Compiled {
  const config = JSON.parse(readFileSync(join(SRC, 'tile_config.json'), 'utf8')) as {
    tile_info: { width?: number; height?: number; pixelscale?: number }[];
    'tiles-new'?: RawSheet[];
  };
  const info = config.tile_info?.[0] ?? {};
  const TILE_W = info.width ?? 16;
  const TILE_H = info.height ?? 16;
  if (TILE_W !== TILE_H) throw new Error(`non-square tiles (${TILE_W}x${TILE_H}) not supported`);
  if ((info.pixelscale ?? 1) !== 1) throw new Error(`pixelscale ${info.pixelscale} not supported`);
  const rawSheets = config['tiles-new'];
  if (!rawSheets) throw new Error(`${SRC}/tile_config.json has no tiles-new (legacy single-sheet tilesets unsupported)`);

  // PNG header: width/height are big-endian u32 at byte 16/20. Reading only the header keeps
  // sheets we never sample (fallback.png is 512x8192) out of memory until needed.
  const pngSize = (path: string) => {
    const b = readFileSync(path).subarray(0, 24);
    if (b.toString('latin1', 12, 16) !== 'IHDR') throw new Error(`${path}: not a PNG`);
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  };

  const sheets: Sheet[] = [];
  let next = 0;
  for (const raw of rawSheets) {
    const path = join(SRC, raw.file);
    const sw = raw.sprite_width ?? TILE_W, sh = raw.sprite_height ?? TILE_H;
    if (!existsSync(path)) {
      // BN skips a missing sheet only when it is an empty ASCII fallback; anything else is fatal.
      if (raw.ascii && !raw.tiles?.length) continue;
      throw new Error(`missing sheet ${path}`);
    }
    const { w, h } = pngSize(path);
    if (w % sw || h % sh) problem('sheet not a multiple of its cell', `${raw.file} ${w}x${h} / ${sw}x${sh}`);
    const across = Math.floor(w / sw);
    const count = across * Math.floor(h / sh);
    sheets.push({ file: raw.file, sw, sh, ox: raw.sprite_offset_x ?? 0, oy: raw.sprite_offset_y ?? 0, first: next, count, across, raw });
    next += count;
  }
  const total = next;

  const sheetImgs = new Map<string, Img>();
  const sheetImg = (s: Sheet) => {
    let img = sheetImgs.get(s.file);
    if (!img) sheetImgs.set(s.file, (img = readPng(join(SRC, s.file), problem, s.file)));
    return img;
  };
  const sheetOf = (idx: number) => sheets.find((s) => idx >= s.first && idx < s.first + s.count);

  const frameOf = new Map<string, number>();
  const frames: FrameSrc[] = [];
  const referenced = new Set<number>();
  let crossSheetRefs = 0;

  function spriteIndex(idx: number, entrySheet: Sheet, ctx: string): number | undefined {
    if (!Number.isInteger(idx) || idx < 0 || idx >= total) {
      // cata_tiles drops out-of-range references silently; we report them.
      problem('sprite index out of range', `${idx} (${ctx})`);
      return undefined;
    }
    const s = sheetOf(idx)!;
    if (s.ox !== entrySheet.ox || s.oy !== entrySheet.oy) crossSheetRefs++;
    referenced.add(idx);
    const key = `${idx}|${entrySheet.ox},${entrySheet.oy}`;
    let f = frameOf.get(key);
    if (f === undefined) {
      f = frames.length;
      const pos = idx - s.first;
      frames.push({
        key: `#${idx}`,
        ox: entrySheet.ox,
        oy: entrySheet.oy,
        load: () => crop(sheetImg(s), (pos % s.across) * s.sw, Math.floor(pos / s.across) * s.sh, s.sw, s.sh),
      });
      frameOf.set(key, f);
    }
    return f;
  }

  function convertLayer(layer: RawLayer | undefined, sheet: Sheet, ctx: string): VariantList | undefined {
    if (layer === undefined || (Array.isArray(layer) && layer.length === 0)) return undefined;
    const out: VariantList = [];
    if (typeof layer === 'number') {
      const i = spriteIndex(layer, sheet, ctx);
      if (i !== undefined) out.push({ weight: 1, sprites: [i] });
    } else if (layer.every((p) => typeof p === 'number')) {
      // A plain list of indices is one variant holding pre-drawn rotations.
      const sprites = (layer as number[]).map((n) => spriteIndex(n, sheet, ctx)).filter((i): i is number => i !== undefined);
      if (sprites.length) out.push({ weight: 1, sprites });
    } else {
      for (const part of layer) {
        if (typeof part === 'number') {
          problem('mixed variant list', ctx);
          continue;
        }
        const idxs = Array.isArray(part.sprite) ? part.sprite : part.sprite === undefined ? [] : [part.sprite];
        const sprites = idxs.map((n) => spriteIndex(n, sheet, ctx)).filter((i): i is number => i !== undefined);
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
  let overwritten = 0, entryCount = 0;
  for (const sheet of sheets) {
    for (const entry of sheet.raw.tiles ?? []) {
      entryCount++;
      const ids = entry.id === undefined ? [] : Array.isArray(entry.id) ? entry.id : [entry.id];
      const ctx = `${sheet.file} ${ids[0] ?? '?'}`;
      if (!ids.length) {
        problem('entry without id', ctx);
        continue;
      }
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
        }
      } else if (entry.additional_tiles?.length) {
        throw new Error(`${ctx}: additional_tiles defined, but 'multitile' is not true`);
      }
      // Tiles without any sprite are erased after loading in cata_tiles.
      if (!def.fg && !def.bg) {
        problem('empty entry', ctx);
        continue;
      }
      for (const id of ids) {
        if (tiles[id]) overwritten++;
        tiles[id] = def;
      }
    }
  }

  const fallback = sheets.find((s) => s.raw.ascii);
  const boldWhite = fallback?.raw.ascii?.find((a) => a.color === 'WHITE' && a.bold);
  const unreferenced = total - referenced.size - (fallback?.count ?? 0);
  return {
    tileset: basename(SRC),
    tileSize: TILE_W,
    tiles,
    frames,
    glyphs: () => {
      if (!fallback || !boldWhite) throw new Error('tile_config.json has no bold WHITE ascii block');
      if (fallback.sw !== TILE_W || boldWhite.offset % 256) throw new Error('unexpected fallback sheet layout');
      return glyphsFromFallback(sheetImg(fallback), TILE_W, boldWhite.offset / 256);
    },
    layering: undefined,
    report: [
      `sheets      ${sheets.map((s) => `${s.file}(${s.sw}x${s.sh}@${s.ox},${s.oy})`).join(' ')}`,
      `sprites     ${total} slots, ${referenced.size} referenced (${unreferenced} unreferenced non-ascii slots, mostly row padding)`,
      `tiles       ${Object.keys(tiles).length} ids from ${entryCount} entries, ${overwritten} overwritten by a later entry`,
      `cross-sheet ${crossSheetRefs} references to a sprite from a sheet with other offsets (own frame each)`,
    ],
  };
}
