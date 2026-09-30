// "How long does this stay fresh?" for item cards (docs/ADAPTATION.md). BN tracks rot in
// points and shows only "(old)" and "(rotten)" once it's nearly too late; a newcomer can't
// plan meals around that. The numbers come from the same model the game runs
// (item::calc_rot: 3600 rot points an hour at 65 °F, doubling every 16 °F, none at freezing).

import { hourlyRotpoints, type Item } from './item';

/** Room temperature the card assumes, °C (BN's rot curve is 1.0× at 65 °F ≈ 18 °C). */
export const ROOM_C = 20;
/** A fridge, °C: what "in the fridge" is worked out at. */
export const FRIDGE_C = 4;

function span(hours: number): string {
  if (!Number.isFinite(hours)) return 'indefinitely';
  if (hours < 1.5) return 'about an hour';
  if (hours < 36) return `about ${Math.round(hours)} hours`;
  const days = hours / 24;
  if (days < 14) return `about ${Math.round(days)} days`;
  if (days < 60) return `about ${Math.round(days / 7)} weeks`;
  return `about ${Math.round(days / 30)} months`;
}

/** Hours until `it` rots at tempC, from its current state. 0 when already rotten. */
export function hoursLeft(it: Item, tempC: number): number {
  if (!it.goesBad()) return Infinity;
  const left = Math.max(0, it.spoilTime() - it.rot);
  const rate = hourlyRotpoints(tempC);
  return rate > 0 ? left / rate : Infinity;
}

/**
 * One line for the card, or null for things that don't go bad. For a sealed container holding
 * food (a can, a jar) it's about the food once opened.
 */
export function freshnessText(it: Item): string | null {
  const inner = it.contents.length === 1 ? it.contents[0] : null;
  if (inner && inner.goesBad() && it.def.container_data?.preserves) {
    return `Keeps while sealed. Once opened: fresh for ${span(hoursLeft(inner, ROOM_C))} (${span(hoursLeft(inner, FRIDGE_C))} in a fridge).`;
  }
  const food = it.goesBad() ? it : inner && inner.goesBad() ? inner : null;
  if (!food) return null;
  if (food.rotten()) return 'Rotten: eating it will make you sick.';
  const room = hoursLeft(food, ROOM_C);
  return `${food.goingBad() ? 'Going off soon' : 'Fresh'}: about ${span(room).replace(/^about /, '')} at room temperature, ${span(hoursLeft(food, FRIDGE_C))} in a fridge. Frozen, it keeps.`;
}
