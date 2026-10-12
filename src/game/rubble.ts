import type { Game } from './game';
import type { Item } from './item';
import { fromSpawned } from './item';
import { spawnOnGround } from './moves';
import { expandItemGroup } from '../data/itemgroups';
import { hasFlag } from '../world/registry';
import { registerSaveable } from '../save/registry';
import { lineOfSight } from './vision';
import { CRAFT_RANGE } from './crafting_inv';
import type { NpcSystem } from './npcai';

export interface RubbleTile { x: number; y: number; z: number }

export function isRubble(game: Game, at: RubbleTile): boolean {
  return hasFlag(game.map.furnAt(at.x, at.y, at.z), 'RUBBLE');
}

/**
 * Unfinished rubble clearing, keyed by tile. BN serializes the player's current activity and
 * backlog directly (src/savegame_json.cpp:545,877: `data.read/json.member("activity"/"backlog", …)`),
 * so a reload (or an interruption that cancels the activity) never loses moves_left; resuming
 * re-validates via player_activity::can_resume_with (player_activity.cpp:693), which requires the
 * *same tile* (`coords[0]`) and the *same `index`* — iexamine.cpp's rubble() always assigns
 * index -1, iuse.cpp's clear_rubble() assigns the DIG-quality `bonus` — so switching tool/path
 * starts over rather than resuming. We track the same two keys (tile + index) here, since this
 * engine doesn't carry its generic `Activity` across a save (src/save/format.ts: "CDDA also
 * drops the current activity on load").
 */
export interface PendingRubbleClear {
  x: number; y: number; z: number;
  /** Furniture id when clearing started; a since-replaced site can't resume. */
  furnId: string;
  /** BN's activity index: -1 for the examine route, the DIG-quality bonus for the tool route. */
  index: number;
  /** Game seconds; frozen at the first activation like BN's moves_total — never recalculated
   * on resume, so a helper joining/leaving or a weaker replacement tool doesn't change it. */
  totalDuration: number;
  /** Game seconds of work done so far; survives cancellation and save/reload. */
  doneSeconds: number;
}

const pendingByGame = new WeakMap<Game, Map<string, PendingRubbleClear>>();
function pendingMap(game: Game): Map<string, PendingRubbleClear> {
  let m = pendingByGame.get(game);
  if (!m) pendingByGame.set(game, (m = new Map()));
  return m;
}
const tileKey = (at: RubbleTile) => `${at.x},${at.y},${at.z}`;

/** Registers save/load for unfinished clears (called once per Game from nature.ts). */
export function installRubble(game: Game): void {
  registerSaveable(game, 'rubble', {
    save: () => ({ pending: [...pendingMap(game).values()] }),
    load: (d: { pending?: PendingRubbleClear[] }) => {
      const m = pendingMap(game);
      m.clear();
      for (const p of d.pending ?? []) m.set(tileKey(p), p);
    },
    missing: () => pendingMap(game).clear(),
  });
}

/**
 * BN character_funcs::get_crafting_helpers (character_functions.cpp:807): awake, allied/
 * following NPCs within pickup range with a clear path to the player. ACT_CLEAR_RUBBLE's own
 * call (iuse.cpp:2832) caps this at 3. BN's PICKUP_RANGE is 6; this project already shrinks
 * that "nearby" radius to CRAFT_RANGE (2) for 3D space (crafting_inv.ts), so we match that
 * existing adaptation rather than the literal BN tile count. Computed once when the activity
 * (re)starts, exactly like BN's assistant count (player_activity::init_all_moves, called from
 * start_or_resume either way) — a helper joining or leaving mid-clear doesn't change a clear
 * already under way.
 */
export function clearRubbleHelpers(game: Game): number {
  const npcs = (game as unknown as { npcs?: NpcSystem }).npcs?.npcs ?? [];
  const p = game.player;
  let n = 0;
  for (const npc of npcs) {
    if (n >= 3) break;
    if (npc.dead || npc.z !== p.z || npc.isAsleep() || !npc.isFollower()) continue;
    if (Math.max(Math.abs(npc.tileX - p.tileX), Math.abs(npc.tileY - p.tileY)) >= CRAFT_RANGE) continue;
    if (!lineOfSight(game.map, p.tileX, p.tileY, npc.tileX, npc.tileY, p.z)) continue;
    n++;
  }
  return n;
}

/** BN iexamine::rubble uses 1/2 minutes; iuse::clear_rubble uses 30s / DIG bonus. */
export function startClearRubble(game: Game, at: RubbleTile, tool?: Item): boolean {
  const p = game.player;
  const reachable = () => p.z === at.z && Math.max(Math.abs(p.tileX - at.x), Math.abs(p.tileY - at.y)) <= 1;
  if (!reachable() || !isRubble(game, at)) return false;
  const quality = () => tool ? (p.inv.has(tool) ? tool.qualityLevel('DIG') : 0) : Math.max(0, ...p.inv.findByQuality('DIG', 1).map((it) => it.qualityLevel('DIG')));
  const burrow = () => !tool && p.hasTrait('BURROW');
  const required = tool ? 1 : 2;
  if (!burrow() && quality() < required) {
    game.message('If only you had a shovel…', 'c_light_gray');
    return false;
  }
  const cost = tool ? Math.max(0, Number(tool.def.charges_per_use ?? 0)) : 0;
  if (tool && tool.ammoRemaining() + (tool.hasFlag('USE_UPS') ? p.inv.upsCharges() : 0) < cost) {
    game.message(`Your ${tool.baseName()} does not have enough charges.`, 'c_light_red');
    return false;
  }
  const original = game.map.furnAt(at.x, at.y, at.z);
  const key = tileKey(at);
  const pending = pendingMap(game);
  let existing = pending.get(key);
  // The site changed since: no partial work to honour (BN never resumes a mismatched site either).
  if (existing && existing.furnId !== original.id) { pending.delete(key); existing = undefined; }

  const bonus = tool ? Math.max(quality() - 1, 1) : 1;
  const index = tool ? bonus : -1;
  const resuming = !!existing && existing.index === index;
  const helpers = tool ? clearRubbleHelpers(game) : 0;
  const freshDuration = tool ? (30 * (10 - helpers)) / 10 / bonus : burrow() || quality() >= 3 ? 60 : 120;
  const entry: PendingRubbleClear = resuming
    ? existing!
    : { x: at.x, y: at.y, z: at.z, furnId: original.id, index, totalDuration: freshDuration, doneSeconds: 0 };
  const duration = Math.max(0, entry.totalDuration - entry.doneSeconds);

  const started = game.activities.start({
    name: `clearing ${original.name}`, duration, at,
    onProgress: (gameDt) => { entry.doneSeconds += gameDt; },
    onComplete: () => {
      // The attempt is over either way: success clears the rubble, failure needs a fresh start.
      pending.delete(key);
      if (!reachable() || game.map.furnAt(at.x, at.y, at.z).id !== original.id || (!burrow() && quality() < required)) {
        game.message('You can no longer clear this rubble.', 'c_light_gray');
        return;
      }
      for (const spawn of original.bash?.items ? expandItemGroup(game.data, original.bash.items, p.rng) : []) {
        for (const item of fromSpawned(game.data, spawn)) spawnOnGround(game.map, at.x, at.y, at.z, item);
      }
      game.map.setFurn(at.x, at.y, at.z, 'f_null');
      game.events.emit('mapChanged', at);
      game.message(`You clear up the ${original.name}.`, 'c_light_green');
    },
  });
  if (!started) return false;
  pending.set(key, entry);
  // BN iuse returns charges_to_use only after assigning a clearing activity; a resumed clear
  // already paid this at its original activation (iuse.cpp is never re-invoked by a resume).
  if (!resuming && tool && cost > 0) {
    const own = tool.ammoConsume(Math.min(cost, tool.ammoRemaining()));
    if (own < cost && tool.hasFlag('USE_UPS')) p.inv.useUpsCharges(cost - own);
  }
  return true;
}
