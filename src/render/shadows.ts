import * as THREE from 'three';

// Sun shadows as switchable variants (docs/SHADOWS.md). The user's report: shadows are
// "very jumpy and sway a lot" and show every voxel step. Causes found (tools/shadow-motion.ts
// measures them; none shows in a still screenshot):
//
//  * the sun direction changes every frame (a game day is ~1 real hour) and the shadow map is
//    re-rendered 20 times a second. The texel snapping in the old code snaps in a basis built
//    from that direction, so the whole texel grid rotates about the world origin with the sun:
//    at town coordinates (thousands of metres out) it slides ~a texel per update, every
//    shadow edge re-rasterises and crawls 20 times a second even when nothing moves
//  * one 768 map over +-30 m: 8 cm texels, stretched to 20-40 cm stair steps on the ground at
//    a low sun, point-sampled (BasicShadowMap) into a 360 px image: the "voxel" look of the
//    shadow edges; nothing past 30 m has a sun shadow at all while the view reaches 168 m
//  * leaves sway (stepped wind) against a shadow map drawn without the sway, so their own
//    shadow slides over them 4 times a second
//
// Variants (Options > Shadows, `?shadows=`, `cdda.setShadows(name)`, gallery switch):
//
//   legacy    the old behaviour, unchanged (for comparison)
//   stable    the sun direction moves in small steps with a short world-anchored dissolve
//             between them; the texel grid is fixed per step, so shadows only change when
//             something moves; leaves keep their shadow while they sway. One 1024 map, +-32 m
//   cascades  stable + two maps: a sharp near one (4 cm texels, +-20 m) and a far one to
//             +-84 m, so buildings and trees down the street cast shadows too
//   smooth    cascades + a contour filter: the shadow edge is traced through a small tent
//             filter of the map and cut at 50%, so edges are clean lines and rounded corners
//             instead of texel staircases, and voxel-sized notches in a caster's silhouette
//             melt away (the silhouette is smoothed, not the object)
//
// Every sun-shadow light is a DirectionalLight carrying the full sun; the shader
// (materials.ts RIG_*) gives each fragment exactly one of them: the dissolve picks the old or
// the new sun step, the cascade test picks near or far. Shadow-casting directional lights come
// first in three's light arrays in scene order, so index = set * cascades + cascade.

export type ShadowModeName = 'legacy' | 'stable' | 'cascades' | 'smooth';
export const SHADOW_MODE_NAMES: ShadowModeName[] = ['legacy', 'stable', 'cascades', 'smooth'];

export interface CascadeSpec {
  /** map size in texels */
  size: number;
  /** half extent in metres (the map covers 2*extent square around the snapped focus) */
  extent: number;
  /** the centre moves in steps of this many texels (1 = every texel) */
  snapTexels: number;
  /** re-renders per second (moving casters, streamed-in chunks); static shadows don't change */
  hz: number;
}

export interface ShadowMode {
  label: string;
  desc: string;
  /** empty = legacy: one map sized by the look (look.ts shadowSize/shadowExtent) */
  cascades: CascadeSpec[];
  /** sun direction step in degrees (0 = follows the sun every frame: legacy) */
  stepDeg: number;
  /** dissolve between sun steps, real seconds (0 = snap) */
  fadeSec: number;
  /** 'stock' = three's own sampling; 'smooth' = contour filter (needs PCF maps) */
  filter: 'stock' | 'smooth';
  /** tent radius of the smooth filter in texels, and the half width of its 50% cut */
  smoothRadius: number;
  smoothSoft: number;
  /** leaves read their shadow at their rest position while they sway (flora.ts) */
  swayLock: boolean;
  /** depth bias and normal offset in texels of each map */
  biasTexels: number;
  normalBiasTexels: number;
}

export const SHADOW_MODES: Record<ShadowModeName, ShadowMode> = {
  legacy: {
    label: 'Legacy', desc: 'The old shadows: follow the sun every frame, one small map, redrawn 20 times a second (shimmer and crawl).',
    cascades: [], stepDeg: 0, fadeSec: 0, filter: 'stock', smoothRadius: 0, smoothSoft: 0, swayLock: false, biasTexels: 0, normalBiasTexels: 0,
  },
  stable: {
    label: 'Stable', desc: 'The sun moves in small steps with a quick dissolve; shadows hold still in between and never shimmer as you walk.',
    cascades: [{ size: 1024, extent: 32, snapTexels: 1, hz: 20 }],
    stepDeg: 0.5, fadeSec: 1.2, filter: 'stock', smoothRadius: 0, smoothSoft: 0, swayLock: true, biasTexels: 1.5, normalBiasTexels: 0.6,
  },
  cascades: {
    label: 'Stable + far', desc: 'Stable, plus a sharp near map and a second map out to ~85 m so buildings and trees down the street cast shadows.',
    cascades: [{ size: 1024, extent: 20, snapTexels: 1, hz: 20 }, { size: 1024, extent: 84, snapTexels: 8, hz: 5 }],
    stepDeg: 0.5, fadeSec: 1.2, filter: 'stock', smoothRadius: 0, smoothSoft: 0, swayLock: true, biasTexels: 1.5, normalBiasTexels: 0.6,
  },
  smooth: {
    label: 'Smooth', desc: 'Stable + far, with clean shadow edges: no texel staircases, voxel notches smoothed away.',
    cascades: [{ size: 1024, extent: 20, snapTexels: 1, hz: 20 }, { size: 1024, extent: 84, snapTexels: 8, hz: 5 }],
    stepDeg: 0.5, fadeSec: 1.2, filter: 'smooth', smoothRadius: 1.25, smoothSoft: 0.08, swayLock: true, biasTexels: 1.5, normalBiasTexels: 0.8,
  },
};

export const DEFAULT_SHADOW_MODE: ShadowModeName = 'smooth';
const STORAGE_KEY = 'cdda3d.shadows';

export function isShadowModeName(s: string | null | undefined): s is ShadowModeName {
  return !!s && (SHADOW_MODE_NAMES as string[]).includes(s);
}

/** URL `shadows=` wins, then the stored choice, then the default. Unknown names fail loudly. */
export function initialShadowMode(): ShadowModeName {
  const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
  const p = params.get('shadows');
  if (p !== null) {
    if (!isShadowModeName(p)) throw new Error(`unknown shadows "${p}" (expected ${SHADOW_MODE_NAMES.join('|')})`);
    return p;
  }
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    if (isShadowModeName(s)) return s;
  } catch {
    // storage blocked: default
  }
  return DEFAULT_SHADOW_MODE;
}

export function storeShadowMode(name: ShadowModeName): void {
  try {
    localStorage.setItem(STORAGE_KEY, name);
  } catch {
    // private mode: not persisted
  }
}

// --- pure parts (tests/shadows.test.ts) ---------------------------------------------------

/** Round `v` to the nearest multiple of `step` (> 0). */
export function snapToGrid(v: number, step: number): number {
  if (!(step > 0)) throw new Error(`snap step must be > 0, got ${step}`);
  return Math.round(v / step) * step;
}

/**
 * The shadow camera's axes for light direction `dir` (unit vector *toward* the light), the
 * same ones three's lookAt gives it (camera up = world up): right = up x dir, up' = dir x right.
 */
export function lightBasis(dir: THREE.Vector3, right: THREE.Vector3, up: THREE.Vector3): void {
  right.set(0, 1, 0).cross(dir);
  if (right.lengthSq() < 1e-8) right.set(1, 0, 0); // sun at the zenith: any horizontal axis
  right.normalize();
  up.copy(dir).cross(right).normalize();
}

const _r = new THREE.Vector3(), _u = new THREE.Vector3();
/**
 * The shadow camera target for `focus`: moved along the map plane in whole steps of `step`
 * metres (in the light's own basis), kept at the focus's depth along the light. With the map
 * size even, texel edges then sit on multiples of the texel size in that basis: a static
 * caster rasterises the same way however the focus moves, as long as `dir` holds still.
 */
export function snappedCenter(focus: THREE.Vector3, dir: THREE.Vector3, step: number, out: THREE.Vector3): THREE.Vector3 {
  lightBasis(dir, _r, _u);
  const rx = snapToGrid(focus.dot(_r), step);
  const uy = snapToGrid(focus.dot(_u), step);
  const fz = focus.dot(dir);
  return out.set(0, 0, 0).addScaledVector(_r, rx).addScaledVector(_u, uy).addScaledVector(dir, fz);
}

/**
 * The sun as the shadows see it: held still until the real sun has moved `stepDeg` away, then
 * jumps there, dissolving from the old direction to the new over `fadeSec` real seconds. Two
 * slots (sets) alternate: the new direction goes into the slot not currently shown, `share`
 * is how much of slot 1 shows (0..1), moving toward the current slot.
 */
export class SunStepper {
  readonly dirs = [new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 1, 0)];
  /** the slot holding the newest direction */
  cur = 0;
  /** 0 = slot 0 fully shown, 1 = slot 1 fully shown */
  share = 0;
  /** steps taken (a new step means its slot's maps need drawing) */
  steps = 0;
  private started = false;

  constructor(public stepDeg: number, public fadeSec: number) {
    if (!(stepDeg > 0)) throw new Error(`sun step must be > 0 degrees, got ${stepDeg}`);
    if (!(fadeSec >= 0)) throw new Error(`fade must be >= 0 s, got ${fadeSec}`);
  }

  get fading(): boolean {
    return this.share !== this.cur;
  }

  /** Advance by `dt` real seconds toward `live` (unit). Returns true when a new step began. */
  update(dt: number, live: THREE.Vector3): boolean {
    if (!this.started) {
      this.started = true;
      this.dirs[0].copy(live);
      this.dirs[1].copy(live);
      this.cur = 0;
      this.share = 0;
      this.steps++;
      return true;
    }
    let stepped = false;
    const held = this.dirs[this.cur];
    if (held.angleTo(live) > (this.stepDeg * Math.PI) / 180) {
      // a step while the previous dissolve is still running: finish it at once (only when
      // time runs much faster than the dissolve, e.g. waiting/sleeping)
      this.share = this.cur;
      this.cur = 1 - this.cur;
      this.dirs[this.cur].copy(live);
      this.steps++;
      stepped = true;
    }
    const target = this.cur;
    if (this.share !== target) {
      const d = this.fadeSec > 0 ? dt / this.fadeSec : 1;
      this.share = target === 1 ? Math.min(1, this.share + d) : Math.max(0, this.share - d);
    }
    return stepped;
  }

  /** Forget the held direction (teleports, mode switches): the next update snaps. */
  reset(): void {
    this.started = false;
  }
}

// --- the rig ---------------------------------------------------------------------------

/** Shader uniforms, shared by reference with every patched material (materials.ts). */
export const shadowUniforms = {
  /** x cascades per set, y sets, z share of set 1 (the dissolve), w cascade dissolve band (uv) */
  uRig: { value: new THREE.Vector4(1, 1, 0, 0.02) },
  /** x filter (0 stock, 1 smooth), y tent radius (texels), z half-width of the 50% cut */
  uRigFilter: { value: new THREE.Vector4(0, 1, 0.08, 0) },
  /** texel index of each near map's corner in its light basis (set 0 xy, set 1 zw): offsets
   *  the dissolve dither so it is anchored to the world, not to the moving map */
  uRigCell: { value: new THREE.Vector4() },
  /** 1 = lit materials output 0.5 + 0.5 * their sun-shadow factor instead of their colour
   *  (measurement: 0.5 shadow, 1 lit; anything else, e.g. the cleared sky, is not a receiver) */
  uShadowView: { value: 0 },
  /** 1 = leaves sample their shadow at rest while they sway (flora.ts) */
  uSwayLock: { value: 0 },
};

// ---------------------------------------------------------------------------

const DEPTH_HALF = 100; // the shadow camera sits this far up the light from the focus

export class ShadowRig {
  name: ShadowModeName = DEFAULT_SHADOW_MODE;
  mode: ShadowMode = { ...SHADOW_MODES[DEFAULT_SHADOW_MODE], cascades: SHADOW_MODES[DEFAULT_SHADOW_MODE].cascades.map((c) => ({ ...c })) };
  /** sun-shadow lights in shader order (set-major, then cascade) */
  lights: THREE.DirectionalLight[] = [];
  readonly uRig = shadowUniforms.uRig;
  readonly uRigFilter = shadowUniforms.uRigFilter;
  readonly uShadowView = shadowUniforms.uShadowView;
  readonly uSwayLock = shadowUniforms.uSwayLock;
  /** Debug/measurement: while set, nothing changes (timers keep counting); see shadowMotion. */
  freeze = false;
  /** Map re-renders per light (counted for the perf/metrics tables). */
  readonly renders: number[] = [];
  stepper = new SunStepper(0.5, 1.2);
  /** legacy: the renderer-wide 20 Hz timer the old code had */
  legacyHz = 20;
  private pendingDt = 0;
  private timers: number[] = [];
  private forced = true;
  /** bumped whenever the light list changes (the owner re-parents lights) */
  version = 0;

  constructor(private readonly group: THREE.Group, private legacySize: () => { size: number; extent: number }) {}

  get legacy(): boolean {
    return this.mode.cascades.length === 0;
  }

  /** Whether the renderer should use PCF (hardware-filtered) maps. */
  pcf(lookSoft: boolean): boolean {
    return this.mode.filter === 'smooth' || lookSoft;
  }

  setMode(name: ShadowModeName): void {
    if (!isShadowModeName(name)) throw new Error(`unknown shadows ${name} (expected ${SHADOW_MODE_NAMES.join('|')})`);
    const m = SHADOW_MODES[name];
    this.name = name;
    this.mode = { ...m, cascades: m.cascades.map((c) => ({ ...c })) };
    this.rebuild();
  }

  /** Re-create the lights for the current mode (after setMode or a tweak of sizes/count). */
  rebuild(): void {
    for (const l of this.lights) {
      this.group.remove(l, l.target);
      l.shadow.map?.dispose();
      l.dispose();
    }
    const m = this.mode;
    const cascades = this.legacy ? 1 : m.cascades.length;
    const sets = this.legacy ? 1 : 2;
    if (cascades < 1 || cascades > 2) throw new Error(`shadows: 1 or 2 cascades supported, got ${cascades}`);
    this.lights = [];
    for (let s = 0; s < sets; s++)
      for (let c = 0; c < cascades; c++) {
        const l = new THREE.DirectionalLight(0xffffff, 1);
        l.name = `sun shadow ${s}.${c}`;
        l.castShadow = true;
        l.shadow.autoUpdate = false;
        const cam = l.shadow.camera;
        if (this.legacy) {
          const { size, extent } = this.legacySize();
          l.shadow.mapSize.set(size, size);
          cam.left = -extent; cam.right = extent; cam.top = extent; cam.bottom = -extent;
          cam.near = 1; cam.far = 160;
          l.shadow.bias = -0.0008;
          l.shadow.normalBias = 0.03;
        } else {
          const spec = m.cascades[c];
          l.shadow.mapSize.set(spec.size, spec.size);
          cam.left = -spec.extent; cam.right = spec.extent; cam.top = spec.extent; cam.bottom = -spec.extent;
          cam.near = 1; cam.far = DEPTH_HALF * 2;
          const texel = (2 * spec.extent) / spec.size;
          // depth is linear over the ortho range: metres -> [0,1] depth units
          l.shadow.bias = -(m.biasTexels * texel) / (cam.far - cam.near);
          l.shadow.normalBias = m.normalBiasTexels * texel;
        }
        cam.updateProjectionMatrix();
        this.lights.push(l);
        this.group.add(l, l.target);
      }
    this.renders.length = this.lights.length;
    this.renders.fill(0);
    this.timers = this.lights.map(() => 0);
    this.stepper = new SunStepper(m.stepDeg || 0.5, m.fadeSec);
    this.uRig.value.set(cascades, sets, 0, 0.02);
    this.uRigFilter.value.set(m.filter === 'smooth' ? 1 : 0, m.smoothRadius, m.smoothSoft, 0);
    this.uSwayLock.value = m.swayLock ? 1 : 0;
    this.forced = true;
    this.version++;
  }

  /** Legacy map size/extent follow the look (look.ts); other modes own theirs. */
  applyLookSize(): void {
    if (!this.legacy) return;
    const { size, extent } = this.legacySize();
    const l = this.lights[0];
    const sh = l.shadow;
    if (sh.mapSize.x !== size) {
      sh.mapSize.set(size, size);
      sh.map?.dispose();
      (sh as { map: THREE.WebGLRenderTarget | null }).map = null;
    }
    const c = sh.camera;
    c.left = -extent; c.right = extent; c.top = extent; c.bottom = -extent;
    c.updateProjectionMatrix();
    this.forced = true;
  }

  /** The sun direction the shading uses right now: live in legacy, the newest step otherwise. */
  heldDir(live: THREE.Vector3): THREE.Vector3 {
    return this.legacy ? live : this.stepper.dirs[this.stepper.cur];
  }

  /** Redraw every map on the next frame (teleport, look change, chunk rebuilds). */
  invalidate(): void {
    this.forced = true;
  }

  /** Forget the held sun step too (after a time jump the shadows should not dissolve). */
  resetSun(): void {
    this.stepper.reset();
    this.forced = true;
  }

  /**
   * Place the lights for this frame. `dir` = unit vector toward the sun/moon (live), `focus` =
   * the camera focus. Returns true when any map must be re-rendered this frame.
   */
  update(dt: number, dir: THREE.Vector3, focus: THREE.Vector3, color: THREE.Color, intensity: number, everyFrame = false): boolean {
    if (this.freeze) {
      this.pendingDt += dt;
      return false;
    }
    dt += this.pendingDt;
    this.pendingDt = 0;
    for (const l of this.lights) {
      l.color.copy(color);
      l.intensity = intensity;
    }
    // legacy redrew the sun map every frame while the flashlight (whose shadow moves with the
    // camera) was on: the renderer-wide update flag covered both
    if (this.legacy && everyFrame) this.forced = true;
    return this.legacy ? this.updateLegacy(dt, dir, focus) : this.updateStepped(dt, dir, focus);
  }

  private updateLegacy(dt: number, dir: THREE.Vector3, focus: THREE.Vector3): boolean {
    const sun = this.lights[0];
    // The pre-rig code, verbatim in effect: snapped along axes rebuilt from the live sun every
    // frame, map redrawn at a fixed 20 Hz.
    const ext = sun.shadow.camera.right;
    const texel = (2 * ext) / sun.shadow.mapSize.x;
    const fwd = _v.copy(dir).negate();
    const right = _rr.set(0, 1, 0).cross(fwd).normalize();
    const up = _uu.copy(fwd).cross(right).normalize();
    const rx = Math.round(focus.dot(right) / texel) * texel;
    const uy = Math.round(focus.dot(up) / texel) * texel;
    const fz = focus.dot(fwd);
    const snapped = _s.set(0, 0, 0).addScaledVector(right, rx).addScaledVector(up, uy).addScaledVector(fwd, fz);
    sun.target.position.copy(snapped);
    sun.position.copy(snapped).addScaledVector(dir, 80);
    sun.target.updateMatrixWorld();
    this.uRig.value.z = 0;
    this.timers[0] += dt;
    if (this.forced || this.timers[0] >= 1 / this.legacyHz) {
      this.timers[0] = 0;
      this.forced = false;
      sun.shadow.needsUpdate = true;
      this.renders[0]++;
      return true;
    }
    return false;
  }

  private updateStepped(dt: number, dir: THREE.Vector3, focus: THREE.Vector3): boolean {
    const m = this.mode;
    const st = this.stepper;
    const C = m.cascades.length;
    const stepped = st.update(dt, dir);
    this.uRig.value.z = st.share;
    let any = false;
    // scheduled redraws (not forced, not a new sun step) go one map per frame: the far map is
    // ~300-1000 draw calls in a town, and landing on the same frame as the near one doubled
    // that frame's draw cost (docs/PERF.md). A postponed map keeps its timer and goes next frame.
    let scheduled = 0;
    for (let s = 0; s < 2; s++) {
      const d = st.dirs[s];
      // a slot that isn't shown and isn't the newest needs no maps
      const shown = s === 1 ? st.share > 0 : st.share < 1;
      for (let c = 0; c < C; c++) {
        const i = s * C + c;
        const l = this.lights[i];
        const spec = m.cascades[c];
        const texel = (2 * spec.extent) / spec.size;
        const center = snappedCenter(focus, d, texel * spec.snapTexels, _s);
        l.target.position.copy(center);
        l.position.copy(center).addScaledVector(d, DEPTH_HALF);
        l.target.updateMatrixWorld();
        l.updateMatrixWorld();
        this.timers[i] += dt;
        const fresh = stepped && s === st.cur;
        // A centre that moved needs no immediate redraw: until the map is redrawn, sampling
        // uses the matrix it was drawn with, so a stale map is only offset by a few cm of
        // coverage, never misplaced.
        const due = this.timers[i] >= 1 / spec.hz && scheduled === 0;
        if (this.forced || fresh || (shown && due)) {
          if (!this.forced && !fresh) scheduled++;
          this.timers[i] = 0;
          l.shadow.needsUpdate = true;
          this.renders[i]++;
          any = true;
          if (c === 0) {
            // map texel (0,0) sits at centre - extent: its index in the world-fixed texel grid.
            // Set only with a redraw: until then the shader still reads the old map/matrix.
            lightBasis(d, _rr, _uu);
            const ox = Math.round((center.dot(_rr) - spec.extent) / texel), oy = Math.round((center.dot(_uu) - spec.extent) / texel);
            const cell = shadowUniforms.uRigCell.value;
            if (s === 0) { cell.x = ox; cell.y = oy; } else { cell.z = ox; cell.w = oy; }
          }
        }
      }
    }
    this.forced = false;
    return any;
  }
}

const _v = new THREE.Vector3(), _rr = new THREE.Vector3(), _uu = new THREE.Vector3(), _s = new THREE.Vector3();
