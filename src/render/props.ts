import * as THREE from 'three';
import type { TerrainDef } from '../data/types';
import type { GeomBuilder, V3 } from './geometry';
import { GeomBuilder as Builder } from './geometry';
import { hash2, type GroundField } from './ground';
import { patternFor } from './pixelArt';
import type { TileFrame } from './textureSource';
import { hasFlag } from '../world/registry';
import { normalOutputChunk } from './materials';

// Scattered ground props (look.ts `props`): low-poly rocks, twigs and fallen leaves on
// natural ground, paper and cans on town pavement, puddles on roads and dirt. Deterministic
// per tile (hash of the position), vertex-coloured geometry baked into the chunk mesh with a
// white texel, so they cost no draw calls; puddles go to their own builder and material.

type Geo = (f: TileFrame) => GeomBuilder;
type RGB = [number, number, number];

const lin = (h: number): RGB => {
  const c = new THREE.Color().setHex(h, THREE.SRGBColorSpace);
  return [c.r, c.g, c.b];
};
const ROCK = [0x6a6660, 0x5a564f, 0x77726a, 0x4e4b46, 0x6e6457].map(lin);
const BARK = [0x4a3526, 0x3c2b1f, 0x57402c].map(lin);
const LEAF = [0x5a4424, 0x6b5a2a, 0x4a4a22, 0x7a4a22, 0x3e3a1c].map(lin);
const PAPER = [0xd8d2c0, 0xc8c0a8, 0xe0dcd0].map(lin);
const CAN = [0xa02a22, 0x9aa0a4, 0x2a5a9a, 0x3a7a3a].map(lin);
const BOTTLE = [0x3a5a2a, 0x5a3a1a].map(lin);

function sub(a: V3, b: V3): V3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function faceNormal(a: V3, b: V3, c: V3): V3 {
  const u = sub(b, a), v = sub(c, a);
  const n: V3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const l = Math.hypot(n[0], n[1], n[2]) || 1;
  return [n[0] / l, n[1] / l, n[2] / l];
}
const TRI_UV = [0, 0, 1, 0, 0, 1];

/** Jittered octahedron, flat shaded, sunk a little into the ground. */
function rock(g: GeomBuilder, w: TileFrame, cx: number, cy: number, cz: number, size: number, h: number): void {
  const rnd = (i: number) => (hash2(Math.floor(cx * 97), Math.floor(cz * 89), i) / 4294967296);
  const yaw = rnd(1) * Math.PI * 2;
  const ring: V3[] = [];
  const n = 5;
  for (let i = 0; i < n; i++) {
    const a = yaw + (i / n) * Math.PI * 2;
    const r = size * (0.7 + rnd(i + 2) * 0.5);
    ring.push([cx + Math.cos(a) * r, cy + size * 0.35 * (0.6 + rnd(i + 9) * 0.8), cz + Math.sin(a) * r * 0.8]);
  }
  const top: V3 = [cx + (rnd(20) - 0.5) * size * 0.4, cy + h, cz + (rnd(21) - 0.5) * size * 0.4];
  const bot: V3 = [cx, cy - size * 0.3, cz];
  const col = ROCK[Math.floor(rnd(30) * ROCK.length)];
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    g.tri(top, b, a, faceNormal(top, b, a), TRI_UV, w, col);
    g.tri(bot, a, b, faceNormal(bot, a, b), TRI_UV, w, [col[0] * 0.8, col[1] * 0.8, col[2] * 0.8]);
  }
}

/** Box rotated about Y (no bottom face): twigs, cans, bottles. */
function orientedBox(g: GeomBuilder, w: TileFrame, cx: number, cy: number, cz: number, yaw: number, lx: number, ly: number, lz: number, col: RGB): void {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const P = (x: number, y: number, z: number): V3 => [cx + x * c - z * s, cy + y, cz + x * s + z * c];
  const hx = lx / 2, hz = lz / 2;
  const q = (a: V3, b: V3, d: V3, e: V3, shade: number) => {
    const n = faceNormal(a, b, d);
    g.quadEx(a, b, d, e, [n, n, n, n], [0, 0, 1, 1], w, [col[0] * shade, col[1] * shade, col[2] * shade]);
  };
  q(P(-hx, ly, hz), P(hx, ly, hz), P(hx, ly, -hz), P(-hx, ly, -hz), 1);
  q(P(-hx, 0, hz), P(hx, 0, hz), P(hx, ly, hz), P(-hx, ly, hz), 0.85);
  q(P(hx, 0, -hz), P(-hx, 0, -hz), P(-hx, ly, -hz), P(hx, ly, -hz), 0.85);
  q(P(hx, 0, hz), P(hx, 0, -hz), P(hx, ly, -hz), P(hx, ly, hz), 0.75);
  q(P(-hx, 0, -hz), P(-hx, 0, hz), P(-hx, ly, hz), P(-hx, ly, -hz), 0.75);
}

/** Flat rotated quad just above the ground (paper, leaves). */
function flake(g: GeomBuilder, w: TileFrame, cx: number, cy: number, cz: number, yaw: number, lx: number, lz: number, col: RGB): void {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const P = (x: number, z: number): V3 => [cx + x * c - z * s, cy, cz + x * s + z * c];
  const up: V3 = [0, 1, 0];
  g.quadEx(P(-lx / 2, lz / 2), P(lx / 2, lz / 2), P(lx / 2, -lz / 2), P(-lx / 2, -lz / 2), [up, up, up, up], [0, 0, 1, 1], w, col);
}

const kindCache = new Map<string, number>();
/** 1 natural ground, 2 town hard surface, 3 road, 0 nothing. */
function surfaceKind(def: TerrainDef): number {
  let k = kindCache.get(def.id);
  if (k !== undefined) return k;
  const p = patternFor(def.id, def.flags, 'floor');
  if (hasFlag(def, 'INDOORS')) k = 0;
  else if (hasFlag(def, 'ROAD') || p === 'pavement') k = 3;
  else if (p === 'sidewalk' || p === 'concrete') k = 2;
  else if (p === 'grass' || p === 'dirt' || p === 'gravel' || p === 'sand') k = 1;
  else k = 0;
  kindCache.set(def.id, k);
  return k;
}

/**
 * Props for tile (x, y). `pud.g` receives puddles (created on first use). Trees' own tiles
 * get twigs/leaves, open ground rocks, town surfaces litter.
 */
export function emitProps(geo: Geo, white: TileFrame, x: number, y: number, z: number, base: number, def: TerrainDef,
  treeTile: boolean, floor: boolean, occupied: boolean, nearTree: boolean, outdoor: boolean, G: GroundField | null,
  pud: { g: GeomBuilder | undefined }): void {
  if (!outdoor || occupied || (!floor && !treeTile)) return;
  const kind = treeTile ? 1 : surfaceKind(def);
  if (!kind) return;
  const h = hash2(x, y, 77);
  const r = (i: number) => hash2(x, y, 100 + i) / 4294967296;
  const gy = (px: number, py: number) => base + (G ? G.heightAt(px, py, z) : 0);
  const g = geo(white);
  if (kind === 1) {
    if (h % 7 === 0 || (treeTile && h % 3 === 0)) {
      const px = x + 0.2 + r(1) * 0.6, py = y + 0.2 + r(2) * 0.6;
      const size = 0.07 + r(3) * r(3) * 0.3;
      rock(g, white, px, gy(px, py), py, size, size * (0.5 + r(4) * 0.5));
    }
    if (treeTile || nearTree) {
      const n = treeTile ? 3 : 1 + (h % 3);
      for (let i = 0; i < n; i++) {
        const px = x + 0.1 + r(10 + i) * 0.8, py = y + 0.1 + r(20 + i) * 0.8;
        flake(g, white, px, gy(px, py) + 0.012 + i * 0.002, py, r(30 + i) * 6.28, 0.14, 0.1, LEAF[Math.floor(r(40 + i) * LEAF.length)]);
      }
      if (h % 5 === 1) {
        const px = x + 0.3 + r(50) * 0.4, py = y + 0.3 + r(51) * 0.4;
        orientedBox(g, white, px, gy(px, py), py, r(52) * 6.28, 0.35 + r(53) * 0.5, 0.035, 0.035, BARK[Math.floor(r(54) * BARK.length)]);
      }
    }
    if (!treeTile && def.id.includes('dirt') && h % 41 === 3) puddle(pud, white, x, y, gy(x + 0.5, y + 0.5), r);
  } else {
    // town litter: paper, cans, bottles; puddles on roads
    if (h % 53 === 0) {
      const px = x + 0.15 + r(1) * 0.7, py = y + 0.15 + r(2) * 0.7;
      flake(g, white, px, gy(px, py) + 0.012, py, r(3) * 6.28, 0.22, 0.3, PAPER[Math.floor(r(4) * PAPER.length)]);
    }
    if (h % 71 === 2) {
      const px = x + 0.2 + r(5) * 0.6, py = y + 0.2 + r(6) * 0.6;
      const bottle = r(7) < 0.3;
      // lying on its side: long axis horizontal
      orientedBox(g, white, px, gy(px, py), py, r(8) * 6.28, bottle ? 0.24 : 0.12, 0.065, 0.065, bottle ? BOTTLE[Math.floor(r(9) * 2)] : CAN[Math.floor(r(9) * CAN.length)]);
    }
    if (kind === 3 && h % 61 === 5) puddle(pud, white, x, y, gy(x + 0.5, y + 0.5), r);
  }
}

function puddle(pud: { g: GeomBuilder | undefined }, white: TileFrame, x: number, y: number, gy: number, r: (i: number) => number): void {
  const g = (pud.g ??= new Builder());
  const cx = x + 0.5 + (r(60) - 0.5) * 0.3, cz = y + 0.5 + (r(61) - 0.5) * 0.3;
  const R = 0.35 + r(62) * 0.45;
  const n = 9;
  const up: V3 = [0, 1, 0];
  const c: V3 = [cx, gy + 0.008, cz];
  const pts: V3[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const rr = R * (0.65 + r(63 + i) * 0.5);
    pts.push([cx + Math.cos(a) * rr, gy + 0.008, cz + Math.sin(a) * rr * 0.75]);
  }
  for (let i = 0; i < n; i++) g.tri(c, pts[(i + 1) % n], pts[i], up, TRI_UV, white, [1, 1, 1]);
}

// Puddle surface: dark water mirroring the sky's colours (zenith overhead, horizon at a
// grazing angle, a sun glint), lit by nothing else; shared sky uniforms (renderer updates).
export const puddleUniforms = {
  uZenith: { value: new THREE.Color() },
  uHorizon: { value: new THREE.Color() },
  uSunDir: { value: new THREE.Vector3() },
  uSunColor: { value: new THREE.Color() },
  uNight: { value: 0 },
};

let puddleMat: THREE.ShaderMaterial | null = null;
export function puddleMaterial(): THREE.ShaderMaterial {
  if (puddleMat) return puddleMat;
  puddleMat = new THREE.ShaderMaterial({
    uniforms: puddleUniforms,
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      layout(location = 1) out highp vec4 gNormal;
      uniform vec3 uZenith, uHorizon, uSunDir, uSunColor;
      uniform float uNight;
      varying vec3 vWorld;
      void main() {
        vec3 v = normalize(cameraPosition - vWorld);
        vec3 r = reflect(-v, vec3(0.0, 1.0, 0.0));
        // water over asphalt: mostly dark, the sky shows at grazing angles (Fresnel)
        float fres = 0.06 + 0.94 * pow(1.0 - max(v.y, 0.0), 5.0);
        vec3 sky = mix(uHorizon, uZenith, pow(clamp(r.y, 0.0, 1.0), 0.6));
        float l = dot(sky, vec3(0.3, 0.59, 0.11));
        sky = mix(vec3(l), sky, 0.6);
        vec3 col = vec3(0.018, 0.02, 0.022) + sky * fres * 0.7;
        col += uSunColor * pow(max(dot(r, uSunDir), 0.0), 200.0) * 3.0 * (1.0 - uNight);
        gl_FragColor = vec4(col, 1.0);
        ${normalOutputChunk(false, 0)}
      }`,
  });
  (puddleMat.userData as { mrt?: boolean }).mrt = true;
  return puddleMat;
}
