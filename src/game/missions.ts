import type { Rng } from '../core/rng';
import type { GameData } from '../data/types';
import { itemName } from '../data/index';
import { warnOnce } from '../data/warn';
import type { MissionDef, Npc, NpcData } from './npc';
import type { Dialogue, TalkPlayer } from './talk';
import { omtMatches, parseDuration } from './talk';

// NPC missions (mission.cpp / missiondef.cpp), a subset of goals:
//   MGOAL_FIND_ITEM / FIND_ANY_ITEM   bring `count` of `item` (handed over on success)
//   MGOAL_KILL_MONSTER_TYPE / _SPEC   kill `monster_kill_goal` of a type / species after accepting
//   MGOAL_KILL_MONSTER                kill the "target" monster the mission's update_mapgen places
//   MGOAL_GO_TO / GO_TO_TYPE          reach the assigned target OMT / an OMT of `destination`
//   MGOAL_ASSASSINATE                 the target NPC is dead
//   MGOAL_CONDITION                   goal_condition (dialogue condition) holds
// Everything else never completes (warned once). Instances are plain data (toJSON) so the
// save system can persist them; the host supplies world queries.

export type MissionStatus = 'available' | 'active' | 'succeeded' | 'failed';

export interface MissionInstance {
  uid: number;
  /** mission_definition id */
  id: string;
  /** Giver (Npc.uid), or -1 for missions without one. */
  npcUid: number;
  status: MissionStatus;
  assignedAt?: number;
  /** Game seconds; missions past it fail. */
  deadline?: number;
  /** Target OMT (chunk coordinates) from assign_mission_target. */
  target?: { x: number; y: number; z: number };
  /** Kill counter value (type or species) when accepted. */
  killsBaseline?: number;
  /** MGOAL_KILL_MONSTER: the monster placed by update_mapgen with "target": true. */
  targetMonster?: { group?: string; monster?: string; name?: string; x: number; y: number; z: number; spawned: boolean; dead: boolean; uid?: number };
  targetNpcUid?: number;
}

export interface MissionHost {
  data: GameData;
  nd: NpcData;
  rng: Rng;
  now(): number;
  player: TalkPlayer;
  message(text: string, color?: string): void;
  npcByUid(uid: number): Npc | undefined;
  /** Kills by the survivor so far: of a monster type, or of a species. */
  killsOf(monsterId: string): number;
  killsOfSpecies(species: string): number;
  /** Overmap terrain id at an OMT (z level). */
  omtAt?(x: number, y: number, z: number): string | undefined;
  /** Nearest OMT (z0) satisfying `pred` within `maxDist` OMTs of `from` (or a random one). */
  findOmt?(pred: (omtId: string) => boolean, from: { x: number; y: number }, opts: { minDist?: number; maxDist?: number; random?: boolean }): { x: number; y: number } | null;
  /** Rotation (quarter turns) of the OMT's mapgen, so update_mapgen coordinates land right. */
  omtRotation?(x: number, y: number, z: number): number;
  /** Reveal overmap tiles around an OMT (reveal_radius). */
  reveal?(x: number, y: number, radius: number): void;
  /**
   * Run an update_mapgen (id, or inline object) on the live map at an OMT. False if it
   * couldn't run (unknown id, no world generator).
   */
  mapgenUpdate?(src: string | Record<string, unknown>, omt: { x: number; y: number; z: number }, opts?: { dropMissionTargets?: boolean }): boolean;
  /** A dialogue with `npc` for running mission effects outside a conversation. */
  dialogueFor(npc: Npc | undefined): Dialogue | null;
}

export class MissionSystem {
  readonly all = new Map<number, MissionInstance>();
  private nextUid = 1;

  constructor(readonly host: MissionHost) {}

  get(uid: number): MissionInstance | undefined {
    return this.all.get(uid);
  }
  def(inst: MissionInstance): MissionDef | undefined {
    return this.host.nd.missions[inst.id];
  }

  /** mission::reserve_new: an unassigned mission offered by `npc`. */
  create(defId: string, npc: Npc | null): MissionInstance | null {
    const def = this.host.nd.missions[defId];
    if (!def) {
      warnOnce('mission', defId);
      return null;
    }
    const inst: MissionInstance = { uid: this.nextUid++, id: defId, npcUid: npc ? npc.uid : -1, status: 'available' };
    this.all.set(inst.uid, inst);
    if (npc) npc.missionIds.push(inst.uid);
    return inst;
  }

  offeredBy(npc: Npc): MissionInstance[] {
    return npc.missionIds.map((u) => this.all.get(u)).filter((m): m is MissionInstance => !!m && m.status === 'available');
  }
  /** Missions from `npc` the survivor is working on (or failed and hasn't reported). */
  assignedFrom(npc: Npc): MissionInstance[] {
    return [...this.all.values()].filter((m) => m.npcUid === npc.uid && (m.status === 'active' || m.status === 'failed'));
  }
  active(): MissionInstance[] {
    return [...this.all.values()].filter((m) => m.status === 'active');
  }
  playerHasMission(defId: string): boolean {
    return [...this.all.values()].some((m) => m.id === defId && m.status === 'active');
  }
  findActive(defId: string): MissionInstance | undefined {
    return [...this.all.values()].find((m) => m.id === defId && m.status === 'active');
  }
  completedValue(npc: Npc): number {
    let v = 0;
    for (const m of this.all.values()) if (m.npcUid === npc.uid && m.status === 'succeeded') v += this.def(m)?.value ?? 0;
    return v;
  }

  /** chatbin.check_missions: fail missions past their deadline. */
  checkMissions(npc?: Npc): void {
    const now = this.host.now();
    for (const m of this.all.values()) {
      if (npc && m.npcUid !== npc.uid) continue;
      if (m.status === 'active' && m.deadline !== undefined && now > m.deadline) this.fail(m, null);
    }
  }

  /** mission::assign: run the start effects, pick the target, remember kill baselines. */
  assign(m: MissionInstance, d: Dialogue | null): void {
    if (m.status !== 'available') return;
    const def = this.def(m);
    if (!def) return;
    const h = this.host;
    m.status = 'active';
    m.assignedAt = h.now();
    if (def.deadline !== undefined) {
      const dl = Array.isArray(def.deadline) ? def.deadline : [def.deadline, def.deadline];
      const lo = durationOf(dl[0]), hi = durationOf(dl[1]);
      if (lo > 0) m.deadline = h.now() + h.rng.int(Math.round(lo), Math.round(Math.max(lo, hi)));
    }
    if (def.goal === 'MGOAL_KILL_MONSTER_TYPE' && def.monster_type) m.killsBaseline = h.killsOf(def.monster_type);
    if (def.goal === 'MGOAL_KILL_MONSTER_SPEC' && def.monster_species) m.killsBaseline = h.killsOfSpecies(def.monster_species);
    const npc = m.npcUid >= 0 ? h.npcByUid(m.npcUid) : undefined;
    const dlg = d ?? h.dialogueFor(npc);
    const start = def.start;
    if (typeof start === 'string') {
      // Hardcoded mission_start functions: only the ones that point somewhere.
      if (start === 'reveal_refugee_center') this.assignTarget(m, { om_terrain: 'evac_center_18', reveal_radius: 3, search_range: 160 }, npc);
      else warnOnce('mission_start', start, `[missions] hardcoded mission start "${start}" is unsupported`);
    }
    else if (start && typeof start === 'object') {
      if (start.assign_mission_target) this.assignTarget(m, start.assign_mission_target, npc);
      // mission_type::parse_funcs: talk effects first, then the update_mapgen functions
      if (start.effect !== undefined) dlg?.effect(start.effect);
      if (start.update_mapgen) {
        this.readTargetMonster(m, start.update_mapgen);
        this.runUpdateMapgen(m, start.update_mapgen, npc);
      }
    }
    if (!m.target && (def.goal === 'MGOAL_GO_TO') && def.destination) this.assignTarget(m, { om_terrain: def.destination }, npc);
    const name = def.name ?? m.id;
    h.message(`New mission: ${name}`, 'c_light_green');
    if (npc) npc.missionSelected = m.uid;
  }

  /** assign_mission_target: nearest (or random within search_range) OMT of the terrain type. */
  private assignTarget(m: MissionInstance, t: any, npc: Npc | undefined): void {
    const found = this.findTarget(t, npc, m.id);
    m.target = found;
    this.host.reveal?.(found.x, found.y, t.reveal_radius ?? 1);
  }

  /**
   * mission_util::get_om_terrain_pos: the OMT a mission_target_params object names - the
   * nearest `om_terrain` from the survivor (or the NPC with origin_npc), plus offsets; no
   * om_terrain = the origin's own OMT. Also used by dialogue `mapgen_update`.
   */
  findTarget(t: any, npc: Npc | undefined, what = 'mapgen_update'): { x: number; y: number; z: number } {
    const h = this.host;
    const terrain: string | undefined = typeof t.om_terrain === 'string' ? t.om_terrain : undefined;
    const origin = t.origin_npc && npc ? npc : h.player;
    const from = { x: Math.floor(origin.x / 24), y: Math.floor(origin.y / 24) };
    const z = typeof t.z === 'number' ? t.z : terrain ? 0 : Math.round(origin.z);
    let found: { x: number; y: number } | null = null;
    if (!terrain) found = from;
    else if (h.findOmt) {
      const match = t.om_terrain_match_type ?? 'TYPE';
      const pred = (id: string) => (match === 'PREFIX' ? id.startsWith(terrain) : match === 'CONTAINS' ? id.includes(terrain) : match === 'EXACT' ? id === terrain : omtMatches(id, terrain));
      found = h.findOmt(pred, from, { minDist: t.min_distance ?? 0, maxDist: t.search_range ?? 80, random: !!t.random });
    }
    if (!found) {
      warnOnce('mission_target', `${what}:${terrain}`, `[missions] ${what}: no "${terrain}" found near the survivor; using a spot nearby`);
      found = { x: from.x + h.rng.int(-6, 6) || 5, y: from.y + h.rng.int(-6, 6) || 5 };
    }
    return { x: found.x + (t.offset_x ?? 0), y: found.y + (t.offset_y ?? 0), z };
  }

  /**
   * A mission's own start/end/fail "update_mapgen" (inline objects with an om_terrain to
   * find near the mission target). "target": true monsters stay with readTargetMonster.
   */
  private runUpdateMapgen(m: MissionInstance, um: any, npc: Npc | undefined): void {
    if (!this.host.mapgenUpdate) return;
    for (const u of Array.isArray(um) ? um : [um]) {
      if (!u || typeof u !== 'object') continue;
      let at = m.target;
      if (typeof u.om_terrain === 'string' && this.host.findOmt) {
        const from = m.target ?? { x: Math.floor(this.host.player.x / 24), y: Math.floor(this.host.player.y / 24) };
        const f = this.host.findOmt((id) => omtMatches(id, u.om_terrain), from, { maxDist: 30 });
        if (f) at = { x: f.x, y: f.y, z: typeof u.z === 'number' ? u.z : 0 };
      }
      if (!at) at = this.findTarget(u, npc, m.id);
      this.host.mapgenUpdate(u, at, { dropMissionTargets: true });
    }
  }

  /** update_mapgen place_monster with "target": true -> the monster MGOAL_KILL_MONSTER is about. */
  private readTargetMonster(m: MissionInstance, um: any): void {
    for (const u of Array.isArray(um) ? um : [um]) {
      for (const pm of u?.place_monster ?? []) {
        if (!pm.target) continue;
        let tgt = m.target;
        if (u.om_terrain && this.host.findOmt) {
          const at = this.host.findOmt((id) => omtMatches(id, u.om_terrain), m.target ?? { x: Math.floor(this.host.player.x / 24), y: Math.floor(this.host.player.y / 24) }, { maxDist: 30 });
          if (at) tgt = { x: at.x, y: at.y, z: 0 };
        }
        if (!tgt) continue;
        let x = Array.isArray(pm.x) ? pm.x[0] : pm.x ?? 12, y = Array.isArray(pm.y) ? pm.y[0] : pm.y ?? 12;
        // Same convention as MapBuffer.rotate: each quarter turn maps (x, y) -> (23 - y, x).
        for (let t = this.host.omtRotation?.(tgt.x, tgt.y, tgt.z) ?? 0; t > 0; t--) [x, y] = [23 - y, x];
        m.targetMonster = { group: pm.group, monster: pm.monster, name: pm.name, x: tgt.x * 24 + x, y: tgt.y * 24 + y, z: tgt.z, spawned: false, dead: false };
      }
    }
  }

  /** mission::is_complete */
  isComplete(m: MissionInstance, npc?: Npc): boolean {
    const def = this.def(m);
    if (!def || m.status !== 'active') return m.status === 'succeeded';
    const h = this.host;
    const p = h.player;
    switch (def.goal) {
      case 'MGOAL_FIND_ITEM': case 'MGOAL_FIND_ANY_ITEM':
        return !!def.item && p.inv.countOf(def.item) >= (def.count ?? 1);
      case 'MGOAL_KILL_MONSTER_TYPE':
        return !!def.monster_type && h.killsOf(def.monster_type) - (m.killsBaseline ?? 0) >= (def.monster_kill_goal ?? 1);
      case 'MGOAL_KILL_MONSTER_SPEC':
        return !!def.monster_species && h.killsOfSpecies(def.monster_species) - (m.killsBaseline ?? 0) >= (def.monster_kill_goal ?? 1);
      case 'MGOAL_KILL_MONSTER':
        return !!m.targetMonster?.dead;
      case 'MGOAL_GO_TO': {
        const t = m.target;
        return !!t && Math.floor(p.x / 24) === t.x && Math.floor(p.y / 24) === t.y && p.z === t.z;
      }
      case 'MGOAL_GO_TO_TYPE': {
        if (!def.destination || !h.omtAt) return false;
        const id = h.omtAt(Math.floor(p.x / 24), Math.floor(p.y / 24), p.z);
        return !!id && omtMatches(id, def.destination);
      }
      case 'MGOAL_ASSASSINATE': {
        const t = m.targetNpcUid !== undefined ? h.npcByUid(m.targetNpcUid) : undefined;
        return !!t?.dead;
      }
      case 'MGOAL_CONDITION': {
        const d = h.dialogueFor(npc ?? (m.npcUid >= 0 ? h.npcByUid(m.npcUid) : undefined));
        return !!d && d.cond(def.goal_condition);
      }
    }
    warnOnce('mission_goal', def.goal, `[missions] goal ${def.goal} is unsupported (never completes)`);
    return false;
  }

  /** mission::wrap_up + step_complete: hand over items, run end effects, queue the follow-up. */
  succeed(m: MissionInstance, d: Dialogue | null): void {
    if (m.status !== 'active') return;
    const def = this.def(m);
    const h = this.host;
    const npc = m.npcUid >= 0 ? h.npcByUid(m.npcUid) : undefined;
    if (def && (def.goal === 'MGOAL_FIND_ITEM' || def.goal === 'MGOAL_FIND_ANY_ITEM') && def.item) {
      const n = def.count ?? 1;
      if (h.player.inv.countOf(def.item) >= n) {
        const items = h.player.inv.useAmount(def.item, n);
        if (npc) for (const it of items) {
          const left = npc.inv.stash(it);
          if (left) npc.stock.push(left);
        }
        h.message(`You hand over ${n > 1 ? `${n} ` : ''}${h.data.items[def.item] ? itemName(h.data.items[def.item], n) : def.item}.`);
      }
    }
    m.status = 'succeeded';
    const dlg = d ?? h.dialogueFor(npc);
    if (def?.end && typeof def.end === 'object') {
      if (def.end.effect !== undefined) dlg?.effect(def.end.effect);
      if (def.end.update_mapgen) this.runUpdateMapgen(m, def.end.update_mapgen, npc);
    }
    h.message(`Mission complete: ${def?.name ?? m.id}`, 'c_light_green');
    if (def?.followup && npc) this.create(def.followup, npc);
  }

  fail(m: MissionInstance, d: Dialogue | null): void {
    if (m.status !== 'active') return;
    const def = this.def(m);
    m.status = 'failed';
    const npc = m.npcUid >= 0 ? this.host.npcByUid(m.npcUid) : undefined;
    const dlg = d ?? this.host.dialogueFor(npc);
    if (def?.fail && typeof def.fail === 'object') {
      if (def.fail.effect !== undefined) dlg?.effect(def.fail.effect);
      if (def.fail.update_mapgen) this.runUpdateMapgen(m, def.fail.update_mapgen, npc);
    }
    this.host.message(`Mission failed: ${def?.name ?? m.id}`, 'c_light_red');
  }

  /** clear_mission: the giver forgets it (it stays in the log as succeeded/failed). */
  clear(m: MissionInstance, npc: Npc): void {
    npc.missionIds = npc.missionIds.filter((u) => u !== m.uid || m.status === 'available');
    if (m.status === 'active') m.status = 'failed';
  }

  /** Target monster bookkeeping: MonsterSystem death notifications call this. */
  onMonsterDied(uid: number): void {
    for (const m of this.all.values()) if (m.targetMonster && m.targetMonster.uid === uid) m.targetMonster.dead = true;
  }

  /** Missions without a giver (game-start ones) complete by themselves. */
  autoComplete(): void {
    for (const m of this.all.values()) if (m.status === 'active' && m.npcUid < 0 && this.isComplete(m)) this.succeed(m, null);
  }

  /** Human-readable goal line for the mission log. */
  goalText(m: MissionInstance): string {
    const def = this.def(m);
    if (!def) return m.id;
    const h = this.host;
    const p = h.player;
    switch (def.goal) {
      case 'MGOAL_FIND_ITEM': case 'MGOAL_FIND_ANY_ITEM': {
        const n = def.count ?? 1;
        const nm = def.item && h.data.items[def.item] ? itemName(h.data.items[def.item], n) : def.item;
        return `Find ${n > 1 ? `${n} ` : ''}${nm} (have ${def.item ? p.inv.countOf(def.item) : 0})`;
      }
      case 'MGOAL_KILL_MONSTER_TYPE': {
        const mon = def.monster_type ? h.data.monsters[def.monster_type] : undefined;
        const done = def.monster_type ? h.killsOf(def.monster_type) - (m.killsBaseline ?? 0) : 0;
        return `Kill ${def.monster_kill_goal ?? 1} ${mon ? (typeof mon.name === 'string' ? mon.name : (mon.name as { str: string }).str) : def.monster_type} (${Math.max(0, done)} so far)`;
      }
      case 'MGOAL_KILL_MONSTER_SPEC': {
        const done = def.monster_species ? h.killsOfSpecies(def.monster_species) - (m.killsBaseline ?? 0) : 0;
        return `Kill ${def.monster_kill_goal ?? 1} ${def.monster_species?.toLowerCase()} (${Math.max(0, done)} so far)`;
      }
      case 'MGOAL_KILL_MONSTER': return m.targetMonster ? `Kill ${m.targetMonster.name ?? 'the target'}${m.targetMonster.dead ? ' (done)' : ''}` : 'Kill the target';
      case 'MGOAL_GO_TO': case 'MGOAL_GO_TO_TYPE': return `Reach ${def.destination ?? 'the destination'}`;
      case 'MGOAL_ASSASSINATE': return 'Kill the target';
      case 'MGOAL_CONDITION': return def.description ?? 'Fulfil the request';
    }
    return def.description ?? def.goal;
  }

  toJSON(): { nextUid: number; missions: MissionInstance[] } {
    return { nextUid: this.nextUid, missions: [...this.all.values()].map((m) => structuredClone(m)) };
  }
  fromJSON(j: { nextUid: number; missions: MissionInstance[] }): void {
    this.all.clear();
    for (const m of j.missions) this.all.set(m.uid, structuredClone(m));
    this.nextUid = j.nextUid;
  }
}

function durationOf(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return parseDuration(v);
  return 0;
}
