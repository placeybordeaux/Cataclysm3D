// Walkable stairs (docs/STAIRS.md): the link solver on BN-like layouts, the climbing paths,
// walking up and down with real (held-key) input, the key shortcut, saving mid-climb and a
// zombie following the survivor up a flight. Against the real extracted terrain data.
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { GameData } from '../src/data/types';
import type { Chunk, ChunkGenerator, GameMap } from '../src/world/map';
import type { Input } from '../src/core/input';
import { Game } from '../src/game/game';
import { LEVEL_HEIGHT } from '../src/world/coords';
import { StairIndex, SWITCH_H, type StairVariant } from '../src/game/stairs';
import { climbOf, liftOf } from '../src/game/stairwalk';
import { installStairs } from '../src/stairs';
import { fallIfUnsupported, goStairs, installZLevels } from '../src/game/zlevels';
import { MonsterSystem } from '../src/game/monai';
import { NpcSystem } from '../src/game/npcai';
import { Dialogue } from '../src/game/talk';
import { installStairNpcs } from '../src/stairs';

const dir = path.join(__dirname, '../public/data');
const load = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
let data: GameData;

beforeAll(() => {
  data = {
    terrain: load('terrain.json'), furniture: load('furniture.json'), items: load('items.json'),
    itemGroups: load('item_groups.json'), monsters: load('monsters.json'), monsterGroups: load('monster_groups.json'), recipes: [], misc: load('misc.json'),
  };
});

const LEGEND: Record<string, [string, string?]> = {
  '#': ['t_wall'], '.': ['t_floor'], '<': ['t_wood_stairs_up'], '>': ['t_wood_stairs_down'],
  H: ['t_ladder_up'], h: ['t_ladder_down'], ' ': ['t_open_air'], '+': ['t_door_c'], L: ['t_door_locked'], c: ['t_floor', 'f_chair'],
};

/** Levels drawn as ASCII from (0, 0); everything else is wall (below 1) or open air. */
class AsciiGen implements ChunkGenerator {
  constructor(private levels: Record<number, string[]>) {}
  generate(map: GameMap, c: Chunk): void {
    c.empty = false;
    c.ter.fill(map.terrain.index(c.z >= 1 ? 't_open_air' : 't_wall'));
    const rows = this.levels[c.z];
    if (!rows) return;
    for (let y = 0; y < rows.length; y++)
      for (let x = 0; x < rows[y].length; x++) {
        const lx = x - c.cx * 24, ly = y - c.cy * 24;
        if (lx < 0 || ly < 0 || lx >= 24 || ly >= 24) continue;
        const [t, f] = LEGEND[rows[y][x]] ?? (() => { throw new Error(`legend: ${rows[y][x]}`); })();
        c.ter[ly * 24 + lx] = map.terrain.index(t);
        if (f) c.furn[ly * 24 + lx] = map.furniture.index(f);
      }
  }
}

function input(): Input {
  return { held: new Set<string>(), captured: false, mouseButtons: 0, onPress() {}, consumeMouse: () => [0, 0], consumeClicks: () => [] } as unknown as Input;
}

function world(levels: Record<number, string[]>, variant: StairVariant = 'flight') {
  const game = new Game(data, 3, input());
  game.map.generator = new AsciiGen(levels);
  for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) for (let z = -1; z <= 2; z++) game.map.chunk(x, y, z);
  installZLevels(game);
  const sys = new MonsterSystem(game);
  game.systems.push(sys);
  const stairs = installStairs(game, { monsters: sys, variant });
  game.clock.seconds = 12 * 3600;
  return { game, sys, stairs, walker: stairs.walker };
}

function solve(levels: Record<number, string[]>, variant: StairVariant, x: number, y: number, z = 0) {
  const { game } = world(levels, variant);
  const idx = new StairIndex(game.map, variant);
  idx.ensureAround(x, y, z, 1);
  return { link: idx.at(x, y, z), idx, game };
}

const step = (game: Game, seconds: number, each?: () => void) => {
  for (let i = 0; i < Math.round(seconds * 30); i++) {
    game.tick(1 / 30);
    each?.();
  }
};

// A pocket at the end of a 1-wide corridor on both floors (BN house_16's basement stair):
// you walk in from the north and leave to the north upstairs.
const POCKET = {
  0: ['#####', '#...#', '##.##', '##.##', '##<##', '#####'],
  1: ['#####', '#...#', '##.##', '##c##', '##>##', '#####'],
};
// An L: in from the north, out to the east upstairs.
const ELL = {
  0: ['#####', '##.##', '##<##', '#####'],
  1: ['#####', '#####', '##>.#', '#####'],
};
// A long hall: room for a real flight on both floors.
const HALL = {
  0: ['#########', '#.......#', '#...<...#', '#.......#', '#########'],
  1: ['#########', '#.......#', '#...>...#', '#.......#', '#########'],
};
// The evac shelter's 2x2 stairs in an open room.
const WIDE = {
  0: ['########', '#......#', '#..<<..#', '#..<<..#', '#......#', '########'],
  1: ['########', '#......#', '#..>>..#', '#..>>..#', '#......#', '########'],
};
const LADDER = {
  0: ['#####', '#...#', '#.H.#', '#####'],
  1: ['#####', '#...#', '#.h.#', '#####'],
};

describe('stair link solver', () => {
  it('a U-shaped pocket becomes a one-turn spiral in the stair tile, landings on the only free sides', () => {
    for (const v of ['flight', 'compact'] as StairVariant[]) {
      const { link } = solve(POCKET, v, 2, 4);
      expect(link?.shape).toBe('spiral');
      expect(Math.abs(link!.spiral!.sweep)).toBeCloseTo(2 * Math.PI, 5);
      expect(link!.bottom).toEqual([[2, 3]]);
      expect(link!.top).toEqual([[2, 3]]);
      expect(link!.lower).toEqual([[2, 4]]);
    }
  });

  it('an L-turn becomes a 450° spiral turning toward the exit', () => {
    const { link } = solve(ELL, 'flight', 2, 2);
    expect(link?.shape).toBe('spiral');
    expect(Math.abs(link!.spiral!.sweep)).toBeCloseTo(2.5 * Math.PI, 5);
    expect(link!.top).toEqual([[3, 2]]);
  });

  it('with room, `flight` lays a 3-tile flight over free floor; `compact` keeps it in the tile', () => {
    const f = solve(HALL, 'flight', 4, 2);
    expect(f.link?.shape).toBe('straight');
    expect(f.link!.run).toBe(3);
    expect(f.link!.lower.length).toBe(3);
    expect(f.link!.upper).toEqual(f.link!.lower);
    const c = solve(HALL, 'compact', 4, 2);
    expect(c.link?.shape).toBe('straight');
    expect(c.link!.run).toBe(1);
  });

  it('2x2 stairs become one 2-wide flight across the block', () => {
    const c = solve(WIDE, 'compact', 3, 2);
    expect(c.link?.shape).toBe('straight');
    expect(c.link!.width).toBe(2);
    expect(c.link!.run).toBe(2);
    expect(c.link!.lower.length).toBe(4);
    // every block tile belongs to it
    for (const [x, y] of [[3, 2], [4, 2], [3, 3], [4, 3]]) expect(c.idx.at(x, y, 0)).toBe(c.link);
  });

  it('ladders are ladders, against a wall', () => {
    const { link } = solve(LADDER, 'flight', 2, 2);
    expect(link?.shape).toBe('ladder');
    expect(link!.kind).toBe('ladder');
  });

  it('a stair you walk across upstairs to reach another room stays classic (a stairwell would cut it off)', () => {
    const CUT = {
      0: ['#########', '#.......#', '#...<...#', '#########'],
      1: ['#########', '#########', '#...>...#', '#########'],
    };
    expect(solve(CUT, 'flight', 4, 2).link).toBeNull();
    expect(solve(CUT, 'compact', 4, 2).link).toBeNull();
  });

  it('a flight never cuts a floor apart: everything walkable still reaches the landings', () => {
    const ROOMS = {
      0: ['#########', '#...#...#', '#...<...#', '#.......#', '#########'],
      1: ['#########', '#.......#', '#...>.#.#', '#.....#.#', '#########'],
    };
    for (const v of ['flight', 'compact'] as StairVariant[]) {
      const { link, game } = solve(ROOMS, v, 4, 2);
      expect(link).toBeTruthy();
      const foot = new Set(link!.lower.map(([x, y]) => `${x},${y}`));
      for (const z of [0, 1]) {
        const walk = (x: number, y: number) => game.map.passable(x, y, z) && !foot.has(`${x},${y}`);
        const goal = z === 0 ? link!.bottom[0] : link!.top[0];
        const seen = new Set([goal.join(',')]);
        const q = [goal];
        while (q.length) {
          const [x, y] = q.pop()!;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const k = `${x + dx},${y + dy}`;
            if (!seen.has(k) && walk(x + dx, y + dy)) (seen.add(k), q.push([x + dx, y + dy]));
          }
        }
        for (let y = 0; y < 5; y++) for (let x = 0; x < 9; x++) if (walk(x, y) && !seen.has(`${x},${y}`)) throw new Error(`${v} z${z} tile ${x},${y} cut off`);
      }
    }
  });

  it('paths are continuous, rise monotonically from floor to floor and end in the landings', () => {
    for (const [lv, x, y, v] of [[POCKET, 2, 4, 'flight'], [ELL, 2, 2, 'flight'], [HALL, 4, 2, 'flight'], [HALL, 4, 2, 'compact'], [WIDE, 3, 2, 'compact'], [LADDER, 2, 2, 'flight']] as const) {
      const { link } = solve(lv, v as StairVariant, x, y);
      const P = link!.path;
      let prev = P.at(0);
      expect(prev.h).toBe(0);
      for (let s = 0.02; s <= P.len; s += 0.02) {
        const q = P.at(s);
        expect(Math.hypot(q.x - prev.x, q.y - prev.y, q.h - prev.h)).toBeLessThan(0.05);
        expect(q.h).toBeGreaterThanOrEqual(prev.h - 1e-9);
        // facing never jumps (the view turns with it)
        expect(Math.abs(q.head - prev.head)).toBeLessThan(0.35);
        prev = q;
      }
      expect(P.at(P.len).h).toBeCloseTo(LEVEL_HEIGHT, 6);
      const has = (tiles: [number, number][], x: number, y: number) => tiles.some(([a, b]) => a === Math.floor(x) && b === Math.floor(y));
      expect(has(link!.bottom, P.at(0).x, P.at(0).y)).toBe(true);
      expect(has(link!.top, P.at(P.len).x, P.at(P.len).y)).toBe(true);
    }
  });

  it('classic has no links', () => {
    const { link } = solve(HALL, 'classic', 4, 2);
    expect(link).toBeNull();
  });
});

/** Stand on the bottom (or top) landing looking onto the flight. */
function standAt(game: Game, walker: ReturnType<typeof world>['walker'], x: number, y: number, top = false) {
  walker.prepare();
  const l = walker.linkAt(x, y, 0)!;
  const e = l.path.at(top ? l.path.len : 0);
  const p = game.player;
  p.x = e.x;
  p.y = e.y;
  p.z = top ? 1 : 0;
  p.yaw = e.head + (top ? Math.PI : 0);
  return l;
}

describe('walking the stairs', () => {
  for (const [name, lv, x, y, v] of [['pocket spiral', POCKET, 2, 4, 'flight'], ['L spiral', ELL, 2, 2, 'flight'], ['long flight', HALL, 4, 2, 'flight'], ['steep flight', HALL, 4, 2, 'compact'], ['2-wide flight', WIDE, 3, 2, 'compact'], ['ladder', LADDER, 2, 2, 'flight']] as const) {
    it(`${name}: holding W carries you up and back down, the eye rising and falling smoothly`, () => {
      const { game, walker } = world(lv, v as StairVariant);
      const l = standAt(game, walker, x, y);
      const p = game.player;
      const eye = () => p.z * LEVEL_HEIGHT + liftOf(p);
      game.input.held.add('KeyW');
      let last = eye(), t = 0, maxH = 0;
      while (!(p.z === 1 && !climbOf(p)) && t < 10) {
        step(game, 1 / 30);
        t += 1 / 30;
        expect(Math.abs(eye() - last)).toBeLessThan(0.15);
        expect(eye()).toBeGreaterThanOrEqual(last - 1e-6);
        maxH = Math.max(maxH, eye());
        last = eye();
      }
      expect(p.z).toBe(1);
      expect(climbOf(p)).toBeUndefined();
      expect(liftOf(p)).toBe(0);
      expect(l.top.some(([a, b]) => a === Math.floor(p.x) && b === Math.floor(p.y))).toBe(true);
      // a flight takes a moment (no teleport), a ladder longer
      expect(t).toBeGreaterThan(v === 'compact' ? 0.7 : 0.9);
      expect(t).toBeLessThan(l.kind === 'ladder' ? 6 : 3.5);
      // you arrive facing onward (spirals turn you with them): W keeps walking away from the well
      const facing = Math.atan2(Math.sin(p.yaw), -Math.cos(p.yaw));
      const out = l.path.at(l.path.len).head;
      expect(Math.cos(facing - Math.atan2(Math.sin(out), -Math.cos(out)))).toBeGreaterThan(0.9);
      game.input.held.delete('KeyW');
      // and back down: turn round, walk into the well
      p.yaw += Math.PI;
      game.input.held.add('KeyW');
      t = 0;
      last = eye();
      while (!(p.z === 0 && !climbOf(p)) && t < 10) {
        step(game, 1 / 30);
        t += 1 / 30;
        expect(eye()).toBeLessThanOrEqual(last + 1e-6);
        last = eye();
      }
      expect(p.z).toBe(0);
      expect(l.bottom.some(([a, b]) => a === Math.floor(p.x) && b === Math.floor(p.y))).toBe(true);
    });
  }

  it('the level switches where the eye passes the ceiling, not at the top', () => {
    const { game, walker } = world(HALL, 'flight');
    standAt(game, walker, 4, 2);
    const p = game.player;
    game.input.held.add('KeyW');
    let switched = -1;
    for (let i = 0; i < 200 && switched < 0; i++) {
      step(game, 1 / 30);
      const c = climbOf(p);
      if (c && p.z === 1) switched = c.h;
    }
    expect(switched).toBeGreaterThanOrEqual(SWITCH_H);
    expect(switched).toBeLessThan(SWITCH_H + 0.2);
  });

  it('running is faster, but not twice as fast; crouching is slower', () => {
    const time = (mod: 'walk' | 'run' | 'crouch') => {
      const { game, walker } = world(HALL, 'flight');
      standAt(game, walker, 4, 2);
      const p = game.player;
      game.input.held.add('KeyW');
      if (mod === 'run') game.input.held.add('ShiftLeft');
      if (mod === 'crouch') p.crouching = true;
      let t = 0;
      while (!(p.z === 1 && !climbOf(p)) && t < 20) (step(game, 1 / 30), (t += 1 / 30));
      return t;
    };
    const walk = time('walk'), run = time('run'), crouch = time('crouch');
    expect(run).toBeLessThan(walk * 0.85);
    expect(run).toBeGreaterThan(walk * 0.55);
    expect(crouch).toBeGreaterThan(walk * 1.5);
  });

  it('sideways into a flight is a wall; only its ends let you on', () => {
    const { game, walker } = world(HALL, 'flight');
    const l = standAt(game, walker, 4, 2);
    const p = game.player;
    // stand beside the middle of the flight and push into it
    const mid = l.lower[1];
    const sideY = l.dIn % 2 === 1 ? mid[1] + 1 : mid[1];
    const sideX = l.dIn % 2 === 1 ? mid[0] : mid[0] + 1;
    p.x = sideX + 0.5;
    p.y = sideY + 0.5;
    p.yaw = l.dIn % 2 === 1 ? 0 : -Math.PI / 2;
    game.input.held.add('KeyW');
    step(game, 1);
    expect(climbOf(p)).toBeUndefined();
    expect(p.z).toBe(0);
    expect([Math.floor(p.x), Math.floor(p.y)]).toEqual([sideX, sideY]);
  });

  it('`<` / `>` climb the nearest flight by themselves', () => {
    const { game, walker } = world(POCKET, 'flight');
    standAt(game, walker, 2, 4);
    const p = game.player;
    p.y -= 0.8; // a step back from the flight
    expect(goStairs(game, 'up')).toBe(true);
    expect(climbOf(p)).toBeTruthy();
    step(game, 4);
    expect(p.z).toBe(1);
    expect(climbOf(p)).toBeUndefined();
    expect(goStairs(game, 'down')).toBe(true);
    step(game, 4);
    expect(p.z).toBe(0);
  });

  it('classic: the keys teleport as before', () => {
    const { game } = world(POCKET, 'classic');
    const p = game.player;
    p.x = 2.5;
    p.y = 4.5;
    expect(goStairs(game, 'up')).toBe(true);
    expect(p.z).toBe(1);
    expect(climbOf(p)).toBeUndefined();
  });

  it('a locked door on the top landing holds you on the top step until it opens; a closed one you just open', () => {
    const DOOR = (door: string) => ({
      0: ['#####', '#...#', '#.<.#', '#####'],
      1: ['#####', `##${door}##`, '##>##', '#####'],
    });
    const { game, walker } = world(DOOR('L'), 'flight');
    const l = standAt(game, walker, 2, 2);
    expect(l.top).toEqual([[2, 1]]);
    const p = game.player;
    game.input.held.add('KeyW');
    step(game, 4);
    expect(climbOf(p)?.held).toBe(true);
    expect(p.z).toBe(1);
    game.map.setTer(2, 1, 1, 't_door_o');
    step(game, 2);
    expect(climbOf(p)).toBeUndefined();
    expect([Math.floor(p.x), Math.floor(p.y), p.z]).toEqual([2, 1, 1]);

    const w2 = world(DOOR('+'), 'flight');
    standAt(w2.game, w2.walker, 2, 2);
    w2.game.input.held.add('KeyW');
    step(w2.game, 5);
    expect(w2.game.map.terAt(2, 1, 1).id).toBe('t_door_o');
    expect(climbOf(w2.game.player)).toBeUndefined();
    expect(w2.game.player.z).toBe(1);
  });

  it('nobody falls through the stairwell mid-climb, and saving mid-climb restores the climb', () => {
    const { game, walker, stairs } = world(HALL, 'flight');
    standAt(game, walker, 4, 2);
    const p = game.player;
    game.input.held.add('KeyW');
    step(game, 0.9);
    const c = climbOf(p)!;
    expect(c).toBeTruthy();
    expect(fallIfUnsupported(game)).toBe(0);
    const saved = JSON.parse(JSON.stringify(walker.saveState()));
    const pos = { x: p.x, y: p.y, z: p.z, lift: liftOf(p) };
    // a fresh game from the same map, loading the climb
    const w2 = world(HALL, 'flight');
    w2.game.player.x = pos.x;
    w2.game.player.y = pos.y;
    w2.game.player.z = pos.z;
    w2.walker.loadState(saved);
    const c2 = climbOf(w2.game.player)!;
    expect(c2.s).toBeCloseTo(c.s, 6);
    expect(w2.game.player.x).toBeCloseTo(pos.x, 3);
    expect(liftOf(w2.game.player)).toBeCloseTo(pos.lift, 6);
    void stairs;
  });
});

describe('monsters on the stairs', () => {
  it('a zombie chasing you follows you up the flight and arrives upstairs', () => {
    const { game, sys, walker } = world(HALL, 'flight');
    const l = standAt(game, walker, 4, 2);
    const p = game.player;
    p.debugInvulnerable = true;
    // a zombie a few tiles behind on the ground floor, already after you
    const b = l.path.at(0);
    const hx = Math.sin(b.head), hy = -Math.cos(b.head);
    const zx = Math.floor(b.x - hx * 2) + 0.5, zy = Math.floor(b.y - hy * 2) + 0.5;
    const z = sys.spawnById('mon_zombie', zx, zy, 0)!;
    z.anger = 100;
    step(game, 0.5);
    game.input.held.add('KeyW');
    let rode = false;
    step(game, 4, () => (rode ||= !!climbOf(z)));
    game.input.held.delete('KeyW');
    // walk a little away from the well upstairs
    step(game, 12, () => (rode ||= !!climbOf(z)));
    expect(p.z).toBe(1);
    expect(rode).toBe(true);
    expect(z.dead).toBe(false);
    expect(z.z).toBe(1);
    expect(climbOf(z)).toBeUndefined();
  });

  it('a zombie killed on the stairs, and what you drop there, end up at the foot of the flight', () => {
    const { game, sys, walker } = world(HALL, 'flight');
    const l = standAt(game, walker, 4, 2);
    const b = l.path.at(0);
    const z = sys.spawnById('mon_zombie', b.x, b.y, 0)!;
    walker.attach(z, l, true, { auto: -1 });
    walker.advance(z, -1.5);
    expect(climbOf(z)).toBeTruthy();
    sys.die(z, null);
    expect(climbOf(z)).toBeUndefined();
    expect(l.bottom.some(([x, y]) => x === Math.floor(z.x) && y === Math.floor(z.y))).toBe(true);
    expect(z.z).toBe(0);
    // the survivor, halfway up, drops something: it tumbles down too
    const p = game.player;
    walker.attach(p, l, false);
    walker.advance(p, l.path.len * 0.7);
    expect(p.z).toBe(1);
    const loc = p.groundLoc!() as unknown as { x: number; y: number; z: number };
    expect([loc.x, loc.y, loc.z]).toEqual([...l.bottom[0], 0]);
  });

  it('a follower takes the flight after you instead of appearing upstairs', () => {
    const { game, sys, walker, stairs } = world(HALL, 'flight');
    const nd = load('npcs.json');
    const npcs = new NpcSystem(game, nd, sys);
    game.systems.push(npcs);
    installStairNpcs(game, stairs, npcs);
    const l = standAt(game, walker, 4, 2);
    const b = l.path.at(0);
    const hx = Math.sin(b.head), hy = -Math.cos(b.head);
    const n = npcs.spawn({ cls: 'NC_SCAVENGER' }, Math.floor(b.x - hx * 1.5), Math.floor(b.y - hy * 1.5), 0)!;
    new Dialogue(npcs, n).effect('follow');
    game.input.held.add('KeyW');
    let rode = false;
    step(game, 3, () => (rode ||= !!climbOf(n)));
    game.input.held.delete('KeyW');
    step(game, 8, () => (rode ||= !!climbOf(n)));
    expect(game.player.z).toBe(1);
    expect(rode).toBe(true);
    expect(n.z).toBe(1);
    expect(climbOf(n)).toBeUndefined();
  });
});
