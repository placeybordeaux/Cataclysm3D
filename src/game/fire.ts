import { hasFlag } from '../world/registry';
import type { ActionResult } from './inventory';
import { facingTile, ADJACENT } from './construction';
import type { CraftHost } from './crafting';
import { Item } from './item';
import { adaptationRules } from './adaptation_rules';
import { isOutside } from './vision';

// Lighting fires (iuse_actor.cpp firestarter_actor): apply a lighter/matches/… to the tile
// you face. It needs something that burns there (firewood-type items, or flammable
// terrain/furniture) and takes longer without good fuel; survival skill speeds it up. The
// result is an fd_fire field, which the renderer lights and crafting treats as the "fire"
// pseudo tool (cooking, boiling water, fire-hardening spears).

const BURNABLE_MATERIALS = new Set(['wood', 'paper', 'cardboard', 'cotton', 'dry_plant', 'straw', 'wool', 'leather', 'bone', 'plastic']);

/** Fuel value of what lies on a tile: FIREWOOD/TINDER items count fully, other burnables less. */
export function fuelAt(host: CraftHost, x: number, y: number, z: number): number {
  let fuel = 0;
  for (const mi of host.map.itemsAt(x, y, z)) {
    if (!(mi instanceof Item)) continue;
    if (mi.hasFlag('FIREWOOD') || mi.hasFlag('TINDER')) fuel += 100;
    else if (mi.def.material?.some((m) => BURNABLE_MATERIALS.has(m))) fuel += 10;
  }
  return fuel;
}

export function flammableTile(host: CraftHost, x: number, y: number, z: number): boolean {
  const t = host.map.terAt(x, y, z), f = host.map.furnAt(x, y, z);
  const flam = (d: { flags: string[] }) => hasFlag(d, 'FLAMMABLE') || hasFlag(d, 'FLAMMABLE_ASH') || hasFlag(d, 'FLAMMABLE_HARD');
  return flam(t) || (f.id !== 'f_null' && flam(f));
}

/** Where `A`pplying a firestarter lights: the faced tile, else an adjacent one with fuel. */
export function fireTarget(host: CraftHost): [number, number, number] {
  const [fx, fy, fz] = facingTile(host);
  const p = host.player;
  if (fx !== Math.floor(p.x) || fy !== Math.floor(p.y)) return [fx, fy, fz];
  for (const [dx, dy] of ADJACENT) {
    const x = Math.floor(p.x) + dx, y = Math.floor(p.y) + dy;
    if (fuelAt(host, x, y, p.z) > 0) return [x, y, p.z];
  }
  return [fx, fy, fz];
}

let lastWarning: { key: string; at: number } | null = null;

/**
 * Why a fire at (x, y, z) could get out of hand, or null (docs/ADAPTATION.md). BN lights a
 * pile of sticks in a field without a word; fire then spreads to anything flammable next to
 * it. Safe: a FIRE_CONTAINER (fire ring, brazier, fireplace, wood stove) under it.
 */
export function fireSpreadRisk(host: CraftHost, x: number, y: number, z: number): string | null {
  if (hasFlag(host.map.furnAt(x, y, z), 'FIRE_CONTAINER')) return null;
  const roofed = !isOutside(host.map, x, y, z);
  if (roofed) return 'That fire would be indoors, with nothing to hold it.';
  for (const [dx, dy] of ADJACENT) {
    if (flammableTile(host, x + dx, y + dy, z)) return 'There is something flammable right next to it.';
    if (fuelAt(host, x + dx, y + dy, z) > 0) return 'There are things that burn right next to it.';
  }
  return null;
}

/**
 * firestarter_actor::use at (x, y, z). `ua` is the item's use_action (moves / moves_slow).
 * Returns CDDA's messages; lighting takes an activity, the fire appears when it completes.
 */
export function useFirestarter(host: CraftHost, tool: Item, ua: { moves?: number; moves_slow?: number; [k: string]: unknown }, x: number, y: number, z: number): ActionResult {
  const say = (ok: boolean, msg: string, col?: string): ActionResult => {
    host.message(msg, col ?? (ok ? undefined : 'c_light_red'));
    return { ok, msg, moves: 0 };
  };
  const p = host.player;
  if (x === Math.floor(p.x) && y === Math.floor(p.y) && z === p.z) return say(false, 'You would set yourself on fire.');
  const need = tool.def.charges_per_use ?? 1;
  const usesCharges = tool.ammoCapacity() > 0 || (tool.def.max_charges ?? 0) > 0;
  if (usesCharges && tool.ammoRemaining() < need) return say(false, "This tool doesn't have enough charges.");
  if (host.map.fieldsAt(x, y, z).some((f) => f.type === 'fd_fire')) return say(false, 'There is already a fire.', 'c_light_gray');
  const fuel = fuelAt(host, x, y, z);
  if (fuel <= 0 && !flammableTile(host, x, y, z) && !hasFlag(host.map.furnAt(x, y, z), 'FIRE_CONTAINER'))
    return say(false, "There's nothing to light there.");
  const risk = fireSpreadRisk(host, x, y, z);
  if (risk && adaptationRules.fireWarning) {
    const key = `${x},${y},${z}`;
    // Second try at the same spot within 30 real seconds: they've read it, go ahead. Real
    // time, not game time: game time runs ~20x faster and a menu in between used up a minute.
    const now = Date.now() / 1000;
    if (!(lastWarning && lastWarning.key === key && now - lastWarning.at < 30)) {
      lastWarning = { key, at: now };
      return say(false, `${risk}  Fires spread.  A fire ring (10 rocks), a brazier or a fireplace keeps it in.  Use the lighter again to light it anyway.`, 'c_yellow');
    }
  }
  // BN firestarter_actor::load: moves_slow defaults to 10 × the fast cost.
  const fast = ua.moves ?? 100, slow = ua.moves_slow ?? fast * 10;
  if (ua.need_sunlight) {
    const h = host.clock.hourOfDay;
    if (p.z < 0 || h < 8 || h >= 18) return say(false, 'You need direct sunlight to light a fire with this.');
  }
  const base = fuel >= 100 ? fast : fuel >= 10 ? (fast + slow) / 2 : slow;
  const mod = Math.pow(0.8, Math.min(5, p.getSkill('survival')));
  const moves = Math.max(Math.min(base, Math.sqrt(1 + base / 100) * 100), base * mod);
  const seconds = Math.max(1, Math.round(moves / 100));
  if (seconds > 60) host.message(`At your skill level, it will take around ${Math.round(seconds / 60)} minutes to light a fire.`, 'c_light_gray');
  const light = () => {
    if (usesCharges) tool.ammoConsume(need);
    host.map.addField(x, y, z, 'fd_fire', 1);
    p.practice('survival', Math.floor(mod + fast / 100 + 2), 5);
    host.message('You successfully light a fire.', 'c_light_green');
  };
  const ok = host.activities.start({ name: 'lighting the fire', duration: seconds, onComplete: light });
  return { ok, msg: ok ? 'You start lighting a fire.' : '', moves: 0 };
}
