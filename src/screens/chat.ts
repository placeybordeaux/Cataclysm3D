// Small NPC menus as ui2 context menus (they open at the screen centre, where the crosshair
// was): `C` chat (talk to someone nearby, orders for your followers, yell) and the item
// picker dialogue effects use when an NPC takes one of your things.

import type { Game } from '../game/game';
import type { Npc } from '../game/npc';
import type { NpcSystem } from '../game/npcai';
import type { Item } from '../game/item';
import { emitSound } from '../game/sound';
import { openContextMenu, type MenuItem } from '../ui2';
import { plain } from './common';

const centre = () => ({ x: Math.round(window.innerWidth / 2), y: Math.round(window.innerHeight / 2) });

export function openChatMenu2(game: Game, sys: NpcSystem, talk: (n: Npc) => void): void {
  const p = game.player;
  const dist = (n: Npc) => Math.hypot(n.x - p.x, n.y - p.y);
  const near = sys.npcs.filter((n) => !n.dead && n.z === p.z && dist(n) <= 15).sort((a, b) => dist(a) - dist(b));
  const allies = near.filter((n) => n.isAlly());
  const items: MenuItem[] = [{ header: near.length ? 'Talk to…' : 'Nobody is in earshot' }];
  near.forEach((n, i) => items.push({
    label: `${n.displayName()}  (${Math.round(dist(n))} m${n.isEnemy() ? ', hostile' : n.isAlly() ? ', follower' : ''})`,
    key: i < 9 ? String(i + 1) : undefined,
    danger: n.isEnemy(),
    primary: i === 0,
    // After the menu closes, so the dialogue's panel is the next surface.
    action: () => setTimeout(() => talk(n), 0),
  }));
  if (allies.length) {
    items.push({ separator: true }, { header: 'Orders' });
    items.push({
      label: 'Wait here', key: 'W',
      action: () => {
        for (const n of allies) {
          n.following = false;
          n.guardPos = { x: n.tileX, y: n.tileY, z: n.z };
        }
        game.message('You tell your allies to wait here.');
      },
    });
    items.push({
      label: 'Follow me', key: 'F',
      action: () => {
        for (const n of allies) {
          n.following = true;
          n.guardPos = null;
          n.attitude = 'FOLLOW';
        }
        game.message('You tell your allies to follow you.');
      },
    });
  }
  items.push({ separator: true }, {
    label: 'Yell', key: 'Y',
    action: () => {
      game.message('You yell!');
      emitSound(game, { x: p.tileX, y: p.tileY, z: p.z }, 30, 'yelling', { category: 'speech', source: p, ambient: true });
    },
  });
  openContextMenu(centre(), items, { title: 'Talk or give orders' });
}

/** npc_gets_item: pick one of your items (null = you decline). */
export function pickItem2(title: string, items: Item[], onPick: (it: Item | null) => void): void {
  if (!items.length) return onPick(null);
  let chosen = false;
  const entries: MenuItem[] = items.map((it, i) => ({
    label: plain(it.name()),
    icon: { typeId: it.typeId, looksLike: it.def.looks_like as string | undefined, symbol: (it.def.symbol as string | undefined) ?? '?', color: ((it.def.color as string | undefined) ?? 'light_gray').replace(/^c_/, '') },
    key: i < 9 ? String(i + 1) : undefined,
    action: () => {
      chosen = true;
      onPick(it);
    },
  }));
  // ui2 menus call onClose before the chosen action runs: decide after it.
  openContextMenu(centre(), entries, { title: plain(title), onClose: () => setTimeout(() => !chosen && onPick(null), 0) });
}
