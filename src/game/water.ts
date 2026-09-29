import type { Game } from './game';
import type { MonsterDef } from '../data/types';
import type { Rng } from '../core/rng';
import type { Monster } from './monster';
import type { MonsterSystem } from './monai';
import { ACTION_SCALE } from '../core/time';
import { hasFlag } from '../world/registry';
import { warnOnce } from '../data/warn';
import { MAIN_PARTS } from './bodyparts';
import { createItem, type Item } from './item';
import { emitSound } from './sound';
import { MAX_VIEW_DISTANCE } from './vision';

// Water: drinking and filling containers from lakes/rivers (iexamine::water_source +
// liquid_handler), fishing with a rod (iuse::fishing_rod + fish_activity_actor), and
// swimming (avatar_action::swim, suffer::while_underwater).

// ------------------------------------------------------------------ liquids

/** CDDA `liquid_source` of a terrain/furniture (water terrain: dirty `water`). */
export function liquidSourceId(game: Game, x: number, y: number, z: number): string | null {
  const f = game.map.furnAt(x, y, z), t = game.map.terAt(x, y, z);
  for (const d of [f, t]) {
    const ls = d.liquid_source as { id?: string } | undefined;
    if (ls?.id) return ls.id;
  }
  const act = [f.examine_action, t.examine_action];
  if (act.includes('water_source')) return 'water';
  return null;
}

/** Containers you carry that can take `liquidId` now: [container, how many charges fit]. */
export function fillableContainers(game: Game, liquidId: string): [Item, number][] {
  const def = game.data.items[liquidId];
  if (!def) return [];
  const probe = createItem(game.data, liquidId, { charges: 100000 });
  const out: [Item, number][] = [];
  for (const it of game.player.inv.allItems()) {
    if (it.sealed || !it.containerPockets().some((p) => p.data.watertight)) continue;
    let room = 0;
    for (const p of it.containerPockets()) {
      const r = p.canContain(probe);
      if (r.ok) room += r.charges ?? 0;
    }
    if (room > 0) out.push([it, room]);
  }
  return out;
}

/** liquid_handler: pour as much of the source's liquid as fits into `container`. Returns charges added. */
export function fillContainer(game: Game, container: Item, liquidId: string): number {
  const w = createItem(game.data, liquidId, { charges: 100000 });
  const before = w.charges;
  const left = container.put(w);
  const added = before - (left ? left.charges : 0);
  if (added > 0) game.message(`You fill the ${container.baseName(1)} with ${w.baseName(added)}.`, 'c_light_gray');
  else game.message(`The ${container.baseName(1)} can't hold any more ${w.baseName(2)}.`, 'c_light_gray');
  return added;
}

// ------------------------------------------------------------------ fishing

/** Tiles of the same body of water within MAX_VIEW_DISTANCE (game::get_fishable_locations). */
export function fishableLocations(game: Game, x0: number, y0: number, z: number, maxTiles = 6000): Set<string> {
  const map = game.map;
  const seen = new Set<string>();
  const q: [number, number][] = [[x0, y0]];
  const ok = (x: number, y: number) =>
    Math.abs(x - x0) <= MAX_VIEW_DISTANCE && Math.abs(y - y0) <= MAX_VIEW_DISTANCE &&
    // never generate chunks just to look for water
    map.hasChunk(Math.floor(x / 24), Math.floor(y / 24), z) && hasFlag(map.terAt(x, y, z), 'FISHABLE');
  if (!ok(x0, y0)) return seen;
  seen.add(`${x0},${y0}`);
  while (q.length && seen.size < maxTiles) {
    const [x, y] = q.pop()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy, k = `${nx},${ny}`;
      if (seen.has(k) || !ok(nx, ny)) continue;
      seen.add(k);
      q.push([nx, ny]);
    }
  }
  return seen;
}

/** monster::fish_population: dice(1, 20) per fishable monster, kept here (the monster class doesn't have it). */
const fishPop = new WeakMap<Monster, number>();
export function fishPopulation(m: Monster, rng: Rng): number {
  let n = fishPop.get(m);
  if (n === undefined) fishPop.set(m, (n = rng.dice(1, 20)));
  return n;
}

export function fishablesIn(game: Game, zone: Set<string>, z: number): Monster[] {
  const ms = (game as unknown as { monsters?: MonsterSystem }).monsters;
  if (!ms) return [];
  return ms.all.filter((m) => !m.dead && m.z === z && m.has('FISHABLE') && zone.has(`${m.tileX},${m.tileY}`));
}

/**
 * fish_activity_actor::do_turn chance numerator for one turn (out of 600000), given the
 * rolled skill bonus. `pops` = fish_population of each visible fishable monster.
 */
export function fishChance(skillRoll: number, pops: number[]): number {
  let c = 1;
  if (!pops.length) c += skillRoll / 2;
  else c += pops.reduce((a, b) => a + b, 0) + skillRoll;
  return Math.min(skillRoll * 10, c);
}

/** Survival skill as boosted by the rod for one turn (FISHING_ROD 1: +1d6; 2: (+4d9)×2). */
export function rodSkillRoll(rng: Rng, survival: number, rodQuality: number): number {
  if (rodQuality >= 2) return (survival + rng.dice(4, 9)) * 2;
  return survival + rng.dice(1, 6);
}

/** Expected chance (0..1) of at least one catch in `seconds` of fishing (for tests/UI). */
export function expectedCatchChance(survival: number, rodQuality: number, pops: number[], seconds: number): number {
  // mean of the dice roll is good enough for an estimate
  const roll = rodQuality >= 2 ? (survival + 20) * 2 : survival + 3.5;
  const p = fishChance(roll, pops) / 600000;
  return 1 - (1 - p) ** seconds;
}

/** Monster types in GROUP_FISH (the hidden fish you can still catch with no fish in sight). */
function fishGroupTypes(game: Game): MonsterDef[] {
  const g = game.data.monsterGroups?.GROUP_FISH as { monsters?: { monster: string }[]; default?: string } | undefined;
  const ids = new Set<string>((g?.monsters ?? []).map((e) => e.monster));
  if (g?.default) ids.add(g.default);
  return [...ids].map((id) => game.data.monsters[id]).filter((d): d is MonsterDef => !!d);
}

/** rod_fish: a fish corpse at your feet (from a visible fish's population, or a hidden one). */
export function catchFish(game: Game, fishables: Monster[]): string | null {
  const p = game.player;
  const ms = (game as unknown as { monsters?: MonsterSystem }).monsters;
  let def: MonsterDef | undefined;
  if (fishables.length) {
    const m = fishables[p.rng.int(0, fishables.length - 1)];
    def = m.type;
    const left = fishPopulation(m, p.rng) - 1;
    fishPop.set(m, left);
    // the last fish of a school is the monster itself
    if (left <= 0) ms?.remove(m);
  } else {
    const types = fishGroupTypes(game);
    if (!types.length) {
      warnOnce('monster_group', 'GROUP_FISH');
      return null;
    }
    def = types[p.rng.int(0, types.length - 1)];
  }
  const name = String((def as { name?: unknown }).name ?? def.id);
  if (ms) ms.placeCorpse(def, p.tileX + 0.5, p.tileY + 0.5, p.z);
  else if (game.data.items.corpse) {
    const it = createItem(game.data, 'corpse');
    it.vars.corpse = def.id;
    it.vars.corpse_name = name;
    game.map.addItem(p.tileX, p.tileY, p.z, it);
  }
  game.message(`You caught a ${name}.`, 'c_green');
  return def.id;
}

/** A fishable tile next to the player (iuse::fishing_rod), or null. */
export function fishingSpot(game: Game): { x: number; y: number; z: number } | null {
  const p = game.player;
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const x = p.tileX + dx, y = p.tileY + dy;
      if (hasFlag(game.map.terAt(x, y, p.z), 'FISHABLE')) return { x, y, z: p.z };
    }
  return null;
}

/**
 * iuse::fishing_rod: cast the line; a 5-hour activity (warped) that rolls every game second
 * for a bite. `onCatch` sees each fish. Returns false with CDDA's message when you can't.
 */
export function startFishing(game: Game, rod: Item, opts: { duration?: number } = {}): boolean {
  const spot = fishingSpot(game);
  if (!spot) {
    game.message("You can't fish there!", 'c_light_gray');
    return false;
  }
  const p = game.player;
  const q = rod.qualityLevel('FISHING_ROD');
  const zone = fishableLocations(game, spot.x, spot.y, spot.z);
  game.message('You cast your line and wait to hook something…', 'c_light_gray');
  let acc = 0, hourAcc = 0;
  return game.activities.start({
    name: 'fishing',
    duration: opts.duration ?? 5 * 3600,
    onProgress: (dt) => {
      acc += dt;
      hourAcc += dt;
      let fish: Monster[] | null = null;
      while (acc >= 1) {
        acc -= 1;
        const roll = rodSkillRoll(p.rng, p.getSkill('survival'), q);
        fish ??= fishablesIn(game, zone, spot.z);
        const pops = fish.map((m) => fishPopulation(m, p.rng));
        if (p.rng.int(1, 600000) <= fishChance(roll, pops)) {
          game.message('You feel a tug on your line!', 'c_green');
          catchFish(game, fish);
          fish = null;
        }
      }
      if (hourAcc >= 3600) {
        hourAcc -= 3600;
        p.practice('survival', p.rng.int(1, 3));
      }
    },
    onComplete: () => game.message('You finish fishing', 'c_light_gray'),
  });
}

// ------------------------------------------------------------------ swimming

export interface SwimState {
  swimming: boolean;
  underwater: boolean;
  oxygen: number;
  /** last dry (non-deep-water) position, for "Dive into the water?" refusals */
  shoreX: number;
  shoreY: number;
  /** player agreed to dive in; cleared on leaving deep water */
  divingOk: boolean;
  drownMsgT: number;
}

const swimStates = new WeakMap<Game, SwimState>();
export function swimState(game: Game): SwimState {
  let s = swimStates.get(game);
  if (!s) swimStates.set(game, (s = { swimming: false, underwater: false, oxygen: oxygenMax(game), shoreX: game.player.x, shoreY: game.player.y, divingOk: false, drownMsgT: 0 }));
  return s;
}

export function oxygenMax(game: Game): number {
  return 30 + 2 * game.player.str;
}

/** Character::swim_speed (no mutations/fins): 440 + carried weight / 60 g − 50 × swimming. */
export function swimSpeed(game: Game): number {
  const p = game.player;
  return 440 + p.inv.weightCarried() / 60 - 50 * p.getSkill('swimming');
}

export function isDeepWater(game: Game, x: number, y: number, z: number): boolean {
  const t = game.map.terAt(x, y, z);
  return hasFlag(t, 'DEEP_WATER') && hasFlag(t, 'SWIMMABLE');
}

/** Items diving would ruin (check_water_affect_items): not inside a watertight pocket. */
export function waterAffectedItems(game: Game): { dissolve: Item[]; destroy: Item[] } {
  const dissolve: Item[] = [], destroy: Item[] = [];
  const walk = (it: Item, protectedByPocket: boolean) => {
    if (!protectedByPocket) {
      if (it.hasFlag('WATER_DISSOLVE')) dissolve.push(it);
      else if (it.hasFlag('WATER_BREAK') && !it.vars.water_broken) destroy.push(it);
    }
    for (const pk of it.pockets) for (const c of pk.contents) walk(c, protectedByPocket || !!pk.data.watertight);
  };
  const inv = game.player.inv;
  for (const it of [...(inv.wielded ? [inv.wielded] : []), ...inv.worn]) walk(it, false);
  return { dissolve, destroy };
}

/** game::water_affect_items: dissolve / short out what the water reaches. */
export function soakItems(game: Game): void {
  const { dissolve, destroy } = waterAffectedItems(game);
  const inv = game.player.inv;
  for (const it of dissolve) {
    inv.remove(it);
    game.message(`Your ${it.name()} dissolves in the water!`, 'c_light_red');
  }
  for (const it of destroy) {
    it.vars.water_broken = 1;
    it.active = false;
    game.message(`Your ${it.name()} short-circuits!`, 'c_light_red');
  }
}

const asking = new WeakSet<Game>();

/** Ask before diving in; the UI sets this (absent = always dive, e.g. tests). */
export const swimUi: { confirmDive?: (warn: string[], answer: (yes: boolean) => void) => void } = {};

/**
 * Per-tick swimming: wet clothes, the dive confirmation, sinking when too heavy or winded,
 * oxygen and drowning. Movement cost itself comes from the terrain (deep water 8 = 400 moves).
 */
export function updateSwimming(game: Game, realDt: number): void {
  const p = game.player;
  const st = swimState(game);
  if (p.dead || game.movementOverride?.()) return;
  const deep = isDeepWater(game, p.tileX, p.tileY, p.z);
  const shallow = !deep && hasFlag(game.map.terAt(p.tileX, p.tileY, p.z), 'SHALLOW_WATER');
  if (shallow) for (const bp of ['leg_l', 'leg_r'] as const) p.wetness[bp] = 1;
  if (!deep) {
    if (st.swimming) game.message('You climb out of the water.', 'c_light_gray');
    st.swimming = st.underwater = st.divingOk = false;
    st.oxygen = oxygenMax(game);
    st.shoreX = p.x;
    st.shoreY = p.y;
    return;
  }
  if (!st.swimming && !st.divingOk && swimUi.confirmDive) {
    // Step back onto the shore and ask, like CDDA's "Dive into the water?"
    const { dissolve, destroy } = waterAffectedItems(game);
    const warn = [...dissolve, ...destroy].map((it) => it.name());
    const tx = p.x, ty = p.y;
    p.x = st.shoreX;
    p.y = st.shoreY;
    // One question at a time: ticks that run while it's open (scripted steps) mustn't stack more.
    if (asking.has(game)) return;
    asking.add(game);
    swimUi.confirmDive(warn, (yes) => {
      asking.delete(game);
      if (!yes) return;
      st.divingOk = true;
      p.x = tx;
      p.y = ty;
    });
    return;
  }
  if (!st.swimming) {
    st.swimming = true;
    soakItems(game);
    if (swimSpeed(game) < 500) game.message('You start swimming.', 'c_light_gray');
    emitSound(game, { x: p.x, y: p.y, z: p.z }, 8, 'splash!', { category: 'movement', source: p });
  }
  for (const bp of MAIN_PARTS) if (bp !== 'head' || st.underwater) p.wetness[bp] = 1;
  const turns = realDt * ACTION_SCALE;
  const winded = p.effects.has('winded');
  const heavy = swimSpeed(game) >= 500;
  if (!st.underwater && (heavy || winded)) {
    st.underwater = true;
    game.message('You sink like a rock!', 'c_light_red');
  } else if (st.underwater && !heavy && !winded) {
    // CDDA needs '<' to surface; in real time you kick back up once you can
    st.underwater = false;
    game.message('You surface, gasping for air.', 'c_light_gray');
  }
  if (st.underwater) {
    st.oxygen -= turns;
    if (st.oxygen <= 5) {
      // suffer::while_underwater: 1-4 torso damage per turn
      let dmg = 0;
      for (let t = turns; t > 0; t--) if (t >= 1 || p.rng.next() < t) dmg += p.rng.int(1, 4);
      if (dmg > 0) p.applyDamage('torso', dmg);
      if ((st.drownMsgT -= realDt) <= 0) {
        st.drownMsgT = 1;
        game.message("You're drowning!", 'c_red');
      }
    }
  } else st.oxygen = Math.min(oxygenMax(game), st.oxygen + turns * 2);
  if (p.rng.next() < turns * 0.02) p.practice('swimming', 1);
}
