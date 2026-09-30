import * as THREE from 'three';
import { LEVEL_HEIGHT } from '../../world/coords';
import { addNormalOutput, patchBandedLambert } from '../materials';
import { netSize, paintPart, texelDims, type Img, type PaintOpts, type SpriteInfo } from './paint';
import { newPoseOut, resetPose, type PoseIn, type PoseOut, type Rig } from './rig';

// Draws every procedural character (render/chars/rig.ts bodies) as instanced boxes: one
// instance per body part, one InstancedMesh per skin page (and per layer: live creatures are
// rewritten every frame, lying corpses only when one is added, removed or still falling).
// A whole street of zombies is one or two draw calls plus their shadow pass.
//
// Skins (paint.ts nets) live on 1024² RGBA pages, shelf-packed. A page is uploaded again when
// a new skin is painted on it, at most once per frame; new species arrive a few at a time.
//
// Per-instance attributes (see VERT below):
//   instanceMatrix  the part's box: joint chain × centre offset × size
//   cTex            net origin + W, H in texels
//   cMisc           D (texels), sky visibility, hostile emphasis, far-silhouette factor
//   cFlash          hit/telegraph flash rgb + strength
//   cRoot           creature root (three.js world coords), for the light-map sample and range

const PAGE = 1024;
/** Beyond this many pages every skin is dropped and repainted on demand (a very long session). */
const MAX_PAGES = 6;

export interface Skin {
  page: number;
  /** per part: net origin x, y and texel dims W, H, D */
  rects: Int32Array;
  refs: number;
}

class SkinPage {
  readonly img: Img = { w: PAGE, h: PAGE, data: new Uint8Array(PAGE * PAGE * 4) };
  readonly tex: THREE.DataTexture;
  private shelves: { y: number; h: number; x: number }[] = [];
  private nextY = 0;
  dirty = false;
  constructor() {
    this.tex = new THREE.DataTexture(this.img.data, PAGE, PAGE, THREE.RGBAFormat);
    this.tex.magFilter = THREE.NearestFilter;
    this.tex.minFilter = THREE.NearestFilter;
    this.tex.generateMipmaps = false;
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.needsUpdate = true;
  }
  /** Shelf packing; null when full. 1 px gutter so nearest sampling never bleeds. */
  alloc(w: number, h: number): [number, number] | null {
    w += 1; h += 1;
    for (const s of this.shelves) {
      if (h <= s.h && h >= s.h * 0.6 && s.x + w <= PAGE) {
        const r: [number, number] = [s.x, s.y];
        s.x += w;
        return r;
      }
    }
    if (this.nextY + h > PAGE || w > PAGE) return null;
    const s = { y: this.nextY, h, x: w };
    this.shelves.push(s);
    this.nextY += h;
    return [0, s.y];
  }
}

// ------------------------------------------------------------------ material

const VERT_PARS = /* glsl */ `
attribute vec4 cTex;
attribute vec4 cMisc;
attribute vec4 cFlash;
attribute vec4 cRoot;
attribute vec3 cFace;
varying vec4 vFaceRect;
varying vec2 vFaceUv;
varying vec4 vFlash;
varying float vSkyVis;
varying float vEmph;
varying vec3 vLmPos;
uniform float uFarNear;
uniform float uFarFar;
`;
// Face rect in the net from the face id (paint.ts layout: right, front, left, back, top, bottom).
const VERT_MAIN = /* glsl */ `
#include <begin_vertex>
{
  float W = cTex.z, H = cTex.w, D = cMisc.x;
  int f = int(cFace.x + 0.5);
  vec4 r = f == 0 ? vec4(0.0, D, D, H) : f == 1 ? vec4(D, D, W, H) : f == 2 ? vec4(D + W, D, D, H)
         : f == 3 ? vec4(2.0 * D + W, D, W, H) : f == 4 ? vec4(D, 0.0, W, D) : vec4(D + W, 0.0, W, D);
  vFaceRect = vec4(cTex.xy + r.xy, r.zw);
  vFaceUv = cFace.yz;
  vFlash = cFlash;
  vSkyVis = cMisc.y;
  // distant hostiles get a light floor so they never sink into the shade (see charLayer.ts)
  float dist = length(cRoot.xyz - cameraPosition);
  vEmph = cMisc.z * smoothstep(uFarNear, uFarFar, dist);
  vLmPos = cRoot.xyz + vec3(0.0, 0.6, 0.0);
}
`;
const FRAG_PARS = /* glsl */ `
varying vec4 vFaceRect;
varying vec2 vFaceUv;
varying vec4 vFlash;
varying float vSkyVis;
varying float vEmph;
#define SKYVIS vSkyVis
uniform float uEmphK;
`;
const FRAG_MAP = /* glsl */ `
{
  vec2 texel = vFaceRect.xy + clamp(vFaceUv * vFaceRect.zw, vec2(0.001), vFaceRect.zw - 0.001);
  vec4 c = texture2D(map, texel / vec2(${PAGE}.0));
  diffuseColor.rgb *= c.rgb;
  diffuseColor.rgb = mix(diffuseColor.rgb, vFlash.rgb, vFlash.a);
}
`;

const matCache = new Map<THREE.Texture, THREE.MeshLambertMaterial>();
export const charUniforms = {
  /** distance (m) where hostile emphasis starts / is full */
  uFarNear: { value: 12 },
  uFarFar: { value: 40 },
  /** emissive share of albedo at full emphasis */
  uEmphK: { value: 0.45 },
};

function charMaterial(page: THREE.Texture): THREE.MeshLambertMaterial {
  let m = matCache.get(page);
  if (m) return m;
  m = new THREE.MeshLambertMaterial({ map: page });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, charUniforms);
    shader.vertexShader = VERT_PARS + shader.vertexShader.replace('#include <begin_vertex>', VERT_MAIN);
    shader.fragmentShader = FRAG_PARS + shader.fragmentShader
      .replace('#include <map_fragment>', FRAG_MAP)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * vEmph * uEmphK + vFlash.rgb * vFlash.a * 0.8;');
    patchBandedLambert(shader, 'world');
    addNormalOutput(shader, true, 1);
  };
  m.customProgramCacheKey = () => 'cdda-char';
  (m.userData as { mrt?: boolean }).mrt = true;
  matCache.set(page, m);
  return m;
}

/** Unit cube (-0.5..0.5) with per-vertex face id + face-local uv (paint.ts conventions). */
function cubeGeometry(): THREE.BufferGeometry {
  const P: number[] = [], N: number[] = [], F: number[] = [], UV: number[] = [], I: number[] = [];
  // face: normal, the axis pointing to the viewer's right (u), the axis pointing down (v)
  const faces: [number[], number[], number[]][] = [
    [[1, 0, 0], [0, 0, -1], [0, -1, 0]], // right (+x): u toward the front
    [[0, 0, -1], [-1, 0, 0], [0, -1, 0]], // front (-z): u toward -x
    [[-1, 0, 0], [0, 0, 1], [0, -1, 0]], // left (-x)
    [[0, 0, 1], [1, 0, 0], [0, -1, 0]], // back (+z)
    [[0, 1, 0], [1, 0, 0], [0, 0, 1]], // top: u +x, v toward the back
    [[0, -1, 0], [1, 0, 0], [0, 0, -1]], // bottom
  ];
  faces.forEach(([n, u, v], f) => {
    const base = P.length / 3;
    for (const [a, b] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      for (let k = 0; k < 3; k++) P.push(n[k] * 0.5 + u[k] * (a - 0.5) + v[k] * (b - 0.5));
      N.push(...n);
      F.push(f, a, b);
      UV.push(a, b);
    }
    // winding: counter-clockwise seen from outside (u right, v down => (0,0),(0,1),(1,0))
    I.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
  g.setAttribute('cFace', new THREE.Float32BufferAttribute(F, 3));
  g.setIndex(I);
  return g;
}

// ------------------------------------------------------------------ batches

class Batch {
  mesh: THREE.InstancedMesh;
  count = 0;
  private cap = 0;
  tex!: THREE.InstancedBufferAttribute;
  misc!: THREE.InstancedBufferAttribute;
  flash!: THREE.InstancedBufferAttribute;
  root!: THREE.InstancedBufferAttribute;
  private geo!: THREE.InstancedBufferGeometry;
  constructor(private cube: THREE.BufferGeometry, private page: THREE.Texture, private parent: THREE.Object3D, private shadows: boolean) {
    this.mesh = this.make(256);
  }
  private make(cap: number): THREE.InstancedMesh {
    const g = new THREE.InstancedBufferGeometry();
    g.index = this.cube.index;
    for (const k of ['position', 'normal', 'uv', 'cFace']) g.setAttribute(k, this.cube.getAttribute(k));
    const attr = (n: string) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
      a.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute(n, a);
      return a;
    };
    this.tex = attr('cTex');
    this.misc = attr('cMisc');
    this.flash = attr('cFlash');
    this.root = attr('cRoot');
    this.geo = g;
    const m = new THREE.InstancedMesh(g, charMaterial(this.page), cap);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.frustumCulled = false; // instances span the whole view
    m.castShadow = this.shadows;
    m.receiveShadow = true;
    m.count = 0;
    m.name = 'characters';
    this.parent.add(m);
    this.cap = cap;
    return m;
  }
  ensure(n: number): void {
    if (n <= this.cap) return;
    let cap = this.cap;
    while (cap < n) cap *= 2;
    this.parent.remove(this.mesh);
    this.mesh.dispose();
    this.geo.dispose();
    this.mesh = this.make(cap);
  }
  commit(n: number): void {
    this.count = n;
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    for (const a of [this.tex, this.misc, this.flash, this.root]) a.needsUpdate = true;
  }
}

// ------------------------------------------------------------------ instances

const tmpM = new THREE.Matrix4();
const tmpM2 = new THREE.Matrix4();
const tmpE = new THREE.Euler();
const tmpQ = new THREE.Quaternion();
const tmpV = new THREE.Vector3();
const tmpS = new THREE.Vector3();
const AXIS = new THREE.Vector3();

export class CharInstance {
  /** Tile coords (x east, y south) and level; set() writes these. */
  x = 0;
  y = 0;
  z = 0;
  /** extra lift above the level floor (m): ground relief, hover */
  lift = 0;
  /** radians, 0 = north, clockwise (Monster.facing convention) */
  yaw = 0;
  /** topple: horizontal direction the body falls toward (tile coords) and angle 0..pi/2 */
  fallDx = 0;
  fallDy = 1;
  fall = 0;
  /** stretch/squash multipliers (telegraph, knock-back) */
  sy = 1;
  sxz = 1;
  /** 0 = normal; 1 = hostile (readability boost at range) */
  emph = 0;
  /** extra silhouette fattening 0..1 (far LOD) */
  far = 0;
  visible = true;
  skyVis = 1;
  readonly pose: PoseOut;
  readonly mats: Float32Array;
  /** set when the pose/placement changed and matrices must be rebuilt */
  dirty = true;
  flashT = 0;
  flashDur = 0;
  readonly flashColor = new THREE.Color();
  /** @internal */ layer: CharLayer | null;
  constructor(layer: CharLayer, readonly rig: Rig, public skin: Skin) {
    this.layer = layer;
    this.pose = newPoseOut(rig.parts.length);
    this.mats = new Float32Array(rig.parts.length * 16);
  }
  get alive(): boolean {
    return this.layer !== null;
  }
  setVisible(v: boolean): void {
    if (v === this.visible) return;
    this.visible = v;
    this.layer?.touch();
  }
  setPose(p: PoseIn): void {
    resetPose(this.pose);
    this.rig.pose(p, this.pose);
    this.dirty = true;
  }
  flash(color = 0xffffff, seconds = 0.2): void {
    this.flashColor.setHex(color);
    this.flashT = this.flashDur = seconds;
    this.layer?.touch();
  }
  remove(): void {
    this.layer?.removeInst(this);
  }

  /** Rebuild the part matrices (world space). */
  build(groundAt: ((x: number, y: number, z: number) => number) | null): void {
    const parts = this.rig.parts;
    const po = this.pose;
    const foot = this.z * LEVEL_HEIGHT + (groundAt?.(this.x, this.y, this.z) ?? 0) + this.lift;
    // root: position -> topple about the feet -> yaw -> lean -> root offset
    const root = tmpM.makeTranslation(this.x, foot, this.y);
    if (this.fall > 0) {
      const d = Math.hypot(this.fallDx, this.fallDy) || 1;
      // rotate "up" toward the fall direction: axis = up × dir (three.js x, z)
      AXIS.set(this.fallDy / d, 0, -this.fallDx / d);
      root.multiply(tmpM2.makeRotationAxis(AXIS, this.fall));
    }
    root.multiply(tmpM2.makeRotationY(-this.yaw));
    tmpE.set(po.lean[0], po.lean[1], po.lean[2]);
    root.multiply(tmpM2.makeRotationFromEuler(tmpE));
    root.multiply(tmpM2.makeTranslation(po.pos[0], po.pos[1], po.pos[2]));
    root.multiply(tmpM2.makeScale(this.sxz, this.sy, this.sxz));
    const joints = this.layer!.jointScratch(parts.length);
    const fat = 1 + this.far * 0.45;
    for (let i = 0; i < parts.length; i++) {
      const pd = parts[i];
      const J = joints[i];
      J.copy(pd.parent < 0 ? root : joints[pd.parent]);
      const r = pd.rest;
      tmpE.set((r?.[0] ?? 0) + po.rot[i * 3], (r?.[1] ?? 0) + po.rot[i * 3 + 1], (r?.[2] ?? 0) + po.rot[i * 3 + 2]);
      tmpQ.setFromEuler(tmpE);
      J.multiply(tmpM2.compose(tmpV.set(pd.joint[0], pd.joint[1], pd.joint[2]), tmpQ, tmpS.set(1, 1, 1)));
      // the box: joint frame -> centre -> size (+ pose scale, + far-LOD thickening)
      const k = pd.kind === 'core' ? 1 + (fat - 1) * 0.4 : fat;
      const sx = pd.size[0] * po.scl[i * 3] * (pd.kind === 'thin' ? 1 : k);
      const sy = pd.size[1] * po.scl[i * 3 + 1];
      const sz = pd.size[2] * po.scl[i * 3 + 2] * (pd.kind === 'thin' ? 1 : k);
      tmpM2.makeScale(sx, sy, sz);
      tmpM2.setPosition(pd.center[0] * po.scl[i * 3], pd.center[1] * po.scl[i * 3 + 1], pd.center[2] * po.scl[i * 3 + 2]);
      tmpM2.premultiply(J);
      tmpM2.toArray(this.mats, i * 16);
    }
    this.dirty = false;
  }
}

export interface SkinSource {
  /** stable id of the sprite pixels (atlas frame / composite key) + anything else that changes the paint */
  key: string;
  info: () => SpriteInfo | null;
  opts?: PaintOpts;
}

export class CharLayer {
  readonly group = new THREE.Group();
  private cube = cubeGeometry();
  private live = new Set<CharInstance>();
  private batches = new Map<number, Batch>();
  private scratch: THREE.Matrix4[] = [];
  private needsWrite = true;
  groundAt: ((x: number, y: number, z: number) => number) | null = null;
  skyVisAt: ((x: number, y: number, z: number) => number) | null = null;
  constructor(private shadows = true, readonly label = 'chars') {
    this.group.name = label;
  }

  get count(): number {
    return this.live.size;
  }
  /** @internal */
  jointScratch(n: number): THREE.Matrix4[] {
    while (this.scratch.length < n) this.scratch.push(new THREE.Matrix4());
    return this.scratch;
  }

  add(rig: Rig, skin: Skin): CharInstance {
    const inst = new CharInstance(this, rig, skin);
    skin.refs++;
    this.live.add(inst);
    this.needsWrite = true;
    return inst;
  }

  /** @internal */
  removeInst(inst: CharInstance): void {
    if (!this.live.delete(inst)) return;
    inst.skin.refs--;
    inst.layer = null;
    this.needsWrite = true;
  }

  /** @internal flash started */
  touch(): void {
    this.needsWrite = true;
  }

  /** Swap an instance's skin (outfit change). */
  reskin(inst: CharInstance, skin: Skin): void {
    inst.skin.refs--;
    skin.refs++;
    inst.skin = skin;
    this.needsWrite = true;
  }

  /**
   * Upload pages painted since last time, rebuild dirty matrices and rewrite the instance
   * buffers when anything changed. `dt` fades flashes. Call once per frame.
   */
  flush(dt: number, store: SkinStore): void {
    store.upload();
    let any = this.needsWrite;
    for (const i of this.live) {
      if (i.flashT > 0) {
        i.flashT = Math.max(0, i.flashT - dt);
        any = true;
      }
      if (i.dirty) {
        i.build(this.groundAt);
        any = true;
      }
    }
    if (!any) return;
    this.needsWrite = false;
    // count per page
    const per = new Map<number, number>();
    for (const i of this.live) if (i.visible) per.set(i.skin.page, (per.get(i.skin.page) ?? 0) + i.rig.parts.length);
    for (const [pg, n] of per) {
      let b = this.batches.get(pg);
      if (!b) {
        b = new Batch(this.cube, store.texture(pg), this.group, this.shadows);
        this.batches.set(pg, b);
      }
      b.ensure(n);
    }
    const fill = new Map<number, number>();
    for (const i of this.live) {
      if (!i.visible) continue;
      const b = this.batches.get(i.skin.page)!;
      let k = fill.get(i.skin.page) ?? 0;
      const M = b.mesh.instanceMatrix.array as Float32Array;
      const T = b.tex.array as Float32Array, X = b.misc.array as Float32Array, F = b.flash.array as Float32Array, R = b.root.array as Float32Array;
      const fk = i.flashDur > 0 ? i.flashT / i.flashDur : 0;
      const sky = this.skyVisAt ? this.skyVisAt(i.x, i.y, i.z) : 1;
      const rx = i.x, ry = i.z * LEVEL_HEIGHT + i.lift, rz = i.y;
      for (let p = 0; p < i.rig.parts.length; p++, k++) {
        M.set(i.mats.subarray(p * 16, p * 16 + 16), k * 16);
        const r = i.skin.rects;
        T[k * 4] = r[p * 5]; T[k * 4 + 1] = r[p * 5 + 1]; T[k * 4 + 2] = r[p * 5 + 2]; T[k * 4 + 3] = r[p * 5 + 3];
        X[k * 4] = r[p * 5 + 4]; X[k * 4 + 1] = sky; X[k * 4 + 2] = i.emph; X[k * 4 + 3] = i.far;
        F[k * 4] = i.flashColor.r; F[k * 4 + 1] = i.flashColor.g; F[k * 4 + 2] = i.flashColor.b; F[k * 4 + 3] = fk;
        R[k * 4] = rx; R[k * 4 + 1] = ry; R[k * 4 + 2] = rz; R[k * 4 + 3] = 0;
      }
      fill.set(i.skin.page, k);
    }
    for (const [pg, b] of this.batches) b.commit(fill.get(pg) ?? 0);
  }

  dispose(): void {
    for (const b of this.batches.values()) {
      this.group.remove(b.mesh);
      b.mesh.dispose();
    }
    this.batches.clear();
    this.live.clear();
  }
}

/** Skin pages shared by every layer (monsters, NPCs, corpses): one texture per page. */
export class SkinStore {
  private pages: SkinPage[] = [];
  private skins = new Map<string, Skin>();

  get pageCount(): number {
    return this.pages.length;
  }
  get skinCount(): number {
    return this.skins.size;
  }

  texture(page: number): THREE.Texture {
    return this.pages[page].tex;
  }

  get(rig: Rig, src: SkinSource): Skin {
    const dimsKey = rig.parts.map((p) => texelDims(p.size).join('x')).join(',');
    const key = `${src.key}|${rig.shape.arch}|${dimsKey}|${src.opts?.eyes?.join(',') ?? ''}`;
    const hit = this.skins.get(key);
    if (hit) return hit;
    const info = src.info();
    const n = rig.parts.length;
    const rects = new Int32Array(n * 5);
    const nets = rig.parts.map((p) => {
      const d = texelDims(p.size);
      return { d, wh: netSize(d[0], d[1], d[2]) };
    });
    let pageIdx = -1;
    let places: [number, number][] = [];
    for (let attempt = 0; attempt < 2 && pageIdx < 0; attempt++) {
      if (!this.pages.length) this.pages.push(new SkinPage());
      const pg = this.pages[this.pages.length - 1];
      places = [];
      for (const nt of nets) {
        const at = pg.alloc(nt.wh[0], nt.wh[1]);
        if (!at) break;
        places.push(at);
      }
      if (places.length === n) pageIdx = this.pages.length - 1;
      else if (this.pages.length < MAX_PAGES) this.pages.push(new SkinPage());
      else throw new Error(`SkinStore: out of skin pages (${this.skins.size} skins)`);
    }
    if (pageIdx < 0) throw new Error('SkinStore: a single skin does not fit a page');
    const pg = this.pages[pageIdx];
    nets.forEach((nt, i) => {
      const [x, y] = places[i];
      rects.set([x, y, nt.d[0], nt.d[1], nt.d[2]], i * 5);
      if (info) paintPart(pg.img, x, y, nt.d, rig.parts[i].src, info, src.opts);
      else fillGrey(pg.img, x, y, nt.wh[0], nt.wh[1]);
    });
    pg.dirty = true;
    const skin: Skin = { page: pageIdx, rects, refs: 0 };
    this.skins.set(key, skin);
    return skin;
  }

  /** Push painted pages to the GPU (once per frame at most). */
  upload(): void {
    for (const p of this.pages) if (p.dirty) (p.tex.needsUpdate = true, p.dirty = false);
  }
}

function fillGrey(img: Img, x0: number, y0: number, w: number, h: number): void {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
    const i = (y * img.w + x) * 4;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = 110;
    img.data[i + 3] = 255;
  }
}
