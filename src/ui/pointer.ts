import type { Game } from '../game/game';
import { closeTopWindow, getUiRoot } from './framework';

// Mouse capture policy. Gameplay uses pointer lock for mouse-look; menus keep it (they're
// keyboard-driven) unless Options > Menu cursor is "free". Outside fullscreen the browser
// releases the lock on Esc and never tells the page about the key, so losing the lock is
// treated as the Esc press it usually is: close the top menu, or open the pause (Esc) menu.
// Focus loss (alt-tab) also drops the lock but isn't an Esc: menus stay as they were.
// Whenever we're in gameplay without the lock, the simulation pauses and a "click to resume"
// hint shows — never a silent state where the mouse does nothing while zombies keep walking.
// Clicking the view or pressing any key (src/core/input.ts) takes the lock back.
//
// In fullscreen (F11, src/ui/fullscreen.ts) the keyboard lock delivers Esc to the page and
// the pointer stays locked; holding Esc leaves fullscreen.

/** What to do when the pointer lock is lost. Pure so the state machine is unit-tested. */
export type LockLossAction = 'ignore' | 'closeTop' | 'openMenu' | 'pause';

export interface LockLossState {
  /** The policy is running (gameplay has started, not dead, not an automation run). */
  active: boolean;
  /** Gameplay wants mouse-look (false on title/death screens). */
  wantLock: boolean;
  /** The lock came back already (a stray event). */
  locked: boolean;
  /** We released it ourselves for a free-cursor menu. */
  expected: boolean;
  /** Milliseconds since an Escape keydown reached the page (Infinity if never). */
  sinceEscapeMs: number;
  /** document.hasFocus() a moment after the unlock. */
  focused: boolean;
  /** A framework window is open. */
  windowOpen: boolean;
}

export function lockLostAction(s: LockLossState): LockLossAction {
  if (!s.active || !s.wantLock || s.locked || s.expected) return 'ignore';
  // The page saw this Esc (Firefox, keyboard-locked fullscreen) and already acted on it.
  if (s.sinceEscapeMs < 250) return 'ignore';
  // Alt-tab, a notification stealing focus: pause, but don't close what the player had open.
  if (!s.focused) return 'pause';
  return s.windowOpen ? 'closeTop' : 'openMenu';
}

/** Gameplay is paused behind the "click to resume" hint: wants the lock, hasn't got it, no menu open. */
export function lockPaused(s: { active: boolean; wantLock: boolean; locked: boolean; captured: boolean }): boolean {
  return s.active && s.wantLock && !s.locked && !s.captured;
}

export function installPointerPolicy(game: Game): { begin(): void; end(): void } {
  const input = game.input;
  // Under automation (puppeteer) pointer lock usually can't be acquired, so the policy stays
  // off unless ?realinput=1 asks for it (tools/drive.ts --headful tests it with real input).
  const automated = typeof navigator !== 'undefined' && !!navigator.webdriver && new URLSearchParams(location.search).get('realinput') !== '1';
  const hint = document.createElement('div');
  hint.className = 'resume-hint';
  hint.style.display = 'none';
  getUiRoot().appendChild(hint);

  document.addEventListener('pointerlockchange', () => {
    if (input.locked) return;
    const expected = input.expectUnlock;
    input.expectUnlock = false;
    const at = performance.now();
    // Chrome fires pointerlockchange before blur on alt-tab: look at focus a moment later.
    setTimeout(() => {
      const act = lockLostAction({
        active: !automated,
        wantLock: input.wantLock,
        locked: input.locked,
        expected,
        sinceEscapeMs: at - input.lastEscape,
        focused: document.hasFocus(),
        windowOpen: input.captured,
      });
      if (act === 'closeTop') closeTopWindow();
      else if (act === 'openMenu') game.keys.handler('menu')?.();
    }, 60);
  });

  let shown = false;
  const update = () => {
    const show = lockPaused({ active: !automated, wantLock: input.wantLock, locked: input.locked, captured: input.captured });
    if (show !== shown) {
      shown = show;
      hint.style.display = show ? '' : 'none';
      // Re-read the keys each time: the menu key may have been rebound.
      if (show)
        hint.innerHTML = `Paused &mdash; <span style="color:var(--c-light_green)">click</span> or press a key to resume` +
          `<div style="color:var(--c-light_gray);font-size:.85em">${game.keys.label('menu')} opens the menu &middot; ${game.keys.label('fullscreen')} fullscreen keeps the mouse captured</div>`;
    }
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
