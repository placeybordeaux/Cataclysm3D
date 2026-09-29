import * as THREE from 'three';
import { CHUNK, LEVEL_HEIGHT } from '../world/coords';
import type { GameMap } from '../world/map';
import { frameAverage } from './framePixels';
import { hash2, type GroundField } from './ground';
import { instancedLitMaterial } from './materials';
import type { TileTextureSource } from './textureSource';
import { runSteps, stepUntil } from './steps';

// Dense grass (look.ts `grass`): world-fixed crossed cards of pixel-art blades around the
// player, several per tile, swaying in the wind. Unlike the classic billboard tufts they
// don't turn with the camera, so walking through a field shows parallax and layering.
// Cards take their colour from the tile's own floor sprite (so they match the atlas grass
// and the season), are lit with an upward normal like the ground under them (t3ssel8r's
// trick: grass shades as a surface, not as a pile of thin quads), receive shadows and
// sample the light map at their root. Rebuilt around the player every few tiles; cards
// shrink to nothing toward the edge of the radius so the rebuild never pops. A rebuild is
// ~20k cards (5-12 ms), so it is time-sliced (`budgetMs` per frame, per row of tiles) and
// the previous field stays until the new one is complete.

interface Kind {
  n: number;
  h0: number;
  h1: number;
  w: number;
  /** colour multiplier (blades catch more light than the flat ground sprite shows) */
  bright: number;
}

const KINDS: Record<string, Kind> = {
  lawn: { n: 7, h0: 0.16, h1: 0.3, w: 0.42, bright: 1.5 },
  long: { n: 11, h0: 0.32, h1: 0.55, w: 0.5, bright: 1.45 },
  tall: { n: 12, h0: 0.55, h1: 0.95, w: 0.55, bright: 1.4 },
  dead: { n: 9, h0: 0.25, h1: 0.45, w: 0.48, bright: 1.45 },
  brush: { n: 8, h0: 0.35, h1: 0.6, w: 0.55, bright: 1.3 },
  sparse: { n: 2, h0: 0.12, h1: 0.24, w: 0.35, bright: 1.45 },
  under: { n: 4, h0: 0.18, h1: 0.32, w: 0.42, bright: 1.4 },
};

function kindOf(id: string): Kind | null {
  if (/^t_grass_tall|^t_grass_long_tall/.test(id)) return KINDS.tall;
  if (/^t_grass_long/.test(id)) return KINDS.long;
  if (/^t_grass_dead|^t_grass_dry/.test(id)) return KINDS.dead;
  if (/^t_grass($|_golf|_white|_alien)/.test(id)) return KINDS.lawn;
  if (/^t_(underbrush|fern|brush)/.test(id)) return KINDS.brush;
  if (/^t_(dirt|moss)$/.test(id)) return KINDS.sparse;
  return null;
}

const TEX = 32;
function bladeTexture(): THREE.DataTexture {
  const d = new Uint8Array(TEX * TEX * 4);
  const set = (x: number, y: number, v: number) => {
    if (x < 0 || x >= TEX || y < 0 || y >= TEX) return;
    const i = (y * TEX + x) * 4; // DataTexture row 0 = bottom
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  };
  for (let b = 0; b < 13; b++) {
    const r = (k: number) => hash2(b, k, 5150) / 4294967296;
    let x = 2 + r(1) * (TEX - 4);
    const h = Math.floor(TEX * (0.45 + r(2) * 0.55));
    const lean = (r(3) - 0.5) * 0.7;
    const wide = r(4) < 0.35;
    for (let y = 0; y < h; y++) {
      const t = y / h;
      // dark roots, light tips: the instance colour carries the hue
      const v = Math.round(255 * (0.62 + 0.38 * t) * (0.88 + r(5) * 0.12));
      set(Math.round(x), y, v);
      if (wide && t < 0.6) set(Math.round(x) + 1, y, Math.round(v * 0.85));
      x += lean * (0.3 + t);
    }
  }
  const t = new THREE.DataTexture(d, TEX, TEX, THREE.RGBAFormat);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/** Two crossed unit cards standing on y = 0 (x in [-0.5, 0.5], y in [0, 1]). */
function crossGeometry(): THREE.BufferGeometry {
  const a = new THREE.PlaneGeometry(1, 1);
  a.translate(0, 0.5, 0);
  const b = a.clone();
  b.rotateY(Math.PI / 2);
  const g = new THREE.BufferGeometry();
  const merge = (name: string, n: number) => {
    const x = a.getAttribute(name).array as Float32Array, y = b.getAttribute(name).array as Float32Array;
    const out = new Float32Array(x.length + y.length);
    out.set(x);
    out.set(y, x.length);
    g.setAttribute(name, new THREE.BufferAttribute(out, n));
  };
  merge('position', 3);
  merge('normal', 3);
  merge('uv', 2);
  const ia = a.getIndex()!.array;
  const idx: number[] = [...ia, ...Array.from(ia, (v) => v + 4)];
  g.setIndex(idx);
  return g;
}

export class GrassLayer {
  readonly group = new THREE.Group();
  enabled = false;
  radius = 22;
  private step = 5;
  private mesh: THREE.InstancedMesh | null = null;
  private cx = NaN;
  private cy = NaN;
  private cz = NaN;
  private season = '';
  private sig = 0;
  private geo = crossGeometry();
  private mat: THREE.MeshLambertMaterial;
  private uRadius = { value: 22 };
  /** Max ms per frame spent rebuilding (the field lags a few frames behind, unseen). */
  budgetMs = 1.5;
  private job: Generator<void, void> | null = null;

  constructor(private ground: GroundField) {
    this.group.name = 'grass';
    const map = bladeTexture();
    this.mat = instancedLitMaterial({ map, alphaTest: 0.5, side: THREE.DoubleSide }, {
      key: 'grass',
      uniforms: { uGrassR: this.uRadius },
      pars: 'uniform float uGrassR;\n',
      // lit like the ground it grows from
      normal: 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);\n#ifdef USE_TANGENT\nvec3 objectTangent = vec3(1.0, 0.0, 0.0);\n#endif\n',
      vertex: `
        vec3 ip = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        float sway = sin(uTime * 1.7 + ip.x * 0.83 + ip.z * 0.61) + 0.5 * sin(uTime * 2.9 + ip.x * 1.7);
        transformed.x += sway * 0.07 * position.y * position.y;
        float dcam = length(ip.xz - cameraPosition.xz);
        transformed *= 1.0 - smoothstep(uGrassR - 7.0, uGrassR - 1.5, dcam);
      `,
      lmLift: 0.3,
      outline: 0,
    }).mat;
  }

  get count(): number {
    return this.mesh?.count ?? 0;
  }

  invalidate(): void {
    this.cx = NaN;
    this.job = null;
  }

  private chunkSig(map: GameMap, px: number, py: number, pz: number): number {
    let sig = 0;
    const r = this.radius + this.step;
    for (let cy = Math.floor((py - r) / CHUNK); cy <= Math.floor((py + r) / CHUNK); cy++)
      for (let cx = Math.floor((px - r) / CHUNK); cx <= Math.floor((px + r) / CHUNK); cx++) {
        const v = map.hasChunk(cx, cy, pz) ? map.chunk(cx, cy, pz)!.version + 1 : 0;
        sig = (Math.imul(sig, 31) + v) | 0;
      }
    return sig;
  }

  update(map: GameMap, px: number, py: number, pz: number, season: string, src: TileTextureSource): void {
    if (!this.enabled) {
      this.clear();
      this.job = null;
      return;
    }
    if (this.job) {
      if (stepUntil(this.job, performance.now() + this.budgetMs).done) this.job = null;
      return;
    }
    const moved = Number.isNaN(this.cx) || Math.hypot(px - this.cx, py - this.cy) > this.step || pz !== this.cz;
    const sig = moved ? 0 : this.chunkSig(map, this.cx, this.cy, pz);
    if (!moved && season === this.season && sig === this.sig) return;
    // a teleport, level change or look switch: build at once rather than show the old field
    const jump = Number.isNaN(this.cx) || pz !== this.cz || Math.hypot(px - this.cx, py - this.cy) > this.step * 3;
    this.cx = Math.floor(px) + 0.5;
    this.cy = Math.floor(py) + 0.5;
    this.cz = pz;
    this.season = season;
    this.sig = this.chunkSig(map, this.cx, this.cy, pz);
    const gen = this.rebuild(map, src);
    if (jump) runSteps(gen);
    else this.job = gen;
  }

  private clear(): void {
    if (this.mesh) {
      this.group.remove(this.mesh);
      this.mesh.dispose();
      this.mesh = null;
    }
  }

  private *rebuild(map: GameMap, src: TileTextureSource): Generator<void, void> {
    const R = this.radius + this.step, z = this.cz;
    this.uRadius.value = this.radius + this.step;
    const x0 = Math.floor(this.cx), y0 = Math.floor(this.cy);
    // instance matrices written directly (yaw rotation * scale + translation): composing
    // Matrix4s and spreading their elements made each rebuild a visible hitch
    let cap = 4096, n = 0;
    let mats = new Float32Array(cap * 16), cols = new Float32Array(cap * 3);
    const add = (px: number, py: number, pz: number, yaw: number, sx: number, sy: number, sz: number, r: number, g: number, b: number) => {
      if (n === cap) {
        cap *= 2;
        const m2 = new Float32Array(cap * 16), c2 = new Float32Array(cap * 3);
        m2.set(mats); c2.set(cols);
        mats = m2; cols = c2;
      }
      const c = Math.cos(yaw), sn = Math.sin(yaw), o = n * 16;
      // column-major: X axis, Y axis, Z axis, translation (rotation about Y)
      mats[o] = c * sx; mats[o + 1] = 0; mats[o + 2] = -sn * sx; mats[o + 3] = 0;
      mats[o + 4] = 0; mats[o + 5] = sy; mats[o + 6] = 0; mats[o + 7] = 0;
      mats[o + 8] = sn * sz; mats[o + 9] = 0; mats[o + 10] = c * sz; mats[o + 11] = 0;
      mats[o + 12] = px; mats[o + 13] = py; mats[o + 14] = pz; mats[o + 15] = 1;
      cols[n * 3] = r; cols[n * 3 + 1] = g; cols[n * 3 + 2] = b;
      n++;
    };
    const winter = this.season === 'winter';
    const colCache = new Map<string, [number, number, number]>();
    for (let y = y0 - R; y <= y0 + R; y++) {
      if (y > y0 - R) yield;
      for (let x = x0 - R; x <= x0 + R; x++) {
        const dx = x - x0, dy = y - y0;
        if (dx * dx + dy * dy > R * R) continue;
        const ccx = Math.floor(x / CHUNK), ccy = Math.floor(y / CHUNK);
        if (!map.hasChunk(ccx, ccy, z)) continue;
        const c = map.chunk(ccx, ccy, z)!;
        const li = (((y % CHUNK) + CHUNK) % CHUNK) * CHUNK + (((x % CHUNK) + CHUNK) % CHUNK);
        const def = map.terrain.defs[c.ter[li]];
        let id = def.id;
        // under trees and shrubs: the grass of a neighbouring tile, thinned
        const treeish = def.flags.includes('TREE') || def.flags.includes('SHRUB') || def.flags.includes('YOUNG');
        if (treeish) id = 't_grass';
        let kind = kindOf(id);
        if (!kind) continue;
        if (treeish) kind = KINDS.under;
        if (c.furn[li] !== 0 || def.flags.includes('INDOORS')) continue;
        let n = kind.n;
        if (winter) n = kind === KINDS.tall || kind === KINDS.long ? Math.ceil(n / 3) : 0;
        if (!n) continue;
        let base = colCache.get(id);
        if (!base) {
          base = winter ? [0.2, 0.16, 0.09] : frameAverage(src.terrain(id, 'floor', { variantSeed: 0, season: this.season as 'spring' }));
          colCache.set(id, base);
        }
        for (let k = 0; k < n; k++) {
          const h = hash2(x, y, k * 7 + 1);
          const r = (i: number) => ((h >>> (i * 5)) & 31) / 31;
          const px = x + 0.05 + r(0) * 0.9, py = y + 0.05 + r(1) * 0.9;
          const gy = z * LEVEL_HEIGHT + this.ground.heightAt(px, py, z) - 0.02;
          const hh = kind.h0 + (kind.h1 - kind.h0) * r(2);
          const v = kind.bright * (0.8 + r(5) * 0.4);
          const hue = (hash2(x, y, k + 99) & 255) / 255 - 0.5;
          add(px, gy, py, r(3) * Math.PI, kind.w * (0.8 + r(4) * 0.4), hh, kind.w, base[0] * v * (1 + hue * 0.15), base[1] * v, base[2] * v * (1 - hue * 0.15));
        }
      }
    }
    this.clear();
    const count = n;
    if (!count) return;
    const mesh = new THREE.InstancedMesh(this.geo, this.mat, count);
    (mesh.instanceMatrix.array as Float32Array).set(mats.subarray(0, count * 16));
    mesh.instanceColor = new THREE.InstancedBufferAttribute(cols.slice(0, count * 3), 3);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    this.mesh = mesh;
    this.group.add(mesh);
  }
}
