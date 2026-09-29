import * as THREE from 'three';
import { LEVEL_HEIGHT } from '../world/coords';
import { framePixels, frameKey } from './framePixels';
import { GeomBuilder, type V3 } from './geometry';
import { hash2, type GroundField } from './ground';
import { instancedLitMaterial, worldMaterials } from './materials';
import { paintSurface, rampAround } from './pixelArt';
import type { ProceduralTextureSource } from './proceduralSource';
import type { TileFrame } from './textureSource';
import { runSteps } from './steps';

// 3D trees (look.ts `trees3d`), built from the tree's own UltiCa sprite so species, colour
// and season all carry over:
//   * the sprite is analysed once: trunk width/colour from its bottom rows, the canopy's
//     silhouette row by row, its colours, and whether it is bare (winter/dead: branches only)
//   * trunk: a tapered, slightly leaning hexagonal prism with a bark texture tinted to the
//     sprite's trunk colour, plus branches reaching into the canopy (many for bare trees)
//   * canopy: the silhouette revolved around the trunk axis and covered with small
//     camera-facing leaf-clump cards (t3ssel8r style). Each card is coloured from the sprite
//     pixel at the matching spot and lit with the canopy's *volume* normal (centre -> card),
//     so the crown shades like a ball: bright sun side, dark underside, self-shadowed.
// One instanced mesh per chunk for all clumps, trunks baked into one geometry per chunk.

export interface TreeSpec {
  x: number;
  y: number;
  z: number;
  frame: TileFrame;
  /** total height, m */
  height: number;
  shrub: boolean;
  seed: number;
}

interface TreeShape {
  /** sprite rows (top-down) spanned by opaque pixels */
  top: number;
  bottom: number;
  /** trunk centre column and width in px */
  trunkX: number;
  trunkW: number;
  trunkCol: [number, number, number];
  /** first (topmost) and last canopy rows */
  cTop: number;
  cBot: number;
  /** per row: [left, right] opaque extent in canopy rows, or null */
  rows: ([number, number] | null)[];
  bare: boolean;
  pine: boolean;
  w: number;
  h: number;
  px: Uint8ClampedArray;
  /** crown mid-tones (linear), and the luminance below which a pixel counts as outline/shade */
  pal: number[][];
  palLo: number;
}

const lum = (c: number[]) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];

const shapeCache = new Map<string, TreeShape | null>();
const toLin = (v: number) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

function analyse(f: TileFrame, shrub: boolean): TreeShape | null {
  const key = frameKey(f) + (shrub ? ':s' : '');
  if (shapeCache.has(key)) return shapeCache.get(key)!;
  const p = framePixels(f);
  let res: TreeShape | null = null;
  if (p) {
    const { w, h, data } = p;
    const op = (x: number, y: number) => data[(y * w + x) * 4 + 3] >= 200;
    const rowsExt: ([number, number] | null)[] = [];
    let top = -1, bottom = -1;
    for (let y = 0; y < h; y++) {
      let l = -1, r = -1;
      for (let x = 0; x < w; x++) if (op(x, y)) { if (l < 0) l = x; r = x; }
      rowsExt.push(l >= 0 ? [l, r] : null);
      if (l >= 0) { if (top < 0) top = y; bottom = y; }
    }
    if (top >= 0) {
      // trunk: the bottom ~12% rows' median width and centre
      const n = Math.max(2, Math.round((bottom - top) * 0.12));
      const ws: number[] = [], cs: number[] = [];
      let tr = 0, tg = 0, tb = 0, tn = 0;
      for (let y = bottom - n + 1; y <= bottom; y++) {
        const e = rowsExt[y];
        if (!e) continue;
        ws.push(e[1] - e[0] + 1);
        cs.push((e[0] + e[1]) / 2);
        for (let x = e[0]; x <= e[1]; x++) if (op(x, y)) {
          const i = (y * w + x) * 4;
          tr += toLin(data[i]); tg += toLin(data[i + 1]); tb += toLin(data[i + 2]); tn++;
        }
      }
      ws.sort((a, b) => a - b);
      cs.sort((a, b) => a - b);
      const trunkW = shrub ? 0 : Math.min(ws[ws.length >> 1] ?? 4, w * 0.25);
      const trunkX = cs[cs.length >> 1] ?? w / 2;
      // canopy rows: clearly wider than the trunk (shrubs: everything)
      let cTop = top, cBot = bottom;
      if (!shrub) {
        cBot = top;
        for (let y = top; y <= bottom; y++) {
          const e = rowsExt[y];
          if (e && e[1] - e[0] + 1 > Math.max(trunkW * 2.2, 6)) cBot = y;
        }
      }
      // bare: few opaque pixels inside the canopy's row extents (branches, no leaves)
      let inside = 0, filled = 0, green = 0;
      for (let y = cTop; y <= cBot; y++) {
        const e = rowsExt[y];
        if (!e) continue;
        for (let x = e[0]; x <= e[1]; x++) {
          inside++;
          if (op(x, y)) {
            filled++;
            const i = (y * w + x) * 4;
            // leaves: green, or saturated and bright (autumn); dead wood is dull brown/grey
            const mx = Math.max(data[i], data[i + 1], data[i + 2]), mn = Math.min(data[i], data[i + 1], data[i + 2]);
            if ((data[i + 1] > data[i] * 0.95 && data[i + 1] > data[i + 2]) || (mx - mn > 70 && mx > 110)) green++;
          }
        }
      }
      const fill = inside ? filled / inside : 0;
      // triangular silhouette (width grows downward) = conifer
      const wAt = (t: number) => { const e = rowsExt[Math.round(cTop + (cBot - cTop) * t)]; return e ? e[1] - e[0] : 0; };
      const pine = !shrub && wAt(0.2) < wAt(0.75) * 0.55;
      const cols: number[][] = [];
      for (let y = cTop; y <= cBot; y++)
        for (let x = 0; x < w; x++)
          if (op(x, y)) {
            const i = (y * w + x) * 4;
            cols.push([toLin(data[i]), toLin(data[i + 1]), toLin(data[i + 2])]);
          }
      cols.sort((a, b) => lum(a) - lum(b));
      const pal = cols.slice(Math.floor(cols.length * 0.3), Math.ceil(cols.length * 0.95));
      const palLo = cols.length ? lum(cols[Math.floor(cols.length * 0.25)]) : 0;
      res = {
        pal, palLo,
        top, bottom, trunkX, trunkW, trunkCol: tn ? [tr / tn, tg / tn, tb / tn] : [0.05, 0.035, 0.02],
        cTop, cBot, rows: rowsExt, bare: green / Math.max(1, filled) < 0.22, pine, w, h, px: data,
      };
    }
  }
  shapeCache.set(key, res);
  return res;
}

// --- leaf clump texture: 4 irregular leafy blobs in a 2x2 grid --------------------------

const CL = 16;
let clumpTex: THREE.DataTexture | null = null;
function clumpTexture(): THREE.DataTexture {
  if (clumpTex) return clumpTex;
  const S = CL * 2;
  const d = new Uint8Array(S * S * 4);
  for (let v = 0; v < 4; v++) {
    const ox = (v & 1) * CL, oy = (v >> 1) * CL;
    for (let y = 0; y < CL; y++)
      for (let x = 0; x < CL; x++) {
        const dx = x - 7.5, dy = y - 7.5;
        const a = Math.atan2(dy, dx);
        const edge = 6.4 + 0.9 * Math.sin(a * 3 + v * 1.7) + 0.5 * Math.sin(a * 7 + v) + ((hash2(x, y, v + 40) & 3) - 1.5) * 0.45;
        const r = Math.hypot(dx, dy);
        if (r > edge) continue;
        // leaf pattern: lighter upper-left, dark specks, rim a bit darker
        const hsh = hash2(x, y, v + 7) & 255;
        let k = 0.78 + 0.22 * (1 - (dy + 8) / 16) * 0.8 - (dx > 0 ? 0.04 : 0);
        if (hsh < 40) k *= 0.72;
        else if (hsh > 225) k *= 1.12;
        if (r > edge - 1.2) k *= 0.82;
        const i = ((oy + y) * S + ox + x) * 4;
        const c = Math.round(Math.min(1, k) * 255);
        d[i] = d[i + 1] = d[i + 2] = c;
        d[i + 3] = 255;
      }
  }
  const t = new THREE.DataTexture(d, S, S, THREE.RGBAFormat);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  clumpTex = t;
  return t;
}

/** Daylight share of leaf translucency (renderer sets it from the sky). */
export const leafGlow = { value: 0.1 };
/** Sun direction (world) and colour*intensity for backlit leaves (renderer sets them). */
export const leafSun = { dir: { value: new THREE.Vector3(0, 1, 0) }, color: { value: new THREE.Color() } };

let clumpMats: { mat: THREE.MeshLambertMaterial; depth: THREE.MeshDepthMaterial } | null = null;
function clumpMaterials(): { mat: THREE.MeshLambertMaterial; depth: THREE.MeshDepthMaterial } {
  if (clumpMats) return clumpMats;
  clumpMats = instancedLitMaterial({ map: clumpTexture(), alphaTest: 0.5, side: THREE.DoubleSide }, {
    key: 'clump',
    pars: 'attribute vec4 instN;\nuniform vec3 uSunW;\nvarying float vTrans;\n',
    normal: 'vec3 objectNormal = instN.xyz;\n#ifdef USE_TANGENT\nvec3 objectTangent = vec3(1.0, 0.0, 0.0);\n#endif\n',
    vertex: `
      {
        vec3 cR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
        vec3 cU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
        vec3 ip = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        // looking through the crown toward the sun: leaves glow (translucency)
        vTrans = pow(max(dot(normalize(ip - cameraPosition), uSunW), 0.0), 3.0);
        vec2 sw = vec2(sin(uTime * 1.3 + ip.x * 0.5 + ip.y * 0.7), cos(uTime * 1.1 + ip.z * 0.6)) * 0.03 * max(ip.y - 1.0, 0.0) / 4.0;
        // clumps melt away within a few metres of the eye instead of filling the view
        float near = smoothstep(1.4, 3.6, length(ip - cameraPosition));
        transformed = (cR * position.x + cU * position.y) * instN.w * near + vec3(sw.x, 0.0, sw.y);
        #ifdef USE_MAP
        vMapUv = vMapUv * 0.5 + vec2(float(gl_InstanceID % 2), float((gl_InstanceID / 2) % 2)) * 0.5;
        #endif
      }
    `,
    lmLift: 0,
    uniforms: { uLeafGlow: leafGlow, uSunW: leafSun.dir, uSunC: leafSun.color },
    fragPars: 'uniform float uLeafGlow;\nuniform vec3 uSunC;\nvarying float vTrans;\n',
    // light scattered through the crown: undersides never go fully black, and the crown
    // glows when backlit
    frag: 'totalEmissiveRadiance += diffuseColor.rgb * (uLeafGlow + uSunC * vTrans * 0.55);',
  });
  return clumpMats;
}

function beam(g: GeomBuilder, f: TileFrame, a: V3, b: V3, r0: number, r1: number, col: [number, number, number], sides = 5, cut = 0): void {
  const ax: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len = Math.hypot(ax[0], ax[1], ax[2]) || 1;
  const d: V3 = [ax[0] / len, ax[1] / len, ax[2] / len];
  // any perpendicular basis
  const t0: V3 = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let u: V3 = [d[1] * t0[2] - d[2] * t0[1], d[2] * t0[0] - d[0] * t0[2], d[0] * t0[1] - d[1] * t0[0]];
  const ul = Math.hypot(u[0], u[1], u[2]);
  u = [u[0] / ul, u[1] / ul, u[2] / ul];
  const v: V3 = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]];
  const ring = (c: V3, r: number, i: number): V3 => {
    const t = (i / sides) * Math.PI * 2;
    const cs = Math.cos(t), sn = Math.sin(t);
    return [c[0] + (u[0] * cs + v[0] * sn) * r, c[1] + (u[1] * cs + v[1] * sn) * r, c[2] + (u[2] * cs + v[2] * sn) * r];
  };
  const nrm = (i: number): V3 => {
    const t = ((i + 0.5) / sides) * Math.PI * 2;
    return [u[0] * Math.cos(t) + v[0] * Math.sin(t), u[1] * Math.cos(t) + v[1] * Math.sin(t), u[2] * Math.cos(t) + v[2] * Math.sin(t)];
  };
  for (let i = 0; i < sides; i++) {
    const n = nrm(i);
    const k = 0.8 + 0.2 * (i % 2);
    g.quadEx(ring(a, r0, i), ring(a, r0, i + 1), ring(b, r1, i + 1), ring(b, r1, i), [n, n, n, n],
      [i / sides * 1.5, 0, (i + 1) / sides * 1.5, len], f, [col[0] * k, col[1] * k, col[2] * k], cut);
  }
}

/**
 * Bare trees (winter, dead) keep their billboard: their look is the sprite's fine branch
 * drawing, which crossed planes only reproduced as giant texels up close, and a billboard
 * can dissolve when the camera walks into it.
 */
export function isBareTree(f: TileFrame, shrub: boolean): boolean {
  return !!analyse(f, shrub)?.bare;
}

/** Build one chunk's trees: trunk geometry (world material) + clumps (instanced). */
export function buildTrees(specs: TreeSpec[], ground: GroundField | null, proc: ProceduralTextureSource, white: TileFrame): THREE.Object3D[] {
  return runSteps(buildTreesSteps(specs, ground, proc, white));
}

/** buildTrees yielding after each tree (a forest chunk is ~10 ms of trees; see chunkManager). */
export function* buildTreesSteps(specs: TreeSpec[], ground: GroundField | null, proc: ProceduralTextureSource, white: TileFrame): Generator<void, THREE.Object3D[]> {
  const trunkG = new GeomBuilder();
  // bare crowns: the sprite's own branch drawing on three crossed planes (per atlas page)
  const planes = new Map<THREE.Texture, GeomBuilder>();
  const inst: number[] = [], nrm: number[] = [], col: number[] = [];
  let first = true;
  for (const s of specs) {
    if (!first) yield;
    first = false;
    const sh = analyse(s.frame, s.shrub);
    if (!sh) continue;
    const r = (i: number) => hash2(s.seed, i, 31) / 4294967296;
    const gy = s.z * LEVEL_HEIGHT + (ground ? ground.heightAt(s.x, s.y, s.z) : 0);
    const H = s.height;
    const pxM = H / (sh.bottom - sh.top + 1);
    const yaw = r(1) * Math.PI * 2;
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    // sprite column offset (px from the trunk axis) and depth -> world, rotated by yaw
    const W = (u: number, v: number): [number, number] => [s.x + (u * cy - v * sy) * pxM, s.y + (u * sy + v * cy) * pxM];
    const yOf = (row: number) => gy + (sh.bottom - row) * pxM;
    const bark = barkFrame(proc, sh.trunkCol);
    const tc = [1, 1, 1] as [number, number, number];
    // trunk: from the ground to 35% into the canopy
    const trunkR = s.shrub ? 0 : Math.max(0.09, Math.min(0.3, (sh.trunkW * pxM) / 2));
    const trunkTopRow = sh.bare ? sh.top + (sh.bottom - sh.top) * 0.15 : sh.cBot - (sh.cBot - sh.cTop) * (sh.pine ? 0.8 : 0.35);
    const lean: [number, number] = [(r(2) - 0.5) * 0.25, (r(3) - 0.5) * 0.25];
    const trunkTop: V3 = [s.x + lean[0], yOf(trunkTopRow), s.y + lean[1]];
    if (!s.shrub) {
      const mid: V3 = [s.x + lean[0] * 0.35, gy + (trunkTop[1] - gy) * 0.45, s.y + lean[1] * 0.35];
      beam(trunkG, bark, [s.x, gy - 0.15, s.y], mid, trunkR * 1.15, trunkR * 0.9, tc, 6);
      beam(trunkG, bark, mid, trunkTop, trunkR * 0.9, trunkR * 0.55, tc, 6);
      // branches toward the crown (bare trees: a fan of them, with twigs)
      const nb = sh.bare ? 0 : sh.pine ? 0 : 4;
      for (let b = 0; b < nb; b++) {
        const a = yaw + (b / nb) * Math.PI * 2 + r(10 + b) * 0.8;
        const startT = sh.bare ? 0.35 + r(20 + b) * 0.55 : 0.6 + r(20 + b) * 0.35;
        const st: V3 = [s.x + lean[0] * startT, gy + (trunkTop[1] - gy) * startT, s.y + lean[1] * startT];
        const reach = (sh.bare ? 0.55 : 0.4) * ((sh.rows[Math.round(sh.cTop + (sh.cBot - sh.cTop) * 0.5)] ?? [0, 8])[1] - (sh.rows[Math.round(sh.cTop + (sh.cBot - sh.cTop) * 0.5)] ?? [0, 8])[0]) * pxM;
        const rise = (sh.bare ? 1.2 : 0.8) + r(30 + b) * 1.0;
        const end: V3 = [st[0] + Math.cos(a) * reach, st[1] + rise, st[2] + Math.sin(a) * reach];
        beam(trunkG, bark, st, end, trunkR * 0.45, trunkR * 0.15, tc, 4);
        if (sh.bare) {
          for (let t = 0; t < 2; t++) {
            const a2 = a + (t ? 0.7 : -0.7);
            const e2: V3 = [end[0] + Math.cos(a2) * reach * 0.45, end[1] + 0.5 + r(40 + b * 2 + t) * 0.6, end[2] + Math.sin(a2) * reach * 0.45];
            beam(trunkG, bark, end, e2, trunkR * 0.15, 0.02, tc, 3);
          }
        }
      }
    }
    if (sh.bare) {
      let g = planes.get(s.frame.texture);
      if (!g) planes.set(s.frame.texture, (g = new GeomBuilder()));
      const yTop = gy + (sh.bottom + 1) * pxM, yBot = gy + (sh.bottom + 1 - sh.h) * pxM;
      const uL = -sh.trunkX * pxM, uR = (sh.w - sh.trunkX) * pxM;
      const up: V3 = [0, 1, 0];
      for (let k = 0; k < 3; k++) {
        const a = yaw + (k * Math.PI) / 3;
        const ca = Math.cos(a), sa = Math.sin(a);
        const P = (u: number, y: number): V3 => [s.x + ca * u, y, s.y + sa * u];
        g.quad(P(uL, yBot), P(uR, yBot), P(uR, yTop), P(uL, yTop), up, [0, 0, 1, 1], s.frame, [1, 1, 1, 1]);
        g.quad(P(uR, yBot), P(uL, yBot), P(uL, yTop), P(uR, yTop), up, [1, 0, 0, 1], s.frame, [1, 1, 1, 1]);
      }
      continue;
    }
    // canopy: revolve the silhouette; cards on the surface plus some inside
    let area = 0;
    for (let y = sh.cTop; y <= sh.cBot; y++) { const e = sh.rows[y]; if (e) area += e[1] - e[0] + 1; }
    const nC = Math.max(s.shrub ? 14 : 40, Math.min(s.shrub ? 60 : 260, Math.round(area / (s.shrub ? 10 : 10))));
    const centreRow = (sh.cTop + sh.cBot) / 2;
    const cardPx = s.shrub ? 6 : sh.pine ? 6 : 7;
    for (let i = 0; i < nC; i++) {
      // rows weighted by width: pick a random canopy pixel's row
      let row = sh.cTop, acc = r(100 + i) * area;
      for (let y = sh.cTop; y <= sh.cBot; y++) {
        const e = sh.rows[y];
        if (!e) continue;
        acc -= e[1] - e[0] + 1;
        if (acc <= 0) { row = y; break; }
      }
      const e = sh.rows[row] ?? [sh.trunkX - 2, sh.trunkX + 2];
      const half = (e[1] - e[0]) / 2;
      const cx = (e[0] + e[1]) / 2 - sh.trunkX;
      const th = r(200 + i) * Math.PI * 2;
      const inner = r(300 + i) < 0.3;
      const rad = half * (inner ? 0.35 + r(400 + i) * 0.35 : 0.72 + r(400 + i) * 0.28);
      const u = cx + Math.cos(th) * rad, v = Math.sin(th) * rad;
      const [wx, wz] = W(u, v);
      const wy = yOf(row) + (r(500 + i) - 0.5) * pxM * 2;
      // colour: the sprite pixel on the facing side of that row
      let sx = Math.round(sh.trunkX + cx + Math.cos(th) * rad);
      sx = Math.max(e[0], Math.min(e[1], sx));
      let pi = (row * sh.w + sx) * 4;
      for (let k = 0; k < 6 && sh.px[pi + 3] < 200; k++) { sx += sx < sh.trunkX + cx ? 1 : -1; pi = (row * sh.w + sx) * 4; }
      let c = [toLin(sh.px[pi]), toLin(sh.px[pi + 1]), toLin(sh.px[pi + 2])];
      // the sprite's dark outline and deepest shade would make black clumps: lighting does
      // the shading here, so fall back to the crown's mid-tones
      if (lum(c) < sh.palLo && sh.pal.length) c = sh.pal[Math.floor(r(700 + i) * sh.pal.length)];
      // volume normal from the crown's centre, biased up
      const cxw = W(0, 0);
      let nx = wx - cxw[0], ny = (wy - yOf(centreRow)) * 0.8 + 0.6 * half * pxM, nz = wz - cxw[1];
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      const size = pxM * cardPx * (0.8 + r(600 + i) * 0.5) * (inner ? 1.2 : 1);
      inst.push(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, wx, wy, wz, 1);
      nrm.push(nx, ny, nz, size);
      const k = (inner ? 0.85 : 1) * 1.45;
      col.push(c[0] * k, c[1] * k, c[2] * k);
    }
  }
  const out: THREE.Object3D[] = [];
  if (trunkG.vertexCount) {
    const { mat, depth } = worldMaterials(proc.texture);
    const m = new THREE.Mesh(trunkG.build(), mat);
    m.customDepthMaterial = depth;
    m.castShadow = true;
    m.receiveShadow = true;
    m.matrixAutoUpdate = false;
    out.push(m);
  }
  for (const [page, g] of planes) {
    const { mat, depth } = worldMaterials(page);
    const m = new THREE.Mesh(g.build(), mat);
    m.customDepthMaterial = depth;
    m.castShadow = true;
    m.receiveShadow = true;
    m.matrixAutoUpdate = false;
    out.push(m);
  }
  const n = inst.length / 16;
  if (n) {
    const q = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = q.index;
    g.setAttribute('position', q.getAttribute('position'));
    g.setAttribute('normal', q.getAttribute('normal'));
    g.setAttribute('uv', q.getAttribute('uv'));
    g.setAttribute('instN', new THREE.InstancedBufferAttribute(new Float32Array(nrm), 4));
    const { mat, depth } = clumpMaterials();
    const m = new THREE.InstancedMesh(g, mat, n);
    (m.instanceMatrix.array as Float32Array).set(inst);
    m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(col), 3);
    m.customDepthMaterial = depth;
    m.castShadow = true;
    m.receiveShadow = true;
    // bounds from the instances (trees reach beyond the chunk's own box)
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = inst[i * 16 + 12], y = inst[i * 16 + 13], z = inst[i * 16 + 14];
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
    const box = new THREE.Box3(new THREE.Vector3(minX - 1, minY - 1, minZ - 1), new THREE.Vector3(maxX + 1, maxY + 1, maxZ + 1));
    m.boundingBox = box;
    m.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
    g.boundingSphere = m.boundingSphere.clone();
    m.frustumCulled = true;
    m.userData.dispose = () => { g.dispose(); m.dispose(); };
    out.push(m);
  }
  void white;
  return out;
}

const barkCache = new Map<string, TileFrame>();
function barkFrame(proc: ProceduralTextureSource, lin: [number, number, number]): TileFrame {
  const srgb = lin.map((v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055) * 255);
  const q = srgb.map((v) => Math.round(v / 12) * 12) as [number, number, number];
  const key = q.join(',');
  let f = barkCache.get(key);
  if (!f) {
    f = proc.custom(`bark:${key}`, () => paintSurface('boards', 'brown', 11, rampAround(q, 0.9)));
    barkCache.set(key, f);
  }
  return f;
}
