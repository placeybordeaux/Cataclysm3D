import type { DebugApi } from '../debug';
import type { Game } from '../game/game';
import type { WorldGenerator } from '../world/worldgen';
import { registerOption } from '../ui/options';
import { LOOK_NAMES, LOOKS, isLookName, look } from './look';
import type { Renderer } from './renderer';
import { frameStats, summarize } from '../perfDebug';
import { voxelStats } from './voxel';

// Wires the visual styles (look.ts) into the game: the Options entry, the automation API
// and the per-look scene layers that need game/world access (skyline from the overmap).
//
//   cdda.setLook('crisp')            switch live (not persisted)
//   cdda.looks                       names
//   await cdda.benchView(5)          frame-time percentiles standing still (GPU perf)

export function installLooks(game: Game, renderer: Renderer, worldgen: WorldGenerator | null, api: DebugApi): void {
  void game;
  if (worldgen) renderer.skyline.overmap = worldgen.overmap;
  registerOption({
    name: 'Visual style',
    value: () => LOOKS[look.name].label,
    change: (d) => {
      const i = LOOK_NAMES.indexOf(look.name);
      renderer.setLook(LOOK_NAMES[(i + d + LOOK_NAMES.length) % LOOK_NAMES.length], true);
    },
    desc: LOOK_NAMES.map((n) => `${LOOKS[n].label}: ${LOOKS[n].desc}`).join('\n'),
  });
  const a = api as DebugApi & Record<string, unknown>;
  a.looks = LOOK_NAMES;
  a.voxelStats = voxelStats;
  a.setLook = (name: string) => {
    if (!isLookName(name)) throw new Error(`unknown look ${name}`);
    renderer.setLook(name);
    return name;
  };
  /** Override single features of the current look (not persisted), e.g. {ssao: 0}. */
  a.lookTweak = (o: Record<string, unknown>) => {
    const prevSoft = look.f.softShadows;
    for (const [k, v] of Object.entries(o)) {
      if (!(k in look.f)) throw new Error(`unknown look feature ${k}`);
      (look.f as unknown as Record<string, unknown>)[k] = v;
    }
    renderer.applyLook(prevSoft);
    return look.f;
  };
  /** Stand still for `seconds` and summarise frame intervals (real GPU: drive.ts --gpu). */
  a.benchView = async (seconds = 5) => {
    frameStats.reset();
    frameStats.recording = true;
    await new Promise((r) => setTimeout(r, seconds * 1000));
    frameStats.recording = false;
    // renderer-only cost, synchronised with the GPU (the frame interval also carries the sim)
    const bench = (a.benchRender as ((n: number) => { msPerFrame: number }) | undefined)?.(40);
    return { look: look.name, interval: summarize(frameStats.interval), work: summarize(frameStats.work), renderMs: bench?.msPerFrame, stats: renderer.stats() };
  };
}
