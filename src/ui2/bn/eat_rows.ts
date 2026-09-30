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
  return rows.filter((r) => !(r.host && listed.has(r.host))).map((r) => ({ row: r.row, label: eatLabel(r.item) }));
}
