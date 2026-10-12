// Grab and drag (BN `G`): furniture push / pull / nudge, strength, blocked cases, contents moving
// with container furniture (conserved through moves.ts), vehicles pushed by hand, and monsters
// pathing around a dragged barricade. Rules: BN game.cpp grabbed_furn_move, grab.cpp, map::move_furn.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Rng } from '../src/core/rng';
import type { GameData } from '../src/data/types';
import { Game } from '../src/game/game';
import { grab, grabbedMove, grabState, release, setGrabRng, furnitureEffort, vehicleStrReq } from '../src/game/grab';
import { createItem } from '../src/game/item';
import { Grid } from '../src/game/los';
import { census, L, spawnOnGround } from '../src/game/moves';
import { findPath, tileCost } from '../src/game/pathfind';
import { interactionProviders, interactionsAt } from '../src/game/interact';
import type { VehicleDataFile } from '../src/game/vehicle_data';
import { VehicleSystem } from '../src/game/vehicles';
import { recentSounds } from '../src/game/sound';
import type { Chunk, ChunkGenerator, GameMap } from '../src/world/map';
import { loadNodeData } from '../tools/lib/node_data';

let data: GameData;
let vdata: VehicleDataFile;
beforeAll(() => {
  data = loadNodeData().game;
  vdata = JSON.parse(readFileSync(resolve('public/data/vehicles.json'), 'utf8'));
});

// Chunk (0,0): floor everywhere, a wall along x = 12 with a doorway (open door) at (12, 5).
// East of the wall: pavement.
class RoomGen implements ChunkGenerator {
  generate(map: GameMap, c: Chunk): void {
    c.empty = false;
    if (c.z !== 0) return void c.ter.fill(map.terrain.index(c.z > 0 ? 't_open_air' : 't_rock'));
    c.ter.fill(map.terrain.index('t_pavement'));
    if (c.cx !== 0 || c.cy !== 0) return;
    for (let y = 0; y < 24; y++)
      for (let x = 0; x < 24; x++) {
        const id = x < 12 ? 't_floor' : x === 12 ? (y === 5 ? 't_door_o' : 't_wall') : 't_pavement';
        c.ter[y * 24 + x] = map.terrain.index(id);
      }
  }
}

const stubInput = () => ({ held: new Set<string>(), captured: false, mouseButtons: 0, onPress() {}, consumeMouse: () => [0, 0], consumeClicks: () => [] }) as any;

/** No strain / heavy-furniture luck unless a test asks for it. */
const calm = { oneIn: () => false, dice: (n: number) => n, next: () => 0.5, int: (lo: number) => lo, chance: () => false } as unknown as Rng;

function world(str = 10) {
  const game = new Game(data, 5, stubInput());
  game.map.generator = new RoomGen();
  for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) game.map.chunk(x, y, 0);
  const vs = new VehicleSystem(game, vdata);
  game.vehicles = vs;
  game.systems.push(vs);
  const log: string[] = [];
  game.events.on('message', (m) => log.push(m.text));
  game.player.str_base = str;
  setGrabRng(game, calm);
  const at = (x: number, y: number) => {
    game.player.x = x + 0.5;
    game.player.y = y + 0.5;
    game.player.z = 0;
  };
  /** Walk the player one tile when the grab lets them (what src/grab.ts does in real time). */
  const step = (dx: number, dy: number) => {
    const r = grabbedMove(game, dx, dy);
    if (!r.handled) at(game.player.tileX + dx, game.player.tileY + dy);
    return r;
  };
  return { game, vs, log, at, step, furn: (x: number, y: number) => game.map.furnAt(x, y, 0).id };
}

describe('grab', () => {
  it('grabs adjacent movable furniture, refuses what BN refuses, and lets go on the grab key', () => {
    const w = world();
    w.at(5, 5);
    w.game.map.setFurn(6, 5, 0, 'f_dresser');
    w.game.map.setFurn(4, 5, 0, 'f_fridge'); // BN required_str -1
    expect(grab(w.game, 4, 5, 0)).toEqual({ ok: false, msg: 'You can not grab the refrigerator' });
    expect(grab(w.game, 5, 7, 0).ok).toBe(false); // out of reach
    expect(grab(w.game, 5, 4, 0)).toEqual({ ok: false, msg: "There's nothing to grab there!" });
    expect(grab(w.game, 6, 5, 0)).toEqual({ ok: true, msg: 'You grab the dresser.' });
    expect(grabState(w.game)).toEqual({ kind: 'furniture', dx: 1, dy: 0 });
    expect(release(w.game)).toBe('You release the dresser.');
    expect(grabState(w.game)).toBeNull();
  });

  it('a weak survivor is warned the heavy safe feels really heavy', () => {
    const w = world(8);
    w.at(5, 5);
    w.game.map.setFurn(6, 5, 0, 'f_safe_c');
    expect(grab(w.game, 6, 5, 0).msg).toBe('You grab the safe. It feels really heavy.');
  });

  it('pushes a dresser: it slides ahead, you follow, costs str_req × 10 moves and stamina, scrapes', () => {
    const w = world(10);
    w.at(5, 5);
    w.game.map.setFurn(6, 5, 0, 'f_dresser');
    grab(w.game, 6, 5, 0);
    const eff = furnitureEffort(w.game, 6, 5, 0);
    expect(eff.strReq).toBe(8);
    expect(eff.moveCost).toBe(80);
    const stamina = w.game.player.stamina;
    const r = w.step(1, 0);
    expect(r).toMatchObject({ handled: false, moves: 80, furniture: { id: 'f_dresser', from: [6, 5, 0], to: [7, 5, 0] } });
    expect(w.furn(6, 5)).toBe('f_null');
    expect(w.furn(7, 5)).toBe('f_dresser');
    expect(w.game.player.tileX).toBe(6);
    expect(grabState(w.game)).toEqual({ kind: 'furniture', dx: 1, dy: 0 });
    expect(w.game.player.stamina).toBeLessThan(stamina);
    const s = recentSounds(w.game).find((x) => x.description === 'a scraping noise.');
    expect(s?.volume).toBe(56); // min(80, 40 + 8 × 2)
  });

  it('pulls a chair: walking away drags it into the tile you left', () => {
    const w = world();
    w.at(5, 5);
    w.game.map.setFurn(6, 5, 0, 'f_chair');
    grab(w.game, 6, 5, 0);
    const r = w.step(-1, 0);
    expect(r.handled).toBe(false);
    expect(w.furn(5, 5)).toBe('f_chair');
    expect(w.game.player.tileX).toBe(4);
    expect(grabState(w.game)).toEqual({ kind: 'furniture', dx: 1, dy: 0 });
  });

  it('pulling needs room behind you', () => {
    const w = world();
    w.at(5, 5);
    w.game.map.setFurn(6, 5, 0, 'f_chair');
    w.game.map.setFurn(4, 5, 0, 'f_dresser');
    grab(w.game, 6, 5, 0);
    expect(w.step(-1, 0)).toMatchObject({ handled: true, moves: 50 });
    expect(w.log.at(-1)).toBe('The chair collides with something.');
    expect(w.furn(6, 5)).toBe('f_chair');
  });

  it('sideways nudges it while you stay; a second nudge out of reach lets go', () => {
    const w = world();
    w.at(5, 5);
    w.game.map.setFurn(6, 5, 0, 'f_chair');
    grab(w.game, 6, 5, 0);
    expect(w.step(0, 1).handled).toBe(true);
    expect(w.furn(6, 6)).toBe('f_chair');
    expect(w.game.player.tileY).toBe(5);
    expect(grabState(w.game)).toEqual({ kind: 'furniture', dx: 1, dy: 1 });
    const r = w.step(0, 1);
    expect(r.released).toBe(true);
    expect(w.furn(6, 7)).toBe('f_chair');
    expect(w.log.at(-1)).toBe('You let go of the chair.');
  });

  it('blocked by a wall: collides, nothing moves', () => {
    const w = world();
    w.at(10, 8);
    w.game.map.setFurn(11, 8, 0, 'f_dresser');
    grab(w.game, 11, 8, 0);
    expect(w.step(1, 0)).toMatchObject({ handled: true, moves: 50 });
    expect(w.furn(11, 8)).toBe('f_dresser');
    expect(w.game.player.tileX).toBe(10);
    expect(w.log.at(-1)).toBe('The dresser collides with something.');
  });

  it("too heavy: a weak survivor can't budge the safe; a strong one moves it slowly", () => {
    const weak = world(8);
    weak.at(5, 5);
    weak.game.map.setFurn(6, 5, 0, 'f_safe_c');
    grab(weak.game, 6, 5, 0);
    expect(weak.step(1, 0)).toMatchObject({ handled: true });
    expect(weak.log.at(-1)).toBe('The safe is too heavy for you to budge.');
    expect(weak.furn(6, 5)).toBe('f_safe_c');
    // str 12 vs 14: within 3 → "really heavy", 3000+ moves, but it goes (the one_in(3) fail is off)
    const mid = world(12);
    mid.at(5, 5);
    mid.game.map.setFurn(6, 5, 0, 'f_safe_c');
    grab(mid.game, 6, 5, 0);
    const r = mid.step(1, 0);
    expect(r.handled).toBe(false);
    expect(r.moves).toBe(140 + 3000 + 296);
    expect(mid.log).toContain('The safe is really heavy!');
    expect(mid.furn(7, 5)).toBe('f_safe_c');
    // BN strain: one_in(max(20 - req - str, 2)) hurts instead of moving
    const strained = world(8);
    strained.at(5, 5);
    strained.game.map.setFurn(6, 5, 0, 'f_safe_c');
    grab(strained.game, 6, 5, 0);
    setGrabRng(strained.game, { ...calm, oneIn: () => true } as unknown as Rng);
    const pain = strained.game.player.pain;
    expect(strained.step(1, 0)).toMatchObject({ handled: true, moves: 100 });
    expect(strained.game.player.pain).toBe(pain + 1);
  });

  it('container furniture carries its contents; items on a table stay behind; all conserved', () => {
    const w = world(14);
    w.at(5, 5);
    const map = w.game.map;
    map.setFurn(6, 5, 0, 'f_dresser');
    spawnOnGround(map, 6, 5, 0, createItem(data, 'jeans'));
    spawnOnGround(map, 6, 5, 0, createItem(data, 'tshirt'));
    const locs = () => [5, 6, 7, 8].flatMap((x) => [4, 5, 6].map((y) => L.ground(map, x, y, 0)));
    const before = census(locs()).counts;
    grab(w.game, 6, 5, 0);
    w.step(1, 0);
    expect(map.itemsAt(7, 5, 0).map((i) => (i as { typeId: string }).typeId).sort()).toEqual(['jeans', 'tshirt']);
    expect(map.itemsAt(6, 5, 0)).toEqual([]);
    expect(census(locs()).counts).toEqual(before);
    // contents weigh in: 1 str per 4 kg on the tile
    // a table (not a CONTAINER) leaves its items on the floor
    release(w.game);
    w.at(5, 4);
    map.setFurn(6, 4, 0, 'f_table');
    spawnOnGround(map, 6, 4, 0, createItem(data, 'rock'));
    grab(w.game, 6, 4, 0);
    w.step(1, 0);
    expect(w.furn(7, 4)).toBe('f_table');
    expect(map.itemsAt(6, 4, 0).map((i) => (i as { typeId: string }).typeId)).toEqual(['rock']);
    expect(w.log).toContain('Stuff spills from the table!');
  });

  it("won't shove a table onto a cluttered tile", () => {
    const w = world();
    w.at(5, 5);
    w.game.map.setFurn(6, 5, 0, 'f_table');
    spawnOnGround(w.game.map, 7, 5, 0, createItem(data, 'rock'));
    grab(w.game, 6, 5, 0);
    expect(w.step(1, 0)).toMatchObject({ handled: true, moves: 50 });
    expect(w.log.at(-1)).toBe("There's stuff in the way.");
  });

  it('barricading: a dresser pushed into the doorway blocks it, and a zombie has to bash through or go round', () => {
    const w = world();
    const grid = new Grid(w.game.map);
    const open = findPath(grid, 14, 5, 8, 5, 0, { bash: true, maxNodes: 4000 });
    expect(open.tiles.some(([x, y]) => x === 12 && y === 5)).toBe(true);
    w.at(10, 5);
    w.game.map.setFurn(11, 5, 0, 'f_dresser');
    grab(w.game, 11, 5, 0);
    expect(w.step(1, 0).handled).toBe(false); // into the open doorway (t_door_o is FLAT)
    expect(w.furn(12, 5)).toBe('f_dresser');
    expect(w.game.map.passable(12, 5, 0)).toBe(false);
    grid.reset();
    // a zombie that can't bash no longer gets in through the doorway
    const walkers = findPath(grid, 14, 5, 8, 5, 0, { maxNodes: 20000, margin: 30 });
    expect(walkers.tiles.some(([x, y]) => x === 12 && y === 5)).toBe(false);
    // bashers see a bashable obstacle there now, priced by its bash strength (monmove bash_at)
    expect(tileCost(grid, 12, 5, 0, {})).toBe(Infinity);
    const bashCost = tileCost(grid, 12, 5, 0, { bash: true });
    expect(bashCost).toBeGreaterThan(5);
    expect(bashCost).toBeLessThan(Infinity);
  });
});

describe('grab: vehicles pushed by hand', () => {
  it('pushes and pulls a shopping cart; a wall stops it without damage', () => {
    const w = world(8);
    const cart = w.vs.spawn('shopping_cart', 16, 10, 0, 0, { force: true })!;
    expect(cart).toBeTruthy();
    expect(vehicleStrReq(w.game, cart)).toBeLessThanOrEqual(1);
    w.at(15, 10);
    expect(grab(w.game, 16, 10, 0)).toEqual({ ok: true, msg: 'You grab the Shopping Cart.' });
    const r = w.step(1, 0);
    expect(r.handled).toBe(false);
    expect(Math.floor(cart.x)).toBe(17);
    expect(w.vs.at(17, 10, 0)?.v).toBe(cart);
    expect(w.game.player.tileX).toBe(16);
    expect(grabState(w.game)).toEqual({ kind: 'vehicle', dx: 1, dy: 0 });
    // pull it back west
    w.step(-1, 0);
    expect(w.vs.at(16, 10, 0)?.v).toBe(cart);
    expect(w.game.player.tileX).toBe(15);
    // walk it into the wall at x = 12
    const hp = cart.parts.map((p) => p.hp);
    w.step(-1, 0); // cart 15, you 14
    w.step(-1, 0); // cart 14, you 13
    const blocked = w.step(-1, 0); // you'd step into the wall: no room
    expect(blocked.handled).toBe(true);
    // from the east side, push it into the wall at x = 12
    release(w.game);
    w.at(15, 10);
    grab(w.game, 14, 10, 0);
    expect(w.step(-1, 0).handled).toBe(false); // cart 13, you 14
    const b = w.step(-1, 0);
    expect(b.handled).toBe(true);
    expect(w.log.at(-1)).toMatch(/^The Shopping Cart collides with the /);
    expect(w.vs.at(13, 10, 0)?.v).toBe(cart);
    expect(cart.parts.map((p) => p.hp)).toEqual(hp);
  });
});

describe('grab in the e menu', () => {
  it("rides along last: e on a dresser still looks inside, e on a chair still examines it", () => {
    const w = world();
    w.at(5, 5);
    w.game.map.setFurn(6, 5, 0, 'f_dresser');
    w.game.map.setFurn(5, 6, 0, 'f_chair');
    // what src/grab.ts registers
    const prov = () => [{ id: 'grab', label: 'Grab it', run: () => {} }];
    interactionProviders.push(prov);
    try {
      expect(interactionsAt(w.game, 6, 5, 0).map((i) => i.id)).toEqual(['pickup', 'deconstruct_furniture', 'grab']);
      expect(interactionsAt(w.game, 5, 6, 0).map((i) => i.id)).toEqual(['describe', 'deconstruct_furniture', 'grab']);
    } finally {
      interactionProviders.splice(interactionProviders.indexOf(prov), 1);
    }
  });
});
