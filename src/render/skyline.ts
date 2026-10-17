import * as THREE from 'three';
import { runSteps, stepUntil } from './steps';
import { CHUNK } from '../world/coords';
import { hash2 } from './ground';

// Distant skyline (look.ts `skyline`): beyond the drawn chunks the world used to end in a
// flat wall of fog. This ring of cheap silhouettes — house boxes with gable roofs, blocky
// town buildings, clumps of low-poly tree crowns — is built from the overmap (what really
// is out there), so the horizon shows where the next town and the forests are.
//
// Everything past uNear metres is pulled toward the camera in the vertex shader keeping its
// direction (an impostor: same angular size and place on the horizon, well inside the
// camera's far plane). The pixels are tagged in the normal target (alpha 0.5) so the post
// pass gives them their own haze instead of the opaque draw-distance fog.
//
// Under the silhouettes lies a far ground ring (atmosphere.ts sky-matched modes, every
// look): one flat quad per OMT coloured by what it is (fields, forest floor, water, snow)
// with roads as grey strips, 0.6 m below the real ground so it only shows where no chunk
// is drawn. Without it the world ended in a band of sky below the horizon at the draw
// distance; with it the ground runs out to the horizon and the post pass fades it into
// the sky by its true distance (written to the normal target's red channel).

export interface OmtLookup {
  omtAt(x: number, y: number, z: number): { id: string };
}

type Kind = 'house' | 'town' | 'tall' | 'forest' | 'none';

type GroundKind = 'field' | 'forest' | 'water' | 'town' | 'road';
function groundKind(id: string): GroundKind {
  if (/^(road|hiway|bridge|railroad)/.test(id)) return 'road';
  if (/^(river|lake|pond)/.test(id)) return 'water';
  if (/^forest|swamp/.test(id)) return 'forest';
  if (/^(field|open_air|empty_rock|solid_earth|crater)/.test(id)) return 'field';
  return 'town';
}
// Linear albedo-ish colours, tuned by eye against the lit chunk ground at 100-150 m.
const GROUND: Record<GroundKind, number[]> = {
  field: [0.105, 0.15, 0.05],
  forest: [0.05, 0.075, 0.03],
  water: [0.035, 0.06, 0.08],
  town: [0.09, 0.11, 0.07],
  road: [0.075, 0.075, 0.08],
};
const SNOW = [0.55, 0.58, 0.62];
/** The ground ring sits this far below the real ground (relief goes down to -0.45 m). */
const GROUND_Y = -0.6;

function classify(id: string): Kind {
  if (/^forest|swamp/.test(id)) return 'forest';
  // a lattice mast, not a building (it matched 'tower' below and stood as a tall block)
  if (/^radio_tower/.test(id)) return 'none';
  if (/^(field|road|river|lake|bridge|open_air|empty_rock|solid_earth|hiway|railroad|sewer|subway|crater|lab|ants|anthill|slimepit|cave)/.test(id)) return 'none';
  if (/house|home|mansion|trailer|cabin|garage|shed|duplex|bungalow|cottage|farm|barn|church/.test(id)) return 'house';
  if (/apartment|office|hospital|hotel|tower|condo|skyscraper|highrise|high_rise/.test(id)) return 'tall';
  return 'town';
}

export type QuadFn = (a: number[], b: number[], c: number[], d: number[], n: number[], k: number[]) => void;
export type TriFn = (a: number[], b: number[], c: number[], k: number[]) => void;

/**
 * The silhouette of OMT (X, Y) with overmap id `id`: house boxes with gable roofs, blocky town
 * buildings, clumps of tree crowns, or nothing (fields, roads, water). World coordinates, ground
 * at y = 0, linear colours tuned for the skyline shader. Also used for the stand-ins of chunks
 * not built yet (placeholders.ts).
 */
export function emitSilhouette(X: number, Y: number, id: string, quad: QuadFn, tri: TriFn): void {
  const box = (x0: number, z0: number, x1: number, z1: number, h: number, k: number[]) => {
    quad([x0, 0, z1], [x1, 0, z1], [x1, h, z1], [x0, h, z1], [0, 0, 1], k);
    quad([x1, 0, z0], [x0, 0, z0], [x0, h, z0], [x1, h, z0], [0, 0, -1], k);
    quad([x1, 0, z1], [x1, 0, z0], [x1, h, z0], [x1, h, z1], [1, 0, 0], k);
    quad([x0, 0, z0], [x0, 0, z1], [x0, h, z1], [x0, h, z0], [-1, 0, 0], k);
    quad([x0, h, z1], [x1, h, z1], [x1, h, z0], [x0, h, z0], [0, 1, 0], k);
  };
  const crown = (cx: number, cz: number, r: number, y0: number, h: number, k: number[], pine: boolean) => {
    // a 6-sided bulb (or cone for pines)
    const n = 6;
    const ring = (y: number, rr: number, ph: number) => Array.from({ length: n }, (_, i) => [cx + Math.cos(ph + (i / n) * 6.283) * rr, y, cz + Math.sin(ph + (i / n) * 6.283) * rr]);
    const top = [cx, y0 + h, cz];
    if (pine) {
      const b = ring(y0, r, 0);
      for (let i = 0; i < n; i++) tri(b[i], top, b[(i + 1) % n], k);
    } else {
      const b = ring(y0, r * 0.7, 0), m = ring(y0 + h * 0.45, r, 0.5);
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        tri(b[i], m[i], b[j], k);
        tri(b[j], m[i], m[j], k);
        tri(m[i], top, m[j], k);
      }
    }
  };
  const kind = classify(id);
  if (kind === 'none') return;
  const r = (i: number) => hash2(X, Y, 500 + i) / 4294967296;
  const bx = X * CHUNK, bz = Y * CHUNK;
  if (kind === 'forest') {
    const n = 5 + Math.floor(r(0) * 5);
    for (let i = 0; i < n; i++) {
      const pine = r(10 + i) < 0.35;
      const g = 0.035 + r(20 + i) * 0.03;
      crown(bx + 2 + r(30 + i) * 20, bz + 2 + r(40 + i) * 20, 3 + r(50 + i) * 3, 1.5, 8 + r(60 + i) * 7, pine ? [g * 0.6, g * 1.2, g * 0.8] : [g, g * 1.5, g * 0.7], pine);
    }
  } else {
    const tall = kind === 'tall';
    const nb = kind === 'house' ? 1 : 1 + Math.floor(r(1) * 2);
    for (let i = 0; i < nb; i++) {
      const w = kind === 'house' ? 8 + r(2 + i) * 5 : 9 + r(2 + i) * 9;
      const dpt = kind === 'house' ? 7 + r(4 + i) * 4 : 8 + r(4 + i) * 9;
      const x0 = bx + 2 + r(6 + i) * (22 - w), z0 = bz + 2 + r(8 + i) * (22 - dpt);
      const h = kind === 'house' ? 3 + r(9 + i) * 2.8 : tall ? 12 + r(9 + i) * 20 : 4 + r(9 + i) * 7;
      const v = 0.05 + r(12 + i) * 0.05;
      const k = [v * 1.05, v, v * 0.95];
      box(x0, z0, x0 + w, z0 + dpt, h, k);
      if (kind === 'house') {
        // gable roof along the longer side
        const rh = 2.2 + r(14 + i);
        const kr = [v * 0.7, v * 0.62, v * 0.6];
        if (w >= dpt) {
          const zm = z0 + dpt / 2;
          quad([x0 - 0.4, h, z0 + dpt + 0.4], [x0 + w + 0.4, h, z0 + dpt + 0.4], [x0 + w + 0.4, h + rh, zm], [x0 - 0.4, h + rh, zm], [0, 0.7, 0.7], kr);
          quad([x0 + w + 0.4, h, z0 - 0.4], [x0 - 0.4, h, z0 - 0.4], [x0 - 0.4, h + rh, zm], [x0 + w + 0.4, h + rh, zm], [0, 0.7, -0.7], kr);
          tri([x0, h, z0], [x0, h, z0 + dpt], [x0, h + rh, zm], k);
          tri([x0 + w, h, z0 + dpt], [x0 + w, h, z0], [x0 + w, h + rh, zm], k);
        } else {
          const xm = x0 + w / 2;
          quad([x0 + w + 0.4, h, z0 + dpt + 0.4], [x0 + w + 0.4, h, z0 - 0.4], [xm, h + rh, z0 - 0.4], [xm, h + rh, z0 + dpt + 0.4], [0.7, 0.7, 0], kr);
          quad([x0 - 0.4, h, z0 - 0.4], [x0 - 0.4, h, z0 + dpt + 0.4], [xm, h + rh, z0 + dpt + 0.4], [xm, h + rh, z0 - 0.4], [-0.7, 0.7, 0], kr);
          tri([x0 + w, h, z0], [x0, h, z0], [xm, h + rh, z0], k);
          tri([x0, h, z0 + dpt], [x0 + w, h, z0 + dpt], [xm, h + rh, z0 + dpt], k);
        }
      }
    }
    // a street tree or two
    if (r(70) < 0.5) crown(bx + r(71) * 24, bz + r(72) * 24, 2.5, 1.5, 6 + r(73) * 3, [0.04, 0.06, 0.03], false);
  }
}

/** Default pull distance (m); farLod.ts moves it past the far proxies, which reach further. */
export const SKYLINE_NEAR = 140;
/** Pulled geometry keeps this share of its depth beyond the pull distance. */
export const SKYLINE_PULL = 0.12;
/** Rebuild after the player's OMT moved this far from the ring's centre. */
const LAG = 2;

/** The ring reaches this many chunks past the draw radius. */
export const SKYLINE_OUTER = 13;

export class SkylineLayer {
  readonly group = new THREE.Group();
  /** Silhouettes (look `skyline`). */
  enabled = false;
  /** Far ground ring (atmosphere.ts: sky-matched haze modes, every look). */
  ground = false;
  season: 'spring' | 'summer' | 'autumn' | 'winter' = 'spring';
  private mesh: THREE.Mesh | null = null;
  private key = '';
  private bx = 0;
  private by = 0;
  private mat: THREE.ShaderMaterial;
  readonly uniforms = {
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uDay: { value: 1 },
    uSkyTint: { value: new THREE.Color(1, 1, 1) },
    /**
     * Pull distance (m). Everything pulled must land beyond whatever real geometry is drawn
     * out there, or it wins the depth test over it: with far proxies to ~370 m, the pulled far
     * ground ring at ~165 m painted over the bottoms of distant buildings (farLodInstall.ts).
     */
    uNear: { value: SKYLINE_NEAR },
  };

  constructor(public overmap: OmtLookup | null = null) {
    this.group.name = 'skyline';
    this.mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        attribute vec3 color;
        uniform float uNear;
        varying vec3 vCol;
        varying vec3 vN;
        varying float vDist;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vec3 d = w.xyz - cameraPosition;
          float L = length(d);
          vDist = L;
          if (L > uNear) w.xyz = cameraPosition + d * ((uNear + (L - uNear) * ${SKYLINE_PULL.toFixed(2)}) / L);
          vCol = color;
          vN = normal;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */ `
        layout(location = 1) out highp vec4 gNormal;
        uniform vec3 uSunDir;
        uniform float uDay;
        uniform vec3 uSkyTint;
        varying vec3 vCol;
        varying vec3 vN;
        varying float vDist;
        void main() {
          float l = 0.45 + 0.55 * max(dot(normalize(vN), uSunDir), 0.0);
          gl_FragColor = vec4(vCol * uSkyTint * l * (0.15 + 0.85 * uDay), 1.0);
          // a = -1 tags the skyline for the post pass; r = true distance (it is pulled in)
          gNormal = vec4(vDist / 1024.0, 0.0, 0.0, -1.0);
        }`,
      side: THREE.DoubleSide,
    });
    (this.mat.userData as { mrt?: boolean }).mrt = true;
  }

  /** Rebuild when the player moves to another OMT or the draw radius changes. */
  update(px: number, py: number, pz: number, radius: number): void {
    const on = (this.enabled || this.ground) && !!this.overmap && pz >= 0;
    this.group.visible = on;
    if (!on) return;
    this.stepJob();
    if (this.job) return;
    const ox = Math.floor(px / CHUNK), oy = Math.floor(py / CHUNK);
    // rebuild only after moving a couple of OMTs: the ring is far away, and a rebuild walks
    // hundreds of overmap tiles (the ground ring's inner edge allows for this lag)
    const key = `${radius}|${this.enabled}|${this.ground}|${this.season}`;
    if (this.key === key && Math.max(Math.abs(ox - this.bx), Math.abs(oy - this.by)) < LAG) return;
    this.key = key;
    const jump = Math.max(Math.abs(ox - this.bx), Math.abs(oy - this.by)) > LAG + 2;
    this.bx = ox;
    this.by = oy;
    // sliced (a rebuild walks ~900 overmap tiles: 10-20 ms at once); the old ring stays
    // up meanwhile, and the very first one is built at once
    this.job = this.rebuild(ox, oy, radius);
    // First build, or a teleport/load: the old ring (centred elsewhere) would lie right under
    // the player until a sliced rebuild finished, so build it now (10-20 ms, behind the
    // load curtain)
    if (!this.mesh || jump) runSteps(this.job);
  }

  /** Max ms per frame spent rebuilding. */
  budgetMs = 1;
  private job: Generator<void, void> | null = null;
  private stepJob(): void {
    if (this.job && stepUntil(this.job, performance.now() + this.budgetMs).done) this.job = null;
  }

  invalidate(): void {
    this.key = '';
    this.job = null;
  }

  private *rebuild(ox: number, oy: number, radius: number): Generator<void, void> {
    const pos: number[] = [], nrm: number[] = [], col: number[] = [];
    const quad = (a: number[], b: number[], c: number[], d: number[], n: number[], k: number[]) => {
      for (const p of [a, b, c, a, c, d]) { pos.push(p[0], p[1], p[2]); nrm.push(n[0], n[1], n[2]); col.push(k[0], k[1], k[2]); }
    };
    const tri = (a: number[], b: number[], c: number[], k: number[]) => {
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const l = Math.hypot(n[0], n[1], n[2]) || 1;
      for (const p of [a, b, c]) { pos.push(p[0], p[1], p[2]); nrm.push(n[0] / l, n[1] / l, n[2] / l); col.push(k[0], k[1], k[2]); }
    };
    const flat = (x0: number, z0: number, x1: number, z1: number, k: number[]) =>
      quad([x0, GROUND_Y, z1], [x1, GROUND_Y, z1], [x1, GROUND_Y, z0], [x0, GROUND_Y, z0], [0, 1, 0], k);
    const snow = this.season === 'winter';
    // Silhouettes: inner edge a ring further out than the drawn chunks (the centre lags up
    // to LAG OMTs). Ground: from well inside the drawn chunks (it is under their ground), so
    // it covers every gap out to the drawn edge wherever the player stands within the lag.
    const inner = radius + 2.6, outer = radius + SKYLINE_OUTER;
    const innerG = Math.max(1, radius - LAG);
    for (let dy = -Math.ceil(outer); dy <= Math.ceil(outer); dy++) {
      yield;
      for (let dx = -Math.ceil(outer); dx <= Math.ceil(outer); dx++) {
        const d = Math.hypot(dx, dy);
        if (d < innerG || d > outer) continue;
        const X = ox + dx, Y = oy + dy;
        const id = this.overmap!.omtAt(X, Y, 0).id;
        if (this.ground) {
          const g = groundKind(id);
          const bx = X * CHUNK, bz = Y * CHUNK;
          if (g === 'road') {
            flat(bx, bz, bx + CHUNK, bz + CHUNK, snow ? SNOW : GROUND.town);
            // the road itself as a strip (a cross for bends and junctions)
            const ns = /_ns\b|_ns_|_ns$/.test(id), ew = /_ew\b|_ew_|_ew$/.test(id);
            const k = GROUND.road, w0 = 7, w1 = 17;
            if (ns || !ew) quad([bx + w0, GROUND_Y + 0.05, bz + CHUNK], [bx + w1, GROUND_Y + 0.05, bz + CHUNK], [bx + w1, GROUND_Y + 0.05, bz], [bx + w0, GROUND_Y + 0.05, bz], [0, 1, 0], k);
            if (ew || !ns) quad([bx, GROUND_Y + 0.05, bz + w1], [bx + CHUNK, GROUND_Y + 0.05, bz + w1], [bx + CHUNK, GROUND_Y + 0.05, bz + w0], [bx, GROUND_Y + 0.05, bz + w0], [0, 1, 0], k);
          } else flat(bx, bz, bx + CHUNK, bz + CHUNK, snow && g !== 'water' ? SNOW : GROUND[g]);
        }
        if (!this.enabled || d < inner) continue;
        emitSilhouette(X, Y, id, quad, tri);
      }
    }
    if (this.mesh) {
      this.group.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh = null;
    }
    if (!pos.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const m = new THREE.Mesh(g, this.mat);
    m.frustumCulled = false;
    m.matrixAutoUpdate = false;
    this.mesh = m;
    this.group.add(m);
  }
}
