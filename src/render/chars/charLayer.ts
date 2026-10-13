import * as THREE from 'three';
import { touchInstanceRange } from '../instanceUpload';
import { LEVEL_HEIGHT } from '../../world/coords';
import { addNormalOutput, patchBandedLambert } from '../materials';
import { analyseSprite, netSize, paintPart, texelDims, type Img, type PaintOpts, type SpriteInfo } from './paint';
import { paintStyled, personPalette } from './styled';
import { paintZombiePart } from './zombieSkin';
import { newPoseOut, resetPose, type PoseIn, type PoseOut, type Rig } from './rig';
import { SHAPES, shapeGeometry } from './shapes';

// Draws every procedural character (render/chars/rig.ts bodies) as instanced boxes: one
// instance per body part, one InstancedMesh per skin page and unit shape (shapes.ts: box,
// octagonal prism, bevelled box, ball; and per layer: live creatures are rewritten every
// frame, lying corpses only when one is added, removed or still falling). A whole street of
// zombies is a handful of draw calls plus their shadow pass.
//
// Skin alpha is not transparency: 255 is a normal texel, 0 is cut out (torn cloth edges,
// smoke dither) and anything between glows (1 - a/255 of its colour is emitted): acid sacs,
// red eyes, electric arcs.
//
// Skins (paint.ts nets) live on 1024² RGBA pages, shelf-packed. A page is uploaded again when
// a new skin is painted on it, at most once per frame; new species arrive a few at a time.
//
// Per-instance attributes (see VERT below):
//   instanceMatrix  the part's box: joint chain × centre offset × size
//   cTex            net origin + W, H in texels
//   cMisc           D (texels), sky visibility, hostile emphasis, taper axis (0 = y, 1 = z)
//   cShape          taper: cross-section scale at the -axis end (xy) and the +axis end (zw)
//   cFlash          hit/telegraph flash rgb + strength
//   cRoot           creature root (three.js world coords), for the light-map sample and range

const PAGE = 1024;
/** More pages than this means skins are leaking (every page is 4 MB of RAM + VRAM): warn. */
const WARN_PAGES = 6;

export interface Skin {
  page: number;
  /** Per part: net origin x, y and texel dims W, H, D. Immutable after packing;
   * replace via reskin(), or call layer.touch(true) after any future in-place mutation. */
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
attribute vec4 cShape;
attribute vec3 cFace;
varying vec4 vFaceRect;
varying vec2 vFaceUv;
varying vec4 vFlash;
varying float vSkyVis;
varying float vEmph;
varying vec3 vLmPos;
varying float vFade;
uniform float uFarNear;
uniform float uFarFar;
`;
// Face rect in the net from the face id (paint.ts layout: right, front, left, back, top, bottom).
// Tapered boxes (limbs narrower at the wrist, shoulders wider than the waist, a snout): the
// unit cube's cross-section is scaled along its y (or z) axis before the instance matrix.
const TAPER = /* glsl */ `
{
  float tk = (cMisc.w < 0.5 ? transformed.y : transformed.z) + 0.5;
  vec2 ts = mix(cShape.xy, cShape.zw, tk);
  if (cMisc.w < 0.5) transformed.xz *= ts; else transformed.xy *= ts;
}
`;
const VERT_MAIN = /* glsl */ `
#include <begin_vertex>
${TAPER}
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
  vFade = cRoot.w;
}
`;
const FRAG_PARS = /* glsl */ `
varying vec4 vFaceRect;
varying vec2 vFaceUv;
varying vec4 vFlash;
varying float vSkyVis;
varying float vEmph;
varying float vFade;
#define SKYVIS vSkyVis
uniform float uEmphK;
vec3 vGlowC = vec3(0.0);
`;
const FRAG_MAP = /* glsl */ `
// far figures dissolve in and out at the draw distance (ordered dither on the pixel grid)
if (vFade > 0.001) {
  ivec2 bi = ivec2(mod(gl_FragCoord.xy, 4.0));
  int bm[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
  if ((float(bm[bi.x + bi.y * 4]) + 0.5) / 16.0 < vFade) discard;
}
{
  vec2 texel = vFaceRect.xy + clamp(vFaceUv * vFaceRect.zw, vec2(0.001), vFaceRect.zw - 0.001);
  vec4 c = texture2D(map, texel / vec2(${PAGE}.0));
  if (c.a < 0.002) discard;
  diffuseColor.rgb *= c.rgb;
  diffuseColor.rgb = mix(diffuseColor.rgb, vFlash.rgb, vFlash.a);
  vGlowC = c.rgb * (1.0 - c.a);
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
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * vEmph * uEmphK + vFlash.rgb * vFlash.a * 0.8 + vGlowC * 1.6;');
    patchBandedLambert(shader, 'world');
    addNormalOutput(shader, true, 1);
  };
  m.customProgramCacheKey = () => 'cdda-char';
  (m.userData as { mrt?: boolean }).mrt = true;
  matCache.set(page, m);
  return m;
}

let depthMat: THREE.MeshDepthMaterial | null = null;
/** Shadow pass with the same taper, so shadows match the shapes. */
function charDepthMaterial(): THREE.MeshDepthMaterial {
  if (depthMat) return depthMat;
  depthMat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depthMat.onBeforeCompile = (shader) => {
    shader.vertexShader = 'attribute vec4 cMisc;\nattribute vec4 cShape;\n' + shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n' + TAPER);
  };
  depthMat.customProgramCacheKey = () => 'cdda-char-depth';
  return depthMat;
}

/**
 * First-person arms and held items (fpView.ts): the same skins and shapes, but drawn in an
 * overlay scene with no lights. Lit by `tint` (the renderer's light-map sample at the player,
 * like the sprite viewmodel) with a fixed key light in 3 bands; flash colour at full strength
 * is emitted unlit (muzzle flashes).
 */
export function fpMaterial(page: THREE.Texture, tint: THREE.Color): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({ map: page });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, charUniforms, { uTint: { value: tint } });
    shader.vertexShader = VERT_PARS + shader.vertexShader.replace('#include <begin_vertex>', VERT_MAIN);
    shader.fragmentShader = FRAG_PARS + 'uniform vec3 uTint;\n' + shader.fragmentShader
      .replace('#include <map_fragment>', FRAG_MAP)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
{
  // Camera-relative key (up-left, toward the eye) + a cooler fill from the lower right, both
  // stepped (Shadowglass's secondary light keeps form where the key falls off), scaled by the
  // light at the player so the hands still go dark at night.
  vec3 n = normalize(normal);
  float kl = dot(n, normalize(vec3(-0.45, 0.75, 0.55)));
  float fl = dot(n, normalize(vec3(0.7, -0.15, 0.55)));
  float key = kl > 0.55 ? 1.0 : kl > 0.15 ? 0.72 : 0.42;
  float fill = fl > 0.3 ? 0.24 : 0.1;
  float lvl = max(max(uTint.r, uTint.g), uTint.b);
  vec3 light = uTint * key + vec3(0.85, 0.9, 1.0) * fill * lvl;
  totalEmissiveRadiance = diffuseColor.rgb * light * 1.1;
  if (vFlash.a > 0.99) totalEmissiveRadiance = vFlash.rgb * 1.3;
  diffuseColor.rgb = vec3(0.0);
}`);
    addNormalOutput(shader, true, 1);
  };
  m.customProgramCacheKey = () => 'cdda-char-fp';
  (m.userData as { mrt?: boolean }).mrt = true;
  return m;
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
  shape!: THREE.InstancedBufferAttribute;
  private geo!: THREE.InstancedBufferGeometry;
  constructor(private cube: THREE.BufferGeometry, private page: THREE.Texture, private parent: THREE.Object3D, private shadows: boolean, private matFor: (page: THREE.Texture) => THREE.Material = charMaterial) {
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
    this.shape = attr('cShape');
    this.geo = g;
    const m = new THREE.InstancedMesh(g, this.matFor(this.page), cap);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.frustumCulled = false; // instances span the whole view
    m.castShadow = this.shadows;
    m.customDepthMaterial = charDepthMaterial();
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
  commit(n: number, layout: boolean): void {
    this.count = n;
    this.mesh.count = n;
    touchInstanceRange(this.mesh.instanceMatrix, 0, n * 16);
    if (layout) touchInstanceRange(this.tex, 0, n * 4);
    touchInstanceRange(this.misc, 0, n * 4);
    touchInstanceRange(this.flash, 0, n * 4);
    touchInstanceRange(this.root, 0, n * 4);
    if (layout) touchInstanceRange(this.shape, 0, n * 4);
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
  /** 0 = solid .. 1 = gone (dithered): far figures fading at the draw distance */
  fade = 0;
  /** A full root transform (camera space for the first-person arms) instead of x/y/yaw/lean. */
  rootOverride: THREE.Matrix4 | null = null;
  /**
   * Tumbling (run-over rag doll, ragdoll.ts): the whole posed body turned by this world
   * rotation about `tumbleCenter` (model space, after lean/pos/scale), which sits at
   * (x, floor + lift, y). Replaces fall and yaw while set.
   */
  tumble: THREE.Quaternion | null = null;
  readonly tumbleCenter = new THREE.Vector3();
  /**
   * Parts not drawn (1 = hidden): a piece of a gibbed body (gibs.ts) is the whole rig with only
   * its own parts shown, so it keeps the body's skin and pose; set before the first flush and
   * call layer.touch(true) after changing it.
   */
  hidden: Uint8Array | null = null;
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
    this.layer?.touch(true);
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
    if (this.rootOverride) root.copy(this.rootOverride);
    else if (this.tumble) {
      root.multiply(tmpM2.makeRotationFromQuaternion(this.tumble));
      root.multiply(tmpM2.makeTranslation(-this.tumbleCenter.x, -this.tumbleCenter.y, -this.tumbleCenter.z));
    } else if (this.fall > 0) {
      const d = Math.hypot(this.fallDx, this.fallDy) || 1;
      // rotate "up" toward the fall direction: axis = up × dir (three.js x, z)
      AXIS.set(this.fallDy / d, 0, -this.fallDx / d);
      root.multiply(tmpM2.makeRotationAxis(AXIS, this.fall));
    }
    if (!this.rootOverride) {
      if (!this.tumble) root.multiply(tmpM2.makeRotationY(-this.yaw));
      tmpE.set(po.lean[0], po.lean[1], po.lean[2]);
      root.multiply(tmpM2.makeRotationFromEuler(tmpE));
      root.multiply(tmpM2.makeTranslation(po.pos[0], po.pos[1], po.pos[2]));
      root.multiply(tmpM2.makeScale(this.sxz, this.sy, this.sxz));
    }
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
  private live = new Set<CharInstance>();
  /** keyed page * SHAPES.length + shape index */
  private batches = new Map<number, Batch>();
  private perKey: number[] = [];
  private fillKey: number[] = [];
  private batchByKey: Batch[] = [];
  private scratch: THREE.Matrix4[] = [];
  private needsWrite = true;
  private needsLayout = true;
  /** Diagnostic off variant: request every attribute each frame for paired upload measurements. */
  reuseStaticUploads = true;
  groundAt: ((x: number, y: number, z: number) => number) | null = null;
  skyVisAt: ((x: number, y: number, z: number) => number) | null = null;
  /** `matFor`: a different material per skin page (the first-person arms, fpView.ts). */
  constructor(private shadows = true, readonly label = 'chars', private matFor?: (page: THREE.Texture) => THREE.Material) {
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
    this.needsLayout = true;
    return inst;
  }

  /** @internal */
  removeInst(inst: CharInstance): void {
    if (!this.live.delete(inst)) return;
    inst.skin.refs--;
    inst.layer = null;
    this.needsWrite = true;
    this.needsLayout = true;
  }

  /** @internal flash started; layout changes also invalidate fixed attributes. */
  touch(layout = false): void {
    this.needsWrite = true;
    this.needsLayout ||= layout;
  }

  /** Swap an instance's skin (outfit change). */
  reskin(inst: CharInstance, skin: Skin): void {
    inst.skin.refs--;
    skin.refs++;
    inst.skin = skin;
    this.needsWrite = true;
    this.needsLayout = true;
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
    // CPU writes stay together: splitting them regressed measured flush time. Only
    // the GPU texture/taper upload requests are suppressed between layout changes.
    // Rig tapers and packed rects are immutable; future in-place edits must touch(true).
    const layout = this.needsLayout || !this.reuseStaticUploads;
    this.needsLayout = false;
    // count per (page, shape); keys are small ints, so plain arrays (this loop runs per part)
    const NS = SHAPES.length;
    const per = this.perKey;
    per.fill(0);
    for (const i of this.live) {
      if (!i.visible) continue;
      const sh = shapeIndex(i.rig);
      const base = i.skin.page * NS;
      while (per.length < base + NS) per.push(0);
      const hid = i.hidden;
      for (let p = 0; p < sh.length; p++) if (!hid || !hid[p]) per[base + sh[p]]++;
    }
    const byKey = this.batchByKey;
    for (let key = 0; key < per.length; key++) {
      if (!per[key]) continue;
      let b = this.batches.get(key);
      if (!b) {
        b = new Batch(shapeGeometry(SHAPES[key % NS]), store.texture(Math.floor(key / NS)), this.group, this.shadows, this.matFor);
        this.batches.set(key, b);
      }
      byKey[key] = b;
      b.ensure(per[key]);
    }
    const fill = this.fillKey;
    fill.length = per.length;
    fill.fill(0);
    for (const i of this.live) {
      if (!i.visible) continue;
      const sh = shapeIndex(i.rig);
      const fk = i.flashDur > 0 ? i.flashT / i.flashDur : 0;
      const sky = this.skyVisAt ? this.skyVisAt(i.x, i.y, i.z) : 1;
      const rx = i.x, ry = i.z * LEVEL_HEIGHT + i.lift, rz = i.y;
      const hid = i.hidden;
      for (let p = 0; p < i.rig.parts.length; p++) {
        if (hid && hid[p]) continue;
        const key = i.skin.page * NS + sh[p];
        const b = byKey[key];
        const k = fill[key]++;
        const M = b.mesh.instanceMatrix.array as Float32Array;
        const T = b.tex.array as Float32Array, X = b.misc.array as Float32Array, F = b.flash.array as Float32Array, R = b.root.array as Float32Array, P = b.shape.array as Float32Array;
        M.set(i.mats.subarray(p * 16, p * 16 + 16), k * 16);
        const r = i.skin.rects;
        T[k * 4] = r[p * 5]; T[k * 4 + 1] = r[p * 5 + 1]; T[k * 4 + 2] = r[p * 5 + 2]; T[k * 4 + 3] = r[p * 5 + 3];
        const pd = i.rig.parts[p];
        X[k * 4] = r[p * 5 + 4]; X[k * 4 + 1] = sky; X[k * 4 + 2] = i.emph; X[k * 4 + 3] = pd.taperAxis === 'z' ? 1 : 0;
        const tp = pd.taper;
        P[k * 4] = tp ? tp[0] : 1; P[k * 4 + 1] = tp ? tp[1] : 1; P[k * 4 + 2] = tp ? tp[2] : 1; P[k * 4 + 3] = tp ? tp[3] : 1;
        F[k * 4] = i.flashColor.r; F[k * 4 + 1] = i.flashColor.g; F[k * 4 + 2] = i.flashColor.b; F[k * 4 + 3] = fk;
        R[k * 4] = rx; R[k * 4 + 1] = ry; R[k * 4 + 2] = rz; R[k * 4 + 3] = i.fade;
      }
    }
    for (const [key, b] of this.batches) b.commit(fill[key] ?? 0, layout);
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

const shapeIdx = new WeakMap<Rig, Uint8Array>();
/** Per part: index into SHAPES (rig parts are immutable). */
function shapeIndex(rig: Rig): Uint8Array {
  let a = shapeIdx.get(rig);
  if (!a) {
    a = Uint8Array.from(rig.parts, (p) => SHAPES.indexOf(p.shape ?? 'box'));
    shapeIdx.set(rig, a);
  }
  return a;
}

/** Skin pages shared by every layer (monsters, NPCs, corpses): one texture per page. */
export class SkinStore {
  private pages: SkinPage[] = [];
  private skins = new Map<string, Skin>();
  /**
   * People's skins: 'styled' = painted from a semantic palette read off the sprite
   * (styled.ts); 'sprite' = the sprite projected onto the boxes (paint.ts). Animals and
   * everything else always use the projection.
   */
  style: 'styled' | 'sprite' = 'styled';

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
    // viewmodel rigs paint at a higher density (seen from a few cm)
    const tpm = rig.texels ?? 1;
    const dimsOf = (v: readonly [number, number, number]) => texelDims([v[0] * tpm, v[1] * tpm, v[2] * tpm]);
    const dimsKey = rig.parts.map((p) => dimsOf(p.size).join('x')).join(',');
    const styled = this.style === 'styled' && rig.shape.arch === 'humanoid';
    const key = `${src.key}|${rig.shape.arch}|${rig.shape.zombie ? 'z' : ''}|${styled ? 'st' : 'sp'}|${rig.skinTag ?? ''}|${dimsKey}|${src.opts?.eyes?.join(',') ?? ''}|${src.opts?.person ? JSON.stringify(src.opts.person) : ''}`;
    const hit = this.skins.get(key);
    if (hit) return hit;
    // flat-coloured rigs (effects, held items) need no sprite: a neutral stand-in palette
    const info = src.info() ?? (rig.parts.every((p) => p.src.color) ? neutralInfo() : null);
    const n = rig.parts.length;
    const rects = new Int32Array(n * 5);
    const nets = rig.parts.map((p) => {
      const d = dimsOf(p.size);
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
      else {
        this.pages.push(new SkinPage());
        if (this.pages.length === WARN_PAGES + 1) console.warn(`chars: ${this.pages.length} skin pages for ${this.skins.size} skins`);
      }
    }
    if (pageIdx < 0) throw new Error('SkinStore: a single skin does not fit a page');
    const pg = this.pages[pageIdx];
    nets.forEach((nt, i) => {
      const [x, y] = places[i];
      rects.set([x, y, nt.d[0], nt.d[1], nt.d[2]], i * 5);
      const part = rig.parts[i];
      const zl = rig.zlook;
      if (!info) fillGrey(pg.img, x, y, nt.wh[0], nt.wh[1]);
      else if (zl && (part.src.zr || (part.src.region && (styled || !part.src.rect)))) {
        // zombie bodies (zombie.ts): their own painter, except sprite-projected parts in
        // ?charpaint=sprite
        const side = /R$/.test(part.name) ? 1 : /L$/.test(part.name) ? -1 : 0;
        paintZombiePart(pg.img, x, y, nt.d, part.src, part.name, { ...personPalette(info, zl.undead), ...(src.opts?.person ?? {}) }, zl, seedOfKey(src.key + rig.skinTag), side);
      } else if (styled && part.src.region) {
        const side = /R$/.test(part.name) ? 1 : /L$/.test(part.name) ? -1 : 0;
        paintStyled(pg.img, x, y, nt.d, part.src.region, { ...personPalette(info, rig.shape.zombie), ...(src.opts?.person ?? {}) }, seedOfKey(src.key), side);
      } else paintPart(pg.img, x, y, nt.d, part.src, info, src.opts);
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

/** 0..1 from a skin key: the same sprite always gets the same decals. */
function seedOfKey(k: string): number {
  let h = 2166136261;
  for (let i = 0; i < k.length; i++) h = Math.imul(h ^ k.charCodeAt(i), 16777619);
  return ((h >>> 0) % 100003) / 100003;
}

let neutral: SpriteInfo | null = null;
function neutralInfo(): SpriteInfo {
  return (neutral ??= analyseSprite({ w: 1, h: 1, data: new Uint8Array([128, 128, 128, 255]) }));
}

function fillGrey(img: Img, x0: number, y0: number, w: number, h: number): void {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
    const i = (y * img.w + x) * 4;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = 110;
    img.data[i + 3] = 255;
  }
}
