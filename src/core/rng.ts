// Deterministic RNG so worlds regenerate identically from a seed (needed because
// map chunks are generated lazily and may be regenerated after being evicted).

export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 0x9e3779b9;
  }
  /** float in [0,1) */
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** integer in [lo, hi] inclusive (CDDA's rng(lo, hi) semantics) */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  /** true with probability 1/n (CDDA one_in) */
  oneIn(n: number): boolean {
    return n <= 1 || this.next() * n < 1;
  }
  /** true with probability pct/100 (CDDA x_in_y style percentage) */
  chance(pct: number): boolean {
    return this.next() * 100 < pct;
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
  /** weighted pick: entries of [value, weight] */
  weighted<T>(entries: readonly (readonly [T, number])[]): T {
    let total = 0;
    for (const [, w] of entries) total += w;
    let r = this.next() * total;
    for (const [v, w] of entries) {
      if ((r -= w) < 0) return v;
    }
    return entries[entries.length - 1][0];
  }
  /** CDDA dice(n, sides) */
  dice(n: number, sides: number): number {
    let t = 0;
    for (let i = 0; i < n; i++) t += this.int(1, sides);
    return t;
  }
}

/** Stable hash of integers -> 32-bit seed, used to derive per-chunk RNGs from the world seed. */
export function hashSeed(...parts: number[]): number {
  let h = 2166136261 >>> 0;
  for (const p of parts) {
    h ^= p | 0;
    h = Math.imul(h, 16777619);
    h ^= h >>> 13;
    h = Math.imul(h, 0x5bd1e995);
    h ^= h >>> 15;
  }
  return h >>> 0;
}

export function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
