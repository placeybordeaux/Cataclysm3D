import type { GameData } from '../data/types';
import { hashString } from '../core/rng';
import * as THREE from 'three';
import { setupPixelTexture, type Atlas, type FrameRef } from './atlas';
import type { RGB } from './colors';
import { paintSurface, patternFor, rampAround } from './pixelArt';
import type { ProceduralTextureSource } from './proceduralSource';
import type { SurfaceFace, SurfaceQuery, TileFrame, TileTextureSource } from './textureSource';

// TileTextureSource backed by the UltiCa atlas, layered in front of the procedural source.
//
// UltiCa is drawn for a top-down/3-4 view, so not every sprite suits every 3D surface:
//   floor / top      atlas sprite (multitile 'center' for walls = the wall's top face)
//   sprite           atlas fg sprite (trees, furniture, items, fire, player)
//   wall             'tinted' (default): procedural brick/plaster/... pattern in a ramp built
//                    from the atlas sprite's average colour, so walls match the tileset
//                    palette without a squashed 3/4 drawing on them;
//                    'sprite': the atlas wall sprite itself (toggle to compare).
//   ceiling / pane   procedural (the tileset has nothing drawn for these)
// Anything the atlas lacks falls back to the procedural source, so coverage gaps never
// leave holes.

export type WallStyle = 'tinted' | 'sprite';

const ATLAS_PPM = 32;

/** Only plain one-cell sprites can texture a 1x1 quad (tall 3/4-view sprites like stairs
 *  or fridges would stretch and punch alpha holes). */
const tileSized = (r: FrameRef | undefined) => (r && r.w === 32 && r.h === 32 && r.ox === 0 && r.oy === 0 ? r : undefined);

export class AtlasTextureSource implements TileTextureSource {
  wallStyle: WallStyle = 'tinted';
  private avgCache = new Map<string, RGB | null>();
  private looksLike: (id: string) => string | undefined;

  constructor(private atlas: Atlas, private data: GameData, readonly fallback: ProceduralTextureSource) {
    this.looksLike = (id) => (data.terrain[id]?.looks_like ?? data.furniture[id]?.looks_like ?? (data.items[id]?.looks_like as string | undefined));
  }

  flush(): void {
    this.fallback.flush();
  }

  private conv(r: FrameRef | undefined, rotate = true): TileFrame | null {
    if (!r) return null;
    return {
      texture: r.texture,
      uv: [r.uv.u0, r.uv.v0, r.uv.u1, r.uv.v1],
      w: r.w,
      h: r.h,
      ppm: ATLAS_PPM,
      rotate: rotate ? r.rotate : 0,
    };
  }

  terrain(id: string, face: SurfaceFace, q?: SurfaceQuery): TileFrame {
    switch (face) {
      case 'floor': {
        const hit = this.atlas.lookupWithLooksLike(id, this.looksLike, { variantSeed: q?.variantSeed, season: q?.season, connections: q?.connections ?? 15 });
        // Some floors (water, shrubs) put the ground in bg and an overlay in fg; for a floor
        // quad we want the opaque one.
        return this.conv(tileSized(hit?.fg ?? hit?.bg)) ?? this.fallback.terrain(id, face, q);
      }
      case 'top': {
        const hit = this.atlas.lookupWithLooksLike(id, this.looksLike, { connections: q?.connections ?? 15, variantSeed: q?.variantSeed });
        return this.conv(tileSized(hit?.fg)) ?? this.fallback.terrain(id, face, q);
      }
      case 'sprite': {
        const hit = this.atlas.lookupWithLooksLike(id, this.looksLike, { variantSeed: q?.variantSeed, season: q?.season });
        return this.conv(hit?.fg, false) ?? this.fallback.terrain(id, face, q);
      }
      case 'wall':
      case 'side': {
        if (this.wallStyle === 'sprite') {
          const hit = this.atlas.lookupWithLooksLike(id, this.looksLike, { connections: q?.connections ?? 0 });
          const f = this.conv(hit?.fg, false);
          if (f) return f;
        }
        const avg = this.average(id);
        const t = this.data.terrain[id];
        if (!avg || !t) return this.fallback.terrain(id, face, q);
        const pattern = patternFor(id, t.flags, 'wall');
        // Plaster/drywall should read as a calm surface; masonry keeps its contrast.
        const spread = pattern === 'plaster' ? 0.45 : pattern === 'blocks' || pattern === 'metalwall' ? 0.6 : 0.85;
        return this.fallback.custom(`wall:${pattern}:${avg.join(',')}`, () => paintSurface(pattern, t.color, hashString(id), rampAround(avg, spread)));
      }
      default:
        return this.fallback.terrain(id, face, q);
    }
  }

  furniture(id: string, face: SurfaceFace, q?: SurfaceQuery): TileFrame {
    if (face === 'sprite') {
      const hit = this.atlas.lookupWithLooksLike(id, this.looksLike, { variantSeed: q?.variantSeed, season: q?.season });
      return this.conv(hit?.fg ?? hit?.bg, false) ?? this.fallback.furniture(id, face, q);
    }
    if (face === 'top') {
      const hit = this.atlas.lookupWithLooksLike(id, this.looksLike, { connections: 15 });
      const f = this.conv(tileSized(hit?.fg));
      if (f) return f;
    }
    const avg = this.average(id);
    const fd = this.data.furniture[id];
    if (!avg || !fd) return this.fallback.furniture(id, face, q);
    const pattern = /fridge|freezer|oven|washer|dryer|locker|metal|vending|safe/.test(id) ? 'metalwall' : 'boards';
    return this.fallback.custom(`fside:${pattern}:${avg.join(',')}`, () => paintSurface(pattern, fd.color, hashString(id), rampAround(avg)));
  }

  item(id: string): TileFrame {
    const it = this.data.items[id];
    const hit = this.atlas.lookupWithLooksLike(id, this.looksLike);
    const f = this.conv(hit?.fg, false);
    if (f) return f;
    return it ? this.glyph(it.symbol, it.color) : this.fallback.item(id);
  }

  glyph(symbol: string, color: string): TileFrame {
    return this.conv(this.atlas.glyph(symbol, color), false)!;
  }

  /** Default survivor look until the character system supplies worn items. */
  playerLayers = ['player_male', 'overlay_male_worn_jeans', 'overlay_male_worn_tshirt', 'overlay_male_worn_sneakers', 'overlay_male_worn_jacket_flannel'];
  private composites = new Map<string, TileFrame>();

  /**
   * CDDA sprite layering for a survivor: body, then each worn item's overlay in wear order
   * (inner to outer), then the wielded item's. Tries the gendered overlay id first like CDDA
   * (overlay_male_worn_X, then overlay_worn_X); items without art are skipped.
   */
  layersFor(worn: string[], wielded: string | null, gender: 'male' | 'female' = 'male'): string[] {
    const pick = (...ids: string[]) => ids.find((id) => this.atlas.has(id));
    const out = [`player_${gender}`];
    for (const id of worn) {
      const o = pick(`overlay_${gender}_worn_${id}`, `overlay_worn_${id}`);
      if (o) out.push(o);
    }
    if (wielded) {
      const o = pick(`overlay_${gender}_wielded_${wielded}`, `overlay_wielded_${wielded}`);
      if (o) out.push(o);
    }
    return out;
  }

  /**
   * Stack several atlas sprites (CDDA-style body + clothing overlays) into one frame on its
   * own small texture. Missing ids are skipped. Memoised by the id list.
   */
  composite(ids: string[]): TileFrame | null {
    const key = ids.join('|');
    const hit = this.composites.get(key);
    if (hit) return hit;
    const refs = ids.map((id) => this.atlas.lookup(id)?.fg).filter((r): r is FrameRef => !!r);
    if (!refs.length || typeof document === 'undefined') return null;
    let minX = 0, minY = 0, maxX = 32, maxY = 32;
    for (const r of refs) {
      minX = Math.min(minX, r.ox); minY = Math.min(minY, r.oy);
      maxX = Math.max(maxX, r.ox + r.w); maxY = Math.max(maxY, r.oy + r.h);
    }
    const c = document.createElement('canvas');
    c.width = maxX - minX;
    c.height = maxY - minY;
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    for (const r of refs) ctx.drawImage(r.image, r.px.x, r.px.y, r.px.w, r.px.h, r.ox - minX, r.oy - minY, r.w, r.h);
    const tex = new THREE.CanvasTexture(c);
    setupPixelTexture(tex);
    const f: TileFrame = { texture: tex, uv: [0, 0, 1, 1], w: c.width, h: c.height, ppm: ATLAS_PPM };
    this.composites.set(key, f);
    return f;
  }

  sprite(name: string): TileFrame {
    if (name === 'player') return this.composite(this.playerLayers) ?? this.fallback.sprite(name);
    const id = name === 'fire' ? 'fd_fire' : name;
    // fields come as fd_x_int<n>; UltiCa has per-intensity sprites for some, one for others
    const hit = this.atlas.lookup(id) ?? (id.startsWith('fd_') ? this.atlas.lookup(id.replace(/_int\d$/, '')) : null);
    return this.conv(hit?.fg ?? hit?.bg, false) ?? this.fallback.sprite(name);
  }

  /** Average opaque colour of an id's atlas sprite (memoised), for tinting procedural faces. */
  private average(id: string): RGB | null {
    if (this.avgCache.has(id)) return this.avgCache.get(id)!;
    let res: RGB | null = null;
    const hit = this.atlas.lookupWithLooksLike(id, this.looksLike, { connections: 15 });
    const r = hit?.fg ?? hit?.bg;
    if (r && typeof document !== 'undefined') {
      const c = document.createElement('canvas');
      c.width = r.px.w;
      c.height = r.px.h;
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(r.image, r.px.x, r.px.y, r.px.w, r.px.h, 0, 0, r.px.w, r.px.h);
      const d = ctx.getImageData(0, 0, r.px.w, r.px.h).data;
      let sr = 0, sg = 0, sb = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 200) continue;
        sr += d[i]; sg += d[i + 1]; sb += d[i + 2]; n++;
      }
      // Quantize so near-identical walls share one packed texture.
      if (n) res = [sr / n, sg / n, sb / n].map((v) => Math.round(v / 4) * 4) as RGB;
    }
    this.avgCache.set(id, res);
    return res;
  }
}
