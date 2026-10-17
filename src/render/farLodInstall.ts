import { Box3, type Mesh } from 'three';
import type * as THREE from 'three';
import type { DebugApi } from '../debug';
import type { Game } from '../game/game';
import { CHUNK } from '../world/coords';
import { GameMap } from '../world/map';
import { WorldGenerator } from '../world/worldgen';
import { registerOption } from '../ui/options';
import { clearFade, setFade } from './dissolve';
import { DISSOLVE_S, dissolves, FAR_LOD_MODES, farLod, Handoff, setFarLodMode, usesProxies, type FarLodMode } from './farLod';
import { FarProxyLayer, overmapTopOf } from './farProxy';
import type { PlaceholderLayer } from './placeholders';
import type { Renderer } from './renderer';
import { look } from './look';
import { SKYLINE_NEAR, SKYLINE_OUTER, SKYLINE_PULL } from './skyline';

// Wires the far LOD (farLod.ts, farProxy.ts, docs/FAR_LOD.md) into the renderer: the proxy
// ring, the hand-off after each chunk update, fade-ins of covers appearing at the far edge, the
// camera's far plane (the proxies reach past the chunks' 200 m), the option and the debug API.
//
//   cdda.setFarLod('dissolve')   switch live (not persisted)
//   cdda.farLod()                mode and stats

const CAMERA_FAR = 200;

export function installFarLod(game: Game, renderer: Renderer, worldgen: WorldGenerator, placeholders: PlaceholderLayer, api: DebugApi): { proxies: FarProxyLayer; handoff: Handoff } {
  // a hook-free copy of the world for columns nobody has generated (farProxy.ts)
  const scratch = new GameMap(game.map.seed);
  for (const t of game.map.terrain.defs) scratch.terrain.add(t);
  for (const f of game.map.furniture.defs) scratch.furniture.add(f);
  scratch.generator = new WorldGenerator(worldgen.seed, worldgen.wg, worldgen.game, worldgen.genVersion, worldgen.overmap);
  const chunks = renderer.chunks;
  const proxies = new FarProxyLayer({
    live: game.map,
    scratch,
    overmapTop: (cx, cy) => overmapTopOf((x, y, z) => worldgen.overmap.omtAt(x, y, z), cx, cy),
    white: () => renderer.whiteFrame(),
    art: (id, part) => chunks.source.averageColor?.(id, part) ?? null,
    pitch: () => look.f.archDetail,
  });
  renderer.scene.add(proxies.group);
  proxies.yieldTo = () => chunks.behind;
  proxies.startIdle();
  const handoff = new Handoff(chunks, placeholders, proxies, (cx, cy) => {
    const t = chunks.levels.columnTop(cx, cy);
    return Number.isNaN(t) ? 1 : t;
  });

  // Covers appearing at the far edge (a proxy at the ring's rim, a stand-in when a column
  // becomes wanted) fade in instead of popping up.
  const appearing = new Map<THREE.Object3D, { t0: number; proxy: [number, number] | null }>();
  const appear = (o: THREE.Object3D, proxy: [number, number] | null, now: number) => {
    appearing.set(o, { t0: now, proxy });
    setFade(o, 0);
  };

  let lastMode: FarLodMode | null = null;
  renderer.beforeRender.push(() => {
    const mode = farLod.mode;
    const p = game.player;
    const now = performance.now();
    const R = chunks.radius;
    if (mode !== lastMode) {
      // (switching live: a clean slate, the next frames rebuild what the mode needs)
      for (const o of appearing.keys()) clearFade(o);
      appearing.clear();
      handoff.reset();
      if (!usesProxies(mode)) proxies.clear();
      lastMode = mode;
    }
    proxies.enabled = usesProxies(mode);
    placeholders.doneFn = mode === 'current' ? null : (cx, cy) => handoff.done(cx, cy);
    placeholders.covered = usesProxies(mode) ? (cx, cy) => proxies.has(cx, cy) : null;
    proxies.update(p.x, p.y, p.z, R, chunks.forward);
    const cam = renderer.camera;
    // With proxies the skyline's pull starts past them (else the pulled far ground ring lands
    // in front of distant proxies and paints over their bottoms), and the far plane takes in
    // the proxies and everything the skyline pulls in behind them.
    const proxyOn = proxies.enabled && p.z >= 0;
    const near = proxyOn ? (proxies.outer(R) + 1.5) * CHUNK : SKYLINE_NEAR;
    renderer.skyline.uniforms.uNear.value = near;
    const pulledFar = near + Math.max(0, (R + SKYLINE_OUTER + 1) * CHUNK - near) * SKYLINE_PULL;
    const far = proxyOn ? Math.max(CAMERA_FAR, pulledFar + 10) : CAMERA_FAR;
    if (cam.far !== far) {
      cam.far = far;
      cam.updateProjectionMatrix();
    }
    if (dissolves(mode)) {
      const pcx = Math.floor(p.x / CHUNK), pcy = Math.floor(p.y / CHUNK);
      for (const [cx, cy] of proxies.fresh) {
        // inside the draw radius the hand-off owns a proxy (it is the cover there)
        if ((cx - pcx) ** 2 + (cy - pcy) ** 2 <= (R + 2) ** 2) continue;
        const m = proxies.solo(cx, cy);
        if (m) appear(m, [cx, cy], now);
      }
      for (const m of placeholders.fresh) appear(m, null, now);
    }
    proxies.fresh.length = 0;
    for (const [o, a] of appearing) {
      const f = (now - a.t0) / (DISSOLVE_S * 1000);
      if (f < 1 && o.parent) {
        setFade(o, f);
        continue;
      }
      clearFade(o);
      appearing.delete(o);
      if (a.proxy && !handoff.covering(a.proxy[0], a.proxy[1])) proxies.unsolo(a.proxy[0], a.proxy[1]);
    }
  });
  chunks.afterUpdate.push(() => handoff.update(game.player.x, game.player.y, game.player.z));
  game.events.on('gameLoaded', () => {
    handoff.reset();
    proxies.clear();
  });

  registerOption({
    category: 'World',
    name: 'Far detail',
    value: () => farLod.mode,
    change: (d) => setFarLodMode(FAR_LOD_MODES[(FAR_LOD_MODES.indexOf(farLod.mode) + d + FAR_LOD_MODES.length) % FAR_LOD_MODES.length], true),
    desc: 'How buildings at the edge of the draw distance come in.  proxy-dissolve: low-poly copies of the real buildings out to 1.75x the draw distance, the detail dissolves in over them.  proxy: the same, swapped in one frame.  dissolve: no far copies; the stand-in boxes fade in and the buildings dissolve in over them.  current: the old pop-in.',
  });
  const a = api as DebugApi & Record<string, unknown>;
  /** Far LOD mode (farLod.ts): live, not persisted. */
  a.setFarLod = (m: string) => setFarLodMode(m as FarLodMode, false);
  /**
   * Columns inside the proxy ring that show nothing: neither handed over to their chunks nor
   * drawn as a proxy (a hole where a building should be). `inner`: those inside the draw radius
   * + 2, where the ring is long built and a hole is a bug, not the rim still filling in.
   */
  const uncovered = () => {
    const p = game.player, R = chunks.radius, outer = proxies.outer(R);
    const pcx = Math.floor(p.x / CHUNK), pcy = Math.floor(p.y / CHUNK);
    let all = 0, inner = 0;
    for (let dy = -Math.ceil(outer); dy <= Math.ceil(outer); dy++)
      for (let dx = -Math.ceil(outer); dx <= Math.ceil(outer); dx++) {
        const d2 = dx * dx + dy * dy;
        if (d2 > outer * outer) continue;
        const cx = pcx + dx, cy = pcy + dy;
        if (proxies.drawn(cx, cy) || handoff.done(cx, cy) || handoff.covering(cx, cy)) continue;
        all++;
        if (d2 <= (R + 2) ** 2) inner++;
      }
    return { all, inner };
  };
  a.farLod = () => ({ mode: farLod.mode, proxies: { ...proxies.stats }, handoff: { ...handoff.stats }, appearing: appearing.size, cameraFar: renderer.camera.far, uncovered: usesProxies(farLod.mode) ? uncovered() : null });
  /** Drop the chunks beyond `dist` m: they stream back in and hand over in view (captures). */
  a.restreamEdge = (dist = 130) => chunks.dropBeyond(game.player.x, game.player.y, dist);
  /** Debug: draw only proxies (chunks and stand-ins hidden), to compare their shapes with the real view. */
  a.proxyView = (on: boolean) => {
    proxies.showAll = on;
    chunks.group.visible = !on;
    placeholders.group.visible = !on;
    proxies.remergeAll();
  };
  /**
   * Debug: per built column within `r` chunks, the proxy's top against the real chunks' top
   * (bounding boxes of the world meshes); the worst `n` mismatches.
   */
  a.proxyCheck = (r = 6, n = 12) => {
    const p = game.player;
    const pcx = Math.floor(p.x / CHUNK), pcy = Math.floor(p.y / CHUNK);
    const out: { cx: number; cy: number; proxy: number; real: number; diff: number }[] = [];
    const box = new Box3(), tmp = new Box3();
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const cx = pcx + dx, cy = pcy + dy;
        const pt = proxies.proxyTop(cx, cy);
        if (Number.isNaN(pt)) continue;
        box.makeEmpty();
        for (let z = 0; z <= 10; z++) {
          const e = chunks.entryAt(cx, cy, z);
          e?.group?.traverse((o) => {
            const m = o as Mesh;
            if (!m.isMesh || !(m.material as { userData?: { worldPage?: boolean } }).userData?.worldPage) return;
            m.geometry.computeBoundingBox();
            tmp.copy(m.geometry.boundingBox!).applyMatrix4(m.matrixWorld);
            box.union(tmp);
          });
        }
        if (box.isEmpty()) continue;
        out.push({ cx, cy, proxy: +pt.toFixed(2), real: +box.max.y.toFixed(2), diff: +(pt - box.max.y).toFixed(2) });
      }
    out.sort((a2, b) => Math.abs(b.diff) - Math.abs(a2.diff));
    return { checked: out.length, worst: out.slice(0, n), meanAbs: +(out.reduce((s2, o) => s2 + Math.abs(o.diff), 0) / Math.max(1, out.length)).toFixed(2) };
  };
  /** Debug: a column's proxy source and the live chunks' wall/tree counts per level. */
  a.proxyColumn = (cx: number, cy: number) => {
    const lv: Record<number, { walls: number; trees: number; empty: boolean }> = {};
    for (let z = 0; z <= 10; z++) {
      if (!game.map.hasChunk(cx, cy, z)) continue;
      const c = game.map.chunk(cx, cy, z)!;
      let walls = 0, trees = 0;
      for (let i = 0; i < c.ter.length; i++) {
        const t = game.map.terrain.get(c.ter[i]);
        if (t.flags?.includes('WALL')) walls++;
        if (t.flags?.includes('TREE')) trees++;
      }
      lv[z] = { walls, trees, empty: !!c.empty };
    }
    return { proxy: proxies.describe(cx, cy), omt: worldgen.overmap.omtAt(cx, cy, 0).id, live: lv };
  };
  /** Pause chunk building (true) or resume it: captures separate dropping from arriving. */
  a.holdBuilds = (on: boolean) => void (chunks.holdBuilds = on);
  return { proxies, handoff };
}
