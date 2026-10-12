import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import { finalizeMutable, placeMutable, poisson, rotateDir, sampleDistribution, zAllows, type MutableGrid } from '../src/world/overmap/mutable';
import type { MutableOvermapDef, MutablePlacementRule, MutableSpecialDef, MutableTerrainJoin } from '../src/world/worldgen_data';

// Synthetic grid: every OMT is "rock" unless set; a location matches when it names the type.
// Writes record the oter id and rotation so tests can check what went where.
class TestGrid implements MutableGrid {
  cells = new Map<string, { oter: string; rot: number }>();
  blocked = new Set<string>();
  constructor(readonly r = 8, readonly zLo = -3, readonly zHi = 1) {}
  inbounds(x: number, y: number, z: number) {
    return Math.abs(x) <= this.r && Math.abs(y) <= this.r && z >= this.zLo && z <= this.zHi;
  }
  typeAt(x: number, y: number, z: number) {
    const k = `${x},${y},${z}`;
    if (this.blocked.has(k)) return 'wall';
    return this.cells.get(k)?.oter ?? (z > 0 ? 'air' : z === 0 ? 'field' : 'rock');
  }
  isAmong(x: number, y: number, z: number, locs: readonly string[]) {
    return locs.includes(this.typeAt(x, y, z));
  }
  set(x: number, y: number, z: number, oter: string, rot: number) {
    this.cells.set(`${x},${y},${z}`, { oter, rot });
  }
  at(x: number, y: number, z: number) {
    return this.cells.get(`${x},${y},${z}`);
  }
}

const M = (id: string): MutableTerrainJoin => ({ id, type: 'mandatory' });
const J = (id: string, type: MutableTerrainJoin['type']): MutableTerrainJoin => ({ id, type });
const one = (overmap: string, extra: Partial<MutablePlacementRule> = {}): MutablePlacementRule => ({ pieces: [{ overmap, pos: [0, 0, 0], rot: 0 }], ...extra });

function special(overmaps: Record<string, Partial<MutableOvermapDef> & { overmap: string }>, phases: MutablePlacementRule[][], extra: Partial<MutableSpecialDef> = {}): MutableSpecialDef {
  const oms: Record<string, MutableOvermapDef> = {};
  for (const [k, o] of Object.entries(overmaps)) oms[k] = { joins: {}, ...o };
  return {
    id: 'test', locations: ['rock'], cityDistance: [0, -1], citySizes: [0, -1], occurrences: [0, 0], flags: [], rotate: true,
    connections: [], checkForLocations: [], joins: [{ id: 't' }], overmaps: oms, root: Object.keys(overmaps)[0], shared: {}, phases, ...extra,
  };
}

describe('mutable special solver (synthetic)', () => {
  it('rotates faces like BN cube_direction + om_direction', () => {
    expect(rotateDir('north', 1)).toBe('east');
    expect(rotateDir('west', 1)).toBe('north');
    expect(rotateDir('south', 3)).toBe('east');
    expect(rotateDir('above', 2)).toBe('above');
  });

  it('matches joins: every arm of a hub gets a dead end facing back into it', () => {
    const def = special({
      hub: { overmap: 'hub', joins: { north: M('t'), east: M('t'), south: M('t'), west: M('t') } },
      end: { overmap: 'end', joins: { north: M('t') } },
    }, [[one('end')]]);
    const g = new TestGrid();
    const res = placeMutable(def, g, new Rng(1), 0, 0, -1, 0);
    expect(res.openMandatory).toBe(0);
    expect(res.bnUnresolved).toBe(false);
    // an "end" has its join on its north face; facing the hub means rotating it toward it
    expect(g.at(0, -1, -1)).toEqual({ oter: 'end', rot: 2 });
    expect(g.at(1, 0, -1)).toEqual({ oter: 'end', rot: 3 });
    expect(g.at(0, 1, -1)).toEqual({ oter: 'end', rot: 0 });
    expect(g.at(-1, 0, -1)).toEqual({ oter: 'end', rot: 1 });
    expect(res.placed).toHaveLength(5);
    expect(res.joinsUsed).toHaveLength(8);
  });

  it('honours max counts and moves to the next phase once a phase is exhausted', () => {
    const def = special({
      root: { overmap: 'root', joins: { south: M('t') } },
      straight: { overmap: 'straight', joins: { north: M('t'), south: M('t') } },
      end: { overmap: 'end', joins: { north: M('t') } },
    }, [[one('straight', { max: 3 })], [one('end')]]);
    for (let seed = 1; seed <= 20; seed++) {
      const g = new TestGrid();
      const res = placeMutable(def, g, new Rng(seed), 0, -5, -1, 0);
      expect(res.placed.map((p) => p.overmap)).toEqual(['root', 'straight', 'straight', 'straight', 'end']);
      expect(res.log.some((l) => l.includes('entering phase 1'))).toBe(true);
      expect(res.openMandatory).toBe(0);
    }
  });

  it('samples max distributions with the shared scale', () => {
    const def = special({
      root: { overmap: 'root', joins: { south: M('t') } },
      straight: { overmap: 'straight', joins: { north: M('t'), south: M('t') } },
      end: { overmap: 'end', joins: { north: M('t') } },
    }, [[one('straight', { max: 1, scale: 'size' })], [one('end')]], { shared: { size: [2, 2] } });
    const res = placeMutable(def, new TestGrid(), new Rng(3), 0, -5, -1, 0);
    expect(res.placed.filter((p) => p.overmap === 'straight')).toHaveLength(2);
  });

  it('uses phase order: a unique room goes in first, the filler only afterwards', () => {
    const def = special({
      root: { overmap: 'root', joins: { north: M('t'), east: M('t'), south: M('t'), west: M('t') } },
      queen: { overmap: 'queen', joins: { north: M('t') } },
      end: { overmap: 'end', joins: { north: M('t') } },
    }, [[one('queen', { max: 1 })], [one('end')]]);
    for (let seed = 1; seed <= 10; seed++) {
      const res = placeMutable(def, new TestGrid(), new Rng(seed), 0, 0, -1, 0);
      const kinds = res.placed.map((p) => p.overmap);
      expect(kinds[1]).toBe('queen');
      expect(kinds.filter((k) => k === 'queen')).toHaveLength(1);
      expect(kinds.filter((k) => k === 'end')).toHaveLength(3);
    }
  });

  it('picks rules by weight (min(max, weight))', () => {
    const def = special({
      root: { overmap: 'root', joins: { south: M('t') } },
      a: { overmap: 'a', joins: { north: M('t') } },
      b: { overmap: 'b', joins: { north: M('t') } },
    }, [[one('a', { weight: 1 }), one('b', { weight: 9 })]]);
    let b = 0;
    for (let seed = 1; seed <= 400; seed++) if (placeMutable(def, new TestGrid(), new Rng(seed), 0, 0, -1, 0).placed[1].overmap === 'b') b++;
    expect(b / 400).toBeGreaterThan(0.82);
    expect(b / 400).toBeLessThan(0.97);
  });

  it('reports a special whose mandatory joins nothing can satisfy, but keeps what it placed (BN never rolls back)', () => {
    const def = special({
      root: { overmap: 'root', joins: { south: M('t') } },
      end: { overmap: 'end', joins: { north: M('t') } },
    }, [[one('end')]]);
    const g = new TestGrid();
    g.blocked.add('0,1,-1');
    const res = placeMutable(def, g, new Rng(1), 0, 0, -1, 0);
    expect(res.bnUnresolved).toBe(true);
    expect(res.openMandatory).toBe(1);
    expect(g.at(0, 0, -1)?.oter).toBe('root');
    expect(res.log.some((l) => l.includes('postponed'))).toBe(true);
  });

  it('never lets an open mandatory join point somewhere outside its into_locations', () => {
    // "straight" would leave a join pointing into the wall row at y = 3; only "end" fits there.
    const def = special({
      root: { overmap: 'root', joins: { south: M('t') } },
      straight: { overmap: 'straight', joins: { north: M('t'), south: M('t') } },
      end: { overmap: 'end', joins: { north: M('t') } },
    }, [[one('straight', { weight: 1000 }), one('end', { weight: 1 })]]);
    for (let seed = 1; seed <= 10; seed++) {
      const g = new TestGrid();
      for (let x = -8; x <= 8; x++) g.blocked.add(`${x},3,-1`);
      const res = placeMutable(def, g, new Rng(seed), 0, 0, -1, 0);
      expect(g.at(0, 2, -1)?.oter).toBe('end');
      expect(res.openMandatory).toBe(0);
    }
  });

  it('a rule with "join" only applies where it matches that join', () => {
    const def = special({
      root: { overmap: 'root', joins: { south: M('t'), below: M('shaft') } },
      stairs_up: { overmap: 'stairs', joins: { above: M('shaft') } },
      end: { overmap: 'end', joins: { north: M('t') } },
      // could fill either spot if "join" didn't stop it
      blob: { overmap: 'blob', joins: { north: J('t', 'available'), above: J('shaft', 'available') } },
    }, [[one('stairs_up', { join: 'shaft' }), one('end'), one('blob', { join: 'shaft', weight: 1 })]], { joins: [{ id: 't' }, { id: 'shaft' }] });
    for (let seed = 1; seed <= 10; seed++) {
      const g = new TestGrid();
      const res = placeMutable(def, g, new Rng(seed), 0, 0, -1, 0);
      expect(g.at(0, 1, -1)?.oter).toBe('end');
      expect(['stairs', 'blob']).toContain(g.at(0, 0, -2)?.oter);
      expect(res.openMandatory).toBe(0);
    }
  });

  it('reject joins refuse a matching neighbour; available joins accept one without demanding it', () => {
    const def = special({
      root: { overmap: 'root', joins: { south: J('t', 'reject'), east: M('t') } },
      // fits east of the root but its west-facing optional join would meet the root's...
      // nothing; and below the root's reject face nothing may present a matching join
      room: { overmap: 'room', joins: { north: J('t', 'optional'), west: M('t') } },
    }, [[one('room', { max: 1 })]]);
    const g = new TestGrid();
    const res = placeMutable(def, g, new Rng(5), 0, 0, -1, 0);
    expect(g.at(1, 0, -1)?.oter).toBe('room');
    // the room's optional north join asked for something it never got, which is fine
    expect(res.openMandatory).toBe(0);
    const f = finalizeMutable(def);
    expect(f.terrains.get('root')!.joins.map(([d, j]) => [d, j.type])).toEqual([['east', 'mandatory'], ['south', 'reject']]);
  });

  it('places chunks as one unit, rotated', () => {
    const def = special({
      root: { overmap: 'root', joins: { east: M('t') } },
      a: { overmap: 'a', joins: { west: M('t'), east: M('t') } },
      b: { overmap: 'b', joins: { west: M('t') } },
    }, [[{ pieces: [{ overmap: 'a', pos: [0, 0, 0], rot: 0 }, { overmap: 'b', pos: [1, 0, 0], rot: 0 }], max: 1 }]]);
    const res = placeMutable(def, new TestGrid(), new Rng(2), 0, 0, -1, 1);
    // root turned east: its join faces south, the chunk runs south from it
    expect(res.placed.map((p) => [p.overmap, p.x, p.y, p.rot])).toEqual([['root', 0, 0, 1], ['a', 0, 1, 1], ['b', 0, 2, 1]]);
    expect(res.openMandatory).toBe(0);
  });

  it('z constraints: "bottom" only on the deepest level so far', () => {
    expect(zAllows('bottom', -3, -3, 0)).toBe(true);
    expect(zAllows('bottom', -2, -3, 0)).toBe(false);
    expect(zAllows('top', 0, -3, 0)).toBe(true);
    expect(zAllows([-10, -4], -4, 0, 0)).toBe(true);
    expect(zAllows(-2, -3, 0, 0)).toBe(false);
    expect(zAllows({ bottom: -1 }, -4, -3, 0)).toBe(true);
  });

  it('distributions sample like BN int_distribution', () => {
    const rng = new Rng(9);
    let sum = 0;
    for (let i = 0; i < 4000; i++) sum += poisson(rng, 2.5);
    expect(sum / 4000).toBeGreaterThan(2.3);
    expect(sum / 4000).toBeLessThan(2.7);
    expect(sampleDistribution(4, rng, 3)).toBe(12);
    const r = sampleDistribution([1, 5], rng, 2);
    expect(r).toBeGreaterThanOrEqual(2);
    expect(r).toBeLessThanOrEqual(10);
    expect(sampleDistribution({ chance: 1 }, rng)).toBe(1);
    expect(sampleDistribution({ chance: 0 }, rng)).toBe(0);
  });

  it('rejects broken definitions loudly', () => {
    expect(() => finalizeMutable(special({ root: { overmap: 'r', joins: { north: M('nope') } } }, []))).toThrow(/unknown join nope/);
    expect(() => finalizeMutable(special({ root: { overmap: 'r' } }, [[one('missing')]]))).toThrow(/not defined/);
    expect(() => finalizeMutable(special({ root: { overmap: 'r' } }, [], { joins: [{ id: 'a', opposite: 'b' }, { id: 'b' }] }))).toThrow(/does not point back/);
  });
});
