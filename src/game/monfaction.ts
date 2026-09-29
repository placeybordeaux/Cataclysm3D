import type { GameData } from '../data/types';
import { warnOnce } from '../data/warn';

// BN monster factions (monfaction.cpp): each MONSTER_FACTION lists other factions it is
// "by_mood" / "neutral" / "friendly" / "hate" toward; a faction without an explicit relation to
// itself is friendly to itself; relations missing on a faction are inherited from its
// base_faction (default: the first root faction), and a relation to a faction that isn't listed
// resolves through that faction's own base_faction chain. This is what monster-vs-monster
// fights (dogs vs zombies) will use; the survivor's relation comes from monster attitude.

export type MonFactionAttitude = 'BY_MOOD' | 'NEUTRAL' | 'FRIENDLY' | 'HATE';

interface RawFaction {
  name: string;
  base_faction?: string;
  by_mood?: string | string[];
  neutral?: string | string[];
  friendly?: string | string[];
  hate?: string | string[];
}

class FactionTable {
  readonly maps = new Map<string, Map<string, MonFactionAttitude>>();
  readonly base = new Map<string, string>();
  private cache = new Map<string, MonFactionAttitude>();

  constructor(data: GameData) {
    const raw = Object.values((data.misc?.monster_faction ?? {}) as Record<string, RawFaction>);
    const tags = (v: string | string[] | undefined) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
    let root: string | undefined;
    for (const f of raw) {
      const m = new Map<string, MonFactionAttitude>();
      for (const [key, att] of [['by_mood', 'BY_MOOD'], ['neutral', 'NEUTRAL'], ['friendly', 'FRIENDLY'], ['hate', 'HATE']] as const) {
        for (const t of tags(f[key])) m.set(t, att);
      }
      this.maps.set(f.name, m);
      if (f.base_faction && f.base_faction !== f.name) this.base.set(f.name, f.base_faction);
      else root ??= f.name;
    }
    for (const f of raw) {
      if (!this.base.has(f.name) && f.name !== root && root !== undefined && f.base_faction !== f.name) this.base.set(f.name, root);
      const m = this.maps.get(f.name)!;
      if (f.name !== root && !m.has(f.name)) m.set(f.name, 'FRIENDLY');
    }
    // Children copy every relation of their ancestors they don't set themselves (apply_base_faction).
    const done = new Set<string>();
    const inherit = (id: string, depth = 0): void => {
      if (done.has(id) || depth > 32) return;
      const parent = this.base.get(id);
      if (parent !== undefined) {
        inherit(parent, depth + 1);
        const pm = this.maps.get(parent);
        const m = this.maps.get(id)!;
        if (pm) for (const [k, v] of pm) if (!m.has(k)) m.set(k, v);
      }
      done.add(id);
    };
    for (const id of this.maps.keys()) inherit(id);
  }

  attitude(from: string, to: string): MonFactionAttitude {
    const key = `${from}>${to}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const m = this.maps.get(from);
    let out: MonFactionAttitude = 'FRIENDLY';
    if (!m) warnOnce('monster_faction', from);
    else {
      let target: string | undefined = to;
      for (let i = 0; target !== undefined && i < 32; i++) {
        const a = m.get(target);
        if (a) {
          out = a;
          break;
        }
        target = this.base.get(target);
      }
    }
    this.cache.set(key, out);
    return out;
  }
}

const tables = new WeakMap<GameData, FactionTable>();

/** monfaction::attitude(from → to) for two monster faction ids. */
export function monsterFactionAttitude(data: GameData, from: string, to: string): MonFactionAttitude {
  let t = tables.get(data);
  if (!t) tables.set(data, (t = new FactionTable(data)));
  return t.attitude(from, to);
}
