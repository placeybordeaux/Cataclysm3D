// Which sound effect a bash plays (pure, no WebAudio: unit tested against the shipped soundset).
//
// BN's map::bash plays smash_success/<ter or furn id> when a thing breaks and smash_fail/<id>
// when it holds (map.cpp bash_ter_furn), and the soundpack decides. CC-Sounds only names ~300 of
// the ~1250 bashable ids, so in BN most bashes fall through to "default", which CC-Sounds
// doesn't have either: silence behind a "whump!" in the log. Here the order is
//
//   1. the pack's exact variant for the id (smash_fail/t_door_c: CC-Sounds' door knock),
//   2. a representative pack variant for the thing's material, read from BN's own bash
//      description ("glass breaking!", "clang!", "rrrrip!") plus the id/flags
//      (an open door sounds like the closed one, a metal door like a locker),
//   3. a synthesized sound for materials no recording covers (cloth, wet things), and the
//      pack/synth "default" only for the handful of joke strings (a suffering piano).
//
//   bashMaterial(def)                          -> 'door_wood'
//   bashSound(has, 't_door_o', 'door_wood', false) -> ['smash_fail', 't_door_c']

export type BashMaterial =
  | 'glass' | 'window' | 'ceramic' | 'door_wood' | 'wood' | 'wall' | 'brick' | 'concrete'
  | 'metal' | 'chain_link' | 'plastic' | 'soft' | 'wet' | 'boom' | 'other';

export interface BashableLike {
  id: string;
  flags?: string[] | unknown;
  bash?: { sound?: unknown; sound_fail?: unknown } | unknown;
}

/**
 * Representative (id, variant) per material for a break and for a blow that holds. Every pair
 * must exist exactly in public/audio/soundset.json or be a synth entry (procedural.ts); a unit
 * test checks that, so a pack change fails loudly instead of going quiet.
 */
export const MATERIAL_SOUNDS: Record<BashMaterial, { success: [string, string]; fail: [string, string] }> = {
  glass: { success: ['smash_success', 'f_glass_cabinet'], fail: ['smash_fail', 'f_glass_cabinet'] },
  window: { success: ['smash_success', 't_window'], fail: ['smash_fail', 'f_glass_cabinet'] },
  ceramic: { success: ['smash_success', 'f_toilet'], fail: ['smash_fail', 'f_toilet'] },
  door_wood: { success: ['smash_success', 't_door_c'], fail: ['smash_fail', 't_door_c'] },
  wood: { success: ['smash_success', 'f_table'], fail: ['smash_fail', 'f_table'] },
  // Drywall/wood-frame walls: CC-Sounds has a knock for them but no break, and a wall coming
  // down splinters like big wooden furniture.
  wall: { success: ['smash_success', 't_window_boarded_noglass'], fail: ['smash_fail', 't_wall'] },
  brick: { success: ['smash_success', 't_brick_wall'], fail: ['smash_fail', 't_brick_wall'] },
  concrete: { success: ['smash_success', 't_concrete_wall'], fail: ['smash_fail', 't_concrete_wall'] },
  metal: { success: ['smash_success', 'f_locker'], fail: ['smash_fail', 'f_locker'] },
  chain_link: { success: ['smash_success', 't_chainfence'], fail: ['smash_fail', 't_chainfence'] },
  plastic: { success: ['smash_success', 'f_trashcan'], fail: ['smash_fail', 'f_trashcan'] },
  soft: { success: ['smash_success', 'soft'], fail: ['smash_fail', 'soft'] },
  wet: { success: ['smash_success', 'wet'], fail: ['smash_fail', 'wet'] },
  boom: { success: ['explosion', 'small'], fail: ['smash_fail', 'default'] },
  other: { success: ['smash_success', 'default'], fail: ['smash_fail', 'default'] },
};

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * Bash descriptions in BN data that deliberately get the generic smash (they describe an
 * effect, not a material). Anything else that classifies as 'other' is a gap: the unit test
 * lists every BN bash string and fails on unmapped ones.
 */
export const DELIBERATELY_GENERIC = [
  'The dimensional boundary absorbs the impact without effect.',
  'Critical failure imminent, self destruct activated.  Have a nice day!',
  'reality shattering!',
  'a suffering piano!',
  'a dramatic pipe organ!',
  'clickity clack… clack… clack',
  'clickity clack… clack… clack!',
  'clickity clack… clack',
  'heavy rumbling!',
  'pow!',
];

/** Material from the bash description words alone, or null when they don't say. */
export function materialFromSound(s: string): BashMaterial | null {
  if (!s) return null;
  if (/porcelain|ceramic/i.test(s)) return 'ceramic';
  if (/glass/i.test(s)) return 'glass';
  if (/concrete/i.test(s)) return 'concrete';
  if (/metal|clang|kerchang|\bting\b|clink|clatter|rattl|plink|screech/i.test(s)) return 'metal';
  if (/r{2,}ip|whish|brush|swish|poof|slap|whuff|crinkle|crumple|\bpaf\b/i.test(s)) return 'soft';
  if (/splorch|splat|splash|glub|blub|squelch/i.test(s)) return 'wet';
  if (/\bboom\b/i.test(s)) return 'boom';
  if (/crunch|crash|smash|whack|whump|wham|thump|thunk|whunk|crack|bash|bonk|thud|whud|womp|plunk|ker-?rash|scr+ash/i.test(s)) return 'wood';
  return null;
}

/**
 * The material a terrain/furniture sounds like when bashed. Ids and flags decide first where
 * they are specific (a brick wall "crash!"es like wood in BN's words), then the description.
 */
export function bashMaterial(def: BashableLike): BashMaterial {
  const id = def.id;
  const flags = Array.isArray(def.flags) ? (def.flags as string[]) : [];
  const b = (def.bash && typeof def.bash === 'object' ? def.bash : {}) as { sound?: unknown; sound_fail?: unknown };
  const ok = str(b.sound), fail = str(b.sound_fail);
  const words = materialFromSound(ok);
  const failWords = materialFromSound(fail);
  if (words === 'ceramic' || /toilet|sink|bathtub|shower|urinal/.test(id)) return 'ceramic';
  // Cloth and wet stuff sound like themselves whatever they lie on (a carpet over concrete).
  if (words === 'soft' || (!ok && failWords === 'soft')) return 'soft';
  if (words === 'wet' || (!ok && failWords === 'wet')) return 'wet';
  if (/brick|adobe/.test(id)) return 'brick';
  if (/conc|cinder|pavement|sidewalk|(^|_)rock|stone|bunker|vault/.test(id) && !/window|glass/.test(id)) return 'concrete';
  if (/chain|chickenwire|screen_door|screened/.test(id)) return 'chain_link';
  if (/plastic/.test(id) || /recycle_bin|trashcan|chair_folding/.test(id)) return 'plastic';
  if (words === 'glass' || (/glass/i.test(fail) && /window|glass|mirror|display/.test(id))) {
    // A window pane: CC-Sounds' window break; other glass (doors, cases, walls) its glass set.
    return flags.includes('WINDOW') || /window|pane/.test(id) ? 'window' : 'glass';
  }
  if (/metal|steel|iron|mdoor|bars|locker|safe|bulkhead/.test(id) || words === 'metal' || failWords === 'metal') return 'metal';
  if (words === 'boom') return 'boom';
  if (flags.includes('DOOR') || /door|gate/.test(id)) return 'door_wood';
  if (flags.includes('WALL') || /wall/.test(id)) return 'wall';
  if (words === 'wood' || failWords === 'wood') return 'wood';
  if (!ok && !fail) return 'wood'; // BN's own default is "thump!"
  return 'other';
}

/**
 * The (id, variant) to play for a bash: the pack's exact variant for the id, else the material's
 * representative. `has(id, variant)` must be an exact lookup (no "default" fallback).
 */
export function bashSound(has: (id: string, variant: string) => boolean, targetId: string, material: BashMaterial, success: boolean): [string, string] {
  const id = success ? 'smash_success' : 'smash_fail';
  if (targetId && has(id, targetId)) return [id, targetId];
  const rep = MATERIAL_SOUNDS[material][success ? 'success' : 'fail'];
  if (has(rep[0], rep[1])) return rep;
  return [id, 'default'];
}
