import * as THREE from 'three';
import type { GameData } from '../data/types';
import { hashString } from '../core/rng';
import { hexToRgb, cddaColor } from './colors';
import { Img, paintFire, paintFurniture, paintPlayer, paintSurface, paintTree, patternFor, type Pattern } from './pixelArt';
import type { SurfaceFace, SurfaceQuery, TileFrame, TileTextureSource } from './textureSource';

// Temporary TileTextureSource: paints pixel-art stand-ins on demand and packs them into
// one 1024x1024 texture page (shelf packing), uploading at most once per frame. A single
// page keeps chunk meshes at one draw call each.

const PAGE = 1024;
/** Surface variants per material: enough to break up tiling, few enough to pack. */
const VARIANTS = 3;

export class ProceduralTextureSource implements TileTextureSource {
  readonly texture: THREE.DataTexture;
  private pixels = new Uint8Array(PAGE * PAGE * 4);
  private frames = new Map<string, TileFrame>();
  private shelfX = 0;
  private shelfY = 0;
  private shelfH = 0;
  private dirty = false;
  private warned = new Set<string>();

  constructor(private data: GameData) {
    this.texture = new THREE.DataTexture(this.pixels, PAGE, PAGE, THREE.RGBAFormat);
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.generateMipmaps = false;
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.needsUpdate = true;
  }

  flush(): void {
    if (this.dirty) {
      this.texture.needsUpdate = true;
      this.dirty = false;
    }
  }

  terrain(id: string, face: SurfaceFace, q?: SurfaceQuery): TileFrame {
    const t = this.data.terrain[id];
    if (!t) return this.unknown(id);
    const season = q?.season ?? 'summer';
    if (face === 'sprite') {
      const kind = /pine|spruce|fir|hemlock|cedar/.test(id) ? 'pine' : t.flags.includes('SHRUB') || t.flags.includes('YOUNG') ? 'shrub' : 'tree';
      const v = (q?.variantSeed ?? 0) % 2;
      return this.frame(`tree:${kind}:${season}:${v}`, () => paintTree(hashString(id) + v * 7919, season, kind));
    }
    let pattern: Pattern;
    if (face === 'ceiling') pattern = 'ceiling';
    else if (face === 'pane') pattern = patternFor(id, t.flags, 'pane');
    else if (face === 'wall' || face === 'side') pattern = patternFor(id, t.flags, 'wall');
    else if (face === 'top') pattern = t.flags.includes('WALL') ? 'concrete' : patternFor(id, t.flags, 'floor');
    else pattern = patternFor(id, t.flags, 'floor');
    // Only natural ground gets random variants; man-made floors look better uniform.
    const variants = pattern === 'grass' || pattern === 'dirt' || pattern === 'gravel' || pattern === 'pavement' || pattern === 'rock' ? VARIANTS : 1;
    const v = (q?.variantSeed ?? 0) % variants;
    const color = pattern === 'ceiling' ? 'light_gray' : t.color;
    return this.frame(`s:${pattern}:${color}:${v}`, () => paintSurface(pattern, color, hashString(pattern) + v * 1013));
  }

  furniture(id: string, face: SurfaceFace, _q?: SurfaceQuery): TileFrame {
    const f = this.data.furniture[id];
    if (!f) return this.unknown(id);
    if (face === 'sprite') return this.frame(`f:${id}`, () => paintFurniture(id, f.color));
    const pattern: Pattern = face === 'top'
      ? /counter|kitchen/.test(id) ? 'tiles' : 'planks'
      : /fridge|freezer|oven|washer|dryer|locker|metal|vending|safe/.test(id) ? 'metalwall' : 'boards';
    return this.frame(`fs:${pattern}:${f.color}`, () => paintSurface(pattern, f.color, hashString(id)));
  }

  item(id: string): TileFrame {
    const it = this.data.items[id];
    if (!it) return this.unknown(id);
    return this.glyph(it.symbol, it.color);
  }

  glyph(symbol: string, color: string): TileFrame {
    return this.frame(`g:${symbol}:${color}`, () => paintGlyph(symbol, color));
  }

  sprite(name: string): TileFrame {
    if (name === 'player') return this.frame('sp:player', paintPlayer);
    if (name === 'fire') return this.frame('sp:fire', () => paintFire(7));
    throw new Error(`ProceduralTextureSource: no sprite named "${name}"`);
  }

  private unknown(id: string): TileFrame {
    if (!this.warned.has(id)) {
      this.warned.add(id);
      console.warn(`texture source: unknown id ${id}`);
    }
    return this.glyph('?', 'pink');
  }

  /** Pack an arbitrary painted image (memoised by key); used by sources layered on top. */
  custom(key: string, paint: () => Img): TileFrame {
    return this.frame('c:' + key, paint);
  }

  private frame(key: string, paint: () => Img): TileFrame {
    let f = this.frames.get(key);
    if (f) return f;
    const img = paint();
    const [x, y] = this.alloc(img.w, img.h);
    // Image rows are top-down; the texture is bottom-up (flipY=false DataTexture).
    for (let iy = 0; iy < img.h; iy++) {
      const row = (y + img.h - 1 - iy) * PAGE + x;
      this.pixels.set(img.data.subarray(iy * img.w * 4, (iy + 1) * img.w * 4), row * 4);
    }
    this.dirty = true;
    f = { texture: this.texture, uv: [x / PAGE, y / PAGE, (x + img.w) / PAGE, (y + img.h) / PAGE], w: img.w, h: img.h };
    this.frames.set(key, f);
    return f;
  }

  private alloc(w: number, h: number): [number, number] {
    // 1px gutter between frames so nearest sampling at a frame edge never reads a neighbor.
    if (this.shelfX + w + 1 > PAGE) {
      this.shelfX = 0;
      this.shelfY += this.shelfH + 1;
      this.shelfH = 0;
    }
    if (this.shelfY + h > PAGE) throw new Error('ProceduralTextureSource: texture page full');
    const r: [number, number] = [this.shelfX, this.shelfY];
    this.shelfX += w + 1;
    this.shelfH = Math.max(this.shelfH, h);
    return r;
  }
}

let glyphCanvas: HTMLCanvasElement | null = null;

/** Rasterize a CDDA glyph into a 16x16 image with a dark outline (browser only). */
function paintGlyph(symbol: string, color: string): Img {
  const S = 16;
  if (typeof document === 'undefined') throw new Error('paintGlyph needs a DOM canvas');
  glyphCanvas ??= document.createElement('canvas');
  glyphCanvas.width = glyphCanvas.height = S;
  const ctx = glyphCanvas.getContext('2d', { willReadFrequently: true })!;
  ctx.clearRect(0, 0, S, S);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 15px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(symbol || '?', S / 2, S / 2 + 1);
  const src = ctx.getImageData(0, 0, S, S).data;
  const img = new Img(S, S);
  const c = hexToRgb(cddaColor(color));
  // Threshold instead of keeping antialiasing: glyphs must be crisp pixel art.
  for (let i = 0; i < S * S; i++) if (src[i * 4 + 3] > 110) img.set(i % S, Math.floor(i / S), c);
  img.outline([10, 8, 6]);
  return img;
}
