import type { Game } from './game';
import type { FurnitureDef, TerrainDef } from '../data/types';
import type { Item } from './item';
import { fromSpawned } from './item';
import { spawnOnGround } from './moves';
import { expandItemGroup } from '../data/itemgroups';
import { emitSound } from './sound';
import { sfx } from '../audio/sfx';
import { bashMaterial } from '../audio/bashSounds';
import { invalidateNaturalLight } from './vision';

// Prying things open with a crowbar, after BN iuse::crowbar (iuse.cpp) on the `pry` object of
// terrain/furniture (BN's format; DDA's older `prying` object is read too). BN data uses it for
// locked doors, latched windows (from outside) and crates/safes:
//
//   diff = difficulty − (tool PRY − pry_quality) × pry_bonus_mult
//   time = max(20, diff × 50 − str × 10) moves
//   success: dice(4, diff) < dice(4, str)
//   else, if breakable: dice(4, diff) > (dice(2, mechanics) + dice(2, str)) × tool PRY breaks it
//        (a window's glass) instead of just failing.

export interface PryInfo {
  pryQuality: number;
  difficulty: number;
  bonusMult: number;
  result: string;
  successMessage: string;
  failMessage: string;
  noise: number;
  breakable: boolean;
  breakResult?: string;
  breakMessage: string;
  breakSound: string;
  breakNoise: number;
  breakItems?: unknown;
  items?: unknown;
  furniture: boolean;
  canPry(game: Game): boolean;
}

const num = (v: unknown, d: number) => (typeof v === 'number' ? v : d);
const str = (v: unknown, d: string) => (typeof v === 'string' ? v : d);

/** The def's prying rules, or null when it can't be pried. */
export function pryInfo(def: TerrainDef | FurnitureDef): PryInfo | null {
  const isFurn = def.id.startsWith('f_');
  const bn = def.pry as Record<string, unknown> | undefined;
  if (bn && typeof bn === 'object' && num(bn.pry_quality, -1) >= 0) {
    const result = str(isFurn ? bn.new_furn_type : bn.new_ter_type, '');
    if (!result) return null;
    const q = num(bn.pry_quality, 1);
    return {
      pryQuality: q,
      difficulty: num(bn.difficulty, 1),
      bonusMult: num(bn.pry_bonus_mult, 1),
      result,
      successMessage: str(bn.success_message, 'You pry it open.'),
      failMessage: str(bn.fail_message, "You pry, but can't get it open."),
      noise: num(bn.noise, 0),
      breakable: bn.breakable === true,
      breakResult: str(isFurn ? bn.break_furn_type : bn.break_ter_type, '') || undefined,
      breakMessage: str(bn.break_message, 'You break it.'),
      breakSound: str(bn.break_sound, 'crunch!'),
      breakNoise: num(bn.break_noise, 0),
      breakItems: bn.break_items,
      items: bn.pry_items,
      furniture: isFurn,
      canPry: (game) => !!bestPryTool(game, q),
    };
  }
  // DDA's `prying` (difficulty against strength, no breaking)
  const dda = def.prying as { result?: string; message?: string; prying_data?: { difficulty?: number; prying_level?: number; noisy?: boolean; failure?: string } } | undefined;
  if (dda?.result) {
    const q = dda.prying_data?.prying_level ?? 1;
    return {
      pryQuality: q, difficulty: dda.prying_data?.difficulty ?? 5, bonusMult: 1, result: dda.result,
      successMessage: dda.message ?? 'You pry it open.', failMessage: dda.prying_data?.failure ?? "You pry, but can't get it open.",
      noise: dda.prying_data?.noisy ? 12 : 0, breakable: false, breakMessage: '', breakSound: '', breakNoise: 0, furniture: isFurn,
      canPry: (game) => !!bestPryTool(game, q),
    };
  }
  return null;
}

/** The carried tool with the best PRY quality ≥ min (BN find_best_prying_tool). */
export function bestPryTool(game: Game, min = 1): Item | null {
  const tools = game.player.inv.findByQuality('PRY', Math.max(1, min));
  let best: Item | null = null;
  for (const t of tools) if (!best || t.qualityLevel('PRY') > best.qualityLevel('PRY')) best = t;
  return best;
}

/** BN dice(): 0 for fewer than 1 side. */
function dice(game: Game, n: number, sides: number): number {
  return sides < 1 ? 0 : game.player.rng.dice(n, sides);
}

function dropItems(game: Game, x: number, y: number, z: number, list: unknown): void {
  if (!Array.isArray(list)) return;
  for (const sp of expandItemGroup(game.data, list as never, game.player.rng))
    for (const it of fromSpawned(game.data, sp)) spawnOnGround(game.map, x, y, z, it);
}

export function pryAttempt(game: Game, x: number, y: number, z: number, def: TerrainDef | FurnitureDef): void {
  const info = pryInfo(def);
  if (!info) return void game.message(`You can't pry the ${def.name} open.`);
  const tool = bestPryTool(game, info.pryQuality);
  if (!tool) return void game.message(`You need a tool with prying ${info.pryQuality} to pry that open.`);
  const p = game.player;
  const level = tool.qualityLevel('PRY');
  const diff = info.difficulty - (level - info.pryQuality) * info.bonusMult;
  const pos = { x: x + 0.5, y: y + 0.5, z };
  const setTo = (id: string) => (info.furniture ? game.map.setFurn(x, y, z, id) : game.map.setTer(x, y, z, id));
  game.activities.start({
    name: 'prying',
    duration: Math.max(20, diff * 50 - p.str * 10) / 100,
    onComplete: () => {
      const here = info.furniture ? game.map.furnAt(x, y, z) : game.map.terAt(x, y, z);
      if (here.id !== def.id) return; // someone else got there first
      if (dice(game, 4, diff) < dice(game, 4, p.str)) {
        setTo(info.result);
        dropItems(game, x, y, z, info.items);
        game.message(info.successMessage, 'c_green');
        sfx.door('open', pos, def.id);
        if (info.noise > 0) emitSound(game, { x, y, z }, info.noise, 'a crunch!', { category: 'destructive_activity', source: p, sfxId: '' });
      } else if (info.breakable && info.breakResult && dice(game, 4, diff) > (dice(game, 2, p.getSkill('mechanics')) + dice(game, 2, p.str)) * level) {
        setTo(info.breakResult);
        dropItems(game, x, y, z, info.breakItems);
        game.message(info.breakMessage, 'c_light_red');
        sfx.smash(pos, { success: true, targetId: def.id, material: bashMaterial(def) });
        emitSound(game, { x, y, z }, info.breakNoise, info.breakSound, { category: 'combat', source: p, sfxId: '' });
      } else {
        game.message(info.failMessage, 'c_light_red');
        if (info.noise > 0) emitSound(game, { x, y, z }, Math.round(info.noise / 2), 'a creak', { category: 'destructive_activity', source: p, sfxId: '' });
      }
      invalidateNaturalLight(game);
      game.events.emit('mapChanged', { x, y, z });
    },
  });
}
