// One BN explosion for everything (src/game/blast.ts; docs/COMBAT_FEEL.md "Blasts", docs/VEHICLES.md
// "Blasts and vehicles"): every caller goes through detonate, blasts and fragments damage vehicle
// parts by vehicle::damage (armour, thresholds, fuel tanks), occupants are shielded by the closed
// doors and boards around them until the blast breaks them, creatures are flung, blasts of radius
// 4+ reach the next level, the free-aim ray stops at vehicles (a HEAT round meets the car it was
// aimed at), and lobbed rounds stay under ceilings (or meet them) and fly over roofs.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import type { GameData } from '../src/data/types';
import { Game } from '../src/game/game';
import { chassisBodyRect } from '../src/game/chassis';
import { has, turretGun, type Vehicle, type VehiclePart } from '../src/game/vehicle';
import type { VehicleDataFile } from '../src/game/vehicle_data';
import { VehicleSystem } from '../src/game/vehicles';
import { stationsOf } from '../src/game/vehwalk';
import { MonsterSystem } from '../src/game/monai';
import { PlayerCombat } from '../src/game/playercombat';
import { createItem, loadAmmo } from '../src/game/item';
import { setAimModel } from '../src/game/aimmodel';
import { installTurrets } from '../src/turrets';
import { BASIC_EXPLOSION, setTrap, triggerTrap } from '../src/game/traps';
import {
  blastFromJson, blastOccluded, bnLine, detonate, flingPath, flingVelocity, legacyBlast, multibashForces, type BlastData,
} from '../src/game/blast';
import { damageDirect, damageVehicleMount, type FuelBlast } from '../src/game/vehicleDamage';
import { ArmedExplosives } from '../src/game/armed';
import { ceilingSpeed, enemyFireOf, lobSpeed, type EnemyRound } from '../src/game/enemyfire';
import { LEVEL_HEIGHT } from '../src/world/coords';
import type { Chunk, ChunkGenerator, GameMap } from '../src/world/map';
import { loadNodeData } from '../tools/lib/node_data';

let data: GameData;
let vdata: VehicleDataFile;
beforeAll(() => {
  data = loadNodeData().game;
  vdata = JSON.parse(readFileSync(resolve('public/data/vehicles.json'), 'utf8'));
});

class FlatGen implements ChunkGenerator {
  generate(map: GameMap, chunk: Chunk): void {
    chunk.ter.fill(map.terrain.index(chunk.z === 0 ? 't_pavement' : chunk.z > 0 ? 't_open_air' : 't_rock'));
    chunk.empty = false;
  }
}

function world(seed = 5) {
  setAimModel('sway');
  const input = { held: new Set<string>(), captured: false, mouseButtons: 0, lastEscape: -1, onPress() {}, consumeMouse: () => [0, 0], consumeClicks: () => [] } as any;
  const game = new Game(data, seed, input);
  game.map.generator = new FlatGen();
  for (let z = 0; z <= 1; z++) for (let y = -1; y <= 6; y++) for (let x = -1; x <= 6; x++) game.map.chunk(x, y, z);
  const vs = new VehicleSystem(game, vdata);
  game.vehicles = vs;
  game.systems.push(vs);
  vs.bodyShape = chassisBodyRect;
  vs.scriptedInput = true;
  const sys = new MonsterSystem(game);
  (game as unknown as { monsters: MonsterSystem }).monsters = sys;
  const combat = new PlayerCombat(game, sys);
  game.systems.push(sys, combat);
  combat.hooks.blast = (x, y, z, e) => void detonate(game, sys, x, y, z, blastFromJson(e)!, 'player');
  const log: string[] = [];
  game.events.on('message', (m) => log.push(m.text));
  const blasts: { x: number; y: number; z: number; radius: number }[] = [];
  game.events.on('explosion', (e) => blasts.push(e));
  const p = game.player;
  p.x = 20.5;
  p.y = 20.5;
  for (const k of Object.keys(p.hp)) p.hp[k as keyof typeof p.hp].max = p.hp[k as keyof typeof p.hp].cur = 100000;
  return { game, vs, sys, combat, log, blasts };
}

const ITEMS = () => data.items as unknown as Record<string, { explosion?: unknown; use_action?: unknown }>;
/** The 120 mm HEAT round's own blast (CUSTOM_EXPLOSION): 150 at the centre, radius 3. */
const heat = (): BlastData => blastFromJson(ITEMS()['120mm_usable_heat'].explosion)!;
/** BN's hand grenade (grenade_act's explosion use_action): 70 / r 2, 60 bullet ×1.8 fragments to 7. */
const grenade = (): BlastData => blastFromJson((ITEMS().grenade_act.use_action as { explosion: unknown }).explosion)!;
const hpSum = (v: Vehicle) => v.parts.reduce((s, p) => s + Math.max(0, p.hp), 0);
const partsAtMount = (v: Vehicle, mx: number, my: number) => v.partsAt(mx, my);
/** World tile centre of a vehicle mount. */
const tileOf = (v: Vehicle, mx: number, my: number) => {
  const [x, y] = v.mountToWorld(mx, my);
  return { x: Math.floor(x), y: Math.floor(y) };
};
const playerHp = (g: Game) => Object.values(g.player.hp).reduce((s, h) => s + h.cur, 0);

/** A plain car facing east at (40, 40): mount +x is world +x (east), +y is south. */
function car(vs: VehicleSystem, x = 40, y = 40): Vehicle {
  const v = vs.spawn('car', x, y, 0, 0, { fuel: 100, status: 2, rng: new Rng(4), force: true })!;
  v.locked = false;
  for (const p of v.parts) if (has(p, 'OPENABLE')) p.open = false;
  v.version++;
  return v;
}

describe('one explosion implementation (BN explosion.cpp)', () => {
  it('the HEAT round, the grenade and the 40 mm HEDP load as BN data', () => {
    expect(heat()).toMatchObject({ damage: 150, radius: 3, fire: false });
    expect(grenade()).toMatchObject({ damage: 70, radius: 2 });
    expect(grenade().fragment).toMatchObject({ range: 7, impact: [{ type: 'bullet', amount: 60, armor_multiplier: 1.8 }] });
    // Legacy power: damage = trunc(power × 2/15), radius = (trunc(power) × 2/15)^¼ × ln 0.75 / ln factor.
    const legacy = legacyBlast(225);
    expect(legacy.damage).toBe(30);
    expect(legacy.radius).toBeCloseTo(Math.pow(30, 0.25) * (Math.log(0.75) / Math.log(0.8)), 6);
  });

  it('the survivor\'s ammo explosions and CUSTOM_EXPLOSION rounds all reach the one blast hook', () => {
    const { combat } = world();
    const calls: unknown[] = [];
    combat.hooks = { blast: (_x, _y, _z, e) => calls.push(e) };
    combat.ammoEffectsAt({ ammoEffects: ['CUSTOM_EXPLOSION'], explosion: { damage: 150, radius: 3 } } as never, 30.5, 30.5, null, 0);
    combat.ammoEffectsAt({ ammoEffects: ['AMMO_M433_HEDP'] } as never, 30.5, 30.5, null, 0);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ damage: 150, radius: 3 });
    expect(calls[1]).toMatchObject({ damage: 70, radius: 1 });
  });

  it('a land mine goes off as BN\'s basic explosion (40 / r 3, 80 bullet ×3 fragments to 6)', () => {
    const { game, sys, blasts, log } = world();
    const p = game.player;
    const z = sys.spawnById('mon_zombie', p.x + 2, p.y, 0)!;
    z.hp = 10000;
    setTrap(game, Math.floor(p.x), Math.floor(p.y), 0, 'tr_landmine');
    const before = playerHp(game);
    expect(triggerTrap(game, Math.floor(p.x), Math.floor(p.y), 0)).toBe(true);
    expect(blasts).toHaveLength(1);
    expect(blasts[0].radius).toBe(BASIC_EXPLOSION.radius);
    expect(playerHp(game)).toBeLessThan(before);
    expect(z.hp).toBeLessThan(10000);
    expect(log).toContain('You trigger a land mine!');
  });

  it('an EXPLODE death function blows up by its size (mdeath::explode: legacy power 75–375)', () => {
    const { game, sys, blasts } = world();
    const p = game.player;
    const bot = sys.spawnById('mon_hazmatbot', p.x + 10, p.y, 0)!;
    const near = sys.spawnById('mon_zombie', p.x + 11, p.y, 0)!;
    near.hp = 10000;
    sys.hurt(bot, 100000, 'player');
    expect(bot.dead).toBe(true);
    expect(blasts).toHaveLength(1);
    expect(near.hp).toBeLessThan(10000);
  });
});

describe('the blast wave and fragments (BN blast_tile, project_shrapnel)', () => {
  it('multibash: up to five bashes falling by damage / 5', () => {
    expect(multibashForces(150, 3, 0)).toEqual([150, 120, 90, 60, 30]);
    expect(multibashForces(150, 3, 2)).toEqual([75, 45, 15]);
    expect(multibashForces(70, 2, 3)).toEqual([]);
  });

  it('bnLine follows BN bresenham, 2D and 3D', () => {
    expect(bnLine(0, 0, 0, 3, 1, 0)).toEqual([[1, 0, 0], [2, 1, 0], [3, 1, 0]]);
    expect(bnLine(0, 0, 0, 0, 0, 1)).toEqual([[0, 0, 1]]);
    expect(bnLine(0, 0, 0, 2, 0, 1).at(-1)).toEqual([2, 0, 1]);
  });

  it('a wall the blast breaks no longer shields what is behind it (occlusion is checked as the wave arrives)', () => {
    const { game, sys } = world();
    const c = { x: 30, y: 30 };
    game.map.setTer(c.x + 1, c.y, 0, 't_window');
    const behind = sys.spawnById('mon_zombie', c.x + 2.5, c.y + 0.5, 0)!;
    behind.hp = 10000;
    expect(blastOccluded(game, c.x, c.y, c.x + 2, c.y, 0)).toBe(true);
    detonate(game, sys, c.x + 0.5, c.y + 0.5, 0, heat());
    expect(game.map.terAt(c.x + 1, c.y, 0).id).not.toBe('t_window');
    expect(behind.hp).toBeLessThan(10000);
  });

  it('grenade fragments break windows in sight (impact × 0.25 bash on impassable tiles)', () => {
    const { game, sys } = world();
    game.map.setTer(35, 30, 0, 't_window');
    detonate(game, sys, 30.5, 30.5, 0, { damage: 0, radius: 0, fire: false, fragment: grenade().fragment });
    expect(game.map.terAt(35, 30, 0).id).not.toBe('t_window');
  });

  it('a blast of radius 4+ reaches the level above through the floor (z-aware distance + 3 per level)', () => {
    const { game, sys } = world();
    for (let y = 25; y <= 35; y++) for (let x = 25; x <= 35; x++) game.map.setTer(x, y, 1, 't_floor');
    const up = sys.spawnById('mon_zombie', 30.5, 30.5, 1)!;
    up.hp = 10000;
    detonate(game, sys, 30.5, 30.5, 0, { damage: 100, radius: 3, fire: false });
    expect(up.hp).toBe(10000);
    detonate(game, sys, 30.5, 30.5, 0, { damage: 100, radius: 5, fire: false });
    // Directly above: distance 1 + 3 = 4 > 5 / 2 → half the blast, bash with 0.4 penetration.
    const armor = up.type.armor?.bash ?? 0;
    expect(10000 - up.hp).toBe(Math.floor(Math.max(0, 50 - Math.max(0, armor - 0.4))));
  });

  it('flinging: velocity (R − d) × damage × 40750 / (grams × 100), bouncing back at 0.3 off walls', () => {
    expect(flingVelocity(150, 3, 0, 81500)).toBeCloseTo(2.25, 2);
    expect(flingVelocity(70, 2, 0, 81500)).toBeLessThan(1);
    const { game } = world();
    // Free flight: 3.2 tiles east from (30, 30).
    expect(flingPath(game, null, 30, 30, 0, 0, 3.2, () => false)).toEqual({ x: 33, y: 30 });
    // A wall two tiles east: it stops short of it and turns back with 0.3 of the rest (< 1: stays).
    game.map.setTer(32, 30, 0, 't_brick_wall');
    expect(flingPath(game, null, 30, 30, 0, 0, 3.2, () => false)).toEqual({ x: 31, y: 30 });
  });

  it('a small creature near a HEAT blast is thrown away from it', () => {
    const { game, sys } = world();
    const dog = sys.spawnById('mon_dog', 31.5, 30.5, 0)!;
    dog.hp = 100000;
    const res = detonate(game, sys, 30.5, 30.5, 0, heat());
    const f = res.flung.get(dog);
    expect(f).toBeDefined();
    expect(f!.dx).toBeGreaterThan(0);
    for (let i = 0; i < 30; i++) game.tick(1 / 30);
    expect(dog.x).toBeGreaterThan(32);
  });
});

describe('blasts damage vehicles (vehicle::damage, map::bash_vehicle)', () => {
  it('vehicle::damage: armour takes the hit and shields the part by its damage_reduction; a hit under the threshold does nothing', () => {
    const { game, vs } = world();
    const v = vs.spawn('tank_m1_abrams', 60, 60, 0, 270, { fuel: 100, status: 2, rng: new Rng(3), force: true })!;
    const mount = partsAtMount(v, 2, -1);
    const armor = mount.find((p) => p.def.id === 'plating_military')!;
    const board = mount.find((p) => has(p, 'OBSTACLE'))!;
    const a0 = armor.hp, b0 = board.hp;
    // A grenade's 70 bash against military plating (70 bash resistance): nothing gets through.
    for (let i = 0; i < 20; i++) damageVehicleMount(game, v, 2, -1, 70, 'bash', new Rng(i));
    expect([armor.hp, board.hp]).toEqual([a0, b0]);
    // A HEAT round's 150: the plating takes 80 a hit.
    damageVehicleMount(game, v, 2, -1, 150, 'bash', { pick: () => board, next: () => 0, int: (a: number) => a, oneIn: () => false } as unknown as Rng);
    expect(a0 - armor.hp).toBe(80);
    // Threshold: min(20, durability / 10).
    expect(damageDirect(game, v, armor, 19, 'bash', new Rng(1))).toBe(0);
    expect(armor.hp).toBe(a0 - 80);
  });

  it('a HEAT blast beside a car wrecks the parts it reaches, and enough of them kill the engine', () => {
    const { game, vs, sys } = world();
    const v = car(vs);
    const hp0 = hpSum(v);
    const engine = v.engines[0];
    const front = tileOf(v, 3, 0); // the road in front of the engine
    detonate(game, sys, front.x + 0.5, front.y + 0.5, 0, heat(), 'player');
    expect(hpSum(v)).toBeLessThan(hp0 - 200);
    for (let i = 0; i < 8 && engine.hp > 0; i++) detonate(game, sys, front.x + 0.5, front.y + 0.5, 0, heat(), 'player');
    expect(engine.hp).toBe(0);
    expect(vs.startEngine(v).ok).toBe(false);
  });

  it('the people inside are shielded by the closed doors until a door opens or breaks', () => {
    const { game, vs, sys } = world();
    const v = car(vs);
    const seat = v.mountToWorld(0, 0);
    const p = game.player;
    [p.x, p.y] = seat;
    expect(vs.playerOn()?.v).toBe(v);
    const outside = tileOf(v, 0, -2); // beside the driver's door
    const door = v.partsAt(0, -1).find((q) => has(q, 'OPENABLE'))!;
    const d0 = door.hp + v.partsAt(0, -1).filter((q) => q !== door).reduce((s, q) => s + q.hp, 0);
    const before = playerHp(game);
    detonate(game, sys, outside.x + 0.5, outside.y + 0.5, 0, grenade());
    expect(playerHp(game)).toBe(before);
    expect(door.hp + v.partsAt(0, -1).filter((q) => q !== door).reduce((s, q) => s + q.hp, 0)).toBeLessThan(d0);
    // The door open: the blast and its fragments reach the driver.
    door.open = true;
    v.version++;
    detonate(game, sys, outside.x + 0.5, outside.y + 0.5, 0, grenade());
    expect(playerHp(game)).toBeLessThan(before);
  });

  it('a tank shrugs off grenades all round it; a HEAT round dents its armour', () => {
    const { game, vs, sys } = world();
    const v = vs.spawn('tank_m1_abrams', 60, 60, 0, 270, { fuel: 100, status: 2, rng: new Rng(3), force: true })!;
    const hp0 = hpSum(v);
    const tiles = new Set(v.occupiedTiles().map((t) => `${t.tx},${t.ty}`));
    let n = 0;
    for (const t of v.occupiedTiles())
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const k = `${t.tx + dx},${t.ty + dy}`;
        if (tiles.has(k) || n >= 12) continue;
        tiles.add(k);
        n++;
        detonate(game, sys, t.tx + dx + 0.5, t.ty + dy + 0.5, 0, grenade());
      }
    expect(n).toBe(12);
    expect(hpSum(v)).toBe(hp0);
    const side = v.occupiedTiles()[0];
    detonate(game, sys, side.tx + 0.5, side.ty - 1 + 0.5, 0, heat());
    expect(hpSum(v)).toBeLessThan(hp0);
  });

  it('fragments hit a vehicle\'s obstacle parts (impact × 0.25)', () => {
    const { game, vs, sys } = world();
    const v = car(vs);
    const hp0 = hpSum(v);
    const at = tileOf(v, 0, -5);
    detonate(game, sys, at.x + 0.5, at.y + 0.5, 0, { damage: 0, radius: 0, fire: false, fragment: { impact: [{ type: 'bullet', amount: 200, armor_penetration: 0, armor_multiplier: 1 }], range: 6 } });
    expect(hpSum(v)).toBeLessThan(hp0);
  });

  it('a damaged fuel tank can blow up (explode_fuel: one in chance_cold, power from what is in it)', () => {
    const { game, vs, sys, blasts } = world();
    const v = car(vs);
    const tank = v.parts.find((q) => has(q, 'FLUIDTANK') && q.fuelType === 'gasoline')!;
    const ml = tank.charges;
    expect(ml).toBeGreaterThan(0);
    const always = { next: () => 0, int: (a: number) => a, oneIn: () => true, pick: <T>(a: readonly T[]) => a.find((q) => q === (tank as unknown as T)) ?? a[0] } as unknown as Rng;
    const out: FuelBlast[] = [];
    damageVehicleMount(game, v, tank.mx, tank.my, 60, 'bash', always, { fuelBlasts: out });
    const ed = (data.items.gasoline as unknown as { fuel: { explosion_data: { factor: number; size_factor: number } } }).fuel.explosion_data;
    expect(out).toHaveLength(1);
    expect(out[0].power).toBeCloseTo(120 * (1 - Math.exp((ed.factor / -5000) * ml * ed.size_factor)), 6);
    expect(tank.hp).toBe(0);
    expect(tank.charges).toBe(0);
    // Through detonate: the tank's blast is queued and goes off after the first.
    const v2 = car(vs, 40, 50);
    const t2 = v2.parts.find((q) => has(q, 'FLUIDTANK') && q.fuelType === 'gasoline')!;
    const rng = game.player.rng;
    const real = rng.oneIn.bind(rng);
    rng.oneIn = () => true;
    try {
      const at = tileOf(v2, t2.mx, t2.my - 1);
      blasts.length = 0;
      detonate(game, sys, at.x + 0.5, at.y + 0.5, 0, heat());
    } finally {
      rng.oneIn = real;
    }
    expect(t2.hp).toBe(0);
    expect(blasts.length).toBeGreaterThanOrEqual(2);
  });
});

describe('free-aim rounds stop at vehicles', () => {
  it("the Abrams' 120 mm HEAT round meets the parked car it was aimed at and blows it apart", () => {
    const { game, vs, sys, combat, blasts } = world();
    installTurrets(game, null, { sys, combat, spawner: null as never, view: null });
    const p = game.player;
    for (const sk of ['gun', 'launcher', 'rifle']) p.skills[sk] = { level: 10, exercise: 0 };
    p.dex_base = p.per_base = 40;
    const tank = vs.spawn('tank_m1_abrams', 60, 60, 0, 270, { fuel: 100, status: 2, rng: new Rng(3), force: true })!;
    for (const q of tank.parts) if (has(q, 'TURRET')) q.gun = undefined;
    tank.locked = false;
    for (const e of tank.engines) tank.selectEngineFuel(e);
    const gunPart = tank.parts.find((q) => q.def.id === 'mounted_tank_manual')!;
    loadAmmo(turretGun(gunPart, data)!, '120mm_usable_heat', 1);
    const list = stationsOf(tank, 'crew');
    vs.stations.enter(tank, list.findIndex((s) => s.turret && tank.partsAt(s.mx, s.my).some((q) => q.def.id === 'mounted_tank_manual')));
    vs.stations.action()!.run();
    const target = car(vs, 60, 36);
    const hp0 = hpSum(target);
    const [cx, cy] = target.mountToWorld(0, 0);
    const eye = (combat as any).eye().h;
    p.yaw = Math.atan2(cx - p.x, -(cy - p.y));
    p.pitch = Math.atan2(0.8 - eye, Math.hypot(cx - p.x, cy - p.y));
    for (let i = 0; i < 150; i++) game.tick(1 / 30);
    expect(combat.fire()).toBe(true);
    expect(blasts).toHaveLength(1);
    // It went off against the car's near side, not behind it.
    const near = target.occupiedTiles().reduce((m, t) => Math.max(m, t.ty), -Infinity);
    expect(blasts[0].y).toBeGreaterThan(near - 0.5);
    expect(blasts[0].y).toBeLessThan(near + 2.5);
    expect(hpSum(target)).toBeLessThan(hp0 - 200);
    // BN map::shoot: the shell's own 4000-point impact wrecked the part it struck.
    expect(target.parts.some((q) => q.hp <= 0)).toBe(true);
  });

  it('map::shoot: a round that stops on a vehicle damages a part there by vehicle::damage (stab; heat if incendiary)', () => {
    const { game, vs, combat } = world();
    const v = car(vs);
    const door = tileOf(v, 0, -1);
    const parts = v.partsAt(0, -1);
    const sum = () => parts.reduce((s, q) => s + q.hp, 0);
    const s0 = sum();
    // A 9 mm round: 31 stab against a door (21) or its frame (52): 10 or nothing.
    const lost = combat.shootVehicle({ x: door.x, y: door.y, z: 0 }, [{ type: 'bullet', amount: 31 }]);
    expect([0, 10]).toContain(lost);
    expect(s0 - sum()).toBe(lost);
    // The HEAT shell's 4000 against the Abrams' plating (stab 88): the plate and the part behind go.
    const tank = vs.spawn('tank_m1_abrams', 60, 60, 0, 270, { fuel: 100, status: 2, rng: new Rng(3), force: true })!;
    const t = tileOf(tank, 2, -1);
    const plate = tank.partsAt(2, -1).find((q) => q.def.id === 'plating_military')!;
    combat.shootVehicle({ x: t.x, y: t.y, z: 0 }, [{ type: 'bullet', amount: 4000 }]);
    expect(plate.hp).toBe(0);
  });
});

describe('lobbed rounds, ceilings and roofs', () => {
  /** A room 20 × 20 around (30, 30) with a ceiling (the floor of level 1). */
  const roof = (game: Game) => {
    for (let y = 20; y <= 40; y++) for (let x = 20; x <= 40; x++) game.map.setTer(x, y, 1, 't_floor');
  };
  const fireLob = (game: Game, from: { x: number; y: number }, to: { x: number; y: number; h: number }) => {
    const d = Math.hypot(to.x - from.x, to.y - from.y);
    return enemyFireOf(game).fire({
      kind: 'grenade', x: from.x, y: from.y, h: 1.5, tx: to.x, ty: to.y, th: to.h, z: 0, yawOff: 0, range: d + 6, from: null,
      speed: lobSpeed('thrown', d), arc: true,
    });
  };
  const highest = (r: EnemyRound, upTo: number) => {
    let top = -Infinity;
    for (let s = 0; s <= upTo; s += 0.05) {
      const plan = s * Math.hypot(r.dx, r.dy);
      if (plan > (r.arc?.aimDist ?? 0)) break;
      top = Math.max(top, r.h0 + r.dh * s + (9.8 / (2 * r.speed * r.speed)) * plan * ((r.arc?.aimDist ?? 0) - plan));
    }
    return top;
  };

  it('indoors a lob is flattened to stay under the ceiling and still lands where it was aimed', () => {
    const { game } = world();
    const out = fireLob(game, { x: 25.5, y: 30.5 }, { x: 37.5, y: 30.5, h: 0.2 });
    expect(highest(out, out.maxS)).toBeGreaterThan(LEVEL_HEIGHT); // outdoors: a high lob
    out.done = true;
    roof(game);
    expect(ceilingSpeed(game, out)).toBeGreaterThan(out.speed);
    const r = fireLob(game, { x: 25.5, y: 30.5 }, { x: 37.5, y: 30.5, h: 0.2 });
    expect(highest(r, r.maxS)).toBeLessThan(LEVEL_HEIGHT - 0.15);
    let end: { x: number; what: string; z: number } | null = null;
    r.onEnd = (x, _y, _h, what, z) => (end = { x, what, z });
    for (let i = 0; i < 120 && !end; i++) game.tick(1 / 30);
    expect(end).not.toBeNull();
    expect(end!.what).toBe('ground');
    expect(Math.abs(end!.x - 37.5)).toBeLessThan(1.5);
  });

  it('a round whose own line reaches the ceiling stops under it and goes off there, on its level', () => {
    const { game, sys, blasts } = world();
    roof(game);
    const r = fireLob(game, { x: 25.5, y: 30.5 }, { x: 33.5, y: 30.5, h: 3.4 });
    let end: { x: number; h: number; what: string; z: number } | null = null;
    r.onEnd = (x, _y, h, what, z) => {
      end = { x, h, what, z };
      detonate(game, sys, x, 30.5, z, grenade());
    };
    for (let i = 0; i < 120 && !end; i++) game.tick(1 / 30);
    expect(end).toMatchObject({ what: 'ceiling', z: 0 });
    expect(end!.h).toBeLessThan(LEVEL_HEIGHT);
    expect(end!.x).toBeLessThan(33.5);
    expect(blasts.at(-1)!.z).toBe(0);
  });

  it('out of doors a lob flies over a one-storey building and lands beyond it, or on its roof', () => {
    const { game } = world();
    // A building across x = 31..33: brick walls at 31 and 33, a room between, a flat roof over all.
    for (let y = 20; y <= 40; y++) {
      game.map.setTer(31, y, 0, 't_brick_wall');
      game.map.setTer(33, y, 0, 't_brick_wall');
      game.map.setTer(32, y, 0, 't_floor');
      for (let x = 31; x <= 33; x++) game.map.setTer(x, y, 1, 't_flat_roof');
    }
    const over = fireLob(game, { x: 22.5, y: 30.5 }, { x: 40.5, y: 30.5, h: 0.2 });
    let end: { x: number; what: string; z: number } | null = null;
    over.onEnd = (x, _y, _h, what, z) => (end = { x, what, z });
    for (let i = 0; i < 150 && !end; i++) game.tick(1 / 30);
    expect(end).toMatchObject({ what: 'ground', z: 0 });
    expect(end!.x).toBeGreaterThan(36);
    // Aimed at the roof: it lands up there (level 1).
    const onto = fireLob(game, { x: 22.5, y: 30.5 }, { x: 32.5, y: 30.5, h: LEVEL_HEIGHT + 0.1 });
    let end2: { x: number; what: string; z: number } | null = null;
    onto.onEnd = (x, _y, _h, what, z) => (end2 = { x, what, z });
    for (let i = 0; i < 150 && !end2; i++) game.tick(1 / 30);
    expect(end2).toMatchObject({ what: 'ground', z: 1 });
    expect(end2!.x).toBeGreaterThan(30.9);
    expect(end2!.x).toBeLessThan(34);
  });

  it("the survivor's arrow loosed up into a ceiling drops from it", () => {
    const { game, combat } = world();
    roof(game);
    const p = game.player;
    p.x = 30.5;
    p.y = 30.5;
    p.str_base = 12;
    p.resetStats();
    p.inv.wear(createItem(data, 'backpack'), null);
    p.inv.wield(createItem(data, 'longbow'), null);
    p.inv.giveNew(createItem(data, 'arrow_wood', { count: 5 }));
    p.setSkill('archery', 10);
    setAimModel('dice');
    p.yaw = 0;
    p.pitch = 1.0;
    const input = (game as unknown as { input: { mouseButtons: number; consumeClicks: () => number[] } }).input;
    input.mouseButtons = 4;
    for (let i = 0; i < 90; i++) game.tick(1 / 30);
    const clicks = [0];
    input.consumeClicks = () => clicks.splice(0);
    game.tick(1 / 30);
    input.mouseButtons = 0;
    expect(combat.flights.length).toBe(1);
    for (let i = 0; i < 60 && combat.flights.length; i++) game.tick(1 / 30);
    const landed = (combat as unknown as { landed: { x: number; y: number }[] }).landed.at(-1)!;
    expect(landed).toBeDefined();
    expect(Math.hypot(landed.x - 30.5, landed.y - 30.5)).toBeLessThan(3);
    setAimModel('sway');
  });
});

describe('armed explosives (BN explosion_iuse: a grenade with its pin pulled)', () => {
  const armedWorld = () => {
    const w = world();
    const armed = new ArmedExplosives(w.game, () => w.sys);
    w.game.systems.push(armed);
    w.game.player.inv.activeProcessors.push((it) => armed.claim(it));
    w.combat.onThrown = (it, x, y, z) => armed.thrown(it, x, y, z);
    w.game.player.inv.useHandlers.set('explosion', (it) => ({ ok: false, msg: ArmedExplosives.refuse(it), moves: 0 }));
    return { ...w, armed };
  };
  const pullPin = (game: Game) => {
    const g = createItem(data, 'grenade');
    game.player.inv.wield(g, null);
    const r = game.player.inv.use(g);
    expect(r.ok).toBe(true);
    expect(g.typeId).toBe('grenade_act');
    expect(g.charges).toBe(5); // target_charges
    expect(g.active).toBe(true);
    return g;
  };

  it('pulling the pin sets a five-turn fuse; the pin does not go back; held, it goes off on you', () => {
    const { game, blasts } = armedWorld();
    const g = pullPin(game);
    expect(game.player.inv.use(g).msg).toBe("You've already pulled the active grenade's pin; try throwing it instead.");
    const before = playerHp(game);
    game.tick(1 / 30);
    // 5 turns of 1/3 s: nothing at 1.5 s, the blast by 1.8 s.
    for (let i = 0; i < 44; i++) game.tick(1 / 30);
    expect(blasts).toHaveLength(0);
    for (let i = 0; i < 10; i++) game.tick(1 / 30);
    expect(blasts).toHaveLength(1);
    expect(playerHp(game)).toBeLessThan(before);
    expect(game.player.inv.wielded).toBeNull();
  });

  it('thrown, it goes off where it landed, and wrecks the car door it landed against', () => {
    const { game, vs, combat, blasts } = armedWorld();
    const v = car(vs, 30, 14);
    const hp0 = hpSum(v);
    const p = game.player;
    p.x = 30.5;
    p.y = 22.5;
    p.yaw = 0; // north, toward the car's right side
    p.str_base = 12;
    p.resetStats();
    const g = pullPin(game);
    expect(combat.throwItem(g)).toBe(true);
    for (let i = 0; i < 60 && !blasts.length; i++) game.tick(1 / 30);
    expect(blasts).toHaveLength(1);
    expect(Math.hypot(blasts[0].x - p.x, blasts[0].y - p.y)).toBeGreaterThan(3);
    expect(hpSum(v)).toBeLessThan(hp0);
  });

  it('a packed LAW unfolds loaded (target_charges with target_ammo)', () => {
    const { game } = world();
    const law = createItem(data, 'LAW_Packed');
    game.player.inv.wield(law, null);
    expect(game.player.inv.use(law).ok).toBe(true);
    expect(law.typeId).toBe('LAW');
    expect(law.ammoRemaining()).toBe(1);
    expect(law.ammoData()?.id).toBe('66mm_HEAT');
  });
});
