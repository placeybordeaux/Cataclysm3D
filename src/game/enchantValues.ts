import type { GameData } from '../data/types';

// BN enchantment_value ids and their parents (Cataclysm-BN src/enchantments/enchantment_value.cpp
// enchantment_value::load / define_child_enchantments). A value with `suffixes` generates
// children: HEALTH_POINTS → HEALTH_POINTS_ARM → HEALTH_POINTS_ARM_L. A child also counts what is
// added to its parents (enchantment::get_value_add sums the parents recursively, with no
// de-duplication), so the tree decides which enchantments reach a lookup.
//
// CLIMATE_CONTROL is the one value with two suffix sets (COOLING/HEATING, then the body parts).
// Following BN's loader exactly gives these parents, quirks included:
//   CLIMATE_CONTROL_COOLING_ARM_L → CLIMATE_CONTROL_COOLING_ARM (→ _COOLING → CLIMATE_CONTROL)
//                                 + CLIMATE_CONTROL_ARM_L (→ CLIMATE_CONTROL_ARM, no further)
//   CLIMATE_CONTROL_COOLING_TORSO → CLIMATE_CONTROL_COOLING (→ CLIMATE_CONTROL)
//                                 + CLIMATE_CONTROL_TORSO (→ CLIMATE_CONTROL)
// so a plain CLIMATE_CONTROL counts twice on the torso, head, eyes and mouth and once on the
// limbs. That is what BN computes; it is kept rather than "fixed".

export interface EnchantValueNode {
  id: string;
  parents: string[];
  /** Description after BN's string_format of desc with desc_insert ("Affects Strength"). */
  desc: string;
  increaseGood: boolean;
  canAdd: boolean;
  canMult: boolean;
  canMax: boolean;
}

interface RawValue {
  id: string;
  desc?: string;
  desc_insert?: string[];
  suffixes?: RawSuffix[][];
  increase_good?: boolean;
  can_add?: boolean;
  can_mult?: boolean;
  can_max?: boolean;
}
interface RawSuffix {
  suffix: string;
  desc?: string;
  desc_insert?: string[];
  suffixes?: RawSuffix[];
}
interface Proto {
  desc: string;
  descInsert: string[];
}

/** BN string_format for these descs: each %s / %1s / %2s takes the next insert (width ignored). */
function formatDesc(desc: string, inserts: string[]): string {
  let i = 0;
  return desc.replace(/%\d*s/g, () => inserts[i++] ?? '');
}

const trees = new WeakMap<object, Map<string, EnchantValueNode>>();

/** Every enchantment_value id in the data (roots and generated children), with parents. */
export function enchantValueTree(data: GameData): Map<string, EnchantValueNode> {
  const raw = (data.misc?.enchantment_value ?? {}) as Record<string, RawValue>;
  const have = trees.get(raw);
  if (have) return have;
  const out = new Map<string, EnchantValueNode & Proto>();
  for (const main of Object.values(raw)) {
    const base = {
      increaseGood: main.increase_good ?? true,
      canAdd: main.can_add ?? true,
      canMult: main.can_mult ?? true,
      canMax: main.can_max ?? false,
    };
    const mainProto: Proto = { desc: main.desc ?? '', descInsert: main.desc_insert ?? [] };
    out.set(main.id, { id: main.id, parents: [], ...base, ...mainProto, desc: mainProto.desc });
    // define_child_enchantments: a copy of `main` per parent, desc/desc_insert overridden only
    // when the suffix object has them (BN reads no "replace" key, so those inherit main's).
    const define = (parents: string[], obj: RawSuffix, first: boolean): string[] => {
      const res: string[] = [];
      for (const p of parents) {
        const id = `${p}_${obj.suffix}`;
        const node = {
          id,
          parents: !first && p === main.id ? [] : [p],
          ...base,
          desc: obj.desc ?? mainProto.desc,
          descInsert: obj.desc_insert ?? mainProto.descInsert,
        };
        out.set(id, node);
        if (obj.suffixes) for (const o of obj.suffixes) res.push(...define([id], o, false));
        else res.push(id);
      }
      return res;
    };
    if (!main.suffixes) continue;
    let first = true;
    let last: string[] = [];
    for (const set of main.suffixes) {
      last.push(main.id);
      const next: string[] = [];
      for (const obj of set) next.push(...define(last, obj, first));
      last = next;
      first = false;
    }
    // The fix-up pass over the lowest nodes: CLIMATE_CONTROL_COOLING_LEG_L also gets
    // CLIMATE_CONTROL_LEG_L. Strip the main id, drop up to the next "_" (all of it when there is
    // none, which is how CLIMATE_CONTROL_TORSO ends up with CLIMATE_CONTROL), put the main id back.
    for (const id of last) {
      let rest = id.slice(main.id.length + 1);
      const cut = rest.indexOf('_');
      rest = cut < 0 ? '' : rest.slice(cut);
      const parent = main.id + rest;
      const node = out.get(id)!;
      // BN checks the parent list for the *main* id here, not for `parent`.
      if (out.has(parent) && !node.parents.includes(main.id)) node.parents.push(parent);
    }
  }
  const tree = new Map<string, EnchantValueNode>();
  for (const [id, n] of out) {
    tree.set(id, {
      id, parents: n.parents, increaseGood: n.increaseGood, canAdd: n.canAdd, canMult: n.canMult, canMax: n.canMax,
      desc: formatDesc(n.desc, n.descInsert),
    });
  }
  trees.set(raw, tree);
  return tree;
}

/**
 * The ids whose values a lookup of `value` sums, with BN's multiplicity (get_value_add recurses
 * into every parent). Null when `value` is not a known enchantment_value.
 */
export function enchantLookupIds(data: GameData, value: string): string[] | null {
  const tree = enchantValueTree(data);
  if (!tree.has(value)) return null;
  const out: string[] = [];
  const walk = (id: string) => {
    out.push(id);
    for (const p of tree.get(id)?.parents ?? []) walk(p);
  };
  walk(value);
  return out;
}
