import type { Game } from '../game/game';
import type { Renderer } from './renderer';

// Load / teleport curtain (QA_WAVE3 #6). After a jump the chunks around the player don't
// exist yet for a second or two, and what showed was the far ground ring (a flat pale plane)
// with grass cards already standing on it. The chunk manager now builds never-built chunks
// next to the player first under its urgent budget; meanwhile the image stays black and
// fades in once they exist. Walking and driving never trigger it: the near ring is built long
// before the player reaches it.

/** Seconds of fade-in once the near chunks are meshed. */
const FADE = 0.3;
/** Give up curtaining after this long (a level with no chunks at all, a stuck build). */
const MAX_HOLD = 4;

export function installNearCurtain(game: Game, renderer: Renderer): void {
  let held = 0;
  renderer.beforeRender.push((dt) => {
    const p = game.player;
    const pending = renderer.chunks.nearUnbuilt(p.x, p.y, p.z) > 0;
    const pl = renderer.pipeline;
    if (pending && held < MAX_HOLD) {
      held += dt;
      pl.curtain = 1;
    } else {
      if (!pending) held = 0;
      pl.curtain = Math.max(0, pl.curtain - dt / FADE);
    }
  });
}
