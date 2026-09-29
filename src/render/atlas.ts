// Runtime access to the compiled UltiCa atlas (public/atlas/, built by `npm run atlas`).
//
//   const atlas = await loadAtlas();
//   const r = atlas.lookup('t_wall', { connections: CONN.N | CONN.S });   // multitile edge
//   r?.fg?.texture, r?.fg?.uv                                            // for a quad
//   atlas.lookupWithLooksLike(id, (id) => data.looksLike(id), { season: 'winter' })
//   atlas.glyph('Z', 'c_green')                                          // ASCII fallback
//   atlas.spriteDataURL('hammer')                                        // <img src> for UI
//
// Textures are NearestFilter, no mipmaps, SRGB. UVs follow three.js conventions (flipY on,
// v = 0 at the bottom of the page): (u0, v0) is the sprite's bottom-left, (u1, v1) top-right.
// Resolution logic lives in atlasIndex.ts (pure, unit-tested).

import * as THREE from 'three';
import type { AtlasFrame, AtlasIndex } from './atlasTypes';
import { AtlasLookup, cddaColor, glyphIndex, type FrameSel, type LookupOpts, type LookupResult } from './atlasIndex';

export { CONN, pointSeed, type LookupOpts, type Season } from './atlasIndex';

export interface FrameRef {
  texture: THREE.Texture;
  /** Page (or glyph canvas) image, for canvas crops. */
  image: CanvasImageSource;
  /** UV rect, three.js convention: (u0, v0) bottom-left, (u1, v1) top-right. */
  uv: { u0: number; v0: number; u1: number; v1: number };
  /** Pixel rect on the page image (top-left origin). */
  px: { x: number; y: number; w: number; h: number };
  /** Sprite size in px (w × h) and CDDA offset relative to the 32×32 cell (see atlasTypes). */
  w: number;
  h: number;
  ox: number;
  oy: number;
  /** Clockwise quarter turns to apply (CDDA software rotation of single-sprite tiles). */
  rotate: 0 | 1 | 2 | 3;
  /** Frame index in atlas.json (-1 for generated glyphs). */
  frame: number;
}

export interface AtlasHit {
  id: string;
  subtile?: string;
  fg?: FrameRef;
  bg?: FrameRef;
}

const GLYPH_PAGE = 1024;

export class Atlas {
  readonly lookupIndex: AtlasLookup;
  readonly tileSize: number;
  private glyphCanvas: HTMLCanvasElement | null = null;
  private glyphTexture: THREE.CanvasTexture | null = null;
  private glyphCache = new Map<string, FrameRef>();
  private glyphNext = 0;
  private dataUrlCache = new Map<string, string | null>();

  constructor(
    readonly index: AtlasIndex,
    readonly pages: THREE.Texture[],
    private pageImages: CanvasImageSource[],
    private glyphSheet: CanvasImageSource,
  ) {
    this.lookupIndex = new AtlasLookup(index);
    this.tileSize = index.tileSize;
  }

  has(id: string): boolean {
    return this.lookupIndex.has(id);
  }

  frameRef(frame: number, rotate: FrameRef['rotate'] = 0): FrameRef {
    const f: AtlasFrame = this.index.frames[frame];
    const page = this.index.pages[f.page];
    return {
      texture: this.pages[f.page],
      image: this.pageImages[f.page],
      uv: { u0: f.x / page.w, u1: (f.x + f.w) / page.w, v0: 1 - (f.y + f.h) / page.h, v1: 1 - f.y / page.h },
      px: { x: f.x, y: f.y, w: f.w, h: f.h },
      w: f.w,
      h: f.h,
      ox: f.ox,
      oy: f.oy,
      rotate,
      frame,
    };
  }

  private toHit(r: LookupResult | null): AtlasHit | null {
    if (!r) return null;
    const conv = (s?: FrameSel) => (s ? this.frameRef(s.frame, s.rotate) : undefined);
    const hit: AtlasHit = { id: r.id };
    if (r.subtile) hit.subtile = r.subtile;
    const fg = conv(r.fg), bg = conv(r.bg);
    if (fg) hit.fg = fg;
    if (bg) hit.bg = bg;
    return hit;
  }

  /** Exact id (+ variant/season). Returns null when the tileset has no tile for it. */
  lookup(id: string, opts?: LookupOpts): AtlasHit | null {
    return this.toHit(this.lookupIndex.lookup(id, opts));
  }

  /** Like lookup, then follows CDDA looks_like (caller supplies the chain from game data). */
  lookupWithLooksLike(id: string, getLooksLike: (id: string) => string | undefined, opts?: LookupOpts): AtlasHit | null {
    return this.toHit(this.lookupIndex.lookupWithLooksLike(id, getLooksLike, opts));
  }

  /** A CDDA-style ASCII glyph (CP437 from the tileset's fallback.png) tinted with a CDDA
   *  color name (c_red, light_gray, …). Glyphs are drawn on demand into a shared 1024²
   *  canvas texture (1024 glyph/colour combos max); the returned ref has the same shape as
   *  sprite frames (32×32, no offset). */
  glyph(symbol: string, color: string): FrameRef {
    const key = `${symbol}\u0000${color}`;
    const hit = this.glyphCache.get(key);
    if (hit) return hit;
    const cell = this.index.glyphs.cell;
    const perRow = GLYPH_PAGE / cell;
    if (this.glyphNext >= perRow * perRow) throw new Error('glyph canvas full');
    if (!this.glyphCanvas) {
      this.glyphCanvas = document.createElement('canvas');
      this.glyphCanvas.width = this.glyphCanvas.height = GLYPH_PAGE;
      this.glyphTexture = new THREE.CanvasTexture(this.glyphCanvas);
      setupPixelTexture(this.glyphTexture);
    }
    const slot = this.glyphNext++;
    const x = (slot % perRow) * cell, y = Math.floor(slot / perRow) * cell;
    const g = glyphIndex(symbol);
    const cols = this.index.glyphs.columns;
    const [r, gg, b] = cddaColor(color);
    // Tint on a scratch cell: white glyph × colour keeps the black outline black; then
    // restore the glyph's alpha.
    const tmp = document.createElement('canvas');
    tmp.width = tmp.height = cell;
    const t = tmp.getContext('2d')!;
    t.imageSmoothingEnabled = false;
    t.drawImage(this.glyphSheet, (g % cols) * cell, Math.floor(g / cols) * cell, cell, cell, 0, 0, cell, cell);
    t.globalCompositeOperation = 'multiply';
    t.fillStyle = `rgb(${r},${gg},${b})`;
    t.fillRect(0, 0, cell, cell);
    t.globalCompositeOperation = 'destination-in';
    t.drawImage(this.glyphSheet, (g % cols) * cell, Math.floor(g / cols) * cell, cell, cell, 0, 0, cell, cell);
    const ctx = this.glyphCanvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(x, y, cell, cell);
    ctx.drawImage(tmp, x, y);
    this.glyphTexture!.needsUpdate = true;
    const ref: FrameRef = {
      texture: this.glyphTexture!,
      image: this.glyphCanvas,
      uv: { u0: x / GLYPH_PAGE, u1: (x + cell) / GLYPH_PAGE, v0: 1 - (y + cell) / GLYPH_PAGE, v1: 1 - y / GLYPH_PAGE },
      px: { x, y, w: cell, h: cell },
      w: cell,
      h: cell,
      ox: 0,
      oy: 0,
      rotate: 0,
      frame: -1,
    };
    this.glyphCache.set(key, ref);
    return ref;
  }

  /** Sprite, or a glyph when the tileset has nothing for the id (CDDA's ASCII fallback). */
  lookupOrGlyph(id: string, symbol: string, color: string, opts?: LookupOpts, getLooksLike?: (id: string) => string | undefined): AtlasHit {
    const hit = getLooksLike ? this.lookupWithLooksLike(id, getLooksLike, opts) : this.lookup(id, opts);
    return hit ?? { id, fg: this.glyph(symbol, color) };
  }

  /** Draws a frame (fg over bg, both in the 32×32 cell's coordinate frame) onto a new canvas
   *  sized to cover both sprites' extents, scaled by `scale` with nearest filtering. */
  spriteCanvas(hit: AtlasHit, scale = 1): HTMLCanvasElement {
    const refs = [hit.bg, hit.fg].filter((r): r is FrameRef => !!r);
    const ts = this.tileSize;
    let minX = 0, minY = 0, maxX = ts, maxY = ts;
    for (const r of refs) {
      minX = Math.min(minX, r.ox);
      minY = Math.min(minY, r.oy);
      maxX = Math.max(maxX, r.ox + r.w);
      maxY = Math.max(maxY, r.oy + r.h);
    }
    const c = document.createElement('canvas');
    c.width = (maxX - minX) * scale;
    c.height = (maxY - minY) * scale;
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    for (const r of refs) {
      ctx.save();
      const cx = (r.ox - minX + r.w / 2) * scale, cy = (r.oy - minY + r.h / 2) * scale;
      ctx.translate(cx, cy);
      ctx.rotate((r.rotate * Math.PI) / 2);
      ctx.drawImage(r.image, r.px.x, r.px.y, r.px.w, r.px.h, (-r.w / 2) * scale, (-r.h / 2) * scale, r.w * scale, r.h * scale);
      ctx.restore();
    }
    return c;
  }

  /** PNG data URL of an id's sprite (for inventory lists etc.), or null if no sprite. */
  spriteDataURL(id: string, opts?: LookupOpts & { scale?: number }): string | null {
    const key = `${id}|${JSON.stringify(opts ?? {})}`;
    if (this.dataUrlCache.has(key)) return this.dataUrlCache.get(key)!;
    const hit = this.lookup(id, opts);
    const url = hit ? this.spriteCanvas(hit, opts?.scale ?? 1).toDataURL() : null;
    this.dataUrlCache.set(key, url);
    return url;
  }

  /** A standalone texture holding just one sprite (fg over bg), e.g. for a UI mesh. */
  spriteTexture(id: string, opts?: LookupOpts): THREE.Texture | null {
    const hit = this.lookup(id, opts);
    if (!hit) return null;
    const tex = new THREE.CanvasTexture(this.spriteCanvas(hit));
    setupPixelTexture(tex);
    return tex;
  }
}

export function setupPixelTexture(t: THREE.Texture): void {
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
}

/**
 * UltiCa draws top-down drop shadows into many sprites (trees, cars, some monsters) as pure
 * black at ~50-75% alpha. Standing up as billboards they became black blobs hanging off tree
 * canopies, so clear them. Real outlines are opaque, so only translucent black goes.
 */
function stripDropShadows(img: HTMLImageElement): CanvasImageSource {
  if (typeof document === 'undefined') return img;
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return img;
  ctx.drawImage(img, 0, 0);
  const id = ctx.getImageData(0, 0, c.width, c.height);
  const d = id.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    if (a > 0 && a < 230 && d[i] < 12 && d[i + 1] < 12 && d[i + 2] < 12) d[i + 3] = 0;
  }
  ctx.putImageData(id, 0, 0);
  return c;
}

async function loadImage(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  await img.decode();
  return img;
}

let cached: Promise<Atlas> | null = null;

/** Loads public/atlas once (memoised). */
export function loadAtlas(baseUrl = `${import.meta.env.BASE_URL ?? '/'}atlas/`): Promise<Atlas> {
  cached ??= (async () => {
    const res = await fetch(`${baseUrl}atlas.json`);
    if (!res.ok) throw new Error(`atlas.json: HTTP ${res.status} (run npm run atlas)`);
    const index = (await res.json()) as AtlasIndex;
    if (index.version !== 1) throw new Error(`atlas.json version ${index.version} unsupported`);
    const [raw, glyphs] = await Promise.all([
      Promise.all(index.pages.map((p) => loadImage(baseUrl + p.file))),
      loadImage(baseUrl + index.glyphs.file),
    ]);
    const images = raw.map(stripDropShadows);
    const textures = images.map((img) => {
      const t = new THREE.Texture(img);
      setupPixelTexture(t);
      return t;
    });
    return new Atlas(index, textures, images, glyphs);
  })();
  return cached;
}
