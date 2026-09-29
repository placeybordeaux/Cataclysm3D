import type { GameMap } from '../world/map';
import type { Item } from './item';
import type { PlayerAvatar } from './player';

// Where a loose liquid can go (CDDA liquid_handler.cpp, simplified): into a watertight
// container that is empty or already holds the same liquid, down the survivor's throat, or
// onto the ground. UI-free: crafting uses it to auto-store results, and the liquid menu
// (src/ui/liquid_ui.ts) builds its choices from `liquidTargets`.

export interface LiquidHost {
  map: GameMap;
  player: PlayerAvatar;
  message(text: string, color?: string): void;
}

export interface LiquidTarget {
  item: Item;
  where: 'inventory' | 'ground';
  /** Charges of the liquid that fit. */
  room: number;
  /** Open containers (pots, buckets) spill when carried; CDDA prefers closed ones. */
  open: boolean;
}

/** Whether `c` can take (some of) `liquid`, and how many charges. */
export function roomFor(c: Item, liquid: Item): number {
  if (c === liquid) return 0;
  let room = 0;
  for (const p of c.containerPockets()) {
    if (!p.data.watertight) continue;
    const r = p.canContain(liquid);
    if (r.ok) room += r.charges ?? liquid.charges;
  }
  return Math.min(room, liquid.charges);
}

/**
 * Containers that can take `liquid`: everything carried (nested too) and items lying on
 * the survivor's tile and the 8 around it (CDDA PICKUP_RANGE is 6; adjacent reads better in
 * real time). Closed containers first, then fullest fit.
 */
export function liquidTargets(host: LiquidHost, liquid: Item, exclude?: Item): LiquidTarget[] {
  const p = host.player;
  const out: LiquidTarget[] = [];
  const seen = new Set<Item>();
  const consider = (it: Item, where: LiquidTarget['where']) => {
    if (seen.has(it) || it === exclude) return;
    seen.add(it);
    const room = roomFor(it, liquid);
    if (room > 0) out.push({ item: it, where, room, open: it.containerPockets().some((pk) => !!pk.data.open_container) });
  };
  for (const it of p.inv.allItems()) consider(it, 'inventory');
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++)
      for (const it of host.map.itemsAt(p.tileX + dx, p.tileY + dy, p.z) as Item[]) {
        if (typeof (it as Item).containerPockets !== 'function') continue;
        consider(it, 'ground');
        for (const inner of it.allContents()) consider(inner, 'ground');
      }
  out.sort((a, b) => Number(a.open) - Number(b.open) || Number(a.where === 'ground') - Number(b.where === 'ground') || b.room - a.room);
  return out;
}

/**
 * Put as much of `liquid` as possible into carried closed containers (no questions: that's
 * what CDDA's auto-pickup of crafted liquids amounts to). Returns what's left, or null.
 */
export function autoStoreLiquid(host: LiquidHost, liquid: Item): Item | null {
  let left: Item | null = liquid;
  for (const t of liquidTargets(host, liquid)) {
    if (!left) break;
    if (t.open || t.where !== 'inventory') continue;
    left = t.item.put(left);
  }
  return left;
}

/** Pour into `container`; returns the rest (null = all of it went in). */
export function pourInto(host: LiquidHost, liquid: Item, container: Item): Item | null {
  const name = liquid.baseName();
  const before = liquid.charges;
  const left = container.put(liquid);
  const moved = before - (left?.charges ?? 0);
  if (moved > 0) host.message(`You pour the ${name} into the ${container.baseName()}.`);
  return left && left.charges > 0 ? left : null;
}

/** Drink from your hands until full or it's gone; returns the rest. */
export function drinkLiquid(host: LiquidHost, liquid: Item): Item | null {
  const inv = host.player.inv;
  for (let n = 0; n < 50 && liquid.charges > 0; n++) {
    if (!inv.consume(liquid).ok) break;
  }
  return liquid.charges > 0 ? liquid : null;
}

export function pourOnGround(host: LiquidHost, liquid: Item): void {
  const p = host.player;
  host.map.addItem(p.tileX, p.tileY, p.z, liquid);
  host.message(`You pour the ${liquid.name()} onto the ground.`);
}

/** Can the survivor drink it at all (comestible drink, not medicine-only)? */
export function drinkable(liquid: Item): boolean {
  return liquid.isComestible() && liquid.isLiquid();
}
