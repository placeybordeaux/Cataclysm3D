import type { Game } from './game/game';
import type { Renderer } from './render/renderer';
import type { DebugApi } from './debug';
import type { Item } from './game/item';
import type { ActionResult } from './game/inventory';
import { createItem } from './game/item';
import { qualityUsages } from './game/inventory';
import { installRubble, isRubble, startClearRubble } from './game/rubble';
import { trapAt } from './game/traps';
import type { MonsterSystem } from './game/monai';
import type { NpcSystem } from './game/npcai';
import { interactionProviders, type Interaction } from './game/interact';
import { targetTile, frontTile } from './game/targeting';
import { hasFlag, isDiggable } from './world/registry';
import { DAYS_PER_SEASON, SECONDS_PER_DAY } from './core/time';
import { registerSaveable } from './save/registry';
import { chunkTracker } from './save/tracking';
import { refreshWeather } from './game/weather';
import { Actualizer } from './game/actualize';
import { SEASONS, seasonAt, sunTimes, type Season } from './game/sun';
import { harvestKind, startHarvest, startForage } from './game/harvest';
import {
  clearOvergrown, fertilizePlant, fertilizers, furnStage, growPlant, harvestPlantNow, isSeed, plantStatus,
  plantableFor, seedAt, seedEntries, startPlanting,
} from './game/farming';
import {
  fillContainer, fillableContainers, fishingSpot, liquidSourceId, startFishing, swimState, swimUi, updateSwimming,
} from './game/water';
import {
  canTill, isTree, isTrunk, startChopLogs, startChopTree, startDig, startLumber, startTill, findLog, treeNear, trunkNear,
} from './game/woodcut';
import { openMenu, c, confirm } from './ui/framework';

// Seasons, foraging, farming, water, fishing, swimming and wood/earth work wired into the
// game: `e` interactions (interactionProviders), tool-quality activations (`a` on an axe,
// shovel or fishing rod), the lazy per-chunk world upkeep (actualize.ts), save state, the
// swimming camera and window.cdda helpers. Called from main.ts after the world systems.

export interface NatureSystem {
  actualizer: Actualizer;
}

const natures = new WeakMap<Game, NatureSystem>();
export function natureOf(game: Game): NatureSystem | undefined {
  return natures.get(game);
}

type Tile = { x: number; y: number; z: number };

function menu(title: string, entries: { label: string; run: () => void }[]): void {
  if (typeof document === 'undefined') return void entries[0]?.run();
  openMenu({ title, entries: entries.map((e) => ({ label: c('c_white', e.label), value: e.run })), onSelect: (run) => void run() });
}

const ok = (msg = ''): ActionResult => ({ ok: true, msg, moves: 0 });
const no = (msg = ''): ActionResult => ({ ok: false, msg, moves: 0 });

/** Pick a container for water from `x,y,z`, then fill it. */
function fillMenu(game: Game, liquidId: string): void {
  const list = fillableContainers(game, liquidId);
  if (!list.length) return game.message("You don't have a container that can hold that.", 'c_light_gray');
  if (list.length === 1) return void fillContainer(game, list[0][0], liquidId);
  menu('Fill which container?', list.map(([it, n]) => ({ label: `${it.name()}  (room for ${n})`, run: () => void fillContainer(game, it, liquidId) })));
}

function plantMenu(game: Game, t: Tile): void {
  const seeds = seedEntries(game);
  if (!seeds.length) return game.message('You have no seeds to plant.', 'c_light_gray');
  menu('Use which seed?', seeds.map((s) => ({ label: `${s.name} (${s.count})`, run: () => void startPlanting(game, t.x, t.y, t.z, s.id) })));
}

function fertilizeMenu(game: Game, t: Tile): void {
  const f = fertilizers(game);
  const seen = new Set<string>();
  const uniq = f.filter((it) => !seen.has(it.typeId) && seen.add(it.typeId));
  const run = (it: Item) => {
    game.activities.start({ name: 'fertilizing', duration: 10, onComplete: () => {
      const err = fertilizePlant(game, t.x, t.y, t.z, it);
      if (err) game.message(err, 'c_light_gray');
    } });
  };
  if (uniq.length === 1) return run(uniq[0]);
  menu('Fertilize with what?', uniq.map((it) => ({ label: it.name(), run: () => run(it) })));
}

function toolWith(game: Game, q: string, level = 1): Item | null {
  return game.player.inv.findByQuality(q, level)[0] ?? null;
}

/**
 * Runs a tool-quality action (chop, dig, till, fish, clear rubble…) and, only if it actually
 * starts an activity, arranges for that activity's own completion to fire the item's
 * successful-use gesture — never when it's merely offered, cancelled, or refused. `run` may
 * open its own confirm dialog first (clearRubbleAction on an occupied tile): the wrap stays
 * live across that await, since `game.activities.start` isn't called until `run` resolves.
 * Axe/shovel/rod tools don't change type from these actions, so the live Item is a safe
 * stand-in for a pre-transform snapshot.
 */
function withDeferredGesture(game: Game, item: Item, run: () => void | Promise<void>): void | Promise<void> {
  const realStart = game.activities.start.bind(game.activities);
  game.activities.start = (spec) => {
    game.activities.start = realStart;
    return realStart({ ...spec, onComplete: () => { spec.onComplete(); game.player.inv.presentDeferredUse(item); } });
  };
  let result: void | Promise<void>;
  try {
    result = run();
  } catch (e) {
    game.activities.start = realStart;
    throw e;
  }
  if (result instanceof Promise) return result.finally(() => { game.activities.start = realStart; });
  game.activities.start = realStart;
  return result;
}

async function clearRubbleAction(game: Game, at: Tile, tool?: Item): Promise<void> {
  const actors = game as unknown as { monsters?: MonsterSystem; npcs?: NpcSystem };
  const occupied = game.vehicles?.at(at.x, at.y, at.z) || trapAt(game, at.x, at.y, at.z) || actors.monsters?.monsterAt(at.x, at.y, at.z) || actors.npcs?.npcAt(at.x, at.y, at.z);
  if (occupied && typeof document !== 'undefined' && !(await confirm(`Clear up that ${game.map.furnAt(at.x, at.y, at.z).name}?`))) return;
  startClearRubble(game, at, tool);
}

/** `e` on nature tiles. */
function natureInteractions(game: Game, x: number, y: number, z: number): Interaction[] {
  const out: Interaction[] = [];
  const add = (id: string, label: string, run: () => void) => out.push({ id, label, run });
  const map = game.map;
  const t = map.terAt(x, y, z), f = map.furnAt(x, y, z);
  const at = { x, y, z };

  if (f.examine_action === 'rubble' && isRubble(game, at)) add('clear_rubble', `Clear the ${f.name}`, () => void clearRubbleAction(game, at));

  // --- crops (grow lazily first: the seed's age decides the stage)
  if (hasFlag(f, 'PLANT') && seedAt(game, x, y, z)) {
    growPlant(game, x, y, z);
    const fs = map.furnAt(x, y, z);
    const stage = furnStage(fs);
    const seed = seedAt(game, x, y, z)!;
    const pname = String((seed.def.seed_data as { plant_name?: string } | undefined)?.plant_name ?? seed.def.plant_name ?? seed.def.name);
    if (stage === 'GROWTH_HARVEST')
      add('harvest_plant', `Harvest the ${pname}`, () =>
        void game.activities.start({ name: `harvesting the ${pname}`, duration: 60, onComplete: () => void harvestPlantNow(game, x, y, z) }));
    else if (stage === 'GROWTH_OVERGROWN') add('clear_overgrown', `Clear the ${fs.name}`, () => clearOvergrown(game, x, y, z));
    else {
      if (fertilizers(game).length && !seed.vars.fertilized) add('fertilize', `Fertilize the ${pname}`, () => fertilizeMenu(game, at));
      add('examine_plant', `Examine the ${fs.name}`, () => game.message(plantStatus(game, x, y, z) ?? fs.name, 'c_light_gray'));
    }
    return out;
  }

  // --- planting
  if ((hasFlag(t, 'PLANTABLE') && f.id === 'f_null') || (hasFlag(f, 'PLANTABLE') && !hasFlag(f, 'PLANT'))) {
    const seeds = seedEntries(game).filter((s) => plantableFor(game, x, y, z, game.data.items[s.id]));
    if (seeds.length) add('plant', 'Plant seeds', () => plantMenu(game, at));
    else add('dirtmound', `Examine the ${f.id !== 'f_null' ? f.name : t.name}`, () => game.message('You have no seeds to plant.', 'c_light_gray'));
  }

  // --- seasonal harvests / foraging
  const hk = harvestKind(game, x, y, z);
  if (hk) {
    const name = hk.def.name;
    if (hk.kind === 'harvest') add('harvest', `Harvest the ${name}`, () => void startHarvest(game, x, y, z));
    else if (hk.kind === 'forage') add('forage', `Forage through the ${name}`, () => void startForage(game, x, y, z));
    else add('harvest_none', `Examine the ${name}`, () => game.message('Nothing can be harvested from this plant in current season.', 'c_light_gray'));
  }

  // --- water: fill containers (drinking is interact.ts's water_source case)
  const liquid = liquidSourceId(game, x, y, z);
  if (liquid && game.data.items[liquid]) {
    const name = f.id !== 'f_null' && f.liquid_source ? f.name : t.name;
    add('fill', `Fill a container from the ${name}`, () => fillMenu(game, liquid));
    if (hasFlag(t, 'FISHABLE')) {
      const rod = toolWith(game, 'FISHING_ROD');
      if (rod) add('fish', `Fish with your ${rod.name()}`, () => void startFishing(game, rod));
    }
  }

  // --- trees & trunks with an axe
  const axe = toolWith(game, 'AXE');
  if (axe && isTree(game, x, y, z)) add('chop_tree', `Chop down the ${t.name}`, () => void startChopTree(game, axe, at));
  if (axe && isTrunk(game, x, y, z)) add('chop_logs', `Chop the ${t.name} into logs`, () => void startChopLogs(game, axe, at));
  return out;
}

/** Everything an axe/shovel/rod can do right here; one runs directly, several get a menu. */
function toolActions(game: Game, it: Item): ActionResult {
  const target = targetTile(game) ?? (frontTile(game) as Tile | null);
  const acts: { label: string; run: () => void }[] = [];
  const q = (id: string) => it.qualityLevel(id);
  if (q('AXE') >= 1) {
    const tree = treeNear(game, target);
    if (tree) acts.push({ label: `Chop down the ${game.map.terAt(tree.x, tree.y, tree.z).name}`, run: () => void withDeferredGesture(game, it, () => { startChopTree(game, it, tree); }) });
    const trunk = trunkNear(game, target);
    if (trunk) acts.push({ label: `Chop the ${game.map.terAt(trunk.x, trunk.y, trunk.z).name} into logs`, run: () => void withDeferredGesture(game, it, () => { startChopLogs(game, it, trunk); }) });
  }
  if ((q('AXE') >= 2 || q('SAW_W') >= 2) && findLog(game)) acts.push({ label: 'Cut a log into planks', run: () => void withDeferredGesture(game, it, () => { startLumber(game); }) });
  if (q('DIG') >= 1 && target) {
    if (isRubble(game, target)) acts.push({ label: `Clear the ${game.map.furnAt(target.x, target.y, target.z).name}`, run: () => void withDeferredGesture(game, it, () => clearRubbleAction(game, target, it)) });
    if (canTill(game, target.x, target.y, target.z)) acts.push({ label: 'Till the soil (dirt mound for planting)', run: () => void withDeferredGesture(game, it, () => { startTill(game, target); }) });
    if (isDiggable(game.map.terAt(target.x, target.y, target.z)) || game.map.terAt(target.x, target.y, target.z).id.startsWith('t_pit'))
      acts.push({ label: 'Dig a pit', run: () => void withDeferredGesture(game, it, () => { startDig(game, target); }) });
  }
  if (q('FISHING_ROD') >= 1 && fishingSpot(game)) acts.push({ label: 'Cast your line', run: () => void withDeferredGesture(game, it, () => { startFishing(game, it); }) });
  if (!acts.length) {
    const msg = q('FISHING_ROD') >= 1 ? "You can't fish there!" : q('AXE') >= 1 ? 'There is no tree to chop down nearby.' : q('DIG') >= 1 ? "You can't dig there." : `You can't do anything interesting with your ${it.name()}.`;
    game.message(msg, 'c_light_gray');
    return no();
  }
  if (acts.length === 1) acts[0].run();
  else menu(`Use your ${it.name()}`, acts);
  // Accepted so far, not finished: the gesture (if any) fires from whichever activity
  // actually completes, via withDeferredGesture above.
  return { ...ok(), deferred: true };
}

/** Jump the calendar forward to day `dayOfSeason` of the next `season` (keeps the hour). */
export function jumpToSeason(game: Game, season: Season, dayOfSeason = 10): void {
  const c = game.clock;
  const idx = SEASONS.indexOf(season);
  if (idx < 0) throw new Error(`unknown season ${season}`);
  const year = DAYS_PER_SEASON * 4;
  const hour = c.seconds % SECONDS_PER_DAY;
  let day = Math.floor(c.day / year) * year + idx * DAYS_PER_SEASON + dayOfSeason - 1;
  if (day < c.day) day += year;
  c.seconds = day * SECONDS_PER_DAY + hour;
}

export function installNature(game: Game, renderer: Renderer | null, api?: DebugApi): NatureSystem {
  const actualizer = new Actualizer(game);
  const sys: NatureSystem = { actualizer };
  natures.set(game, sys);

  for (const [quality, level, type] of [
    ['AXE', 1, 'CHOP_TREE'], ['AXE', 1, 'CHOP_LOGS'], ['AXE', 2, 'LUMBER'], ['SAW_W', 2, 'LUMBER'],
    ['DIG', 1, 'CLEAR_RUBBLE'], ['DIG', 1, 'MAKEMOUND'], ['DIG', 1, 'DIG'], ['FISHING_ROD', 1, 'FISH_ROD'],
  ] as const) {
    if (!qualityUsages.some((u) => u.quality === quality && u.type === type)) qualityUsages.push({ quality, level, type });
    game.player.inv.useHandlers.set(type, (it) => toolActions(game, it));
  }
  // module-level list shared by every Game (tests build several): register once
  if (!interactionProviders.includes(natureInteractions)) interactionProviders.push(natureInteractions);

  game.systems.push({
    name: 'nature',
    update(g, realDt, gameDt) {
      actualizer.update(gameDt);
      updateSwimming(g, realDt);
    },
  });

  // An evicted chunk regenerates in its day-0 state, so its rot/regrowth clock restarts too.
  game.map.onChunkEvicted.push((c) => actualizer.stamps.delete(`${c.cx},${c.cy},${c.z}`));

  const tracker = chunkTracker(game);
  if (tracker) actualizer.tracking = tracker;
  registerSaveable(game, 'nature', {
    save: () => ({
      stamps: actualizer.toJSON((k) => {
        if (!tracker) return true;
        const [cx, cy, z] = k.split(',').map(Number);
        return game.map.hasChunk(cx, cy, z) && tracker.isDirty(game.map.chunk(cx, cy, z)!);
      }),
    }),
    load: (d: { stamps?: Record<string, [number, number]> }) => actualizer.load(d.stamps ?? {}),
    missing: () => actualizer.load({}),
  });
  installRubble(game);

  if (renderer) {
    // swimming: head just above the surface; sunk: just below it
    renderer.beforeRender.push(() => {
      const st = swimState(game);
      renderer.rig.eyeOffset = st.underwater ? -1.75 : st.swimming ? -1.35 : 0;
    });
    swimUi.confirmDive = (warn, answer) => {
      if (typeof document === 'undefined') return answer(true);
      const title = warn.length ? 'Diving will destroy the following items.  Proceed?' : 'Dive into the water?';
      let answered = false;
      openMenu({
        title,
        entries: [
          ...warn.map((w) => ({ label: c('c_light_red', w), value: 'x', disabled: true })),
          { label: c('c_white', 'Yes'), value: 'y', hotkey: 'y' },
          { label: c('c_white', 'No'), value: 'n', hotkey: 'n' },
        ],
        onSelect: (v) => {
          answered = true;
          answer(v === 'y');
        },
        // Esc is a "no" too (and frees the question for the next attempt).
        onClose: () => !answered && answer(false),
      });
    };
  }

  if (api) installNatureDebug(game, api, sys);
  return sys;
}

// ------------------------------------------------------------------ window.cdda helpers

function installNatureDebug(game: Game, api: DebugApi, sys: NatureSystem): void {
  const p = () => game.player;
  const run = (maxReal = 900) => {
    for (let i = 0; i < maxReal * 30 && game.activities.current; i++) game.tick(1 / 30);
  };
  const give = (id: string) => {
    const it = createItem(game.data, id);
    // debug convenience: a survivor with no carrying space gets a backpack
    if (!p().inv.canCarry(it) && !p().inv.worn.some((w) => w.typeId === 'backpack') && game.data.items.backpack) p().inv.wear(createItem(game.data, 'backpack'), null);
    p().inv.giveNew(it);
    return it;
  };
  const nearest = (pred: (x: number, y: number, z: number) => boolean, r = 60) => {
    let best: Tile | null = null, bd = Infinity;
    const z = p().z;
    for (let y = p().tileY - r; y <= p().tileY + r; y++)
      for (let x = p().tileX - r; x <= p().tileX + r; x++) {
        if (!game.map.hasChunk(Math.floor(x / 24), Math.floor(y / 24), z) || !pred(x, y, z)) continue;
        const d = (x - p().tileX) ** 2 + (y - p().tileY) ** 2;
        if (d < bd) (bd = d), (best = { x, y, z });
      }
    return best;
  };
  /** Stand on a walkable dry tile next to (x, y), facing it. */
  const standBeside = (t: Tile) => {
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      const x = t.x + dx, y = t.y + dy;
      const tt = game.map.terAt(x, y, t.z);
      if (!game.map.passable(x, y, t.z) || hasFlag(tt, 'LIQUID') || hasFlag(tt, 'TREE')) continue;
      p().x = x + 0.5;
      p().y = y + 0.5;
      p().yaw = Math.atan2(t.x - x, -(t.y - y));
      p().pitch = -0.35;
      return true;
    }
    return false;
  };
  Object.assign(api, {
    /** Jump the clock forward to a season (keeps the hour); chunks re-season on the next frame. */
    setSeason: (s: Season, day = 10) => {
      jumpToSeason(game, s, day);
      refreshWeather(game);
      sys.actualizer.soon();
      return game.clock.format();
    },
    season: () => seasonAt(game.clock.seconds),
    sunTimes: (day = game.clock.day) => sunTimes(day),
    /** Actualize nearby chunks now (regrowth, crop growth, rot). */
    actualize: () => sys.actualizer.sweep(),
    /** Till + plant `seedId` on the tile at (dx, dy) from the player (default: in front). */
    plant: (seedId = 'seed_tomato', dx?: number, dy?: number) => {
      const ft = frontTile(game) as Tile | null;
      const t = dx === undefined ? ft! : { x: p().tileX + dx, y: p().tileY + (dy ?? 0), z: p().z };
      if (!isSeed(game.data.items[seedId])) throw new Error(`${seedId} is not a seed`);
      if (!p().inv.hasAmount(seedId, 1)) give(seedId);
      if (!hasFlag(game.map.terAt(t.x, t.y, t.z), 'PLANTABLE')) {
        if (!canTill(game, t.x, t.y, t.z)) return { ...t, err: `can't till ${game.map.terAt(t.x, t.y, t.z).id}` };
        game.map.setTer(t.x, t.y, t.z, 't_dirtmound');
      }
      const err = startPlanting(game, t.x, t.y, t.z, seedId, { instant: true });
      return { ...t, err, furn: game.map.furnAt(t.x, t.y, t.z).id };
    },
    /** Let `days` pass (clock jump) and actualize: crops grow, bushes regrow, food rots. */
    growPlants: (days: number) => {
      game.clock.seconds += days * SECONDS_PER_DAY;
      refreshWeather(game);
      sys.actualizer.sweep();
      const out: { x: number; y: number; furn: string; status: string | null }[] = [];
      for (let y = p().tileY - 20; y <= p().tileY + 20; y++)
        for (let x = p().tileX - 20; x <= p().tileX + 20; x++)
          if (hasFlag(game.map.furnAt(x, y, p().z), 'PLANT')) out.push({ x, y, furn: game.map.furnAt(x, y, p().z).id, status: plantStatus(game, x, y, p().z) });
      return out;
    },
    /** Walk up to the nearest underbrush and forage it (instant). Returns item names found. */
    forage: () => {
      const t = nearest((x, y, z) => harvestKind(game, x, y, z)?.kind === 'forage');
      if (!t) return null;
      standBeside(t);
      const before = new Set(game.map.itemsAt(p().tileX, p().tileY, p().z));
      startForage(game, t.x, t.y, t.z, { instant: true });
      return (game.map.itemsAt(p().tileX, p().tileY, p().z) as Item[]).filter((i) => !before.has(i)).map((i) => i.name());
    },
    /** Nearest tile with a harvest this season (regex on terrain/furniture id optional). */
    findHarvest: (re = '.') => {
      const rx = new RegExp(re);
      return nearest((x, y, z) => harvestKind(game, x, y, z)?.kind === 'harvest' && (rx.test(game.map.terAt(x, y, z).id) || rx.test(game.map.furnAt(x, y, z).id)));
    },
    /** Nearest n×n block of tillable ground (top-left corner). */
    findOpenGround: (n = 5, r = 60) =>
      nearest((x, y, z) => {
        for (let dy = 0; dy < n; dy++) for (let dx = 0; dx < n; dx++) if (!canTill(game, x + dx, y + dy, z) || game.map.itemsAt(x + dx, y + dy, z).length) return false;
        return true;
      }, r),
    /** Stand beside (x, y) facing it. */
    standBeside: (x: number, y: number) => standBeside({ x, y, z: p().z }),
    harvest: (x: number, y: number) => startHarvest(game, x, y, p().z, { instant: true }),
    /** Walk to the nearest fishable water and fish for `seconds` of game time (a rod is provided). */
    fish: (seconds = 3600, opts: { spot?: boolean; run?: boolean } = {}) => {
      if (opts.spot !== false && !fishingSpot(game)) {
        const w = nearest((x, y, z) => hasFlag(game.map.terAt(x, y, z), 'FISHABLE') && !hasFlag(game.map.terAt(x, y, z), 'DEEP_WATER'))
          ?? nearest((x, y, z) => hasFlag(game.map.terAt(x, y, z), 'FISHABLE'));
        if (!w || !standBeside(w)) return { error: 'no water nearby' };
      }
      const rod = toolWith(game, 'FISHING_ROD') ?? give('fishing_rod_professional');
      const corpses = () => (game.map.itemsAt(p().tileX, p().tileY, p().z) as Item[]).filter((i) => i.vars.corpse);
      const before = corpses().length;
      if (!startFishing(game, rod, { duration: seconds })) return { error: 'cannot fish' };
      if (opts.run === false) return { started: true };
      run();
      return { caught: corpses().slice(before).map((i) => String(i.vars.corpse)), time: game.clock.format() };
    },
    /** Chop the tree in front / nearest (gives an axe). instant=false plays the activity. */
    chopTree: (instant = true) => {
      const axe = toolWith(game, 'AXE') ?? give('ax');
      let t = treeNear(game, targetTile(game));
      if (!t) {
        // a lone tree with open ground south (to stand on) and north (for it to fall on)
        const open = (x: number, y: number, z: number) => hasFlag(game.map.terAt(x, y, z), 'FLAT') && game.map.passable(x, y, z) && game.map.furnAt(x, y, z).id === 'f_null' && !game.map.hasFloor(x, y, z + 1);
        const n = nearest((x, y, z) => isTree(game, x, y, z) && open(x, y + 1, z) && open(x, y + 2, z) && [1, 2, 3, 4].every((d) => open(x, y - d, z)));
        if (!n) return null;
        p().x = n.x + 0.5;
        p().y = n.y + 1.5;
        p().yaw = 0;
        p().pitch = 0;
        t = n;
      }
      startChopTree(game, axe, t, { instant });
      return t;
    },
    swim: () => ({ ...swimState(game) }),
    /** Jump into the water at (x, y) without the "Dive into the water?" prompt. */
    dive: (x: number, y: number) => {
      swimState(game).divingOk = true;
      p().x = x + 0.5;
      p().y = y + 0.5;
    },
    natureInteractions: (x: number, y: number, z = p().z) => natureInteractions(game, x, y, z).map((i) => i.label),
    fillable: (liquid = 'water') => fillableContainers(game, liquid).map(([it, n]) => [it.name(), n]),
    /** Place RUBBLE furniture at (dx, dy) from the player (default: in front); setup only. */
    makeRubble: (dx = 1, dy = 0, id = 'f_rubble_rock') => {
      const t = { x: p().tileX + dx, y: p().tileY + dy, z: p().z };
      game.map.setFurn(t.x, t.y, t.z, id);
      return t;
    },
  });
}
