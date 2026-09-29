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

// URL params (all optional): seed=<int>, gen=world|test (default world), debug=1 (render stats overlay),
// renderer params px/grade/tex/cam/walls (see src/render/renderer.ts), debug=atlas (sprite sheet view
// instead of the game, see src/render/atlasDebug.ts)

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  if (params.get('debug') === 'atlas') {
    const { runAtlasDebug } = await import('./render/atlasDebug');
    return runAtlasDebug(document.getElementById('view') as HTMLCanvasElement);
  }
  const seed = Number(params.get('seed') ?? Math.floor(Math.random() * 2 ** 31));
  const genKind = params.get('gen') ?? 'world';
  if (genKind !== 'world' && genKind !== 'test') throw new Error(`unknown gen=${genKind} (expected world or test)`);
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const [data, worldgenData] = await Promise.all([loadGameData(), genKind === 'world' ? loadWorldgenData() : null]);
  const input = new Input(canvas);
  initUi(document.getElementById('ui') as HTMLElement, input);
  const game = new Game(data, seed, input);
  let worldgen: WorldGenerator | null = null;
  if (worldgenData) {
    worldgen = new WorldGenerator(seed, worldgenData, data);
    game.map.generator = worldgen;
    // CDDA's default scenario: wake up inside an evacuation shelter near a town.
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

  let last = performance.now();
  const loop = (now: number) => {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    game.frame(dt);
    renderer.render();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  api.ready = true;
}

main().catch((e) => {
  document.body.innerHTML = `<pre style="color:#f55;padding:1em;font:14px monospace">${String(e?.stack ?? e)}</pre>`;
  (window as any).cddaError = String(e?.stack ?? e);
  throw e;
});
