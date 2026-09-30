import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { GameData } from '../src/data/types';
import type { Input } from '../src/core/input';
import { Game } from '../src/game/game';
import type { Chunk, ChunkGenerator, GameMap } from '../src/world/map';
import { MonsterSystem } from '../src/game/monai';
import { PlayerCombat } from '../src/game/playercombat';
import { createItem, type Item } from '../src/game/item';
import { L, spawnItem } from '../src/game/moves';
import { defenseOf, FEEL, guardScoreBonus, setFeelDifficulty } from '../src/game/combatfeel';
import {
  aimDirection, aimHooks, AimSway, bowPerfect, bowWindow, Breath, defaultHitZone, describeHit, freeAim, hitDamageMul, offsetToPixels, reloadBand,
  setAimModel, skillDamageMul, swayAmplitude, timingGames, weakSpotChance, type SwayInputs,
} from '../src/game/aimmodel';
import type { Monster } from '../src/game/monster';

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
  setAimModel('sway');
  setFeelDifficulty('accessible');
});

class FlatGen implements ChunkGenerator {
  generate(map: GameMap, c: Chunk): void {
    c.ter.fill(c.z === 0 ? map.terrain.index('t_dirt') : c.z > 0 ? map.terrain.index('t_open_air') : map.terrain.index('t_rock'));
    c.empty = false;
  }
}

interface FakeInput { clicks: number[]; mouseButtons: number; held: Set<string> }
function world(seed = 7) {
  const clicks: number[] = [];
  const input = { held: new Set<string>(), captured: false, mouseButtons: 0, clicks, onPress() {}, consumeMouse: () => [0, 0], consumeClicks: () => clicks.splice(0) } as FakeInput;
  const game = new Game(data, seed, input as unknown as Input);
  game.map.generator = new FlatGen();
  game.player.x = 40.5;
  game.player.y = 40.5;
  game.player.yaw = 0;
  game.player.pitch = 0;
  for (let y = 0; y <= 4; y++) for (let x = 0; x <= 4; x++) game.map.chunk(x, y, 0);
  const sys = new MonsterSystem(game);
  const combat = new PlayerCombat(game, sys);
  game.systems.push(sys, combat);
  game.clock.seconds = 12 * 3600;
  for (const k of Object.keys(game.player.hp)) game.player.hp[k as keyof typeof game.player.hp].max = game.player.hp[k as keyof typeof game.player.hp].cur = 100000;
  return { game, sys, combat, input };
}
const step = (game: Game, seconds: number) => {
  for (let i = 0; i < Math.round(seconds * 30); i++) game.tick(1 / 30);
};
function pistol(game: Game): Item {
  const gun = createItem(data, 'glock_19');
  spawnItem(createItem(data, 'glockmag', { ammo: '9mm' }), L.mag(gun));
  game.player.inv.wield(gun, null);
  return gun;
}
/** A zombie `d` m straight ahead (north) that stays put and doesn't die. */
function target(sys: MonsterSystem, game: Game, d: number, id = 'mon_zombie'): Monster {
  const z = sys.spawnById(id, game.player.x, game.player.y - d, 0)!;
  z.hp = 100000;
  z.addEffect('stunned', 10000);
  return z;
}
/** Aim the view at height `h` (m above the floor) on something `d` m ahead, and pin the reticle there. */
function aimAt(game: Game, combat: PlayerCombat, d: number, h: number, ox = 0): void {
  game.player.pitch = Math.atan2(h - 1.6, d);
  combat.aim.markShown(ox, 0, performance.now());
}
const base: SwayInputs = { staticMoa: 400, recoilMoa: 100, floorMoa: 80, skill: 0, speed: 0, running: false, crouching: false, ads: 0, pain: 0, stamina: 1 };
const deg = (r: number) => (r * 180) / Math.PI;

describe('aim model switch', () => {
  it('defaults to sway and rejects unknown models loudly', () => {
    expect(freeAim()).toBe(true);
    expect(timingGames()).toBe(false);
    setAimModel('timing');
    expect(freeAim() && timingGames()).toBe(true);
    setAimModel('dice');
    expect(freeAim()).toBe(false);
    expect(() => setAimModel('wobbly' as never)).toThrow(/unknown aim model/);
  });
});

describe('sway amplitude (from BN dispersion)', () => {
  it('is BN mean lateral error × aimSwayScale when steady, and shrinks with skill', () => {
    // 400 MOA of dispersion maxima: mean lateral = 200 × 2/π MOA ≈ 2.12°, × FEEL.aimSwayScale.
    expect(deg(swayAmplitude(base))).toBeCloseTo(((200 * 2) / Math.PI / 60) * FEEL.aimSwayScale, 1);
    const s0 = swayAmplitude({ ...base, staticMoa: 412 }), s5 = swayAmplitude({ ...base, staticMoa: 102, skill: 5 }), s10 = swayAmplitude({ ...base, staticMoa: 31, skill: 10 });
    expect(s0).toBeGreaterThan(s5 * 3);
    expect(s5).toBeGreaterThan(s10 * 2);
  });
  it('aiming down the sights and crouching steady it; moving, running, pain, fatigue and being unaimed shake it', () => {
    const a = swayAmplitude(base);
    expect(swayAmplitude({ ...base, ads: 1 })).toBeLessThan(a * 0.7);
    expect(swayAmplitude({ ...base, crouching: true })).toBeLessThan(a);
    expect(swayAmplitude({ ...base, speed: 3 })).toBeGreaterThan(a * 1.5);
    expect(swayAmplitude({ ...base, speed: 5, running: true })).toBeGreaterThan(swayAmplitude({ ...base, speed: 5 }));
    expect(swayAmplitude({ ...base, pain: 40 })).toBeGreaterThan(a * 1.4);
    expect(swayAmplitude({ ...base, stamina: 0.05 })).toBeGreaterThan(a * 1.5);
    expect(swayAmplitude({ ...base, recoilMoa: 3000 })).toBeGreaterThan(a * 1.3);
    // Skill damps the unaimed part too.
    expect(swayAmplitude({ ...base, recoilMoa: 3000, staticMoa: 0, skill: 10 })).toBeLessThan(swayAmplitude({ ...base, recoilMoa: 3000, staticMoa: 0 }) * 0.6);
  });
  it('a bow shakes while drawing, settles at full draw and shakes again when held too long', () => {
    const d = (full: boolean, heldFull: number) => swayAmplitude({ ...base, draw: { full, heldFull, holdSteady: 4 } });
    expect(d(false, 0)).toBeGreaterThan(d(true, 1) * 1.5);
    expect(d(true, 6)).toBeGreaterThan(d(true, 1) * 1.5);
  });
  it('holding your breath (timing) cuts it to Breath.MUL', () => {
    expect(swayAmplitude({ ...base, breath: Breath.MUL })).toBeCloseTo(swayAmplitude(base) * Breath.MUL, 5);
  });
});

describe('aim state and ray direction', () => {
  it('aimDirection: no offset is the view; x/y offsets turn right/up by that angle at level pitch', () => {
    expect(aimDirection(0.7, 0.2, 0, 0).yaw).toBeCloseTo(0.7, 9);
    expect(aimDirection(0.7, 0.2, 0, 0).pitch).toBeCloseTo(0.2, 9);
    expect(aimDirection(0.3, 0, 0.05, 0).yaw).toBeCloseTo(0.35, 9);
    expect(aimDirection(0.3, 0, 0, 0.05).pitch).toBeCloseTo(0.05, 9);
    // Looking up, a sideways offset turns the yaw by more (it's a screen angle, not a yaw angle).
    expect(aimDirection(0, 1, 0.05, 0).yaw).toBeGreaterThan(0.05);
  });
  it('offsetToPixels matches the perspective projection', () => {
    const px = offsetToPixels({ x: Math.atan(Math.tan((35 * Math.PI) / 180)), y: 0 }, 70, 1000);
    expect(px.x).toBeCloseTo(500, 6);
    expect(offsetToPixels({ x: 0, y: 0.1 }, 70, 1000).y).toBeLessThan(0);
  });
  it('the shot uses the reticle the HUD drew (fresh), else the simulated one; kicks settle faster with skill', () => {
    const a = new AimSway();
    a.update(1 / 30, 0.02, 0);
    a.markShown(0.011, -0.004, 1000);
    expect(a.shotOffset(1020)).toEqual({ x: 0.011, y: -0.004 });
    expect(a.shotOffset(1200)).toEqual(a.offset(0));
    const lo = new AimSway(), hi = new AimSway();
    for (const s of [lo, hi]) s.kick(600, 0);
    expect(lo.kickY).toBeGreaterThan(0.01);
    for (let i = 0; i < 6; i++) {
      lo.update(1 / 30, 0, 0);
      hi.update(1 / 30, 0, 10);
    }
    expect(hi.kickY).toBeLessThan(lo.kickY * 0.6);
  });
});

describe('where it hit and what that does', () => {
  it('zones by height; NOHEAD monsters have no head', () => {
    const human = { size: 'medium', type: { bodytype: 'human', flags: [] as string[] } };
    expect(defaultHitZone(human, 0.9)).toBe('head');
    expect(defaultHitZone(human, 0.6)).toBe('torso');
    expect(defaultHitZone(human, 0.2)).toBe('legs');
    expect(defaultHitZone({ size: 'medium', type: { bodytype: 'blob', flags: ['NOHEAD'] } }, 0.95)).toBe('torso');
  });
  it('damage multipliers: head ×2, legs ×0.75, graze ×0.5, skill 0 ×0.75 .. 10 ×1.3; the readout names them', () => {
    expect(skillDamageMul(0)).toBeCloseTo(0.75);
    expect(skillDamageMul(10)).toBeCloseTo(1.3);
    const h = hitDamageMul({ zone: 'head', graze: false, weakSpot: false, perfect: false, skill: 5, skillName: 'pistol' });
    expect(h.mul).toBeCloseTo(2 * skillDamageMul(5));
    expect(describeHit(h)).toBe('HEADSHOT ×2');
    const g = hitDamageMul({ zone: 'legs', graze: true, weakSpot: false, perfect: false, skill: 0, skillName: 'pistol' });
    expect(g.mul).toBeCloseTo(0.75 * 0.5 * 0.75);
    expect(describeHit(g)).toBe('legs ×0.75 · graze ×0.5 · pistol skill 0 ×0.75');
    expect(hitDamageMul({ zone: 'head', graze: false, weakSpot: true, perfect: true, skill: 10 }).mul).toBe(3);
    expect(weakSpotChance(10, 12, 12)).toBeGreaterThan(weakSpotChance(0, 8, 8) * 3);
  });
  it('timing windows: breath settles into a perfect moment, then strains and needs recovering; bow and reload bands widen with skill', () => {
    const b = new Breath();
    b.update(0.1, true, 0, 1);
    expect(b.state(0, 1)).toBe('settling');
    b.update(0.3, true, 0, 1);
    expect(b.state(0, 1)).toBe('perfect');
    expect(b.mul(0, 1)).toBeCloseTo(Breath.MUL);
    b.update(3, true, 0, 1);
    expect(b.state(0, 1)).toBe('straining');
    expect(b.mul(0, 1)).toBeGreaterThan(1);
    b.update(0.1, false, 0, 1);
    expect(b.state(0, 1)).toBe('recovering');
    b.update(0.1, true, 0, 1);
    expect(b.held).toBe(0);
    expect(bowWindow(10).width).toBeGreaterThan(bowWindow(0).width);
    expect(bowPerfect(bowWindow(0).delay, 0)).toBe(true);
    expect(bowPerfect(0.1, 0)).toBe(false);
    expect(reloadBand(10).end - reloadBand(10).start).toBeGreaterThan(reloadBand(0).end - reloadBand(0).start);
  });
});

describe('free aim in play: the shot goes where the reticle is', () => {
  it('a skill-0 pistol on the chest at 10 m hits every time (dice would miss often)', () => {
    const { game, sys, combat } = world();
    pistol(game);
    const z = target(sys, game, 10);
    let hits = 0, misses = 0;
    game.events.on('playerAttack', (e) => (e.outcome === 'hit' || e.outcome === 'crit' ? hits++ : e.outcome === 'miss' || e.outcome === 'whiff' ? misses++ : 0));
    for (let i = 0; i < 12; i++) {
      aimAt(game, combat, 10, 1.1);
      combat.cooldown = 0;
      expect(combat.fire()).toBe(true);
      step(game, 0.3);
    }
    expect(z.dead).toBe(false);
    expect(hits).toBe(12);
    expect(misses).toBe(0);
    expect(combat.lastHit?.zone).toBe('torso');
  });

  it('the same pistol under classic dice misses some of those shots', () => {
    setAimModel('dice');
    const { game, sys, combat } = world();
    pistol(game);
    target(sys, game, 10);
    let misses = 0;
    game.events.on('playerAttack', (e) => (e.outcome === 'miss' || e.outcome === 'whiff' ? misses++ : 0));
    for (let i = 0; i < 12; i++) {
      game.player.pitch = Math.atan2(1.1 - 1.6, 10);
      combat.cooldown = 0;
      combat.fire();
      step(game, 0.3);
    }
    expect(misses).toBeGreaterThan(0);
  });

  it('a reticle beside the body misses (and says nothing: you saw it go wide); head and legs zones follow the aim height', () => {
    const { game, sys, combat } = world();
    pistol(game);
    target(sys, game, 8);
    const reasons: (string | undefined)[] = [];
    let hit = 0;
    game.events.on('playerAttack', (e) => (e.outcome === 'whiff' ? reasons.push(e.reason) : hit++));
    aimAt(game, combat, 8, 1.1, 0.07); // ~4° right: 0.56 m off at 8 m
    combat.fire();
    expect(hit).toBe(0);
    expect(reasons).toEqual([undefined]);
    step(game, 0.5);
    aimAt(game, combat, 8, 1.6);
    combat.cooldown = 0;
    combat.fire();
    expect(combat.lastHit?.zone).toBe('head');
    expect(combat.lastHit?.text).toMatch(/HEADSHOT ×2/);
    step(game, 0.5);
    aimAt(game, combat, 8, 0.4);
    combat.cooldown = 0;
    combat.fire();
    expect(combat.lastHit?.zone).toBe('legs');
  });

  it('skill makes the same hits hurt more', () => {
    const avg = (skill: number) => {
      const { game, sys, combat } = world(3);
      game.player.setSkill('pistol', skill);
      game.player.setSkill('gun', skill);
      pistol(game);
      const z = target(sys, game, 6);
      let dealt = 0;
      game.events.on('playerAttack', (e) => (dealt += e.damage));
      for (let i = 0; i < 10; i++) {
        aimAt(game, combat, 6, 1.1);
        combat.cooldown = 0;
        combat.fire();
        step(game, 0.3);
      }
      void z;
      return dealt / 10;
    };
    expect(avg(8)).toBeGreaterThan(avg(0) * 1.3);
  });

  it('recoil kicks the aim up; the reticle ray still decides', () => {
    const { game, sys, combat } = world();
    pistol(game);
    target(sys, game, 10);
    aimAt(game, combat, 10, 1.1);
    const y0 = combat.aim.kickY;
    combat.fire();
    expect(combat.aim.kickY).toBeGreaterThan(y0);
  });

  it('the hit-zone hook can be replaced (real 3D models)', () => {
    const { game, sys, combat } = world();
    pistol(game);
    target(sys, game, 8);
    const prev = aimHooks.hitZone;
    aimHooks.hitZone = () => 'head';
    try {
      aimAt(game, combat, 8, 0.5);
      combat.fire();
      expect(combat.lastHit?.zone).toBe('head');
    } finally {
      aimHooks.hitZone = prev;
    }
  });

  it('an arrow flies along the reticle and strikes by where it arrives, no dodge dice', () => {
    const { game, sys, combat } = world();
    game.player.str_base = 12;
    game.player.resetStats();
    game.player.inv.wear(createItem(data, 'backpack'), null);
    const bow = createItem(data, 'longbow');
    game.player.inv.wield(bow, null);
    game.player.inv.giveNew(createItem(data, 'arrow_wood', { count: 10 }));
    target(sys, game, 12);
    let hits = 0;
    game.events.on('playerAttack', (e) => (e.outcome === 'hit' || e.outcome === 'crit' ? hits++ : 0));
    for (let i = 0; i < 4; i++) {
      combat.cooldown = 0;
      const d = combat.startDraw(bow, 'draw', true)!;
      d.t = d.full;
      aimAt(game, combat, 12, 1.1);
      step(game, 1.2);
    }
    expect(hits).toBe(4);
  });
});

describe('free aim melee: a blow that connects lands', () => {
  it('a hopeless hit roll glances instead of missing, and says so', () => {
    const { game, sys, combat } = world();
    const z = target(sys, game, 1.0);
    game.player.dex_base = 1;
    game.player.resetStats();
    const out: string[] = [];
    game.events.on('playerAttack', (e) => out.push(`${e.outcome}:${e.reason ?? ''}`));
    for (let i = 0; i < 20; i++) combat.melee(z);
    expect(out.some((o) => o.startsWith('miss'))).toBe(false);
    expect(out.some((o) => /glancing ×0\.5/.test(o))).toBe(true);
  });

  it('a dodging monster hops visibly out of the swing at the wind-up (and the whiff says it dodged)', () => {
    const { game, sys, combat } = world();
    const z = sys.spawnById('mon_zombie', game.player.x, game.player.y - 1.0, 0)!;
    z.type = { ...z.type, dodge: 30 };
    z.attackCooldown = 999;
    for (const s of z.specials) s.cooldown = 999;
    const dodges: unknown[] = [];
    game.events.on('monsterDodge', (e) => dodges.push(e.monster));
    const reasons: string[] = [];
    game.events.on('playerAttack', (e) => e.reason && reasons.push(`${e.outcome}:${e.reason}`));
    const before = { x: z.x, y: z.y };
    combat.beginSwing();
    expect(dodges).toEqual([z]);
    expect(z.dashTime).toBeGreaterThan(0);
    step(game, 0.25);
    expect(Math.hypot(z.x - before.x, z.y - before.y), JSON.stringify([before, z.x, z.y])).toBeGreaterThan(0.7);
    step(game, 0.4);
    expect(reasons.some((r) => /^whiff:.*dodged$/.test(r)), JSON.stringify(reasons)).toBe(true);
  });

  it('plain zombies (dodge 0) never dodge', () => {
    const { game, sys, combat } = world();
    target(sys, game, 1.0);
    let n = 0;
    game.events.on('monsterDodge', () => n++);
    for (let i = 0; i < 20; i++) {
      combat.beginSwing();
      step(game, 1.5);
    }
    expect(n).toBe(0);
  });

  it('melee skill widens the parry window in free aim only', () => {
    const { game, combat } = world();
    game.player.setSkill('melee', 10);
    step(game, 0.05);
    const def = defenseOf(game.player);
    expect(def.parryMul).toBeCloseTo(1 + 10 * FEEL.aimParryPerSkill);
    expect(guardScoreBonus({ guarding: true, guardAge: FEEL.parryWindow * 1.2, parryMul: def.parryMul }).parry).toBe(true);
    setAimModel('dice');
    step(game, 0.05);
    expect(def.parryMul).toBe(1);
    void combat;
  });

  it('timing: a click banked just before the swing is ready chains a perfect swing', () => {
    setAimModel('timing');
    const { game, sys, combat, input } = world();
    target(sys, game, 1.0);
    combat.beginSwing();
    // Run until just inside the early window, then click once.
    while (combat.cooldown > 0.08) game.tick(1 / 30);
    input.clicks.push(0);
    game.tick(1 / 30);
    while (!combat.swing || combat.swing.t === 0) {
      game.tick(1 / 30);
      if (combat.cooldown <= 0 && !combat.swing) break;
    }
    expect(combat.swing?.perfect).toBe(true);
  });
});
