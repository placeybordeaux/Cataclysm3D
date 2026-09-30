// Remembering what the survivor has seen lying around (src/game/seenitems.ts), for the reload
// helper's "you saw 2 light batteries in a dresser 40 m northwest" (src/game/reloadhelp.ts).
//
// "Seen" is what the pile markers would show: floor piles and furniture tops in line of sight
// within SEEN_RADIUS, and storage you've looked into (LootMemory says searched) — never the
// inside of a closed drawer you haven't opened (CDDA hides that too). Only reload-relevant items
// are kept (ammo, magazines, batteries, UPSes). A light scan once a second of game time; the
// memory is saved with the game.

import type { Game } from '../../game/game';
import type { Item } from '../../game/item';
import type { LootMemory } from '../../game/loot';
import { reloadRelevant, SeenItems, type Sighting } from '../../game/seenitems';
import { setReloadHints, withArticle } from '../../game/reloadhelp';
import { registerSaveable } from '../../save/registry';
import { CHUNK } from '../../world/coords';
import { lineOfSight } from './markers';
import { isLootContainer } from './sources';

export const SEEN_RADIUS = 12;
const SCAN_EVERY = 1; // real seconds

export function installSeenItems(game: Game, lootMemory: () => LootMemory): { seen(): SeenItems; scan(): void } {
  let seen = new SeenItems();
  registerSaveable(game, 'seenItems', {
    save: () => seen.toJSON(),
    load: (j) => void (seen = SeenItems.fromJSON(j)),
    missing: () => void (seen = new SeenItems()),
  });

  const map = () => game.map;
  /** False once the tile is loaded and the item is gone; undefined when it can't be checked. */
  const stillThere = (s: Sighting): boolean | undefined => {
    if (!map().hasChunk(Math.floor(s.x / CHUNK), Math.floor(s.y / CHUNK), s.z)) return undefined;
    for (const top of map().itemsAt(s.x, s.y, s.z) as unknown as Item[]) for (const it of top.walk()) if (it.typeId === s.id) return true;
    return false;
  };
  setReloadHints(game.player, () => {
    const p = game.player;
    return { seen, here: { x: p.tileX, y: p.tileY, z: p.z }, stillThere };
  });

  const scan = () => {
    const p = game.player;
    if (p.dead || p.isAsleep()) return;
    const mem = lootMemory();
    const t = game.clock.seconds;
    for (let dy = -SEEN_RADIUS; dy <= SEEN_RADIUS; dy++)
      for (let dx = -SEEN_RADIUS; dx <= SEEN_RADIUS; dx++) {
        if (dx * dx + dy * dy > SEEN_RADIUS * SEEN_RADIUS) continue;
        const x = p.tileX + dx, y = p.tileY + dy;
        const items = map().itemsAt(x, y, p.z) as unknown as Item[];
        if (!items.length) continue;
        const f = map().furnAt(x, y, p.z);
        const container = isLootContainer(f);
        if (container && mem.state(x, y, p.z) === 'unsearched') continue;
        // Count before the line-of-sight walk: most piles hold nothing worth remembering.
        const counts = new Map<string, number>();
        for (const top of items) for (const it of top.walk()) if (reloadRelevant(it)) counts.set(it.typeId, (counts.get(it.typeId) ?? 0) + (it.countByCharges ? it.charges : 1));
        if (!counts.size) continue;
        if (!lineOfSight(game, p.tileX, p.tileY, x, y, p.z)) continue;
        const where = f.id === 'f_null' ? 'on the ground' : `${container ? 'in' : 'on'} ${withArticle(f.name)}`;
        for (const [id, n] of counts) seen.record(id, n, x, y, p.z, where, t);
      }
  };

  let acc = 0;
  game.systems.push({
    name: 'seen-items',
    update(_g, realDt) {
      acc += realDt;
      if (acc < SCAN_EVERY) return;
      acc = 0;
      scan();
    },
  });
  return { seen: () => seen, scan };
}
