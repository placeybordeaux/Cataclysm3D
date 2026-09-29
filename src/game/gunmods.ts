import type { Rng } from '../core/rng';
import type { Character } from './character';
import { MAX_RECOIL } from './character';
import { asArray, type Item } from './item';
import { L, moveItem, type Loc } from './moves';

// Gun depth (CDDA item_gun_tool_ammo.cpp / ranged.cpp): gunmods (install/remove with CDDA's
// compatibility rules, mod locations incl. mounts that add_mod new slots), their effect on
// dispersion/handling/sights/noise/range/shot spread, fire modes (SEMI/BURST/AUTO), gun jams
// (handle_gun_damage) and aim levels (Character::get_aim_types). Pure logic over Items.

// ------------------------------------------------------------------ gunmods

type ModLoc = [string, number];

/** Gun's own `valid_mod_locations` plus slots added by installed mods (sights mounts…). */
export function modLocations(gun: Item): Map<string, number> {
  const out = new Map<string, number>();
  for (const [loc, n] of (gun.def.valid_mod_locations as ModLoc[] | undefined) ?? []) out.set(loc, (out.get(loc) ?? 0) + n);
  for (const m of gun.gunmods) for (const [loc, n] of (m.def.add_mod as ModLoc[] | undefined) ?? []) out.set(loc, (out.get(loc) ?? 0) + n);
  return out;
}

export function modLocation(mod: Item): string {
  return String(mod.def.location ?? '');
}

export function freeModSlots(gun: Item, loc: string): number {
  return (modLocations(gun).get(loc) ?? 0) - gun.gunmods.filter((m) => modLocation(m) === loc).length;
}

export function isGunmod(it: Item): boolean {
  return it.def.type === 'GUNMOD' || (it.def.subtypes ?? []).includes('GUNMOD');
}

/**
 * item::is_gunmod_compatible: a slot of the mod's location free, the mod usable on this gun
 * type (mod_targets: gun skill or gun id), no duplicate or blacklisted mod, internals only on
 * an unloaded gun, compatible ammo for ammo-specific mods. Returns the CDDA reason on failure.
 */
export function gunmodCompatible(gun: Item, mod: Item): { ok: boolean; reason?: string } {
  const fail = (reason: string) => ({ ok: false, reason });
  if (!isGunmod(mod)) return fail('is not a gunmod');
  if (!gun.isGun()) return fail("isn't a weapon");
  if (isGunmod(gun)) return fail('is a gunmod and cannot be modded');
  if (gun.gunmods.some((m) => m.typeId === mod.typeId)) return fail(`already has a ${mod.baseName()}`);
  const loc = modLocation(mod);
  if (!modLocations(gun).has(loc)) return fail("doesn't have a slot for this mod");
  if (freeModSlots(gun, loc) <= 0) return fail(`doesn't have enough room for another ${loc} mod`);
  const targets = asArray(mod.def.mod_targets as string[] | string | undefined);
  if (!targets.includes(gun.def.skill ?? '') && !targets.includes(gun.typeId)) return fail(`cannot have a ${mod.baseName()}`);
  if (loc === 'underbarrel' && !mod.hasFlag('PUMP_RAIL_COMPATIBLE') && gun.hasFlag('PUMP_RAIL')) return fail('can only accept small mods on that slot');
  if (['magazine', 'mechanism', 'loading port', 'bore'].includes(loc) && (gun.ammoRemaining() > 0 || gun.magazineCurrent()))
    return fail('must be unloaded before installing this mod');
  const acceptable = asArray(mod.def.acceptable_ammo as string[] | undefined);
  if (acceptable.length && !acceptable.some((a) => gun.ammoTypes().includes(a))) return fail(`${mod.baseName()} cannot be used on item with no compatible ammo types`);
  for (const slot of asArray(mod.def.blacklist_slot as string[] | undefined)) if (modLocations(gun).has(slot)) return fail(`cannot be installed on a weapon with a "${slot}"`);
  for (const other of asArray(mod.def.blacklist_mod as string[] | undefined)) {
    const hit = gun.gunmods.find((m) => m.typeId === other);
    if (hit) return fail(`cannot be installed on a weapon with a "${hit.baseName()}"`);
  }
  // Installed mods can blacklist the newcomer too.
  for (const m of gun.gunmods) if (asArray(m.def.blacklist_mod as string[] | undefined).includes(mod.typeId)) return fail(`cannot be installed on a weapon with a "${m.baseName()}"`);
  return { ok: true };
}

/** min_skills ("weapon" = the gun's own skill) the installer must meet (gunmod_attach). */
export function gunmodSkillShortfall(c: Character, gun: Item, mod: Item): string | null {
  for (const [sk, lvl] of (mod.def.min_skills as [string, number][] | undefined) ?? []) {
    const id = sk === 'weapon' ? (gun.def.skill ?? 'gun') : sk;
    if (c.getSkill(id) < lvl) return `You need ${c.skillName(id)} ${lvl} to install the ${mod.baseName()}.`;
  }
  return null;
}

/** Game seconds to install (CDDA install_time; the extractor normalizes "30 s" to seconds). */
export function installSeconds(mod: Item): number {
  const t = mod.def.install_time;
  return typeof t === 'number' && t > 0 ? t : 60;
}

/** Attach `mod` (which is at `from`: the installer's inventory, the ground...) to `gun`. */
export function installGunmod(c: Character, gun: Item, mod: Item, from: Loc | null): { ok: boolean; msg: string } {
  const ok = gunmodCompatible(gun, mod);
  if (!ok.ok) return { ok: false, msg: `Your ${gun.baseName()} ${ok.reason}.` };
  const skill = gunmodSkillShortfall(c, gun, mod);
  if (skill) return { ok: false, msg: skill };
  const r = moveItem(mod, from, L.mod(gun), { actor: c, quiet: true });
  if (!r.ok) return { ok: false, msg: r.msg };
  const msg = `You successfully attached the ${mod.baseName()} to your ${gun.baseName()}.`;
  c.msg(msg, 'c_green');
  return { ok: true, msg };
}

/** Mods that can come off: not IRREMOVABLE and not a mount other installed mods need. */
export function removableReason(gun: Item, mod: Item): string | null {
  if (mod.hasFlag('IRREMOVABLE')) return `The ${mod.baseName()} can't be removed.`;
  // A mount can only go once what sits on the slots it adds fits in what's left.
  for (const [loc, n] of (mod.def.add_mod as ModLoc[] | undefined) ?? []) {
    const onLoc = gun.gunmods.filter((m) => m !== mod && modLocation(m) === loc);
    if (onLoc.length > (modLocations(gun).get(loc) ?? 0) - n) return `Remove the ${onLoc[0].baseName()} first.`;
  }
  return null;
}

/** Detach a mod into the first of `to` that takes it (the inventory, else the ground). */
export function removeGunmod(c: Character, gun: Item, mod: Item, to: Loc[]): { ok: boolean; msg: string; mod?: Item } {
  const why = removableReason(gun, mod);
  if (why) return { ok: false, msg: why };
  if (!gun.gunmods.includes(mod)) return { ok: false, msg: `The ${mod.baseName()} isn't on your ${gun.baseName()}.` };
  let last = `You have nowhere to put the ${mod.baseName()}.`;
  for (const dest of to) {
    const r = moveItem(mod, L.mod(gun), dest, { actor: c, quiet: true });
    if (r.ok) {
      const msg = `You remove your ${mod.baseName()} from your ${gun.baseName()}.`;
      c.msg(msg);
      return { ok: true, msg, mod };
    }
    last = r.msg;
  }
  return { ok: false, msg: last };
}

const num = (v: unknown) => (typeof v === 'number' ? v : 0);

/** Sum of a numeric gunmod field over installed mods. */
export function modSum(gun: Item, field: string): number {
  let s = 0;
  for (const m of gun.gunmods) s += num(m.def[field]);
  return s;
}

/** item::gun_shot_spread_multiplier. */
export function shotSpreadMultiplier(gun: Item): number {
  return Math.max(0, 1 + modSum(gun, 'shot_spread_multiplier_modifier'));
}

/**
 * item::sight_dispersion: the gun's iron sights (300 when a mod has DISABLE_SIGHTS) or the
 * best installed sight (a mod with sight_dispersion >= 0 and field_of_view > 0).
 */
export function sightDispersion(gun: Item): number {
  const disabled = gun.hasFlag('DISABLE_SIGHTS') || gun.gunmods.some((m) => m.hasFlag('DISABLE_SIGHTS'));
  let best = disabled ? 300 : typeof gun.def.sight_dispersion === 'number' ? gun.def.sight_dispersion : 90;
  for (const m of gun.gunmods) {
    const sd = m.def.sight_dispersion, fov = m.def.field_of_view;
    if (typeof sd !== 'number' || sd < 0 || typeof fov !== 'number' || fov <= 0) continue;
    best = Math.min(best, sd);
  }
  return best;
}

// ------------------------------------------------------------------ fire modes

export interface GunMode {
  id: string;
  name: string;
  qty: number;
  flags: string[];
}

/** item::gun_all_modes: the gun's `modes` plus mode_modifier from mods; default semi-auto. */
export function gunModes(gun: Item): GunMode[] {
  const out: GunMode[] = [];
  const add = (raw: unknown[]) => {
    const [id, name, qty, flags] = raw as [string, string, number, string[] | undefined];
    if (typeof id !== 'string' || out.some((m) => m.id === id)) return;
    out.push({ id, name: String(name ?? id.toLowerCase()), qty: Math.max(1, Number(qty) || 1), flags: flags ?? [] });
  };
  for (const m of (gun.def.modes as unknown[][] | undefined) ?? []) add(m);
  for (const mod of gun.gunmods) for (const m of (mod.def.mode_modifier as unknown[][] | undefined) ?? []) add(m);
  if (!out.length) out.push({ id: 'DEFAULT', name: 'semi-auto', qty: 1, flags: [] });
  // Mods can hide modes by id (hide_modes).
  const hidden = new Set(gun.gunmods.flatMap((m) => asArray(m.def.hide_modes as string[] | undefined)));
  const vis = out.filter((m) => !hidden.has(m.id));
  return vis.length ? vis : out.slice(0, 1);
}

export function currentMode(gun: Item): GunMode {
  const modes = gunModes(gun);
  return modes.find((m) => m.id === gun.vars.gun_mode) ?? modes[0];
}

/** CDDA select_fire_mode: step to the next mode. */
export function cycleMode(gun: Item): GunMode {
  const modes = gunModes(gun);
  const i = modes.findIndex((m) => m.id === currentMode(gun).id);
  const next = modes[(i + 1) % modes.length];
  gun.vars.gun_mode = next.id;
  return next;
}

// ------------------------------------------------------------------ faults

/** Chance a shot jams from gun damage level and magazine damage (handle_gun_damage). */
export function jamChance(gun: Item): number {
  const mult = num(gun.def.gun_jam_mult) || 1;
  const gl = Math.min(4, Math.max(0, Math.floor(gun.damage / 1000)));
  const g = [0.0005, 0.03, 0.15, 0.45, 0.8][gl] * mult;
  const mag = gun.magazineCurrent();
  let m = 0;
  if (mag) {
    const ml = Math.min(4, Math.max(0, Math.floor(mag.damage / 1000)));
    m = [0.00027, 0.05, 0.24, 0.96, 2.5][ml] * (num(mag.def.mag_jam_mult) || 1);
  }
  return g + m;
}

export function isJammed(gun: Item): boolean {
  return !!gun.vars.jammed;
}

/**
 * Roll the per-shot malfunctions: a durability-based one-off malfunction (1 in
 * (2 << durability) × 3; the shot just fails) or a jam from damage (sets a fault that must
 * be cleared). NEVER_JAMS guns are immune. Returns the CDDA message, or null to fire.
 */
export function rollMalfunction(gun: Item, rng: Rng): string | null {
  if (gun.hasFlag('NEVER_JAMS')) return null;
  if (isJammed(gun)) return `Your ${gun.baseName()} is jammed!`;
  const dur = num(gun.def.durability) || 5;
  if (rng.oneIn((2 << dur) * 3)) return `Your ${gun.baseName()} malfunctions!`;
  if (rng.next() < jamChance(gun)) {
    gun.vars.jammed = 1;
    return `Your ${gun.baseName()} malfunctions!`;
  }
  return null;
}

export function clearJam(gun: Item): boolean {
  if (!isJammed(gun)) return false;
  delete gun.vars.jammed;
  return true;
}

// ------------------------------------------------------------------ aim levels

export type AimLevel = 'Immediate' | 'Regular' | 'Careful' | 'Precise';

/**
 * Character::get_aim_types thresholds: 10% and 2.5% of the way from the sight limit to
 * MAX_RECOIL, then the limit itself. `limit` is the most accurate aiming method's dispersion.
 */
export function aimThresholds(limit: number): { regular: number; careful: number; precise: number } {
  return {
    regular: Math.trunc((MAX_RECOIL - limit) / 10 + limit),
    careful: Math.trunc((MAX_RECOIL - limit) / 40 + limit),
    precise: Math.trunc(limit),
  };
}

export function aimLevel(recoil: number, limit: number): AimLevel {
  const t = aimThresholds(limit);
  // A hair of slack: aim() approaches the floor asymptotically.
  if (recoil <= t.precise + 1) return 'Precise';
  if (recoil <= t.careful) return 'Careful';
  if (recoil <= t.regular) return 'Regular';
  return 'Immediate';
}
