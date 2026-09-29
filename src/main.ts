import { Input } from './core/input';
import { loadGameData } from './data/load';
import { Game } from './game/game';
import { Renderer } from './render/renderer';
import { TestGenerator } from './world/testgen';
import { installDebugApi } from './debug';

// URL params (all optional): seed=<int>, gen=test, debug=1

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const seed = Number(params.get('seed') ?? Math.floor(Math.random() * 2 ** 31));
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const data = await loadGameData();
  const input = new Input(canvas);
  const game = new Game(data, seed, input);
  game.map.generator = new TestGenerator();
  const renderer = new Renderer(canvas, game);
  const api = installDebugApi(game, renderer);

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
