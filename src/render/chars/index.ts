import type { Renderer } from '../renderer';
import type { TileFrame } from '../textureSource';
import { CharLayer, SkinStore, charUniforms } from './charLayer';
import { analyseSprite, type Img, type SpriteInfo } from './paint';

// Entry point for the 3D characters (docs/CHARACTERS.md): the display mode switch, the shared
// layers (live creatures / lying bodies) and sprite pixel access for the painter.
//
//   ?chars=model|billboard       URL (wins for the session)
//   Options → Creatures          persisted in localStorage
//   cdda.chars('billboard')      debug console; cdda.chars({ fps: 12, far: [16, 45] }) tweaks

export type CharMode = 'model' | 'billboard';
const STORAGE_KEY = 'cdda3d.chars';

function initialMode(): CharMode {
  const p = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('chars') : null;
  if (p === 'model' || p === 'billboard') return p;
  if (p) throw new Error(`?chars=${p}: expected model or billboard`);
  try {
    const s = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    if (s === 'model' || s === 'billboard') return s;
  } catch {
    // storage blocked: default
  }
  return 'model';
}

const VM_KEY = 'cdda3d.viewmodel';
function initialViewmodel(): 'model' | 'sprite' {
  const p = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('viewmodel') : null;
  if (p === 'model' || p === 'sprite') return p;
  if (p) throw new Error(`?viewmodel=${p}: expected model or sprite`);
  try {
    const s = typeof localStorage !== 'undefined' ? localStorage.getItem(VM_KEY) : null;
    if (s === 'model' || s === 'sprite') return s;
  } catch {
    // storage blocked: default
  }
  // The user's pick (style gallery, 2026-09-30): the flat pixel hands read cleaner than the 3D ones.
  return 'sprite';
}

export function setViewmodelMode(m: 'model' | 'sprite'): void {
  if (m !== 'model' && m !== 'sprite') throw new Error(`viewmodel mode: ${m}`);
  charSettings.viewmodel = m;
  try {
    localStorage.setItem(VM_KEY, m);
  } catch {
    // not persisted
  }
}

export const charSettings = {
  mode: initialMode(),
  /** pose updates per second (Shadowglass-style stepped animation); 0 = every frame */
  fps: 10,
  /** draw bows/slingshots in 3D too (off: the 2D bowArt sprite reads better) */
  fpBow: false,
  /** first-person hands: 3D (fpView.ts) or the sprite viewmodel (?viewmodel=sprite) */
  viewmodel: initialViewmodel(),
  /** people's skins: styled.ts (default) or the projected sprite (?charpaint=sprite) */
  paint: (typeof location !== 'undefined' && new URLSearchParams(location.search).get('charpaint') === 'sprite' ? 'sprite' : 'styled') as 'styled' | 'sprite',
  listeners: [] as ((m: CharMode) => void)[],
};

export function setCharMode(m: CharMode): void {
  if (m !== 'model' && m !== 'billboard') throw new Error(`chars mode: ${m}`);
  if (m === charSettings.mode) return;
  charSettings.mode = m;
  try {
    localStorage.setItem(STORAGE_KEY, m);
  } catch {
    // not persisted
  }
  for (const f of charSettings.listeners) f(m);
}

/** Debug entry (cdda.chars): mode string, or a tweak object; returns the current settings. */
export function charsApi(arg?: CharMode | { fps?: number; far?: [number, number]; emph?: number; paint?: 'styled' | 'sprite'; viewmodel?: 'model' | 'sprite'; fpBow?: boolean }): Record<string, unknown> {
  if (typeof arg === 'string') setCharMode(arg);
  else if (arg) {
    if (arg.viewmodel) setViewmodelMode(arg.viewmodel);
    if (arg.fpBow !== undefined) charSettings.fpBow = arg.fpBow;
    if (arg.paint) {
      if (arg.paint !== 'styled' && arg.paint !== 'sprite') throw new Error(`chars paint: ${arg.paint}`);
      charSettings.paint = arg.paint;
      if (layersIfAny) layersIfAny.store.style = arg.paint;
      // repaint: every view rebuilds its visuals (skins are keyed by style)
      for (const f of charSettings.listeners) f(charSettings.mode);
    }
    if (arg.fps !== undefined) charSettings.fps = arg.fps;
    if (arg.far) (charUniforms.uFarNear.value = arg.far[0], charUniforms.uFarFar.value = arg.far[1]);
    if (arg.emph !== undefined) charUniforms.uEmphK.value = arg.emph;
  }
  const L = layersIfAny;
  return {
    mode: charSettings.mode, paint: charSettings.paint, viewmodel: charSettings.viewmodel, fps: charSettings.fps, far: [charUniforms.uFarNear.value, charUniforms.uFarFar.value], emph: charUniforms.uEmphK.value,
    live: L?.live.count ?? 0, bodies: L?.dead.count ?? 0, skins: L?.store.skinCount ?? 0, pages: L?.store.pageCount ?? 0,
  };
}

export interface CharLayers {
  store: SkinStore;
  /** moving creatures: rewritten every frame */
  live: CharLayer;
  /** corpses: rewritten only on change */
  dead: CharLayer;
}

let layersIfAny: CharLayers | null = null;
const perRenderer = new WeakMap<Renderer, CharLayers>();

/** The character layers for a renderer (created on first use, flushed before each frame). */
export function charLayers(renderer: Renderer): CharLayers {
  let L = perRenderer.get(renderer);
  if (L) return L;
  const store = new SkinStore();
  store.style = charSettings.paint;
  const live = new CharLayer(true, 'chars-live');
  const dead = new CharLayer(true, 'chars-dead');
  for (const l of [live, dead]) {
    l.groundAt = (x, y, z) => renderer.groundAt?.(x, y, z) ?? 0;
    l.skyVisAt = (x, y, z) => renderer.sprites.skyVisAt?.(x, y, z) ?? 1;
    renderer.scene.add(l.group);
  }
  renderer.beforeRender.push((dt) => {
    live.flush(dt, store);
    dead.flush(dt, store);
  });
  L = { store, live, dead };
  perRenderer.set(renderer, L);
  layersIfAny = L;
  return L;
}

// ------------------------------------------------------------------ sprite pixels

const infoCache = new Map<string, SpriteInfo | null>();

/** Stable key for a sprite frame's pixels. */
export function frameKey(f: TileFrame): string {
  return `${f.texture.uuid}:${f.uv.map((v) => v.toFixed(5)).join(',')}`;
}

/** Read a frame's pixels (atlas page or composite canvas) and analyse them; memoised. */
export function spriteInfo(f: TileFrame): SpriteInfo | null {
  const key = frameKey(f);
  if (infoCache.has(key)) return infoCache.get(key)!;
  let res: SpriteInfo | null = null;
  const img = f.texture.image as (CanvasImageSource & { width: number; height: number }) | undefined;
  if (img && img.width && typeof document !== 'undefined') {
    const [u0, v0, u1, v1] = f.uv;
    const x = Math.round(Math.min(u0, u1) * img.width), w = Math.max(1, Math.round(Math.abs(u1 - u0) * img.width));
    // three.js UVs have v at the bottom (flipY): image row = (1 - v) * height
    const y = Math.round((1 - Math.max(v0, v1)) * img.height), h = Math.max(1, Math.round(Math.abs(v1 - v0) * img.height));
    try {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const g = c.getContext('2d', { willReadFrequently: true })!;
      // a flipped frame (u1 < u0) is the mirror image
      if (u1 < u0) (g.translate(w, 0), g.scale(-1, 1));
      g.drawImage(img, x, y, w, h, 0, 0, w, h);
      const d = g.getImageData(0, 0, w, h);
      const im: Img = { w, h, data: d.data };
      res = analyseSprite(im);
    } catch (e) {
      console.warn('chars: cannot read sprite pixels', e);
    }
  }
  infoCache.set(key, res);
  return res;
}
