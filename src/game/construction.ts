import { effectiveSkills, effectiveTime } from './adaptation_rules';
import type { GameData, RecipeComponent, QualityRequirement } from '../data/types';
import { expandItemGroup } from '../data/itemgroups';
import { hasFlag, isDiggable } from '../world/registry';
import { CraftingInventory } from './crafting_inv';
import { craftingInventory, hasCraftingLight, type CraftHost } from './crafting';
import { createItem, fromSpawned, Item } from './item';
import { consumeItem, L, moveItem, spawnOnGround, transaction } from './moves';
import { consumeRequirements, evaluateRequirements, type RequirementEval } from './requirements';
import { cddaText } from './units';
import { constructionPractice, withPracticeSource } from './practice';

// Construction after Bright Nights (construction.cpp): build / dig / board up / deconstruct on
// a tile next to you. Constructions come from misc.construction (requirements expanded by the
// extractor) and are grouped (construction_group: "Build Wooden Wall" has stages — a half wall
// on flat ground, then the wall on the half wall). A site needs its pre_terrain /
// pre_furniture, pre_flags (and none of deny_flags), a passing pre_special, diggable ground
// when asked, and the construction must change something.
//
// Starting puts BN's partial construction on the site: here a real item (the `craft` type with
// vars.con_id) lying on the tile that holds the components, so nothing vanishes if you stop.
// Its progress stays; continue it (or cancel it to get the components back) from the site.

export interface ConstructionDef {
  id: string;
  group: string;
  category: string;
  required_skills?: [string, number][];
  /** seconds */
  time: number;
  components: RecipeComponent[][];
  tools: RecipeComponent[][];
  qualities: QualityRequirement[][];
  pre_terrain?: string;
  pre_furniture?: string;
  pre_flags?: string | string[];
  deny_flags?: string | string[];
  pre_special?: string;
  needs_diggable?: boolean;
  post_terrain?: string;
  post_furniture?: string;
  post_special?: string;
  post_flags?: string[];
  byproducts?: import('../data/types').ItemGroupRef;
  dark_craftable?: boolean;
  pre_note?: string;
  vehicle_start?: boolean;
  [k: string]: unknown;
}

export interface ConstructionGroup {
  id: string;
  name: string;
  /** construction_category ids of its stages */
  categories: string[];
  constructions: ConstructionDef[];
}

const asList = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** post_specials we can't carry out (vehicles need the vehicle system's placement). */
const UNSUPPORTED_POST = new Set(['done_vehicle']);

const groupCache = new WeakMap<GameData, ConstructionGroup[]>();
/** Construction groups sorted by name, like BN's construction menu. */
export function constructionGroups(data: GameData): ConstructionGroup[] {
  let gs = groupCache.get(data);
  if (gs) return gs;
  const by = new Map<string, ConstructionGroup>();
  for (const c of Object.values((data.misc.construction ?? {}) as Record<string, ConstructionDef>)) {
    if (c.vehicle_start || asList(c.post_special).some((s) => UNSUPPORTED_POST.has(s)) || !c.group) continue;
    let g = by.get(c.group);
    if (!g) by.set(c.group, (g = { id: c.group, name: cddaText(data.misc.construction_group?.[c.group]?.name) || c.group, categories: [], constructions: [] }));
    g.constructions.push(c);
    if (!g.categories.includes(c.category)) g.categories.push(c.category);
  }
  gs = [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
  groupCache.set(data, gs);
  return gs;
}

export function getConstruction(data: GameData, id: string): ConstructionDef | undefined {
  return data.misc.construction?.[id] as ConstructionDef | undefined;
}

export function groupName(data: GameData, con: ConstructionDef): string {
  return cddaText(data.misc.construction_group?.[con.group]?.name) || con.group;
}

export function terOrFurnName(data: GameData, id: string): string {
  return cddaText((id.startsWith('f_') ? data.furniture[id] : data.terrain[id])?.name) || id;
}

// ------------------------------------------------------------------ site checks
/** BN checks a flag on the furniture when there is any, else on the terrain. */
function flagAt(host: CraftHost, x: number, y: number, z: number, flag: string): boolean {
  const f = host.map.furnAt(x, y, z);
  return f.id !== 'f_null' ? hasFlag(f, flag) : hasFlag(host.map.terAt(x, y, z), flag);
}
/** map::has_flag: terrain or furniture. */
function anyFlagAt(host: CraftHost, x: number, y: number, z: number, flag: string): boolean {
  const f = host.map.furnAt(x, y, z);
  return hasFlag(host.map.terAt(x, y, z), flag) || (f.id !== 'f_null' && hasFlag(f, flag));
}

function creatureOn(host: CraftHost, x: number, y: number, z: number): boolean {
  const at = (host as unknown as { creatureAt?: (x: number, y: number, z: number) => unknown }).creatureAt;
  return typeof at === 'function' && !!at.call(host, x, y, z);
}

/** Items other than an unfinished construction (which is the site itself). */
function looseItemsAt(host: CraftHost, x: number, y: number, z: number): number {
  return host.map.itemsAt(x, y, z).filter((i) => !(i instanceof Item && i.isCraft() && i.vars.con_id !== undefined)).length;
}

const OVERMAP_HEIGHT = 10, OVERMAP_DEPTH = -10;
const checkEmpty = (h: CraftHost, x: number, y: number, z: number) =>
  anyFlagAt(h, x, y, z, 'FLAT') && h.map.furnAt(x, y, z).id === 'f_null' && !creatureOn(h, x, y, z) && looseItemsAt(h, x, y, z) === 0;
const upOk = (_h: CraftHost, _x: number, _y: number, z: number) => z < OVERMAP_HEIGHT;

const PRE_SPECIALS: Record<string, (host: CraftHost, x: number, y: number, z: number) => boolean> = {
  check_nothing: () => true,
  check_empty: checkEmpty,
  check_support: (h, x, y, z) => {
    if (!h.map.passable(x, y, z)) return false;
    let n = 0;
    for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) if (anyFlagAt(h, x + dx, y + dy, z, 'SUPPORTS_ROOF')) n++;
    return n >= 2;
  },
  check_deconstruct: (h, x, y, z) => {
    const f = h.map.furnAt(x, y, z);
    if (f.id !== 'f_null') return !!f.deconstruct;
    return !!h.map.terAt(x, y, z).deconstruct;
  },
  check_empty_up_OK: (h, x, y, z) => checkEmpty(h, x, y, z) && upOk(h, x, y, z),
  check_up_OK: upOk,
  check_down_OK: (_h, _x, _y, z) => z > OVERMAP_DEPTH,
  check_no_trap: () => true,
  check_ramp_low: (h, x, y, z) => upOk(h, x, y, z) && upOk(h, x, y, z + 1),
  check_ramp_high: (h, x, y, z) => upOk(h, x, y, z) && upOk(h, x, y, z + 1) && [[0, -1], [0, 1], [-1, 0], [1, 0]].some(([dx, dy]) => anyFlagAt(h, x + dx, y + dy, z + 1, 'RAMP_DOWN')),
  check_empty_ramp_low: (h, x, y, z) => checkEmpty(h, x, y, z) && upOk(h, x, y, z) && upOk(h, x, y, z + 1),
  check_empty_ramp_high: (h, x, y, z) => checkEmpty(h, x, y, z) && PRE_SPECIALS.check_ramp_high(h, x, y, z),
  check_ceiling: (h, x, y, z) => checkEmpty(h, x, y, z) && !anyFlagAt(h, x, y, z + 1, 'NO_FLOOR') && h.map.terAt(x, y, z + 1).id !== 't_open_air',
};

/**
 * construction::can_construct(con, p): site conditions only (no skills/tools). With `why`,
 * returns the first reason it fails (for the placement ghost), else null when it's fine.
 */
export function siteProblem(host: CraftHost, con: ConstructionDef, x: number, y: number, z: number): string | null {
  const p = host.player;
  if (x === Math.floor(p.x) && y === Math.floor(p.y) && z === p.z) return "You can't build where you stand.";
  if (Math.max(Math.abs(x - Math.floor(p.x)), Math.abs(y - Math.floor(p.y))) > 1 || z !== p.z) return 'Too far away: stand next to it.';
  if (unfinishedAt(host, x, y, z)) return 'There is already an unfinished construction there.';
  const ter = host.map.terAt(x, y, z), furn = host.map.furnAt(x, y, z);
  if (con.pre_terrain && ter.id !== con.pre_terrain) return `Needs ${terOrFurnName(host.data, con.pre_terrain)}.`;
  if (con.pre_furniture && furn.id !== con.pre_furniture) return `Needs ${terOrFurnName(host.data, con.pre_furniture)}.`;
  for (const s of asList(con.pre_special)) {
    const fn = PRE_SPECIALS[s];
    if (!fn) return `Can't be built here (${s}).`;
    if (!fn(host, x, y, z)) return s === 'check_empty' ? 'Needs empty, flat ground.' : s === 'check_support' ? 'Needs two supporting walls next to it.' : s === 'check_deconstruct' ? "There's nothing to take apart." : "Can't be built here.";
  }
  for (const f of asList(con.deny_flags)) if (flagAt(host, x, y, z, f)) return `Not on ${furn.id !== 'f_null' ? cddaText(furn.name) : cddaText(ter.name)}.`;
  for (const f of asList(con.pre_flags)) if (!flagAt(host, x, y, z, f)) return `Needs ${f.toLowerCase().replace(/_/g, ' ')}.`;
  if (con.needs_diggable && !isDiggable(ter)) return 'The ground here is too hard to dig.';
  if (con.post_terrain && ter.id === con.post_terrain) return 'Already built.';
  if (con.post_furniture && furn.id === con.post_furniture) return 'Already built.';
  return null;
}

export function siteOk(host: CraftHost, con: ConstructionDef, x: number, y: number, z: number): boolean {
  return siteProblem(host, con, x, y, z) === null;
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

/** The stage of a group that fits a tile (BN place_construction picks it per tile). */
export function stageFor(host: CraftHost, g: ConstructionGroup, x: number, y: number, z: number, inv?: CraftingInventory): ConstructionDef | null {
  const fits = g.constructions.filter((c) => siteOk(host, c, x, y, z));
  if (!fits.length) return null;
  if (inv) return fits.find((c) => canBuild(host, c, inv).ok) ?? fits[0];
  return fits[0];
}

export interface ConstructionCheck {
  ok: boolean;
  missing: string[];
  req: RequirementEval;
  skillsOk: boolean;
  light: boolean;
}

export function constructionInventory(host: CraftHost): CraftingInventory {
  return craftingInventory(host);
}

/** player_can_build + player_can_see_to_build: skills, tools/qualities/components, light. */
export function canBuild(host: CraftHost, con: ConstructionDef, inv = constructionInventory(host)): ConstructionCheck {
  const c = host.player;
  const req = evaluateRequirements(host.data, con, inv);
  const missing = [...req.missing];
  const skills = effectiveSkills(con);
  const skillsOk = skills.every(([s, l]) => c.getSkill(s) >= l);
  if (!skillsOk) for (const [s, l] of skills) if (c.getSkill(s) < l) missing.push(`${c.skillName(s)} ${l}`);
  const light = !!con.dark_craftable || hasCraftingLight(host);
  if (!light) missing.push('It is too dark to construct right now.');
  return { ok: missing.length === 0, missing, req, skillsOk, light };
}

// ------------------------------------------------------------------ unfinished constructions
/** The unfinished construction (partial_con) lying on a tile, if any. */
export function unfinishedAt(host: CraftHost, x: number, y: number, z: number): Item | null {
  for (const i of host.map.itemsAt(x, y, z)) if (i instanceof Item && i.isCraft() && i.vars.con_id !== undefined) return i;
  return null;
}

export function unfinishedState(data: GameData, it: Item): { con: ConstructionDef; progress: number } | null {
  if (!it.isCraft() || it.vars.con_id === undefined) return null;
  const con = getConstruction(data, String(it.vars.con_id));
  return con ? { con, progress: Number(it.vars.craft_progress ?? 0) } : null;
}

// ------------------------------------------------------------------ building
function setAt(host: CraftHost, x: number, y: number, z: number, id: string): void {
  if (id.startsWith('f_')) host.map.setFurn(x, y, z, id);
  else host.map.setTer(x, y, z, id);
}

function spawnGroup(host: CraftHost, group: import('../data/types').ItemGroupRef, x: number, y: number, z: number): void {
  const data = host.data;
  for (const sp of expandItemGroup(data, group, host.player.rng)) for (const it of fromSpawned(data, sp)) spawnOnGround(host.map, x, y, z, it);
}

/** construct::done_deconstruct. */
function doneDeconstruct(host: CraftHost, x: number, y: number, z: number): void {
  const f = host.map.furnAt(x, y, z);
  if (f.id !== 'f_null') {
    const d = f.deconstruct;
    if (!d) return host.message(`That ${cddaText(f.name)} can not be disassembled!`);
    host.map.setFurn(x, y, z, d.furn_set ?? 'f_null');
    host.message(`The ${cddaText(f.name)} is disassembled.`);
    if (d.items) spawnGroup(host, d.items, x, y, z);
    return;
  }
  const t = host.map.terAt(x, y, z);
  const d = t.deconstruct;
  if (!d) return host.message(`That ${cddaText(t.name)} can not be disassembled!`);
  if (d.deconstruct_above) doneDeconstruct(host, x, y, z + 1);
  // BN: t_null means "whatever the roof below is", i.e. open air above ground
  const set = d.ter_set && d.ter_set !== 't_null' ? d.ter_set : host.map.terAt(x, y, z - 1).roof ?? 't_open_air';
  host.map.setTer(x, y, z, set);
  host.message(`The ${cddaText(t.name)} is disassembled.`);
  if (d.items) {
    // Don't drop things down a hole we just made.
    const p = host.player;
    const [ix, iy] = set === 't_open_air' ? [Math.floor(p.x), Math.floor(p.y)] : [x, y];
    spawnGroup(host, d.items, ix, iy, z);
  }
}

const POST_SPECIALS: Record<string, (host: CraftHost, x: number, y: number, z: number) => void> = {
  done_nothing: () => {},
  done_deconstruct: doneDeconstruct,
  done_dig_stair: (h, x, y, z) => {
    const solid = !h.map.passable(x, y, z - 1);
    h.message(solid ? 'You dig a stairway, adding sturdy timbers and a rope for safety.' : 'You dig into a preexisting space, and improvise a ladder.');
    h.map.setTer(x, y, z, 't_stairs_down');
    h.map.setTer(x, y, z - 1, solid ? 't_stairs_up' : 't_ladder_up');
  },
  done_mine_downstair: (h, x, y, z) => {
    const solid = !h.map.passable(x, y, z - 1);
    h.message(solid ? 'You drill out a passage, heading deeper underground.' : 'You dig into a preexisting space, and improvise a ladder.');
    h.map.setTer(x, y, z, 't_stairs_down');
    h.map.setTer(x, y, z - 1, solid ? 't_stairs_up' : 't_ladder_up');
  },
  done_mine_upstair: (h, x, y, z) => {
    h.message('You drill out a passage, heading for the surface.');
    h.map.setTer(x, y, z, 't_stairs_up');
    h.map.setTer(x, y, z + 1, 't_stairs_down');
  },
  done_wood_stairs: (h, x, y, z) => h.map.setTer(x, y, z + 1, 't_wood_stairs_down'),
  done_ramp_low: (h, x, y, z) => h.map.setTer(x, y, z + 1, 't_ramp_down_low'),
  done_ramp_high: (h, x, y, z) => h.map.setTer(x, y, z + 1, 't_ramp_down_high'),
  done_window_curtains: (h) => {
    const p = h.player;
    const [px, py] = [Math.floor(p.x), Math.floor(p.y)];
    for (const [id, n] of [['nail', 4], ['sheet', 2], ['stick', 1], ['string_36', 1]] as const) {
      if (!h.data.items[id]) continue;
      const it = createItem(h.data, id);
      if (it.countByCharges) it.charges = n;
      spawnOnGround(h.map, px, py, p.z, it);
      if (!it.countByCharges) for (let i = 1; i < n; i++) spawnOnGround(h.map, px, py, p.z, createItem(h.data, id));
    }
    h.message('After boarding up the window the curtains and curtain rod are left.');
  },
  done_grave: (h) => h.message('You bury what lies here.'),
  done_trunk_plank: (h) => {
    const p = h.player;
    for (let i = h.player.rng.int(2, 3) * 5; i > 0; i--) if (h.data.items['2x4']) spawnOnGround(h.map, Math.floor(p.x), Math.floor(p.y), p.z, createItem(h.data, '2x4'));
    h.message('You cut the log into planks.');
  },
  // traps are not simulated for these marks yet
  done_mark_firewood: () => {},
  done_mark_practice_target: () => {},
};

/** complete_construction: xp, clear the site, terrain/furniture change, byproducts, post_special. */
function applyPost(host: CraftHost, con: ConstructionDef, x: number, y: number, z: number): void {
  // Items on the site move to a neighbouring tile unless the construction keeps them.
  if (!(con.post_flags ?? []).includes('keep_items')) {
    const items = [...host.map.itemsAt(x, y, z)] as Item[];
    if (items.length) {
      const spots = ADJACENT.map(([dx, dy]) => [x + dx, y + dy] as const).filter(([sx, sy]) => host.map.passable(sx, sy, z) && !hasFlag(host.map.terAt(sx, sy, z), 'NOITEM'));
      const [sx, sy] = spots.length ? spots[host.player.rng.int(0, spots.length - 1)] : [Math.floor(host.player.x), Math.floor(host.player.y)];
      for (const it of items) moveItem(it, L.ground(host.map, x, y, z), L.ground(host.map, sx, sy, z), { force: true, quiet: true });
    }
  }
  if (con.post_terrain) {
    setAt(host, x, y, z, con.post_terrain);
    const roof = host.data.terrain[con.post_terrain]?.roof;
    if (roof && host.map.terAt(x, y, z + 1).id === 't_open_air') host.map.setTer(x, y, z + 1, roof);
  }
  if (con.post_furniture) host.map.setFurn(x, y, z, con.post_furniture);
  if (con.byproducts) {
    const p = host.player;
    spawnGroup(host, con.byproducts, Math.floor(p.x), Math.floor(p.y), p.z);
  }
  host.message(`You finished construction: ${groupName(host.data, con)}.`, 'c_light_green');
  for (const s of asList(con.post_special)) POST_SPECIALS[s]?.(host, x, y, z);
  host.events?.emit('mapChanged', { x, y, z });
}

/** Practice from complete_construction: (10 + 15 × level) × (1 + time / 10 minutes). */
function awardXp(host: CraftHost, con: ConstructionDef): void {
  withPracticeSource(`Building: ${groupName(host.data, con)}`, () => {
    for (const { skill, amount, cap } of constructionPractice(con)) host.player.practice(skill, amount, cap);
  });
}

export interface BuildOptions {
  instant?: boolean;
}

/** Called when a construction finishes (UI refresh, progression). */
export const constructedHooks: ((con: ConstructionDef, x: number, y: number, z: number) => void)[] = [];

/**
 * Start building `con` at (x, y, z) (BN place_construction): the components go into an
 * unfinished construction on the site, tool charges are paid, then the work starts. Returns
 * false (with a message) if not possible.
 */
export function startConstruction(host: CraftHost, con: ConstructionDef, x: number, y: number, z: number, opts: BuildOptions = {}): boolean {
  const name = groupName(host.data, con);
  const why = siteProblem(host, con, x, y, z);
  if (why) {
    // Group names are imperative phrases ('Build Fire Ring', 'Board Up Window').
    host.message(`You can't ${name.toLowerCase()} there. ${why}`, 'c_light_red');
    return false;
  }
  const inv = constructionInventory(host);
  const check = canBuild(host, con, inv);
  if (!check.ok) {
    host.message(`You can't build that: missing ${check.missing.join('; ')}.`, 'c_light_red');
    return false;
  }
  const site = createItem(host.data, 'craft');
  site.vars.con_id = con.id;
  site.vars.craft_label = `unfinished ${name}`;
  site.vars.craft_progress = 0;
  transaction(() => {
    consumeRequirements(con, inv, 1, L.in(site));
    spawnOnGround(host.map, x, y, z, site);
    return true;
  });
  return continueConstruction(host, site, x, y, z, opts);
}

/** Keep working on the unfinished construction at (x, y, z). */
export function continueConstruction(host: CraftHost, site: Item, x: number, y: number, z: number, opts: BuildOptions = {}): boolean {
  const st = unfinishedState(host.data, site);
  if (!st) return false;
  const { con } = st;
  const name = groupName(host.data, con);
  const p = host.player;
  if (Math.max(Math.abs(x - Math.floor(p.x)), Math.abs(y - Math.floor(p.y))) > 1 || z !== p.z) {
    host.message('You need to stand next to it.', 'c_light_red');
    return false;
  }
  // Tools must still be at hand (their charges were paid when it was started).
  const inv = constructionInventory(host);
  const need = { qualities: con.qualities, tools: con.tools.map((g) => g.map((t) => ({ ...t, count: -1 }))) };
  const ev = evaluateRequirements(host.data, need, inv);
  if (!ev.ok) {
    host.message(`You can't continue: missing ${ev.missing.join('; ')}.`, 'c_light_red');
    return false;
  }
  if (!con.dark_craftable && !hasCraftingLight(host)) {
    host.message('It is too dark to construct right now.', 'c_light_red');
    return false;
  }
  const finish = () => {
    const ground = L.ground(host.map, x, y, z);
    for (const comp of [...site.contents]) consumeItem(comp, L.in(site));
    if (!consumeItem(site, ground)) {
      host.message('The construction site is gone.', 'c_light_red');
      return;
    }
    awardXp(host, con);
    applyPost(host, con, x, y, z);
    for (const h of constructedHooks) h(con, x, y, z);
  };
  if (opts.instant) {
    finish();
    return true;
  }
  const speed = p.mutationValue('construction_speed_modifier') || 1;
  const total = Math.max(1, effectiveTime(con) / speed);
  const base = st.progress;
  if (base > 0) host.message(`You get back to work: ${name}.`);
  return host.activities.start({
    name: `constructing ${name}`,
    kind: 'construction',
    target: site,
    customUi: true,
    at: { x, y, z },
    duration: Math.max(1, Math.round(total * (1 - base))),
    onProgress: (_dt, f) => void (site.vars.craft_progress = base + (1 - base) * f),
    onComplete: finish,
    onCancel: () => host.message(`The ${site.name()} waits for you: right-click it (or look at it and press <keybind:world_menu>) to continue or cancel.`, 'c_light_gray'),
  });
}

/** Cancel an unfinished construction: its components go back to the ground next to it. */
export function cancelConstruction(host: CraftHost, site: Item, x: number, y: number, z: number): boolean {
  const ground = L.ground(host.map, x, y, z);
  if (!unfinishedState(host.data, site) || !host.map.itemsAt(x, y, z).includes(site)) return false;
  if (host.activities.current?.spec.target === site) host.activities.cancel('You stop constructing.');
  const p = host.player;
  const here = L.ground(host.map, Math.floor(p.x), Math.floor(p.y), p.z);
  for (const comp of [...site.contents]) moveItem(comp, L.in(site), here, { force: true, quiet: true });
  consumeItem(site, ground);
  host.message(`You abandon the ${site.baseName()} and gather up its materials.`);
  return true;
}

/** The targeted examine action uses the same recipes and requirements as construction. */
export function furnitureDeconstruction(host: CraftHost, x: number, y: number, z: number): { id: string; label: string; run: () => void }[] {
  const f = host.map.furnAt(x, y, z);
  if (f.id === 'f_null' || !f.deconstruct) return [];
  const inv = constructionInventory(host);
  const candidates = constructionGroups(host.data).flatMap((g) => g.constructions)
    .filter((con) => asList(con.post_special).includes('done_deconstruct') && siteOk(host, con, x, y, z))
    .map((con) => ({ con, requirements: canBuild(host, con, inv) }))
    .sort((a, b) => Number(b.requirements.ok) - Number(a.requirements.ok) || a.con.time - b.con.time);
  const choice = candidates[0];
  if (!choice) return [];
  const need = choice.requirements.ok ? '' : ` (Need: ${choice.requirements.missing.join('; ')})`;
  return [{
    id: 'deconstruct_furniture',
    label: `Deconstruct the ${cddaText(f.name)}${need}`,
    run: () => { startConstruction(host, choice.con, x, y, z); },
  }];
}
