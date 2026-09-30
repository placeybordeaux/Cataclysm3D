// The UI's view of an item. Screens convert whatever the game's item model is (DDA Item today,
// the BN port tomorrow) into ItemView and back into actions; ui2 components never touch game
// items directly, so the item model can change under them. Pure.

/** What to draw: an atlas id (with CDDA looks_like fallback) or an ASCII glyph. */
export interface IconRef {
  typeId: string;
  looksLike?: string;
  symbol?: string;
  color?: string;
}

export type Tone = 'good' | 'bad' | 'warn' | 'info' | 'accent' | 'dim' | 'magic';

/** A tiny marker in a cell corner: "W" wielded, "E" worn, "!" rotten, "♥" favourite… */
export interface Badge {
  text: string;
  tone?: Tone;
  /** Shown in the tooltip's badge line, e.g. "Wielded". */
  title?: string;
}

/** A tooltip/compare row. Numeric so compare can show ▲/▼ deltas. */
export interface ItemStat {
  label: string;
  value: number;
  /** Suffix, e.g. ' kg', ' L', ' s'. */
  unit?: string;
  /** Which direction is an improvement (for compare colours); omit for neutral facts. */
  better?: 'higher' | 'lower';
  /** Decimal places (default: 0 for integers, else 1). */
  digits?: number;
}

export interface ItemView {
  /** Unique per item instance (stacks count as one instance). */
  id: string;
  typeId: string;
  name: string;
  /** Stack size (1 for a single item). */
  count: number;
  stackable: boolean;
  /** Per unit, grams / millilitres. */
  weight: number;
  volume: number;
  category?: string;
  /** 0..1 (1 = pristine); undefined hides the condition bar. */
  condition?: number;
  /** Ammo, battery, liquid amount: drawn as a thin second bar. */
  charges?: { cur: number; max: number; label?: string };
  badges?: Badge[];
  description?: string;
  /** A highlighted line above the description (how long food stays fresh). */
  note?: string;
  icon?: IconRef;
  /** Body parts it covers when worn (BN `covers` ids: head, eyes, mouth, torso, arm_l, …). */
  covers?: string[];
  stats?: ItemStat[];
  /** When the item is itself a container: what fits inside. */
  capacity?: { volume: number; weight: number };
  contents?: ItemView[];
}

/** Weight of the stack including anything inside, grams. */
export function totalWeight(it: ItemView): number {
  return it.weight * it.count + (it.contents ?? []).reduce((a, c) => a + totalWeight(c), 0);
}

/** Volume of the stack, ml. Containers are treated as rigid: contents don't add volume. */
export function totalVolume(it: ItemView): number {
  return it.volume * it.count;
}

/** Split a stack: take `take` of `count`. Throws on nonsense rather than clamping silently. */
export function splitCounts(count: number, take: number): { take: number; rest: number } {
  if (!Number.isInteger(count) || count < 1) throw new Error(`splitCounts: bad stack size ${count}`);
  if (!Number.isInteger(take) || take < 1 || take > count) throw new Error(`splitCounts: can't take ${take} of ${count}`);
  return { take, rest: count - take };
}

/** Whether b can be merged into a's stack (same kind, both stackable, neither holds anything). */
export function canMerge(a: ItemView, b: ItemView): boolean {
  return (
    a.id !== b.id && a.typeId === b.typeId && a.stackable && b.stackable &&
    !a.contents?.length && !b.contents?.length && (a.condition ?? 1) === (b.condition ?? 1)
  );
}

/** "2.4 kg" / "350 g". */
export function fmtWeight(g: number): string {
  return g >= 1000 ? `${(g / 1000).toFixed(g >= 10000 ? 1 : 2).replace(/\.?0+$/, '')} kg` : `${Math.round(g)} g`;
}

/** "1.25 L" / "250 ml". */
export function fmtVolume(ml: number): string {
  return ml >= 1000 ? `${(ml / 1000).toFixed(2).replace(/\.?0+$/, '')} L` : `${Math.round(ml)} ml`;
}

/** Action time for menus: "0.5 s", "12 s", "3 min", "1 h 20 min". */
export function fmtDuration(seconds: number): string {
  if (seconds < 10) return `${+seconds.toFixed(1)} s`;
  if (seconds < 90) return `${Math.round(seconds)} s`;
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}

export function displayName(it: ItemView): string {
  return it.count > 1 ? `${it.name} (${it.count})` : it.name;
}
