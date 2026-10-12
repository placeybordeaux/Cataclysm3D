// Vehicle turrets (src/game/turret.ts, src/turrets.ts; docs/VEHICLES.md "Turrets"): BN's
// turret_data (query, ammo from the turret's own gun), spawn ammo from the prototype's turret
// "ammo" fields, reload from carried rounds or cargo within one cell (BN range 1), manning the
// gun at a gunner station and firing it from its muzzle through PlayerCombat with only the
// vehicle's recoil (turret_data::prepare_fire), battery drain (ups_charges), the controls volley
// (turrets_aim_and_fire_mult with the targeting NPC), the station eye height for shots, and the
// governed speed figures the dashboard shows.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import type { GameData } from '../src/data/types';
import { Game } from '../src/game/game';
import { chassisBodyRect } from '../src/game/chassis';
import { has, MPH_PER_MS, spawnVehicle, turretGun, Vehicle, type VehiclePart } from '../src/game/vehicle';
import type { VehicleDataFile } from '../src/game/vehicle_data';
import { VehicleSystem } from '../src/game/vehicles';
import { stationsOf } from '../src/game/vehwalk';
import { MonsterSystem } from '../src/game/monai';
import { PlayerCombat } from '../src/game/playercombat';
import { createItem, loadAmmo, type Item } from '../src/game/item';
import { L, spawnItem } from '../src/game/moves';
import { setAimModel } from '../src/game/aimmodel';
import { activeWeapon } from '../src/game/bionicguns';
import { cycleMode, currentMode } from '../src/game/gunmods';
import { blastFromJson, detonate } from '../src/game/blast';
import { ammoChoices, reloadTurret, setAmmoPref, turretAim, turretSession, turretStatus, vehicleRecoilMoa } from '../src/game/turret';
import { installTurrets } from '../src/turrets';
import { driveReadout } from '../src/screens/logic/vehicle';
import { gearFor } from '../src/audio/vehicleAudio';
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

function world() {
  setAimModel('sway');
  const input = { held: new Set<string>(), captured: false, mouseButtons: 0, lastEscape: -1, onPress() {}, consumeMouse: () => [0, 0], consumeClicks: () => [] } as any;
  const game = new Game(data, 5, input);
  game.map.generator = new FlatGen();
  for (let y = -1; y <= 6; y++) for (let x = -1; x <= 6; x++) game.map.chunk(x, y, 0);
  const vs = new VehicleSystem(game, vdata);
  game.vehicles = vs;
  game.systems.push(vs);
  vs.bodyShape = chassisBodyRect;
  vs.scriptedInput = true;
  const sys = new MonsterSystem(game);
  const combat = new PlayerCombat(game, sys);
  game.systems.push(sys, combat);
  const turrets = installTurrets(game, null, { sys, combat, spawner: null as never, view: null });
  const log: string[] = [];
  game.events.on('message', (m) => log.push(m.text));
  game.player.x = 60.5;
  game.player.y = 60.5;
  // A steady gunner, so hits don't hang on the reticle's weave.
  const pl = game.player;
  pl.dex_base = pl.per_base = 40;
  for (const sk of ['gun', 'launcher', 'rifle']) pl.skills[sk] = { level: 10, exercise: 0 };
  return { game, vs, sys, combat, turrets, log, input };
}

/** An Abrams facing north at (60, 60), full battery, its cargo and turrets emptied. */
function abrams(vs: VehicleSystem): Vehicle {
  const v = vs.spawn('tank_m1_abrams', 60, 60, 0, 270, { fuel: 100, status: 2, rng: new Rng(3), force: true })!;
  for (const p of v.parts) {
    p.items.length = 0;
    if (has(p, 'TURRET')) p.gun = undefined;
  }
  v.locked = false;
  // what starting the engine does: the turbine burns the JP-8 it carries (multi-fuel engines)
  for (const e of v.engines) v.selectEngineFuel(e);
  v.version++;
  return v;
}
const part = (v: Vehicle, id: string): VehiclePart => v.parts.find((p) => p.def.id === id)!;
const cargoAt = (v: Vehicle, mx: number, my: number): VehiclePart => v.partsAt(mx, my).find((p) => has(p, 'CARGO'))!;
const rounds = (items: readonly Item[], id: string) => items.filter((i) => i.typeId === id).reduce((n, i) => n + i.charges, 0);

/** Sit at the gunner station whose cell carries `turretId`. */
function seatAt(vs: VehicleSystem, v: Vehicle, turretId: string): void {
  const list = stationsOf(v, 'crew');
  const i = list.findIndex((s) => s.turret && v.partsAt(s.mx, s.my).some((p) => p.def.id === turretId));
  expect(i).toBeGreaterThanOrEqual(0);
  vs.stations.enter(v, i);
}

/** Look from the player at world (x, y, h) and let the turret come round. */
function lookAt(game: Game, x: number, y: number, h: number, eye: number): void {
  const p = game.player;
  p.yaw = Math.atan2(x - p.x, -(y - p.y));
  p.pitch = Math.atan2(h - eye, Math.hypot(x - p.x, y - p.y));
  for (let i = 0; i < 150; i++) game.tick(1 / 30);
}

function zombieAt(sys: MonsterSystem, x: number, y: number) {
  const m = sys.spawnById('mon_zombie', x, y, 0)!;
  m.addEffect('downed', 1000);
  return m;
}

describe('turret spawn ammo (BN place_spawn_items: prototype part "ammo", "ammo_types", "ammo_qty")', () => {
  it('the extracted Abrams carries the turret ammo fields', () => {
    const parts = vdata.vehicles.tank_m1_abrams.parts.filter((p) => p.ammo);
    expect(parts.map((p) => p.part).sort()).toEqual(['mounted_browning', 'mounted_m240', 'mounted_tank_manual']);
    expect(parts.find((p) => p.part === 'mounted_tank_manual')!.ammo_types).toEqual(['120mm_usable_heat', '120mm_usable_ap']);
    expect(parts.find((p) => p.part === 'mounted_m240')!.ammo_qty).toEqual([10, 100]);
  });

  it('spawns ~80% loaded: the 120 mm with one HEAT or AP round, the M2 / M240 belts with 10-100 rounds', () => {
    let loaded = 0;
    const n = 60;
    for (let seed = 1; seed <= n; seed++) {
      const v = spawnVehicle(vdata, data, 'tank_m1_abrams', { x: 0.5, y: 0.5, z: 0, facing: 0, fuel: 100, status: 2, rng: new Rng(seed) });
      const main = turretGun(part(v, 'mounted_tank_manual'), data)!;
      expect(main.hasFlag('VEHICLE')).toBe(true);
      if (main.ammoRemaining() > 0) {
        loaded++;
        expect(main.ammoRemaining()).toBe(1);
        expect(['120mm_usable_heat', '120mm_usable_ap']).toContain(main.ammoData()!.id);
      }
      const m2 = turretGun(part(v, 'mounted_browning'), data)!;
      if (m2.ammoRemaining() > 0) {
        expect(m2.magazine?.typeId).toBe('belt50');
        expect(m2.ammoRemaining()).toBeGreaterThanOrEqual(10);
        expect(m2.ammoRemaining()).toBeLessThanOrEqual(100);
        expect(m2.ammoData()!.id).toBe('50bmg');
      }
      const m240 = turretGun(part(v, 'mounted_m240'), data)!;
      if (m240.ammoRemaining() > 0) expect(m240.ammoData()!.id).toBe('762_51');
    }
    expect(loaded / n).toBeGreaterThan(0.6);
    expect(loaded / n).toBeLessThan(0.97);
  });

  it('a save keeps the gun and the rounds in it', () => {
    const v = spawnVehicle(vdata, data, 'tank_m1_abrams', { x: 0.5, y: 0.5, z: 0, facing: 0, fuel: 100, status: 2, rng: new Rng(1), items: false });
    const gun = turretGun(part(v, 'mounted_browning'), data)!;
    loadAmmo(gun, '50bmg', 37);
    const back = Vehicle.fromJSON(vdata, data, JSON.parse(JSON.stringify(v.toJSON())));
    const g2 = part(back, 'mounted_browning').gun!;
    expect(g2.ammoRemaining()).toBe(37);
    expect(g2.magazine?.typeId).toBe('belt50');
    expect(g2.hasFlag('VEHICLE')).toBe(true);
  });
});

describe('turret state survives save / load', () => {
  it('keeps each turret\'s bearing over the hull, its elevation and the chosen round type', () => {
    const v = spawnVehicle(vdata, data, 'tank_m1_abrams', { x: 0.5, y: 0.5, z: 0, facing: 30, fuel: 100, status: 2, rng: new Rng(1), items: false });
    const main = part(v, 'mounted_tank_manual'), m2 = part(v, 'mounted_browning');
    const a = turretAim(v, main);
    a.yaw += 1.2;
    a.pitch = 0.15;
    turretAim(v, m2).yaw -= 0.5;
    setAmmoPref(main, '120mm_usable_heat');
    const j = JSON.parse(JSON.stringify(v.toJSON()));
    // turned to a different heading on load: the turret keeps its bearing over the hull
    j.facing = 120;
    const back = Vehicle.fromJSON(vdata, data, j);
    const rel = (veh: Vehicle, p: VehiclePart) => Math.atan2(Math.sin(turretAim(veh, p).yaw - ((veh.facing + 90) * Math.PI) / 180), Math.cos(turretAim(veh, p).yaw - ((veh.facing + 90) * Math.PI) / 180));
    expect(rel(back, part(back, 'mounted_tank_manual'))).toBeCloseTo(rel(v, main), 5);
    expect(rel(back, part(back, 'mounted_browning'))).toBeCloseTo(rel(v, m2), 5);
    expect(turretAim(back, part(back, 'mounted_tank_manual')).pitch).toBeCloseTo(0.15, 5);
    expect(part(back, 'mounted_tank_manual').ammoPref).toBe('120mm_usable_heat');
    // a turret nobody touched isn't written at all
    expect(j.parts.find((p: { id: string }) => p.id === 'mounted_m240').aim).toBeUndefined();
  });
});

describe('turret status and reload (BN turret_data::query, avatar_action::reload on a turret)', () => {
  it('empty -> no_ammo; loaded -> ready; a flat battery -> no_power (25 kJ a shot for the 120 mm)', () => {
    const { game, vs } = world();
    const v = abrams(vs);
    const p = part(v, 'mounted_tank_manual');
    expect(turretStatus(v, p, game.data)).toBe('no_ammo');
    loadAmmo(turretGun(p, game.data)!, '120mm_usable_heat', 1);
    expect(turretStatus(v, p, game.data)).toBe('ready');
    for (const b of v.parts) if (b.fuelType === 'battery') b.charges = 10;
    expect(turretStatus(v, p, game.data)).toBe('no_power');
  });

  it('loads a round from the ammo rack beside the gun (cargo within one cell), conserving it', () => {
    const { game, vs } = world();
    const v = abrams(vs);
    const p = part(v, 'mounted_tank_manual');
    // the rack at (-3, 1) is next to the gunner (-2, 1); the one at (-4, 0) isn't
    const near = cargoAt(v, -3, 1), far = cargoAt(v, -4, 0);
    spawnItem(createItem(data, '120mm_usable_heat', { count: 2 }), L.cargo(near), { force: true });
    spawnItem(createItem(data, '120mm_usable_ap', { count: 3 }), L.cargo(far), { force: true });
    const r = reloadTurret(v, p, game.player);
    expect(r.ok).toBe(true);
    const gun = p.gun!;
    expect(gun.ammoRemaining()).toBe(1);
    expect(gun.ammoData()!.id).toBe('120mm_usable_heat');
    expect(rounds(near.items, '120mm_usable_heat')).toBe(1);
    expect(rounds(far.items, '120mm_usable_ap')).toBe(3);
    // BN item_reload_cost for a 300-move tank gun: a few real seconds
    expect(r.seconds).toBeGreaterThanOrEqual(1.5);
    expect(r.seconds).toBeLessThanOrEqual(6);
    expect(reloadTurret(v, p, game.player).ok).toBe(false);
  });

  it('carried rounds count; the preferred round type (fire_mode) is loaded first', () => {
    const { game, vs } = world();
    const v = abrams(vs);
    const p = part(v, 'mounted_tank_manual');
    spawnItem(createItem(data, '120mm_usable_heat', { count: 1 }), L.cargo(cargoAt(v, -3, 1)), { force: true });
    spawnItem(createItem(data, '120mm_usable_ap', { count: 1 }), L.inv(game.player), { force: true });
    const gun = turretGun(p, data)!;
    expect(ammoChoices(v, p, gun, game.player).map((c) => c.id).sort()).toEqual(['120mm_usable_ap', '120mm_usable_heat']);
    setAmmoPref(p, '120mm_usable_heat');
    expect(reloadTurret(v, p, game.player).ok).toBe(true);
    expect(gun.ammoData()!.id).toBe('120mm_usable_heat');
  });

  it('feeds a fuller belt into the M2; the old one goes to your inventory', () => {
    const { game, vs } = world();
    const v = abrams(vs);
    const p = part(v, 'mounted_browning');
    const gun = turretGun(p, data)!;
    loadAmmo(gun, '50bmg', 5);
    const old = gun.magazine!;
    const belt = createItem(data, 'belt50');
    loadAmmo(belt, '50bmg', 100);
    spawnItem(belt, L.cargo(cargoAt(v, -3, 2)), { force: true });
    const r = reloadTurret(v, p, game.player);
    expect(r.ok).toBe(true);
    expect(gun.magazine).toBe(belt);
    expect(gun.ammoRemaining()).toBe(100);
    // into your inventory, or back where the new one came from when you can't carry it
    expect(game.player.inv.items.includes(old) || cargoAt(v, -3, 2).items.includes(old)).toBe(true);
    expect(old.ammoRemaining()).toBe(5);
  });
});

describe('manning a turret at a gunner station and firing it', () => {
  it('e mans the gun: it becomes the active weapon; the shot leaves the muzzle, kills the zombie, drains 25 kJ', () => {
    const { game, vs, sys, combat } = world();
    const v = abrams(vs);
    const p = part(v, 'mounted_tank_manual');
    loadAmmo(turretGun(p, data)!, '120mm_usable_ap', 1);
    seatAt(vs, v, 'mounted_tank_manual');
    const act = vs.stations.action()!;
    expect(act.label).toMatch(/Man the 120mm tank gun/);
    act.run();
    expect(turretSession(game)?.part).toBe(p);
    expect(activeWeapon(game)).toBe(p.gun);
    expect(vs.stations.action()!.label).toMatch(/Stand down/);
    const z = zombieAt(sys, 60.5, 40.5);
    const [tx, ty] = v.mountToWorld(p.mx, p.my);
    lookAt(game, z.x, z.y, 1.2, (combat as any).eye().h);
    const bat0 = v.fuelLeft('battery');
    const fired: any[] = [];
    game.events.on('turretFired', (e) => fired.push(e));
    expect(combat.fire()).toBe(true);
    expect(z.dead).toBe(true);
    expect(p.gun!.ammoRemaining()).toBe(0);
    expect(bat0 - v.fuelLeft('battery')).toBeCloseTo(25, 5);
    expect(fired).toHaveLength(1);
    // from the muzzle: ahead of the turret's cell, ~2 m up (not the survivor's 1.6 m eye)
    expect(fired[0].muzzle.h).toBeGreaterThan(1.2);
    expect(fired[0].muzzle.h).toBeLessThan(2.6);
    expect(Math.hypot(fired[0].muzzle.x - tx, fired[0].muzzle.y - ty)).toBeGreaterThan(3);
    const tr = combat.tracers[combat.tracers.length - 1];
    expect(tr.h0).toBeCloseTo(fired[0].muzzle.h, 5);
    // empty now: the next click is refused until reloaded
    expect(combat.fire()).toBe(false);
  });

  it('the gunner keeps their own recoil; the shot sees only the vehicle\'s (BN prepare_fire / post_fire)', () => {
    const { game, vs, combat } = world();
    const v = abrams(vs);
    const p = part(v, 'mounted_browning');
    loadAmmo(turretGun(p, data)!, '50bmg', 50);
    seatAt(vs, v, 'mounted_browning');
    vs.stations.action()!.run();
    lookAt(game, 60.5, 30.5, 1.2, (combat as any).eye().h);
    game.player.recoil = 123;
    expect(vehicleRecoilMoa(v)).toBe(0);
    expect(combat.fire()).toBe(true);
    expect(game.player.recoil).toBe(123);
    v.velocity = 10 / MPH_PER_MS;
    // |velocity| 1000 vmiph * 3 / 100
    expect(vehicleRecoilMoa(v)).toBeCloseTo(30, 0);
  });

  it('the M2 on auto fires a 3-round burst from its belt', () => {
    const { game, vs, combat } = world();
    const v = abrams(vs);
    const p = part(v, 'mounted_browning');
    const gun = turretGun(p, data)!;
    loadAmmo(gun, '50bmg', 50);
    seatAt(vs, v, 'mounted_browning');
    vs.stations.action()!.run();
    while (currentMode(gun).qty < 3) cycleMode(gun);
    lookAt(game, 60.5, 30.5, 1.2, (combat as any).eye().h);
    expect(combat.fire()).toBe(true);
    for (let i = 0; i < 30; i++) game.tick(1 / 30);
    expect(gun.ammoRemaining()).toBe(47);
  });

  it('a click while the turret is still coming round fires once it gets there', () => {
    const { game, vs, combat } = world();
    const v = abrams(vs);
    const p = part(v, 'mounted_tank_manual');
    loadAmmo(turretGun(p, data)!, '120mm_usable_ap', 1);
    seatAt(vs, v, 'mounted_tank_manual');
    vs.stations.action()!.run();
    // look behind (the turret starts down the hull, north)
    game.player.yaw = Math.PI;
    game.player.pitch = 0;
    game.tick(1 / 30);
    expect(combat.fire()).toBe(false);
    expect(p.gun!.ammoRemaining()).toBe(1);
    for (let i = 0; i < 150; i++) game.tick(1 / 30);
    expect(p.gun!.ammoRemaining()).toBe(0);
    expect(Math.abs(Math.atan2(Math.sin(turretAim(v, p).yaw - Math.PI), Math.cos(turretAim(v, p).yaw - Math.PI)))).toBeLessThan(0.05);
  });

  it('hopping away from the gun stands you down', () => {
    const { game, vs } = world();
    const v = abrams(vs);
    seatAt(vs, v, 'mounted_tank_manual');
    vs.stations.action()!.run();
    expect(turretSession(game)).not.toBeNull();
    vs.stations.enter(v, stationsOf(v, 'crew').findIndex((s) => s.kind === 'driver'));
    game.tick(1 / 30);
    expect(turretSession(game)).toBeNull();
  });

  it('a HEAT round blows up where it lands (CUSTOM_EXPLOSION: damage 150, radius 3)', () => {
    const { game, vs, sys, combat } = world();
    combat.hooks.blast = (x, y, z, e) => void detonate(game, sys, x, y, z, blastFromJson(e)!, 'player');
    const blasts: any[] = [];
    game.events.on('explosion', (e) => blasts.push(e));
    const v = abrams(vs);
    const p = part(v, 'mounted_tank_manual');
    loadAmmo(turretGun(p, data)!, '120mm_usable_heat', 1);
    seatAt(vs, v, 'mounted_tank_manual');
    vs.stations.action()!.run();
    // two zombies a metre apart, 25 m out; aim at the road between them
    const a = zombieAt(sys, 59.5, 35.5), b = zombieAt(sys, 61.5, 35.5);
    lookAt(game, 60.5, 35.5, 0, (combat as any).eye().h);
    const why: string[] = [];
    game.events.on('attackRefused', (e) => why.push(e.reason));
    expect([combat.fire(), why]).toEqual([true, []]);
    expect(blasts).toHaveLength(1);
    expect(blasts[0].radius).toBe(3);
    expect(Math.hypot(blasts[0].x - 60.5, blasts[0].y - 35.5)).toBeLessThan(1.5);
    expect(a.hp < a.hpMax || a.dead).toBe(true);
    expect(b.hp < b.hpMax || b.dead).toBe(true);
  });
});

describe('the station eye (shots from a vehicle station leave the seat, not 1.6 m over the road)', () => {
  it('at the gunner station the eye is over the turret roof; on the road it is 1.6 m', () => {
    const { game, vs, combat } = world();
    const v = abrams(vs);
    expect((combat as any).eye().h).toBeCloseTo(1.6, 5);
    seatAt(vs, v, 'mounted_tank_manual');
    expect((combat as any).eye().h).toBeGreaterThan(2.8);
    vs.stations.enter(v, stationsOf(v, 'crew').findIndex((s) => s.kind === 'hatch'));
    expect((combat as any).eye().h).toBeGreaterThan(3);
    void game;
  });
});

describe('controls volley (BN turrets_aim_and_fire_mult from the controls, the targeting NPC)', () => {
  it('f at the wheel with empty hands fires every ready turret at the crosshair', () => {
    const { game, vs, sys } = world();
    const v = abrams(vs);
    for (const [id, ammo, n] of [['mounted_tank_manual', '120mm_usable_ap', 1], ['mounted_browning', '50bmg', 30], ['mounted_m240', '762_51', 30]] as const) loadAmmo(turretGun(part(v, id), data)!, ammo, n);
    expect(vs.takeControls(v).ok).toBe(true);
    const z = zombieAt(sys, 60.5, 30.5);
    const pl = game.player;
    pl.yaw = Math.atan2(z.x - pl.x, -(z.y - pl.y));
    pl.pitch = Math.atan2(1.2 - 1.8, Math.hypot(z.x - pl.x, z.y - pl.y));
    const fired: any[] = [];
    game.events.on('turretFired', (e) => fired.push(e));
    game.keys.handler('fire')!();
    // each turret traverses onto the point first, then fires
    for (let i = 0; i < 90 && new Set(fired.map((e) => e.part)).size < 3; i++) game.tick(1 / 30);
    expect(fired.length).toBeGreaterThanOrEqual(3);
    expect(new Set(fired.map((e) => e.part)).size).toBe(3);
    expect(part(v, 'mounted_tank_manual').gun!.ammoRemaining()).toBe(0);
    expect(z.dead).toBe(true);
  });
});

describe('controls volley traverses before it fires', () => {
  it('a target behind the tank: nothing fires on the key, the turret swings round at 45 deg/s, then fires', () => {
    const { game, vs, sys } = world();
    const v = abrams(vs);
    const main = part(v, 'mounted_tank_manual');
    loadAmmo(turretGun(main, data)!, '120mm_usable_ap', 1);
    expect(vs.takeControls(v).ok).toBe(true);
    // the tank faces north; the zombie is 30 m south, behind it
    const z = zombieAt(sys, 60.5, 92.5);
    const pl = game.player;
    pl.yaw = Math.atan2(z.x - pl.x, -(z.y - pl.y));
    pl.pitch = Math.atan2(1.2 - 1.8, Math.hypot(z.x - pl.x, z.y - pl.y));
    const fired: any[] = [];
    game.events.on('turretFired', (e) => fired.push(e));
    const yaw0 = turretAim(v, main).yaw;
    game.keys.handler('fire')!();
    expect(fired.filter((e) => e.part === main)).toHaveLength(0);
    expect(main.gun!.ammoRemaining()).toBe(1);
    let t = 0, firedAt = -1;
    for (; t < 8 && firedAt < 0; t += 1 / 30) {
      game.tick(1 / 30);
      if (fired.some((e) => e.part === main)) firedAt = t;
    }
    // ~180 deg at 45 deg/s: about 4 s of visible traverse
    expect(firedAt).toBeGreaterThan(3);
    expect(firedAt).toBeLessThan(5.5);
    const turned = Math.abs(Math.atan2(Math.sin(turretAim(v, main).yaw - yaw0), Math.cos(turretAim(v, main).yaw - yaw0)));
    expect(turned).toBeGreaterThan(Math.PI * 0.9);
    expect(main.gun!.ammoRemaining()).toBe(0);
  });
});

describe('dashboard figures (governed tracks, not CDDA drag maths)', () => {
  it('the Abrams reads ~45 mph top, not 150; a car keeps its CDDA figures', () => {
    const { vs } = world();
    const v = abrams(vs);
    v.engineOn = true;
    const lim = vs.speedLimits(v);
    expect(v.maxVelocity() * MPH_PER_MS).toBeGreaterThan(100);
    expect(lim.top * MPH_PER_MS).toBeGreaterThan(40);
    expect(lim.top * MPH_PER_MS).toBeLessThan(48);
    expect(lim.safe).toBeLessThanOrEqual(lim.top);
    const r = driveReadout(v, false, lim);
    expect(r.topMph).toBeLessThan(48);
    expect(r.safeMph).toBeLessThan(48);
    const car = vs.spawn('car', 90, 90, 0, 0, { fuel: 100, status: 2, rng: new Rng(4), force: true })!;
    car.engineOn = true;
    const cl = vs.speedLimits(car);
    expect(cl.top).toBeCloseTo(car.maxVelocity(), 6);
    expect(cl.safe).toBeCloseTo(car.maxVelocity(true), 6);
  });

  it('the engine note spreads its gears over the governed speed (top gear near 40 mph in the Abrams)', () => {
    const { vs } = world();
    const v = abrams(vs);
    v.engineOn = true;
    const at40 = 40 / MPH_PER_MS;
    expect(gearFor(at40, vs.speedLimits(v).safe)).toBe(6);
    expect(gearFor(at40, v.maxVelocity(true))).toBeLessThan(6);
  });
});
