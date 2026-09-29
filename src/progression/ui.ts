// Progression's small UI pieces on the ui2 toolkit: nudge / unlock toasts and the HUD badge
// on the crafting key. The bigger screens (journal.ts, newgame.ts) build on ui2 directly.

import { h, toast, ui2Layers, type IconRef } from '../ui2';
import type { Game } from '../game/game';
import type { GameData } from '../data/types';
import './progression.css';

/** `<keybind:id>` → "[e]", the player's current key in brackets (reads better in running text than a bare letter). */
export function withKeys(game: Game, text: string): string {
  return text.replace(/<keybind:([a-z_0-9]+)>/g, (_, id: string) => `[${game.keys.label(id)}]`);
}

/**
 * Icon for an item id: the sprite, else its looks_like sprite, else its ASCII glyph (UltiCa
 * lacks some BN items; a '?' box teaches nothing).
 */
export function itemIcon(data: GameData, id: string): IconRef {
  const d = data.items[id];
  return { typeId: id, ...(d?.looks_like ? { looksLike: d.looks_like } : {}), ...(d ? { symbol: d.symbol, color: d.color } : {}) };
}

export function nudgeToast(game: Game, o: { title: string; body: string; category?: 'discovery' | 'warning'; icon?: string; key: string }): void {
  toast({ category: o.category ?? 'discovery', title: withKeys(game, o.title), body: withKeys(game, o.body), key: o.key, ...(o.icon ? { icon: itemIcon(game.data, o.icon) } : {}) });
}

export function unlockToast(game: Game, name: string, kind: string, icon?: string): void {
  const what = kind === 'scenario' ? 'New scenario' : kind === 'creator' ? 'Unlocked' : kind === 'cosmetic' ? 'New title' : 'New start unlocked';
  toast({ category: 'achievement', title: `${what}: ${name}`, body: kind === 'cosmetic' ? 'Pick it in New Game.' : 'Choose it from New Game on the title screen.', key: `unlock:${name}`, ...(icon ? { icon: itemIcon(game.data, icon) } : {}) });
}

/**
 * HUD badge: "[&] 3 new recipes", bottom-right above the hotbar area. Cleared when the
 * crafting menu opens. Plain DOM in the ui2 HUD layer (no pointer events: it's a label).
 */
export class CraftBadge {
  private el: HTMLElement | null = null;
  count = 0;
  constructor(private readonly game: Game) {}
  add(n: number): void {
    this.count += n;
    this.render();
  }
  clear(): void {
    this.count = 0;
    this.render();
  }
  setVisible(on: boolean): void {
    if (this.el) this.el.style.display = on && this.count ? '' : 'none';
  }
  private render(): void {
    if (!this.count) {
      if (this.el) this.el.style.display = 'none';
      return;
    }
    this.el ??= ui2Layers().hud.appendChild(h('div', { class: 'pg-badge', attrs: { 'data-testid': 'craft-badge' } }));
    this.el.style.display = '';
    this.el.replaceChildren(
      h('kbd', { text: this.game.keys.label('craft') }),
      h('span', { text: this.count === 1 ? '1 new recipe' : `${this.count} new recipes` }),
    );
  }
}
