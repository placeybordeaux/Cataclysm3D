import type { Game } from './game';
import type { FurnitureDef, GameData, TerrainDef } from '../data/types';
import type { Rng } from '../core/rng';
import { expandItemGroup } from '../data/itemgroups';
import { warnOnce } from '../data/warn';
import { hasFlag } from '../world/registry';
import { DAYS_PER_SEASON, SECONDS_PER_DAY } from '../core/time';
import { createItem, fromSpawned, type Item } from './item';
import { seasonAt, type Season } from './sun';

// Foraging and seasonal harvests, after CDDA iexamine.cpp (harvest_ter / harvest_furn /
// harvested_plant / shrub_wildveggies) and activity_actor.cpp (harvest_activity_actor,
// forage_activity_actor), plus map::restock_fruits for regrowth.
//
//  - Terrain/furniture with `harvest_by_season` yields that season's harvest list
//    (misc.harvest: drop, base_num, scale_num × survival skill, max), then turns into its
//    `transforms_into` (a HARVESTED variant: "A small blueberry bush that's fruitless.").
//  - HARVESTED terrain turns back into its `transforms_into` once the season changes (or a
//    whole season passed) — evaluated lazily when the chunk is actualized (actualize.ts), so
//    bushes regrow while you're away just as in CDDA.
//  - Underbrush (shrub_wildveggies) is foraged with a survival + perception roll against
//    the season's forage_<season> item group.

export interface HarvestEntry {
  drop: string;
  type?: string;
  base_num?: [number, number];
  scale_num?: [number, number];
  max?: number;
}

type TileDef = TerrainDef | FurnitureDef;

export function examineAction(def: TileDef): string | null {
  const e = def.examine_action;
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object' && typeof (e as { type?: unknown }).type === 'string') return (e as { type: string }).type;
  return null;
}

/** map::get_harvest: the harvest list id for the current season, or null. */
export function harvestIdFor(def: TileDef, season: Season): string | null {
  const hbs = def.harvest_by_season as { seasons: string[]; id: string }[] | undefined;
  if (!Array.isArray(hbs)) return null;
  for (const e of hbs) if (e.seasons?.map((s) => s.toLowerCase()).includes(season)) return e.id;
  return null;
}

export function harvestEntries(data: GameData, id: string): HarvestEntry[] {
  const h = (data.misc.harvest as Record<string, { entries?: HarvestEntry[] }> | undefined)?.[id];
  if (!h) {
    warnOnce('harvest', id);
    return [];
  }
  return h.entries ?? [];
}

function rngFloat(rng: Rng, a: number, b: number): number {
  return Math.min(a, b) + rng.next() * Math.abs(b - a);
}

/**
 * harvest_activity_actor::finish: for each entry roll round(rng_float(min, max)) with
 * min/max = scale_num × survival + base_num, capped at `max`. Returns [item id, count].
 */
export function rollHarvest(rng: Rng, entries: HarvestEntry[], survival: number): [string, number][] {
  const out: [string, number][] = [];
  for (const e of entries) {
    const base = e.base_num ?? [1, 1], scale = e.scale_num ?? [0, 0];
    const lo = scale[0] * survival + base[0], hi = scale[1] * survival + base[1];
    const n = Math.min(e.max ?? 1000, Math.round(rngFloat(rng, lo, hi)));
    if (n > 0) out.push([e.drop, n]);
  }
  return out;
}

/** What `e` offers for a harvestable tile (terrain or furniture), for the current season. */
export type HarvestKind = 'harvest' | 'forage' | 'harvested' | 'out_of_season';

export function harvestKind(game: Game, x: number, y: number, z: number): { kind: HarvestKind; def: TileDef; isFurn: boolean } | null {
  const map = game.map;
  const f = map.furnAt(x, y, z), t = map.terAt(x, y, z);
  const isFurn = f.id !== 'f_null' && ['harvest_furn', 'harvest_furn_nectar'].includes(examineAction(f) ?? '');
  const def: TileDef = isFurn ? f : t;
  const act = examineAction(def);
  if (!act) return null;
  if (act === 'shrub_wildveggies') return { kind: 'forage', def, isFurn: false };
  if (act === 'harvested_plant') return { kind: 'harvested', def, isFurn };
  if (!['harvest_ter', 'harvest_ter_nectar', 'harvest_furn', 'harvest_furn_nectar'].includes(act)) return null;
  const id = harvestIdFor(def, seasonAt(game.clock.seconds));
  if (!id || !harvestEntries(game.data, id).length) return { kind: 'out_of_season', def, isFurn };
  return { kind: 'harvest', def, isFurn };
}

/** iexamine_helper::handle_harvest: into your pockets if it fits, else at your feet. */
export function giveHarvest(game: Game, it: Item): void {
  const p = game.player;
  if (p.inv.canStash(it) && p.inv.weightCarried() + it.weight() <= p.inv.weightCapacity()) {
    p.inv.stash(it);
    game.message(`You harvest: ${it.name()}.`, 'c_light_gray');
  } else {
    game.map.addItem(p.tileX, p.tileY, p.z, it);
    game.message(`You harvest and drop: ${it.name()}.`, 'c_light_gray');
  }
}

/** iexamine::practice_survival_while_foraging. */
export function practiceForaging(game: Game): void {
  const p = game.player;
  const maxSkill = Math.floor(p.int / 3) + 1;
  const maxExp = 2 * (maxSkill - Math.floor(p.getSkill('survival')));
  if (maxExp >= 1) p.practice('survival', p.rng.int(1, maxExp), maxSkill);
}

/** Make `n` of item `id` (charge items as one stack per unit, like CDDA spawning them singly). */
function makeItems(data: GameData, id: string, n: number): Item[] {
  if (!data.items[id]) {
    warnOnce('item', id);
    return [];
  }
  const out: Item[] = [];
  for (let i = 0; i < n; i++) out.push(createItem(data, id));
  return out;
}

/**
 * Pick the tile's seasonal harvest: 5-15 s activity, then harvest_activity_actor::finish.
 * Returns false (with CDDA's message) when nothing can be harvested now.
 */
export function startHarvest(game: Game, x: number, y: number, z: number, opts: { instant?: boolean } = {}): boolean {
  const k = harvestKind(game, x, y, z);
  if (!k || k.kind === 'harvested' || k.kind === 'out_of_season') {
    game.message('Nothing can be harvested from this plant in current season.', 'c_light_gray');
    return false;
  }
  if (k.kind === 'forage') return startForage(game, x, y, z, opts);
  const p = game.player;
  const finish = () => {
    const hk = harvestKind(game, x, y, z);
    if (!hk || hk.kind !== 'harvest') return;
    const id = harvestIdFor(hk.def, seasonAt(game.clock.seconds))!;
    const rolls = rollHarvest(p.rng, harvestEntries(game.data, id), p.getSkill('survival'));
    let got = false;
    for (const [drop, n] of rolls) for (const it of makeItems(game.data, drop, n)) (got = true), giveHarvest(game, it);
    if (!got) game.message("You couldn't harvest anything.", 'c_light_red');
    if (hk.isFurn) game.map.setFurn(x, y, z, 'f_null');
    else transformTer(game, x, y, z);
    practiceForaging(game);
  };
  if (opts.instant) {
    finish();
    return true;
  }
  return game.activities.start({ name: `harvesting the ${k.def.name}`, duration: p.rng.int(5, 15), onComplete: finish });
}

/** ter_set(get_ter_transforms_into): harvested bushes/trees/underbrush. */
function transformTer(game: Game, x: number, y: number, z: number): void {
  const t = game.map.terAt(x, y, z);
  const into = t.transforms_into;
  if (!into) return;
  if (!game.map.terrain.has(into)) return void warnOnce('terrain', into);
  game.map.setTer(x, y, z, into);
  game.events.emit('mapChanged', { x, y, z });
}

/** iexamine::shrub_wildveggies move cost → game seconds (CDDA: 100000 / (2·survival + 5) / rng(per…)). */
export function forageSeconds(rng: Rng, survival: number, per: number): number {
  let moves = 100000 / (2 * survival + 5);
  moves /= rng.int(Math.min(Math.max(4, per), 4 + per * 2), 4 + per * 2);
  return Math.max(1, Math.round(moves / 100));
}

/** forage_activity_actor::finish success chance, percent: survival·3 + per − 2 against d100. */
export function forageChance(survival: number, per: number): number {
  return Math.min(100, Math.max(0, Math.round(survival * 3 + per - 2) - 1));
}

export function startForage(game: Game, x: number, y: number, z: number, opts: { instant?: boolean } = {}): boolean {
  const p = game.player;
  const t = game.map.terAt(x, y, z);
  game.message(`You forage through the ${t.name}.`, 'c_light_gray');
  const finish = () => forageFinish(game, x, y, z);
  if (opts.instant) {
    finish();
    return true;
  }
  return game.activities.start({ name: `foraging through the ${t.name}`, duration: forageSeconds(p.rng, p.getSkill('survival'), p.per), onComplete: finish });
}

/** forage_activity_actor::finish. Returns the items found (they're placed at your feet). */
export function forageFinish(game: Game, x: number, y: number, z: number): Item[] {
  const p = game.player;
  const data = game.data;
  const group = `forage_${seasonAt(game.clock.seconds)}`;
  transformTer(game, x, y, z);
  const found: Item[] = [];
  const drop = (groupId: string) => {
    if (!data.itemGroups[groupId]) return void warnOnce('item_group', groupId);
    for (const s of expandItemGroup(data, groupId, p.rng))
      for (const it of fromSpawned(data, s)) {
        // FORAGE_POISON / FORAGE_HALLU: 1 in 10 is secretly bad (CDDA HIDDEN_POISON/HALLU)
        if (it.hasFlag('FORAGE_POISON') && p.rng.oneIn(10)) it.vars.hidden_poison = p.rng.int(2, 7);
        else if (it.hasFlag('FORAGE_HALLU') && p.rng.oneIn(10)) it.vars.hidden_hallu = 1;
        game.map.addItem(p.tileX, p.tileY, p.z, it);
        game.message(`You found: ${it.name()}!`, 'c_green');
        found.push(it);
      }
  };
  if (p.rng.int(1, 100) < Math.round(p.getSkill('survival') * 3 + p.per - 2)) drop(group);
  if (p.rng.oneIn(10)) drop('SUS_trash_forest_no_manmade');
  if (!found.length) game.message("You didn't find anything.", 'c_light_gray');
  practiceForaging(game);
  return found;
}

/**
 * map::restock_fruits: a HARVESTED terrain becomes harvestable again when the season changed
 * since it was last touched, or a whole season went by. Returns true if it regrew.
 */
export function restockFruits(game: Game, x: number, y: number, z: number, lastTouched: number): boolean {
  const t = game.map.terAt(x, y, z);
  if (!hasFlag(t, 'HARVESTED') || !t.transforms_into) return false;
  const now = game.clock.seconds;
  if (seasonAt(now) === seasonAt(lastTouched) && now - lastTouched < DAYS_PER_SEASON * SECONDS_PER_DAY) return false;
  if (!game.map.terrain.has(t.transforms_into)) return false;
  game.map.setTer(x, y, z, t.transforms_into);
  return true;
}
