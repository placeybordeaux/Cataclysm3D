import type { Game } from './game';
import type { FurnitureDef, GameData, ItemDef } from '../data/types';
import { hasFlag } from '../world/registry';
import { warnOnce } from '../data/warn';
import { DAYS_PER_SEASON, SECONDS_PER_DAY } from '../core/time';
import { createItem, type Item } from './item';
import { destroyWhere, L, spawnItem, spawnOnGround } from './moves';
import { weatherPoint, climateSeconds, temperatureAt } from './weather';
import { practiceForaging } from './harvest';

// Bright Nights iexamine.cpp, itype.cpp and map/mapbuffer.cpp.
// Hidden seed birthday persists on the tile; default BN growth scales seed_data.grow
// against a 14-day reference season. Three equal epochs lead to harvest, which remains
// ripe until collected. Fertilizer advances the birthday by 60% of one epoch per stage.
// Legacy growth_stages data remains supported for imported DDA content.

export const GROWTH_FLAGS = ['GROWTH_SEED', 'GROWTH_SEEDLING', 'GROWTH_MATURE', 'GROWTH_HARVEST', 'GROWTH_OVERGROWN'] as const;
export type GrowthStage = (typeof GROWTH_FLAGS)[number];

export function isSeed(def: ItemDef | undefined): boolean {
  return !!def && !!def.subtypes?.includes('SEED') && (Array.isArray(def.growth_stages) || !!def.seed_data);
}

interface SeedData { grow?: number; plant_name?: string; fruit?: string; seeds?: boolean; fruit_div?: number; byproducts?: string[]; }
const seedData = (def: ItemDef): SeedData => (def.seed_data ?? def) as SeedData;

/** BN islot_seed::get_plant_epoch, default GROWTH_SCALING=0 (14-day reference season). */
export function plantEpoch(def: ItemDef): number {
  return Number(seedData(def).grow ?? 0) * DAYS_PER_SEASON / 14 / 3;
}

/** Growth stages as [stage flag, game seconds], in order. */
export function growthStages(def: ItemDef): [string, number][] {
  const raw = def.growth_stages as Record<string, number>[] | undefined;
  if (!raw) {
    const epoch = plantEpoch(def);
    if (!(epoch > 0)) return [];
    return [['GROWTH_SEED', epoch], ['GROWTH_SEEDLING', epoch], ['GROWTH_MATURE', epoch], ['GROWTH_HARVEST', Infinity]];
  }
  return raw.map((o) => {
    const [k, v] = Object.entries(o)[0];
    return [k, Number(v)] as [string, number];
  });
}

/** Stage the seed should be at after `age` seconds (map::grow_plant's target_stage). */
export function targetStage(def: ItemDef, age: number): string {
  let t = 0, stage = 'GROWTH_SEED';
  for (const [flag, dur] of growthStages(def)) {
    if (age >= t) stage = flag;
    t += dur;
  }
  return stage;
}

/** Seconds from planting until the plant can be harvested (sum of stages before HARVEST). */
export function timeToHarvest(def: ItemDef): number {
  let t = 0;
  for (const [flag, dur] of growthStages(def)) {
    if (flag === 'GROWTH_HARVEST') return t;
    t += dur;
  }
  return t;
}

/** Furniture growth stage flag, or null if not a crop. */
export function furnStage(f: FurnitureDef): string | null {
  if (!hasFlag(f, 'PLANT')) return null;
  return GROWTH_FLAGS.find((g) => hasFlag(f, g)) ?? null;
}

interface PlantData {
  transform?: string;
  base?: string;
  harvest_multiplier?: number;
}
const plantData = (f: FurnitureDef) => (f.plant_data ?? {}) as PlantData;

/** The (hidden) seed item of a crop at (x, y, z). */
export function seedAt(game: Game, x: number, y: number, z: number): Item | null {
  for (const it of game.map.itemsAt(x, y, z) as Item[]) if (isSeed(it.def)) return it;
  return null;
}

/** `vars.planted` as a number; CDDA keeps it as the item's birthday. */
export function plantedAt(seed: Item): number {
  const v = Number(seed.vars.planted);
  return Number.isFinite(v) ? v : 0;
}

/**
 * map::grow_plant: advance the crop's furniture through as many stages as its age allows.
 * Returns the number of stages advanced. A crop with no seed is cleared like CDDA does.
 */
export function growPlant(game: Game, x: number, y: number, z: number): number {
  const map = game.map;
  const f = map.furnAt(x, y, z);
  const cur = furnStage(f);
  if (!cur) return 0;
  const seed = seedAt(game, x, y, z);
  if (!seed) {
    warnOnce('plant_without_seed', f.id, `plant furniture ${f.id} at ${x},${y},${z} has no seed item; clearing it`);
    map.setFurn(x, y, z, 'f_null');
    return 0;
  }
  const stages = growthStages(seed.def).map(([k]) => k);
  const target = targetStage(seed.def, game.clock.seconds - plantedAt(seed));
  if (stages.indexOf(cur) < 0) return 0;
  const steps = stages.indexOf(target) - stages.indexOf(cur);
  // CDDA can't reverse growth on a time rewind either: leave the stage as is
  if (steps <= 0) return 0;
  for (let i = 0; i < steps; i++) {
    const tr = plantData(map.furnAt(x, y, z)).transform;
    if (!tr || !map.furniture.has(tr)) break;
    // fertilizer is used up by each stage it speeds along
    delete seed.vars.fertilized;
    map.setFurn(x, y, z, tr);
  }
  return steps;
}

/** Tile accepts `seed` (PLANTABLE, or SHALLOW_WATER for cattails/lotus); CDDA required_terrain_flag. */
export function plantableFor(game: Game, x: number, y: number, z: number, seed: ItemDef): boolean {
  const flag = (seedData(seed) as SeedData & { required_terrain_flag?: string }).required_terrain_flag ?? 'PLANTABLE';
  const t = game.map.terAt(x, y, z), f = game.map.furnAt(x, y, z);
  if (f.id !== 'f_null') return hasFlag(f, flag) && !hasFlag(f, 'PLANT');
  return hasFlag(t, flag);
}

/** Highest temperature within ±12 h of `t` (weather.cpp highest_temp_on_day, 15-min steps → hourly). */
export function highestTempOnDay(seed: number, t: number): number {
  let hi = -Infinity;
  for (let dt = -12 * 3600; dt <= 12 * 3600; dt += 3600) hi = Math.max(hi, weatherPoint(seed, climateSeconds(t + dt)).temperature);
  return hi;
}

/**
 * BN weather.cpp warm_enough_to_plant: today's tile temperature must be at least 10 °C.
 * Underground planting is permitted; roofs do not block planting. Returns an error or null.
 */
export function warmEnoughToPlant(game: Game, x: number, y: number, z: number, seed: ItemDef): string | null {
  // BN checks today's temperature, rather than predicting future stage weather.
  if (z >= 0 && (game.weather ? temperatureAt(game, x, y, z) : weatherPoint(game.seed, climateSeconds(game.clock.seconds)).temperature) < 10) return 'It is too cold to plant anything now.';
  return null;
}

/** Seeds in the survivor's inventory, one entry per type with the count (iexamine::get_seed_entries). */
export function seedEntries(game: Game): { id: string; name: string; count: number }[] {
  const m = new Map<string, number>();
  for (const it of game.player.inv.allItems()) if (isSeed(it.def)) m.set(it.typeId, (m.get(it.typeId) ?? 0) + it.count());
  return [...m].map(([id, count]) => ({ id, count, name: createItem(game.data, id).baseName(count) })).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * iexamine::dirtmound checks (seed choice aside). Returns an error message or null.
 */
export function canPlant(game: Game, x: number, y: number, z: number, seedId: string): string | null {
  const def = game.data.items[seedId];
  if (!isSeed(def)) return `${seedId} is not a seed.`;
  if (!game.player.inv.hasAmount(seedId, 1)) return 'You have no seeds to plant.';
  if (game.map.itemsAt(x, y, z).length) return "Something's lying there…";
  if (!plantableFor(game, x, y, z, def)) return 'This type of seed can not be planted in this location.';
  return warmEnoughToPlant(game, x, y, z, def);
}

/** plant_seed_activity_actor::finish: the seed goes on the tile, dirt mound becomes a seed plot. */
export function plantSeedNow(game: Game, x: number, y: number, z: number, seedId: string): boolean {
  const map = game.map;
  const inv = game.player.inv;
  if (!inv.hasAmount(seedId, 1)) return false;
  // the seed leaves the pack and goes into the ground (used up here, placed there)
  const seed = inv.useAmount(seedId, 1)[0];
  seed.rot = 0;
  seed.vars.planted = game.clock.seconds;
  seed.vars.hidden = 1;
  const f = map.furnAt(x, y, z);
  const flag = (seedData(seed.def) as SeedData & { required_terrain_flag?: string }).required_terrain_flag ?? 'PLANTABLE';
  spawnItem(seed, L.ground(map, x, y, z), { force: true, quiet: true });
  if (f.id !== 'f_null' && hasFlag(f, flag) && plantData(f).transform) map.setFurn(x, y, z, plantData(f).transform!);
  else {
    if (flag === 'PLANTABLE') map.setTer(x, y, z, map.terAt(x, y, z).id === 't_greenhouse_tilled' ? 't_greenhouse' : 't_dirt');
    map.setFurn(x, y, z, 'f_plant_seed');
  }
  game.message(`You plant some ${seed.baseName(2)}.`, 'c_light_gray');
  return true;
}

/** Plant `seedId` at (x, y, z): 30 s activity. Returns an error message or null. */
export function startPlanting(game: Game, x: number, y: number, z: number, seedId: string, opts: { instant?: boolean } = {}): string | null {
  const err = canPlant(game, x, y, z, seedId);
  if (err) {
    game.message(err, 'c_light_gray');
    return err;
  }
  const done = () => {
    const changed = canPlant(game, x, y, z, seedId);
    if (changed) game.message(changed, 'c_light_gray');
    else plantSeedNow(game, x, y, z, seedId);
  };
  if (opts.instant) done();
  else game.activities.start({ name: `planting ${game.data.items[seedId].name}`, duration: 30, onComplete: done });
  return null;
}

/** Fertilizers the survivor carries (FERTILIZER flag). */
export function fertilizers(game: Game): Item[] {
  return game.player.inv.allItems().filter((it) => it.hasFlag('FERTILIZER'));
}

/**
 * BN iexamine::fertilize_plant: advance the plant 60% of one growth epoch.
 * Only one application per stage (CDDA: "This %s has already been fertilized.").
 */
export function fertilizePlant(game: Game, x: number, y: number, z: number, fert: Item): string | null {
  const seed = seedAt(game, x, y, z);
  if (!seed) return 'There is no plant there.';
  const name = String(seedData(seed.def).plant_name ?? seed.def.name);
  if (seed.vars.fertilized) return `This ${name} has already been fertilized.`;
  const inv = game.player.inv;
  if (!inv.hasAmount(fert.typeId, 1)) return `You don't have any ${fert.name()}.`;
  inv.useAmount(fert.typeId, 1);
  seed.vars.planted = plantedAt(seed) - (seed.def.seed_data ? plantEpoch(seed.def) * 0.6 : DAYS_PER_SEASON * SECONDS_PER_DAY * 0.2);
  seed.vars.fertilized = 1;
  game.message(`You fertilize the ${name} with the ${fert.baseName(1)}.`, 'c_light_gray');
  growPlant(game, x, y, z);
  return null;
}

/**
 * iexamine::harvest_plant: survival-scaled fruit count (clamped 1..12), seeds, byproducts,
 * all dropped at your feet; the plot returns to its base furniture. Returns the items.
 */
export function harvestPlantNow(game: Game, x: number, y: number, z: number): Item[] {
  const map = game.map;
  const p = game.player;
  const seed = seedAt(game, x, y, z);
  const f = map.furnAt(x, y, z);
  if (!seed || furnStage(f) !== 'GROWTH_HARVEST') return [];
  const data = game.data;
  const skill = Math.round(p.getSkill('survival'));
  let plants = p.rng.int(Math.floor(skill / 2), skill);
  plants = Math.floor(plants * (plantData(f).harvest_multiplier ?? 1));
  plants = Math.min(Math.max(plants, 1), 12);
  const seedCount = Math.max(1, p.rng.int(Math.floor(plants / 4), Math.floor(plants / 2)));
  const out: Item[] = [];
  const add = (id: string | undefined, n: number) => {
    if (!id || n <= 0) return;
    if (!data.items[id]) return void warnOnce('item', id);
    const first = createItem(data, id);
    if (first.countByCharges) {
      first.charges = Math.max(1, Math.floor(first.charges * n / (seedData(seed.def).fruit_div ?? 1)));
      out.push(first);
    } else for (let i = 0; i < n; i++) out.push(createItem(data, id));
  };
  if (seedData(seed.def).seeds !== false) add(seed.typeId, seedCount);
  add(seedData(seed.def).fruit, plants);
  for (const b of seedData(seed.def).byproducts ?? []) add(b, 1);
  clearPlot(game, x, y, z);
  for (const it of out) spawnOnGround(map, p.tileX, p.tileY, p.z, it);
  game.message('You harvest the plant.', 'c_light_gray');
  practiceForaging(game);
  return out;
}

/** Remove the crop: its items go, the furniture returns to plant_data.base. */
function clearPlot(game: Game, x: number, y: number, z: number): void {
  const map = game.map;
  const f = map.furnAt(x, y, z);
  destroyWhere(L.ground(map, x, y, z), () => true);
  const base = plantData(f).base;
  map.setFurn(x, y, z, base && map.furniture.has(base) ? base : 'f_null');
}

/** iexamine::clear_overgrown. */
export function clearOvergrown(game: Game, x: number, y: number, z: number): void {
  clearPlot(game, x, y, z);
  game.message("You pull up what's left of the planted crop and trample the rest.", 'c_light_gray');
}

/** Human-readable status for examine: "tomato (seedling), ready in about 20 days". */
export function plantStatus(game: Game, x: number, y: number, z: number): string | null {
  const seed = seedAt(game, x, y, z);
  const f = game.map.furnAt(x, y, z);
  if (!seed || !furnStage(f)) return null;
  const name = String(seedData(seed.def).plant_name ?? seed.def.name);
  const left = plantedAt(seed) + timeToHarvest(seed.def) - game.clock.seconds;
  const days = Math.ceil(left / SECONDS_PER_DAY);
  const when = furnStage(f) === 'GROWTH_HARVEST' ? 'ready to harvest' : furnStage(f) === 'GROWTH_OVERGROWN' ? 'overgrown' : days <= 1 ? 'ready in about a day' : `ready in about ${days} days`;
  return `${f.name} of ${name}${seed.vars.fertilized ? ' (fertilized)' : ''}: ${when}.`;
}

/** Growth of every crop in a chunk-sized area; used by actualize and tests. */
export function growAll(game: Game, x0: number, y0: number, x1: number, y1: number, z: number): number {
  let n = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (hasFlag(game.map.furnAt(x, y, z), 'PLANT')) n += growPlant(game, x, y, z);
  return n;
}

export function seedDef(data: GameData, id: string): ItemDef | undefined {
  const d = data.items[id];
  return isSeed(d) ? d : undefined;
}
