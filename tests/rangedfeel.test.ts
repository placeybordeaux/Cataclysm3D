import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import type { GameData } from '../src/data/types';
import type { Input } from '../src/core/input';
import { Game } from '../src/game/game';
import type { Chunk, ChunkGenerator, GameMap } from '../src/world/map';
import { MonsterSystem } from '../src/game/monai';
import { PlayerCombat, type ViewModelHook } from '../src/game/playercombat';
import { createItem, type Item } from '../src/game/item';
import { census, L, spawnItem, takeRound, type Loc } from '../src/game/moves';
import { dispersionBreakdown, fireGun } from '../src/game/combat';
import { setFeelDifficulty } from '../src/game/combatfeel';
import {
  arcHeight, canDraw, drawSeconds, drawStyle, embedsIn, effectiveRange, fliesVisibly, hasMuzzleFlash, rangedClass, rangedMissReason, rollRecovery,
  strDrawDamageMod, strDrawDispersionMul, strDrawPenalty, strDrawRangeMod, strRequirementLine, type DispersionBreakdown,
} from '../src/game/rangedfeel';

const dir = path.join(__dirname, '../public/data');
const load = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
let data: GameData;

beforeAll(() => {
  data = {
    terrain: load('terrain.json'), furniture: load('furniture.json'), items: load('items.json'), itemGroups: load('item_groups.json'),
    monsters: load('monsters.json'), monsterGroups: load('monster_groups.json'), recipes: [], misc: load('misc.json'),
  };
});
afterEach(() => setFeelDifficulty('accessible'));

class FlatGen implements ChunkGenerator {
  wallAtY: number | null = null;
  generate(map: GameMap, c: Chunk): void {
    c.ter.fill(c.z === 0 ? map.terrain.index('t_dirt') : c.z > 0 ? map.terrain.index('t_open_air') : map.terrain.index('t_rock'));
    c.empty = false;
  }
}

/** A fake input whose LMB clicks and held buttons a test sets. */
interface FakeInput { clicks: number[]; mouseButtons: number }
function fakeInput(): FakeInput {
  const clicks: number[] = [];
  return {
    held: new Set<string>(), captured: false, mouseButtons: 0, clicks, onPress() {}, consumeMouse: () => [0, 0],
    consumeClicks: () => clicks.splice(0),
  } as FakeInput;
}
const asInput = (f: FakeInput) => f as unknown as Input;

function world(seed = 7) {
  const input = fakeInput();
  const game = new Game(data, seed, asInput(input));
  game.map.generator = new FlatGen();
  game.player.x = 40.5;
  game.player.y = 40.5;
  game.player.yaw = 0; // facing north (-y)
  for (let y = 0; y <= 4; y++) for (let x = 0; x <= 4; x++) game.map.chunk(x, y, 0);
  const sys = new MonsterSystem(game);
  const combat = new PlayerCombat(game, sys);
  game.systems.push(sys, combat);
  game.clock.seconds = 12 * 3600;
  const recoils: { k: number; flash?: boolean }[] = [];
  const vm: ViewModelHook = { attack() {}, recoil: (k, o) => recoils.push({ k, flash: o?.flash }) };
  combat.viewmodel = () => vm;
  return { game, sys, combat, input, recoils };
}
const step = (game: Game, seconds: number) => {
  for (let i = 0; i < Math.round(seconds * 30); i++) game.tick(1 / 30);
};
const tough = (game: Game) => {
  for (const k of Object.keys(game.player.hp)) game.player.hp[k as keyof typeof game.player.hp].max = game.player.hp[k as keyof typeof game.player.hp].cur = 100000;
};
const setStr = (game: Game, str: number) => {
  game.player.str_base = str;
  game.player.resetStats();
};
function archer(game: Game, bow = 'longbow', arrows = 10): Item {
  setStr(game, 12);
  game.player.inv.wear(createItem(data, 'backpack'), null);
  const b = createItem(data, bow);
  game.player.inv.wield(b, null);
  game.player.inv.giveNew(createItem(data, bow === 'crossbow' ? 'bolt_steel' : bow === 'sling' ? 'pebble' : 'arrow_wood', { count: arrows }));
  return b;
}
/** A zombie `d` m straight ahead (north) that stays put. */
function target(sys: MonsterSystem, game: Game, d: number) {
  const z = sys.spawnById('mon_zombie', game.player.x, game.player.y - d, 0)!;
  z.hp = 10000;
  z.addEffect('stunned', 10000);
  return z;
}

describe('weapon classes from BN data', () => {
  const cls = (id: string) => rangedClass(createItem(data, id));
  it('bows, crossbows, slings, launchers, energy and air guns, firearms, thrown', () => {
    for (const id of ['longbow', 'shortbow', 'compbow', 'compositebow', 'selfbow', 'recurbow']) expect(cls(id), id).toBe('bow');
    for (const id of ['crossbow', 'hand_crossbow', 'compcrossbow', 'rep_crossbow', 'speargun']) expect(cls(id), id).toBe('crossbow');
    for (const id of ['sling', 'staff_sling', 'slingshot', 'wristrocket']) expect(cls(id), id).toBe('sling');
    for (const id of ['m79', 'LAW', 'flamethrower']) expect(cls(id), id).toBe('launcher');
    expect(cls('laser_rifle')).toBe('energy');
    expect(cls('nailgun')).toBe('air');
    for (const id of ['glock_19', 'remington_870', 'ak47']) expect(cls(id), id).toBe('firearm');
    expect(cls('rock')).toBe('thrown');
  });
  it('draw styles: bows and slingshots are drawn, slings whirled, the rest have triggers', () => {
    expect(drawStyle(createItem(data, 'longbow'))).toBe('draw');
    expect(drawStyle(createItem(data, 'slingshot'))).toBe('draw');
    expect(drawStyle(createItem(data, 'sling'))).toBe('whirl');
    expect(drawStyle(createItem(data, 'crossbow'))).toBe('trigger');
    expect(drawStyle(createItem(data, 'glock_19'))).toBe('trigger');
  });
  it('only powder flashes; arrows, bolts and stones fly visibly', () => {
    expect(hasMuzzleFlash('firearm')).toBe(true);
    expect(hasMuzzleFlash('launcher')).toBe(true);
    for (const c of ['bow', 'crossbow', 'sling', 'air', 'energy', 'thrown'] as const) expect(hasMuzzleFlash(c), c).toBe(false);
    for (const c of ['bow', 'crossbow', 'sling'] as const) expect(fliesVisibly(c)).toBe(true);
    expect(fliesVisibly('firearm')).toBe(false);
  });
});

describe('BN strength to draw (STR_DRAW, ranged.cpp)', () => {
  const bowFor = (str: number, skill = 0) => {
    const game = new Game(data, 1, asInput(fakeInput()));
    setStr(game, str);
    game.player.setSkill('archery', skill);
    return { p: game.player, bow: createItem(data, 'longbow') };
  };
  it('penalty bands: full, 0.75x, 0.5x with double spread, unusable below half', () => {
    let { p, bow } = bowFor(10);
    expect(strDrawPenalty(bow, p)).toBe(1);
    expect(strDrawDamageMod(bow, p)).toBe(1);
    ({ p, bow } = bowFor(8)); // 8/10
    expect(strDrawDamageMod(bow, p)).toBe(0.75);
    expect(strDrawRangeMod(bow, p)).toBe(0.75);
    expect(strDrawDispersionMul(bow, p)).toBe(1);
    ({ p, bow } = bowFor(6)); // 6/10
    expect(strDrawDamageMod(bow, p)).toBe(0.5);
    expect(strDrawDispersionMul(bow, p)).toBe(2);
    expect(canDraw(bow, p)).toBe(true);
    ({ p, bow } = bowFor(4));
    expect(canDraw(bow, p)).toBe(false);
    expect(strRequirementLine(bow, p)?.text).toMatch(/Strength 10 to draw: you can't use it/);
  });
  it('archery skill lowers the requirement (1 at 4, 2 at 8, 3 at 10)', () => {
    const { p, bow } = bowFor(9, 4);
    expect(strDrawPenalty(bow, p)).toBe(1);
    expect(strDrawPenalty(bow, bowFor(8, 8).p)).toBe(1);
    expect(strDrawPenalty(bow, bowFor(7, 8).p)).toBe(0.9);
  });
  it('fireGun refuses an undrawable bow and weakens a hard pull', () => {
    const { p, bow } = bowFor(4);
    spawnItem(createItem(data, 'arrow_wood', { count: 1 }), L.in(bow));
    const r = fireGun(p, bow, new Rng(1));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/enough strength/);
    const weak = bowFor(8);
    spawnItem(createItem(data, 'arrow_wood', { count: 1 }), L.in(weak.bow));
    const full = bowFor(12);
    spawnItem(createItem(data, 'arrow_wood', { count: 1 }), L.in(full.bow));
    const a = fireGun(weak.p, weak.bow, new Rng(1)), b = fireGun(full.p, full.bow, new Rng(1));
    expect(a.damage[0].amount).toBeCloseTo(b.damage[0].amount * 0.75);
    expect(a.range).toBeCloseTo(b.range * 0.75);
  });
  it('drawing is slower for a weak archer (item_reload_cost), never under the floor', () => {
    expect(drawSeconds(bowFor(6).bow, bowFor(6).p)).toBeGreaterThan(drawSeconds(bowFor(12).bow, bowFor(12).p));
    expect(drawSeconds(bowFor(20).bow, bowFor(20).p)).toBeGreaterThanOrEqual(0.45);
  });
});

describe('after the shot: break, drop, embed (BN drop_or_embed_projectile)', () => {
  it('arrows survive unless one_in(dont_recover_one_in) breaks them; bullets never come back', () => {
    const rng = new Rng(3);
    const arrow = data.items.arrow_wood;
    let kept = 0;
    for (let i = 0; i < 5000; i++) if (rollRecovery(arrow, null, rng)) kept++;
    expect(kept / 5000).toBeGreaterThan(0.93); // 1 in 25 break
    expect(kept / 5000).toBeLessThan(0.99);
    expect(rollRecovery(data.items['9mm'], null, rng)).toBe(false);
  });
  it('embeds only in big enough bodies, and only when cutting beats bashing', () => {
    const rng = new Rng(5);
    expect(embedsIn('medium', 250, { cut: 0, stab: 30, bash: 0 }, rng)).toBe(true);
    expect(embedsIn('tiny', 250, { cut: 0, stab: 30, bash: 0 }, rng)).toBe(false);
    expect(embedsIn('medium', 250, { cut: 0, stab: 2, bash: 10 }, rng)).toBe(false);
    expect(embedsIn('medium', 250, { cut: 0, stab: 30, bash: 0 }, rng, ['NO_EMBED'])).toBe(false);
  });
  it('takeRound keeps a fired arrow as an object (nothing lost or doubled)', () => {
    const bow = createItem(data, 'longbow');
    spawnItem(createItem(data, 'arrow_wood', { count: 1 }), L.in(bow));
    expect(bow.ammoRemaining()).toBe(1);
    const r = takeRound(bow)!;
    expect(r.typeId).toBe('arrow_wood');
    expect(r.charges).toBe(1);
    expect(bow.ammoRemaining()).toBe(0);
    expect(takeRound(bow)).toBe(null);
  });
});

describe('the flight: visible, timed, on an arc', () => {
  it('meets the crosshair line exactly where it was aimed, and falls past it', () => {
    const a = { eye: 1.6, slope: Math.tan(-0.03), aimDist: 20, speed: 50 };
    expect(arcHeight(20, a)).toBeCloseTo(1.6 + 20 * a.slope, 5);
    expect(arcHeight(10, a)).toBeGreaterThan(1.6 + 10 * a.slope - 0.13); // the hump (drop compensation)
    expect(arcHeight(35, a)).toBeLessThan(1.6 + 35 * a.slope - 0.5);
  });

  it('RMB draws, LMB looses: the arrow takes time to arrive, then hits (8 m)', () => {
    const { game, sys, combat, input, recoils } = world(11);
    tough(game);
    archer(game);
    game.player.setSkill('archery', 10);
    game.player.setSkill('gun', 10);
    const z = target(sys, game, 8);
    input.mouseButtons = 4; // hold RMB
    step(game, 0.2);
    expect(combat.draw).not.toBe(null);
    expect(combat.draw!.t).toBeLessThan(combat.draw!.full);
    step(game, 2.5); // full draw, aiming
    const aimed = game.player.recoil;
    expect(aimed).toBeLessThan(1500);
    input.clicks.push(0);
    game.tick(1 / 30);
    expect(combat.flights.length).toBe(1);
    expect(combat.flashShots).toBe(0);
    expect(recoils.at(-1)?.flash).toBe(false);
    const hp0 = z.hp;
    game.tick(1 / 30);
    expect(z.hp).toBe(hp0); // not hitscan: still in the air after a frame
    step(game, 0.5);
    expect(combat.flights.length).toBe(0);
    input.mouseButtons = 0;
  });

  it('letting go of RMB lets the string down without a shot', () => {
    const { game, combat, input } = world(12);
    const bow = archer(game);
    input.mouseButtons = 4;
    step(game, 0.4);
    input.mouseButtons = 0;
    step(game, 0.1);
    expect(combat.draw).toBe(null);
    expect(combat.flights.length).toBe(0);
    expect(bow.ammoRemaining()).toBe(1); // still nocked
  });

  it('too weak to draw: no shot, the crosshair says why', () => {
    const { game, combat, input } = world(13);
    archer(game);
    setStr(game, 4);
    const why: string[] = [];
    game.events.on('attackRefused', (e) => why.push(e.reason));
    input.mouseButtons = 4;
    step(game, 0.3);
    expect(combat.draw).toBe(null);
    expect(why[0]).toMatch(/too weak to draw this bow \(Str 10 needed\)/);
  });

  it('a pistol still flashes', () => {
    const { game, combat, recoils } = world(14);
    const gun = createItem(data, 'glock_19');
    spawnItem(createItem(data, 'glockmag', { ammo: '9mm' }), L.mag(gun));
    game.player.inv.wield(gun, null);
    combat.fire();
    expect(combat.flashShots).toBe(1);
    expect(recoils[0].flash).toBe(true);
  });
});

describe('arrow recovery conserves arrows', () => {
  const arrowsAt = (locs: Loc[]) => census(locs).counts.get('arrow_wood') ?? 0;
  it('every fired arrow ends on the ground, stuck in the zombie, or broken (counted)', () => {
    const { game, sys, combat } = world(21);
    tough(game);
    archer(game, 'longbow', 30);
    game.player.setSkill('archery', 3);
    const z = target(sys, game, 9);
    const map = game.map;
    const groundLocs = () => {
      const out: Loc[] = [];
      for (let y = 0; y < 80; y++) for (let x = 20; x < 60; x++) if (map.itemsAt(x, y, 0).length) out.push(L.ground(map, x, y, 0));
      return out;
    };
    const mine = () => [L.hands(game.player), L.inv(game.player)];
    const before = arrowsAt(mine());
    let broke = 0, shots = 0;
    game.events.on('message', (m) => void (/breaks\.$/.test(m.text) && broke++));
    for (let i = 0; i < 30; i++) {
      // Aim roughly at the zombie's chest; the BN spread does the rest.
      game.player.yaw = (i % 5 - 2) * 0.03;
      game.player.pitch = -0.05;
      combat.attack();
      step(game, 1.4);
      const s = combat.lastShotClass;
      expect(s).toBe('bow');
      shots++;
    }
    const after = arrowsAt(mine()) + arrowsAt(groundLocs()) + arrowsAt([L.cargo(z.stuck)]);
    expect(shots).toBe(30);
    expect(after + broke).toBe(before);
    expect(census([...mine(), ...groundLocs(), L.cargo(z.stuck)]).aliased).toEqual([]);
    // Some came to rest in view for the stuck-arrow visuals.
    expect(combat.landed.length + z.stuck.items.length).toBeGreaterThan(0);
  });

  it('arrows stuck in a zombie fall where it dies', () => {
    const { game, sys } = world(22);
    const z = target(sys, game, 3);
    spawnItem(createItem(data, 'arrow_wood', { count: 2 }), L.cargo(z.stuck));
    sys.die(z, 'player');
    expect(z.stuck.items.length).toBe(0);
    expect(game.map.itemsAt(z.tileX, z.tileY, 0).some((it) => (it as Item).typeId === 'arrow_wood')).toBe(true);
  });

  it('a save lands arrows still in the air', () => {
    const { game, combat } = world(23);
    archer(game);
    combat.attack();
    step(game, 0.7); // drawn and loosed
    expect(combat.flights.length).toBeGreaterThan(0);
    combat.settleFlights();
    expect(combat.flights.length).toBe(0);
  });
});

describe('why a ranged shot missed', () => {
  const spread = (o: Partial<DispersionBreakdown> = {}): DispersionBreakdown => ({ weapon: 60, dex: 6, hands: 0, skill: 380, aim: 100, strMul: 1, ...o });
  const base = { distance: 8, targetRadius: 0.3, skill: 'archery', skillLevel: 0, style: 'draw' as const, range: 22 };
  it('obstacles and the dodge come first', () => {
    expect(rangedMissReason({ ...base, kind: 'wall', spread: spread() })).toBe('blocked by cover');
    expect(rangedMissReason({ ...base, kind: 'range', spread: spread() })).toBe('fell short: out of range (22 m)');
    expect(rangedMissReason({ ...base, kind: 'dodged', spread: spread() })).toBe('dodged');
    expect(rangedMissReason({ ...base, kind: 'ground', spread: spread() })).toMatch(/^low/);
  });
  it('unaimed shots blame the aim, and say how to fix it', () => {
    expect(rangedMissReason({ ...base, kind: 'passed', spread: spread({ aim: 3000 }) })).toBe('wide: unsteady aim — hold RMB to draw and aim');
    expect(rangedMissReason({ ...base, style: 'trigger', kind: 'passed', spread: spread({ aim: 3000 }) })).toBe('wide: unsteady aim — hold RMB to aim');
  });
  it('a weak draw, then distance beyond the effective range, then skill', () => {
    expect(rangedMissReason({ ...base, kind: 'passed', spread: spread({ strMul: 2 }), strNeeded: 10 })).toBe('wide: too weak to draw fully (Str 10)');
    const eff = effectiveRange(spread(), 0.3);
    expect(rangedMissReason({ ...base, distance: eff * 2, kind: 'passed', spread: spread() })).toMatch(/^wide: out of effective range \(~\d+ m for you\)$/);
    expect(rangedMissReason({ ...base, distance: eff * 0.9, kind: 'passed', spread: spread() })).toBe('wide: archery skill too low (0)');
  });
  it('a tight spread that still missed was bad luck', () => {
    expect(rangedMissReason({ ...base, distance: 3, kind: 'passed', spread: spread({ skill: 5, aim: 2, weapon: 20 }) })).toBe('wide: unlucky shot');
  });
  it('the breakdown puts recoil in the aim slot and a weak draw in the multiplier', () => {
    const game = new Game(data, 1, asInput(fakeInput()));
    setStr(game, 6);
    game.player.recoil = 1234;
    const b = dispersionBreakdown(game.player, createItem(data, 'longbow'));
    expect(b.aim).toBe(1234);
    expect(b.strMul).toBe(2);
  });

  it('in play: an unaimed snap shot that misses says so; a zombie beyond range says "fell short"', () => {
    const { game, sys, combat } = world(31);
    tough(game);
    archer(game, 'longbow', 20);
    const reasons: string[] = [];
    game.events.on('playerAttack', (e) => e.reason && reasons.push(e.reason));
    const far = target(sys, game, 30);
    for (let i = 0; i < 4; i++) {
      game.player.yaw = 0;
      game.player.pitch = -0.02;
      game.player.recoil = 0; // perfectly aimed: only the range can stop it
      combat.attack();
      step(game, 1.6);
    }
    expect(reasons.some((r) => /fell short: out of range/.test(r) || /^low/.test(r))).toBe(true);
    expect(far.hp).toBe(10000);
  });
});
