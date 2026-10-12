// Towing (src/game/towing.ts, docs/VEHICLES.md "Towing"): BN's heavy duty tow cable as a rope
// constraint in the momentum physics. Slack, then taut; the pull is an equal and opposite impulse
// (a heavy load slows the tower, a tank drags a car); the towed vehicle trails through turns;
// the cable snaps per BN (25 tiles, z-levels, a destroyed part) or on overload; it saves.
// Run with drawn bodies (the modelled look), as the game does.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import type { GameData } from '../src/data/types';
import { Game } from '../src/game/game';
import { createItem } from '../src/game/item';
import { MonsterSystem } from '../src/game/monai';
import { census, L, spawnItem } from '../src/game/moves';
import { CABLE_BREAK_N, TOW_SNAP_M, TOW_TAUT_M, towDirection, TOW_MIN_ACCEL } from '../src/game/towing';
import { has, MPH_PER_MS, type Vehicle } from '../src/game/vehicle';
import type { VehicleDataFile } from '../src/game/vehicle_data';
import { monsterCreatureHooks, VehicleSystem } from '../src/game/vehicles';
import { bodyRectFor } from '../src/render/vehicleLayout';
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
const stubInput = () => ({ held: new Set<string>(), captured: false, mouseButtons: 0, onPress() {}, consumeMouse: () => [0, 0], consumeClicks: () => [] }) as any;

function world() {
  const game = new Game(data, 3, stubInput());
  game.map.generator = new FlatGen();
  for (let y = -1; y <= 8; y++) for (let x = -1; x <= 12; x++) game.map.chunk(x, y, 0);
  const ms = new MonsterSystem(game);
  const vs = new VehicleSystem(game, vdata);
  game.vehicles = vs;
  vs.creatureHooks = monsterCreatureHooks(ms);
  game.systems.push(ms, vs);
  vs.bodyShape = bodyRectFor;
  game.player.x = 10.5;
  game.player.y = 150.5;
  vs.scriptedInput = true;
  const log: string[] = [];
  game.events.on('message', (m) => log.push(m.text));
  logs.set(game, log);
  return { game, ms, vs };
}
const logs = new WeakMap<Game, string[]>();
const logOf = (game: Game) => logs.get(game)!;

function put(vs: VehicleSystem, proto: string, x: number, y: number, facing: number): Vehicle {
  const v = vs.spawn(proto, Math.floor(x), Math.floor(y), 0, facing, { fuel: 100, status: 0, rng: new Rng(7), force: true })!;
  for (const p of v.parts) if (has(p, 'OPENABLE')) p.open = false;
  v.locked = false;
  v.x = x;
  v.y = y;
  v.version++;
  vs.reindex(v);
  return v;
}
function drive(vs: VehicleSystem, v: Vehicle) {
  [vs.game.player.x, vs.game.player.y] = v.mountToWorld(0, 0);
  expect(vs.takeControls(v).ok).toBe(true);
  const r = vs.startEngine(v);
  expect(r.ok, r.msg).toBe(true);
  vs.driveMode = 'direct';
}
const mph = (v: Vehicle) => v.velocity * MPH_PER_MS;
const DT = 1 / 60;
function run(game: Game, seconds: number, each?: (t: number) => void) {
  for (let t = 0; t < seconds; t += DT) {
    game.tick(DT);
    each?.(t);
  }
}
/** The outside mount at the back (rear) or front of `v`, nearest its middle column. */
function endMount(v: Vehicle, end: 'front' | 'rear'): { mx: number; my: number } {
  const [x0, y0, x1, y1] = v.bounds();
  const mx = end === 'front' ? x1 : x0, mid = (y0 + y1) / 2;
  const ys = [...new Set(v.parts.filter((p) => p.mx === mx).map((p) => p.my))].sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid));
  return { mx, my: ys[0] };
}
function cable() {
  return createItem(data, 'hd_tow_cable');
}
/** Link `tower`'s rear to `towed`'s front through the real use flow (the player carries the cable). */
function hitch(game: Game, vs: VehicleSystem, tower: Vehicle, towed: Vehicle) {
  const c = cable();
  expect(spawnItem(c, L.inv(game.player), { force: true }).ok).toBe(true);
  const a = endMount(tower, 'rear'), b = endMount(towed, 'front');
  [game.player.x, game.player.y] = vs.towing.hookWorld(tower, a);
  expect(vs.towing.useCable(c, tower, a.mx, a.my).ok).toBe(true);
  [game.player.x, game.player.y] = vs.towing.hookWorld(towed, b);
  const r = vs.towing.useCable(c, towed, b.mx, b.my);
  expect(r.ok, r.msg).toBe(true);
  const l = vs.towing.linkOf(tower)!;
  expect(l.towed).toBe(towed);
  return l;
}
/** Tower facing east at (x, y); towed parked `gap` m of paint behind it, also facing east. */
function pair(towerProto: string, towedProto: string, gap = 2) {
  const w = world();
  const tower = put(w.vs, towerProto, 60.5, 100.5, 0);
  const tb = w.vs.physRect(tower);
  const towed = put(w.vs, towedProto, 0, 100.5, 0);
  const vb = w.vs.physRect(towed);
  towed.x = tower.x + tb.x0 - gap - vb.x1;
  w.vs.reindex(towed);
  return { ...w, tower, towed };
}

/** Run with W held (and `steer(t)`) for `seconds`; returns the largest tension and hook distance seen once taut. */
function haul(game: Game, vs: VehicleSystem, tower: Vehicle, seconds: number, steer: (t: number) => number = () => 0) {
  const l = vs.towing.linkOf(tower);
  let maxT = 0, maxD = 0;
  vs.input = { throttle: 1, steer: 0, brake: false };
  run(game, seconds, (t) => {
    vs.input.steer = steer(t);
    if (l && vs.towing.links.includes(l)) (maxT = Math.max(maxT, l.tension)), (maxD = Math.max(maxD, l.dist));
  });
  return { maxT, maxD };
}
const cablesAround = (game: Game) => census([L.inv(game.player), L.hands(game.player), L.worn(game.player)]).counts.get('hd_tow_cable') ?? 0;
function groundCables(game: Game, x: number, y: number, r = 3): number {
  let n = 0;
  for (let ty = Math.floor(y) - r; ty <= Math.floor(y) + r; ty++)
    for (let tx = Math.floor(x) - r; tx <= Math.floor(x) + r; tx++) n += game.map.itemsAt(tx, ty, 0).filter((it) => it.typeId === 'hd_tow_cable').length;
  return n;
}
const angleDiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

describe('towing: BN rules', () => {
  it('tow direction is BN set_tow_directions: rear third back, middle side, front third front', () => {
    const { vs } = world();
    const car = put(vs, 'car', 30.5, 30.5, 0);
    const [x0, , x1] = car.bounds();
    expect(x1 - x0 + 1).toBeGreaterThanOrEqual(3);
    expect(towDirection(car, x1)).toBe('front');
    expect(towDirection(car, x0)).toBe('back');
    expect(towDirection(car, x0 + Math.floor((x1 - x0 + 1) / 3) + 1)).toBe('side');
  });

  it('attaching takes the cable out of your hands and into the two vehicles; detaching gives it back once', () => {
    const { game, vs, tower, towed } = pair('pickup', 'car');
    expect(cablesAround(game)).toBe(0);
    const l = hitch(game, vs, tower, towed);
    expect(cablesAround(game)).toBe(0);
    expect(tower.parts.filter((p) => has(p, 'TOW_CABLE')).length).toBe(1);
    expect(towed.parts.filter((p) => has(p, 'TOW_CABLE')).length).toBe(1);
    // the cable rides on the tower's part, once
    expect([...tower.parts, ...towed.parts].filter((p) => p.installedItem?.typeId === 'hd_tow_cable').length).toBe(1);
    expect(vs.towing.isTowing(tower) && vs.towing.isTowed(towed)).toBe(true);
    vs.towing.unlink(l, 'carry', 'You detach and re-spool the tow cable.');
    expect(cablesAround(game)).toBe(1);
    expect([...tower.parts, ...towed.parts].some((p) => has(p, 'TOW_CABLE'))).toBe(false);
    expect(vs.towing.links.length).toBe(0);
  });

  it('refuses a self-tow, an inside square, a second cable and a hook out of reach', () => {
    const { game, vs, tower, towed } = pair('pickup', 'car');
    const c = cable();
    spawnItem(c, L.inv(game.player), { force: true });
    const a = endMount(tower, 'rear');
    // out of reach
    game.player.x = tower.x + 20;
    expect(vs.towing.useCable(c, tower, a.mx, a.my).ok).toBe(false);
    [game.player.x, game.player.y] = vs.towing.hookWorld(tower, a);
    expect(vs.towing.useCable(c, tower, a.mx, a.my).ok).toBe(true);
    // the loose end on the same vehicle
    expect(vs.towing.useCable(c, tower, a.mx, a.my).msg).toMatch(/tow itself/);
    // an inside square of the other one (BN is_external_part)
    const inner = towed.parts.find((p) => !vs.towing.isExternal(towed, p.mx, p.my))!;
    expect(inner).toBeTruthy();
    [game.player.x, game.player.y] = towed.mountToWorld(inner.mx, inner.my);
    expect(vs.towing.useCable(c, towed, inner.mx, inner.my).ok).toBe(false);
    const b = endMount(towed, 'front');
    [game.player.x, game.player.y] = vs.towing.hookWorld(towed, b);
    expect(vs.towing.useCable(c, towed, b.mx, b.my).ok).toBe(true);
    // a second cable onto a towed vehicle
    const c2 = cable();
    spawnItem(c2, L.inv(game.player), { force: true });
    expect(vs.towing.useCable(c2, towed, b.mx, b.my).msg).toMatch(/already has a tow-line/);
  });

  it('the loose end you carry breaks loose past the 6-tile cable (BN process_cable)', () => {
    const { game, vs, tower } = pair('pickup', 'car');
    const c = cable();
    spawnItem(c, L.inv(game.player), { force: true });
    const a = endMount(tower, 'rear');
    [game.player.x, game.player.y] = vs.towing.hookWorld(tower, a);
    vs.towing.useCable(c, tower, a.mx, a.my);
    game.player.x -= 4;
    run(game, 0.1);
    expect(vs.towing.looseEnd()?.cable).toBe(c);
    game.player.x -= 3;
    run(game, 0.1);
    expect(vs.towing.looseEnd()).toBeNull();
    expect(logOf(game).some((m) => /over-extended cable breaks loose/.test(m))).toBe(true);
  });

  it('the cable is slack until the hooks are 7 m apart (BN 8 tiles), then pulls and holds that length', () => {
    const { game, vs, tower, towed } = pair('pickup', 'car');
    const l = hitch(game, vs, tower, towed);
    drive(vs, tower);
    const x0 = towed.x;
    let tautAt = -1;
    vs.input = { throttle: 1, steer: 0, brake: false };
    run(game, 8, (t) => {
      if (l.dist < TOW_TAUT_M - 0.05) expect(towed.x).toBe(x0);
      else if (tautAt < 0) tautAt = t;
      if (tautAt >= 0) expect(l.dist).toBeLessThan(TOW_TAUT_M + 0.1);
    });
    expect(tautAt).toBeGreaterThan(0.5);
    expect(towed.x - x0).toBeGreaterThan(15);
    expect(Math.abs(mph(towed) - mph(tower))).toBeLessThan(1.5);
    expect(angleDiff(towed.facing, tower.facing)).toBeLessThan(3);
    // steady pulling is nowhere near the overload
    expect(l.tension).toBeLessThan(CABLE_BREAK_N * 0.1);
  });
});

describe('towing: momentum', () => {
  it('a heavy load slows the tower: a pickup with a car on the cable is slower than alone', () => {
    const speed = (load: string | null) => {
      const { game, vs, tower, towed } = pair('pickup', load ?? 'car');
      if (load) hitch(game, vs, tower, towed);
      else vs.remove(towed);
      drive(vs, tower);
      haul(game, vs, tower, 8);
      return mph(tower);
    };
    const alone = speed(null), withCar = speed('car'), withTruck = speed('truck_trailer');
    expect(withCar).toBeLessThan(alone * 0.9);
    expect(withTruck).toBeLessThan(withCar);
  });

  it('momentum is exchanged equal and opposite when the cable snaps taut', () => {
    const { game, vs, tower, towed } = pair('car', 'car', 2);
    hitch(game, vs, tower, towed);
    game.player.x = 10.5;
    game.player.y = 150.5;
    tower.velocity = 8;
    tower.engineOn = false;
    const l = vs.towing.linkOf(tower)!;
    const p = () => [tower, towed].reduce(([px, py], v) => { const [vx, vy] = vs.planarVelocity(v); return [px + v.mass() * vx, py + v.mass() * vy]; }, [0, 0]);
    let before: number[] | null = null, after: number[] | null = null, frames = 0;
    run(game, 3, () => {
      if (!before && l.dist > TOW_TAUT_M - 0.2) before = p();
      if (before && !after && towed.velocity > 0.5 && ++frames > 6) after = p();
    });
    expect(before && after).toBeTruthy();
    const [bx, by] = before!, [ax, ay] = after!;
    // only rolling drag over ~0.2 s is lost
    expect(Math.abs(ax - bx) / Math.abs(bx)).toBeLessThan(0.04);
    expect(Math.abs(ay - by)).toBeLessThan(0.02 * Math.abs(bx));
    // and the car on the cable now rolls along with roughly half the speed (equal masses, inelastic)
    expect(towed.velocity).toBeGreaterThan(2.5);
    expect(tower.velocity).toBeLessThan(6);
  });

  it('a tank drags a car and barely notices', () => {
    const run1 = (load: boolean) => {
      const { game, vs, tower, towed } = pair('tank_m1_abrams', 'car');
      if (load) hitch(game, vs, tower, towed);
      else vs.remove(towed);
      drive(vs, tower);
      const x0 = towed.x;
      haul(game, vs, tower, 10);
      return { v: mph(tower), moved: towed.x - x0, linked: load ? vs.towing.links.length : 1 };
    };
    const alone = run1(false), towing = run1(true);
    expect(towing.linked).toBe(1);
    expect(towing.moved).toBeGreaterThan(25);
    expect(towing.v).toBeGreaterThan(alone.v * 0.9);
  });

  it('turning swings the towed vehicle in behind (pickup and tank, through a right-angle turn)', () => {
    for (const proto of ['pickup', 'tank_m1_abrams']) {
      const { game, vs, tower, towed } = pair(proto, 'car');
      const l = hitch(game, vs, tower, towed);
      drive(vs, tower);
      let maxD = 0, turned = false, tTurn = 0;
      const dbg: string[] = [];
      vs.input = { throttle: 1, steer: 0, brake: false };
      run(game, 14, (t) => {
        if (vs.towing.links.includes(l)) maxD = Math.max(maxD, l.dist);
        if (t > 4.5 && Math.round(t * 60) % 15 === 0) dbg.push(`${t.toFixed(1)} tw f${tower.facing.toFixed(0)} ${mph(tower).toFixed(0)}mph (${tower.x.toFixed(0)},${tower.y.toFixed(0)}) td f${towed.facing.toFixed(0)} (${towed.x.toFixed(0)},${towed.y.toFixed(0)}) d${l.dist.toFixed(2)}`);
        // drive ~5 s, then hold D until the tower has turned 90 deg, then straight again
        if (t > 5 && !turned) {
          vs.input.steer = 1;
          if (angleDiff(tower.facing, 0) >= 90) (turned = true), (tTurn = t), (vs.input.steer = 0);
        }
      });
      if (process.env.TOW_DEBUG) require('node:fs').appendFileSync(process.env.TOW_DEBUG, `${proto}\n${dbg.join('\n')}\n`);
      expect(turned, proto).toBe(true);
      expect(vs.towing.links.length, proto).toBe(1);
      expect(maxD, proto).toBeLessThan(TOW_TAUT_M + 0.15);
      // swung round with it and trailing behind (its hook on the tower's line, not off to the side)
      expect(angleDiff(towed.facing, tower.facing), proto + '\n' + dbg.join('\n')).toBeLessThan(8);
      const [ax, ay] = vs.towing.hookWorld(tower, l.a), [bx, by] = vs.towing.hookWorld(towed, l.b);
      const back = (((Math.atan2(by - ay, bx - ax) * 180) / Math.PI - tower.facing + 540) % 360) - 180;
      expect(Math.abs(Math.abs(back) - 180), proto + '\n' + dbg.join('\n')).toBeLessThan(10);
      expect(14 - tTurn, proto).toBeGreaterThan(4);
    }
  });
});

describe('towing: stopping', () => {
  it('when the tower brakes, the slack car brakes too (BN rl_dist < 6) instead of rear-ending it', () => {
    const { game, vs, tower, towed } = pair('pickup', 'car');
    const l = hitch(game, vs, tower, towed);
    drive(vs, tower);
    haul(game, vs, tower, 7);
    expect(mph(tower)).toBeGreaterThan(20);
    let minD = Infinity;
    // the handbrake (S held would reverse into the car once stopped)
    vs.input = { throttle: 0, steer: 0, brake: true };
    run(game, 6, () => (minD = Math.min(minD, l.dist)));
    expect(Math.abs(towed.velocity)).toBeLessThan(0.2);
    // the bodies never met: hooks stayed well apart (it stops ~6 m back), and no crash was logged
    expect(minD).toBeGreaterThan(4);
    expect(logOf(game).some((m) => /rams into|smash|crunch/i.test(m)), logOf(game).join(' | ')).toBe(false);
  });
});

describe('towing: breaking', () => {
  it('snaps at 25 tiles (BN tow_cable_too_far): both parts come off, the cable falls once', () => {
    const { game, vs, tower, towed } = pair('pickup', 'car');
    hitch(game, vs, tower, towed);
    towed.x -= TOW_SNAP_M + 3;
    vs.reindex(towed);
    run(game, 0.05);
    expect(vs.towing.links.length).toBe(0);
    expect(logOf(game).some((m) => /towing cable snaps off of the car/i.test(m))).toBe(true);
    expect([...tower.parts, ...towed.parts].some((p) => has(p, 'TOW_CABLE'))).toBe(false);
    const [hx, hy] = tower.mountToWorld(tower.bounds()[0], 0);
    expect(groundCables(game, hx, hy, 4)).toBe(1);
  });

  it('snaps across z-levels and when a cable part is destroyed', () => {
    {
      const { game, vs, tower, towed } = pair('pickup', 'car');
      hitch(game, vs, tower, towed);
      towed.z = 1;
      run(game, 0.05);
      expect(vs.towing.links.length).toBe(0);
    }
    {
      const { game, vs, tower, towed } = pair('pickup', 'car');
      hitch(game, vs, tower, towed);
      vs.damagePart(towed, towed.parts.find((p) => has(p, 'TOW_CABLE'))!, 10_000);
      run(game, 0.05);
      expect(vs.towing.links.length).toBe(0);
      expect(logOf(game).some((m) => /tow cable between .* breaks/.test(m))).toBe(true);
    }
  });

  it('overload: an Abrams yanking another Abrams off the slack snaps it; the same pull gently does not', () => {
    const yank = (speed: number) => {
      const { game, vs, tower, towed } = pair('tank_m1_abrams', 'tank_m1_abrams', 3);
      hitch(game, vs, tower, towed);
      game.player.x = 10.5;
      game.player.y = 150.5;
      tower.velocity = speed;
      let maxT = 0;
      const l = vs.towing.linkOf(tower)!;
      run(game, 3, () => vs.towing.links.includes(l) && (maxT = Math.max(maxT, l.tension)));
      return { snapped: vs.towing.links.length === 0, maxT, log: logOf(game).join(' | ') };
    };
    const hard = yank(8), soft = yank(1);
    expect(hard.snapped, hard.log).toBe(true);
    expect(hard.log).toMatch(/snaps under the strain/);
    expect(soft.snapped).toBe(false);
    expect(soft.maxT).toBeLessThan(CABLE_BREAK_N);
  });

  it('BN: a tower too weak for the combined mass struggles and cannot pull it', () => {
    const { game, vs, tower, towed } = pair('golf_cart', 'tank_m1_abrams');
    hitch(game, vs, tower, towed);
    drive(vs, tower);
    const m = tower.mass(), m2 = towed.mass();
    // BN ground_acceleration with the towed mass added, under 89 vmiph/turn
    expect((tower.acceleration(1, 1) * m) / (m + m2)).toBeLessThan(TOW_MIN_ACCEL);
    const x0 = towed.x;
    haul(game, vs, tower, 8);
    expect(logOf(game).some((msg) => /struggles to pull the .* on this surface/.test(msg))).toBe(true);
    expect(towed.x - x0).toBeLessThan(1.5);
  });
});

describe('towing: save and load', () => {
  it('keeps the link, the parts and the cable, and towing goes on after the load', () => {
    const a = pair('pickup', 'car');
    hitch(a.game, a.vs, a.tower, a.towed);
    drive(a.vs, a.tower);
    haul(a.game, a.vs, a.tower, 3);
    const j = JSON.parse(JSON.stringify(a.vs.toJSON()));
    expect(j.tows).toHaveLength(1);
    const b = world();
    const warns: string[] = [];
    b.vs.fromJSON(data, j, { warn: (w) => warns.push(w) });
    expect(warns).toEqual([]);
    expect(b.vs.towing.links).toHaveLength(1);
    const l = b.vs.towing.links[0];
    expect(l.tower.uid).toBe(a.tower.uid);
    expect(l.towed.uid).toBe(a.towed.uid);
    expect(l.tower.parts.find((p) => has(p, 'TOW_CABLE'))?.installedItem).toBeTruthy();
    // drive on: still towing
    b.vs.driving = null;
    drive(b.vs, l.tower);
    const x0 = l.towed.x;
    haul(b.game, b.vs, l.tower, 3);
    expect(b.vs.towing.links).toHaveLength(1);
    expect(l.towed.x - x0).toBeGreaterThan(5);
    // a link whose vehicle is gone is dropped loudly, and the leftover cable part comes off as the cable
    const j2 = JSON.parse(JSON.stringify(j));
    j2.vehicles = j2.vehicles.filter((v: { uid: number }) => v.uid !== a.towed.uid);
    const c = world();
    const w2: string[] = [];
    c.vs.fromJSON(data, j2, { warn: (w) => w2.push(w) });
    expect(c.vs.towing.links).toHaveLength(0);
    expect(w2.some((w) => /dropped a tow link/.test(w))).toBe(true);
    const t = c.vs.list.find((v) => v.uid === a.tower.uid)!;
    expect(t.parts.some((p) => has(p, 'TOW_CABLE'))).toBe(false);
    expect(groundCables(c.game, t.x, t.y, 6)).toBe(1);
  });
});
