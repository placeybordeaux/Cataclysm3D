import { Rng, hashSeed } from '../core/rng';
import { pickMonsterGroupResult } from '../data/index';
import { warnOnce } from '../data/warn';
import { CHUNK, MAX_Z } from '../world/coords';
import { SM_SIZE, type MonGroup } from '../world/overmap/mongroups';
import { registerSaveable } from '../save/registry';
import type { Game } from './game';
import type { MonsterSystem } from './monai';
import type { Spawner } from './spawner';
import { canStandAt } from './standing';
import { isOutside, playerCanSee } from './vision';

// Materialises the overmap monster groups that specials place (src/world/overmap/mongroups.ts,
// genVersion >= 3: an anthill's ant colony, a slime pit's goo, triffid and fungal growths) as the
// survivor nears them. Port of map::spawn_monsters_submap_group (BN src/map/map.cpp 7837-7953),
// driven the way BN drives it:
//  - a group sits on one submap; it spawns when its submap is inside the reality bubble (BN
//    MAPSIZE 11: within 5 submaps of the survivor's, every z level). BN spawns new submaps as
//    the map shifts (all of them on the bubble's edge) and the whole bubble every 2.5 minutes;
//    we scan the bubble once a second, which does both.
//  - spawn spots: the submap's tiles with nobody on them, passable with a floor, under the open
//    sky (is_outside) and out of the survivor's sight, except on the bubble's outermost ring, on
//    another z level, or on the first scan after a new game or a load (BN spawn_monsters(true)).
//  - the population is rolled into monsters with GetResultFromGroup, each costing
//    max(1, cost_multiplier * pack) (BN's loop is `for (m = 0; m < pop; m++)` while the roll
//    lowers pop, so a group yields fewer monsters than its population; kept), each monster
//    tries 10 random spots; then the group is cleared whether or not everyone found a spot. A
//    group with no spot at all is cleared too (these groups are never hordes).
// Spawned monsters are ordinary monsters from then on (saved, stashed when far). What is saved
// here is only which groups are spent: the groups themselves regenerate with the overmap.
//
// Not BN: the port's safe radius (no hostile spawns within SpawnerOptions.safeRadius) applies, as
// it does to every other spawn; a submap whose chunk (or the chunk above it, for is_outside)
// isn't generated yet waits instead of spawning.

/** BN g_half_mapsize: the reality bubble is 11x11 submaps around the survivor's. */
export const BUBBLE_SUBMAPS = 5;
/** Real seconds between scans of the bubble. */
const SCAN_INTERVAL = 1;
/** BN allow_on_terrain is about terrain only; the walker rule (BN passable && has_floor). */
const WALKER = { flags: [] as string[] };

/** Where groups come from: the Overmap (only regions generated so far). */
export interface MonGroupSource {
  monGroupsAt(sx: number, sy: number): readonly MonGroup[];
}

export class MonGroupSpawner {
  /** keys (MonGroup.key) of groups already materialised or cleared */
  readonly spent = new Set<string>();
  readonly stats = { groups: 0, monsters: 0, empty: 0 };
  /** next scan ignores the survivor's sight (new game, load) */
  private fresh = true;
  private t = SCAN_INTERVAL;

  constructor(readonly sys: MonsterSystem, readonly source: MonGroupSource, readonly spawner: Spawner) {}

  update(_game: Game, realDt: number): void {
    this.t += realDt;
    if (this.t < SCAN_INTERVAL) return;
    this.t = 0;
    if (this.spawner.holding) return;
    this.scan();
  }

  /** One pass over the bubble: materialise every unspent group whose submap is ready. */
  scan(): number {
    const p = this.sys.game.player;
    const psx = Math.floor(p.x / SM_SIZE), psy = Math.floor(p.y / SM_SIZE);
    let n = 0;
    for (let dy = -BUBBLE_SUBMAPS; dy <= BUBBLE_SUBMAPS; dy++)
      for (let dx = -BUBBLE_SUBMAPS; dx <= BUBBLE_SUBMAPS; dx++) {
        const groups = this.source.monGroupsAt(psx + dx, psy + dy);
        if (!groups.length) continue;
        const edge = Math.max(Math.abs(dx), Math.abs(dy)) === BUBBLE_SUBMAPS;
        for (const g of groups) {
          if (this.spent.has(g.key)) continue;
          const spawned = this.materialise(g, this.fresh || edge || g.z !== p.z);
          if (spawned !== null) n += spawned;
        }
      }
    this.fresh = false;
    return n;
  }

  /** The next scan spawns regardless of sight (BN spawn_monsters(true) after a load). */
  ignoreSightOnce(): void {
    this.fresh = true;
  }

  /**
   * BN spawn_monsters_submap_group for one group. Returns the monsters placed, or null when
   * its submap can't be judged yet (chunk not generated) and the group stays for later.
   */
  materialise(g: MonGroup, ignoreSight: boolean): number | null {
    const game = this.sys.game, map = game.map;
    const x0 = g.sx * SM_SIZE, y0 = g.sy * SM_SIZE;
    const cx = Math.floor(x0 / CHUNK), cy = Math.floor(y0 / CHUNK);
    if (!map.hasChunk(cx, cy, g.z) || (g.z < MAX_Z && !map.hasChunk(cx, cy, g.z + 1))) return null;
    const p = game.player;
    const taken = new Set<number>();
    const tileKey = (x: number, y: number) => (y - y0) * SM_SIZE + (x - x0);
    const inSubmap = (x: number, y: number) => x >= x0 && y >= y0 && x < x0 + SM_SIZE && y < y0 + SM_SIZE;
    for (const m of this.sys.all) if (!m.dead && m.z === g.z && inSubmap(m.tileX, m.tileY)) taken.add(tileKey(m.tileX, m.tileY));
    if (p.z === g.z && inSubmap(p.tileX, p.tileY)) taken.add(tileKey(p.tileX, p.tileY));
    const spots: [number, number][] = [];
    for (let y = y0; y < y0 + SM_SIZE; y++)
      for (let x = x0; x < x0 + SM_SIZE; x++) {
        if (taken.has(tileKey(x, y))) continue;
        // NPCs (game.creatureAt also answers for monsters in the bubble, already counted above)
        if (game.creatureAt?.(x, y, g.z)) continue;
        if (!canStandAt(map, WALKER, x, y, g.z)) continue;
        if (!ignoreSight && playerCanSee(game, x, y, g.z)) continue;
        if (!isOutside(map, x, y, g.z)) continue;
        spots.push([x, y]);
      }
    this.spent.add(g.key);
    if (!spots.length) {
      this.stats.empty++;
      return 0;
    }
    this.stats.groups++;
    const data = game.data;
    const rng = new Rng(hashSeed(game.seed, g.sx, g.sy, g.z, g.special, 0x6d73));
    const ctx = this.spawner.groupCtx();
    const ids: string[] = [];
    let pop = g.population;
    for (let m = 0; m < pop; m++) {
      const res = pickMonsterGroupResult(data, g.group, rng, ctx);
      if (!res) break;
      pop -= res.cost;
      for (const s of res.spawns) for (let i = 0; i < s.count; i++) ids.push(s.id);
    }
    const safe = this.spawner.opts.safeRadius;
    let placed = 0;
    for (const id of ids) {
      const def = data.monsters[id];
      if (!def) {
        warnOnce('monster', id);
        continue;
      }
      for (let tries = 0; tries < 10 && spots.length; tries++) {
        const [x, y] = spots.splice(rng.int(0, spots.length - 1), 1)[0];
        if (!canStandAt(map, def, x, y, g.z)) continue;
        if (def.aggression > 0 && p.z === g.z && Math.hypot(x + 0.5 - p.x, y + 0.5 - p.y) < safe) continue;
        this.sys.spawn(def, x + 0.5, y + 0.5, g.z, { rng: new Rng(hashSeed(game.seed, x, y, g.z, g.special, placed)) });
        placed++;
        break;
      }
    }
    this.stats.monsters += placed;
    return placed;
  }
}

/** Wire the spawner into the game loop and the save (section `mongroups`: spent group keys). */
export function installMonGroups(game: Game, sys: MonsterSystem, source: MonGroupSource, spawner: Spawner): MonGroupSpawner {
  const mg = new MonGroupSpawner(sys, source, spawner);
  game.systems.push({ name: 'mongroups', update: (g, dt) => mg.update(g, dt) });
  registerSaveable<string[]>(game, 'mongroups', {
    order: 21,
    save: () => [...mg.spent].sort(),
    load(keys) {
      mg.spent.clear();
      for (const k of keys) mg.spent.add(k);
      mg.ignoreSightOnce();
    },
    // A save from before special spawns: none of its groups have spawned yet.
    missing() {
      mg.spent.clear();
      mg.ignoreSightOnce();
    },
  });
  return mg;
}
