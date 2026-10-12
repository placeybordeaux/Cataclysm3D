import type { Game } from './game';
import type { Item } from './item';
import type { BionicState } from './bionics';

// Bionic guns (BN bionics.cpp activate_bionic, BIONIC_GUN branch; activity_actor.cpp
// aim_activity_actor::use_bionic / finish). Activating a BIONIC_GUN bionic spawns its fake_item
// as a *detached* gun: it is never wielded, never enters the inventory or the save, and the
// wielded item is left exactly where it was. The activation cost is refunded at once and the
// same amount (power_activate, kJ) is charged per shot actually fired instead.
//
// This module owns the session (one per Game) so every reader of "what is the survivor shooting
// with" — PlayerCombat, the HUD, ADS, the fire-mode key — agrees on one answer (activeWeapon).
// Adaptation from BN (docs/BN_BIONIC_GUNS.md): BN charges cost × shots after the whole burst and
// never re-checks power while re-aiming; real-time bursts here pay per shot and stop the burst
// (and the session) when the next shot can't be paid. Nothing here is saved: like every
// activity, aiming is dropped on load (save/format.ts applySave), and src/bionicguns.ts ends it.

export interface BionicGunSession {
  /** Bionic id (bio_laser) and its fake gun (bio_laser_gun, detached). */
  id: string;
  gun: Item;
  bio: BionicState;
  /** kJ per shot: the bionic's act_cost (BN bp_cost_per_shot = power_activate). */
  cost: number;
}

const sessions = new WeakMap<Game, BionicGunSession>();

export function bionicGunSession(game: Game): BionicGunSession | null {
  return sessions.get(game) ?? null;
}

/**
 * Other guns the survivor can be shooting with instead of the wielded one: a manned vehicle
 * turret (src/turrets.ts). First non-null wins, after an aimed bionic gun.
 */
export const weaponProviders: ((game: Game) => Item | null)[] = [];

/** The gun the survivor is shooting with: an aimed bionic gun, a manned turret, else what's wielded. */
export function activeWeapon(game: Game): Item | null {
  const s = sessions.get(game);
  if (s) return s.gun;
  for (const f of weaponProviders) {
    const g = f(game);
    if (g) return g;
  }
  return game.player.inv.wielded;
}

/**
 * Start aiming a bionic's fake gun. Refuses (false) when the survivor is dead, lacks the bionic,
 * can't pay one shot (BN enough_power_for: power >= power_activate) or the item isn't a gun.
 */
export function beginBionicGun(game: Game, bio: BionicState, id: string, gun: Item, cost: number): boolean {
  if (game.player.dead || !bio.has(id) || !gun.isGun() || bio.power < cost) return false;
  sessions.set(game, { id, gun, bio, cost });
  return true;
}

/** End the session (cancel, lost bionic, death, out of power). Returns whether one was active. */
export function endBionicGun(game: Game, message?: string): boolean {
  if (!sessions.has(game)) return false;
  sessions.delete(game);
  if (message) game.message(message);
  return true;
}

/**
 * Why an active session must end now, or null; checked every frame by PlayerCombat. (Esc, the
 * menu key, cancels through src/bionicguns.ts, like Esc leaving BN's aiming UI.)
 */
export function bionicGunEndReason(game: Game, s: BionicGunSession): 'dead' | 'lost' | null {
  if (game.player.dead) return 'dead';
  if (!s.bio.has(s.id)) return 'lost';
  return null;
}

/** Can the next shot of the session's gun be paid for? */
export function canPayShot(s: BionicGunSession): boolean {
  return s.bio.has(s.id) && s.bio.power >= s.cost;
}

/** Charge one fired shot (BN mod_power_level(-bp_cost_per_shot), which clamps at 0). */
export function payShot(s: BionicGunSession): void {
  s.bio.modPower(-s.cost);
}

/** HUD text while a bionic gun is aimed: "laser finger (CBM)" and "10 kJ/shot · 9 shots". */
export function bionicGunHud(game: Game): { name: string; detail: string; shots: number } | null {
  const s = sessions.get(game);
  if (!s) return null;
  const shots = s.cost > 0 ? Math.floor(s.bio.power / s.cost) : Infinity;
  return {
    name: `${s.gun.name()} (CBM)`,
    detail: `${s.cost} kJ/shot${Number.isFinite(shots) ? ` · ${shots} shot${shots === 1 ? '' : 's'}` : ''}`,
    shots,
  };
}
