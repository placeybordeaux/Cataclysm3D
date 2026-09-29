import type { Game } from '../game/game';

// Fullscreen with keyboard lock (Chrome/Edge): in fullscreen entered through the Fullscreen API,
// navigator.keyboard.lock(['Escape']) makes Esc an ordinary key for the page, so it opens and
// closes menus without dropping mouse capture; holding Esc still leaves fullscreen (the
// browser shows that tip). Other browsers get plain fullscreen, where Esc leaves it.

interface KeyboardLock {
  lock?: (keys?: string[]) => Promise<void>;
  unlock?: () => void;
}
const keyboard = (): KeyboardLock | undefined => (navigator as unknown as { keyboard?: KeyboardLock }).keyboard;

export function isFullscreen(): boolean {
  return !!document.fullscreenElement;
}

/** Toggle fullscreen; must run inside a user gesture (key or click handler). */
export async function toggleFullscreen(game: Game): Promise<void> {
  if (document.fullscreenElement) {
    keyboard()?.unlock?.();
    await document.exitFullscreen().catch(() => {});
    return;
  }
  try {
    await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
  } catch (e) {
    game.message(`Fullscreen isn't available here (${(e as Error).message}).`, 'c_light_red');
    return;
  }
  try {
    await keyboard()?.lock?.(['Escape']);
  } catch {
    // no keyboard lock (Firefox, Safari): Esc leaves fullscreen as usual
  }
  // Entering fullscreen is a fine moment to take the mouse too.
  game.input.tryLock();
}

export function installFullscreen(game: Game): void {
  game.keys.register('fullscreen', 'Toggle fullscreen (keeps Esc from releasing the mouse)', () => void toggleFullscreen(game));
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) keyboard()?.unlock?.();
  });
}
