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
import { harvestIdFor, harvestEntries, seasonalHarvestEntries, rollHarvest, startHarvest, harvestKind, forageFinish, forageChance } from '../src/game/harvest';
import { targetStage, timeToHarvest, plantEpoch, startPlanting, growPlant, harvestPlantNow, seedAt, canPlant, fertilizePlant, plantedAt } from '../src/game/farming';
import { expectedCatchChance, fishChance, catchFish, fillableContainers, fillContainer, fishingSpot, updateSwimming, swimState, fishableLocations } from '../src/game/water';
import { chopSeconds, cutDownTree, chopLogsAt, cutPlanks } from '../src/game/woodcut';
import { useActions } from '../src/game/inventory';
import { consumeItem } from '../src/game/moves';
import { startClearRubble } from '../src/game/rubble';
import { Npc, FACTION_FOLLOWERS } from '../src/game/npc';
import { storedEnergy, upsEffMult, upsUsefulEnergy } from '../src/game/upsTransfer';
import { installNature, jumpToSeason, natureOf } from '../src/nature';
import { BnInventoryModel } from '../src/ui2/bn/model';
import { applyPickerChoice } from '../src/ui2/bn/install';
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
  game.player.inv.wear(createItem(data, 'backpack'), null);
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
  it('BN inline berries in spring and autumn tree fruit', () => {
    const blue = data.terrain.t_shrub_blueberry, apple = data.terrain.t_tree_apple, oak = data.terrain.t_tree;
    expect(seasonalHarvestEntries(data, blue, 'spring')[0].drop).toBe('blueberries');
    expect(seasonalHarvestEntries(data, blue, 'summer')).toEqual([]);
    expect(seasonalHarvestEntries(data, apple, 'autumn')[0].drop).toBe('apple');
    expect(seasonalHarvestEntries(data, apple, 'winter').map((e) => e.drop)).not.toContain('apple');
    expect(seasonalHarvestEntries(data, oak, 'autumn')[0].drop).toBe('acorns');
  });

  it('rolls BN counts: base_num + scale_num × survival', () => {
    const { game } = makeGame();
    const entries = seasonalHarvestEntries(data, data.terrain.t_shrub_blueberry, 'spring');
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
    game.clock.seconds = day(5) + 12 * 3600;
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
    game.weather!.temperature = 25;
    game.clock.seconds = day(SUMMER + 2);
    nat.actualizer.sweep();
    expect(map.terAt(31, 30, 0).id).toBe('t_shrub_blueberry');
    expect(harvestKind(game, 31, 30, 0)?.kind).toBe('out_of_season');
    expect(startHarvest(game, 31, 30, 0, { instant: true })).toBe(false);
    expect(log.at(-1)).toMatch(/Nothing can be harvested/);
  });

  it('apple trees give apples in autumn and sticks otherwise', () => {
    const { game } = makeGame();
    place(game, 30, 30);
    game.map.setTer(31, 30, 0, 't_tree_apple');
    game.clock.seconds = day(SUMMER + 10);
    expect(harvestKind(game, 31, 30, 0)?.kind).toBe('harvest');
    expect(seasonalHarvestEntries(data, data.terrain.t_tree_apple, 'summer').map((e) => e.drop)).not.toContain('apple');
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
      expect(game.map.terAt(-19, 5, 0).id).toBe('t_underbrush_harvested_summer');
    }
    expect(found).toBeGreaterThan(0);
  });
});

describe('farming', () => {
  it('cancelled planting preserves the seed; an occupied site blocks completion', () => {
    const { game } = makeGame();
    game.weather!.temperature = 25;
    game.clock.seconds = day(SUMMER + 2) + 12 * 3600;
    place(game, 30, 30);
    game.map.setTer(31, 30, 0, 't_dirtmound');
    game.player.inv.stashNew(createItem(data, 'seed_tomato', { charges: 2 }));
    expect(startPlanting(game, 31, 30, 0, 'seed_tomato')).toBeNull();
    game.activities.cancel('You stop.');
    expect(game.player.inv.countOf('seed_tomato')).toBe(2);
    expect(seedAt(game, 31, 30, 0)).toBeNull();
    expect(startPlanting(game, 31, 30, 0, 'seed_tomato')).toBeNull();
    game.map.addItem(31, 30, 0, createItem(data, 'rock'));
    game.activities.current!.spec.onComplete!();
    game.activities.cancel('Done testing the blocked completion.');
    expect(game.player.inv.countOf('seed_tomato')).toBe(2);
    expect(game.map.furnAt(31, 30, 0).id).toBe('f_null');
    expect(game.map.itemsAt(31, 30, 0).map((it) => it.typeId)).toEqual(['rock']);
  });
  it('growth stages by BN seed_data grow and season scaling', () => {
    const tomato = data.items.seed_tomato;
    expect(targetStage(tomato, 0)).toBe('GROWTH_SEED');
    const epoch = day(10) * DAYS_PER_SEASON / 14 / 3;
    expect(plantEpoch(tomato)).toBe(epoch);
    expect(targetStage(tomato, epoch)).toBe('GROWTH_SEEDLING');
    expect(targetStage(tomato, epoch * 2)).toBe('GROWTH_MATURE');
    expect(targetStage(tomato, epoch * 3)).toBe('GROWTH_HARVEST');
    expect(targetStage(tomato, epoch * 10)).toBe('GROWTH_HARVEST');
    expect(timeToHarvest(tomato)).toBe(epoch * 3);
  });

  it('plants in a dirt mound and grows while the player is far away', () => {
    const { game } = makeGame();
    const map = game.map;
    const nat = natureOf(game)!;
    game.weather!.temperature = 25;
    game.clock.seconds = day(SUMMER + 2) + 10 * 3600;
    place(game, 30, 30);
    map.setTer(31, 30, 0, 't_dirtmound');
    game.player.inv.stashNew(createItem(data, 'seed_tomato'));
    expect(canPlant(game, 31, 30, 0, 'seed_tomato')).toBeNull();
    expect(interactionsAt(game, 31, 30, 0).map((i) => i.label)).toContain('Plant seeds');
    expect(startPlanting(game, 31, 30, 0, 'seed_tomato', { instant: true })).toBeNull();
    expect(map.furnAt(31, 30, 0).id).toBe('f_plant_seed');
    expect(map.terAt(31, 30, 0).id).toBe('t_dirt');
    expect(seedAt(game, 31, 30, 0)).not.toBeNull();
    expect(game.player.inv.countOf('seed_tomato')).toBe(3);
    expect(seedAt(game, 31, 30, 0)!.count()).toBe(1);

    // Walk away beyond actualization, let one BN epoch pass, then return.
    place(game, 30 + 24 * 10, 30);
    game.clock.seconds += plantEpoch(data.items.seed_tomato) + 1;
    nat.actualizer.sweep();
    expect(map.furnAt(31, 30, 0).id).toBe('f_plant_seed'); // untouched while away
    // come back: the crop catches up at once
    place(game, 30, 30);
    nat.actualizer.sweep();
    expect(map.furnAt(31, 30, 0).id).toBe('f_plant_seedling');
    game.clock.seconds += plantEpoch(data.items.seed_tomato);
    growPlant(game, 31, 30, 0);
    expect(map.furnAt(31, 30, 0).id).toBe('f_plant_mature');
    game.clock.seconds += plantEpoch(data.items.seed_tomato);
    expect(interactionsAt(game, 31, 30, 0).map((i) => i.label)).toContain('Harvest the tomato');
    expect(map.furnAt(31, 30, 0).id).toBe('f_plant_harvest');
    const got = harvestPlantNow(game, 31, 30, 0);
    const ids = got.map((i) => i.typeId);
    expect(ids).toContain('tomato');
    expect(ids).toContain('withered');
    expect(ids).toContain('seed_tomato'); // BN defaults to returning seeds.
    expect(map.furnAt(31, 30, 0).id).toBe('f_null');
    expect(map.itemsAt(31, 30, 0).length).toBe(0);
  });

  it('refuses cold planting but permits roofed warm soil', () => {
    const { game } = makeGame();
    game.weather!.temperature = -5;
    game.clock.seconds = day(WINTER + 20) + 12 * 3600;
    place(game, 30, 30);
    game.map.setTer(31, 30, 0, 't_dirtmound');
    game.player.inv.stashNew(createItem(data, 'seed_tomato'));
    expect(canPlant(game, 31, 30, 0, 'seed_tomato')).toMatch(/too cold/);
    // inside the house (roofed)
    game.map.setTer(8, 8, 0, 't_dirtmound');
    game.weather!.temperature = 25;
    game.clock.seconds = day(SUMMER + 2) + 12 * 3600;
    expect(canPlant(game, 8, 8, 0, 'seed_tomato')).toBeNull();
  });

  it('fertilizer ages the crop by 60% of its BN epoch, once per stage', () => {
    const { game } = makeGame();
    game.weather!.temperature = 25;
    game.clock.seconds = day(SUMMER + 2);
    place(game, 30, 30);
    game.map.setTer(31, 30, 0, 't_dirtmound');
    game.player.inv.stashNew(createItem(data, 'seed_tomato'));
    startPlanting(game, 31, 30, 0, 'seed_tomato', { instant: true });
    const seed = seedAt(game, 31, 30, 0)!;
    const t0 = plantedAt(seed);
    game.player.inv.stashNew(createItem(data, 'fertilizer_commercial'));
    game.player.inv.stashNew(createItem(data, 'fertilizer_commercial'));
    expect(fertilizePlant(game, 31, 30, 0, game.player.inv.allItems().find((i) => i.typeId === 'fertilizer_commercial')!)).toBeNull();
    expect(t0 - plantedAt(seed)).toBeCloseTo(plantEpoch(data.items.seed_tomato) * 0.6);
    // A 60% epoch boost alone stays within the seed stage.
    expect(game.map.furnAt(31, 30, 0).id).toBe('f_plant_seed');
    expect(game.player.inv.countOf('fertilizer_commercial')).toBe(119);
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
    game.player.inv.wield(createItem(data, 'jug_plastic'), null);
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
    game.player.inv.wield(createItem(data, 'anvil'), null);
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

  it('a tool-quality use (`A`pply an axe) fires its item-use gesture only when the chop actually finishes, never on open or cancel', () => {
    const { game } = makeGame();
    place(game, 30, 30);
    game.map.setTer(31, 30, 0, 't_grass');
    game.map.setTer(31, 30, 0, 't_tree');
    const axe = createItem(data, 'ax');
    game.player.inv.wield(axe, null);
    const idx = useActions(axe.def).findIndex((a) => a.type === 'CHOP_TREE');
    expect(idx).toBeGreaterThanOrEqual(0);
    const seen: { kind: string; item: { typeId: string } }[] = [];
    game.player.inv.onItemPresentation.push((a) => seen.push(a as any));

    // Opening/accepting the action (the activity starts) must not animate it yet.
    const started = game.player.inv.use(axe, undefined, idx);
    expect(started.ok).toBe(true);
    expect(started.deferred).toBe(true);
    expect(game.activities.current).not.toBeNull();
    expect(seen).toHaveLength(0);

    // Cancelling it (walking off, interrupted) must never animate it either.
    game.activities.cancel('You stop chopping.');
    expect(seen).toHaveLength(0);
    expect(game.map.terAt(31, 30, 0).id).toBe('t_tree');

    // Trying again and letting the activity actually finish fires it exactly once, showing
    // the real tool (not the finished stump/trunks).
    expect(game.player.inv.use(axe, undefined, idx).ok).toBe(true);
    game.activities.current!.spec.onComplete();
    expect(game.map.terAt(31, 30, 0).id).toBe('t_stump');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: 'use', item: { typeId: 'ax' }, moves: 0 });
  });

  it('the `u` apply picker\'s Use submenu for an axe lists its real tool actions (regression: a second model.actions() call used to make this submenu always come up empty), and choosing one starts and completes the activity, firing the deferred gesture', () => {
    const { game } = makeGame();
    place(game, 40, 40);
    game.map.setTer(41, 40, 0, 't_grass');
    game.map.setTer(41, 40, 0, 't_tree');
    const axe = createItem(data, 'ax');
    game.player.inv.wield(axe, null);
    const seen: { kind: string; item: { typeId: string } }[] = [];
    game.player.inv.onItemPresentation.push((a) => seen.push(a as any));

    const model = new BnInventoryModel(() => ({ who: game.player, map: game.map, at: { x: game.player.tileX, y: game.player.tileY, z: game.player.z } }));
    model.refresh();
    const hands = model.contents('hands')[0];
    expect(hands?.typeId).toBe('ax');

    const choice = applyPickerChoice(model, hands, 'hands');
    expect(choice?.kind).toBe('submenu');
    if (choice?.kind !== 'submenu') throw new Error('expected the axe to offer a Use submenu');
    // BN's own item_actions.json names (docs/GAP_IMPLEMENTATION_WORK.md use-menu fix), not the
    // raw CHOP_TREE/CHOP_LOGS/LUMBER ids.
    const labels = choice.items.map((i) => ('label' in i ? i.label : ''));
    expect(labels).toEqual(expect.arrayContaining(['Chop down a tree', 'Chop a Tree Trunk into logs', 'Cut a log into planks']));

    const chop = choice.items.find((i) => 'label' in i && i.label === 'Chop down a tree');
    expect(chop && 'action' in chop && !!chop.action).toBe(true);
    (chop as { action: () => void }).action();
    expect(game.activities.current?.spec.name).toMatch(/chopping down/);
    expect(seen).toHaveLength(0);

    game.activities.current!.spec.onComplete();
    expect(game.map.terAt(41, 40, 0).id).toBe('t_stump');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: 'use', item: { typeId: 'ax' } });
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
      game.player.inv.wear(createItem(data, 'backpack'), null);
      return game;
    };
    const A = mk();
    A.weather!.temperature = 25;
    A.clock.seconds = day(SUMMER + 2) + 10 * 3600;
    place(A, 30, 30);
    A.map.setTer(31, 30, 0, 't_dirtmound');
    A.player.inv.stashNew(createItem(data, 'seed_tomato'));
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
    B.clock.seconds += plantEpoch(data.items.seed_tomato) + 1;
    natureOf(B)!.actualizer.sweep();
    expect(B.map.furnAt(31, 30, 0).id).toBe('f_plant_seedling');
  });
});


describe('BN clearing rubble', () => {
  const at = { x: 13, y: 12, z: 0 };
  const setup = (id = 'shovel') => {
    const { game } = makeGame();
    place(game, 12, 12);
    const tool = createItem(data, id);
    game.player.inv.giveNew(tool);
    game.map.setFurn(at.x, at.y, at.z, 'f_rubble_rock');
    return { game, tool };
  };
  const complete = (game: Game) => {
    const action = game.activities.current!;
    game.activities.current = null;
    action.spec.onComplete();
  };
  it('uses BN examine/tool durations and rejects inadequate examine quality', () => {
    const { game, tool } = setup();
    expect(startClearRubble(game, at)).toBe(true);
    expect(game.activities.current?.spec.duration).toBe(60);
    game.activities.cancel('cancel');
    expect(startClearRubble(game, at, tool)).toBe(true);
    expect(game.activities.current?.spec.duration).toBe(15);
    const primitive = setup('primitive_shovel');
    expect(startClearRubble(primitive.game, at)).toBe(true);
    expect(primitive.game.activities.current?.spec.duration).toBe(120);
    const stick = setup('digging_stick');
    expect(startClearRubble(stick.game, at)).toBe(false);
    expect(startClearRubble(stick.game, at, stick.tool)).toBe(true);
    expect(stick.game.activities.current?.spec.duration).toBe(30);
  });
  it('tool activation spends the real auger20 charges only after an accepted start; examine spends none', () => {
    const { game } = setup('auger');
    const auger = game.player.inv.carried().find((it) => it.typeId === 'auger')!;
    expect(startClearRubble(game, at, auger)).toBe(false);
    expect(game.activities.current).toBeNull();
    expect(auger.ammoRemaining()).toBe(0);
    auger.charges = 40;
    expect(startClearRubble(game, { ...at, x: 99 }, auger)).toBe(false);
    expect(auger.ammoRemaining()).toBe(40);
    game.activities.dangerChecks.push(() => 'danger');
    expect(startClearRubble(game, at, auger)).toBe(false);
    expect(auger.ammoRemaining()).toBe(40);
    game.activities.dangerChecks.length = 0;
    expect(startClearRubble(game, at, auger)).toBe(true);
    expect(auger.ammoRemaining()).toBe(20);
    game.activities.cancel('cancel');
    expect(startClearRubble(game, at)).toBe(true);
    expect(auger.ammoRemaining()).toBe(20);
  });
  it('a USE_UPS tool pays remaining activation energy from carried UPS after its internal charges', () => {
    const { game } = setup('digging_stick');
    const upsData = { ...data, items: { ...data.items, auger: { ...data.items.auger, flags: [...data.items.auger.flags ?? [], 'USE_UPS'] } } };
    const tool = createItem(upsData, 'auger', { ammo: 'gasoline', ammoCount: 5 });
    const ups = createItem(data, 'adv_UPS_off');
    game.player.inv.giveNew(tool); game.player.inv.giveNew(ups);
    expect(upsEffMult(ups)).toBe(2);
    const cost = Number(tool.def.charges_per_use);
    const before = upsUsefulEnergy(ups);
    expect(startClearRubble(game, at, tool)).toBe(true);
    expect(tool.ammoRemaining()).toBe(0);
    // BN use_charges(itype_UPS): the advanced UPS pays (cost - 5 own charges) useful kJ at
    // ups_eff_mult 2, i.e. half that of its own charge; the half-charge stays as credit.
    expect(upsUsefulEnergy(ups)).toBeCloseTo(before - (cost - 5), 9);
    expect(storedEnergy(ups)).toBeCloseTo(5000 - (cost - 5) / 2, 9);
  });
  it('clears furniture and adds real bash drops at the source without losing sealed contents or tool', () => {
    const { game, tool } = setup();
    const rag = createItem(data, 'rag');
    game.map.addItem(at.x, at.y, at.z, rag);
    expect(interactionsAt(game, at.x, at.y, at.z).map((a) => a.id)).toContain('clear_rubble');
    expect(startClearRubble(game, at)).toBe(true);
    complete(game);
    expect(game.map.furnAt(at.x, at.y, at.z).id).toBe('f_null');
    const items = game.map.itemsAt(at.x, at.y, at.z) as Item[];
    expect(items).toContain(rag);
    const total = (id: string) => items.filter((it) => it.typeId === id).reduce((n, it) => n + it.count(), 0);
    expect(total('rock')).toBeGreaterThanOrEqual(5);
    expect(total('rock')).toBeLessThanOrEqual(10);
    expect(total('sharp_rock')).toBeGreaterThanOrEqual(1);
    expect(total('sharp_rock')).toBeLessThanOrEqual(5);
    expect(game.player.inv.has(tool)).toBe(true);
    expect(game.map.itemsAt(12, 12, 0)).toHaveLength(0);
    const before = items.map((it) => it.toJSON());
    expect(startClearRubble(game, at)).toBe(false);
    expect(items.map((it) => it.toJSON())).toEqual(before);
  });
  it('cancellation and a replaced site produce no drops and preserve the replacement', () => {
    const { game } = setup();
    expect(startClearRubble(game, at)).toBe(true);
    game.activities.cancel('moving');
    expect(game.map.furnAt(at.x, at.y, at.z).id).toBe('f_rubble_rock');
    expect(game.map.itemsAt(at.x, at.y, at.z)).toHaveLength(0);
    expect(startClearRubble(game, at)).toBe(true);
    game.map.setFurn(at.x, at.y, at.z, 'f_chair');
    complete(game);
    expect(game.map.furnAt(at.x, at.y, at.z).id).toBe('f_chair');
    expect(game.map.itemsAt(at.x, at.y, at.z)).toHaveLength(0);
  });
  it('lost tool and moved worker cannot complete remotely', () => {
    const { game, tool } = setup();
    expect(startClearRubble(game, at, tool)).toBe(true);
    place(game, 20, 20);
    complete(game);
    expect(game.map.furnAt(at.x, at.y, at.z).id).toBe('f_rubble_rock');
    expect(game.map.itemsAt(at.x, at.y, at.z)).toHaveLength(0);
    const lost = setup();
    expect(startClearRubble(lost.game, at, lost.tool)).toBe(true);
    consumeItem(lost.tool, lost.game.player.inv.locOf(lost.tool)!);
    complete(lost.game);
    expect(lost.game.map.furnAt(at.x, at.y, at.z).id).toBe('f_rubble_rock');
    expect(lost.game.map.itemsAt(at.x, at.y, at.z)).toHaveLength(0);
  });
  it('keeps unfinished progress through a cancellation and resumes on the same tile without paying tool energy twice', () => {
    const { game } = setup('auger');
    const auger = game.player.inv.carried().find((it) => it.typeId === 'auger')!;
    auger.charges = 999;
    expect(startClearRubble(game, at, auger)).toBe(true);
    expect(auger.ammoRemaining()).toBe(979);
    const full = game.activities.current!.spec.duration;
    for (let i = 0; i < 2; i++) game.tick(1 / 30);
    const partial = game.activities.current!.elapsed;
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(full);
    game.activities.cancel('moving');
    expect(game.activities.current).toBeNull();
    expect(game.map.furnAt(at.x, at.y, at.z).id).toBe('f_rubble_rock');
    // Resuming at the same tile with the same tool continues from where it stopped and does
    // not spend the auger's charges a second time (BN never re-invokes iuse on a resume).
    expect(startClearRubble(game, at, auger)).toBe(true);
    expect(auger.ammoRemaining()).toBe(979);
    expect(game.activities.current!.spec.duration).toBeCloseTo(full - partial, 5);
    for (let i = 0; i < 30 * 10; i++) game.tick(1 / 30);
    expect(game.map.furnAt(at.x, at.y, at.z).id).toBe('f_null');
    const items = game.map.itemsAt(at.x, at.y, at.z) as Item[];
    const total = (id: string) => items.filter((it) => it.typeId === id).reduce((n, it) => n + it.count(), 0);
    expect(total('rock')).toBeGreaterThanOrEqual(5);
    expect(total('rock')).toBeLessThanOrEqual(10);
  });
  it('switching tool/path after a cancellation starts over rather than resuming a mismatched index', () => {
    const { game, tool } = setup();
    expect(startClearRubble(game, at)).toBe(true);
    expect(game.activities.current?.spec.duration).toBe(60);
    game.activities.cancel('cancel');
    // BN's player_activity::can_resume_with requires the same `index` (iexamine's -1 vs.
    // iuse's DIG bonus) to resume; a different route recomputes a fresh duration instead.
    expect(startClearRubble(game, at, tool)).toBe(true);
    expect(game.activities.current?.spec.duration).toBe(15);
  });
  it('unfinished clearing survives save/load and resumes on the same tile without paying tool energy twice', async () => {
    const mk = () => {
      const game = new Game(data, 7, stubInput());
      installChunkTracking(game);
      game.map.generator = new TestGenerator();
      installWeather(game);
      registerCoreSaveables(game);
      installNature(game, null);
      game.player.inv.wear(createItem(data, 'backpack'), null);
      return game;
    };
    const A = mk();
    place(A, 12, 12);
    const auger = createItem(data, 'auger');
    auger.charges = 999;
    A.player.inv.giveNew(auger);
    A.map.setFurn(at.x, at.y, at.z, 'f_rubble_rock');
    expect(startClearRubble(A, at, auger)).toBe(true);
    expect(auger.ammoRemaining()).toBe(979);
    const full = A.activities.current!.spec.duration;
    for (let i = 0; i < 2; i++) A.tick(1 / 30);
    const partial = A.activities.current!.elapsed;
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(full);

    const file = serializeGame(A, { slot: 'rubble', name: A.player.name, gen: 'test' });
    expect(file.sections.rubble).toBeTruthy();
    const loaded = await decodeSave((await encodeSave(file)).stored);
    const B = mk();
    const r = applySave(B, loaded);
    expect(r.warnings).toEqual([]);
    // The generic activity (progress bar) doesn't survive a reload; the rubble-specific
    // pending-clear record does, which is what lets the tile resume correctly below.
    expect(B.activities.current).toBeNull();
    expect(B.map.furnAt(at.x, at.y, at.z).id).toBe('f_rubble_rock');
    const augerB = B.player.inv.carried().find((it) => it.typeId === 'auger')!;
    expect(augerB.ammoRemaining()).toBe(979);

    expect(startClearRubble(B, at, augerB)).toBe(true);
    expect(augerB.ammoRemaining()).toBe(979);
    const remaining = B.activities.current!.spec.duration;
    expect(remaining).toBeLessThan(full);
    expect(remaining).toBeCloseTo(full - partial, 5);

    for (let i = 0; i < 30 * 10; i++) B.tick(1 / 30);
    expect(B.map.furnAt(at.x, at.y, at.z).id).toBe('f_null');
    const items = B.map.itemsAt(at.x, at.y, at.z) as Item[];
    const total = (id: string) => items.filter((it) => it.typeId === id).reduce((n, it) => n + it.count(), 0);
    expect(total('rock')).toBeGreaterThanOrEqual(5);
    expect(total('rock')).toBeLessThanOrEqual(10);
  });
  it('a nearby awake ally speeds up tool-based clearing; one that leaves mid-clear does not change the run already under way', () => {
    const withAlly = setup('auger');
    const ally = new Npc(data, 1);
    ally.faction = FACTION_FOLLOWERS;
    ally.x = 12; ally.y = 11; ally.z = 0;
    (withAlly.game as unknown as { npcs: { npcs: Npc[] } }).npcs = { npcs: [ally] };
    const auger1 = withAlly.game.player.inv.carried().find((it) => it.typeId === 'auger')!;
    auger1.charges = 999;
    expect(startClearRubble(withAlly.game, at, auger1)).toBe(true);
    const withHelperDuration = withAlly.game.activities.current!.spec.duration;

    const withoutAlly = setup('auger');
    const auger2 = withoutAlly.game.player.inv.carried().find((it) => it.typeId === 'auger')!;
    auger2.charges = 999;
    expect(startClearRubble(withoutAlly.game, at, auger2)).toBe(true);
    const withoutHelperDuration = withoutAlly.game.activities.current!.spec.duration;

    // BN iuse.cpp: moves = moves * (10 - helpers.size()) / 10 — one helper is a 10% discount.
    expect(withHelperDuration).toBeLessThan(withoutHelperDuration);
    expect(withHelperDuration).toBeCloseTo(withoutHelperDuration * 0.9, 5);

    // The ally leaves mid-task (BN's assistant count is fixed at activation/resume, never
    // live-recalculated while an activity runs): the already-running clear is unaffected.
    for (let i = 0; i < 2; i++) withAlly.game.tick(1 / 30);
    const midway = withAlly.game.activities.current!.elapsed;
    expect(midway).toBeGreaterThan(0);
    expect(midway).toBeLessThan(withHelperDuration);
    ally.x = 999;
    expect(withAlly.game.activities.current!.spec.duration).toBe(withHelperDuration);
    for (let i = 0; i < 2; i++) withAlly.game.tick(1 / 30);
    expect(withAlly.game.activities.current!.spec.duration).toBe(withHelperDuration);
  });
  it('a sleeping or distant ally does not count as a helper', () => {
    const asleepRun = setup('auger');
    const asleep = new Npc(data, 2);
    asleep.faction = FACTION_FOLLOWERS;
    asleep.x = 12; asleep.y = 11; asleep.z = 0;
    asleep.fallAsleep();
    (asleepRun.game as unknown as { npcs: { npcs: Npc[] } }).npcs = { npcs: [asleep] };
    const augerA = asleepRun.game.player.inv.carried().find((it) => it.typeId === 'auger')!;
    augerA.charges = 999;
    expect(startClearRubble(asleepRun.game, at, augerA)).toBe(true);
    const asleepDuration = asleepRun.game.activities.current!.spec.duration;

    const farRun = setup('auger');
    const far = new Npc(data, 3);
    far.faction = FACTION_FOLLOWERS;
    far.x = 999; far.y = 999; far.z = 0;
    (farRun.game as unknown as { npcs: { npcs: Npc[] } }).npcs = { npcs: [far] };
    const augerB = farRun.game.player.inv.carried().find((it) => it.typeId === 'auger')!;
    augerB.charges = 999;
    expect(startClearRubble(farRun.game, at, augerB)).toBe(true);
    const farDuration = farRun.game.activities.current!.spec.duration;

    const soloRun = setup('auger');
    const augerC = soloRun.game.player.inv.carried().find((it) => it.typeId === 'auger')!;
    augerC.charges = 999;
    expect(startClearRubble(soloRun.game, at, augerC)).toBe(true);
    const soloDuration = soloRun.game.activities.current!.spec.duration;

    expect(asleepDuration).toBe(soloDuration);
    expect(farDuration).toBe(soloDuration);
  });
});
