// BN npc_follower_rules (npc.h / npc.cpp): the orders a survivor gives an ally through the
// dialogue menus (TALK_COMBAT_COMMANDS, TALK_MISC_RULES, TALK_AIM_RULES, TALK_CBM_*_RULES).
// Dialogue reads and writes them through npc_rule / npc_override / npc_*_rule conditions and
// the toggle/set/clear_npc_rule, set_npc_*_rule, copy_npc_rules and clear_overrides effects.
//
// The NPC AI (npcai.ts, with BN's arithmetic in npctactics.ts) acts on every rule except the
// ones in STORED_ONLY, which need a system the port lacks; setting one of those warns once
// naming what is missing, so the gap stays visible.

import { warnOnce } from '../data/warn';

/** BN ally_rule flags (npc.h ally_rule_strs keys). */
export const ALLY_RULES = [
  'use_guns', 'use_grenades', 'use_silent', 'avoid_friendly_fire', 'allow_pick_up', 'allow_bash', 'allow_sleep',
  'allow_complain', 'allow_pulp', 'close_doors', 'follow_close', 'avoid_doors', 'hold_the_line', 'ignore_noise',
  'forbid_engage', 'follow_distance_2', 'move_own_pace',
] as const;
export type AllyRule = (typeof ALLY_RULES)[number];

/** combat_engagement_strs */
export const ENGAGEMENT_RULES = ['ENGAGE_NONE', 'ENGAGE_CLOSE', 'ENGAGE_WEAK', 'ENGAGE_HIT', 'ENGAGE_ALL', 'ENGAGE_FREE_FIRE', 'ENGAGE_NO_MOVE'] as const;
/** aim_rule_strs */
export const AIM_RULES = ['AIM_WHEN_CONVENIENT', 'AIM_SPRAY', 'AIM_PRECISE', 'AIM_STRICTLY_PRECISE'] as const;
/** cbm_recharge_strs (percent of power left before recharging) */
export const CBM_RECHARGE_RULES = ['CBM_RECHARGE_ALL', 'CBM_RECHARGE_MOST', 'CBM_RECHARGE_SOME', 'CBM_RECHARGE_LITTLE', 'CBM_RECHARGE_NONE'] as const;
/** cbm_reserve_strs (percent of power kept for defense) */
export const CBM_RESERVE_RULES = ['CBM_RESERVE_ALL', 'CBM_RESERVE_MOST', 'CBM_RESERVE_SOME', 'CBM_RESERVE_LITTLE', 'CBM_RESERVE_NONE'] as const;

/**
 * Rules (and rule fields) the NPC AI can't act on, with what is missing. Everything else in
 * ALLY_RULES plus `engagement` and `aim` changes behaviour (npcai.ts). avoid_friendly_fire is
 * honoured the way BN honours it: BN's AI never reads the flag, npc::wont_hit_friend holds
 * every NPC's fire whatever it says, and so does the port's.
 */
export const STORED_ONLY: Readonly<Record<string, string>> = {
  allow_pick_up: 'NPCs never fetch items in this port (BN npc::find_item / pick_up_item and the npc::value item valuation are not ported)',
  cbmReserve: 'NPCs have no bionics or bionic power in this port (bodymods are attached to the survivor only, src/mutbio.ts), so BN npc::can_use_offensive_cbm has nothing to gate',
  cbmRecharge: 'NPCs have no bionics or bionic power in this port (bodymods are attached to the survivor only, src/mutbio.ts), so BN npc::wants_to_recharge_cbm has nothing to recharge',
};
/** Rules the NPC AI acts on (npcai.ts). */
export const AI_HONORED = new Set<string>([...ALLY_RULES, 'engagement', 'aim'].filter((r) => !(r in STORED_ONLY)));

/** npc.h cbm_reserve_rule enum values (percent of max power). */
export const CBM_RESERVE_PERCENT: Readonly<Record<string, number>> = { CBM_RESERVE_ALL: 100, CBM_RESERVE_MOST: 75, CBM_RESERVE_SOME: 50, CBM_RESERVE_LITTLE: 25, CBM_RESERVE_NONE: 0 };
/** npc.h cbm_recharge_rule enum values (percent of max power). */
export const CBM_RECHARGE_PERCENT: Readonly<Record<string, number>> = { CBM_RECHARGE_ALL: 90, CBM_RECHARGE_MOST: 75, CBM_RECHARGE_SOME: 50, CBM_RECHARGE_LITTLE: 25, CBM_RECHARGE_NONE: 10 };

export interface NpcRulesJSON {
  engagement: string;
  aim: string;
  cbmRecharge: string;
  cbmReserve: string;
  flags: string[];
  overrideEnable: string[];
  overrides: string[];
}

export const isAllyRule = (s: string): s is AllyRule => (ALLY_RULES as readonly string[]).includes(s);

export class NpcRules {
  engagement: string = 'ENGAGE_CLOSE';
  aim: string = 'AIM_WHEN_CONVENIENT';
  cbmRecharge: string = 'CBM_RECHARGE_SOME';
  cbmReserve: string = 'CBM_RESERVE_SOME';
  readonly flags = new Set<AllyRule>();
  readonly overrideEnable = new Set<AllyRule>();
  readonly overrides = new Set<AllyRule>();

  /** npc_follower_rules::npc_follower_rules defaults. */
  constructor() {
    for (const r of ['use_guns', 'use_grenades', 'avoid_friendly_fire', 'allow_complain', 'allow_pulp', 'follow_distance_2'] as const) this.flags.add(r);
  }

  /**
   * npc::can_use_offensive_cbm: power above the reserve (cbm_reserve_rule values are the percent
   * of max power kept back: ALL 100, MOST 75, SOME 50, LITTLE 25, NONE 0).
   */
  canUseOffensiveCbm(power: number, maxPower: number): boolean {
    return power > maxPower * (CBM_RESERVE_PERCENT[this.cbmReserve] ?? 50) / 100;
  }
  /**
   * npc::wants_to_recharge_cbm: power below the recharge threshold (cbm_recharge_rule values:
   * ALL 90, MOST 75, SOME 50, LITTLE 25, NONE 10 percent) and a fuelled bionic is off (or the
   * NPC has no fuelled bionic at all).
   */
  wantsToRechargeCbm(power: number, maxPower: number, fueledBionicsOff: boolean): boolean {
    return power < maxPower * (CBM_RECHARGE_PERCENT[this.cbmRecharge] ?? 50) / 100 && fueledBionicsOff;
  }

  /** has_flag: an enabled override wins over the flag itself. */
  hasFlag(r: AllyRule, checkOverride = true): boolean {
    if (checkOverride && this.overrideEnable.has(r)) return this.overrides.has(r);
    return this.flags.has(r);
  }
  setFlag(r: AllyRule): void {
    this.flags.add(r);
    noteStoredOnly(r);
  }
  clearFlag(r: AllyRule): void {
    this.flags.delete(r);
    noteStoredOnly(r);
  }
  /** toggle_flag uses has_flag (overrides included), like BN. */
  toggleFlag(r: AllyRule): void {
    if (this.hasFlag(r)) this.clearFlag(r);
    else this.setFlag(r);
  }
  hasOverrideEnable(r: AllyRule): boolean {
    return this.overrideEnable.has(r);
  }
  clearOverrides(): void {
    this.overrides.clear();
    this.overrideEnable.clear();
  }
  copyFrom(o: NpcRules): void {
    this.load(o.toJSON());
  }

  toJSON(): NpcRulesJSON {
    return {
      engagement: this.engagement, aim: this.aim, cbmRecharge: this.cbmRecharge, cbmReserve: this.cbmReserve,
      flags: [...this.flags], overrideEnable: [...this.overrideEnable], overrides: [...this.overrides],
    };
  }
  load(j: NpcRulesJSON): void {
    Object.assign(this, { engagement: j.engagement, aim: j.aim, cbmRecharge: j.cbmRecharge, cbmReserve: j.cbmReserve });
    for (const [set, list] of [[this.flags, j.flags], [this.overrideEnable, j.overrideEnable], [this.overrides, j.overrides]] as const) {
      set.clear();
      for (const r of list) {
        if (!isAllyRule(r)) throw new Error(`npc rules: unknown ally rule "${r}" in save`);
        set.add(r);
      }
    }
  }
}

/** Warn once when a rule the AI can't act on is set (STORED_ONLY names what is missing). */
export function noteStoredOnly(r: string): void {
  const why = STORED_ONLY[r];
  if (why) warnOnce('npc_rule_ai', r, `[npc rules] "${r}" is remembered (dialogue shows it) but the NPC AI can't act on it: ${why}`);
}
