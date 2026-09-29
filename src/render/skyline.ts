import * as THREE from 'three';
import { runSteps, stepUntil } from './steps';
import { CHUNK } from '../world/coords';
import { hash2 } from './ground';

// Distant skyline (look.ts `skyline`): beyond the drawn chunks the world used to end in a
// flat wall of fog. This ring of cheap silhouettes — house boxes with gable roofs, blocky
// town buildings, clumps of low-poly tree crowns — is built from the overmap (what really
// is out there), so the horizon shows where the next town and the forests are.
//
// Everything past NEAR metres is pulled toward the camera in the vertex shader keeping its
// direction (an impostor: same angular size and place on the horizon, well inside the
// camera's far plane). The pixels are tagged in the normal target (alpha 0.5) so the post
// pass gives them their own haze instead of the opaque draw-distance fog.

export interface OmtLookup {
  omtAt(x: number, y: number, z: number): { id: string };
}

type Kind = 'house' | 'town' | 'tall' | 'forest' | 'none';

function classify(id: string): Kind {
  if (/^forest|swamp/.test(id)) return 'forest';
  if (/^(field|road|river|lake|bridge|open_air|empty_rock|solid_earth|hiway|railroad|sewer|subway|crater|lab|ants|anthill|slimepit|cave)/.test(id)) return 'none';
  if (/house|home|mansion|trailer|cabin|garage|shed|duplex|bungalow|cottage|farm|barn|church/.test(id)) return 'house';
  if (/apartment|office|hospital|hotel|tower|condo|skyscraper|highrise|high_rise/.test(id)) return 'tall';
  return 'town';
}

const NEAR = 140;

export class SkylineLayer {
  readonly group = new THREE.Group();
  enabled = false;
  private mesh: THREE.Mesh | null = null;
  private key = '';
  private bx = 0;
  private by = 0;
  private mat: THREE.ShaderMaterial;
  readonly uniforms = {
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uDay: { value: 1 },
    uSkyTint: { value: new THREE.Color(1, 1, 1) },
  };

  constructor(public overmap: OmtLookup | null = null) {
    this.group.name = 'skyline';
    this.mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        attribute vec3 color;
        varying vec3 vCol;
        varying vec3 vN;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vec3 d = w.xyz - cameraPosition;
          float L = length(d);
          if (L > ${NEAR.toFixed(1)}) w.xyz = cameraPosition + d * ((${NEAR.toFixed(1)} + (L - ${NEAR.toFixed(1)}) * 0.12) / L);
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
        void main() {
          float l = 0.45 + 0.55 * max(dot(normalize(vN), uSunDir), 0.0);
          gl_FragColor = vec4(vCol * uSkyTint * l * (0.15 + 0.85 * uDay), 1.0);
          gNormal = vec4(0.5, 0.5, 1.0, 0.5);
        }`,
      side: THREE.DoubleSide,
    });
    (this.mat.userData as { mrt?: boolean }).mrt = true;
  }

  /** Rebuild when the player moves to another OMT or the draw radius changes. */
  update(px: number, py: number, pz: number, radius: number): void {
    const on = this.enabled && !!this.overmap && pz >= 0;
    this.group.visible = on;
    if (!on) return;
    this.stepJob();
    if (this.job) return;
    const ox = Math.floor(px / CHUNK), oy = Math.floor(py / CHUNK);
    // rebuild only after moving a few OMTs: the ring is far away, and a rebuild walks
    // hundreds of overmap tiles
    if (this.key === `${radius}` && Math.max(Math.abs(ox - this.bx), Math.abs(oy - this.by)) < 3) return;
    this.key = `${radius}`;
    this.bx = ox;
    this.by = oy;
    // sliced (a rebuild walks ~900 overmap tiles: 10-20 ms at once); the old ring stays
    // up meanwhile, and the very first one is built at once
    this.job = this.rebuild(ox, oy, radius);
    if (!this.mesh) runSteps(this.job);
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
    // inner edge one ring further out than the drawn chunks: the centre lags up to 2 OMTs
    const inner = radius + 2.6, outer = radius + 13;
    for (let dy = -Math.ceil(outer); dy <= Math.ceil(outer); dy++) {
      yield;
      for (let dx = -Math.ceil(outer); dx <= Math.ceil(outer); dx++) {
        const d = Math.hypot(dx, dy);
        if (d < inner || d > outer) continue;
        const X = ox + dx, Y = oy + dy;
        const kind = classify(this.overmap!.omtAt(X, Y, 0).id);
        if (kind === 'none') continue;
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
