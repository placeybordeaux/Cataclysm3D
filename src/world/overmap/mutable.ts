import type { Rng } from '../../core/rng';
import type {
  CubeDir, IntDistribution, MutableJoinDef, MutableOvermapDef, MutablePlacementRule, MutableSpecialDef,
  MutableTerrainJoin, ZConstraint,
} from '../worldgen_data';
import { rotateOffset } from './oter';

// Generic solver for BN's mutable overmap specials, a port of overmap.cpp
// mutable_overmap_special_data::place and its helpers (joins_tracker,
// mutable_overmap_phase_remainder::satisfy / can_place, z_constraints, int_distribution).
//
// The special grows from its root terrain. Every terrain declares joins on its six faces; a
// mandatory or optional join leaves an "unresolved" join on the neighbouring OMT that later
// pieces must satisfy. Phases are worked through in order: each phase realises its rules (a
// sampled `max` count and a weight) and keeps resolving the top-priority unresolved position
// (the join declared earliest in "joins" first) by picking, weighted, one rule that fits there.
// A position nothing fits is postponed until the next phase. BN commits terrain as it goes and
// never rolls back; a special that ends with mandatory joins postponed is a JSON error that
// BN only reports (debugmsg), and so do we (MutablePlacement.bnUnresolved).
//
// The solver only sees the world through MutableGrid so it can run on synthetic grids in
// tests; Overmap supplies one backed by a region.

export const INT_MAX = 2147483647;

/** What the solver needs from the map. Coordinates are whatever the caller uses (region-local OMTs). */
export interface MutableGrid {
  inbounds(x: number, y: number, z: number): boolean;
  /** BN is_amongst_locations(om.ter(p), locations) */
  isAmong(x: number, y: number, z: number, locations: readonly string[]): boolean;
  /** Write a terrain: `oter` is the id as the special names it, `rot` the turns to rotate it by. */
  set(x: number, y: number, z: number, oter: string, rot: number): void;
  /** For failure descriptions only. */
  describe?(x: number, y: number, z: number): string;
}

export interface PlacedPiece {
  x: number;
  y: number;
  z: number;
  /** key into def.overmaps */
  overmap: string;
  rot: number;
}

export interface PlacedConnection {
  connection: string;
  x: number;
  y: number;
  z: number;
  dir: CubeDir;
}

export interface MutablePlacement {
  placed: PlacedPiece[];
  connections: PlacedConnection[];
  /** BN joins_tracker::used: [x, y, z, dir, join id] of every join that met its opposite */
  joinsUsed: [number, number, number, CubeDir, string][];
  /** BN !is_finished(): mandatory joins left postponed (BN debugmsgs "had unresolved joins") */
  bnUnresolved: boolean;
  /** Mandatory joins still open anywhere (postponed or unresolved) when placement ended.
   *  Stricter than bnUnresolved: BN also stops when the last phase's rules run out. */
  openMandatory: number;
  /** Human-readable record of each step, like BN's debug description list. */
  log: string[];
}

// ---------------------------------------------------------------------------------------
// Directions

const HDIRS: CubeDir[] = ['north', 'east', 'south', 'west'];
/** Iteration order of a terrain's joins (BN iterates an unordered_map; any fixed order will do). */
export const CUBE_DIRS: CubeDir[] = ['north', 'east', 'south', 'west', 'above', 'below'];
const DIR_INDEX: Record<CubeDir, number> = { north: 0, east: 1, south: 2, west: 3, above: 4, below: 5 };
const DISPLACE: Record<CubeDir, [number, number, number]> = {
  north: [0, -1, 0], east: [1, 0, 0], south: [0, 1, 0], west: [-1, 0, 0], above: [0, 0, 1], below: [0, 0, -1],
};
const OPPOSITE: Record<CubeDir, CubeDir> = { north: 'south', east: 'west', south: 'north', west: 'east', above: 'below', below: 'above' };

/** BN cube_direction + om_direction: horizontal faces turn clockwise, above/below stay. */
export function rotateDir(d: CubeDir, rot: number): CubeDir {
  if (d === 'above' || d === 'below') return d;
  return HDIRS[(DIR_INDEX[d] + rot + 4 * 4) % 4];
}

interface PosDir {
  x: number;
  y: number;
  z: number;
  dir: CubeDir;
}
const keyOf = (p: PosDir) => `${p.x},${p.y},${p.z},${p.dir}`;
const posKey = (x: number, y: number, z: number) => `${x},${y},${z}`;
function opposite(p: PosDir): PosDir {
  const [dx, dy, dz] = DISPLACE[p.dir];
  return { x: p.x + dx, y: p.y + dy, z: p.z + dz, dir: OPPOSITE[p.dir] };
}
/** BN pos_dir operator<: tie(p, dir), tripoint compared x, y, z. */
function comparePosDir(a: PosDir, b: PosDir): number {
  return a.x - b.x || a.y - b.y || a.z - b.z || DIR_INDEX[a.dir] - DIR_INDEX[b.dir];
}

// ---------------------------------------------------------------------------------------
// Distributions / constraints

/** BN std::poisson_distribution (Knuth; means here stay well under 100). */
export function poisson(rng: Rng, mean: number): number {
  if (!(mean > 0)) return 0;
  const l = Math.exp(-mean);
  let k = 0, p = 1;
  do {
    k++;
    p *= rng.next();
  } while (p > l);
  return k - 1;
}

/** BN int_distribution::sample(scale) */
export function sampleDistribution(d: IntDistribution | undefined, rng: Rng, scale = 1): number {
  // BN's default max is int_distribution(INT_MAX); unscaled it means "no limit".
  if (d === undefined) return INT_MAX;
  if (typeof d === 'number') return d * scale;
  if (Array.isArray(d)) return rng.int(d[0] * scale, d[1] * scale);
  if ('poisson' in d) return poisson(rng, d.poisson * scale);
  // chance_distribution: (chance * scale) >= rng_float(0, 1)
  return d.chance * scale >= rng.next() ? 1 : 0;
}

/** BN z_constraints::check */
export function zAllows(c: ZConstraint | undefined, z: number, zMin: number, zMax: number): boolean {
  if (c === undefined) return true;
  if (typeof c === 'number') return z === c;
  if (Array.isArray(c)) return z >= c[0] && z <= c[1];
  if (c === 'top') return z >= zMax;
  if (c === 'bottom') return z <= zMin;
  return (c.top !== undefined && z === c.top + zMax) || (c.bottom !== undefined && z === c.bottom + zMin);
}

// ---------------------------------------------------------------------------------------
// Finalized definition (BN mutable_overmap_special_data::finalize)

interface FJoin {
  id: string;
  opposite: FJoin;
  into: readonly string[];
  /** index in the special's joins list: lower resolves first */
  priority: number;
}
interface FTerrainJoin {
  join: FJoin;
  type: MutableTerrainJoin['type'];
  alternatives: FJoin[];
}
interface FTerrain {
  key: string;
  def: MutableOvermapDef;
  locations: readonly string[];
  joins: [CubeDir, FTerrainJoin][];
}
interface FPiece {
  ter: FTerrain;
  pos: [number, number, number];
  rot: number;
}
interface FRule {
  src: MutablePlacementRule;
  pieces: FPiece[];
  outward: { pos: [number, number, number]; dir: CubeDir; tj: FTerrainJoin }[];
}
interface FSpecial {
  def: MutableSpecialDef;
  terrains: Map<string, FTerrain>;
  phases: FRule[][];
}

const finalized = new WeakMap<MutableSpecialDef, FSpecial>();

/** Resolve ids and precompute outward joins; throws on the errors BN's check() reports. */
export function finalizeMutable(def: MutableSpecialDef): FSpecial {
  const cached = finalized.get(def);
  if (cached) return cached;
  const ctx = `mutable special ${def.id}`;
  const joins = new Map<string, FJoin>();
  def.joins.forEach((j: MutableJoinDef, i) => {
    if (joins.has(j.id)) throw new Error(`${ctx}: duplicate join id ${j.id}`);
    joins.set(j.id, { id: j.id, opposite: undefined as unknown as FJoin, into: j.into_locations?.length ? j.into_locations : def.locations, priority: i });
  });
  for (const j of def.joins) {
    const fj = joins.get(j.id)!;
    const opp = joins.get(j.opposite ?? j.id);
    if (!opp) throw new Error(`${ctx}: join ${j.id} names unknown opposite ${j.opposite}`);
    if ((def.joins.find((k) => k.id === opp.id)!.opposite ?? opp.id) !== j.id) throw new Error(`${ctx}: join ${j.id}'s opposite ${opp.id} does not point back`);
    fj.opposite = opp;
  }
  const join = (id: string, where: string) => {
    const j = joins.get(id);
    if (!j) throw new Error(`${ctx}: ${where} uses unknown join ${id}`);
    return j;
  };
  const terrains = new Map<string, FTerrain>();
  for (const [key, o] of Object.entries(def.overmaps)) {
    const tjs: [CubeDir, FTerrainJoin][] = [];
    for (const d of CUBE_DIRS) {
      const tj = o.joins[d];
      if (!tj) continue;
      tjs.push([d, { join: join(tj.id, `overmap ${key}`), type: tj.type, alternatives: (tj.alternatives ?? []).map((a) => join(a, `overmap ${key}`)) }]);
    }
    terrains.set(key, { key, def: o, locations: o.locations?.length ? o.locations : def.locations, joins: tjs });
  }
  if (!terrains.has(def.root)) throw new Error(`${ctx}: root ${def.root} is not one of its overmaps`);
  const phases = def.phases.map((phase) => phase.map((rule): FRule => {
    if (!rule.pieces.length) throw new Error(`${ctx}: rule with no pieces`);
    if (rule.join !== undefined) join(rule.join, 'a rule');
    if (rule.scale !== undefined && !(rule.scale in def.shared)) throw new Error(`${ctx}: rule scales by unknown shared ${rule.scale}`);
    const pieces = rule.pieces.map((p): FPiece => {
      const ter = terrains.get(p.overmap);
      if (!ter) throw new Error(`${ctx}: phase specifies overmap ${p.overmap} which is not defined for that special`);
      return { ter, pos: p.pos, rot: p.rot };
    });
    const byPos = new Map(pieces.map((p) => [posKey(...p.pos), p]));
    if (byPos.size !== pieces.length) throw new Error(`${ctx}: chunk with duplicated position`);
    const outward: FRule['outward'] = [];
    for (const piece of pieces) {
      for (const [d, tj] of piece.ter.joins) {
        const dir = rotateDir(d, piece.rot);
        const other = opposite({ x: piece.pos[0], y: piece.pos[1], z: piece.pos[2], dir });
        const op = byPos.get(posKey(other.x, other.y, other.z));
        if (!op) outward.push({ pos: piece.pos, dir, tj });
        else if (tj.type === 'mandatory') {
          // BN only debugmsgs here; inside a chunk the faces must agree.
          const back = op.ter.joins.find(([od]) => rotateDir(od, op.rot) === other.dir);
          if (!back || back[1].join.id !== tj.join.opposite.id) throw new Error(`${ctx}: chunk pieces ${piece.ter.key} and ${op.ter.key} have mismatched joins`);
        }
      }
    }
    return { src: rule, pieces, outward };
  }));
  const f = { def, terrains, phases };
  finalized.set(def, f);
  return f;
}

// ---------------------------------------------------------------------------------------
// joins_tracker

interface TJoin {
  where: PosDir;
  type: MutableTerrainJoin['type'];
  join: FJoin;
}

class IndexedJoins {
  readonly byKey = new Map<string, TJoin>();
  find(p: PosDir): TJoin | undefined {
    return this.byKey.get(keyOf(p));
  }
  allAt(x: number, y: number, z: number): TJoin[] {
    const out: TJoin[] = [];
    for (const dir of CUBE_DIRS) {
      const j = this.byKey.get(keyOf({ x, y, z, dir }));
      if (j) out.push(j);
    }
    return out;
  }
  anyAt(x: number, y: number, z: number): boolean {
    return this.allAt(x, y, z).length > 0;
  }
  add(j: TJoin): void {
    const k = keyOf(j.where);
    if (this.byKey.has(k)) throw new Error(`mutable special: join added twice at ${k}`);
    this.byKey.set(k, j);
  }
  erase(p: PosDir): TJoin | undefined {
    const k = keyOf(p);
    const j = this.byKey.get(k);
    if (j) this.byKey.delete(k);
    return j;
  }
}

type JoinStatus = 'disallowed' | 'matched_available' | 'matched_non_available' | 'mismatched_available' | 'free';

class JoinsTracker {
  private unresolved = new IndexedJoins();
  /** priority -> keys of unresolved joins with that priority */
  private byPriority: Set<string>[] = [];
  private resolved = new IndexedJoins();
  private postponed = new IndexedJoins();
  readonly used: [number, number, number, CubeDir, string][] = [];

  anyUnresolved(): boolean {
    return this.unresolved.byKey.size > 0;
  }
  mandatoryAmountAt(x: number, y: number, z: number): number {
    return this.unresolved.allAt(x, y, z).filter((j) => j.type === 'mandatory').length;
  }
  allUnresolvedAt(x: number, y: number, z: number): TJoin[] {
    return this.unresolved.allAt(x, y, z);
  }
  isFinished(): boolean {
    for (const j of this.postponed.byKey.values()) if (j.type === 'mandatory') return false;
    return true;
  }
  openMandatory(): number {
    let n = 0;
    for (const j of this.postponed.byKey.values()) if (j.type === 'mandatory') n++;
    for (const j of this.unresolved.byKey.values()) if (j.type === 'mandatory') n++;
    return n;
  }
  anyPostponedAt(x: number, y: number, z: number): boolean {
    return this.postponed.anyAt(x, y, z);
  }

  allows(thisSide: PosDir, tj: FTerrainJoin): JoinStatus {
    const existing = this.resolved.find(opposite(thisSide));
    if (!existing) return 'free';
    const candidate = existing.join.id;
    const allowedOpposite = tj.join.opposite.id === candidate || tj.alternatives.some((a) => a.opposite.id === candidate);
    if (allowedOpposite) {
      if (existing.type === 'mandatory') return 'matched_non_available';
      if (existing.type === 'reject' || tj.type === 'reject') return 'disallowed';
      return 'matched_available';
    }
    if (existing.type === 'mandatory' || tj.type === 'mandatory') return 'disallowed';
    return 'mismatched_available';
  }

  addJoinsFor(ter: FTerrain, x: number, y: number, z: number, rot: number, suppressed: PosDir[]): void {
    const avoid = new Set(suppressed.map(keyOf));
    for (const [d, tj] of ter.joins) {
      const thisSide: PosDir = { x, y, z, dir: rotateDir(d, rot) };
      const otherSide = opposite(thisSide);
      const otherJoin = this.resolved.find(otherSide);
      if (otherJoin) {
        this.eraseUnresolved(thisSide);
        if (!avoid.has(keyOf(thisSide))) {
          this.used.push([otherSide.x, otherSide.y, otherSide.z, otherSide.dir, otherJoin.join.id]);
          // BN records the opposite of what was actually there (it may have been an alternative).
          this.used.push([x, y, z, thisSide.dir, otherJoin.join.opposite.id]);
        }
      } else {
        // Joins postponed on the OMT this one points into may be satisfiable now.
        this.restorePostponedAt(otherSide.x, otherSide.y, otherSide.z);
        if (tj.type === 'mandatory' || tj.type === 'optional') this.addUnresolved({ where: otherSide, type: tj.type, join: tj.join.opposite });
      }
      this.resolved.add({ where: thisSide, type: tj.type, join: tj.join });
    }
  }

  pickTopPriority(rng: Rng): { x: number; y: number; z: number } {
    const set = this.byPriority.find((s) => s && s.size > 0);
    if (!set) throw new Error('mutable special: pickTopPriority with nothing unresolved');
    // BN keeps each priority bucket as a flat_set ordered by position and takes random_entry.
    const entries = [...set].map((k) => this.unresolved.byKey.get(k)!.where).sort(comparePosDir);
    const w = entries[Math.floor(rng.next() * entries.length)];
    return { x: w.x, y: w.y, z: w.z };
  }

  postpone(x: number, y: number, z: number): void {
    for (const j of this.unresolved.allAt(x, y, z)) {
      this.postponed.add(j);
      this.eraseUnresolved(j.where);
    }
  }
  private restorePostponedAt(x: number, y: number, z: number): void {
    for (const j of this.postponed.allAt(x, y, z)) {
      this.postponed.erase(j.where);
      this.addUnresolved(j);
    }
  }
  restorePostponed(): void {
    const all = [...this.postponed.byKey.values()];
    this.postponed = new IndexedJoins();
    for (const j of all) this.addUnresolved(j);
  }

  private addUnresolved(j: TJoin): void {
    this.unresolved.add(j);
    (this.byPriority[j.join.priority] ??= new Set()).add(keyOf(j.where));
  }
  private eraseUnresolved(p: PosDir): boolean {
    const j = this.unresolved.erase(p);
    if (!j) return false;
    this.byPriority[j.join.priority].delete(keyOf(p));
    return true;
  }
}

// ---------------------------------------------------------------------------------------
// Phases (mutable_overmap_phase_remainder)

interface RuleRemainder {
  rule: FRule;
  max: number;
  weight: number;
}
const ruleWeight = (r: RuleRemainder) => Math.min(r.max, r.weight);
const ruleName = (r: FRule) => r.src.name ?? (r.pieces.length === 1 ? r.pieces[0].ter.key : `chunk using overmap ${r.pieces[0].ter.key}`);

interface Candidate {
  ter: FTerrain;
  x: number;
  y: number;
  z: number;
  rot: number;
}
function rulePieces(rule: FRule, ox: number, oy: number, oz: number, rot: number): Candidate[] {
  return rule.pieces.map((p) => {
    const [dx, dy] = rotateOffset(p.pos[0], p.pos[1], rot);
    return { ter: p.ter, x: ox + dx, y: oy + dy, z: oz + p.pos[2], rot: (rot + p.rot) % 4 };
  });
}

interface CanPlace {
  shortfall: number;
  mine: number;
  suppressed: PosDir[];
}
/** BN can_place_result ordering: (context mandatory joins matched, my mandatory joins matched). */
const cmp = (a: CanPlace, b: CanPlace) => a.shortfall - b.shortfall || a.mine - b.mine;

function canPlace(grid: MutableGrid, rule: FRule, ox: number, oy: number, oz: number, rot: number, joins: JoinsTracker): CanPlace | null {
  const required = rule.src.join;
  let haveRequired = required === undefined;
  let shortfall = 0;
  for (const p of rulePieces(rule, ox, oy, oz, rot)) {
    if (!grid.inbounds(p.x, p.y, p.z)) return null;
    if (!grid.isAmong(p.x, p.y, p.z, p.ter.locations)) return null;
    if (joins.anyPostponedAt(p.x, p.y, p.z)) return null;
    if (!haveRequired && p.ter.joins.some(([, tj]) => tj.join.id === required)) haveRequired = true;
    shortfall -= joins.mandatoryAmountAt(p.x, p.y, p.z);
  }
  if (!haveRequired) return null;
  let mine = 0;
  const suppressed: PosDir[] = [];
  for (const o of rule.outward) {
    const [dx, dy] = rotateOffset(o.pos[0], o.pos[1], rot);
    const pd: PosDir = { x: ox + dx, y: oy + dy, z: oz + o.pos[2], dir: rotateDir(o.dir, rot) };
    switch (joins.allows(pd, o.tj)) {
      case 'disallowed':
        return null;
      case 'matched_non_available':
        shortfall++;
        if (o.tj.type === 'mandatory') mine++;
        continue;
      case 'matched_available':
        if (o.tj.type === 'mandatory') mine++;
        continue;
      case 'mismatched_available':
        suppressed.push(pd);
        if (o.tj.join.id === required) return null;
        break;
      case 'free':
        if (o.tj.join.id === required) return null;
        break;
    }
    if (o.tj.type !== 'mandatory') continue;
    // An open mandatory join must lead somewhere it could later be satisfied.
    const n = opposite(pd);
    if (!grid.inbounds(n.x, n.y, n.z)) return null;
    if (!grid.isAmong(n.x, n.y, n.z, o.tj.join.into)) return null;
  }
  return { shortfall, mine, suppressed };
}

interface Satisfied {
  rule: RuleRemainder;
  ox: number;
  oy: number;
  oz: number;
  rot: number;
  suppressed: PosDir[];
}

function satisfy(grid: MutableGrid, rules: RuleRemainder[], x: number, y: number, z: number, joins: JoinsTracker,
  rotatable: boolean, zMin: number, zMax: number, rng: Rng): Satisfied | null {
  const options: [Satisfied, number][] = [];
  for (const r of rules) {
    if (!zAllows(r.rule.src.z, z, zMin, zMax)) continue;
    let best: CanPlace = { shortfall: 0, mine: 0, suppressed: [] };
    let here: Satisfied[] = [];
    for (let rot = 0; rot < 4; rot++) {
      for (const p of r.rule.pieces) {
        const [dx, dy] = rotateOffset(p.pos[0], p.pos[1], rot);
        const ox = x - dx, oy = y - dy, oz = z - p.pos[2];
        const res = canPlace(grid, r.rule, ox, oy, oz, rot, joins);
        if (!res) continue;
        // BN starts best_result at {0, 0}, so a placement that leaves one of the mandatory
        // joins on its own OMTs unmatched (negative shortfall) is never a candidate.
        if (cmp(best, res) < 0) (here = []), (best = res);
        if (cmp(res, best) === 0) here.push({ rule: r, ox, oy, oz, rot, suppressed: res.suppressed });
      }
      if (r.rule.src.rotate !== undefined ? !r.rule.src.rotate : !rotatable) break;
    }
    if (here.length) options.push([here[Math.floor(rng.next() * here.length)], ruleWeight(r)]);
  }
  // weighted_int_list::pick: zero-weight (exhausted) rules can't be chosen.
  const live = options.filter(([, w]) => w > 0);
  if (!live.length) return null;
  const picked = rng.weighted(live);
  picked.rule.max--;
  return picked;
}

// ---------------------------------------------------------------------------------------
// Placement (mutable_overmap_special_data::place)

/**
 * Grow `def` from its root at (ox, oy, oz) turned by `rot` (0..3). Writes terrain through
 * `grid` as it goes, exactly like BN; never fails, but reports open joins.
 * `rotatable` is the special's own "rotate" flag (rules may override it).
 */
export function placeMutable(def: MutableSpecialDef, grid: MutableGrid, rng: Rng, ox: number, oy: number, oz: number, rot: number,
  rotatable = def.rotate): MutablePlacement {
  const f = finalizeMutable(def);
  const joins = new JoinsTracker();
  const placed: PlacedPiece[] = [];
  const connections: PlacedConnection[] = [];
  const log: string[] = [];
  const scales: Record<string, number> = {};
  for (const [k, d] of Object.entries(def.shared)) scales[k] = sampleDistribution(d, rng);
  let zMin = Infinity, zMax = -Infinity;
  const addTer = (ter: FTerrain, x: number, y: number, z: number, r: number, suppressed: PosDir[]) => {
    grid.set(x, y, z, ter.def.overmap, r);
    joins.addJoinsFor(ter, x, y, z, r, suppressed);
    placed.push({ x, y, z, overmap: ter.key, rot: r });
    zMin = Math.min(zMin, z);
    zMax = Math.max(zMax, z);
    for (const d of CUBE_DIRS) {
      const conn = ter.def.connections?.[d];
      if (!conn) continue;
      const dir = rotateDir(d, r);
      const [dx, dy, dz] = DISPLACE[dir];
      if (grid.inbounds(x + dx, y + dy, z + dz)) connections.push({ connection: conn, x: x + dx, y: y + dy, z: z + dz, dir });
    }
  };
  const realise = (phase: FRule[]): RuleRemainder[] => phase.map((rule) => ({
    rule,
    max: rule.src.max === undefined ? INT_MAX : sampleDistribution(rule.src.max, rng, rule.src.scale !== undefined ? scales[rule.src.scale] : 1),
    weight: rule.src.weight ?? INT_MAX,
  }));

  addTer(f.terrains.get(def.root)!, ox, oy, oz, rot, []);
  let phase = 0;
  let remaining = f.phases.length ? realise(f.phases[0]) : [];
  while (f.phases.length && joins.anyUnresolved()) {
    const p = joins.pickTopPriority(rng);
    const s = satisfy(grid, remaining, p.x, p.y, p.z, joins, rotatable, zMin, zMax, rng);
    if (s) {
      log.push(`at ${p.x},${p.y},${p.z} chose '${ruleName(s.rule.rule)}' rot ${s.rot}`);
      for (const c of rulePieces(s.rule.rule, s.ox, s.oy, s.oz, s.rot)) addTer(c.ter, c.x, c.y, c.z, c.rot, s.suppressed);
    } else {
      log.push(`at ${p.x},${p.y},${p.z} (${grid.describe?.(p.x, p.y, p.z) ?? '?'}) nothing fits [${joins.allUnresolvedAt(p.x, p.y, p.z).map((j) => `${j.where.dir}: ${j.join.id}`).join(', ')}]; postponed`);
      joins.postpone(p.x, p.y, p.z);
    }
    if (!joins.anyUnresolved() || remaining.every((r) => ruleWeight(r) === 0)) {
      if (++phase >= f.phases.length) break;
      log.push(`## entering phase ${phase}`);
      remaining = realise(f.phases[phase]);
      joins.restorePostponed();
    }
  }
  return { placed, connections, joinsUsed: joins.used, bnUnresolved: !joins.isFinished(), openMandatory: joins.openMandatory(), log };
}

/** BN overmap_special::required_locations for a mutable special (check_for_locations or the root). */
export function mutableRequiredLocations(def: MutableSpecialDef): { p: [number, number, number]; locations: string[] }[] {
  if (def.checkForLocations.length) return def.checkForLocations;
  const root = def.overmaps[def.root];
  if (!root) throw new Error(`mutable special ${def.id}: root ${def.root} is not one of its overmaps`);
  return [{ p: [0, 0, 0], locations: root.locations?.length ? root.locations : def.locations }];
}

/** Every oter id a mutable special can write (for the extractor and render checks). */
export function mutableTerrains(def: MutableSpecialDef): string[] {
  return [...new Set(Object.values(def.overmaps).map((o) => o.overmap))];
}

// ---------------------------------------------------------------------------------------
// Grow without committing (the classic Lab's lab_basement)

/** Read-only view of a region, for callers that grow into a scratch overlay and commit later. */
export interface MutableReadHost {
  /** oter type id at a point (no rotation suffix) */
  terrainAt(x: number, y: number, z: number): string;
  inbounds(x: number, y: number, z: number): boolean;
  /** overmap_location id -> oter types it accepts */
  location(id: string): Set<string> | undefined;
  /** BN get_default_terrain(z) (can_place_special also accepts it below ground) */
  defaultTerrain(z: number): string;
}

export interface OverlayPlacement {
  x: number;
  y: number;
  z: number;
  /** oter type id the special wrote */
  type: string;
  /** the id as the special names it (may carry a direction suffix) */
  oter: string;
  /** turns the piece was placed with (callers drop it for NO_ROTATE oters) */
  rot: number;
}

/** BN int_distribution::sample(scale), argument order of the lab grower's original API. */
export const sampleDist = (d: IntDistribution | undefined, scale: number, rng: Rng) => sampleDistribution(d, rng, scale);

/**
 * A mutable special grown into a scratch overlay: `grow` reads the host but never writes it, so
 * a caller can regrow with another RNG (placeLabBasement retries until the escape cells appear)
 * and then commit `placed` itself. Same solver as placeMutable.
 */
export class MutableSpecial {
  constructor(readonly def: MutableSpecialDef) {
    finalizeMutable(def);
  }

  /** BN can_place_special's test of the special's required locations. */
  canPlace(host: MutableReadHost, origin: { x: number; y: number; z: number }, rot: number): boolean {
    return mutableRequiredLocations(this.def).every((c) => {
      const [dx, dy] = rotateOffset(c.p[0], c.p[1], rot);
      const x = origin.x + dx, y = origin.y + dy, z = origin.z + c.p[2];
      if (!host.inbounds(x, y, z)) return false;
      const t = host.terrainAt(x, y, z);
      return c.locations.some((l) => host.location(l)?.has(t)) || (z !== 0 && t === host.defaultTerrain(z));
    });
  }

  grow(host: MutableReadHost, origin: { x: number; y: number; z: number }, rot: number, rng: Rng, rotatable = this.def.rotate ?? true) {
    const overlay = new Map<string, string>();
    const placed: OverlayPlacement[] = [];
    const typeOf = (oter: string) => {
      // the overlay stores the type, like the host: strip a direction suffix if the special wrote one
      for (const s of ['_north', '_east', '_south', '_west']) if (oter.endsWith(s)) return oter.slice(0, -s.length);
      return oter;
    };
    const grid: MutableGrid = {
      inbounds: (x, y, z) => host.inbounds(x, y, z),
      isAmong: (x, y, z, locs) => {
        const t = overlay.get(posKey(x, y, z)) ?? host.terrainAt(x, y, z);
        return locs.some((l) => host.location(l)?.has(t));
      },
      set: (x, y, z, oter, r) => {
        const k = posKey(x, y, z);
        if (overlay.has(k)) throw new Error(`${this.def.id}: placed two terrains at ${k}`);
        overlay.set(k, typeOf(oter));
        placed.push({ x, y, z, type: typeOf(oter), oter, rot: r });
      },
      describe: (x, y, z) => overlay.get(posKey(x, y, z)) ?? host.terrainAt(x, y, z),
    };
    const res = placeMutable(this.def, grid, rng, origin.x, origin.y, origin.z, rot, rotatable);
    return { placed, connections: res.connections, joinsUsed: res.joinsUsed, unresolvedMandatory: res.openMandatory, bnUnresolved: res.bnUnresolved };
  }
}
