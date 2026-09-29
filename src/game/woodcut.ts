import type { Game } from './game';
import { hasFlag } from '../world/registry';
import { warnOnce } from '../data/warn';
import { bresenham } from './vision';
import { normalRoll } from './combat';
import { createItem, type Item } from './item';
import { consumeItem, L, spawnOnGround } from './moves';
import { emitSound } from './sound';
import { getConstruction, siteOk, startConstruction } from './construction';

// Wood and earth work with tools, after CDDA iuse.cpp (chop_tree, chop_logs, lumber,
// makemound, dig) and activity_actor.cpp (chop_tree / chop_logs / chop_planks / churn):
//   AXE 1   CHOP_TREE  a TREE → the tree falls away from you as t_trunk tiles, t_stump left
//   AXE 1   CHOP_LOGS  t_trunk → 2-3 logs (+ long sticks); t_stump → 0-2 logs + splinters
//   AXE 2 / SAW_W 2  LUMBER  a log → 2x4 planks (fabrication roll) + splinters
//   DIG 1   MAKEMOUND  PLOWABLE ground → t_dirtmound (for planting)
//   DIG 2   DIG        dig a (shallow) pit via the construction system

/** chop_moves: (60 − str) minutes halved per AXE level above 1, in game seconds. */
export function chopSeconds(str: number, axeQuality: number, powered = false, dex = 8): number {
  const attr = powered ? dex : str;
  return Math.round(((60 - attr) * 60) / 2 ** (axeQuality - 1));
}

type Tile = { x: number; y: number; z: number };

function adjacent(game: Game, pred: (x: number, y: number, z: number) => boolean, prefer?: Tile | null): Tile | null {
  const p = game.player;
  if (prefer && Math.max(Math.abs(prefer.x - p.tileX), Math.abs(prefer.y - p.tileY)) <= 1 && pred(prefer.x, prefer.y, prefer.z)) return prefer;
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      if (pred(p.tileX + dx, p.tileY + dy, p.z)) return { x: p.tileX + dx, y: p.tileY + dy, z: p.z };
    }
  return null;
}

export const isTree = (game: Game, x: number, y: number, z: number) => hasFlag(game.map.terAt(x, y, z), 'TREE');
export const isTrunk = (game: Game, x: number, y: number, z: number) => ['t_trunk', 't_stump'].includes(game.map.terAt(x, y, z).id);

export function treeNear(game: Game, prefer?: Tile | null): Tile | null {
  return adjacent(game, (x, y, z) => isTree(game, x, y, z), prefer);
}
export function trunkNear(game: Game, prefer?: Tile | null): Tile | null {
  return adjacent(game, (x, y, z) => isTrunk(game, x, y, z), prefer);
}

function drop(game: Game, x: number, y: number, z: number, id: string, n: number): Item[] {
  const out: Item[] = [];
  if (!game.data.items[id]) {
    warnOnce('item', id);
    return out;
  }
  for (let i = 0; i < n; i++) {
    const it = createItem(game.data, id);
    spawnOnGround(game.map, x, y, z, it);
    out.push(it);
  }
  return out;
}

/**
 * map::cut_down_tree: the trunk falls 3 tiles (±1) away from you; open ground along the line
 * becomes t_trunk until something solid stops it (its bash drops land there instead). The
 * canopy above goes too. Leaves a stump.
 */
export function cutDownTree(game: Game, x: number, y: number, z: number): void {
  const map = game.map;
  const p = game.player;
  const rng = p.rng;
  let dx = Math.sign(x - p.tileX), dy = Math.sign(y - p.tileY);
  if (!dx && !dy) dx = 1;
  const tx = x + 3 * dx + rng.int(-1, 1), ty = y + 3 * dy + rng.int(-1, 1);
  const line = bresenham(x, y, tx, ty).slice(1);
  let shattered = false;
  for (const [lx, ly] of line) {
    if (lx === p.tileX && ly === p.tileY) break;
    const t = map.terAt(lx, ly, z), f = map.furnAt(lx, ly, z);
    if (!shattered && hasFlag(t, 'FLAT') && f.id === 'f_null' && map.passable(lx, ly, z)) {
      map.setTer(lx, ly, z, 't_trunk');
      continue;
    }
    shattered = true;
    drop(game, lx, ly, z, 'splinter', rng.int(5, 15));
  }
  map.setTer(x, y, z, 't_stump');
  const above = map.terAt(x, y, z + 1);
  if (above.id === 't_treetop' && map.terrain.has('t_open_air')) map.setTer(x, y, z + 1, 't_open_air');
  game.events.emit('mapChanged', { x, y, z });
  emitSound(game, { x, y, z }, 40, 'TIMBER!', { category: 'destructive_activity', source: p });
}

export function startChopTree(game: Game, tool: Item, at?: Tile | null, opts: { instant?: boolean } = {}): boolean {
  const t = treeNear(game, at);
  if (!t) {
    game.message('There is no tree to chop down nearby.', 'c_light_gray');
    return false;
  }
  const p = game.player;
  const done = () => {
    if (!isTree(game, t.x, t.y, t.z)) return;
    cutDownTree(game, t.x, t.y, t.z);
    game.message('You finish chopping down a tree.', 'c_green');
    p.practice('fabrication', 1);
  };
  if (opts.instant) return done(), true;
  return game.activities.start({
    name: `chopping down the ${game.map.terAt(t.x, t.y, t.z).name}`,
    duration: chopSeconds(p.str, tool.qualityLevel('AXE'), tool.hasFlag('POWERED'), p.dex),
    onProgress: (_dt, frac) => {
      // a thwack every so often (chop_single_do_turn makes noise each turn)
      if (p.rng.oneIn(40)) emitSound(game, t, 15, 'CHK!', { category: 'destructive_activity', source: p });
      void frac;
    },
    onComplete: done,
  });
}

/** chop_logs_activity_actor::finish. Returns the items dropped. */
export function chopLogsAt(game: Game, x: number, y: number, z: number): Item[] {
  const map = game.map, rng = game.player.rng;
  const id = map.terAt(x, y, z).id;
  const out: Item[] = [];
  if (id === 't_trunk') {
    out.push(...drop(game, x, y, z, 'log', rng.int(2, 3)), ...drop(game, x, y, z, 'stick_long', rng.int(0, 3)));
  } else if (id === 't_stump') {
    out.push(...drop(game, x, y, z, 'log', rng.int(0, 2)), ...drop(game, x, y, z, 'splinter', rng.int(5, 15)));
  } else return out;
  map.setTer(x, y, z, 't_dirt');
  game.events.emit('mapChanged', { x, y, z });
  game.message('You finish chopping wood.', 'c_green');
  return out;
}

export function startChopLogs(game: Game, tool: Item, at?: Tile | null, opts: { instant?: boolean } = {}): boolean {
  const t = trunkNear(game, at);
  if (!t) {
    game.message('There is no tree trunk to chop nearby.', 'c_light_gray');
    return false;
  }
  const p = game.player;
  const done = () => void chopLogsAt(game, t.x, t.y, t.z);
  if (opts.instant) return done(), true;
  return game.activities.start({ name: 'chopping wood', duration: chopSeconds(p.str, tool.qualityLevel('AXE'), tool.hasFlag('POWERED'), p.dex), onComplete: done });
}

/** A log at your feet or in your inventory (iuse::lumber). */
export function findLog(game: Game): { item: Item; onMap: boolean } | null {
  const p = game.player;
  const ground = (game.map.itemsAt(p.tileX, p.tileY, p.z) as Item[]).find((i) => i.typeId === 'log');
  if (ground) return { item: ground, onMap: true };
  const carried = p.inv.allItems().find((i) => i.typeId === 'log');
  return carried ? { item: carried, onMap: false } : null;
}

/** chop_planks_activity_actor::finish: 2x4s by a fabrication roll, the waste as splinters. */
export function cutPlanks(game: Game): Item[] {
  const p = game.player;
  const max = 10;
  const planks = Math.min(max, Math.max(0, Math.round(normalRoll(p.rng, 2 + p.getSkill('fabrication'), 1))));
  const wasted = max - planks;
  const scraps = p.rng.int(wasted, wasted * 3);
  const out = [...drop(game, p.tileX, p.tileY, p.z, '2x4', planks), ...drop(game, p.tileX, p.tileY, p.z, 'splinter', scraps)];
  if (planks > 0) game.message(`You produce ${planks} plank${planks === 1 ? '' : 's'}.`, 'c_green');
  if (scraps > 0) game.message(`You produce ${scraps} splinter${scraps === 1 ? '' : 's'}.`, 'c_green');
  if (planks < max / 2) game.message('You waste a lot of the wood.', 'c_light_red');
  return out;
}

export function startLumber(game: Game, opts: { instant?: boolean } = {}): boolean {
  const log = findLog(game);
  if (!log) {
    game.message("You don't have any logs to cut up.", 'c_light_gray');
    return false;
  }
  const p = game.player;
  // the log is used up (the planks are made when the work is done)
  const at = log.onMap ? L.ground(game.map, p.tileX, p.tileY, p.z) : p.inv.locOf(log.item);
  if (at) consumeItem(log.item, at, log.item.countByCharges ? 1 : undefined);
  game.message('You cut the log into planks.', 'c_light_gray');
  const done = () => void cutPlanks(game);
  if (opts.instant) return done(), true;
  return game.activities.start({
    name: 'cutting the log into planks',
    duration: 20 * 60,
    onComplete: done,
    // CDDA consumed the log up front; give it back if you stop
    onCancel: () => spawnOnGround(game.map, p.tileX, p.tileY, p.z, log.item),
  });
}

/** iuse::makemound: churn PLOWABLE ground into a dirt mound (3 minutes). */
export function canTill(game: Game, x: number, y: number, z: number): boolean {
  const map = game.map;
  const t = map.terAt(x, y, z), f = map.furnAt(x, y, z);
  return hasFlag(t, 'PLOWABLE') && !hasFlag(f, 'PLANT') && f.id === 'f_null';
}

export function startTill(game: Game, at: Tile | null, opts: { instant?: boolean } = {}): boolean {
  const p = game.player;
  if (!at) return false;
  if (at.x === p.tileX && at.y === p.tileY) {
    game.message('You think about jumping on a shovel, but then change your mind.', 'c_light_gray');
    return false;
  }
  if (!canTill(game, at.x, at.y, at.z)) {
    game.message("You can't churn up this ground.", 'c_light_gray');
    return false;
  }
  game.message('You start churning up the earth here.', 'c_light_gray');
  const done = () => {
    game.map.setTer(at.x, at.y, at.z, 't_dirtmound');
    game.message('You finish churning up the earth here.', 'c_green');
  };
  if (opts.instant) return done(), true;
  return game.activities.start({ name: 'churning up the earth', duration: 180, onComplete: done });
}

/** iuse::dig: a pit where there's a shallow pit, else a shallow pit (construction.cpp). */
export function startDig(game: Game, at: Tile | null): boolean {
  if (!at) return false;
  for (const id of ['constr_pit', 'constr_pit_shallow']) {
    const con = getConstruction(game.data, id);
    if (!con || !siteOk(game, con, at.x, at.y, at.z)) continue;
    return startConstruction(game, con, at.x, at.y, at.z);
  }
  game.message("You can't dig a pit there.", 'c_light_gray');
  return false;
}
