import * as THREE from 'three';
import type { DebugApi } from '../debug';
import type { Game } from '../game/game';
import { clockScale } from '../core/time';
import { registerOption } from '../ui/options';
import { look } from './look';
import type { Renderer } from './renderer';
import { SHADOW_MODES, SHADOW_MODE_NAMES, isShadowModeName, shadowUniforms, storeShadowMode, type ShadowModeName } from './shadows';

// Wires the sun-shadow variants (shadows.ts) into the game: Options > Shadows, `?shadows=`
// (read by LightManager at boot), the console and the motion measurement behind
// tools/shadow-motion.ts.
//
//   cdda.setShadows('stable')        switch live (not persisted)
//   cdda.shadowTweak({ stepDeg: 1 }) edit the current mode (cascade specs: { near: {...}, far: {...} })
//   cdda.shadowView(true)            show the sun-shadow factor only (white lit, black shadow)
//   cdda.shadowMotion({...})         frame-by-frame shadow change metrics (see below)

export function switchShadows(renderer: Renderer, name: string, persist = false): ShadowModeName {
  if (!isShadowModeName(name)) throw new Error(`unknown shadows ${name} (expected ${SHADOW_MODE_NAMES.join('|')})`);
  renderer.lights.shadows.setMode(name);
  syncShadowType(renderer);
  if (persist) storeShadowMode(name);
  return name;
}

/** The shadow sampling code (Basic vs PCF) is baked into programs: recompile when it changes. */
function syncShadowType(renderer: Renderer): void {
  const sm = renderer.three.shadowMap;
  const type = renderer.lights.shadows.pcf(look.f.softShadows) ? THREE.PCFShadowMap : THREE.BasicShadowMap;
  if (sm.type === type) return;
  sm.type = type;
  renderer.scene.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(m)) m.forEach((x) => (x.needsUpdate = true));
    else if (m) m.needsUpdate = true;
  });
}

export function installShadows(game: Game, renderer: Renderer, api: DebugApi): void {
  // LightManager already picked the boot mode; the look may have set Basic maps for it
  syncShadowType(renderer);
  const rig = renderer.lights.shadows;
  registerOption({
    category: 'World',
    name: 'Shadows',
    value: () => SHADOW_MODES[rig.name].label,
    change: (d) => {
      const i = SHADOW_MODE_NAMES.indexOf(rig.name);
      switchShadows(renderer, SHADOW_MODE_NAMES[(i + d + SHADOW_MODE_NAMES.length) % SHADOW_MODE_NAMES.length], true);
    },
    desc: SHADOW_MODE_NAMES.map((n) => `${SHADOW_MODES[n].label}: ${SHADOW_MODES[n].desc}`).join('\n'),
  });
  const a = api as DebugApi & Record<string, unknown>;
  a.shadowModes = SHADOW_MODE_NAMES;
  a.setShadows = (name: string) => switchShadows(renderer, name);
  a.shadows = () => ({ mode: rig.name, ...rig.mode, lights: rig.lights.length, renders: [...rig.renders], share: rig.uRig.value.z, steps: rig.stepper.steps, pcf: renderer.three.shadowMap.type === THREE.PCFShadowMap });
  a.shadowTweak = (o: Record<string, unknown>) => {
    const m = rig.mode as unknown as Record<string, unknown>;
    let rebuild = false;
    for (const [k, v] of Object.entries(o)) {
      if (k === 'near' || k === 'far') {
        const c = rig.mode.cascades[k === 'near' ? 0 : 1];
        if (!c) throw new Error(`shadows ${rig.name} has no ${k} cascade`);
        Object.assign(c, v);
        rebuild = true;
        continue;
      }
      if (!(k in m) || k === 'cascades' || k === 'label' || k === 'desc') throw new Error(`unknown shadow setting ${k}`);
      m[k] = v;
      rebuild = true;
    }
    if (rebuild) rig.rebuild();
    syncShadowType(renderer);
    return rig.mode;
  };
  a.shadowView = (on = true) => {
    shadowUniforms.uShadowView.value = on ? 1 : 0;
    renderer.sky.mesh.visible = !on;
    return on;
  };
  a.shadowMotion = (o: MotionOptions = {}) => shadowMotion(game, renderer, o);
}

export interface MotionOptions {
  /** frames to record (default 60) */
  frames?: number;
  /** seconds per frame (default 1/60) */
  dt?: number;
  /** walk speed along the view, m/s (0) */
  walk?: number;
  /** turn rate, degrees/s (0) */
  pan?: number;
  /** game clock speed as a multiple of normal play (1); 0 stops the sun */
  time?: number;
  /** return colour frames as PNG data URLs, cropped to [x, y, w, h] (fractions of the image) */
  capture?: boolean;
  crop?: [number, number, number, number];
  /** also return the shadow-factor frames */
  captureMask?: boolean;
  /** return a heat map of where shadows changed without the camera moving */
  heat?: boolean;
}

/**
 * Shadow motion, frame by frame. Each frame is rendered twice with the shadow-factor view on:
 * A with the shadow maps as they were (the sun rig frozen), B after the maps update as they
 * normally would that frame. Both use the same camera, time and wind, so A != B is shadow
 * change that is not the camera's own motion: shimmer, crawl, swim. Reported as a share of
 * all pixels and of the shadowed ones; `still` (no walk/pan) also counts B-to-B changes, i.e.
 * everything that moved on screen, and `flicker` the pixels that change and change back.
 */
export function shadowMotion(game: Game, renderer: Renderer, o: MotionOptions) {
  const frames = o.frames ?? 60, dt = o.dt ?? 1 / 60, walk = o.walk ?? 0, pan = o.pan ?? 0, time = o.time ?? 1;
  const pl = renderer.pipeline;
  const w = pl.lowW, h = pl.lowH, N = w * h;
  const rig = renderer.lights.shadows;
  const view = shadowUniforms.uShadowView;
  const p = game.player;
  const x0 = p.x, y0 = p.y, yaw0 = p.yaw, sec0 = game.clock.seconds;
  const hideVm = renderer.hideViewmodel;
  renderer.hideViewmodel = true;
  const renders0 = rig.renders.reduce((s, v) => s + v, 0);
  const still = walk === 0 && pan === 0;
  const half = new Uint16Array(N * 4);
  // per pixel: 0 not a lit surface (sky hidden -> cleared to 0), 1 shadow (0.5), 2 lit (1.0).
  // Non-negative half floats order like their bit patterns: 0x3733 ~ 0.45, 0x3a00 = 0.75.
  const readMask = (): Uint8Array => {
    renderer.three.readRenderTargetPixels(pl.scene, 0, 0, w, h, half);
    const m = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      const v = half[i * 4];
      m[i] = v < 0x3733 ? 0 : v < 0x3a00 ? 1 : 2;
    }
    return m;
  };
  const sky = renderer.sky.mesh;
  const setView = (on: boolean) => {
    view.value = on ? 1 : 0;
    sky.visible = !on;
  };
  const rgba = new Uint8Array(N * 4);
  const [cx, cy, cw, ch] = (o.crop ?? [0, 0, 1, 1]).map((v, i) => Math.round(v * (i % 2 === 0 ? w : h)));
  const toPng = (src: Uint8Array, gray: boolean): string => {
    const cv = document.createElement('canvas');
    cv.width = cw;
    cv.height = ch;
    const ctx = cv.getContext('2d')!;
    const img = ctx.createImageData(cw, ch);
    for (let y = 0; y < ch; y++)
      for (let x = 0; x < cw; x++) {
        // render-target rows are bottom-up
        const sy = h - 1 - (cy + y), sx = cx + x, d = (y * cw + x) * 4;
        if (gray) {
          const k = src[sy * w + sx];
          const v = k === 1 ? 30 : k === 2 ? 235 : 120;
          img.data[d] = img.data[d + 1] = img.data[d + 2] = v;
        } else {
          const s = (sy * w + sx) * 4;
          img.data[d] = src[s]; img.data[d + 1] = src[s + 1]; img.data[d + 2] = src[s + 2];
        }
        img.data[d + 3] = 255;
      }
    ctx.putImageData(img, 0, 0);
    return cv.toDataURL('image/png');
  };
  const swim: number[] = [], swimOfShadow: number[] = [], total: number[] = [], shadowed: number[] = [], flicker: number[] = [];
  const png: string[] = [], maskPng: string[] = [];
  const heat = o.heat ? new Uint16Array(N) : null;
  let prevB: Uint8Array | null = null, prevPrevB: Uint8Array | null = null;
  const fx = Math.sin(p.yaw), fy = -Math.cos(p.yaw);
  const t0 = performance.now();
  try {
    // settle: one normal frame so the first A has maps for this pose
    setView(true);
    renderer.render(0);
    for (let f = 0; f < frames; f++) {
      p.x += fx * walk * dt;
      p.y += fy * walk * dt;
      p.yaw += (pan * Math.PI / 180) * dt;
      game.clock.seconds += dt * clockScale() * time;
      rig.freeze = true;
      renderer.render(dt);
      const A = readMask();
      rig.freeze = false;
      renderer.render(0);
      const B = readMask();
      let d = 0, sh = 0;
      for (let i = 0; i < N; i++) {
        if (A[i] !== B[i]) {
          d++;
          if (heat) heat[i]++;
        }
        sh += B[i] === 1 ? 1 : 0;
      }
      swim.push(d / N);
      swimOfShadow.push(d / Math.max(1, sh));
      shadowed.push(sh / N);
      if (still && prevB) {
        let t = 0, fl = 0;
        for (let i = 0; i < N; i++) {
          if (B[i] !== prevB[i]) t++;
          if (prevPrevB && B[i] === prevPrevB[i] && B[i] !== prevB[i]) fl++;
        }
        total.push(t / N);
        if (prevPrevB) flicker.push(fl / N);
      }
      prevPrevB = prevB;
      prevB = B;
      if (o.captureMask) maskPng.push(toPng(B, true));
      if (o.capture) {
        setView(false);
        renderer.render(0);
        renderer.three.readRenderTargetPixels(pl.postTarget, 0, 0, w, h, rgba);
        png.push(toPng(rgba, false));
        setView(true);
      }
    }
  } finally {
    setView(false);
    rig.freeze = false;
    renderer.hideViewmodel = hideVm;
    p.x = x0;
    p.y = y0;
    p.yaw = yaw0;
    game.clock.seconds = sec0;
  }
  const stat = (a: number[]) => {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y);
    const pct = (v: number) => +(v * 100).toFixed(3);
    return { mean: pct(a.reduce((x, y) => x + y, 0) / a.length), p95: pct(s[Math.floor(s.length * 0.95)] ?? s[s.length - 1]), max: pct(s[s.length - 1]), framesChanged: +((a.filter((v) => v > 0.0005).length / a.length) * 100).toFixed(1) };
  };
  let heatPng: string | undefined;
  if (heat) {
    // red where shadows changed on their own, over the last frame in grey
    setView(false);
    renderer.hideViewmodel = true;
    renderer.render(0);
    renderer.hideViewmodel = hideVm;
    renderer.three.readRenderTargetPixels(pl.postTarget, 0, 0, w, h, rgba);
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext('2d')!;
    const img = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const s = (h - 1 - y) * w + x, d = (y * w + x) * 4;
        const k = Math.min(1, (heat[s] / frames) * 4);
        const g = (rgba[s * 4] + rgba[s * 4 + 1] + rgba[s * 4 + 2]) / 6;
        img.data[d] = g + k * (255 - g);
        img.data[d + 1] = g * (1 - k);
        img.data[d + 2] = g * (1 - k);
        img.data[d + 3] = 255;
      }
    ctx.putImageData(img, 0, 0);
    heatPng = cv.toDataURL('image/png');
  }
  return {
    mode: rig.name, frames, w, h, ms: Math.round(performance.now() - t0),
    mapRenders: rig.renders.reduce((s, v) => s + v, 0) - renders0,
    /** % of pixels whose shadow state changed per frame with the camera held */
    swim: stat(swim),
    /** the same as a % of the shadowed pixels */
    swimOfShadow: stat(swimOfShadow),
    shadowed: stat(shadowed),
    total: stat(total),
    flicker: stat(flicker),
    png, maskPng, heatPng,
  };
}
