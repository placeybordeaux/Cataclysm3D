import { BODY_PARTS, MAIN_PARTS, type BodyPartId, type MainPartId } from './bodyparts';
import type { Character } from './character';

// BN heal_actor (iuse_actor.cpp): bandages, gauze, disinfectant, first-aid kits used on
// yourself. Kept out of inventory.ts so the item model can change underneath it; Inventory.use
// hands `heal` use_actions here.

/** The heal_actor JSON fields (iuse_actor.cpp heal_actor::load). */
export interface HealActor {
  type?: string;
  move_cost?: number;
  limb_power?: number;
  head_power?: number;
  torso_power?: number;
  limb_scaling?: number;
  head_scaling?: number;
  torso_scaling?: number;
  bandages_power?: number;
  bandages_scaling?: number;
  disinfectant_power?: number;
  disinfectant_scaling?: number;
  bleed?: number;
  bite?: number;
  infect?: number;
  long_action?: boolean;
  effects?: { id: string; duration?: number; bp?: string; permanent?: boolean }[];
  [k: string]: unknown;
}

export interface HealResult {
  ok: boolean;
  /** Everything the treatment said, in order ("You stop the bleeding.  You use your bandages."). */
  msg: string;
  moves: number;
  part?: MainPartId;
}

/** heal_actor::load defaults, resolved. */
function powers(a: HealActor) {
  const limb = a.limb_power ?? 0;
  const bandages = a.bandages_power ?? 0;
  const disinfect = a.disinfectant_power ?? 0;
  const head = a.head_power ?? 0.8 * limb;
  const torso = a.torso_power ?? 1.5 * limb;
  const limbScaling = a.limb_scaling ?? 0.25 * limb;
  const ratio = limb < 0.0001 ? 0 : limbScaling / limb;
  return {
    limb, head, torso, limbScaling,
    headScaling: a.head_scaling ?? ratio * head,
    torsoScaling: a.torso_scaling ?? ratio * torso,
    bandages, bandagesScaling: a.bandages_scaling ?? 0.25 * bandages,
    disinfect, disinfectScaling: a.disinfectant_scaling ?? 0.25 * disinfect,
    bleed: a.bleed ?? 0, bite: a.bite ?? 0, infect: a.infect ?? 0,
  };
}

/** heal_actor::get_heal_value: power + scaling × first aid (truncated to int like BN). */
export function healValue(c: Character, a: HealActor, part: MainPartId): number {
  const p = powers(a);
  const [base, scale] = part === 'head' ? [p.head, p.headScaling] : part === 'torso' ? [p.torso, p.torsoScaling] : [p.limb, p.limbScaling];
  return base > 0 ? Math.trunc(base + scale * c.getSkill('firstaid')) : Math.trunc(base);
}

/**
 * heal_actor::use + finish_using for a survivor treating themselves. BN asks which part to
 * treat (use_healing_item's menu, defaulting to the most urgent); we pick that default: a
 * bleeding part first, then bitten/infected, then the most damaged one the item can help.
 * Bleeding stops with chance `bleed`, bites clean with `bite`, infections with `infect`;
 * bandages/disinfectant add their healing-over-time effect at power + scaling × first aid.
 */
export function applyHealActor(c: Character, itemName: string, a: HealActor, target?: BodyPartId): HealResult {
  const p = powers(a);
  const score = (bp: MainPartId) =>
    (p.bleed > 0 && c.effects.has('bleed', bp) ? 1000 : 0) +
    (p.bite > 0 && c.effects.has('bite', bp) ? 500 : 0) +
    (p.infect > 0 && c.effects.has('infected', bp) ? 500 : 0) +
    ((p.limb > 0 || p.bandages > 0 || p.disinfect > 0) ? c.hp[bp].max - c.hp[bp].cur : 0);
  const part: MainPartId = target ? BODY_PARTS[target].main : [...MAIN_PARTS].sort((x, y) => score(y) - score(x))[0];
  if (!target && score(part) <= 0) return { ok: false, msg: `You don't need to use your ${itemName} right now.`, moves: 0 };

  const msgs: string[] = [];
  let practice = p.limb * 3;
  const dam = healValue(c, a, part);
  // "Prevent first-aid from mending limbs": parts at 0 HP get no direct healing.
  if (c.hp[part].cur >= 1 && dam > 0) c.heal(part, dam);
  else if (c.hp[part].cur >= 1 && dam < 0) c.applyDamage(part, -dam);

  if (c.effects.has('bleed', part)) {
    if (c.rng.next() < p.bleed) {
      c.effects.remove('bleed', part);
      msgs.push('You stop the bleeding.');
    } else msgs.push('You fail to stop the bleeding.');
    practice += p.bleed * 3;
  }
  if (c.effects.has('bite', part)) {
    if (c.rng.next() < p.bite) {
      c.effects.remove('bite', part);
      msgs.push('You clean the wound.');
    } else msgs.push('Your wound still aches.');
    practice += p.bite * 3;
  }
  const infected = c.effects.get('infected', part);
  if (infected) {
    if (c.rng.next() < p.infect) {
      const dur = infected.duration;
      c.effects.remove('infected', part);
      c.addEffect('recover', dur);
      msgs.push('You disinfect the wound.');
    } else msgs.push('Your wound still hurts.');
    practice += p.infect * 10;
  }
  for (const e of a.effects ?? []) c.addEffect(e.id, e.duration ?? 0, { permanent: e.permanent });

  const skill = c.getSkill('firstaid');
  if (p.bandages > 0) {
    const level = Math.trunc(p.bandages + p.bandagesScaling * skill);
    const e = c.addEffect('bandaged', 1, { bp: part });
    e.setDuration(e.type.intDurFactor * level);
    practice += 3 * level;
  }
  if (p.disinfect > 0) {
    const level = Math.trunc(p.disinfect + p.disinfectScaling * skill);
    const e = c.addEffect('disinfected', 1, { bp: part });
    e.setDuration(e.type.intDurFactor * level);
    practice += 3 * level;
  }
  c.practice('firstaid', Math.trunc(Math.max(9, practice)));
  let moves = a.move_cost ?? 0;
  // long_action items (first-aid kits) take the whole treatment time, shortened by skill.
  if (a.long_action) moves = Math.trunc(moves / Math.min(10, skill + 1));
  msgs.push(`You use your ${itemName}.`);
  return { ok: true, msg: msgs.join('  '), moves, part };
}
