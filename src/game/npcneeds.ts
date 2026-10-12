import type { Npc } from './npc';
import type { Item } from './item';
import { materialIds, useActions } from './inventory';

/** BN npcmove.cpp rate_food: avoid waste, spoilage, parasites and automatic drug use. */
export function rateNpcFood(n: Npc, food: Item): number {
  if (!food.isComestible()) return 0;
  const d = food.def;
  if (Number(d.parasites ?? 0) && !food.hasFlag('NO_PARASITES')) return 0;
  const nutr = Math.trunc((d.calories ?? 0) / (2500 / 288));
  const quench = d.quench ?? 0;
  if ((nutr <= 0 && quench <= 0) || useActions(d).length) return 0;
  const rot = food.relativeRot();
  if (rot >= 1) return 0;
  const wantNutr = Math.max(0, Math.trunc((n.maxStoredKcal() - n.storedKcal) / 10));
  const wantQuench = Math.max(0, n.thirst);
  let weight = Math.max(1, 10 * rot);
  if ((d.fun ?? 0) < 0) weight /= -(d.fun ?? 0) + 1;
  if ((d.healthy ?? 0) < 0) weight /= -(d.healthy ?? 0) + 1;
  if (rot < 0.9 && quench > wantQuench) weight -= (1 - rot) * (quench - wantQuench);
  if (quench < 0 && wantQuench > 0 && wantNutr < wantQuench) weight *= wantNutr / wantQuench;
  if (nutr > wantNutr) {
    if (nutr >= 5) return 0;
    if (rot < 0.9) weight /= nutr - wantNutr;
  }
  // Instance poison is not modeled by Item. Reject known poisonous content instead.
  if (food.hasFlag('POISON') || food.hasFlag('HIDDEN_POISON')) return 0;
  return weight;
}

/** Active food/tools exclude unfinished work and all escrowed components, including nested crafts. */
function needsInventory(n: Npc): Item[] {
  const out: Item[] = [];
  const visit = (item: Item) => {
    if (item.isCraft()) return;
    out.push(item);
    for (const child of item.allContents()) visit(child);
  };
  for (const item of n.inv.topLevel()) visit(item);
  return out;
}

/** BN Character::can_eat/will_eat noninteractive refusal checks on represented NPC state. */
export function npcWillEat(n: Npc, food: Item): boolean {
  if (food.isCraft()) return false;
  const d = food.def;
  const vitamins = new Set((d.vitamins ?? []).filter(([, amount]) => amount > 0).map(([id]) => id));
  const hasAny = (ids: string[]) => ids.some(id => vitamins.has(id));
  const kcal = d.calories ?? 0, quench = d.quench ?? 0;
  if (food.hasFlag('DIRTY')) return false;
  if (food.hasFlag('INEDIBLE')) {
    for (const species of ['CATTLE', 'FELINE', 'LUPINE', 'BIRD'])
      if (food.hasFlag(species) && !n.hasTrait(`THRESH_${species}`)) return false;
  }
  if (n.hasTrait('M_DEPENDENT') && !food.hasFlag('MYCUS_OK') && !food.hasFlag('NO_INGEST')) return false;
  const drinkable = d.comestible_type === 'DRINK' && !food.hasFlag('USE_EAT_VERB');
  const edible = d.comestible_type === 'FOOD' || food.hasFlag('USE_EAT_VERB');
  if ((edible || drinkable) && materialIds(d).some(id => n.data.misc.material?.[id]?.edible === false)) return false;
  const tool = d.tool as string | undefined;
  if (tool && !needsInventory(n).some(it => it.typeId === tool && (!it.countByCharges || it.charges >= 1))) return false;
  if (n.hasTrait('PROBOSCIS') && !drinkable && d.comestible_type !== 'MED') return false;
  if (n.hasTrait('CARNIVORE') && kcal > 0 && !food.hasFlag('CARNIVORE_OK') &&
      hasAny(['veggy_allergen', 'fruit_allergen', 'wheat_allergen', 'nut_allergen'])) return false;
  if ((n.hasTrait('HERBIVORE') || n.hasTrait('RUMINANT')) && hasAny(['meat_allergen', 'egg_allergen'])) return false;
  for (const trait of n.traits) {
    const only = n.traitDef(trait)?.can_only_eat;
    if (Array.isArray(only) && only.length && !food.hasFlag('NO_INGEST') && !materialIds(d).some(id => only.includes(id))) return false;
  }
  const cannibal = [...n.traits].some(id => n.traitDef(id)?.flags?.includes('CANNIBAL'));
  if (vitamins.has('human_flesh_vitamin') && !cannibal) return false;
  if (kcal > 0 && n.effects.has('nausea')) return false;
  if ((kcal > 0 || quench > 0) && n.effects.has('bloated') && !food.hasFlag('NO_BLOAT')) return false;
  const allergies: [string, string][] = [['VEGETARIAN', 'meat_allergen'], ['MEATARIAN', 'veggy_allergen'],
    ['LACTOSE', 'milk_allergen'], ['ANTIFRUIT', 'fruit_allergen'], ['ANTIJUNK', 'junk_allergen'], ['ANTIWHEAT', 'wheat_allergen']];
  if (allergies.some(([trait, vitamin]) => n.hasTrait(trait) && vitamins.has(vitamin))) return false;
  if (n.hasTrait('CARNIVORE') && food.hasFlag('ALLERGEN_JUNK') && !food.hasFlag('CARNIVORE_OK')) return false;
  if (kcal > 0 && n.storedKcal + n.stomach.kcal + kcal > n.maxStoredKcal()) return false;
  if (quench > 0 && n.thirst < quench && !n.hasTrait('NO_THIRST')) return false;
  return true;
}

/** Consume one actual carried portion through Inventory; never fabricate food or replenish allies. */
export function consumeNpcFood(n: Npc): { item: Item; moves: number } | null {
  const candidates = needsInventory(n).filter(it => it.isComestible())
    .map(item => ({ item, weight: rateNpcFood(n, item) })).filter(c => c.weight > 0)
    .sort((a, b) => b.weight - a.weight);
  for (const { item } of candidates) {
    if (!npcWillEat(n, item) || n.inv.consumeChecks.some(check => check(item))) continue;
    const result = n.inv.consume(item);
    if (result.ok) return { item, moves: result.moves };
  }
  return null;
}
