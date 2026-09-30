import { installLooks } from './render/lookInstall';
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
import { installPointerPolicy } from './ui/pointer';
import { installDevBridge } from './dev/bridge';
import { installUi } from './ui/index';
import { installAudio } from './audio/install';
import { installCrafting } from './ui/crafting_install';
import { installVehicles } from './ui/vehicle_ui';
import { installWorldInteraction } from './worldInteraction';
import { installNature } from './nature';
import { lightAt } from './game/vision';
import { installMonsters } from './monsters';
import { smashAimed } from './game/bash';
import { installNpcs } from './npcs';
import { installMutBio } from './mutbio';
import { installCombatDepth } from './combatdepth';
import { installCombatFeel } from './feel';
import { installAim } from './aim';
import { installLabs } from './labs';
import { installChunkTracking } from './save/tracking';
import { installSave, takePendingLoad } from './save/install';
import { frameStats, installPerfDebug } from './perfDebug';
import { ChunkPrefetcher } from './world/prefetch';
import { installAchievements } from './achievements';
import { installProgression } from './progression/install';
import { installDifficulty } from './difficulty';
import { installTacticalPause } from './pause';
import { installScreens } from './screens/install';
import { installChunkEviction } from './save/eviction';
import { installPerf } from './perf/install';

// URL params (all optional): seed=<int>, gen=world|test (default world), debug=1 (render stats overlay),
// renderer params px/grade/tex/cam/walls (see src/render/renderer.ts), debug=atlas (sprite sheet view
// instead of the game, see src/render/atlasDebug.ts), debug=ui2 (ui2 component showcase, docs/UI2.md)

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  if (params.get('debug') === 'atlas') {
    const { runAtlasDebug } = await import('./render/atlasDebug');
    return runAtlasDebug(document.getElementById('view') as HTMLCanvasElement);
  }
  if (params.get('debug') === 'ui2') {
    const { runUi2Showcase } = await import('./ui2/showcase');
    return runUi2Showcase(document.getElementById('view') as HTMLCanvasElement);
  }
  // ?gallery: the style gallery (src/gallery, docs/GALLERY.md), a debug page on the real
  // renderer. It never loads or writes saves (not even the dev hot-reload snapshot, which a
  // tab opened from the game would otherwise inherit) and defaults to the seed its scenes use.
  const gallery = params.has('gallery');
  // A save chosen on the previous page (title screen Load) decides the world to build.
  const pending = gallery ? null : await takePendingLoad();
  const seed = pending?.file ? pending.file.world.seed : Number(params.get('seed') ?? (gallery ? 1 : Math.floor(Math.random() * 2 ** 31)));
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
  installPerfDebug(api, game, worldgen ? () => worldgen!.overmap.citiesNear(game.player.x / 24, game.player.y / 24) : undefined);
  // Visual styles (Options > Visual style, ?look=): per-look layers, cdda.setLook/benchView.
  installLooks(game, renderer, worldgen, api);
  installAudio(game, api);
  installCrafting(game, api, renderer);
  installWorldInteraction(game, renderer, api);
  installNature(game, renderer, api);
  // One light model: vision.ts lightAt (monster vision, "too dark", playerCanSee) reads the
  // renderer's shadowcast light map where it's exact and estimates elsewhere.
  game.lightProvider = (x, y, z) => renderer.exactLightAt(x, y, z);
  // Crafting/reading probe `game.lightAt` for "too dark" checks; back it with real vision light.
  (game as unknown as { lightAt: (x: number, y: number, z: number) => number }).lightAt = (x, y, z) => lightAt(game, x, y, z);
  const monsters = installMonsters(game, renderer, worldgen, api);
  // Swinging at a window/door/furniture with nothing alive in the arc smashes it.
  monsters.combat.smashWorld = () => smashAimed(game);
  // Difficulty presets (src/game/difficulty.ts): spawner knobs, needs, feel, pausing; before progression (its hook).
  installDifficulty(game, { spawner: monsters.spawner, api });
  await installVehicles(game, renderer, api);
  const npcs = await installNpcs(game, renderer, worldgen, monsters, api);
  const mods = installMutBio(game, renderer, api);
  installLabs(game, worldgen, api);
  // Before installUi: the UI registers the save key only when game.save exists.
  const save = await installSave(game, { api, genKind, worldgen, monsters });
  game.events.on('gameLoaded', () => renderer.chunks.invalidateAll());
  // Far clean chunks are dropped (they regenerate); keep well outside the rendered radius.
  api.eviction = installChunkEviction(game, { keepRadius: () => renderer.chunks.radius + 4 });
  const ui = await installUi(game, renderer, worldgen, api);
  // After the UI: wraps the reload key (clears gun jams) and adds item-menu gunmod actions.
  installCombatDepth(game, renderer, monsters, api);
  // Combat feel layer (telegraphs, guard, side-step, hit-stop, crosshair HUD); wraps reload/interact.
  installCombatFeel(game, renderer, monsters, api);
  // Aim model (sway / timing / classic dice): moving reticle, timing games, Options entry; wraps reload.
  installAim(game, renderer, monsters, api);
  // After installMonsters (wraps PlayerCombat for attack events) and installSave (its saveable).
  const achievements = await installAchievements(game, worldgen, api);
  // Unlocks, discovery tips, the journal; the title screen's Start / New Game use it.
  const progression = await installProgression(game, ui.ctx, worldgen, achievements, api);
  // Tactical pause key + PAUSED banner (src/pause.ts).
  installTacticalPause(game, api);
  // ui2 dialogue/trade/missions/vehicle/body-mod/achievement panels replace the curses ones.
  installScreens(game, renderer, { npcs, mods }, api);

  // Mapgen ahead of the player in idle time (see src/world/prefetch.ts); ?prefetch=0 disables.
  const prefetch = new ChunkPrefetcher(game.map, () => game.player);
  api.prefetch = prefetch;
  // Generate one ring beyond what's drawn so chunks entering the draw circle are ready to mesh.
  prefetch.opts.radius = renderer.chunks.radius + 1;
  if (params.get('prefetch') !== '0') prefetch.start();
  // Performance telemetry: F3 overlay, Shift+F3 dump, cdda.perf (src/perf, docs/PERF.md).
  installPerf(game, renderer, api, prefetch);

  let last = performance.now();
  const loop = (now: number) => {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    frameStats.begin(now);
    game.frame(dt);
    frameStats.lap('game');
    prefetch.observe(now);
    frameStats.lap('prefetch');
    renderer.render();
    api.__onFrame?.();
    frameStats.frame(performance.now() - now, now);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  // Title screen / character creation (skipped with ?skipmenu=1 and under automation),
  // unless the previous page asked to load a save.
  const loaded = pending ? await save.applyPending(pending) : false;
  if (gallery) {
    // No title, no mouse capture, no save session, no live bridge (tools/live.ts must keep
    // talking to the player's own tab): the gallery owns the page from here.
    const { runGallery } = await import('./gallery');
    await runGallery({ game, renderer, api });
    api.ready = true;
    return;
  }
  api.ready = true;
  // Dev only: live view/eval bridge for the terminal (tools/live.ts).
  installDevBridge(game, renderer, api);
  if (!loaded) await ui.boot();
  // Gameplay proper: capture the mouse from here on (title/chargen use it as a pointer).
  const pointer = installPointerPolicy(game);
  pointer.begin();
  game.events.on('playerDied', () => pointer.end());
  // Spawns were held while the title screen / character creation ran (density choice).
  monsters.spawner.release();
  save.startSession();
  achievements.begin(loaded);
  progression.begin(loaded);
}

main().catch((e) => {
  document.body.innerHTML = `<pre style="color:#f55;padding:1em;font:14px monospace">${String(e?.stack ?? e)}</pre>`;
  (window as any).cddaError = String(e?.stack ?? e);
  throw e;
});
