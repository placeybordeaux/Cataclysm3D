// Drop validation (pure, unit-tested): can this many of this item go into that container,
// and if not, why not — in words the player sees ("Too heavy: 1.2 kg over").
//
// Every drop target in ui2 answers with a DropVerdict while the item hovers over it, so the
// ghost and the target can show valid / partial / invalid before the button is released.

import { canMerge, fmtVolume, fmtWeight, type ItemView } from './items';

export interface ContainerRules {
  /** Capacity, ml / g. Omit for unlimited (the ground). */
  maxVolume?: number;
  maxWeight?: number;
  /** Separate stacks allowed (1 for an equipment slot or the hands). */
  maxStacks?: number;
  /** An occupied single slot takes the new item and hands the old one back to the source. */
  swap?: boolean;
  /** Extra checks (wearable here? not into itself?) → reason to refuse, or null. */
  accepts?: (item: ItemView) => string | null;
}

export type DropVerdict =
  | { kind: 'ok'; count: number }
  /** Only `count` of the dragged amount fit; the rest stays where it was. */
  | { kind: 'partial'; count: number; reason: string }
  /** Single slot occupied by `displaced`, which goes back where the dragged item came from. */
  | { kind: 'swap'; count: number; displaced: ItemView }
  | { kind: 'reject'; reason: string }
  /** Dropped where it already is: nothing happens, no error sound. */
  | { kind: 'noop' };

export const isAccepted = (v: DropVerdict): v is Extract<DropVerdict, { count: number }> =>
  v.kind === 'ok' || v.kind === 'partial' || v.kind === 'swap';

/**
 * Check a drop of `count` × `item` into a container currently holding `contents`.
 * `swapBack`, when the target may swap, says whether the displaced item fits in the source.
 */
export function checkDrop(
  rules: ContainerRules,
  contents: readonly ItemView[],
  item: ItemView,
  count: number,
  swapBack?: (displaced: ItemView) => string | null,
): DropVerdict {
  if (!Number.isInteger(count) || count < 1 || count > item.count) throw new Error(`checkDrop: can't move ${count} of ${item.count}`);
  if (contents.some((c) => c.id === item.id)) return { kind: 'noop' };
  const refuse = rules.accepts?.(item);
  if (refuse) return { kind: 'reject', reason: refuse };

  const mergeable = contents.some((c) => canMerge(c, item));
  if (rules.maxStacks !== undefined && !mergeable && contents.length >= rules.maxStacks) {
    if (rules.swap && rules.maxStacks === 1 && contents.length === 1) {
      // Swapping moves the whole dragged stack; a partial swap would leave two stacks fighting
      // for one slot.
      const displaced = contents[0];
      const back = swapBack?.(displaced) ?? null;
      if (back) return { kind: 'reject', reason: `Can't swap: ${displaced.name} ${back}` };
      const cap = fitCount(rules, [], item, count);
      if (cap.count < count) return { kind: 'reject', reason: cap.reason ?? 'Does not fit' };
      return { kind: 'swap', count, displaced };
    }
    return { kind: 'reject', reason: rules.maxStacks === 1 ? 'Slot is taken' : 'No free slot' };
  }
  const fit = fitCount(rules, contents, item, count);
  if (fit.count <= 0) return { kind: 'reject', reason: fit.reason ?? 'Does not fit' };
  if (fit.count < count) return { kind: 'partial', count: fit.count, reason: `Only ${fit.count} of ${count} fit (${fit.reason})` };
  return { kind: 'ok', count };
}

/** How many of `count` fit by volume and weight, and what limits it. */
export function fitCount(rules: ContainerRules, contents: readonly ItemView[], item: ItemView, count: number): { count: number; reason?: string } {
  let n = count;
  let reason: string | undefined;
  if (rules.maxVolume !== undefined) {
    const used = contents.reduce((a, c) => a + c.volume * c.count, 0);
    const free = rules.maxVolume - used;
    const byVol = item.volume > 0 ? Math.floor(free / item.volume) : Infinity;
    if (byVol < n) {
      n = Math.max(0, byVol);
      reason = n > 0 ? 'out of space' : `Too big: needs ${fmtVolume(item.volume)}, ${fmtVolume(Math.max(0, free))} free`;
    }
  }
  if (rules.maxWeight !== undefined) {
    const used = contents.reduce((a, c) => a + weightOf(c), 0);
    const free = rules.maxWeight - used;
    const unit = weightOf({ ...item, count: 1 });
    const byWt = unit > 0 ? Math.floor(free / unit) : Infinity;
    if (byWt < n) {
      n = Math.max(0, byWt);
      reason = n > 0 ? 'too heavy' : `Too heavy: ${fmtWeight(unit - Math.max(0, free))} over`;
    }
  }
  return { count: n, reason };
}

function weightOf(it: ItemView): number {
  return it.weight * it.count + (it.contents ?? []).reduce((a, c) => a + weightOf(c), 0);
}

/** Default amount for a split prompt: half, rounded down, at least 1. */
export function defaultSplit(count: number): number {
  return Math.max(1, Math.floor(count / 2));
}

/** Mouse-wheel adjustment of the dragged amount: clamps to [1, max]. */
export function wheelCount(current: number, max: number, deltaSteps: number, fine: boolean): number {
  const step = fine ? 1 : Math.max(1, Math.round(max / 10));
  return Math.max(1, Math.min(max, current + deltaSteps * step));
}
