import { CHUNK } from '../world/coords';
import type { Chunk } from '../world/map';
import { chunkTracker } from '../save/tracking';
import { warnOnce } from '../data/warn';
import type { CorpseRecord, MonsterSystem } from './monai';
import { monsterToJSON, restoreMonster, type MonsterJSON } from './monster_json';

// Far-monster retention (a cheap stand-in for CDDA folding far monsters into overmap
// monster groups). Without it every monster ever spawned stays in MonsterSystem.all: a long
// drive leaves hundreds of dormant zombies behind, each costing refresh/drift/spatial work
// and save space.
//
//   - Idle dormant monsters (outside the bubble, not drifting toward a noise) farther than
//     `stashRadius` OMTs from the survivor are serialised into their OMT column's record and
//     removed from the live list. They come back, exactly as they were, when the survivor
//     gets within `stashRadius - 1` OMTs again (hysteresis, so a column on the boundary
//     doesn't flap).
//   - Dormant-zombie corpses laid by the spawner are part of a chunk's generated baseline
//     (spawner.ts rebaselines), so their chunk can be evicted. Eviction moves them into the
//     column record, and they are laid again when the chunk regenerates (the spawner skips
//     regenerated chunks, so nobody else would).
//   - Both survive save/load in the `monsters` save section (`stash`); a dormant corpse on a
//     clean chunk (not written to the save) is saved there too.
//
// Named and friendly monsters are never stashed: other systems (missions, pets) may hold
// references to those instances.

export interface StashedCorpse {
  monId: string;
  x: number;
  y: number;
  z: number;
  facing: number;
  diedAt: number;
}

export interface StashColumn {
  monsters: MonsterJSON[];
  corpses: StashedCorpse[];
}

export interface StashColumnJSON extends StashColumn {
  /** "cx,cy" OMT column */
  col: string;
}

/** Real seconds between sweeps. */
const SWEEP_INTERVAL = 2;

export class MonsterStash {
  readonly columns = new Map<string, StashColumn>();
  /** OMTs (Chebyshev) beyond which idle dormant monsters are folded away. */
  stashRadius = 7;
  readonly stats = { stashed: 0, restored: 0, corpsesStashed: 0, corpsesRestored: 0 };
  private timer = SWEEP_INTERVAL;

  constructor(readonly sys: MonsterSystem) {
    const map = sys.game.map;
    map.onChunkEvicted.push((c) => this.onEvicted(c));
    map.onChunkGenerated.push((c) => this.layCorpses(c));
  }

  /** Total monsters and corpses held in the stash. */
  count(): { monsters: number; corpses: number } {
    let monsters = 0, corpses = 0;
    for (const col of this.columns.values()) {
      monsters += col.monsters.length;
      corpses += col.corpses.length;
    }
    return { monsters, corpses };
  }

  update(dt: number): void {
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = SWEEP_INTERVAL;
    this.sweep();
  }

  private column(key: string): StashColumn {
    let col = this.columns.get(key);
    if (!col) this.columns.set(key, (col = { monsters: [], corpses: [] }));
    return col;
  }

  private dropIfEmpty(key: string): void {
    const col = this.columns.get(key);
    if (col && !col.monsters.length && !col.corpses.length) this.columns.delete(key);
  }

  /** Fold far idle monsters away and bring back the ones near the survivor again. */
  sweep(): void {
    const sys = this.sys;
    const p = sys.game.player;
    const pcx = Math.floor(p.x / CHUNK), pcy = Math.floor(p.y / CHUNK);
    const far = (cx: number, cy: number) => Math.max(Math.abs(cx - pcx), Math.abs(cy - pcy));
    for (const m of sys.all) {
      if (m.dead || !m.dormant || m.wanderTime > 0 || m.friendly || m.name || sys.grabbedBy === m) continue;
      const cx = Math.floor(m.x / CHUNK), cy = Math.floor(m.y / CHUNK);
      if (far(cx, cy) <= this.stashRadius) continue;
      this.column(`${cx},${cy}`).monsters.push(monsterToJSON(m));
      sys.remove(m);
      this.stats.stashed++;
    }
    for (const [key, col] of this.columns) {
      if (!col.monsters.length) continue;
      const [cx, cy] = key.split(',').map(Number);
      if (far(cx, cy) >= this.stashRadius) continue;
      for (const j of col.monsters.splice(0)) if (restoreMonster(sys, j, (msg) => warnOnce('stash', msg))) this.stats.restored++;
      this.dropIfEmpty(key);
    }
  }

  /** An evicted chunk takes its dormant corpses into the stash; other corpse records just go. */
  private onEvicted(c: Chunk): void {
    const sys = this.sys;
    const x0 = c.cx * CHUNK, y0 = c.cy * CHUNK;
    const inside = (r: CorpseRecord) => r.z === c.z && r.x >= x0 && r.y >= y0 && r.x < x0 + CHUNK && r.y < y0 + CHUNK;
    const gone: CorpseRecord[] = [];
    for (let i = sys.corpses.length - 1; i >= 0; i--) {
      const r = sys.corpses[i];
      if (!inside(r)) continue;
      sys.corpses.splice(i, 1);
      gone.push(r);
      // Only dormant corpses can be on a clean (evictable) chunk: a death dirties it.
      if (r.dormant) {
        this.column(`${c.cx},${c.cy}`).corpses.push({ monId: r.monId, x: r.x, y: r.y, z: r.z, facing: r.facing, diedAt: r.diedAt });
        this.stats.corpsesStashed++;
      }
    }
    for (const r of gone) for (const f of sys.onCorpseGone) f(r);
  }

  /** Put stashed dormant corpses back on their (re)generated chunk; they stay baseline. */
  layCorpses(c: Chunk): void {
    const key = `${c.cx},${c.cy}`;
    const col = this.columns.get(key);
    if (!col?.corpses.length) return;
    const data = this.sys.game.data;
    let laid = 0;
    col.corpses = col.corpses.filter((s) => {
      if (s.z !== c.z) return true;
      const def = data.monsters[s.monId];
      if (!def) {
        warnOnce('monster', s.monId);
        return false;
      }
      const rec = this.sys.placeCorpse(def, s.x, s.y, s.z, { dormant: true, facing: s.facing });
      if (rec) rec.diedAt = s.diedAt;
      laid++;
      return false;
    });
    this.stats.corpsesRestored += laid;
    if (laid) chunkTracker(this.sys.game)?.rebaseline(c);
    this.dropIfEmpty(key);
  }

  clear(): void {
    this.columns.clear();
  }

  toJSON(extraCorpses: StashedCorpse[] = []): StashColumnJSON[] {
    const out = new Map<string, StashColumnJSON>();
    for (const [col, v] of this.columns) out.set(col, { col, monsters: [...v.monsters], corpses: [...v.corpses] });
    for (const s of extraCorpses) {
      const col = `${Math.floor(s.x / CHUNK)},${Math.floor(s.y / CHUNK)}`;
      let e = out.get(col);
      if (!e) out.set(col, (e = { col, monsters: [], corpses: [] }));
      e.corpses.push(s);
    }
    return [...out.values()];
  }

  /** Replace the stash from a save; corpses for chunks that already exist are laid at once. */
  load(list: StashColumnJSON[]): void {
    this.columns.clear();
    for (const e of list) this.columns.set(e.col, { monsters: [...e.monsters], corpses: [...e.corpses] });
    for (const c of [...this.sys.game.map.loadedChunks()]) this.layCorpses(c);
  }
}
