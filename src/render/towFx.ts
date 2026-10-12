import * as THREE from 'three';
import type { Game } from '../game/game';
import { CABLE_REACH, HOOK_H, TOW_TAUT_M } from '../game/towing';
import { LEVEL_HEIGHT } from '../world/coords';
import type { Renderer } from './renderer';

// Tow cables (src/game/towing.ts): a steel cable from hook to hook, sagging to the road while
// slack and pulled straight once taut, and the loose end you carry, from its hook to your hand.
// Each cable is a thin flat-shaded tube whose vertices are rewritten in place every frame (a
// pooled mesh per cable; a new TubeGeometry + Mesh per frame was churn the page didn't survive).

// Thick enough to read from the top-down camera (a real cable is ~2 cm: this is a drawn one).
const RADIUS = 0.05;
const SIDES = 5;
const SEGMENTS = 28;
/** Height of the loose end in your hand over your level's floor, m. */
const HAND_H = 0.95;
/** Hidden past this distance from the eye, m. */
const DRAW_DIST = 120;

/**
 * Points along a cable of `length` hung between a and b (Three.js space, y up): a parabola whose
 * sag keeps roughly that length (s = sqrt(3 d (L - d) / 8) for span d), lying on the ground
 * (`floor`) where it would hang below it. Taut (d >= L) is straight with a hair of sag.
 */
export function cablePoints(a: THREE.Vector3, b: THREE.Vector3, length: number, floor: number, n = SEGMENTS): THREE.Vector3[] {
  const d = Math.hypot(b.x - a.x, b.z - a.z);
  const sag = d >= length ? 0.004 * d : Math.sqrt((3 * Math.max(d, 0.1) * (length - d)) / 8);
  const out: THREE.Vector3[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const p = a.clone().lerp(b, t);
    p.y -= 4 * sag * t * (1 - t);
    if (p.y < floor + RADIUS) p.y = floor + RADIUS;
    out.push(p);
  }
  return out;
}

/** A tube of SEGMENTS + 1 rings x SIDES vertices whose positions are rewritten in place. */
class CableMesh {
  readonly mesh: THREE.Mesh;
  private readonly pos: THREE.BufferAttribute;
  constructor(mat: THREE.Material) {
    const geo = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array((SEGMENTS + 1) * SIDES * 3), 3);
    this.pos.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.pos);
    const idx: number[] = [];
    for (let i = 0; i < SEGMENTS; i++)
      for (let k = 0; k < SIDES; k++) {
        const a = i * SIDES + k, b = i * SIDES + ((k + 1) % SIDES), c = a + SIDES, d = b + SIDES;
        idx.push(a, c, b, b, c, d);
      }
    geo.setIndex(idx);
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = 'towCable';
    this.mesh.frustumCulled = false;
  }
  /** Rings of RADIUS around each point, square to the local direction. */
  set(points: THREE.Vector3[]): void {
    const arr = this.pos.array as Float32Array;
    const t = new THREE.Vector3(), n = new THREE.Vector3(), b = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i <= SEGMENTS; i++) {
      const p = points[i];
      t.subVectors(points[Math.min(SEGMENTS, i + 1)], points[Math.max(0, i - 1)]);
      if (t.lengthSq() < 1e-10) t.set(1, 0, 0);
      t.normalize();
      n.crossVectors(t, up);
      if (n.lengthSq() < 1e-6) n.set(1, 0, 0);
      n.normalize();
      b.crossVectors(n, t).normalize();
      for (let k = 0; k < SIDES; k++) {
        const a = (k / SIDES) * Math.PI * 2, cs = Math.cos(a) * RADIUS, sn = Math.sin(a) * RADIUS, o = (i * SIDES + k) * 3;
        arr[o] = p.x + n.x * cs + b.x * sn;
        arr[o + 1] = p.y + n.y * cs + b.y * sn;
        arr[o + 2] = p.z + n.z * cs + b.z * sn;
      }
    }
    this.pos.needsUpdate = true;
    this.mesh.geometry.computeVertexNormals();
    this.mesh.geometry.computeBoundingSphere();
  }
}

export class TowFx {
  private readonly group = new THREE.Group();
  private readonly mat = new THREE.MeshLambertMaterial({ color: 0x9fb6c8, flatShading: true }); // BN's light_blue cable, as galvanised steel
  private readonly hookMat = new THREE.MeshLambertMaterial({ color: 0x8a6a2a, flatShading: true });
  private readonly hookGeo = new THREE.BoxGeometry(0.12, 0.12, 0.12);
  /** Pooled: the meshes are reused every frame (geometry rewritten in place), never re-created. */
  private cables: CableMesh[] = [];
  private hooks: THREE.Mesh[] = [];

  constructor(private readonly game: Game, private readonly renderer: Renderer) {
    this.group.name = 'towFx';
    renderer.scene.add(this.group);
    renderer.beforeRender.push(() => this.update());
  }

  update(): void {
    const vs = this.game.vehicles;
    const cables: { a: THREE.Vector3; b: THREE.Vector3; length: number; floor: number; hooks: THREE.Vector3[] }[] = [];
    const p = this.game.player;
    const chunks = this.renderer.chunks;
    const near = (x: number, y: number, z: number) => Math.hypot(x - p.x, y - p.y) < DRAW_DIST && chunks.drawnAt(x, y, z);
    if (vs) {
      for (const l of vs.towing.links) {
        const [ax, ay] = vs.towing.hookWorld(l.tower, l.a), [bx, by] = vs.towing.hookWorld(l.towed, l.b);
        if (!near(ax, ay, l.tower.z) || !near(bx, by, l.towed.z)) continue;
        const a = new THREE.Vector3(ax, l.tower.z * LEVEL_HEIGHT + HOOK_H, ay), b = new THREE.Vector3(bx, l.towed.z * LEVEL_HEIGHT + HOOK_H, by);
        cables.push({ a, b, length: TOW_TAUT_M, floor: Math.min(l.tower.z, l.towed.z) * LEVEL_HEIGHT, hooks: [a, b] });
      }
      const loose = vs.towing.looseEnd();
      if (loose) {
        const [ax, ay] = vs.towing.hookWorld(loose.v, loose.hook);
        if (near(ax, ay, loose.v.z)) {
          // From the hook to your hand: a little ahead of you and to the right, where it's held.
          const right = p.yaw + Math.PI / 2;
          const hx = p.x + Math.sin(p.yaw) * 0.35 + Math.sin(right) * 0.25, hy = p.y - Math.cos(p.yaw) * 0.35 - Math.cos(right) * 0.25;
          const a = new THREE.Vector3(ax, loose.v.z * LEVEL_HEIGHT + HOOK_H, ay);
          cables.push({ a, b: new THREE.Vector3(hx, p.z * LEVEL_HEIGHT + HAND_H, hy), length: CABLE_REACH, floor: loose.v.z * LEVEL_HEIGHT, hooks: [a] });
        }
      }
    }
    while (this.cables.length < cables.length) {
      const c = new CableMesh(this.mat);
      this.group.add(c.mesh);
      this.cables.push(c);
    }
    const hookAt: THREE.Vector3[] = [];
    this.cables.forEach((m, i) => {
      m.mesh.visible = i < cables.length;
      if (!m.mesh.visible) return;
      const c = cables[i];
      m.set(cablePoints(c.a, c.b, c.length, c.floor));
      hookAt.push(...c.hooks);
    });
    while (this.hooks.length < hookAt.length) {
      const h = new THREE.Mesh(this.hookGeo, this.hookMat);
      this.group.add(h);
      this.hooks.push(h);
    }
    this.hooks.forEach((h, i) => {
      h.visible = i < hookAt.length;
      if (h.visible) h.position.copy(hookAt[i]);
    });
  }
}
