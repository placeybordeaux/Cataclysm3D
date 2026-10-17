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
    art: (id) => chunks.source.averageColor?.(id) ?? null,
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
    const far = proxies.enabled && p.z >= 0 ? Math.max(CAMERA_FAR, (proxies.outer(R) + 1.5) * CHUNK) : CAMERA_FAR;
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
  a.farLod = () => ({ mode: farLod.mode, proxies: { ...proxies.stats }, handoff: { ...handoff.stats }, appearing: appearing.size, cameraFar: renderer.camera.far });
  /** Drop the chunks beyond `dist` m: they stream back in and hand over in view (captures). */
  a.restreamEdge = (dist = 130) => chunks.dropBeyond(game.player.x, game.player.y, dist);
  /** Pause chunk building (true) or resume it: captures separate dropping from arriving. */
  a.holdBuilds = (on: boolean) => void (chunks.holdBuilds = on);
  return { proxies, handoff };
}
