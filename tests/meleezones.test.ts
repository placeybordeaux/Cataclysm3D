import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { GameData } from '../src/data/types';
import type { Input } from '../src/core/input';
import { Game } from '../src/game/game';
import type { Chunk, ChunkGenerator, GameMap } from '../src/world/map';
import { MonsterSystem } from '../src/game/monai';
import { PlayerCombat } from '../src/game/playercombat';
import { createItem } from '../src/game/item';
import { aimHooks, basisOf, setAimModel, swingFan, type HitZone, type Vec3 } from '../src/game/aimmodel';
import type { Monster } from '../src/game/monster';

// Melee on the model boxes (free aim, round 3): the swing's fan of rays meets the bodies as
// drawn. The renderer's hooks are stood in for by a box body per monster (legs, torso, head).

const dir = path.join(__dirname, '../public/data');
const load = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
let data: GameData;
beforeAll(() => {
  data = {
    terrain: load('terrain.json'), furniture: load('furniture.json'), items: load('items.json'), itemGroups: load('item_groups.json'),
    monsters: load('monsters.json'), monsterGroups: load('monster_groups.json'), recipes: [], misc: load('misc.json'),
  };
});
afterEach(() => {
  aimHooks.view = null;
  aimHooks.prepare = null;
  setAimModel('sway');
});

class FlatGen implements ChunkGenerator {
  generate(map: GameMap, c: Chunk): void {
    c.ter.fill(c.z === 0 ? map.terrain.index('t_dirt') : c.z > 0 ? map.terrain.index('t_open_air') : map.terrain.index('t_rock'));
    c.empty = false;
  }
}

/** Ray vs axis-aligned box (game coords); entry t or null. */
function rayBox(o: Vec3, d: Vec3, lo: Vec3, hi: Vec3): number | null {
  let a = 0, b = Infinity;
  for (const k of ['x', 'y', 'h'] as const) {
    if (Math.abs(d[k]) < 1e-12) {
      if (o[k] < lo[k] || o[k] > hi[k]) return null;
      continue;
    }
    let t0 = (lo[k] - o[k]) / d[k], t1 = (hi[k] - o[k]) / d[k];
    if (t0 > t1) [t0, t1] = [t1, t0];
    a = Math.max(a, t0);
    b = Math.min(b, t1);
    if (a > b) return null;
  }
  return a;
}

function world() {
  const input = { held: new Set<string>(), captured: false, mouseButtons: 0, onPress() {}, consumeMouse: () => [0, 0], consumeClicks: () => [] };
  const game = new Game(data, 3, input as unknown as Input);
  game.map.generator = new FlatGen();
  const p = game.player;
  p.x = 40.5;
  p.y = 40.5;
  p.yaw = 0;
  p.pitch = 0;
  for (let y = 0; y <= 4; y++) for (let x = 0; x <= 4; x++) game.map.chunk(x, y, 0);
  const sys = new MonsterSystem(game);
  const combat = new PlayerCombat(game, sys);
  game.systems.push(sys, combat);
  for (const k of Object.keys(p.hp)) p.hp[k as keyof typeof p.hp].max = p.hp[k as keyof typeof p.hp].cur = 100000;
  // A first-person camera at the eye, looking where the survivor looks.
  aimHooks.view = () => {
    const b = basisOf(p.yaw, p.pitch);
    const eye = { x: p.x, y: p.y, h: 1.6 };
    return { o: eye, ...b, third: false, eye };
  };
  // Each monster a stack of boxes: legs 0–0.8 m, torso 0.8–1.45, head 1.45–1.75 (0.25 m half-width).
  aimHooks.prepare = (mm) => {
    const m = mm as Monster;
    const box = (h0: number, h1: number, w: number, zone: HitZone) => ({ lo: { x: m.x - w, y: m.y - w, h: h0 }, hi: { x: m.x + w, y: m.y + w, h: h1 }, zone });
    const parts = [box(0, 0.8, 0.18, 'legs'), box(0.8, 1.45, 0.25, 'torso'), box(1.45, 1.75, 0.13, 'head')];
    return (o, d) => {
      let best: { t: number; zone: HitZone; part: string } | null = null;
      for (const b of parts) {
        const t = rayBox(o, d, b.lo, b.hi);
        if (t !== null && (!best || t < best.t)) best = { t, zone: b.zone, part: b.zone };
      }
      return best;
    };
  };
  return { game, sys, combat };
}

function zombie(sys: MonsterSystem, x: number, y: number): Monster {
  const z = sys.spawnById('mon_zombie', x, y, 0)!;
  z.hp = 100000;
  z.attackCooldown = 999;
  for (const s of z.specials) s.cooldown = 999;
  return z;
}

describe('melee on the model boxes', () => {
  it('the fan starts at the crosshair and spreads out', () => {
    const f = swingFan((40 * Math.PI) / 180);
    expect(f[0]).toEqual({ x: 0, y: 0 });
    expect(Math.abs(f[f.length - 1].x)).toBeCloseTo((40 * Math.PI) / 180, 3);
  });

  it('in a crowd, the swing hits the one under the crosshair, not the nearest to the swing\'s centre line', () => {
    const { game, sys, combat } = world();
    const p = game.player;
    const left = zombie(sys, p.x - 0.55, p.y - 0.9), mid = zombie(sys, p.x, p.y - 1.0), right = zombie(sys, p.x + 0.55, p.y - 0.9);
    // Look at the right one's chest.
    p.yaw = Math.atan2(right.x - p.x, -(right.y - p.y));
    p.pitch = Math.atan2(1.1 - 1.6, Math.hypot(right.x - p.x, right.y - p.y));
    expect(combat.meleePick()?.m).toBe(right);
    p.yaw = Math.atan2(left.x - p.x, -(left.y - p.y));
    expect(combat.meleePick()?.m).toBe(left);
    p.yaw = 0;
    expect(combat.meleePick()?.m).toBe(mid);
  });

  it('a bat to the head hits harder and says so; a leg blow makes it stumble or go down', () => {
    const { game, sys, combat } = world();
    const p = game.player;
    p.inv.wield(createItem(data, 'bat'), null);
    const z = zombie(sys, p.x, p.y - 1.0);
    const lines: string[] = [];
    let head = 0, torso = 0, nh = 0, nt = 0;
    game.events.on('playerAttack', (e) => e.reason && lines.push(e.reason));
    for (let i = 0; i < 20; i++) {
      p.pitch = Math.atan2(1.6 - 1.6, 1.0);
      const pk = combat.meleePick();
      expect(pk?.zone).toBe('head');
      const before = z.hp;
      combat.melee(z, { zone: pk!.zone });
      head += before - z.hp;
      nh++;
      z.effects.delete('stunned');
      z.effects.delete('downed');
      p.pitch = Math.atan2(1.1 - 1.6, 1.0);
      const pk2 = combat.meleePick();
      expect(pk2?.zone).toBe('torso');
      const b2 = z.hp;
      combat.melee(z, { zone: pk2!.zone });
      torso += b2 - z.hp;
      nt++;
    }
    expect(head / nh).toBeGreaterThan((torso / nt) * 1.25);
    expect(lines.some((l) => /HEAD ×1\.5/.test(l))).toBe(true);
    p.pitch = Math.atan2(0.4 - 1.6, 1.0);
    expect(combat.meleePick()?.zone).toBe('legs');
    const fx: string[] = [];
    game.events.on('playerAttack', (e) => e.reason && fx.push(e.reason));
    for (let i = 0; i < 12; i++) {
      z.effects.delete('downed');
      combat.melee(z, { zone: 'legs' });
    }
    expect(fx.every((l) => /legs ×0\.8/.test(l))).toBe(true);
    expect(fx.some((l) => /knocked down/.test(l))).toBe(true);
    expect(fx.some((l) => /stumbles/.test(l))).toBe(true);
  });

  it('when no ray meets a body (a zombie crawling at your feet), the swept arc still hits it', () => {
    const { game, sys, combat } = world();
    const p = game.player;
    const z = zombie(sys, p.x + 0.3, p.y - 0.8);
    aimHooks.prepare = () => () => null; // the model is there but no ray of the fan meets it
    expect(combat.meleePick()?.m).toBe(z);
  });

  it('classic dice ignores the models', () => {
    setAimModel('dice');
    const { game, sys, combat } = world();
    const p = game.player;
    const z = zombie(sys, p.x, p.y - 1.0);
    p.pitch = 0;
    expect(combat.meleePick()).toEqual({ m: z, zone: 'torso' });
  });
});
