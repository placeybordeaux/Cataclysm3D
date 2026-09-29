import type { GameData, ItemGroupRef, RecipeComponent, QualityRequirement } from '../data/types';
import { expandItemGroup } from '../data/itemgroups';
import { hasFlag } from '../world/registry';
import { CraftingInventory } from './crafting_inv';
import { giveOrDrop, hasCraftingLight, type CraftHost } from './crafting';
import { fromSpawned } from './item';
import { consumeRequirements, evaluateRequirements, type RequirementEval } from './requirements';
import { cddaText } from './units';

// Construction (construction.cpp): build/dig/board up/deconstruct on a tile next to you.
// Constructions come from misc.construction (requirements already expanded by the
// extractor) and are grouped by construction_group ("Build Wooden Wall" has several stages:
// half wall on empty ground, then the full wall on a half wall). CDDA keeps partial
// progress as a "partial construction" furniture; we simplify to all-or-nothing: components
// are taken when you start and handed back if you stop.

export interface ConstructionDef {
  id: string;
  group: string;
  category: string;
  required_skills?: [string, number][];
  time: number;
  components: RecipeComponent[][];
  tools: RecipeComponent[][];
  qualities: QualityRequirement[][];
  pre_terrain?: string | string[];
  pre_flags?: string | (string | { flag: string; force_terrain?: boolean })[];
  pre_special?: string | string[];
  post_terrain?: string;
  post_special?: string | string[];
  post_flags?: string[];
  byproducts?: ItemGroupRef;
  dark_craftable?: boolean;
  pre_note?: string;
  [k: string]: unknown;
}

export interface ConstructionGroup {
  id: string;
  name: string;
  constructions: ConstructionDef[];
}

const asList = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

const groupCache = new WeakMap<GameData, ConstructionGroup[]>();
/** Construction groups sorted by name, like CDDA's construction menu. */
export function constructionGroups(data: GameData): ConstructionGroup[] {
  let gs = groupCache.get(data);
  if (gs) return gs;
  const by = new Map<string, ConstructionGroup>();
  for (const c of Object.values((data.misc.construction ?? {}) as Record<string, ConstructionDef>)) {
    // Vehicle/appliance placement needs systems we don't have.
    if (c.category === 'APPLIANCE' || asList(c.post_special).some((s) => s === 'done_vehicle' || s === 'done_appliance')) continue;
    let g = by.get(c.group);
    if (!g) by.set(c.group, (g = { id: c.group, name: cddaText(data.misc.construction_group?.[c.group]?.name) || c.group, constructions: [] }));
    g.constructions.push(c);
  }
  gs = [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
  groupCache.set(data, gs);
  return gs;
}

export function getConstruction(data: GameData, id: string): ConstructionDef | undefined {
  return data.misc.construction?.[id] as ConstructionDef | undefined;
}

export function terOrFurnName(data: GameData, id: string): string {
  return cddaText((id.startsWith('f_') ? data.furniture[id] : data.terrain[id])?.name) || id;
}

// ------------------------------------------------------------------ site checks
function flagAt(host: CraftHost, x: number, y: number, z: number, flag: string): boolean {
  const t = host.map.terAt(x, y, z), f = host.map.furnAt(x, y, z);
  return hasFlag(t, flag) || (f.id !== 'f_null' && hasFlag(f, flag));
}

const PRE_SPECIALS: Record<string, (host: CraftHost, x: number, y: number, z: number) => boolean> = {
  check_empty: (h, x, y, z) => flagAt(h, x, y, z, 'FLAT') && h.map.furnAt(x, y, z).id === 'f_null' && h.map.itemsAt(x, y, z).length === 0,
  check_empty_lite: (h, x, y, z) => h.map.furnAt(x, y, z).id === 'f_null' && h.map.itemsAt(x, y, z).length === 0,
  check_unblocked: (h, x, y, z) => h.map.furnAt(x, y, z).id === 'f_null' && h.map.itemsAt(x, y, z).length === 0 && (h.map.passable(x, y, z) || h.map.terAt(x, y, z).id === 't_open_air'),
  check_support: (h, x, y, z) => {
    if (!h.map.passable(x, y, z)) return false;
    let n = 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (flagAt(h, x + dx, y + dy, z, 'SUPPORTS_ROOF') || flagAt(h, x + dx, y + dy, z - 1, 'SUPPORTS_ROOF')) n++;
    if (flagAt(h, x, y, z - 1, 'SUPPORTS_ROOF') && (flagAt(h, x, y, z - 1, 'WALL') || flagAt(h, x, y, z - 1, 'DOOR') || flagAt(h, x, y, z - 1, 'WINDOW'))) n += 2;
    return n >= 2;
  },
  check_single_support: (h, x, y, z) => h.map.passable(x, y, z) && flagAt(h, x, y, z - 1, 'SUPPORTS_ROOF'),
  check_stable: (h, x, y, z) => flagAt(h, x, y, z - 1, 'SUPPORTS_ROOF'),
  check_nofloor_above: (h, x, y, z) => flagAt(h, x, y, z + 1, 'NO_FLOOR'),
  check_floor_above: (h, x, y, z) => !flagAt(h, x, y, z + 1, 'NO_FLOOR'),
  check_deconstruct: (h, x, y, z) => {
    const f = h.map.furnAt(x, y, z);
    if (f.id !== 'f_null') return !hasFlag(f, 'EASY_DECONSTRUCT') && !!f.deconstruct;
    return !!h.map.terAt(x, y, z).deconstruct;
  },
  check_up_OK: (_h, _x, _y, z) => z < 10,
  check_down_OK: (_h, _x, _y, z) => z > -10,
  check_no_trap: () => true,
  check_no_wiring: () => true,
};

function preTerrainOk(host: CraftHost, con: ConstructionDef, x: number, y: number, z: number): boolean {
  const pre = asList(con.pre_terrain);
  if (!pre.length) return true;
  const isFurn = pre[0].startsWith('f_');
  const cur = isFurn ? host.map.furnAt(x, y, z).id : host.map.terAt(x, y, z).id;
  return pre.includes(cur);
}

function preFlagsOk(host: CraftHost, con: ConstructionDef, x: number, y: number, z: number): boolean {
  const t = host.map.terAt(x, y, z), f = host.map.furnAt(x, y, z);
  return asList(con.pre_flags).every((pf) => {
    const flag = typeof pf === 'string' ? pf : pf.flag;
    const useTer = (typeof pf !== 'string' && pf.force_terrain) || f.id === 'f_null';
    return useTer ? hasFlag(t, flag) : hasFlag(f, flag);
  });
}

/** can_construct(con, p): site conditions only (no skills/tools). */
export function siteOk(host: CraftHost, con: ConstructionDef, x: number, y: number, z: number): boolean {
  const p = host.player;
  if (x === Math.floor(p.x) && y === Math.floor(p.y) && z === p.z) return false;
  for (const s of asList(con.pre_special)) {
    const fn = PRE_SPECIALS[s];
    if (!fn || !fn(host, x, y, z)) return false;
  }
  if (!preTerrainOk(host, con, x, y, z) || !preFlagsOk(host, con, x, y, z)) return false;
  if (con.post_terrain) {
    const isFurn = con.post_terrain.startsWith('f_');
    const cur = isFurn ? host.map.furnAt(x, y, z).id : host.map.terAt(x, y, z).id;
    if (cur === con.post_terrain) return false;
  }
  return true;
}

export const ADJACENT: [number, number, string][] = [
  [0, -1, 'north'], [1, -1, 'northeast'], [1, 0, 'east'], [1, 1, 'southeast'],
  [0, 1, 'south'], [-1, 1, 'southwest'], [-1, 0, 'west'], [-1, -1, 'northwest'],
];

/** The tile the player faces (the one under the first-person crosshair at arm's length). */
export function facingTile(host: CraftHost): [number, number, number] {
  const p = host.player;
  const fx = Math.sin(p.yaw), fy = -Math.cos(p.yaw);
  return [Math.floor(p.x + fx * 0.9), Math.floor(p.y + fy * 0.9), p.z];
}

/** Adjacent tiles where `con` could be built (site conditions only). */
export function validSites(host: CraftHost, con: ConstructionDef): [number, number, number, string][] {
  const p = host.player;
  const px = Math.floor(p.x), py = Math.floor(p.y);
  return ADJACENT.filter(([dx, dy]) => siteOk(host, con, px + dx, py + dy, p.z)).map(([dx, dy, n]) => [px + dx, py + dy, p.z, n]);
}

export interface ConstructionCheck {
  ok: boolean;
  missing: string[];
  req: RequirementEval;
  skillsOk: boolean;
  light: boolean;
}

export function constructionInventory(host: CraftHost): CraftingInventory {
  const p = host.player;
  return CraftingInventory.gather(host.data, p, host.map, { x: p.x, y: p.y, z: p.z });
}

/** player_can_build: skills + tools/qualities/components (+ light unless dark_craftable). */
export function canBuild(host: CraftHost, con: ConstructionDef, inv = constructionInventory(host)): ConstructionCheck {
  const c = host.player;
  const req = evaluateRequirements(host.data, con, inv);
  const missing = [...req.missing];
  const skillsOk = (con.required_skills ?? []).every(([s, l]) => c.getSkill(s) >= l);
  if (!skillsOk) for (const [s, l] of con.required_skills ?? []) if (c.getSkill(s) < l) missing.push(`${c.skillName(s)} ${l}`);
  const light = !!con.dark_craftable || hasCraftingLight(host);
  if (!light) missing.push("It is too dark to construct right now.");
  return { ok: missing.length === 0, missing, req, skillsOk, light };
}

// ------------------------------------------------------------------ building
function applyPost(host: CraftHost, con: ConstructionDef, x: number, y: number, z: number): void {
  const data = host.data;
  // Items in the way get moved to a neighbouring tile unless the construction keeps them.
  if (!(con.post_flags ?? []).includes('keep_items')) {
    const items = [...host.map.itemsAt(x, y, z)];
    if (items.length) {
      const p = host.player;
      for (const it of items) {
        host.map.removeItem(x, y, z, it);
        host.map.addItem(Math.floor(p.x), Math.floor(p.y), p.z, it);
      }
    }
  }
  if (con.post_terrain) {
    if (con.post_terrain.startsWith('f_')) host.map.setFurn(x, y, z, con.post_terrain);
    else host.map.setTer(x, y, z, con.post_terrain);
  }
  for (const s of asList(con.post_special)) {
    if (s === 'done_deconstruct') {
      const f = host.map.furnAt(x, y, z);
      const d = f.id !== 'f_null' ? f.deconstruct : host.map.terAt(x, y, z).deconstruct;
      if (!d) continue;
      if (f.id !== 'f_null') host.map.setFurn(x, y, z, d.furn_set ?? 'f_null');
      else if (d.ter_set) host.map.setTer(x, y, z, d.ter_set);
      if (d.items) for (const sp of expandItemGroup(data, d.items, host.player.rng)) for (const it of fromSpawned(data, sp)) host.map.addItem(x, y, z, it);
      host.message(`You disassemble the ${cddaText((f.id !== 'f_null' ? f : host.map.terAt(x, y, z)).name)}.`);
    }
  }
  if (con.byproducts) {
    const p = host.player;
    for (const sp of expandItemGroup(data, con.byproducts, p.rng)) for (const it of fromSpawned(data, sp)) host.map.addItem(Math.floor(p.x), Math.floor(p.y), p.z, it);
  }
  host.events?.emit('mapChanged', { x, y, z });
}

/** Practice from complete_construction: (10 + 15*level) * (1 + time/180000 moves). */
function awardXp(host: CraftHost, con: ConstructionDef): void {
  for (const [s, l] of con.required_skills ?? []) host.player.practice(s, Math.floor((10 + 15 * l) * (1 + (con.time * 100) / 180000)), Math.floor(l * 1.25));
}

export interface BuildOptions {
  instant?: boolean;
}

/** Start building `con` at (x, y, z). Returns false (with a message) if not possible. */
export function startConstruction(host: CraftHost, con: ConstructionDef, x: number, y: number, z: number, opts: BuildOptions = {}): boolean {
  const groupName = cddaText(host.data.misc.construction_group?.[con.group]?.name) || con.group;
  if (!siteOk(host, con, x, y, z)) {
    host.message(`You can't build ${groupName} there.`, 'c_light_red');
    return false;
  }
  const inv = constructionInventory(host);
  const check = canBuild(host, con, inv);
  if (!check.ok) {
    host.message(`You can't build that: missing ${check.missing.join('; ')}.`, 'c_light_red');
    return false;
  }
  const { items } = consumeRequirements(con, inv);
  const finish = () => {
    awardXp(host, con);
    applyPost(host, con, x, y, z);
    host.message(`You finished construction: ${groupName}.`, 'c_light_green');
  };
  if (opts.instant) {
    finish();
    return true;
  }
  const ok = host.activities.start({
    name: `constructing ${groupName}`,
    duration: Math.max(1, con.time),
    onComplete: finish,
    onCancel: () => giveOrDrop(host, items),
  });
  if (!ok) giveOrDrop(host, items);
  return ok;
}

