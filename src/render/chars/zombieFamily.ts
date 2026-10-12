// Which zombie a monster is, for the 3D zombie bodies (zombie.ts, zombieSkin.ts). Pure, for
// tests. This file is the one place the mapping lives: BN monster data in, a look out.
//
// The UltiCa sprites give every kind of special zombie its own silhouette (a boomer is a ball
// of belly, a hulk is fists and forearms, a shrieker crouches with its maw open, a necromancer
// is jet black with tendrils); the 3D bodies follow them. Families are read from BN data first
// (special attacks, flags, species, volume) and the id second, so variants and mod monsters
// nobody listed still land in a sensible family: anything with ACID_BLOOD gets acid sacs,
// anything ELECTRIC crackles, anything with SMASH is built like a brute, anything over 500 L
// is a hulk.
//
// A look is three independent things:
//   build   body proportions + resting posture (BUILDS in zombie.ts)
//   fx      features that stack on any build: acid sacs, arcs, smoke, tendrils, thorns...
//   gear    what the body still wears that changes its outline: helmets, visors, vests
// plus `bone` (SKELETON species: a skeleton brute is a brute made of bone) and `undead`.

export type ZFamily =
  | 'walker' | 'fat' | 'boomer' | 'brute' | 'hulk' | 'shrieker' | 'acid' | 'electric' | 'smoker'
  | 'necro' | 'skeleton' | 'thorny' | 'child' | 'runner' | 'grabber' | 'scorched' | 'feral';

export type ZBuild = 'walker' | 'fat' | 'bloated' | 'brute' | 'hulk' | 'gaunt' | 'runner' | 'child' | 'necro' | 'grabber';

export type ZFx = 'acid' | 'arcs' | 'smoke' | 'tendrils' | 'redEyes' | 'thorns' | 'maw' | 'charred';

export type ZGear =
  | 'none' | 'cop' | 'swat' | 'soldier' | 'hazmat' | 'fireman' | 'bioop' | 'survivor' | 'armored'
  | 'miner' | 'beekeeper' | 'scientist' | 'medic';

export interface ZombieLook {
  family: ZFamily;
  build: ZBuild;
  fx: ZFx[];
  gear: ZGear;
  /** 0..1: how far the family's signature goes (zombie_tough 0.5 < brute 1; acidic < corrosive) */
  degree: number;
  /** made of bone (BN species SKELETON) */
  bone: boolean;
  /** zombie skin and gore (species ZOMBIE); feral humans are alive */
  undead: boolean;
}

/** What the mapping reads from a BN monster (MonsterDef has all of it). */
export interface ZombieSource {
  id: string;
  species?: string[];
  flags?: string[];
  /** special attack ids (BN `special_attacks[].id ?? type`) */
  attacks?: string[];
  /** ml */
  volume?: number;
  /** BN emit_fields ids (`emit_smoke_stream`, ...) */
  emits?: string[];
}

interface Ctx {
  id: string;
  sp: (s: string) => boolean;
  fl: (f: string) => boolean;
  att: (...a: string[]) => boolean;
  vol: number;
  emitsSmoke: boolean;
}

/**
 * The family table, first match wins. `degree` defaults to 1. Order matters: a skeleton brute
 * is a brute (bone comes from the species), a corrosive zombie is acid before it is big, a
 * zombie survivor that SHRIEKs is still a survivor (shriekers stumble).
 */
export const ZOMBIE_FAMILIES: readonly { family: ZFamily; why: string; when: (c: Ctx) => boolean; build: (c: Ctx) => ZBuild; fx?: (c: Ctx) => ZFx[]; degree?: (c: Ctx) => number }[] = [
  { family: 'thorny', why: 'species PLANT (thorny zombie): a spiky plant mass', when: (c) => c.sp('PLANT') || /thorn/.test(c.id), build: () => 'walker', fx: () => ['thorns'] },
  { family: 'necro', why: 'RESURRECT / COMMAND_BUFF attacks: jet black, red eyes, tendrils', when: (c) => c.att('RESURRECT', 'COMMAND_BUFF') || /necro|zombie_master|skeleton_master/.test(c.id), build: () => 'necro', fx: () => ['tendrils', 'redEyes'] },
  { family: 'hulk', why: 'volume >= 500 L (hulk, nemesis, kevlar hulk): towering, huge fists', when: (c) => c.vol >= 500000 || /hulk|colossus|nemesis/.test(c.id), build: () => 'hulk', fx: (c) => (c.fl('ELECTRIC') ? ['arcs'] : []) },
  { family: 'boomer', why: 'BOOMER / BOOMER_GLOW / SUICIDE attacks: a huge round belly', when: (c) => c.att('BOOMER', 'BOOMER_GLOW', 'SUICIDE') || /boomer|gasbag|bloat|zomballoon|zomblimp|gas_zombie/.test(c.id), build: () => 'bloated', degree: (c) => (c.att('BOOMER_GLOW') || /huge|zomballoon|zomblimp/.test(c.id) ? 1 : /gasbag/.test(c.id) ? 0.35 : 0.5) },
  { family: 'acid', why: 'ACID_BLOOD flag or ACID / ACID_BARF attacks: glowing sacs, drool', when: (c) => c.fl('ACID_BLOOD') || c.att('ACID', 'ACID_BARF'), build: (c) => (c.att('SMASH') ? 'brute' : c.vol > 70000 ? 'fat' : 'walker'), fx: () => ['acid'], degree: (c) => (c.vol > 70000 || /corrosive|mortar|spawner/.test(c.id) ? 1 : 0.6) },
  { family: 'electric', why: 'ELECTRIC flag or SHOCKSTORM: crackling blue arcs', when: (c) => c.fl('ELECTRIC') || c.att('SHOCKSTORM'), build: (c) => (c.att('SMASH') || /brute/.test(c.id) ? 'brute' : 'walker'), fx: () => ['arcs'], degree: (c) => (c.att('SHOCKSTORM') ? 1 : 0.6) },
  { family: 'smoker', why: 'emit_fields with smoke (or smoker ids): wrapped in smoke', when: (c) => c.emitsSmoke || /smoker/.test(c.id), build: (c) => (c.att('TENTACLE', 'RANGED_PULL') ? 'grabber' : 'walker'), fx: () => ['smoke'] },
  { family: 'shrieker', why: 'SHRIEK attacks on a stumbling adult, or shriek/screech ids: crouched, gaunt, open maw', when: (c) => (c.att('SHRIEK', 'SHRIEK_ALERT', 'SHRIEK_STUN') && c.fl('STUMBLES') && c.vol > 32000) || /shriek|screech|banshee/.test(c.id), build: () => 'gaunt', fx: () => ['maw'] },
  { family: 'fat', why: 'fat ids', when: (c) => /(^|_)fat(_|$)/.test(c.id), build: () => 'fat', degree: () => 0.6 },
  { family: 'brute', why: 'SMASH attack, or brute/tough/bouncer ids: big shoulders and arms', when: (c) => c.att('SMASH') || /brute|tough|bouncer|fiend|juggernaut/.test(c.id), build: () => 'brute', degree: (c) => (/tough|bouncer/.test(c.id) && !c.att('SMASH') ? 0.5 : 1) },
  { family: 'grabber', why: 'GRAB_DRAG / RANGED_PULL / STRETCH_* attacks or grabber ids: long reaching arms', when: (c) => c.att('GRAB_DRAG', 'RANGED_PULL', 'STRETCH_ATTACK', 'STRETCH_BITE') || /grabber|grappler/.test(c.id), build: () => 'grabber' },
  { family: 'child', why: 'volume <= 32 L: a child', when: (c) => c.vol <= 32000, build: () => 'child', fx: (c) => (c.att('SHRIEK') ? ['maw'] : []) },
  { family: 'runner', why: 'no STUMBLES and a leap, or runner/hunter/predator ids: lean, leaning forward', when: (c) => (!c.fl('STUMBLES') && c.att('leap')) || /runner|hunter|predator|stalker|shady/.test(c.id), build: () => 'runner' },
  { family: 'scorched', why: 'scorched/charred ids: burnt crust', when: (c) => /scorched|charred|burnt/.test(c.id), build: () => 'walker', fx: () => ['charred'] },
  { family: 'skeleton', why: 'species SKELETON: bony, pale', when: (c) => c.sp('SKELETON'), build: () => 'walker' },
  { family: 'feral', why: 'living HUMAN monsters (feral humans): athletic, leaning forward', when: (c) => !c.sp('ZOMBIE'), build: () => 'runner' },
  { family: 'walker', why: 'everything else', when: () => true, build: () => 'walker' },
];

/** Uniform / outfit pieces that change the outline, by id (BN has no field for them). */
export const ZOMBIE_GEAR: readonly [RegExp, ZGear][] = [
  [/swat/, 'swat'],
  [/bio_op|blackops/, 'bioop'],
  [/hazmat/, 'hazmat'],
  [/fireman|flamer/, 'fireman'],
  [/soldier|military|kevlar|grenadier|supply_sergeant|pilot|militia|jackboot/, 'soldier'],
  [/(^|_)cop(_|$)|police|labsecurity|jackson/, 'cop'],
  [/survivor|prepper|survivalist/, 'survivor'],
  [/armored/, 'armored'],
  [/miner|foreman/, 'miner'],
  [/beekeeper/, 'beekeeper'],
  [/scientist|technician/, 'scientist'],
  [/nurse|surgeon|vivisector|medical|conjoiner/, 'medic'],
];

/**
 * The zombie look of a humanoid monster, or null for monsters that aren't zombie-like people
 * (NPC-like humans with no ZOMBIE species and no feral id keep the person rig).
 */
export function zombieLookOf(m: ZombieSource): ZombieLook | null {
  const species = m.species ?? [], flags = m.flags ?? [], attacks = m.attacks ?? [];
  const undead = species.includes('ZOMBIE');
  if (!undead && !/feral/.test(m.id)) return null;
  const c: Ctx = {
    id: m.id,
    sp: (s) => species.includes(s),
    fl: (f) => flags.includes(f),
    att: (...a) => a.some((x) => attacks.includes(x)),
    vol: m.volume ?? 62500,
    emitsSmoke: (m.emits ?? []).some((e) => /smoke/.test(e)),
  };
  const rule = ZOMBIE_FAMILIES.find((r) => r.when(c))!;
  const gear = ZOMBIE_GEAR.find(([re]) => re.test(m.id))?.[1] ?? 'none';
  const fx = [...(rule.fx?.(c) ?? [])];
  // features that stack on whatever the family is
  if (c.fl('ELECTRIC') && !fx.includes('arcs') && rule.family !== 'necro') fx.push('arcs');
  if (c.fl('ACID_BLOOD') && !fx.includes('acid')) fx.push('acid');
  if (/scorched|charred/.test(m.id) && !fx.includes('charred')) fx.push('charred');
  return { family: rule.family, build: rule.build(c), fx, gear, degree: rule.degree?.(c) ?? 1, bone: c.sp('SKELETON'), undead };
}
