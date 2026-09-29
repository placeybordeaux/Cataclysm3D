// Live balance multipliers read by simulation code (monster.ts, character.ts, vehicles.ts …).
// This module has no imports on purpose: low-level files read it without pulling in the
// difficulty system (src/game/difficulty.ts), which owns the presets and writes these values.
//
// Every value defaults to 1 = the Bright Nights number (adapted for real time where the code
// says so), so unit tests and tools that never pick a difficulty see plain BN behaviour.

/** Per-survivor multipliers (Character.balance; only the player's gets a preset, NPCs stay at 1). */
export interface SurvivorBalance {
  /** Calories burned per 5 minutes (BN PLAYER_HUNGER_RATE). */
  hunger: number;
  /** Thirst per 5 minutes (BN PLAYER_THIRST_RATE). */
  thirst: number;
  /** Sleepiness per 5 minutes awake (BN PLAYER_FATIGUE_RATE). */
  fatigue: number;
  /** Natural regeneration and medicine (bandages, disinfectant) HP per day (BN PLAYER_HEALING_RATE). */
  healing: number;
  /** Chance per turn that a bleeding wound costs 1 HP (eff_fun_bleed's one_in(36 / intensity)). */
  bleed: number;
  /**
   * How much cold air, wind chill and wet clothes push body temperature down. 1 = BN; 0.7 means
   * a 5 °C night feels like BN's ~9 °C. Heat is untouched (summer isn't the newcomer's problem).
   */
  cold: number;
}

export const NEUTRAL_SURVIVOR: Readonly<SurvivorBalance> = Object.freeze({ hunger: 1, thirst: 1, fatigue: 1, healing: 1, bleed: 1, cold: 1 });

export interface WorldBalance {
  /** Monster movement speed (BN MONSTER_SPEED / 100, applied to walking only, not to attacks). */
  monsterSpeed: number;
  /** Damage the survivor takes from vehicle crashes and being run over. */
  crashDamage: number;
  /**
   * Monster hit points (BN MONSTER_RESILIENCE / 100). Read when a monster is created, so it
   * applies to monsters spawned afterwards (BN: "requires world reset").
   */
  monsterResilience: number;
}

/** The live world multipliers. Mutate through difficulty.ts (applyDifficulty), tests may poke fields. */
export const BALANCE: WorldBalance = { monsterSpeed: 1, crashDamage: 1, monsterResilience: 1 };
