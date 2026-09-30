import * as THREE from 'three';
import type { Img } from '../pixelArt';
import type { TileFrame } from '../textureSource';

// Texture pages for the modelled furniture (docs/FURNITURE.md). Every face of a model gets a
// frame painted at its exact size in texels (32 per metre), so bevels, drawer lines and
// book spines sit where the geometry is. Frames are memoised by key and shelf-packed into
// 1024x1024 DataTexture pages; a new page opens when one fills (one more draw call per
// chunk, which the per-page meshing already handles).

const PAGE = 1024;
/** Border texels copied from each frame's edge: nearest sampling and the first mip levels
 *  at a frame edge read its own colour instead of a neighbour's. */
const GUTTER = 2;

interface Page {
  tex: THREE.DataTexture;
  px: Uint8Array;
  /** open shelf per height class (frames come in wildly different heights: drawer lines
   *  next to 2 m wardrobe sides would waste most of a shared shelf) */
  shelves: Map<number, { x: number; y: number; h: number }>;
  nextY: number;
}

export class ModelAtlas {
  private pages: Page[] = [];
  private frames = new Map<string, TileFrame>();
  private uploadQueued = new Set<Page>();
  /** texels packed so far (perf stats / tests) */
  texels = 0;

  get pageCount(): number {
    return this.pages.length;
  }
  get frameCount(): number {
    return this.frames.size;
  }

  frame(key: string, paint: () => Img): TileFrame {
    let f = this.frames.get(key);
    if (f) return f;
    const img = paint();
    if (img.w < 1 || img.h < 1) throw new Error(`ModelAtlas: empty frame ${key}`);
    if (img.w + GUTTER * 2 > PAGE || img.h + GUTTER * 2 > PAGE) throw new Error(`ModelAtlas: frame ${key} too big (${img.w}x${img.h})`);
    const [page, x, y] = this.alloc(img.w + GUTTER * 2, img.h + GUTTER * 2);
    // Image rows are top-down; the page is bottom-up (flipY=false DataTexture, v0 = bottom).
    const W = img.w + GUTTER * 2, H = img.h + GUTTER * 2;
    for (let gy = 0; gy < H; gy++) {
      const iy = Math.min(img.h - 1, Math.max(0, gy - GUTTER));
      const row = (y + H - 1 - gy) * PAGE + x;
      for (let gx = 0; gx < W; gx++) {
        const ix = Math.min(img.w - 1, Math.max(0, gx - GUTTER));
        const s = (iy * img.w + ix) * 4, d = (row + gx) * 4;
        page.px[d] = img.data[s];
        page.px[d + 1] = img.data[s + 1];
        page.px[d + 2] = img.data[s + 2];
        page.px[d + 3] = img.data[s + 3];
      }
    }
    this.texels += W * H;
    this.queueUpload(page);
    const u0 = (x + GUTTER) / PAGE, v0 = (y + GUTTER) / PAGE;
    f = { texture: page.tex, uv: [u0, v0, u0 + img.w / PAGE, v0 + img.h / PAGE], w: img.w, h: img.h, ppm: 32 };
    this.frames.set(key, f);
    return f;
  }

  /** Re-upload coalesced to once per animation frame: a chunk build paints dozens of faces. */
  private queueUpload(p: Page): void {
    if (typeof requestAnimationFrame === 'undefined') {
      p.tex.needsUpdate = true;
      return;
    }
    if (this.uploadQueued.has(p)) return;
    this.uploadQueued.add(p);
    requestAnimationFrame(() => {
      this.uploadQueued.delete(p);
      p.tex.needsUpdate = true;
    });
  }

  private newPage(): Page {
    const px = new Uint8Array(PAGE * PAGE * 4);
    const tex = new THREE.DataTexture(px, PAGE, PAGE, THREE.RGBAFormat);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.name = `furniture page ${this.pages.length}`;
    tex.needsUpdate = true;
    const p: Page = { tex, px, shelves: new Map(), nextY: 0 };
    this.pages.push(p);
    return p;
  }

  private alloc(w: number, h: number): [Page, number, number] {
    const cls = h <= 6 ? 6 : h <= 10 ? 10 : h <= 18 ? 18 : h <= 34 ? 34 : h <= 66 ? 66 : h;
    for (let attempt = 0; attempt < 2; attempt++) {
      const p = this.pages[this.pages.length - 1] ?? this.newPage();
      let sh = p.shelves.get(cls);
      if (sh && sh.x + w > PAGE) sh = undefined;
      if (!sh) {
        if (p.nextY + cls > PAGE) {
          this.newPage();
          continue;
        }
        sh = { x: 0, y: p.nextY, h: cls };
        p.nextY += cls;
        p.shelves.set(cls, sh);
      }
      const r: [Page, number, number] = [p, sh.x, sh.y];
      sh.x += w;
      return r;
    }
    throw new Error(`ModelAtlas: cannot place ${w}x${h}`);
  }
}
