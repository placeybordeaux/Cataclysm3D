import type { GameMap } from '../world/map';
import type { Item } from './item';
import { canMove, L, moveItem, spawnSome, type Loc } from './moves';
import type { PlayerAvatar } from './player';

// Where a liquid can go (BN liquid_handler.cpp, simplified): into a container that takes it
// (watertight; sealed if you carry it, a bucket only on the ground or in hand), down the
// survivor's throat, or onto the ground. UI-free: crafting uses it to auto-store results, and
// the liquid menu (src/ui/liquid_ui.ts) builds its choices from `liquidTargets`.
//
// A liquid is either new (a crafting result: `from` = null) or sitting somewhere (in the
// container being unloaded: `from` = its location). Every transfer is a moves.ts move.

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
  /** Buckets and pots (not sealable) spill when carried; BN prefers closed ones. */
  open: boolean;
}

/** How many charges of `liquid` (at `from`) `c` would take for this survivor. */
export function roomFor(host: LiquidHost, c: Item, liquid: Item, from: Loc | null): number {
  if (c === liquid || !c.isContainer()) return 0;
  const r = canMove(liquid, from, L.in(c), { partial: true, actor: host.player });
  return r.ok ? r.moved : 0;
}

/**
 * Containers that can take `liquid`: everything carried (nested too) and items lying on
 * the survivor's tile and the 8 around it. Closed containers first, then fullest fit.
 */
export function liquidTargets(host: LiquidHost, liquid: Item, exclude?: Item, from: Loc | null = null): LiquidTarget[] {
  const p = host.player;
  const out: LiquidTarget[] = [];
  const seen = new Set<Item>();
  const consider = (it: Item, where: LiquidTarget['where']) => {
    if (seen.has(it) || it === exclude) return;
    seen.add(it);
    const room = roomFor(host, it, liquid, from);
    if (room > 0) out.push({ item: it, where, room, open: !it.isWatertight() });
  };
  for (const it of p.inv.allItems()) consider(it, 'inventory');
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++)
      for (const mi of host.map.itemsAt(p.tileX + dx, p.tileY + dy, p.z) as Item[]) {
        if (typeof mi.walk !== 'function') continue;
        for (const it of mi.walk()) consider(it, 'ground');
      }
  out.sort((a, b) => Number(a.open) - Number(b.open) || Number(a.where === 'ground') - Number(b.where === 'ground') || b.room - a.room);
  return out;
}

/**
 * Put as much of a *new* `liquid` as possible into carried closed containers (no questions:
 * that's what BN's auto-handling of crafted liquids amounts to). Returns what's left, or null.
 */
export function autoStoreLiquid(host: LiquidHost, liquid: Item): Item | null {
  let left: Item | null = liquid;
  for (const t of liquidTargets(host, liquid)) {
    if (!left) break;
    if (t.open || t.where !== 'inventory') continue;
    left = spawnSome(left, L.in(t.item), { actor: host.player, quiet: true });
  }
  return left;
}

/**
 * Pour `liquid` (at `from`, or new when null) into `container`, as much as fits. Returns what
 * is left where it was (the same item), or null when all of it went.
 */
export function pourInto(host: LiquidHost, liquid: Item, container: Item, from: Loc | null = null): Item | null {
  const name = liquid.baseName();
  const before = liquid.charges;
  const r = moveItem(liquid, from, L.in(container), { partial: true, actor: host.player, quiet: true });
  if (!r.ok) {
    host.message(r.msg, 'c_light_red');
    return liquid;
  }
  host.message(`You pour the ${name} into the ${container.baseName()}.`);
  return r.moved >= before ? null : liquid;
}

/** Drink from your hands until full or it's gone; returns the rest (still at `from`). */
export function drinkLiquid(host: LiquidHost, liquid: Item, from: Loc | null = null): Item | null {
  const inv = host.player.inv;
  for (let n = 0; n < 50 && liquid.charges > 0; n++) {
    // the last sip consumes the item object itself: stop touching it
    const last = liquid.charges <= 1;
    if (!inv.consume(liquid, from).ok) break;
    if (last) return null;
  }
  return liquid.charges > 0 ? liquid : null;
}

/** Pour it out on the survivor's tile. */
export function pourOnGround(host: LiquidHost, liquid: Item, from: Loc | null = null): void {
  const p = host.player;
  const r = moveItem(liquid, from, L.ground(host.map, p.tileX, p.tileY, p.z), { force: true, quiet: true });
  if (r.ok) host.message(`You pour the ${liquid.name()} onto the ground.`);
}

/** Can the survivor drink it at all (comestible drink, not medicine-only)? */
export function drinkable(liquid: Item): boolean {
  return liquid.isComestible() && liquid.isLiquid();
}
