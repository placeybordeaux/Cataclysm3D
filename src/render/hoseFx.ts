import * as THREE from 'three';
import type { Game } from '../game/game';
import type { HosePoint, HoseSpec } from '../game/activity';
import { LEVEL_HEIGHT } from '../world/coords';
import type { Renderer } from './renderer';

// The hose (or a can's pour) for liquid-moving activities: siphoning a tank into a container
// or another vehicle, pouring a jerrycan into a car (ActivitySpec.hose). A clear vinyl tube
// droops from the filler cap to the ground, lies along the ground around the vehicle bodies
// (spec.path) and rises to the other end, and slugs of the liquid's colour run along it, so you
// can see what's flowing where while the activity's clock warp runs. A pour is a tipped can in
// your hands with an arcing stream into the filler (or the side in front of you). Ends are re-read every frame and the tube is rebuilt only
// when one moves, so a parked siphon costs nothing but the slugs.

/** Most slugs on screen at once (a long hose around two cars spaces them out further). */
const MAX_BLOBS = 40;
/** Metres between slugs, and how fast they run in real seconds: reads as flow at any warp. */
const BLOB_GAP = 0.32;
const BLOB_SPEED = 1.4;
const TUBE_R = 0.045;
/** Flat-shaded few-sided tube: chunky, like the game's other low-poly props. */
const TUBE_SIDES = 6;

const toVec = (p: HosePoint) => new THREE.Vector3(p.x, p.z * LEVEL_HEIGHT + p.h, p.y);

function hoseCurve(a: HosePoint, b: HosePoint, spec: HoseSpec, floor: number): THREE.Curve<THREE.Vector3> {
  const va = toVec(a), vb = toVec(b);
  if (spec.style === 'pour') {
    // The spout lifts the stream a little before it falls into the neck.
    const mid = va.clone().lerp(vb, 0.3);
    mid.y = Math.max(va.y, vb.y) + 0.08;
    return new THREE.QuadraticBezierCurve3(va, mid, vb);
  }
  const ground = spec.path?.(a, b) ?? [{ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }];
  const g = ground.map((p) => new THREE.Vector3(p.x, floor, p.y));
  // A knee halfway down each end so the hose droops off the cap instead of kinking.
  const knee = (end: THREE.Vector3, to: THREE.Vector3) => end.clone().lerp(to, 0.45).setY(floor + (end.y - floor) * 0.4);
  const rough = new THREE.CatmullRomCurve3([va, knee(va, g[0]), ...g, knee(vb, g[g.length - 1]), vb], false, 'centripetal');
  // The spline swings a little below the ground between ground points: hold it on the ground.
  const n = Math.max(16, Math.ceil(rough.getLength() * 8));
  return new THREE.CatmullRomCurve3(rough.getSpacedPoints(n).map((p) => (p.y < floor ? p.setY(floor) : p)), false, 'centripetal');
}

export class HoseFx {
  private readonly group = new THREE.Group();
  private tube: THREE.Mesh | null = null;
  // Translucent but not glassy: a pale green-grey vinyl you can see on asphalt and grass.
  private readonly tubeMat = new THREE.MeshLambertMaterial({ color: 0xc4e0cc, transparent: true, opacity: 0.72, depthWrite: false, flatShading: true });
  private readonly blobMat = new THREE.MeshBasicMaterial({ color: 0xd8b040 });
  private readonly canMat = new THREE.MeshLambertMaterial({ color: 0x9c2a1c, flatShading: true });
  private readonly blobs: THREE.InstancedMesh;
  private readonly can: THREE.Mesh;
  private curve: THREE.Curve<THREE.Vector3> | null = null;
  private length = 1;
  private key = '';
  private t = 0;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly s = new THREE.Vector3();
  private readonly z = new THREE.Vector3(0, 0, 1);

  constructor(private readonly game: Game, renderer: Renderer) {
    this.group.name = 'hoseFx';
    renderer.scene.add(this.group);
    this.blobs = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), this.blobMat, MAX_BLOBS);
    this.blobs.frustumCulled = false;
    this.group.add(this.blobs);
    // A jerrycan for pours: tall, narrow, spout on its top corner (pivot at the spout).
    const canGeo = new THREE.BoxGeometry(0.09, 0.22, 0.16).translate(0, -0.11, -0.08);
    this.can = new THREE.Mesh(canGeo, this.canMat);
    this.group.add(this.can);
    this.group.visible = false;
  }

  update(realDt: number): void {
    const spec = this.game.activities.current?.spec.hose;
    const a = spec?.from(), b = spec?.to();
    if (!spec || !a || !b) { this.group.visible = false; this.key = ''; return; }
    this.group.visible = true;
    // Rebuild only when an end moved more than a centimetre (or the style changed).
    const key = [spec.style, a.x, a.y, a.z, a.h, b.x, b.y, b.z, b.h].map((n) => (typeof n === 'number' ? Math.round(n * 100) : n)).join(',');
    if (key !== this.key) {
      this.key = key;
      // a touch above the floor: terrain tops (pavement, grass) sit slightly over the level's 0
      this.curve = hoseCurve(a, b, spec, a.z * LEVEL_HEIGHT + TUBE_R + 0.03);
      this.length = this.curve.getLength();
      this.tube?.geometry.dispose();
      if (this.tube) this.group.remove(this.tube);
      this.tube = null;
      if (spec.style === 'hose') {
        this.tube = new THREE.Mesh(new THREE.TubeGeometry(this.curve, Math.max(24, Math.ceil(this.length * 10)), TUBE_R, TUBE_SIDES, false), this.tubeMat);
        this.group.add(this.tube);
      }
      this.can.visible = spec.style === 'pour';
      if (spec.style === 'pour') {
        // Tipped past level over the neck: its body runs back toward your hands, a little up.
        const from = toVec(a), to = toVec(b);
        this.can.position.copy(from);
        this.can.lookAt(new THREE.Vector3(to.x, from.y, to.z));
        this.can.rotateX(1.8);
      }
    }
    this.blobMat.color.setHex(spec.color);
    const curve = this.curve!;
    if (spec.style === 'pour') {
      // An unbroken stream: overlapping slugs, slightly wider at the spout.
      const n = 8;
      this.t = (this.t + (realDt * 2.2) / Math.max(this.length, 0.2)) % 1;
      for (let i = 0; i < MAX_BLOBS; i++) {
        if (i >= n) { this.m.makeScale(0, 0, 0); this.blobs.setMatrixAt(i, this.m); continue; }
        const u = (this.t + i / n) % 1;
        const w = 0.05 - 0.015 * u;
        this.place(i, curve, u, w, (this.length / n) * 1.6);
      }
    } else {
      const n = Math.min(MAX_BLOBS, Math.max(4, Math.round(this.length / BLOB_GAP)));
      this.t = (this.t + (realDt * BLOB_SPEED) / this.length) % 1;
      for (let i = 0; i < MAX_BLOBS; i++) {
        if (i >= n) { this.m.makeScale(0, 0, 0); this.blobs.setMatrixAt(i, this.m); continue; }
        // Slugs fill most of the bore so they show through the vinyl's sides.
        this.place(i, curve, (this.t + i / n) % 1, TUBE_R * 1.5, BLOB_GAP * 0.45);
      }
    }
    this.blobs.instanceMatrix.needsUpdate = true;
  }

  /** Slug i at curve parameter u, `w` wide and `len` long along the curve. */
  private place(i: number, curve: THREE.Curve<THREE.Vector3>, u: number, w: number, len: number): void {
    this.q.setFromUnitVectors(this.z, curve.getTangentAt(u));
    this.m.compose(curve.getPointAt(u), this.q, this.s.set(w, w, len));
    this.blobs.setMatrixAt(i, this.m);
  }
}

export function installHoseFx(game: Game, renderer: Renderer): HoseFx {
  const fx = new HoseFx(game, renderer);
  let last = performance.now();
  game.systems.push({ name: 'hoseFx', update: () => {
    const now = performance.now();
    fx.update(Math.min(0.1, (now - last) / 1000));
    last = now;
  } });
  return fx;
}
