// What pressing a hotbar slot does with the bound item.
//
// The hotbar used to run the item's *primary* (double-click) action, and that rule prefers
// "Wear" for anything with armor data. BN gives every bow armor data (a longbow can be carried
// slung across the torso, layer BELTED), shields and helmets have melee damage, and a holster is
// both clothing and a tool — so the double-click rule wore the longbow when the player pressed its
// slot to shoot. A hotbar slot is a quick-draw: it answers "get this ready to use", which for a
// weapon means in your hands. The inventory's double-click keeps its own rule.
//
// Rule table (first match wins; the chosen action is returned even when disabled so the player is
// told why — falling through to another action is how the longbow ended up worn):
//   in your hands                  → put away (the slot toggles; unchanged)
//   food / drink / pills / bandage → eat or drink (BN treats bandages as comestibles with a heal use)
//   a gun (guns, bows, crossbows, slings, slingshots — worn or carried) → wield
//   clothing/armor, not worn       → wear (jackets, backpacks, holsters, shields, helmets)
//   clothing/armor, worn           → its use action if it has one (holster: draw), else take off
//   a melee weapon (BN weapon_category, or BN is_melee: some melee damage > MELEE_STAT) → wield
//   a tool with a use action       → use it (flashlight on, lighter, …)
//   anything else                  → the double-click action (open a bag, …), else wield

import type { Character } from './character';
import { itemActions, type ItemAction } from './inventory_view';
import type { Item } from './item';
import type { Loc } from './moves';

/** BN game_constants.h MELEE_STAT: item::is_melee(dt) is damage_melee(dt) > MELEE_STAT. */
export const MELEE_STAT = 5;

/** BN item::is_melee(): any melee damage type above MELEE_STAT. */
export function isMeleeWeapon(it: Item): boolean {
  const dmg = it.def.melee_damage ?? {};
  return Object.values(dmg).some((v) => (v ?? 0) > MELEE_STAT);
}

/** Is wielding the point of this item? Guns of every kind, and melee weapons that aren't clothing. */
export function isWieldWeapon(it: Item): boolean {
  if (it.isGun()) return true;
  if (it.isArmor()) return false; // shields, helmets: worn in BN even though they hit hard
  const cats = (it.def as { weapon_category?: string[] }).weapon_category;
  return (cats?.length ?? 0) > 0 || isMeleeWeapon(it);
}

export type HotbarChoiceId = ItemAction['id'];

/**
 * The action a hotbar press runs for `it` at `loc`, or null when there is nothing sensible (the
 * caller falls back to the double-click action, e.g. "Open" on a bag with contents).
 */
export function hotbarChoice(who: Character, it: Item, loc: Loc): ItemAction | null {
  const acts = itemActions(who, it, loc);
  const find = (id: HotbarChoiceId) => acts.find((a) => a.id === id) ?? null;
  if (loc.kind === 'hands') return find('unwield');
  const food = find('eat') ?? find('drink');
  if (food) return food;
  if (it.isGun()) return find('wield');
  if (it.isArmor()) {
    if (loc.kind !== 'worn') return find('wear');
    return find('activate') ?? find('takeoff');
  }
  if (isWieldWeapon(it)) return find('wield');
  const use = find('activate');
  if (use) return use;
  return null;
}
