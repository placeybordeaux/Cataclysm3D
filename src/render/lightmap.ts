import * as THREE from 'three';
import type { GameMap } from '../world/map';
import { CHUNK, LEVEL_HEIGHT, MAX_Z } from '../world/coords';
import { hasFlag } from '../world/registry';
import { displayIrradiance, LightField, type LightSource } from './lightfield';
import { terrainShape } from './tileKinds';

// GPU side of the CDDA-style light map (see lightfield.ts for the model):
//  - builds the LightField for the player's z-level from chunk data (opacity, open sky,
//    light_emitted terrain/furniture, fire fields, lit items, dynamic light handles)
//  - uploads it as a SIZE x SIZE float texture: rgb = artificial irradiance (display curve
//    applied), a = natural light fraction, or -1 for opaque tiles so the shader's masked
//    bilinear filter never interpolates light *through* a wall
//  - uploads a "cover height" texture (highest floor/roof above each tile) so rain stops
//    at roofs
// Rebuilds are throttled: natural light only when map chunks/window/level change, artificial
// light at most `hz` times a second, and only when sources changed or something flickers.

export const LM_SIZE = 128;
/** The window re-centres in steps of this many tiles (fewer full rebuilds while walking). */
const SNAP = 16;

/** Brightness of the flat (light-map) share of artificial light, see displayIrradiance. */
export const FLAT_SCALE = 1.8;

/** Fire field luminance by intensity (CDDA field_type fd_fire light_emitted). */
const FIRE_LUM = [0, 20, 60, 160];

/** Uniforms shared by every patched material (materials.ts reads them by reference). */
export const lmUniforms = {
  tLightMap: { value: null as THREE.Texture | null },
  /** x, y = world tile of texel (0,0); z = size; w = 1 when valid */
  uLmRect: { value: new THREE.Vector4(0, 0, LM_SIZE, 0) },
  /** floor Y of the mapped level and level height */
  uLmLevel: { value: new THREE.Vector2(0, LEVEL_HEIGHT) },
  tCover: { value: null as THREE.Texture | null },
};

import type { StaticLight } from './lights';

export interface DynamicLight {
  x: number;
  y: number;
  z: number;
  /** CDDA-ish luminance */
  lum: number;
  color: number;
  flicker: boolean;
  phase: number;
}

interface IdCache {
  opaque: Uint8Array;
  lum: Float32Array;
  none: Uint8Array;
  n: number;
}

export class LightMap {
  readonly field = new LightField(LM_SIZE);
  readonly texture: THREE.DataTexture;
  readonly cover: THREE.DataTexture;
  z = 0;
  /** Current outdoor light level in CDDA units (sun + moon), set by the renderer. */
  naturalLevel = 100;
  /** Debug: false makes the shaders ignore the map (sky-share fallback, ungated lights). */
  enabled = true;
  /** Max artificial rebuilds per second (flicker rate). */
  hz = 10;
  /** Lit items: return a luminance for items that glow (hook for the items system). */
  itemLight: ((item: unknown) => number) | null = (it) => defaultItemLight(it);
  readonly stats = { naturalMs: 0, artificialMs: 0, sources: 0, rebuilds: 0 };
  private data: Float32Array;
  private coverData: Float32Array;
  private ter: IdCache = { opaque: new Uint8Array(0), lum: new Float32Array(0), none: new Uint8Array(0), n: 0 };
  private furn: IdCache = { opaque: new Uint8Array(0), lum: new Float32Array(0), none: new Uint8Array(0), n: 0 };
  private natSig = NaN;
  private artSig = NaN;
  private artT = 0;
  private flickering = false;
  private sources: LightSource[] = [];
  /** Tile sources of the last collection (new array whenever it is rebuilt). */
  statics: StaticLight[] = [];
  private valid = false;

  constructor(private map: GameMap) {
    this.data = new Float32Array(LM_SIZE * LM_SIZE * 4);
    this.texture = new THREE.DataTexture(this.data, LM_SIZE, LM_SIZE, THREE.RGBAFormat, THREE.FloatType);
    this.texture.magFilter = this.texture.minFilter = THREE.NearestFilter;
    this.texture.generateMipmaps = false;
    this.coverData = new Float32Array(LM_SIZE * LM_SIZE);
    this.cover = new THREE.DataTexture(this.coverData, LM_SIZE, LM_SIZE, THREE.RedFormat, THREE.FloatType);
    this.cover.magFilter = this.cover.minFilter = THREE.NearestFilter;
    this.cover.generateMipmaps = false;
    lmUniforms.tLightMap.value = this.texture;
    lmUniforms.tCover.value = this.cover;
  }

  private ids(kind: 'ter' | 'furn'): IdCache {
    const reg = kind === 'ter' ? this.map.terrain : this.map.furniture;
    const c = kind === 'ter' ? this.ter : this.furn;
    const n = reg.defs.length;
    if (c.n === n) return c;
    const opaque = new Uint8Array(n), lum = new Float32Array(n), none = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const d = reg.defs[i] as any;
      lum[i] = d.light_emitted ?? 0;
      if (kind === 'ter') {
        opaque[i] = d.id !== 't_null' && !hasFlag(d, 'TRANSPARENT') ? 1 : 0;
        none[i] = terrainShape(d) === 'none' ? 1 : 0;
      } else {
        opaque[i] = d.id !== 'f_null' && !hasFlag(d, 'TRANSPARENT') ? 1 : 0;
      }
    }
    const out = { opaque, lum, none, n };
    if (kind === 'ter') this.ter = out; else this.furn = out;
    return out;
  }

  /** Chunk-version signature of everything the natural pass reads. */
  private naturalSignature(ox: number, oy: number, z: number): number {
    let sig = (ox * 73856093) ^ (oy * 19349663) ^ (z * 83492791);
    const c0x = Math.floor(ox / CHUNK), c0y = Math.floor(oy / CHUNK);
    const c1x = Math.floor((ox + LM_SIZE - 1) / CHUNK), c1y = Math.floor((oy + LM_SIZE - 1) / CHUNK);
    for (let dz = 0; dz <= 3; dz++)
      for (let cy = c0y; cy <= c1y; cy++)
        for (let cx = c0x; cx <= c1x; cx++) {
          const has = this.map.hasChunk(cx, cy, z + dz);
          const v = has ? this.map.chunk(cx, cy, z + dz)!.version + 1 : 0;
          sig = (Math.imul(sig, 31) + v) | 0;
        }
    return sig;
  }

  /**
   * Keep the map current. `dynamic` are renderer light handles (lights.add), `time` is the
   * renderer clock in seconds (drives fire flicker). Returns true if the texture changed.
   */
  update(px: number, py: number, pz: number, dt: number, time: number, dynamic: Iterable<DynamicLight>, force = false): boolean {
    const ox = Math.floor(px / SNAP) * SNAP - LM_SIZE / 2 + SNAP / 2;
    const oy = Math.floor(py / SNAP) * SNAP - LM_SIZE / 2 + SNAP / 2;
    const f = this.field;
    let changed = false;
    const nsig = this.naturalSignature(ox, oy, pz);
    if (nsig !== this.natSig || !this.valid) {
      const t0 = performance.now();
      f.ox = ox; f.oy = oy;
      this.z = pz;
      this.buildGrid();
      f.computeNatural();
      this.natSig = nsig;
      this.stats.naturalMs = performance.now() - t0;
      this.artSig = NaN; // grid changed: occlusion of every source may have changed
      changed = true;
      this.valid = true;
    }
    this.artT += dt;
    const due = this.artT >= 1 / this.hz;
    if (due || force || Number.isNaN(this.artSig)) {
      const sources = this.collectSources(dynamic, time);
      let sig = sources.length;
      for (const s of sources) sig = (Math.imul(sig, 31) + ((s.x * 7919 + s.y * 104729) ^ Math.round(s.lum * 16))) | 0;
      if (sig !== this.artSig || this.flickering) {
        const t0 = performance.now();
        f.computeArtificial(sources);
        this.artSig = sig;
        this.stats.artificialMs = performance.now() - t0;
        this.stats.sources = sources.length;
        changed = true;
      }
      this.artT = 0;
    }
    if (changed) this.upload();
    lmUniforms.uLmRect.value.set(f.ox, f.oy, LM_SIZE, this.enabled ? 1 : 0);
    lmUniforms.uLmLevel.value.set(this.z * LEVEL_HEIGHT, LEVEL_HEIGHT);
    return changed;
  }

  /** Force a full rebuild next update (texture source swap, save loaded). */
  invalidate(): void {
    this.valid = false;
  }

  private buildGrid(): void {
    const f = this.field, S = LM_SIZE, z = this.z;
    const ter = this.ids('ter'), furn = this.ids('furn');
    f.opaque.fill(0);
    f.outside.fill(1);
    this.coverData.fill(z * LEVEL_HEIGHT);
    const c0x = Math.floor(f.ox / CHUNK), c0y = Math.floor(f.oy / CHUNK);
    const c1x = Math.floor((f.ox + S - 1) / CHUNK), c1y = Math.floor((f.oy + S - 1) / CHUNK);
    for (let cy = c0y; cy <= c1y; cy++)
      for (let cx = c0x; cx <= c1x; cx++) {
        const here = this.map.hasChunk(cx, cy, z) ? this.map.chunk(cx, cy, z) : null;
        const above: ({ ter: Uint16Array } | null)[] = [];
        for (let dz = 1; dz <= 3 && z + dz <= MAX_Z; dz++) above.push(this.map.hasChunk(cx, cy, z + dz) ? this.map.chunk(cx, cy, z + dz) : null);
        for (let ly = 0; ly < CHUNK; ly++) {
          const gy = cy * CHUNK + ly - f.oy;
          if (gy < 0 || gy >= S) continue;
          for (let lx = 0; lx < CHUNK; lx++) {
            const gx = cx * CHUNK + lx - f.ox;
            if (gx < 0 || gx >= S) continue;
            const li = ly * CHUNK + lx, gi = gy * S + gx;
            if (here) {
              const ti = here.ter[li], fi = here.furn[li];
              f.opaque[gi] = ter.opaque[ti] || furn.opaque[fi] ? 1 : 0;
            }
            for (let k = 0; k < above.length; k++) {
              const a = above[k];
              if (!a || ter.none[a.ter[li]]) continue;
              if (k === 0) f.outside[gi] = 0;
              this.coverData[gi] = (z + k + 1) * LEVEL_HEIGHT;
            }
          }
        }
      }
  }

  private collectSources(dynamic: Iterable<DynamicLight>, time: number): LightSource[] {
    const out = this.sources;
    out.length = 0;
    const statics: StaticLight[] = [];
    const f = this.field, S = LM_SIZE, z = this.z;
    const ter = this.ids('ter'), furn = this.ids('furn');
    let flicker = false;
    const c0x = Math.floor(f.ox / CHUNK), c0y = Math.floor(f.oy / CHUNK);
    const c1x = Math.floor((f.ox + S - 1) / CHUNK), c1y = Math.floor((f.oy + S - 1) / CHUNK);
    const inside = (x: number, y: number) => x >= f.ox && y >= f.oy && x < f.ox + S && y < f.oy + S;
    for (let cy = c0y; cy <= c1y; cy++)
      for (let cx = c0x; cx <= c1x; cx++) {
        if (!this.map.hasChunk(cx, cy, z)) continue;
        const c = this.map.chunk(cx, cy, z)!;
        const bx = cx * CHUNK, by = cy * CHUNK;
        for (let li = 0; li < CHUNK * CHUNK; li++) {
          const l = ter.lum[c.ter[li]] + furn.lum[c.furn[li]];
          if (l > 0) {
            const x = bx + (li % CHUNK), y = by + Math.floor(li / CHUNK);
            if (!inside(x, y)) continue;
            out.push({ x, y, lum: l, r: 1, g: 0.86, b: 0.66 });
            statics.push({ x, y, z, lum: l, color: 0xffdba8, flicker: false, height: ter.lum[c.ter[li]] > 0 ? 2.2 : 1.2 });
          }
        }
        for (const [li, list] of c.fields) {
          for (const fd of list) {
            if (fd.type !== 'fd_fire') continue;
            const x = bx + (li % CHUNK), y = by + Math.floor(li / CHUNK);
            if (!inside(x, y)) continue;
            const base = FIRE_LUM[Math.max(1, Math.min(3, fd.intensity))];
            out.push({ x, y, lum: base * flickerAt(time, x, y), r: 1, g: 0.6, b: 0.25 });
            statics.push({ x, y, z, lum: base, color: 0xff9a40, flicker: true, height: 0.6 });
            flicker = true;
          }
        }
        if (this.itemLight)
          for (const [li, list] of c.items) {
            let lum = 0;
            for (const it of list) lum += this.itemLight(it);
            if (lum <= 0) continue;
            const x = bx + (li % CHUNK), y = by + Math.floor(li / CHUNK);
            if (!inside(x, y)) continue;
            out.push({ x, y, lum, r: 1, g: 0.92, b: 0.8 });
            statics.push({ x, y, z, lum, color: 0xffecc8, flicker: false, height: 0.3 });
          }
      }
    for (const d of dynamic) {
      if (d.z !== z) continue;
      const x = Math.floor(d.x), y = Math.floor(d.y);
      if (!inside(x, y) || d.lum <= 0) continue;
      const k = d.flicker ? flickerAt(time, x + d.phase, y) : 1;
      if (d.flicker) flicker = true;
      out.push({ x, y, lum: d.lum * k, r: ((d.color >> 16) & 255) / 255, g: ((d.color >> 8) & 255) / 255, b: (d.color & 255) / 255 });
    }
    this.flickering = flicker;
    // keep the previous array (identity) when nothing changed, so consumers can skip work
    if (!sameStatics(statics, this.statics)) this.statics = statics;
    return out;
  }

  private upload(): void {
    const f = this.field, d = this.data, n = LM_SIZE * LM_SIZE;
    for (let i = 0; i < n; i++) {
      const r = f.disp[i * 3], g = f.disp[i * 3 + 1], b = f.disp[i * 3 + 2];
      const m = Math.max(r, g, b);
      // Curve the brightest channel and scale the others with it so hue is preserved.
      // the flat term is the soft part of lamp light; gated point lights add the pools
      const k = m > 0 ? displayIrradiance(m, FLAT_SCALE) / m : 0;
      d[i * 4] = r * k;
      d[i * 4 + 1] = g * k;
      d[i * 4 + 2] = b * k;
      d[i * 4 + 3] = f.opaque[i] ? -1 : f.natural[i];
    }
    this.texture.needsUpdate = true;
    this.cover.needsUpdate = true;
    this.stats.rebuilds++;
  }

  /** lightAt restricted to the mapped window on the mapped level; null elsewhere. */
  exactLightAt(x: number, y: number, z: number): number | null {
    if (!this.valid || z !== this.z) return null;
    const tx = Math.floor(x), ty = Math.floor(y);
    const i = this.field.index(tx, ty);
    return i >= 0 ? this.field.natural[i] * this.naturalLevel + this.field.artificialAt(tx, ty) : null;
  }

  /**
   * CDDA-style light level at a tile, in CDDA luminance units (compare with lightmap.h:
   * LIGHT_AMBIENT_LOW 3.5, LIGHT_AMBIENT_DIM 5, LIGHT_AMBIENT_LIT 10; daylight ~100).
   * Outside the mapped window/level it falls back to "outdoors unless something is
   * overhead". Gameplay can use it for vision/stealth.
   */
  lightAt(x: number, y: number, z: number): number {
    const exact = this.exactLightAt(x, y, z);
    if (exact !== null) return exact;
    const tx = Math.floor(x), ty = Math.floor(y);
    const covered = terrainShape(this.map.terAt(tx, ty, z + 1)) !== 'none';
    return (covered ? this.field.indoorAmbient : 1) * this.naturalLevel;
  }
}

function sameStatics(a: StaticLight[], b: StaticLight[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i].x !== b[i].x || a[i].y !== b[i].y || a[i].lum !== b[i].lum) return false;
  return true;
}

/** Cheap deterministic flicker in 0.7..1.05 (two incommensurate sines per position). */
function flickerAt(t: number, x: number, y: number): number {
  const p = x * 12.9898 + y * 78.233;
  return 0.87 + 0.1 * Math.sin(t * 9.1 + p) + 0.07 * Math.sin(t * 23.3 + p * 1.7);
}

/** Items glow when they carry a CDDA LIGHT_<n> flag (lit flashlights, candles, lanterns). */
const itemLum = new WeakMap<object, number>();
function defaultItemLight(it: unknown): number {
  const def = (it as any)?.def as { flags?: string[] } | undefined;
  if (!def) return 0;
  let n = itemLum.get(def);
  if (n === undefined) {
    n = 0;
    for (const f of def.flags ?? []) if (f.startsWith('LIGHT_')) n = Math.max(n, Number(f.slice(6)) || 0);
    itemLum.set(def, n);
  }
  return n;
}

/** CDDA sun_light_at() from the sun's altitude, plus a quarter-moon's light at night. */
export function naturalLightLevel(sunAltitudeRad: number, moon = 2.5): number {
  const a = (sunAltitudeRad * 180) / Math.PI;
  let sun: number;
  if (a < -18) sun = 0;
  else if (a <= -12) sun = 3.7 * (2 ** ((a + 18) / 6) - 1);
  else if (a <= -6) sun = 1.3 * (2 ** ((a + 12) / 6) - 1) + 3.7;
  else if (a <= -1) sun = 55 * (2 ** ((a + 6) / 5) - 1) + 5;
  else if (a <= 60) sun = (65 / 61) * a + 65 / 61 + 60;
  else sun = 125;
  return sun + moon;
}
