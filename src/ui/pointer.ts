import type { Game } from '../game/game';
import { closeTopWindow, getUiRoot } from './framework';

// Mouse capture policy. Gameplay uses pointer lock for mouse-look; menus keep it (they're
// keyboard-driven). The browser always releases the lock on Esc (we can't prevent that
// outside fullscreen), so losing the lock is treated as the Esc press it usually is:
// close the top menu, or open the pause (Esc) menu. Whenever we're in gameplay without the
// lock, the simulation pauses and a "click to resume" hint shows — never a silent state
// where the mouse does nothing while zombies keep walking.

export function installPointerPolicy(game: Game): { begin(): void; end(): void } {
  const input = game.input;
  const automated = typeof navigator !== 'undefined' && !!navigator.webdriver;
  const hint = document.createElement('div');
  hint.className = 'resume-hint';
  hint.innerHTML = 'Paused &mdash; <span style="color:var(--c-light_green)">click</span> to resume';
  hint.style.display = 'none';
  getUiRoot().appendChild(hint);

  document.addEventListener('pointerlockchange', () => {
    if (input.locked || !input.wantLock || automated) return;
    // A keydown Escape we already handled (it closed a window / opened the menu) — nothing more.
    if (performance.now() - input.lastEscape < 250) return;
    // Otherwise the browser swallowed the Esc (or focus was lost): act on it ourselves.
    if (!closeTopWindow()) game.keys.handler('menu')?.();
  });

  const update = () => {
    const show = input.wantLock && !automated && !input.locked && !input.captured;
    hint.style.display = show ? '' : 'none';
    game.lockPaused = show;
    requestAnimationFrame(update);
  };
  requestAnimationFrame(update);

  return {
    begin() {
      input.wantLock = true;
      input.tryLock();
    },
    end() {
      input.wantLock = false;
      if (document.pointerLockElement) document.exitPointerLock();
    },
  };
}
