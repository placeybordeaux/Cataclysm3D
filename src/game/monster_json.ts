import { Rng, hashSeed } from '../core/rng';
import type { MonsterSystem } from './monai';
import type { Monster, MonEffect } from './monster';

// Monster <-> JSON, shared by the save section (src/save/builtins.ts) and the far-monster
// stash (monstash.ts), which keeps the same records for monsters folded out of the live list.

export interface MonsterJSON {
  id: string;
  x: number; y: number; z: number;
  hp: number;
  /** Monster.hpScale (difficulty resilience at spawn) when not 1. */
  hpScale?: number;
  facing: number;
  anger: number;
  morale: number;
  aggro: boolean;
  friendly?: boolean;
  name?: string;
  /** Member of a city horde (reacts to far gunfire; spawner.ts). */
  horde?: boolean;
  effects?: [MonEffect, number][];
  attackCooldown?: number;
  busy?: number;
  /** Special attack cooldowns by special id. */
  specials?: [string, number][];
  upgradeDay: number;
  /** [x, y, seconds left] of the noise being investigated. */
  wander?: [number, number, number];
  /** [x, y, seconds ago] where the player was last seen; absent = never. */
  lastSeen?: [number, number, number];
}

export function monsterToJSON(m: Monster): MonsterJSON {
  const j: MonsterJSON = {
    id: m.type.id, x: m.x, y: m.y, z: m.z, hp: m.hp, facing: m.facing, anger: m.anger, morale: m.morale, aggro: m.aggroCharacter,
    upgradeDay: m.upgradeDay,
  };
  if (m.hpScale !== 1) j.hpScale = m.hpScale;
  if (m.friendly) j.friendly = true;
  if (m.name) j.name = m.name;
  if (m.horde) j.horde = true;
  // 'grabbing' is tied to the grab link we don't persist (the survivor starts free).
  const eff = [...m.effects].filter(([e, t]) => t > 0 && e !== 'grabbing');
  if (eff.length) j.effects = eff;
  if (m.attackCooldown > 0) j.attackCooldown = m.attackCooldown;
  if (m.busy > 0) j.busy = m.busy;
  const sp = m.specials.filter((s) => s.cooldown > 0).map((s) => [String(s.def.id), s.cooldown] as [string, number]);
  if (sp.length) j.specials = sp;
  if (m.wanderTime > 0) j.wander = [m.wanderX, m.wanderY, m.wanderTime];
  if (Number.isFinite(m.lastSeenAge)) j.lastSeen = [m.lastSeenX, m.lastSeenY, m.lastSeenAge];
  return j;
}

export function restoreMonster(sys: MonsterSystem, j: MonsterJSON, warn: (msg: string) => void): Monster | null {
  const game = sys.game;
  const def = game.data.monsters[j.id];
  if (!def) {
    warn(`unknown monster "${j.id}" dropped`);
    return null;
  }
  const m = sys.spawn(def, j.x, j.y, j.z, {
    friendly: j.friendly,
    name: j.name,
    rng: new Rng(hashSeed(game.seed, Math.floor(j.x * 16), Math.floor(j.y * 16), j.z, sys.all.length, 0x10ad)),
  });
  m.hpScale = j.hpScale ?? 1;
  m.hp = j.hp;
  m.horde = !!j.horde;
  m.facing = j.facing;
  m.anger = j.anger;
  m.morale = j.morale;
  m.aggroCharacter = j.aggro;
  m.upgradeDay = j.upgradeDay;
  m.effects.clear();
  for (const [e, t] of j.effects ?? []) m.effects.set(e, t);
  m.attackCooldown = j.attackCooldown ?? 0;
  m.busy = j.busy ?? 0;
  const cds = new Map(j.specials ?? []);
  for (const sp of m.specials) sp.cooldown = cds.get(String(sp.def.id)) ?? 0;
  if (j.wander) [m.wanderX, m.wanderY, m.wanderTime] = j.wander;
  if (j.lastSeen) [m.lastSeenX, m.lastSeenY, m.lastSeenAge] = j.lastSeen;
  return m;
}
