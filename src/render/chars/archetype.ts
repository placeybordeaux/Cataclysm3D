// Which procedural body a monster gets, and its proportions. Pure (no three.js), for tests.
//
// BN's `bodytype` (mtype.h: a free string, only compared in two places in the C++) is the
// best hint we have: human, quadruped, pig, insect, spider, blob, snake, fish, bear, bird,
// migo, crab, dog, horse, angel, gator, frog, "flying insect". ~120 monsters have none
// (robots, plants, fungi, nether things); for those species, flags (FLIES) and the CDDA
// symbol decide. Size comes from BN `volume` (ml; mtype volume is units::volume, loaded in
// monstergenerator.cpp with the "ml"/"L" string form our extractor normalises to ml).

export type Archetype = 'humanoid' | 'quadruped' | 'critter' | 'insect' | 'flyer' | 'blob' | 'serpent' | 'plant' | 'machine' | 'lump';

export const ARCHETYPES: readonly Archetype[] = ['humanoid', 'quadruped', 'critter', 'insect', 'flyer', 'blob', 'serpent', 'plant', 'machine', 'lump'];

export interface BodyShape {
  arch: Archetype;
  /** Overall scale: 1 = the archetype's reference body (a 1.75 m adult; a 30 L dog; ...). */
  scale: number;
  /** Width multiplier (fat/brute torsos, bears); 1 = normal. */
  girth: number;
  /** Leg length multiplier (deer vs pig). */
  legs: number;
  /** Head size multiplier (children, rats). */
  head: number;
  /** Humanoid undead hold their arms out and shamble. */
  zombie: boolean;
  /** Leg count for insects (6) / spiders and crabs (8). */
  legCount: number;
  /** Hovers above the floor (FLIES). */
  flies: boolean;
  /** Wings on the body (birds, bats, wasps, winged zombies). */
  wings: 'none' | 'feather' | 'membrane' | 'insect';
  /** Held weapon mesh (humanoids: NPCs and the survivor). */
  weapon?: Weapon;
  /**
   * A distinct plan within the archetype (docs/CHARACTERS.md round 6): insects 'ant' |
   * 'spider' | 'roach'; flyers 'wasp' | 'bee' | 'mosquito' | 'fly' | 'dragonfly' | 'bird' |
   * 'bat'; humanoids a feature: 'bloated' | 'hulk' | 'skeletal' | 'acid' | 'shocker' | 'charred'.
   */
  variant?: string;
  /** humanoids: hair style / headgear piece (NPC variety) */
  hair?: 'none' | 'short' | 'long' | 'ponytail' | 'cap' | 'hat' | 'helmet';
}

export type Weapon = 'none' | 'pistol' | 'rifle' | 'long' | 'short';

export interface MonsterLike {
  id: string;
  bodytype?: string;
  species?: string[];
  flags?: string[];
  symbol?: string;
  /** ml */
  volume?: number;
}

/** Reference volumes (ml) the archetype meshes are built at. */
const REF_VOLUME: Record<Archetype, number> = {
  humanoid: 62500, quadruped: 30000, critter: 1500, insect: 30000, flyer: 750, blob: 62500,
  serpent: 30000, plant: 62500, machine: 62500, lump: 62500,
};
/** Clamp so a hulk (875 L) is a looming 2.6 m brute, not a 4 m tower, and a fly is visible. */
const SCALE_RANGE: Record<Archetype, [number, number]> = {
  humanoid: [0.7, 1.5], quadruped: [0.55, 2.0], critter: [0.6, 2.2], insect: [0.25, 2.2], flyer: [0.6, 4.0],
  blob: [0.4, 2.2], serpent: [0.5, 2.5], plant: [0.4, 2.5], machine: [0.6, 2.4], lump: [0.4, 2.5],
};

export function archetypeOf(m: MonsterLike): Archetype {
  const species = m.species ?? [];
  const flags = m.flags ?? [];
  const bt = m.bodytype ?? '';
  const sym = m.symbol ?? '';
  const flies = flags.includes('FLIES');
  if (species.includes('ROBOT') || species.includes('ROBOT_FLYING')) return flies ? 'flyer' : 'machine';
  switch (bt) {
    case 'human': case 'angel': case 'migo':
      return 'humanoid';
    case 'quadruped': case 'dog': case 'pig': case 'bear': case 'horse': case 'gator':
      return (m.volume ?? REF_VOLUME.quadruped) < 6000 ? 'critter' : 'quadruped';
    case 'frog':
      return 'critter';
    case 'insect': case 'spider': case 'crab':
      return 'insect';
    case 'flying insect': case 'bird':
      return 'flyer';
    case 'blob':
      return 'blob';
    case 'snake': case 'fish':
      return 'serpent';
  }
  if (species.includes('PLANT') || species.includes('FUNGUS') || species.includes('LEECH_PLANT')) return 'plant';
  if (flies && (m.volume ?? 0) < 30000) return 'flyer';
  if (species.includes('INSECT') || species.includes('SPIDER')) return 'insect';
  if (species.includes('MOLLUSK') || species.includes('BLOB')) return 'blob';
  if (species.includes('MAMMAL')) return (m.volume ?? 30000) < 6000 ? 'critter' : 'quadruped';
  if (species.includes('HUMAN') || /[ZH@M]/.test(sym)) return 'humanoid';
  return 'lump';
}

/** Body shape for a monster: archetype + proportions from BN volume and id hints. */
export function bodyShapeOf(m: MonsterLike): BodyShape {
  const arch = archetypeOf(m);
  const id = m.id;
  const vol = Math.max(1, m.volume ?? REF_VOLUME[arch]);
  const [lo, hi] = SCALE_RANGE[arch];
  let scale = Math.min(hi, Math.max(lo, Math.cbrt(vol / REF_VOLUME[arch])));
  let girth = 1, legs = 1, head = 1;
  const species = m.species ?? [];
  const flags = m.flags ?? [];
  const zombie = arch === 'humanoid' && (species.includes('ZOMBIE') || flags.includes('STUMBLES')) && !/skeleton|runner|predator|hunter|shady|nemesis/.test(id);
  if (arch === 'humanoid') {
    // BN gives most zombie kinds the plain human 62.5 L; the name carries the build.
    if (/hulk|giant|colossus|abomination/.test(id)) (girth = 1.5, scale = Math.max(scale, 1.45));
    else if (/brute|tough|bull|grappler|shoggoth|juggernaut|master_grappler/.test(id)) (girth = 1.35, scale = Math.max(scale, 1.1));
    else if (/fat|bloat|gasbag|swollen|boomer/.test(id)) girth = 1.45;
    else if (/child|kid|homunculus|imp/.test(id) || vol <= 32000) (head = 1.3, scale = Math.min(scale, 0.8));
    else if (/skeleton|thin|runner|withered|shriveled/.test(id)) girth = 0.85;
    if (/soldier|swat|armored|bio_op|kevlar|riot/.test(id)) girth = Math.max(girth, 1.12);
  } else if (arch === 'quadruped') {
    if (m.bodytype === 'bear' || /bear|boar|bull|cow|bison|moose/.test(id)) (girth = 1.4, legs = 0.85);
    if (m.bodytype === 'horse' || /deer|horse|moose|elk|reindeer|mule|donkey/.test(id)) (legs = 1.5, girth = Math.min(girth, 1.05));
    if (m.bodytype === 'pig' || /pig|hog|boar|badger|wolverine/.test(id)) legs = Math.min(legs, 0.7);
    if (m.bodytype === 'gator' || /gator|croc|lizard/.test(id)) (legs = 0.45, girth = 1.2);
  } else if (arch === 'critter') {
    head = 1.25;
    if (/rabbit|hare/.test(id)) legs = 1.2;
  }
  let legCount = 0;
  if (arch === 'insect') legCount = m.bodytype === 'spider' || m.bodytype === 'crab' || species.includes('SPIDER') ? 8 : 6;
  if (arch === 'insect' && m.bodytype === 'crab') girth = 1.4;
  const fliesFlag = flags.includes('FLIES');
  let wings: BodyShape['wings'] = 'none';
  if (arch === 'flyer') wings = species.includes('INSECT') || m.bodytype === 'flying insect' ? 'insect' : /bat/.test(id) ? 'membrane' : species.includes('ROBOT_FLYING') ? 'none' : 'feather';
  else if (fliesFlag && arch === 'humanoid') wings = 'membrane';
  let variant = '';
  if (arch === 'insect') variant = /(^|_)ant(_|$)/.test(id) ? 'ant' : legCount === 8 ? 'spider' : 'roach';
  else if (arch === 'flyer') {
    variant = /wasp|hornet|yellowjacket/.test(id) ? 'wasp' : /(^|_)bee(_|$)|bumble/.test(id) ? 'bee' : /mosquito/.test(id) ? 'mosquito'
      : /dragonfly/.test(id) ? 'dragonfly' : /(^|_)fly(_|$)/.test(id) ? 'fly' : /(^|_)bat(_|$)|vampire/.test(id) ? 'bat' : wings === 'feather' ? 'bird' : '';
  } else if (arch === 'humanoid') {
    variant = /boomer|bloat|gasbag|gas_zombie|swollen/.test(id) ? 'bloated' : /hulk|colossus/.test(id) ? 'hulk'
      : /skeleton|skeletal|withered|shriveled/.test(id) ? 'skeletal' : /acid|spitter|corrosive/.test(id) ? 'acid'
      : /shock|electric|static/.test(id) ? 'shocker' : /scorched|charred|burnt/.test(id) ? 'charred' : '';
  }
  return { arch, scale, girth, legs, head, zombie, legCount, flies: fliesFlag, wings, variant };
}

/**
 * Which weapon mesh a person holds, from the wielded item: guns by skill (long guns vs
 * handguns), anything else by volume (ml): a bat or spear is long, a knife short.
 */
export function weaponOf(item: { isGun(): boolean; def: { skill?: string; volume?: number } } | null | undefined): Weapon {
  if (!item) return 'none';
  if (item.isGun()) return /rifle|shotgun|smg|launcher/.test(item.def.skill ?? '') || (item.def.volume ?? 0) > 1500 ? 'rifle' : 'pistol';
  return (item.def.volume ?? 0) >= 1250 ? 'long' : 'short';
}
