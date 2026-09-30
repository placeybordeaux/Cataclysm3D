// The eat/drink picker, adapted (docs/ADAPTATION.md). Playtest: a bottle of water was listed
// twice, once as "clean water (plastic bottle) (2/2)" (drink from the bottle) and once as
// "clean water ×2 · In your plastic bottle" (drink the water), and "(2/2)" is CDDA's charges
// notation, which a newcomer reads as "two out of two… what?". Both rows do the same thing.
//
// Rules: a row whose item sits inside another listed row's item is dropped (the container row
// already covers it); a container holding one consumable is named after what's in it with
// "N servings"; a bare stack of servings says so too. Pure, so it's unit-tested.

import type { Item } from '../../game/item';

export interface EatRowIn<R> {
  row: R;
  item: Item;
  /** The item this row's item is inside, if any. */
  host: Item | null;
}

const servings = (n: number) => `${n} serving${n === 1 ? '' : 's'}`;

/** What the picker should call this item. */
export function eatLabel(it: Item): string {
  const inner = it.contents;
  if (it.isContainer() && inner.length === 1 && inner[0].countByCharges) {
    const c = inner[0];
    return `${c.label(c.charges)} (${it.label()}) · ${servings(c.charges)}`;
  }
  if (it.countByCharges && it.charges > 1) return `${it.label(it.charges)} · ${servings(it.charges)}`;
  return it.name();
}

/** Drop rows already covered by their container's row, and relabel the rest. */
export function adaptEatRows<R>(rows: EatRowIn<R>[]): { row: R; label: string }[] {
  const listed = new Set(rows.map((r) => r.item));
  const kept = rows.filter((r) => !(r.host && listed.has(r.host)));
  // Two identical bottles stack into one row (the first bottle), so the second bottle's water
  // showed up on its own as "clean water · In your plastic bottle" (playtest, round 6). Fold such
  // rows into the stacked bottle's row and count all the servings there.
  const kindOf = (c: Item) => (c.isContainer() && c.contents.length === 1 && c.contents[0].countByCharges ? `${c.typeId}|${c.contents[0].typeId}` : null);
  const groups = new Map<string, { owner: Item; bottles: number; servings: number }>();
  for (const r of kept) {
    const k = kindOf(r.item);
    if (k && !groups.has(k)) groups.set(k, { owner: r.item, bottles: 1, servings: r.item.contents[0].charges });
  }
  const shown = kept.filter((r) => {
    const g = r.host ? groups.get(kindOf(r.host) ?? '') : undefined;
    if (!g) return true;
    g.bottles++;
    g.servings += r.item.charges;
    return false;
  });
  return shown.map((r) => {
    const g = groups.get(kindOf(r.item) ?? '');
    if (!g || g.owner !== r.item || g.bottles === 1) return { row: r.row, label: eatLabel(r.item) };
    const c = r.item.contents[0];
    return { row: r.row, label: `${c.label(g.servings)} (${r.item.label(g.bottles)}) · ${servings(g.servings)}` };
  });
}
