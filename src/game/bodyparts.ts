// Human anatomy, transcribed from CDDA data/json/body_parts.json. Hard-coded rather than
// loaded because every system (HP bars, armor, targeting) needs these exact ids and the
// numbers are stable across CDDA versions; mods with extra limbs are out of scope.

export type MainPartId = 'head' | 'torso' | 'arm_l' | 'arm_r' | 'leg_l' | 'leg_r';
export type BodyPartId = MainPartId | 'eyes' | 'mouth' | 'hand_l' | 'hand_r' | 'foot_l' | 'foot_r';

export interface BodyPartType {
  id: BodyPartId;
  name: string;
  /** Sidebar label ("hp_bar_ui_text"). */
  heading: string;
  /** Minor parts (hands, eyes...) take damage on their main part, like CDDA apply_damage. */
  main: MainPartId;
  base_hp: number;
  hit_size: number;
  hit_difficulty: number;
  drench_capacity: number;
  /** LIMB_UPPER parts can't be hit by short attackers; LIMB_LOWER weight x3 for them. */
  upper?: boolean;
  lower?: boolean;
  /** Encumbrance above this starts to matter (CDDA encumbrance_threshold). */
  encumbrance_threshold: number;
  opposite?: BodyPartId;
}

const bp = (p: BodyPartType) => p;

export const BODY_PARTS: Record<BodyPartId, BodyPartType> = {
  torso: bp({ id: 'torso', name: 'torso', heading: 'TORSO', main: 'torso', base_hp: 60, hit_size: 36, hit_difficulty: 1, drench_capacity: 4000, encumbrance_threshold: 6 }),
  head: bp({ id: 'head', name: 'head', heading: 'HEAD', main: 'head', base_hp: 60, hit_size: 4, hit_difficulty: 1.2, drench_capacity: 700, upper: true, encumbrance_threshold: 10 }),
  eyes: bp({ id: 'eyes', name: 'eyes', heading: 'EYES', main: 'head', base_hp: 60, hit_size: 0.5, hit_difficulty: 1.15, drench_capacity: 100, upper: true, encumbrance_threshold: 0 }),
  mouth: bp({ id: 'mouth', name: 'mouth', heading: 'MOUTH', main: 'head', base_hp: 60, hit_size: 0.5, hit_difficulty: 1.15, drench_capacity: 100, upper: true, encumbrance_threshold: 0 }),
  arm_l: bp({ id: 'arm_l', name: 'left arm', heading: 'L ARM', main: 'arm_l', base_hp: 60, hit_size: 13, hit_difficulty: 0.95, drench_capacity: 1000, encumbrance_threshold: 5, opposite: 'arm_r' }),
  arm_r: bp({ id: 'arm_r', name: 'right arm', heading: 'R ARM', main: 'arm_r', base_hp: 60, hit_size: 13, hit_difficulty: 0.95, drench_capacity: 1000, encumbrance_threshold: 5, opposite: 'arm_l' }),
  hand_l: bp({ id: 'hand_l', name: 'left hand', heading: 'L HAND', main: 'arm_l', base_hp: 60, hit_size: 1.5, hit_difficulty: 1.1, drench_capacity: 300, encumbrance_threshold: 0, opposite: 'hand_r' }),
  hand_r: bp({ id: 'hand_r', name: 'right hand', heading: 'R HAND', main: 'arm_r', base_hp: 60, hit_size: 1.5, hit_difficulty: 1.1, drench_capacity: 300, encumbrance_threshold: 0, opposite: 'hand_l' }),
  leg_l: bp({ id: 'leg_l', name: 'left leg', heading: 'L LEG', main: 'leg_l', base_hp: 60, hit_size: 13, hit_difficulty: 0.9, drench_capacity: 1100, lower: true, encumbrance_threshold: 6, opposite: 'leg_r' }),
  leg_r: bp({ id: 'leg_r', name: 'right leg', heading: 'R LEG', main: 'leg_r', base_hp: 60, hit_size: 13, hit_difficulty: 0.9, drench_capacity: 1100, lower: true, encumbrance_threshold: 6, opposite: 'leg_l' }),
  foot_l: bp({ id: 'foot_l', name: 'left foot', heading: 'L FOOT', main: 'leg_l', base_hp: 60, hit_size: 2, hit_difficulty: 0.8, drench_capacity: 300, lower: true, encumbrance_threshold: 5, opposite: 'foot_r' }),
  foot_r: bp({ id: 'foot_r', name: 'right foot', heading: 'R FOOT', main: 'leg_r', base_hp: 60, hit_size: 2, hit_difficulty: 0.8, drench_capacity: 300, lower: true, encumbrance_threshold: 5, opposite: 'foot_l' }),
};

/** Display order used by CDDA's sidebar. */
export const MAIN_PARTS: MainPartId[] = ['head', 'torso', 'arm_l', 'arm_r', 'leg_l', 'leg_r'];
export const ALL_PARTS: BodyPartId[] = ['head', 'eyes', 'mouth', 'torso', 'arm_l', 'arm_r', 'hand_l', 'hand_r', 'leg_l', 'leg_r', 'foot_l', 'foot_r'];

export function isBodyPart(id: string): id is BodyPartId {
  return id in BODY_PARTS;
}

export function isLimb(id: MainPartId): boolean {
  return id !== 'head' && id !== 'torso';
}
