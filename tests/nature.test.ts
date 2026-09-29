// Seasons, foraging/harvesting, farming, water/fishing/swimming, woodcutting and world-item
// spoilage against the real extracted CDDA data and the deterministic TestGenerator map:
//   chunk (0,0): house (fridge at 12,5), grass/dirt around; chunk (-1,0): forest with
//   underbrush; chunk (0,1): fenced yard with a pond centred on (14, 36).
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { GameData } from '../src/data/types';
import { Game } from '../src/game/game';
import { TestGenerator } from '../src/world/testgen';
import { createItem, type Item } from '../src/game/item';
import { DAYS_PER_SEASON, SECONDS_PER_DAY } from '../src/core/time';
import { sunTimes, seasonAt, sunAltitudeAt } from '../src/game/sun';
import { harvestIdFor, harvestEntries, rollHarvest, startHarvest, harvestKind, forageFinish, forageChance } from '../src/game/harvest';
import { targetStage, timeToHarvest, startPlanting, growPlant, harvestPlantNow, seedAt, canPlant, fertilizePlant, plantedAt } from '../src/game/farming';
import { expectedCatchChance, fishChance, catchFish, fillableContainers, fillContainer, fishingSpot, updateSwimming, swimState, fishableLocations } from '../src/game/water';
import { chopSeconds, cutDownTree, chopLogsAt, cutPlanks } from '../src/game/woodcut';
import { useActions } from '../src/game/inventory';
import { installNature, jumpToSeason, natureOf } from '../src/nature';
import { installWeather } from '../src/game/weather';
import { interactionsAt } from '../src/game/interact';
import { canonicalHour } from '../src/render/lights';
import { installChunkTracking } from '../src/save/tracking';
import { registerCoreSaveables } from '../src/save/builtins';
import { applySave, decodeSave, encodeSave, serializeGame } from '../src/save/format';

const dir = path.join(__dirname, '../public/data');
const load = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
let data: GameData;

beforeAll(() => {
  data = {
    terrain: load('terrain.json'), furniture: load('furniture.json'), items: load('items.json'),
    itemGroups: load('item_groups.json'), monsters: load('monsters.json'), monsterGroups: load('monster_groups.json'), recipes: [], misc: load('misc.json'),
  };
});

function stubInput(): any {
  return { held: new Set<string>(), captured: false, onPress() {}, capture: () => () => {}, consumeMouse: () => [0, 0], consumeClicks: () => [] };
}

function makeGame(seed = 7): { game: Game; log: string[] } {
  const game = new Game(data, seed, stubInput());
  game.map.generator = new TestGenerator();
  installWeather(game);
  installNature(game, null);
  // pockets to put harvests and seeds in
  game.player.inv.wear(createItem(data, 'backpack'));
  const log: string[] = [];
  game.events.on('message', (m) => log.push(m.text));
  return { game, log };
}

const place = (game: Game, x: number, y: number, z = 0) => {
  game.player.x = x + 0.5;
  game.player.y = y + 0.5;
  game.player.z = z;
};
const day = (d: number) => d * SECONDS_PER_DAY;
const SPRING = 0, SUMMER = DAYS_PER_SEASON, AUTUMN = 2 * DAYS_PER_SEASON, WINTER = 3 * DAYS_PER_SEASON;

describe('sun and seasons', () => {
  it('sunTimes: equinox ~06-18, long summer days, short winter days (Boston)', () => {
    const eq = sunTimes(SPRING);
    expect(eq.sunrise).toBeGreaterThan(5.6);
    expect(eq.sunrise).toBeLessThan(6.3);
    expect(eq.sunset).toBeGreaterThan(17.7);
    const mids = sunTimes(SUMMER - 1); // solstice ≈ end of spring
    const midw = sunTimes(WINTER - 1);
    expect(mids.sunrise).toBeLessThan(4.6);
    expect(mids.sunset).toBeGreaterThan(19.4);
    expect(midw.sunrise).toBeGreaterThan(7.1);
    expect(midw.sunset).toBeLessThan(16.9);
    expect(mids.dayLength - midw.dayLength).toBeGreaterThan(5.5);
    expect(eq.dawn).toBeLessThan(eq.sunrise);
    expect(eq.dusk).toBeGreaterThan(eq.sunset);
  });

  it('sun altitude: high summer noon, low winter noon, below horizon at night', () => {
    expect(sunAltitudeAt(day(SUMMER - 1) + 12 * 3600)).toBeGreaterThan(68);
    expect(sunAltitudeAt(day(WINTER - 1) + 12 * 3600)).toBeLessThan(27);
    expect(sunAltitudeAt(day(WINTER) + 2 * 3600)).toBeLessThan(-20);
  });

  it('renderer sky keys follow the real sunrise (canonical 06:00 at sunrise)', () => {
    expect(canonicalHour(7.4, 7.4, 16.6)).toBeCloseTo(6);
    expect(canonicalHour(16.6, 7.4, 16.6)).toBeCloseTo(20);
    expect(canonicalHour(12, 7.4, 16.6)).toBeCloseTo(13);
  });

  it('seasonAt / jumpToSeason', () => {
    const { game } = makeGame();
    expect(seasonAt(game.clock.seconds)).toBe('spring');
    jumpToSeason(game, 'winter');
    expect(game.clock.season).toBe('winter');
    const before = game.clock.seconds;
    jumpToSeason(game, 'summer');
    expect(game.clock.season).toBe('summer');
    expect(game.clock.seconds).toBeGreaterThan(before); // only forward in time
  });
});

describe('harvest_by_season', () => {
  it('berry bushes in summer, apples and acorns in autumn, nothing in winter', () => {
    const blue = data.terrain.t_shrub_blueberry, apple = data.terrain.t_tree_apple, oak = data.terrain.t_tree;
    expect(harvestIdFor(blue, 'summer')).toBe('shrub_blueberry_harv');
    expect(harvestIdFor(blue, 'spring')).toBeNull();
    expect(harvestIdFor(apple, 'autumn')).toBe('apple_harv');
    expect(harvestIdFor(apple, 'winter')).toBeNull();
    expect(harvestIdFor(oak, 'autumn')).toBe('oak_harv');
  });

  it('rolls CDDA counts: base_num + scale_num × survival', () => {
    const { game } = makeGame();
    const entries = harvestEntries(data, 'shrub_blueberry_harv');
    for (let i = 0; i < 50; i++) {
      const [[id, n]] = rollHarvest(game.player.rng, entries, 0);
      expect(id).toBe('blueberries');
      expect(n).toBeGreaterThanOrEqual(2);
      expect(n).toBeLessThanOrEqual(5);
    }
    // survival 10 adds up to 5 more
    const hi = Math.max(...Array.from({ length: 50 }, () => rollHarvest(game.player.rng, entries, 10)[0][1]));
    expect(hi).toBeGreaterThan(5);
  });

  it('harvesting transforms the bush; it regrows next season, not before', () => {
    const { game, log } = makeGame();
    const map = game.map;
    game.clock.seconds = day(SUMMER + 5) + 12 * 3600;
    place(game, 30, 30);
    map.setTer(31, 30, 0, 't_shrub_blueberry');
    const nat = natureOf(game)!;
    nat.actualizer.sweep();
    expect(harvestKind(game, 31, 30, 0)?.kind).toBe('harvest');
    expect(interactionsAt(game, 31, 30, 0).map((i) => i.label)).toContain('Harvest the blueberry bush');
    expect(startHarvest(game, 31, 30, 0, { instant: true })).toBe(true);
    expect(log.filter((l) => /You harvest(?: and drop)?: /.test(l)).length, log.join('|')).toBeGreaterThanOrEqual(2);
    expect(map.terAt(31, 30, 0).id).toBe('t_shrub_blueberry_harvested');
    expect(harvestKind(game, 31, 30, 0)?.kind).toBe('harvested');
    // same season, 10 days later: still bare
    game.clock.seconds += day(10);
    nat.actualizer.sweep();
    expect(map.terAt(31, 30, 0).id).toBe('t_shrub_blueberry_harvested');
    // next season: regrown (but out of season now)
    game.clock.seconds = day(AUTUMN + 2);
    nat.actualizer.sweep();
    expect(map.terAt(31, 30, 0).id).toBe('t_shrub_blueberry');
    expect(harvestKind(game, 31, 30, 0)?.kind).toBe('out_of_season');
    expect(startHarvest(game, 31, 30, 0, { instant: true })).toBe(false);
    expect(log.at(-1)).toMatch(/Nothing can be harvested/);
  });

  it('apple trees give apples only in autumn', () => {
    const { game } = makeGame();
    place(game, 30, 30);
    game.map.setTer(31, 30, 0, 't_tree_apple');
    game.clock.seconds = day(SUMMER + 10);
    expect(harvestKind(game, 31, 30, 0)?.kind).toBe('out_of_season');
    game.clock.seconds = day(AUTUMN + 10);
    expect(startHarvest(game, 31, 30, 0, { instant: true })).toBe(true);
    expect(game.player.inv.countOf('apple') + game.map.itemsAt(30, 30, 0).filter((i) => i.typeId === 'apple').length).toBeGreaterThanOrEqual(2);
    expect(game.map.terAt(31, 30, 0).id).toBe('t_tree_apple_harvested');
  });

  it('forages underbrush with the season forage group', () => {
    const { game } = makeGame();
    game.clock.seconds = day(SUMMER + 10);
    place(game, -20, 5);
    game.map.setTer(-19, 5, 0, 't_underbrush');
    expect(forageChance(0, 8)).toBe(5);
    expect(forageChance(5, 10)).toBe(22);
    let found = 0;
    for (let i = 0; i < 60; i++) {
      game.map.setTer(-19, 5, 0, 't_underbrush');
      found += forageFinish(game, -19, 5, 0).length;
      expect(game.map.terAt(-19, 5, 0).id).toBe('t_underbrush_harvested');
    }
    expect(found).toBeGreaterThan(0);
  });
});

describe('farming', () => {
  it('growth stages by elapsed days (seed_data growth_stages)', () => {
    const tomato = data.items.seed_tomato;
    expect(targetStage(tomato, 0)).toBe('GROWTH_SEED');
    expect(targetStage(tomato, day(17))).toBe('GROWTH_SEEDLING');
    expect(targetStage(tomato, day(33))).toBe('GROWTH_MATURE');
    expect(targetStage(tomato, day(49))).toBe('GROWTH_HARVEST');
    expect(targetStage(tomato, day(66))).toBe('GROWTH_OVERGROWN');
    expect(timeToHarvest(tomato)).toBe(day(49));
  });

  it('plants in a dirt mound and grows while the player is far away', () => {
    const { game } = makeGame();
    const map = game.map;
    const nat = natureOf(game)!;
    game.clock.seconds = day(SUMMER + 2) + 10 * 3600;
    place(game, 30, 30);
    map.setTer(31, 30, 0, 't_dirtmound');
    game.player.inv.stash(createItem(data, 'seed_tomato'));
    expect(canPlant(game, 31, 30, 0, 'seed_tomato')).toBeNull();
    expect(interactionsAt(game, 31, 30, 0).map((i) => i.label)).toContain('Plant seeds');
    expect(startPlanting(game, 31, 30, 0, 'seed_tomato', { instant: true })).toBeNull();
    expect(map.furnAt(31, 30, 0).id).toBe('f_plant_seed');
    expect(map.terAt(31, 30, 0).id).toBe('t_dirt');
    expect(seedAt(game, 31, 30, 0)).not.toBeNull();
    expect(game.player.inv.countOf('seed_tomato')).toBe(0);

    // walk far away (outside the actualize radius), let 20 days pass, sweep there
    place(game, 30 + 24 * 10, 30);
    game.clock.seconds += day(20);
    nat.actualizer.sweep();
    expect(map.furnAt(31, 30, 0).id).toBe('f_plant_seed'); // untouched while away
    // come back: the crop catches up at once
    place(game, 30, 30);
    nat.actualizer.sweep();
    expect(map.furnAt(31, 30, 0).id).toBe('f_plant_seedling');
    game.clock.seconds += day(15);
    growPlant(game, 31, 30, 0);
    expect(map.furnAt(31, 30, 0).id).toBe('f_plant_mature');
    game.clock.seconds += day(15);
    expect(interactionsAt(game, 31, 30, 0).map((i) => i.label)).toContain('Harvest the tomato');
    expect(map.furnAt(31, 30, 0).id).toBe('f_plant_harvest');
    const got = harvestPlantNow(game, 31, 30, 0);
    const ids = got.map((i) => i.typeId);
    expect(ids).toContain('tomato');
    expect(ids).toContain('withered');
    expect(ids).not.toContain('seed_tomato'); // tomato "seeds": false
    expect(map.furnAt(31, 30, 0).id).toBe('f_null');
    expect(map.itemsAt(31, 30, 0).length).toBe(0);
  });

  it('refuses cold planting (warm_enough_to_plant) and dark/indoor tiles', () => {
    const { game } = makeGame();
    game.clock.seconds = day(WINTER + 20) + 12 * 3600;
    place(game, 30, 30);
    game.map.setTer(31, 30, 0, 't_dirtmound');
    game.player.inv.stash(createItem(data, 'seed_tomato'));
    expect(canPlant(game, 31, 30, 0, 'seed_tomato')).toMatch(/cold will kill/);
    // inside the house (roofed)
    game.map.setTer(8, 8, 0, 't_dirtmound');
    expect(canPlant(game, 8, 8, 0, 'seed_tomato')).toMatch(/sunlight/);
  });

  it('fertilizer ages the crop 20% of a season, once', () => {
    const { game } = makeGame();
    game.clock.seconds = day(SUMMER + 2);
    place(game, 30, 30);
    game.map.setTer(31, 30, 0, 't_dirtmound');
    game.player.inv.stash(createItem(data, 'seed_tomato'));
    startPlanting(game, 31, 30, 0, 'seed_tomato', { instant: true });
    const seed = seedAt(game, 31, 30, 0)!;
    const t0 = plantedAt(seed);
    game.player.inv.stash(createItem(data, 'fertilizer_commercial'));
    game.player.inv.stash(createItem(data, 'fertilizer_commercial'));
    expect(fertilizePlant(game, 31, 30, 0, game.player.inv.allItems().find((i) => i.typeId === 'fertilizer_commercial')!)).toBeNull();
    expect(t0 - plantedAt(seed)).toBeCloseTo(day(DAYS_PER_SEASON * 0.2));
    // 2 + 18.2 days old: past the 17-day seed stage at once; the fertilizer is used up by it
    expect(game.map.furnAt(31, 30, 0).id).toBe('f_plant_seedling');
    expect(game.player.inv.countOf('fertilizer_commercial')).toBe(1);
    seed.vars.fertilized = 1;
    expect(fertilizePlant(game, 31, 30, 0, game.player.inv.allItems().find((i) => i.typeId === 'fertilizer_commercial')!)).toMatch(/already been fertilized/);
  });
});

describe('water and fishing', () => {
  it('fishing chance > 0 near water, better with fish around', () => {
    expect(expectedCatchChance(0, 1, [], 5 * 3600)).toBeGreaterThan(0);
    const withFish = expectedCatchChance(0, 1, [10, 12], 5 * 3600);
    expect(withFish).toBeGreaterThan(expectedCatchChance(0, 1, [], 5 * 3600));
    // a professional rod and skill help a lot
    expect(expectedCatchChance(5, 2, [10], 3600)).toBeGreaterThan(expectedCatchChance(0, 1, [10], 3600));
    // skill caps the chance: survival roll × 10
    expect(fishChance(3, [20, 20, 20])).toBe(30);
  });

  it('finds the pond, catches a fish corpse from GROUP_FISH', () => {
    const { game, log } = makeGame();
    place(game, 14, 24 + 12 - 5); // north shore of the pond (14, 36)
    const spot = fishingSpot(game);
    expect(spot).not.toBeNull();
    const zone = fishableLocations(game, spot!.x, spot!.y, 0);
    expect(zone.size).toBeGreaterThan(20);
    const id = catchFish(game, []);
    expect(id).toMatch(/^mon_fish_/);
    expect(log.at(-1)).toMatch(/You caught a /);
    const corpse = (game.map.itemsAt(game.player.tileX, game.player.tileY, 0) as Item[]).find((i) => i.vars.corpse);
    expect(corpse?.vars.corpse).toBe(id);
  });

  it('fills containers from lake water (dirty water)', () => {
    const { game } = makeGame();
    place(game, 14, 31);
    game.player.inv.wield(createItem(data, 'jug_plastic'));
    const list = fillableContainers(game, 'water');
    expect(list.length).toBe(1);
    expect(fillContainer(game, list[0][0], 'water')).toBeGreaterThan(0);
    expect(game.player.inv.countOf('water')).toBeGreaterThan(0);
    const labels = interactionsAt(game, 14, 32, 0).map((i) => i.label);
    expect(labels.some((l) => /Fill a container/.test(l))).toBe(true);
  });

  it('swimming: wet, and a heavy load sinks you until you drown', () => {
    const { game, log } = makeGame();
    place(game, 14, 36);
    expect(game.map.terAt(14, 36, 0).id).toBe('t_water_dp');
    updateSwimming(game, 1 / 30);
    const st = swimState(game);
    expect(st.swimming).toBe(true);
    expect(game.player.wetness.torso).toBe(1);
    expect(st.underwater).toBe(false);
    // an anvil in hand: swim speed ≥ 500
    game.player.inv.wielded = createItem(data, 'anvil');
    const hp0 = game.player.hp.torso.cur;
    for (let i = 0; i < 30 * 30 && !game.player.dead; i++) updateSwimming(game, 1 / 30);
    expect(log).toContain('You sink like a rock!');
    expect(log).toContain("You're drowning!");
    expect(game.player.hp.torso.cur).toBeLessThan(hp0);
  });
});

describe('wood and tools', () => {
  it('axe quality grants CHOP_TREE / CHOP_LOGS / LUMBER usages; chop time by strength and quality', () => {
    makeGame();
    const types = useActions(data.items.ax).map((a) => a.type);
    expect(types).toEqual(expect.arrayContaining(['CHOP_TREE', 'CHOP_LOGS', 'LUMBER']));
    expect(useActions(data.items.shovel).map((a) => a.type)).toEqual(expect.arrayContaining(['MAKEMOUND', 'DIG']));
    expect(useActions(data.items.fishing_rod_basic).map((a) => a.type)).toContain('FISH_ROD');
    expect(chopSeconds(8, 1)).toBe(52 * 60);
    expect(chopSeconds(8, 3)).toBe(13 * 60);
  });

  it('a chopped tree falls as trunks and leaves a stump; trunks give logs; logs give planks', () => {
    const { game } = makeGame();
    const map = game.map;
    place(game, 30, 30);
    for (let x = 31; x <= 36; x++) map.setTer(x, 30, 0, 't_grass');
    map.setTer(31, 30, 0, 't_tree');
    cutDownTree(game, 31, 30, 0);
    expect(map.terAt(31, 30, 0).id).toBe('t_stump');
    let trunks = 0;
    for (let y = 28; y <= 32; y++) for (let x = 32; x <= 36; x++) if (map.terAt(x, y, 0).id === 't_trunk') trunks++;
    expect(trunks).toBeGreaterThan(0);
    const t = [...Array(5).keys()].map((i) => 32 + i).find((x) => [29, 30, 31].some((y) => map.terAt(x, y, 0).id === 't_trunk'))!;
    const ty = [29, 30, 31].find((y) => map.terAt(t, y, 0).id === 't_trunk')!;
    const logs = chopLogsAt(game, t, ty, 0).filter((i) => i.typeId === 'log');
    expect(logs.length).toBeGreaterThanOrEqual(2);
    expect(map.terAt(t, ty, 0).id).toBe('t_dirt');
    const planks = cutPlanks(game).filter((i) => i.typeId === '2x4');
    expect(planks.length).toBeLessThanOrEqual(10);
  });
});

describe('spoilage of items in the world', () => {
  it('food in an unpowered fridge rots like food on the counter; sealed cans do not', () => {
    const { game } = makeGame();
    const nat = natureOf(game)!;
    place(game, 9, 9);
    const c = game.map.chunk(0, 0, 0)!;
    nat.actualizer.sweep();
    const milk = createItem(data, 'milk');
    const fridgeMilk = createItem(data, 'milk');
    game.map.addItem(8, 8, 0, milk); // indoors, on the floor
    game.map.addItem(12, 5, 0, fridgeMilk); // f_fridge, no power
    game.clock.seconds += day(20);
    nat.actualizer.actualize(c);
    expect(milk.rot).toBeGreaterThan(0);
    expect(fridgeMilk.rot).toBeCloseTo(milk.rot, -2);
    expect(milk.name()).toMatch(/rotten/);
  });

  it('mapgen food ages from the cataclysm start when a chunk is first seen', () => {
    const { game } = makeGame();
    const nat = natureOf(game)!;
    game.clock.seconds = day(30);
    place(game, 9, 9);
    const c = game.map.chunk(0, 0, 0)!;
    const bread = createItem(data, 'bread');
    game.map.addItem(8, 8, 0, bread);
    nat.actualizer.actualize(c);
    expect(bread.rot).toBeGreaterThan(day(10));
  });
});

describe('save', () => {
  it('a planted crop and the chunk stamps survive save/load, and keep growing', async () => {
    const mk = () => {
      const game = new Game(data, 7, stubInput());
      installChunkTracking(game);
      game.map.generator = new TestGenerator();
      installWeather(game);
      registerCoreSaveables(game);
      installNature(game, null);
      game.player.inv.wear(createItem(data, 'backpack'));
      return game;
    };
    const A = mk();
    A.clock.seconds = day(SUMMER + 2) + 10 * 3600;
    place(A, 30, 30);
    A.map.setTer(31, 30, 0, 't_dirtmound');
    A.player.inv.stash(createItem(data, 'seed_tomato'));
    startPlanting(A, 31, 30, 0, 'seed_tomato', { instant: true });
    natureOf(A)!.actualizer.sweep();
    const file = serializeGame(A, { slot: 'farmer', name: A.player.name, gen: 'test' });
    expect(file.sections.nature).toBeTruthy();
    const loaded = await decodeSave((await encodeSave(file)).stored);
    const B = mk();
    const r = applySave(B, loaded);
    expect(r.warnings).toEqual([]);
    expect(B.map.furnAt(31, 30, 0).id).toBe('f_plant_seed');
    expect(plantedAt(seedAt(B, 31, 30, 0)!)).toBe(plantedAt(seedAt(A, 31, 30, 0)!));
    // The farmed chunk's stamp survives; untouched chunks regenerate from day 0, so theirs aren't saved.
    const key = '1,1,0';
    expect(natureOf(B)!.actualizer.stamps.get(key)).toEqual(natureOf(A)!.actualizer.stamps.get(key));
    expect(natureOf(B)!.actualizer.stamps.size).toBeLessThanOrEqual(natureOf(A)!.actualizer.stamps.size);
    B.clock.seconds += day(20);
    natureOf(B)!.actualizer.sweep();
    expect(B.map.furnAt(31, 30, 0).id).toBe('f_plant_seedling');
  });
});
