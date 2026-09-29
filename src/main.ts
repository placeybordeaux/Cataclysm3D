import { Input } from './core/input';
import { loadGameData } from './data/load';
import { Game } from './game/game';
import { Renderer } from './render/renderer';
import { TestGenerator } from './world/testgen';
import { WorldGenerator } from './world/worldgen';
import { loadWorldgenData } from './world/worldgen_data';
import { installWorldgenDebug } from './world/worldgen_debug';
import { installDebugApi } from './debug';
import { initUi } from './ui/framework';
import { installUi } from './ui/index';
import { installAudio } from './audio/install';
import { installCrafting } from './ui/crafting_install';
import { installVehicles } from './ui/vehicle_ui';
import { installWorldInteraction } from './worldInteraction';
import { installNature } from './nature';
import { lightAt } from './game/vision';
import { installMonsters } from './monsters';
import { installNpcs } from './npcs';
import { installMutBio } from './mutbio';
import { installChunkTracking } from './save/tracking';
import { installSave, takePendingLoad } from './save/install';
import { installAchievements } from './achievements';

// URL params (all optional): seed=<int>, gen=world|test (default world), debug=1 (render stats overlay),
// renderer params px/grade/tex/cam/walls (see src/render/renderer.ts), debug=atlas (sprite sheet view
// instead of the game, see src/render/atlasDebug.ts)

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  if (params.get('debug') === 'atlas') {
    const { runAtlasDebug } = await import('./render/atlasDebug');
    return runAtlasDebug(document.getElementById('view') as HTMLCanvasElement);
  }
  // A save chosen on the previous page (title screen Load) decides the world to build.
  const pending = await takePendingLoad();
  const seed = pending?.file ? pending.file.world.seed : Number(params.get('seed') ?? Math.floor(Math.random() * 2 ** 31));
  const genKind = pending?.file ? pending.file.world.gen : params.get('gen') ?? 'world';
  if (genKind !== 'world' && genKind !== 'test') throw new Error(`unknown gen=${genKind} (expected world or test)`);
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const [data, worldgenData] = await Promise.all([loadGameData(), genKind === 'world' ? loadWorldgenData() : null]);
  const input = new Input(canvas);
  initUi(document.getElementById('ui') as HTMLElement, input);
  const game = new Game(data, seed, input);
  // Before any chunk generates: saves store only chunks that differ from their generated state.
  installChunkTracking(game);
  let worldgen: WorldGenerator | null = null;
  if (worldgenData) {
    worldgen = new WorldGenerator(seed, worldgenData, data);
    game.map.generator = worldgen;
    // CDDA's default scenario: wake up inside an evacuation shelter near a town.
    // (A loaded save puts the player back where they were instead.)
    const start = worldgen.findStartLocation('shelter', game.map);
    game.player.x = start.x + 0.5;
    game.player.y = start.y + 0.5;
    game.player.z = start.z;
  } else {
    game.map.generator = new TestGenerator();
  }
  const renderer = new Renderer(canvas, game);
  // Wait for the tile atlas so the first frames (and screenshots) use the real art.
  await renderer.ready;
  const api = installDebugApi(game, renderer);
  if (worldgen) installWorldgenDebug(api, game, worldgen);
  installAudio(game, api);
  installCrafting(game, api);
  installWorldInteraction(game, renderer, api);
  installNature(game, renderer, api);
  // One light model: vision.ts lightAt (monster vision, "too dark", playerCanSee) reads the
  // renderer's shadowcast light map where it's exact and estimates elsewhere.
  game.lightProvider = (x, y, z) => renderer.exactLightAt(x, y, z);
  // Crafting/reading probe `game.lightAt` for "too dark" checks; back it with real vision light.
  (game as unknown as { lightAt: (x: number, y: number, z: number) => number }).lightAt = (x, y, z) => lightAt(game, x, y, z);
  const monsters = installMonsters(game, renderer, worldgen, api);
  await installVehicles(game, renderer, api);
  await installNpcs(game, renderer, worldgen, monsters, api);
  installMutBio(game, renderer, api);
  // Before installUi: the UI registers the save key only when game.save exists.
  const save = await installSave(game, { api, genKind, worldgen, monsters });
  game.events.on('gameLoaded', () => renderer.chunks.invalidateAll());
  const ui = await installUi(game, renderer, worldgen, api);
  // After installMonsters (wraps PlayerCombat for attack events) and installSave (its saveable).
  const achievements = await installAchievements(game, worldgen, api);

  let last = performance.now();
  const loop = (now: number) => {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    game.frame(dt);
    renderer.render();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  // Title screen / character creation (skipped with ?skipmenu=1 and under automation),
  // unless the previous page asked to load a save.
  const loaded = pending ? await save.applyPending(pending) : false;
  api.ready = true;
  if (!loaded) await ui.boot();
  save.startSession();
  achievements.begin(loaded);
}

main().catch((e) => {
  document.body.innerHTML = `<pre style="color:#f55;padding:1em;font:14px monospace">${String(e?.stack ?? e)}</pre>`;
  (window as any).cddaError = String(e?.stack ?? e);
  throw e;
});
