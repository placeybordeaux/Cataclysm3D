import * as THREE from 'three';

// Per-object screen-door fades for world geometry (materials.ts DISSOLVE_SOLID, farLod.ts).
// The dither is a 4x4 Bayer matrix, so a fade has 17 visible steps; a fading world mesh wears
// a shared clone of its page material for its step (one per page, step and direction: the
// same program, since three runs onBeforeCompile per material and finds the cached program by
// its key, so nothing compiles). The ends need no clone: fully in is the shared material,
// fully out is not drawn at all (a held chunk costs no draw call). Sharing matters: a material
// switch re-uploads the material's uniforms, and a clone per mesh made every held chunk one.
// Meshes without a world page material (3D trees, glass, puddles) can't dither; they show once
// the fade is past half, and the chunk's prop cards likewise.
//
//   setFade(group, 0.3)          ~30 % of its pixels drawn (in)
//   setFade(proxy, 0.3, true)    the complementary ~70 % (out)
//   clearFade(group)             back to the shared materials

const STEPS = 16;

interface FadeState {
  /** quantized step 0..STEPS and direction last applied */
  step: number;
  out: boolean;
  /** children count when last applied (trees join a group late) */
  n: number;
  /** world meshes: the shared material each one had, and its visibility */
  base: Map<THREE.Mesh, { mat: THREE.Material; vis: boolean }>;
  /** other meshes: their visibility before the fade */
  other: Map<THREE.Object3D, boolean>;
}

const states = new WeakMap<THREE.Object3D, FadeState>();
/** clones per shared material, by step * 2 + out */
const clones = new WeakMap<THREE.Material, Map<number, THREE.Material>>();

function isWorldPage(m: THREE.Material | THREE.Material[]): m is THREE.Material {
  return !Array.isArray(m) && !!(m.userData as { worldPage?: boolean }).worldPage;
}

function cloneFor(base: THREE.Material, step: number, out: boolean): THREE.Material {
  let byStep = clones.get(base);
  if (!byStep) clones.set(base, (byStep = new Map()));
  const k = step * 2 + (out ? 1 : 0);
  let c = byStep.get(k);
  if (c) return c;
  c = base.clone();
  const u = { uDissolve: { value: step / STEPS }, uDissolveOut: { value: out ? 1 : 0 } };
  const compile = base.onBeforeCompile.bind(base);
  c.onBeforeCompile = (shader, r) => {
    compile(shader, r);
    shader.uniforms.uDissolve = u.uDissolve;
    shader.uniforms.uDissolveOut = u.uDissolveOut;
  };
  c.customProgramCacheKey = base.customProgramCacheKey.bind(base);
  byStep.set(k, c);
  return c;
}

/** Is `obj` mid-fade (or held at 0)? The chunk batcher leaves such groups alone. */
export function isFading(obj: THREE.Object3D): boolean {
  return states.has(obj);
}

/**
 * Draw `obj` at dissolve `f` (0..1): fading in draws the pixels under f, `out` the rest.
 * Cheap to call every frame: only a step change (or children added) touches the meshes.
 */
export function setFade(obj: THREE.Object3D, f: number, out = false): void {
  const step = Math.max(0, Math.min(STEPS, Math.round(f * STEPS)));
  let s = states.get(obj);
  const n = obj.children.length;
  if (s && s.step === step && s.out === out && s.n === n) return;
  if (!s) {
    s = { step: -1, out, n: -1, base: new Map(), other: new Map() };
    states.set(obj, s);
    obj.userData.fading = true;
  }
  s.step = step;
  s.out = out;
  s.n = n;
  const st = s;
  // how much of the object shows: all of it (shared material), none (not drawn), or a step
  const shown = out ? STEPS - step : step;
  // non-world meshes are all-or-nothing: on from half way
  const otherOn = shown * 2 >= STEPS;
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && (st.base.has(m) || isWorldPage(m.material))) {
      let b = st.base.get(m);
      if (!b) st.base.set(m, (b = { mat: m.material as THREE.Material, vis: m.visible }));
      m.visible = b.vis && shown > 0;
      m.material = shown >= STEPS ? b.mat : cloneFor(b.mat, step, out);
      return;
    }
    if (!m.isMesh && !(o as THREE.Points).isPoints) return;
    if (!st.other.has(o)) st.other.set(o, o.visible);
    o.visible = st.other.get(o)! && otherOn;
  });
  const sprites = obj.userData.sprites as { setVisible(v: boolean): void } | undefined;
  sprites?.setVisible(otherOn && obj.visible);
}

/** End the fade: shared materials and visibility back. */
export function clearFade(obj: THREE.Object3D): void {
  const s = states.get(obj);
  if (!s) return;
  for (const [m, b] of s.base) {
    m.material = b.mat;
    m.visible = b.vis;
  }
  for (const [o, v] of s.other) o.visible = v;
  states.delete(obj);
  delete obj.userData.fading;
  const sprites = obj.userData.sprites as { setVisible(v: boolean): void } | undefined;
  sprites?.setVisible(obj.visible);
}
