import type { Season, SoundEffectDef, SoundsetFile } from './soundsetTypes';

// CDDA sound lookup (src/sdlsound.cpp find_closest_sfx), kept pure so it can be unit tested.
//
// Effects are indexed id -> variant -> season -> indoors -> night. Lookup walks the levels
// in that order; at each level it takes the exact key if present, otherwise the level's
// default ("default" variant, no season, either in/out, any time). It never backtracks: if
// variant "t_door_c" exists but only for spring, a summer lookup of t_door_c finds nothing
// even though a "default" variant exists. That is CDDA's behavior and soundpacks rely on it.

export interface SoundContext {
  season?: Season;
  indoors?: boolean;
  night?: boolean;
}

export interface ResolvedSound {
  file: string;
  /** CDDA volume of the entry (0..100+) */
  volume: number;
  id: string;
  variant: string;
}

type Night = 'day' | 'night' | '';
type InOut = 'in' | 'out' | '';
type Leaf = { file: string; volume: number }[];
type Index = Map<string, Map<string, Map<string, Map<InOut, Map<Night, Leaf>>>>>;

const getOrMake = <K, V>(m: Map<K, V>, k: K, make: () => V): V => {
  let v = m.get(k);
  if (v === undefined) m.set(k, (v = make()));
  return v;
};
const inOut = (b: boolean | undefined): InOut => (b === undefined ? '' : b ? 'in' : 'out');
const dayNight = (b: boolean | undefined): Night => (b === undefined ? '' : b ? 'night' : 'day');

export class Soundset {
  private index: Index = new Map();

  constructor(effects: SoundEffectDef[] = []) {
    for (const e of effects) this.add(e);
  }

  static fromFile(f: SoundsetFile): Soundset {
    if (f.version !== 1) throw new Error(`soundset.json version ${f.version} not supported`);
    return new Soundset(f.effects);
  }

  /** Entries with the same key accumulate files, like CDDA loading several JSON objects. */
  add(e: SoundEffectDef): void {
    const byVariant = getOrMake(this.index, e.id, () => new Map());
    for (const v of e.variants) {
      const bySeason = getOrMake(byVariant, v, () => new Map());
      const byInOut = getOrMake(bySeason, e.season ?? '', () => new Map());
      const byNight = getOrMake(byInOut, inOut(e.indoors), () => new Map());
      const leaf = getOrMake<Night, Leaf>(byNight, dayNight(e.night), () => []);
      for (const file of e.files) leaf.push({ file, volume: e.volume });
    }
  }

  hasId(id: string): boolean {
    return this.index.has(id);
  }

  ids(): string[] {
    return [...this.index.keys()];
  }

  variants(id: string): string[] {
    return [...(this.index.get(id)?.keys() ?? [])];
  }

  /** CDDA find(): variant falls back to "default". */
  find(id: string, variant: string, ctx: SoundContext = {}): Leaf | null {
    return this.lookup(id, variant, 'default', ctx);
  }

  /** CDDA find_exact(): no fallback to the "default" variant (other levels still fall back). */
  findExact(id: string, variant: string, ctx: SoundContext = {}): Leaf | null {
    return this.lookup(id, variant, null, ctx);
  }

  /** Pick a random file for (id, variant) with CDDA fallback. `rand` in [0,1). */
  resolve(id: string, variant = 'default', ctx: SoundContext = {}, rand: () => number = Math.random): ResolvedSound | null {
    const leaf = this.find(id, variant, ctx);
    if (!leaf || !leaf.length) return null;
    const pick = leaf[Math.min(leaf.length - 1, Math.floor(rand() * leaf.length))];
    const usedVariant = this.index.get(id)!.has(variant) ? variant : 'default';
    return { file: pick.file, volume: pick.volume, id, variant: usedVariant };
  }

  /** Every file the soundset references (for preloading / verification). */
  allFiles(): string[] {
    const out = new Set<string>();
    for (const byV of this.index.values())
      for (const byS of byV.values())
        for (const byIO of byS.values()) for (const byN of byIO.values()) for (const leaf of byN.values()) for (const f of leaf) out.add(f.file);
    return [...out];
  }

  private lookup(id: string, variant: string, variantDefault: string | null, ctx: SoundContext): Leaf | null {
    const byVariant = this.index.get(id);
    if (!byVariant) return null;
    const bySeason = byVariant.get(variant) ?? (variantDefault !== null ? byVariant.get(variantDefault) : undefined);
    if (!bySeason) return null;
    const byInOut = bySeason.get(ctx.season ?? '') ?? bySeason.get('');
    if (!byInOut) return null;
    const byNight = byInOut.get(inOut(ctx.indoors)) ?? byInOut.get('');
    if (!byNight) return null;
    return byNight.get(dayNight(ctx.night)) ?? byNight.get('') ?? null;
  }
}
