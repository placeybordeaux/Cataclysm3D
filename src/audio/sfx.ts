import type { AudioEngine, PlayOptions, Voice } from './audio';
import type { Vec3 } from './spatial';
import { rangeForLoudness } from './spatial';

// Typed helpers other systems call directly (combat, doors, monsters, UI). Each one maps a
// game fact to CDDA's sound_effect id/variant with the same selection rules CDDA uses in
// sounds.cpp, so any CDDA soundpack's JSON drops in. All are no-ops until installAudio()
// has set the engine, so game logic and unit tests never need to care about audio.
//
//   import { sfx } from '../audio/sfx';
//   sfx.meleeHit('flesh', target, { skill: 'bashing', volumeMl: 1500 });
//   sfx.gunshot('glock_19', shooter, { listenerDist: 30 });
//
// When you both call sfx.* and emit a `sound` event for AI hearing, pass `sfxId: ''` on the
// event so the keyword mapper (soundEvents.ts) doesn't play a second sound.

let engine: AudioEngine | null = null;

export function setAudioEngine(e: AudioEngine | null): void {
  engine = e;
}
export function getAudioEngine(): AudioEngine | null {
  return engine;
}

function play(id: string, variant: string, opts: PlayOptions = {}): Voice | null {
  return engine ? engine.play(id, variant, opts) : null;
}
function has(id: string, variant: string): boolean {
  return engine ? engine.has(id, variant, true) : false;
}

export type MeleeSkill = 'bashing' | 'cutting' | 'stabbing' | 'unarmed' | 'other';

export interface WeaponSound {
  /** item id, e.g. "bat"; used if the pack has a weapon-specific variant */
  id?: string;
  skill?: MeleeSkill;
  /** weapon volume in ml (CDDA picks "big_*" variants above a size threshold) */
  volumeMl?: number;
}

/** CDDA sound_thread: skill + weapon volume (in 250 ml units) -> generic variant. */
export function meleeSkillVariant(w: WeaponSound = {}): string {
  const units = (w.volumeMl ?? 0) / 250;
  switch (w.skill) {
    case 'bashing': return units > 8 ? 'big_bash' : 'small_bash';
    case 'cutting': return units > 6 ? 'big_cutting' : 'small_cutting';
    case 'stabbing': return units > 4 ? 'big_stabbing' : 'small_stabbing';
    case 'unarmed': case undefined: return 'unarmed';
    default: return 'default';
  }
}

/** Weapon-specific variant if the pack has it exactly, else the skill variant (CDDA order). */
function weaponVariant(id: string, w: WeaponSound): string {
  return w.id && has(id, w.id) ? w.id : meleeSkillVariant(w);
}

/** Lower a voice's pitch (heavier variants of a synth sound); 1 leaves it alone. */
function slowed(v: Voice | null, rate: number): Voice | null {
  if (v && rate !== 1) v.setRate(rate, 0);
  return v;
}

/** Tiles past which CDDA switches to "_distant" gun variants. */
export const GUN_DISTANT_TILES = 17;

export const sfx = {
  meleeSwing(pos?: Vec3, weapon: WeaponSound = {}): Voice | null {
    return play('melee_swing', weaponVariant('melee_swing', weapon), { pos, pitchJitter: 0.2 });
  },

  /**
   * A melee blow landing. CDDA: target made of steel -> melee_hit_metal, else
   * melee_hit_flesh; variant is the weapon id or skill-size bucket.
   */
  meleeHit(material: string, pos?: Vec3, weapon: WeaponSound = {}): Voice | null {
    const id = material === 'steel' || material === 'iron' || material === 'metal' ? 'melee_hit_metal' : 'melee_hit_flesh';
    return play(id, weaponVariant(id, weapon), { pos, pitchJitter: 0.2 });
  },

  /** Your swing cutting through nothing (the feel layer's clear miss, on the contact frame). */
  meleeWhiff(heavy = false): Voice | null {
    return slowed(play('synth_whoosh', 'default', { pitchJitter: 0.12, volume: heavy ? 0.9 : 0.7 }), heavy ? 0.8 : 1);
  },
  /** A monster drawing back to strike (combatfeel.ts telegraph); heavy = hulk-sized blow. */
  monsterWindup(pos: Vec3, heavy = false): Voice | null {
    return slowed(play('synth_windup', 'default', { pos, pitchJitter: 0.12, range: 20 }), heavy ? 0.7 : 1);
  },
  /** A monster's telegraphed blow landing on air (you stepped out of reach, or it missed). */
  monsterWhiff(pos: Vec3): Voice | null {
    return slowed(play('synth_whoosh', 'default', { pos, pitchJitter: 0.15, volume: 0.8 }), 0.85);
  },
  /** Guard raised just in time. */
  parry(pos?: Vec3): Voice | null {
    return play('synth_parry', 'default', { pos, pitchJitter: 0.08 });
  },
  /** A dying monster's body hitting the ground. */
  bodyFall(pos: Vec3, heavy = false): Voice | null {
    return slowed(play('synth_bodyfall', 'default', { pos, pitchJitter: 0.1, range: 25 }), heavy ? 0.8 : 1);
  },

  /** A monster's melee attack connecting with the player. */
  monsterHit(pos?: Vec3): Voice | null {
    return play('melee_attack', 'monster_melee_hit', { pos, pitchJitter: 0.15 });
  },
  monsterBite(hit: boolean, pos?: Vec3): Voice | null {
    return play('mon_bite', hit ? 'bite_hit' : 'bite_miss', { pos, pitchJitter: 0.15 });
  },

  /**
   * Gunfire, CDDA generate_gun_sound order: fire_gun[_suffix]/<gun id> ->
   * fire_ammo[_suffix]/<ammo type> -> fire_gun[_suffix]/default -> fire_gun/default.
   * Suffix is "_suppressed" for the player's suppressed guns, "_distant" beyond 17 tiles.
   * Deviation: a pack without any "_distant" sounds (CC-Sounds) keeps the gun's own sound
   * at distance (air absorption in the engine already makes it read as far).
   */
  gunshot(gunId: string, pos?: Vec3, opts: { ammoType?: string; suppressed?: boolean; listenerDist?: number; loudness?: number } = {}): Voice | null {
    let suffix = '';
    if (opts.suppressed) suffix = '_suppressed';
    else if ((opts.listenerDist ?? 0) > GUN_DISTANT_TILES && engine?.soundset.hasId('fire_gun_distant')) suffix = '_distant';
    const po: PlayOptions = { pos, pitchJitter: 0.05, range: rangeForLoudness(opts.loudness ?? 80), minGain: pos ? 0.3 : 0 };
    const tries: [string, string][] = [[`fire_gun${suffix}`, gunId]];
    if (opts.ammoType) tries.push([`fire_ammo${suffix}`, opts.ammoType]);
    tries.push([`fire_gun${suffix}`, 'default']);
    for (const [id, v] of tries) if (has(id, v)) return play(id, v, po);
    return play('fire_gun', 'default', po);
  },
  gunEmpty(pos?: Vec3): Voice | null {
    return play('fire_gun', 'empty', { pos });
  },
  brassEject(pos?: Vec3): Voice | null {
    return play('fire_gun', 'brass_eject', { pos, pitchJitter: 0.1, volume: 0.6 });
  },
  reload(gunId: string, pos?: Vec3): Voice | null {
    return play('reload', gunId, { pos });
  },
  bulletHit(what: 'flesh' | 'wall' | 'metal', pos: Vec3): Voice | null {
    return play('bullet_hit', `hit_${what}`, { pos, pitchJitter: 0.15 });
  },

  /**
   * Doors/windows/gates. CDDA uses the terrain/furniture id *before* the change as the
   * variant (open_door/t_door_c, close_door/t_door_o). Unknown ids fall back to a wooden
   * door (pack has no "default" for these).
   */
  door(action: 'open' | 'close', pos?: Vec3, terFurnId?: string): Voice | null {
    const id = action === 'open' ? 'open_door' : 'close_door';
    const variant = terFurnId && has(id, terFurnId) ? terFurnId : action === 'open' ? 't_door_c' : 't_door_o';
    return play(id, variant, { pos, pitchJitter: 0.08 });
  },
  doorLocked(pos?: Vec3): Voice | null {
    return play('synth_door_locked', 'default', { pos });
  },

  /**
   * Bashing terrain/furniture (map.cpp bash): smash_success/<id> when it breaks,
   * smash_fail/<id> otherwise, synthesized crunch/thud when the pack lacks the id.
   */
  smash(pos: Vec3, opts: { success?: boolean; targetId?: string; glass?: boolean } = {}): Voice | null {
    if (opts.glass) return play('smash', 'glass', { pos, pitchJitter: 0.1 });
    const id = opts.success === false ? 'smash_fail' : 'smash_success';
    return play(id, opts.targetId ?? 'default', { pos, pitchJitter: 0.1 });
  },

  /** CDDA plays mon_death/zombie_death for every monster (mondeath.cpp), gibbed separately. */
  monsterDeath(_monId: string, pos: Vec3, gibbed = false): Voice | null {
    return gibbed ? play('mon_gibbed', 'zombie_gibbed', { pos, pitchJitter: 0.1 }) : play('mon_death', 'zombie_death', { pos, pitchJitter: 0.1 });
  },

  /** Zombie vocalisation: speech/<mon id>, else the generic mon_zombie groans. */
  zombieGroan(pos: Vec3, monId = 'mon_zombie'): Voice | null {
    const v = has('speech', monId) ? monId : 'mon_zombie';
    return play('speech', v, { pos, pitchJitter: 0.12, range: 30 });
  },
  /** Any monster's idle voice: speech/<mon id> if the pack has it, else a synthesized growl. */
  monsterVoice(monId: string, pos: Vec3): Voice | null {
    if (has('speech', monId)) return play('speech', monId, { pos, pitchJitter: 0.12, range: 30 });
    if (/zombie|zom_|mon_z/.test(monId)) return sfx.zombieGroan(pos);
    return play('synth_growl', 'default', { pos, pitchJitter: 0.2, range: 30 });
  },
  monsterStep(pos: Vec3): Voice | null {
    return play('synth_monster_step', 'default', { pos, pitchJitter: 0.25, range: 14 });
  },

  playerHurt(female = false): Voice | null {
    return play('deal_damage', female ? 'hurt_f' : 'hurt_m', { pitchJitter: 0.05 });
  },
  playerDeath(female = false): Voice | null {
    return play('clean_up_at_end', female ? 'death_f' : 'death_m');
  },
  heartbeat(volume = 1): Voice | null {
    return play('synth_heartbeat', 'default', { volume, bus: 'ui' });
  },

  explosion(pos: Vec3, size: 'small' | 'default' | 'huge' = 'default'): Voice | null {
    return play('explosion', size, { pos, range: size === 'huge' ? 200 : size === 'small' ? 60 : 120, minGain: 0.25 });
  },
  fireIgnite(pos?: Vec3): Voice | null {
    return play('fire', 'ignition', { pos });
  },
  /** Crackling loop for a fire field; keep the Voice and stop() it when the fire dies. */
  fireLoop(pos: Vec3, intensity = 1): Voice | null {
    return play('synth_fire', 'default', { pos, loop: true, volume: 0.4 + 0.3 * intensity, range: 16, fadeIn: 1 });
  },
  tool(toolId: string, pos?: Vec3): Voice | null {
    return play('tool', toolId, { pos, pitchJitter: 0.05 });
  },
  /** Player footstep with a CDDA plmove variant (see footsteps.ts). */
  footstep(variant: string, volume = 1): Voice | null {
    return play('plmove', variant, { volume, pitchJitter: 0.1 });
  },

  ui(kind: 'menu_move' | 'menu_error' | 'menu_select' | 'menu_open' | 'menu_close'): Voice | null {
    return play(kind, 'default', { bus: 'ui' });
  },
};
