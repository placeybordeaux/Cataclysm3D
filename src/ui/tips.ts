import { DEFAULT_BINDINGS } from './keys';
import { keyLabel } from './keymap';
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

/** What the hints need to name keys: the game's Keys (current bindings and layout). */
export interface KeyNames {
  label(id: string): string;
  movementKeys(): string;
}
const DEFAULT_NAMES: KeyNames = { label: (id) => keyLabel(DEFAULT_BINDINGS[id]?.[0] ?? '?'), movementKeys: () => 'WASD' };

/**
 * The start-of-game hints in CDDA's voice (short second-person sentences, key names in
 * yellow). Exported for tests / the help screen.
 */
export function startHints(keys: KeyNames = DEFAULT_NAMES): string[] {
  const key = (id: string) => c('c_yellow', keys.label(id));
  // Short enough to fit a 960×540 window without scrolling.
  return [
    `You wake up in an evacuation shelter.  Nobody is coming.  ${c('c_light_green', 'Search the lockers and the table')}: walk up to furniture and press ${key('interact')}; ${key('pickup')} picks things up.`,
    `Move with ${c('c_yellow', keys.movementKeys())} and the mouse.  Hold ${c('c_yellow', 'Shift')} to run: ${c('c_light_green', 'you can outrun most zombies')}, but it burns stamina.  ${key('crouch')} crouches.`,
    `${c('c_yellow', 'Left mouse')} attacks.  ${key('wield')} wields a weapon, ${key('inventory')} opens your inventory, ${key('craft')} crafts.  ${c('c_light_red', 'Zombies hear you:')} smashing, shouting and above all ${c('c_light_red', 'gunfire')} pull in everything nearby.`,
    `No weapon?  Smash (${key('smash')}) a young tree for ${c('c_white', 'long sticks')}; with a knife or a ${c('c_white', 'sharp rock')} a long stick becomes a ${c('c_white', 'long pointy stick')} (${key('craft')}).`,
    `Menus pause the game; the key that opened one, or ${c('c_yellow', 'Bksp')}, closes it.  ${key('menu')} pauses and frees the mouse (click or press a key to resume); in fullscreen (${key('fullscreen')}) it keeps it.`,
    `${key('help')} lists every key (rebind them in ${c('c_white', 'Options')}).  Don't fight against the odds: there's no shame in running.`,
  ];
}

/** Show the hints popup (always; callers check hintsEnabled()). Resolves when closed. */
export function openHints(ctx: UiContext): Promise<void> {
  return new Promise((resolve) => {
    const tip = randomTip(ctx);
    let win: UiWindow;
    const render = () => {
      const lines = startHints(ctx.game.keys).map((h) => `<div style="margin:.35em 0">${c('c_white', '•')} ${h}</div>`).join('');
      const tipHtml = tip ? `<div style="margin-top:.8em">${c('c_light_cyan', 'Tip of the day:')} ${c('c_light_gray', tip)}</div>` : '';
      win.body.innerHTML = `<div style="white-space:normal;line-height:1.35">${lines}${tipHtml}</div>`;
      win.setFooter(`${c('c_light_green', 'Enter')}/${c('c_light_green', 'Esc')} close  ${c('c_light_green', 'd')} ${hintsEnabled() ? "don't show hints at start" : c('c_yellow', 'hints disabled (re-enable in Options)')}`);
    };
    win = openWindow({
      title: 'Hints',
      width: 'min(78ch, 92vw)',
      closeLabel: null,
      onKey: (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'PageDown' || e.key === 'PageUp') {
          win.body.scrollTop += (e.key.endsWith('Down') ? 1 : -1) * (e.key.startsWith('Page') ? win.body.clientHeight : 40);
          return true;
        }
        if (e.key === 'Enter' || e.key === ' ') {
          win.close();
          return true;
        }
        if (e.key === 'd' || e.key === 'D') {
          setHintsEnabled(!hintsEnabled());
          render();
          return true;
        }
        return false; // Esc / Bksp close via the framework
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
