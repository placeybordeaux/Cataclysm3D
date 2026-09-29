import { DEFAULT_BINDINGS } from './keys';
import { c, openWindow, type UiWindow } from './framework';
import { registerOption } from './options';
import type { UiContext } from './context';

// Onboarding hints, CDDA-style: a "Hints" popup when a new game starts (disable it with
// [d] in the popup or Options > Show hints at start), and CDDA's own "tip of the day"
// snippets (data/core/tips.json, extracted into ui.json). The first-page hints cover what a
// CDDA veteran would otherwise have to guess in this port: real-time keys, where the evac
// shelter keeps its kit, and that noise and running work like they do in CDDA.

const STORAGE_KEY = 'cdda3d.hints';

export function hintsEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setHintsEnabled(on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off');
  } catch {
    // storage blocked: the setting just doesn't persist
  }
}

/** A random CDDA tip-of-the-day line (plain text), or '' when the data has none. */
export function randomTip(ctx: UiContext, rng = Math.random): string {
  const tips = ctx.data.tips ?? [];
  return tips.length ? tips[Math.floor(rng() * tips.length)] : '';
}

const key = (id: string) => c('c_yellow', (DEFAULT_BINDINGS[id]?.[0] ?? '?').replace('Escape', 'Esc'));

/**
 * The start-of-game hints in CDDA's voice (short second-person sentences, key names in
 * yellow). Exported for tests / the help screen.
 */
export function startHints(): string[] {
  return [
    `You wake up in an evacuation shelter.  Nobody is coming.  ${c('c_light_green', 'Search the lockers and the table')} — the shelter's supplies are all you have.  Walk up to furniture and press ${key('interact')} to look inside; ${key('pickup')} picks things up.`,
    `Move with ${c('c_yellow', 'WASD')} and the mouse.  Hold ${c('c_yellow', 'Shift')} to run: ${c('c_light_green', 'you can outrun most zombies')}, but running burns stamina.  ${key('crouch')} crouches.`,
    `${c('c_light_red', 'Zombies hear you.')}  Smashing things, shouting and above all ${c('c_light_red', 'gunfire')} carry a long way and pull in everything nearby.  A quiet weapon keeps you alive longer.`,
    `${c('c_yellow', 'Left mouse')} attacks.  Heavy, awkward things make poor weapons: the time between swings is shown next to your weapon (${c('c_light_gray', 'Wield:')} in the sidebar).  ${key('wield')} wields, ${key('inventory')} opens your inventory, ${key('craft')} crafts.`,
    `No weapon?  ${c('c_white', 'Sticks')} and ${c('c_white', 'rocks')} lie in the woods around the shelter, and smashing (${key('smash')}) a young tree gives ${c('c_white', 'long sticks')}.  With anything sharp, a long stick becomes a ${c('c_white', 'long pointy stick')} (${key('craft')}).`,
    `Don't fight against the odds.  There's no shame in running to survive.  ${key('help')} lists every key; ${key('menu')} pauses the game.`,
  ];
}

/** Show the hints popup (always; callers check hintsEnabled()). Resolves when closed. */
export function openHints(ctx: UiContext): Promise<void> {
  return new Promise((resolve) => {
    const tip = randomTip(ctx);
    let win: UiWindow;
    const render = () => {
      const lines = startHints().map((h) => `<div style="margin:.35em 0">${c('c_white', '•')} ${h}</div>`).join('');
      const tipHtml = tip ? `<div style="margin-top:.8em">${c('c_light_cyan', 'Tip of the day:')} ${c('c_light_gray', tip)}</div>` : '';
      win.body.innerHTML = `<div style="white-space:normal;line-height:1.35">${lines}${tipHtml}</div>`;
      win.setFooter(`${c('c_light_green', 'Enter')} / ${c('c_light_green', 'Esc')} close   ${c('c_light_green', 'd')} ${hintsEnabled() ? "don't show hints at start" : c('c_yellow', 'hints disabled (re-enable in Options)')}`);
    };
    win = openWindow({
      title: 'Hints',
      width: 'min(78ch, 92vw)',
      onKey: (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          win.close();
          return true;
        }
        if (e.key === 'd' || e.key === 'D') {
          setHintsEnabled(!hintsEnabled());
          render();
          return true;
        }
        return true;
      },
      onClose: () => resolve(),
    });
    render();
  });
}

/** Called once a new game begins (not on load): show the hints unless disabled. */
export function maybeShowStartHints(ctx: UiContext): Promise<void> {
  return hintsEnabled() ? openHints(ctx) : Promise.resolve();
}

export function installTipsOption(): void {
  registerOption({
    name: 'Show hints at start',
    value: () => (hintsEnabled() ? 'on' : 'off'),
    change: () => setHintsEnabled(!hintsEnabled()),
    desc: 'Show the Hints popup (keys, where to find gear, how noise works) when a new game starts.',
  });
}
