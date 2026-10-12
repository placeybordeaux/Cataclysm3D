// Enemy projectiles that behave like the survivor's (docs/COMBAT_FEEL.md, "Enemy arrows, grenades
// and dodging"): NPC and monster arrows fly the survivor's gravity arc, enemy grenades and
// launcher rounds lob and blow up by BN's explosion.cpp rules where they land (blast falloff by
// size, fragments, occlusion, tear gas), the survivor's own new-format explosive ammo goes off, and
// monsters avoid free-aim rounds by BN's deal_projectile_attack dodge.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { GameData } from '../src/data/types';
import type { Input } from '../src/core/input';
import { Game } from '../src/game/game';
import type { Chunk, ChunkGenerator, GameMap } from '../src/world/map';
import { MonsterSystem } from '../src/game/monai';
import { NpcSystem } from '../src/game/npcai';
import type { Npc, NpcData } from '../src/game/npc';
import { PlayerCombat } from '../src/game/playercombat';
import { createItem } from '../src/game/item';
import { setAimModel } from '../src/game/aimmodel';
import { EnemyFire, enemyFireOf, lobOf, lobSpeed, type EnemyRound } from '../src/game/enemyfire';
import { arcHump } from '../src/game/rangedfeel';
import { blastFromJson, blastNoise, critterBlastPct, detonate, ammoBlasts, roundEndsAt, POWER_TO_DMG } from '../src/game/blast';
import { findField } from '../src/game/fields';
import { projectileDodge } from '../src/game/projectile';
import { Rng } from '../src/core/rng';

const dir = path.join(__dirname, '../public/data');
const load = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
let data: GameData;
let nd: NpcData;
beforeAll(() => {
  data = {
    terrain: load('terrain.json'), furniture: load('furniture.json'), items: load('items.json'), itemGroups: load('item_groups.json'),
    monsters: load('monsters.json'), monsterGroups: load('monster_groups.json'), recipes: [], misc: load('misc.json'),
  };
  nd = load('npcs.json');
});
afterEach(() => setAimModel('sway'));

class FlatGen implements ChunkGenerator {
  generate(map: GameMap, c: Chunk): void {
    c.ter.fill(c.z === 0 ? map.terrain.index('t_dirt') : c.z > 0 ? map.terrain.index('t_open_air') : map.terrain.index('t_rock'));
    c.empty = false;
  }
}

function world(seed = 7) {
  const clicks: number[] = [];
  const input = { held: new Set<string>(), captured: false, mouseButtons: 0, clicks, onPress() {}, consumeMouse: () => [0, 0], consumeClicks: () => clicks.splice(0) };
  const game = new Game(data, seed, input as unknown as Input);
  game.map.generator = new FlatGen();
  const p = game.player;
  p.x = 40.5;
  p.y = 40.5;
  for (let y = 0; y <= 4; y++) for (let x = 0; x <= 4; x++) game.map.chunk(x, y, 0);
  const sys = new MonsterSystem(game);
  const combat = new PlayerCombat(game, sys);
  const npcs = new NpcSystem(game, nd, sys);
  (game as unknown as { monsters: MonsterSystem; npcs: NpcSystem }).monsters = sys;
  (game as unknown as { npcs: NpcSystem }).npcs = npcs;
  game.systems.push(sys, combat);
  if (!game.systems.includes(npcs)) game.systems.push(npcs);
  game.clock.seconds = 12 * 3600;
  const msgs: string[] = [];
  game.events.on('message', (m) => msgs.push(m.text));
  return { game, sys, combat, npcs, msgs, fire: enemyFireOf(game) };
}
const step = (game: Game, s: number, until?: () => boolean) => {
  for (let i = 0; i < Math.round(s * 30); i++) {
    game.tick(1 / 30);
    if (until?.()) return true;
  }
  return false;
};
const hpOf = (c: { hp: Record<string, { cur: number }> }) => Object.values(c.hp).reduce((s, h) => s + h.cur, 0);
/** Height of a round over the straight line from its launch to where it was aimed, s m (path) along. */
const overLine = (r: EnemyRound, s: number) => EnemyFire.at(r, s).h - (r.h0 + r.dh * s);

describe('enemy arrows drop like the survivor\'s', () => {
  it('an arc round rises over its aim line, meets it at the aimed distance and falls past it', () => {
    const { game, fire } = world();
    const p = game.player;
    const r = fire.fire({ kind: 'arrow', x: p.x, y: p.y - 20, h: 1.4, tx: p.x, ty: p.y, th: 1.2, yawOff: 0, range: 60, z: 0, from: 'bow', arc: true, speed: 30 });
    expect(r.arc?.aimDist).toBeCloseTo(20, 5);
    expect(overLine(r, 10)).toBeCloseTo(arcHump(10, 20, 30), 3);
    expect(overLine(r, 10)).toBeGreaterThan(0.5); // 9.8/(2·900)·10·10 = 0.54 m
    expect(Math.abs(overLine(r, 20))).toBeLessThan(0.02);
    expect(overLine(r, 26)).toBeLessThan(-0.5);
    const straight = fire.fire({ kind: 'bullet', x: p.x, y: p.y - 20, h: 1.4, tx: p.x, ty: p.y, th: 1.2, yawOff: 0, range: 60, z: 0, from: 'gun' });
    expect(overLine(straight, 10)).toBe(0);
  });

  it('an arc arrow aimed at the survivor still hits (BN odds unchanged); a miss falls to the ground past them', () => {
    const { game, fire } = world();
    const p = game.player;
    let hit = false, ended = '';
    fire.fire({ kind: 'arrow', x: p.x, y: p.y - 18, h: 1.4, tx: p.x, ty: p.y, th: 1.2, yawOff: 0, range: 60, z: 0, from: 'bow', arc: true, speed: 30, onPlayer: () => (hit = true) });
    step(game, 2);
    expect(hit).toBe(true);
    let landed: { x: number; y: number; what: string } | null = null;
    fire.fire({
      kind: 'arrow', x: p.x, y: p.y - 18, h: 1.4, tx: p.x, ty: p.y, th: 1.2, yawOff: Math.atan2(1.5, 18), range: 60, z: 0, from: 'bow', arc: true, speed: 30,
      onPlayer: () => (ended = 'hit'), onEnd: (x, y, _h, what) => (landed = { x, y, what }),
    });
    step(game, 3);
    expect(ended).toBe('');
    expect(landed).not.toBeNull();
    expect(landed!.what).toBe('ground');
    // It came down beyond the survivor (y south), not at 60 m: drop, not a straight line to range.
    expect(landed!.y).toBeGreaterThan(p.y + 1);
    expect(landed!.y).toBeLessThan(p.y + 20);
  });

  it('an NPC archer\'s arrow flies the arc', () => {
    const { game, npcs, fire } = world();
    const p = game.player;
    const n = npcs.spawn({ cls: 'NC_SCAVENGER' }, Math.floor(p.x), Math.floor(p.y) - 14, 0)! as Npc;
    n.x = p.x;
    n.y = p.y - 14;
    if (n.inv.wielded) n.inv.drop(n.inv.wielded);
    n.str_base = 12;
    n.setSkill('archery', 4);
    n.resetStats();
    n.inv.wear(createItem(data, 'backpack'), null);
    n.inv.wield(createItem(data, 'longbow'), null);
    n.inv.giveNew(createItem(data, 'arrow_wood', { count: 20 }));
    n.attitude = 'KILL';
    let seen: EnemyRound | null = null;
    step(game, 15, () => {
      seen = fire.rounds.find((r) => r.from === n) ?? null;
      return !!seen;
    });
    expect(seen).not.toBeNull();
    const r = seen! as EnemyRound;
    expect(r.kind).toBe('arrow');
    expect(r.arc).toBeDefined();
    // NPCs only shoot within their confident range (BN npc::confident_gun_mode_range, npcai.ts),
    // so the archer closes in first: check the hump halfway to wherever it aimed.
    const half = r.arc!.aimDist / 2;
    expect(overLine(r, half)).toBeGreaterThan(0);
    expect(overLine(r, half)).toBeCloseTo(arcHump(half, r.arc!.aimDist, r.speed), 4);
  });

  it('a monster bow (the elf-a\'s longbow) flies the arc too', () => {
    const { game, sys, fire } = world();
    const p = game.player;
    const m = sys.spawnById('mon_mutant_elfa', p.x, p.y - 12, 0)!;
    m.aggroCharacter = true;
    let seen: EnemyRound | null = null;
    step(game, 20, () => {
      seen = fire.rounds.find((r) => r.from === m) ?? null;
      return !!seen;
    });
    expect(seen).not.toBeNull();
    expect((seen! as EnemyRound).kind).toBe('arrow');
    expect((seen! as EnemyRound).arc).toBeDefined();
  });
});

describe('BN explosion data and rules (explosion.cpp)', () => {
  it('reads new and legacy explosion data with BN\'s conversions', () => {
    const hedp = blastFromJson((data.misc as Record<string, Record<string, { explosion?: unknown }>>).ammo_effect.AMMO_M433_HEDP.explosion)!;
    expect(hedp).toMatchObject({ damage: 70, radius: 1, fire: false });
    expect(hedp.fragment).toEqual({ impact: [{ type: 'bullet', amount: 60, armor_penetration: 0, armor_multiplier: 1.6 }], range: 7 });
    // Legacy: damage = power × 2/15; radius = (power × 2/15)^¼ × ln 0.75 / ln factor; shrapnel → bullet ×3 to 2 × radius.
    const old = blastFromJson({ power: 240, distance_factor: 0.75, shrapnel: 1 })!;
    expect(old.damage).toBeCloseTo(240 * POWER_TO_DMG, 6);
    expect(old.radius).toBeCloseTo(Math.pow(32, 0.25), 6);
    expect(old.fragment).toEqual({ impact: [{ type: 'bullet', amount: 32, armor_penetration: 0, armor_multiplier: 3 }], range: Math.trunc(2 * Math.pow(32, 0.25)) });
    expect(blastFromJson({})).toBeNull();
    // A round's blasts: its effects' explosions plus CUSTOM_EXPLOSION's own.
    const table = (data.misc as Record<string, Record<string, { explosion?: unknown }>>).ammo_effect;
    expect(ammoBlasts(table, ['AMMO_M433_HEDP', 'NEVER_MISFIRES'])).toHaveLength(1);
    expect(ammoBlasts(table, ['CUSTOM_EXPLOSION'], { damage: 150, radius: 3 })[0]).toMatchObject({ damage: 150, radius: 3 });
  });

  it('blast falloff and size scaling (critter_blast_percentage), noise bands', () => {
    expect(critterBlastPct('medium', 3, 1)).toBe(1);
    expect(critterBlastPct('medium', 3, 2)).toBe(0.5);
    expect(critterBlastPct('medium', 3, 4)).toBe(0);
    expect(critterBlastPct('huge', 3, 0)).toBe(2);
    expect(critterBlastPct('tiny', 3, 2)).toBe(0.25);
    expect(blastNoise({ damage: 70, radius: 1, fire: false, fragment: { impact: [{ type: 'bullet', amount: 60, armor_penetration: 0, armor_multiplier: 1.6 }], range: 7 } })).toMatchObject({ volume: 160, text: 'an explosion!' });
    expect(blastNoise({ damage: 150, radius: 3, fire: false })).toMatchObject({ volume: 191, text: 'a huge explosion!' });
    expect(blastNoise({ damage: 20, radius: 3, fire: true })).toMatchObject({ volume: 90, text: 'a loud pop!' });
  });

  it('a blast hurts the near zombie fully, the farther one half, nothing past the radius; walls shield', () => {
    const { game, sys } = world();
    const p = game.player;
    p.x = 10.5;
    p.y = 10.5; // well away
    const c = { x: 40, y: 40 };
    const near = sys.spawnById('mon_zombie', c.x + 1.5, c.y + 0.5, 0)!;
    const half = sys.spawnById('mon_zombie', c.x + 0.5, c.y + 2.5, 0)!;
    const out = sys.spawnById('mon_zombie', c.x - 3.5, c.y + 0.5, 0)!;
    const hidden = sys.spawnById('mon_zombie', c.x + 0.5, c.y - 1.5, 0)!;
    game.map.setTer(c.x, c.y - 1, 0, 't_brick_wall');
    for (const m of [near, half, out, hidden]) m.hp = 1000;
    const res = detonate(game, sys, c.x + 0.5, c.y + 0.5, 0, { damage: 40, radius: 3, fire: false });
    const armor = near.type.armor?.bash ?? 0;
    const dealt = (amount: number) => Math.floor(Math.max(0, amount - Math.max(0, armor - 0.4)));
    expect(1000 - near.hp).toBe(dealt(40));
    expect(1000 - half.hp).toBe(dealt(20));
    expect(out.hp).toBe(1000);
    expect(hidden.hp).toBe(1000);
    expect(res.damaged.has(near)).toBe(true);
  });

  it('fragments hit the survivor on every main body part out to their range unless a wall is in the way', () => {
    const { game, sys, msgs } = world();
    const p = game.player;
    const before = hpOf(p);
    const frag = { damage: 0, radius: 0, fire: false, fragment: { impact: [{ type: 'bullet', amount: 6, armor_penetration: 0, armor_multiplier: 1 }], range: 7 } };
    const hurt: number[] = [];
    game.events.on('playerHurt', (e) => hurt.push(e.amount));
    detonate(game, sys, p.x, p.y - 5, 0, frag);
    expect(before - hpOf(p)).toBe(36);
    expect(hurt).toEqual([36]);
    expect(msgs.some((m) => m.includes('shrapnel'))).toBe(true);
    const mid = hpOf(p);
    for (let dx = -2; dx <= 2; dx++) game.map.setTer(Math.floor(p.x) + dx, Math.floor(p.y) - 2, 0, 't_brick_wall');
    detonate(game, sys, p.x, p.y - 5, 0, frag);
    expect(hpOf(p)).toBe(mid);
    // Out of range: nothing.
    detonate(game, sys, p.x + 9, p.y, 0, frag);
    expect(hpOf(p)).toBe(mid);
  });

  it('the survivor in a blast takes it on six parts at BN\'s per-part bands', () => {
    const { game, sys, msgs } = world();
    const p = game.player;
    const before = hpOf(p);
    detonate(game, sys, p.x, p.y, 0, { damage: 20, radius: 2, fire: false });
    const lost = before - hpOf(p);
    // torso/head rng(10, 20) each, limbs rng(15, 25) each, unarmored.
    expect(lost).toBeGreaterThanOrEqual(10 + 10 + 4 * 15);
    expect(lost).toBeLessThanOrEqual(20 + 20 + 4 * 25);
    expect(msgs).toContain("You're caught in the explosion!");
  });
});

describe('enemy grenades lob and blow up', () => {
  it('lobOf: thrown and grenade-launcher rounds lob; rockets and tank guns fly straight', () => {
    const it = data.items as Record<string, Record<string, unknown>>;
    expect(lobOf(it.zombie_swat_thrown_teargas, it['40x46mm_m651'], 'sling')).toBe('thrown');
    expect(lobOf(it.feral_pa_boss_grenade, it['40x46mm_m433'], 'launcher')).toBe('launched');
    expect(lobOf(it.m202_flash, it.m235tpa, 'launcher')).toBeNull();
    expect(lobOf(it.tank_gun_auto_monster, it['120mm_usable_heat'], 'launcher')).toBeNull();
    expect(lobOf(it.longbow, it.arrow_wood, 'bow')).toBeNull();
    // A thrown grenade at 8 m hangs about a second, its apex over a metre above the line.
    const v = lobSpeed('thrown', 8);
    expect(8 / v).toBeGreaterThan(0.9);
    expect(arcHump(4, 8, v)).toBeGreaterThan(1);
  });

  it("the feral bio-operator's grenade launcher lobs an HEDP round that explodes with fragments", () => {
    const { game, sys, fire } = world(3);
    const p = game.player;
    p.hp.torso.max = p.hp.torso.cur = 10000; // survive to be measured
    const boss = sys.spawnById('mon_feral_pa_boss_grenade', p.x, p.y - 12, 0)!;
    boss.aggroCharacter = true;
    const blasts: { x: number; y: number }[] = [];
    game.events.on('explosion', (e) => blasts.push(e));
    let round: EnemyRound | null = null;
    step(game, 20, () => {
      // Hold it at 12 m (it walks in while its launcher's 40-turn cooldown runs).
      boss.x = p.x;
      boss.y = p.y - 12;
      round = fire.rounds.find((r) => r.from === boss) ?? null;
      return !!round;
    });
    expect(round).not.toBeNull();
    const r = round! as EnemyRound;
    expect(r.kind).toBe('grenade');
    expect(r.arc).toBeDefined();
    expect(overLine(r, 6)).toBeGreaterThan(0.5);
    const before = hpOf(p);
    step(game, 4, () => blasts.length > 0);
    expect(blasts.length).toBe(1);
    // Wherever it came down, it was within the fragments' 7 tiles of the survivor (it was aimed at them).
    expect(Math.hypot(blasts[0].x - p.x, blasts[0].y - p.y)).toBeLessThan(8);
    expect(hpOf(p)).toBeLessThan(before);
  });

  it("a SWAT zombie's thrown tear gas grenade lands in a cloud of tear gas", () => {
    const { game, sys, fire } = world(5);
    const p = game.player;
    const z = sys.spawnById('mon_zombie_swat_boss', p.x, p.y - 6, 0)!;
    z.aggroCharacter = true;
    let round: EnemyRound | null = null;
    step(game, 30, () => {
      round = fire.rounds.find((r) => r.from === z) ?? null;
      return !!round;
    });
    expect(round).not.toBeNull();
    expect((round! as EnemyRound).kind).toBe('grenade');
    let end: { x: number; y: number } | null = null;
    const onEnd = (round! as EnemyRound).onEnd!;
    (round! as EnemyRound).onEnd = (x, y, h, what, z) => {
      end = { x, y };
      onEnd(x, y, h, what, z);
    };
    step(game, 3, () => !!end);
    expect(end).not.toBeNull();
    expect(findField(game, Math.floor(end!.x), Math.floor(end!.y), 0, 'fd_tear_gas')).toBeTruthy();
  });

  it('roundEndsAt: incendiary rockets (PYROPHORIC) blast and spread fire fields', () => {
    const { game, sys } = world();
    const blasts: unknown[] = [];
    game.events.on('explosion', (e) => blasts.push(e));
    const n = roundEndsAt(game, sys, 30.5, 30.5, 0, (data.items as Record<string, object>).m235tpa, [], null);
    expect(n).toBe(1);
    expect(blasts).toHaveLength(1);
    let fires = 0;
    for (let dy = -7; dy <= 7; dy++) for (let dx = -7; dx <= 7; dx++) if (findField(game, 30 + dx, 30 + dy, 0, 'fd_incendiary')) fires++;
    expect(fires).toBeGreaterThan(20);
  });
});

describe("the survivor's own explosive ammo", () => {
  it('new-format ammo effect explosions (40 mm HEDP) reach the blast hook', () => {
    const { combat } = world();
    const calls: unknown[] = [];
    combat.hooks = { blast: (_x, _y, _z, e) => calls.push(e) };
    combat.ammoEffectsAt({ ammoEffects: ['AMMO_M433_HEDP', 'NEVER_MISFIRES'] } as never, 30.5, 30.5, null, 0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ damage: 70, radius: 1 });
  });
});

describe('monsters dodge free-aim rounds by BN\'s rule', () => {
  it('projectileDodge: dodge×5 over dice(10, speed), dropped under 0.01', () => {
    const rng = new Rng(1);
    let bulletAdds = 0, arrowAdds = 0;
    for (let i = 0; i < 500; i++) {
      bulletAdds += projectileDodge(50, 1000, rng);
      arrowAdds += projectileDodge(50, 100, rng);
    }
    // 50 / ~5005 ≈ 0.01 for bullets (about half the rolls fall under the 0.01 floor); 50 / ~505 ≈ 0.1 for arrows.
    expect(bulletAdds / 500).toBeLessThan(0.012);
    expect(arrowAdds / 500).toBeGreaterThan(0.07);
    expect(arrowAdds / 500).toBeLessThan(0.15);
    expect(projectileDodge(0, 100, rng)).toBe(0);
  });

  it('a nimble monster avoids an arrow at the edge of its body, never a bullet; a zombie never', () => {
    const { game, sys, combat, msgs } = world();
    const p = game.player;
    const elf = sys.spawnById('mon_mutant_elfa', p.x, p.y - 10, 0)!;
    const zed = sys.spawnById('mon_zombie', p.x + 3, p.y - 10, 0)!;
    const dodge = (m: unknown, mb: number, speed: number) => (combat as unknown as { freeDodge(m: unknown, mb: number, s: number, f: { x: number; y: number }): number | null }).freeDodge(m, mb, speed, p);
    let arrowAvoided = 0, bulletAvoided = 0, centreAvoided = 0;
    for (let i = 0; i < 200; i++) {
      elf.dashTime = 0;
      if (dodge(elf, 0.95, 100) === null) arrowAvoided++;
      if (dodge(elf, 0.95, 1000) === null) bulletAvoided++;
      if (dodge(elf, 0.2, 100) === null) centreAvoided++;
    }
    expect(arrowAvoided).toBeGreaterThan(100);
    expect(bulletAvoided).toBe(0);
    expect(centreAvoided).toBe(0);
    expect(msgs.some((m) => m.endsWith('avoids your projectile!'))).toBe(true);
    for (let i = 0; i < 50; i++) expect(dodge(zed, 0.99, 100)).toBe(0.99);
    // Something that sways aside visibly.
    let dodged = 0;
    game.events.on('monsterDodge', () => dodged++);
    elf.dashTime = 0;
    for (let i = 0; i < 20 && dodged === 0; i++) {
      elf.dashTime = 0;
      dodge(elf, 0.99, 100);
    }
    expect(dodged).toBeGreaterThan(0);
  });
});
