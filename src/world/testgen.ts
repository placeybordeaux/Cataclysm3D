import type { Chunk, ChunkGenerator, GameMap } from './map';
import { CHUNK } from './coords';
import { Rng, hashSeed } from '../core/rng';

// Placeholder generator used until the real overmap + JSON mapgen lands (?gen=test). A
// small deterministic neighbourhood that exercises the renderer:
//   chunk ( 0,0)  one-room house (drywall, windows, closed door, furniture) + flat roof
//   chunk ( 1,0)  two-storey brick house: open door, curtains, carpet/kitchen, stairs,
//                 upper floor, roof
//   chunk (-1,0)  dense mixed forest with undergrowth
//   chunk ( 0,1)  fenced yard: pond (shallow + deep), campfire, brazier, scattered items
//   row  cy = 0   east-west road with sidewalks along y = 18..23
// Everything else is grass/dirt with a few trees. Underground is solid rock.

const ROAD_Y0 = 18; // sidewalk
const ROAD_Y1 = 23; // sidewalk

export class TestGenerator implements ChunkGenerator {
  generate(map: GameMap, c: Chunk): void {
    const rng = new Rng(hashSeed(map.seed, c.cx, c.cy, c.z));
    const T = (id: string) => map.terrain.index(id);
    const F = (id: string) => map.furniture.index(id);
    const set = (x: number, y: number, id: string) => (c.ter[y * CHUNK + x] = T(id));
    const furn = (x: number, y: number, id: string) => (c.furn[y * CHUNK + x] = F(id));
    const rect = (x0: number, y0: number, x1: number, y1: number, id: string) => {
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y, id);
    };
    const box = (x0: number, y0: number, x1: number, y1: number, wall: string, floor: string) => {
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) set(x, y, y === y0 || y === y1 || x === x0 || x === x1 ? wall : floor);
    };
    c.empty = false;

    if (c.z > 0) {
      c.ter.fill(T('t_open_air'));
      if (c.z === 1 && c.cx === 0 && c.cy === 0) rect(4, 4, 14, 12, 't_flat_roof');
      if (c.cx === 1 && c.cy === 0) {
        if (c.z === 1) {
          box(4, 3, 16, 13, 't_brick_wall', 't_floor');
          set(6, 5, 't_stairs_down');
          set(4, 8, 't_window_domestic');
          set(10, 3, 't_window_domestic');
          set(16, 9, 't_curtains');
          set(12, 13, 't_window');
          for (let y = 4; y <= 12; y++) if (y !== 10) set(11, y, 't_wall');
          set(11, 10, 't_door_o');
          furn(14, 5, 'f_bed');
          furn(13, 12, 'f_dresser');
          furn(8, 11, 'f_bookcase');
        }
        if (c.z === 2) rect(4, 3, 16, 13, 't_flat_roof');
      }
      return;
    }
    if (c.z < 0) {
      c.ter.fill(T('t_rock'));
      return;
    }

    // ground level
    const grass = T('t_grass'), dirt = T('t_dirt'), tree = T('t_tree');
    for (let i = 0; i < CHUNK * CHUNK; i++) c.ter[i] = rng.oneIn(6) ? dirt : grass;
    if (c.cx !== -1) for (let i = 0; i < 6; i++) c.ter[rng.int(0, CHUNK * CHUNK - 1)] = tree;

    if (c.cy === 0) {
      for (let x = 0; x < CHUNK; x++) {
        set(x, ROAD_Y0, 't_sidewalk');
        set(x, ROAD_Y1, 't_sidewalk');
        for (let y = ROAD_Y0 + 1; y < ROAD_Y1; y++) set(x, y, 't_pavement');
        if (((c.cx * CHUNK + x) & 3) < 2) set(x, 20, 't_pavement_y');
      }
    }

    if (c.cx === 0 && c.cy === 0) {
      box(4, 4, 14, 12, 't_wall', 't_floor');
      set(9, 12, 't_door_c');
      set(7, 4, 't_window');
      set(14, 8, 't_window');
      set(4, 9, 't_window_domestic');
      furn(6, 6, 'f_table');
      furn(7, 6, 'f_chair');
      furn(10, 10, 'f_bed');
      furn(12, 5, 'f_fridge');
      furn(5, 11, 'f_floor_lamp');
      furn(13, 11, 'f_sofa');
      // clear the path from the door to the road
      for (let y = 13; y < ROAD_Y0; y++) set(9, y, 't_dirt');
    }

    if (c.cx === 1 && c.cy === 0) {
      box(4, 3, 16, 13, 't_brick_wall', 't_carpet_red');
      rect(12, 4, 15, 12, 't_linoleum_white');
      for (let y = 4; y <= 12; y++) if (y !== 7) set(11, y, 't_wall');
      set(10, 13, 't_door_o');
      set(4, 8, 't_window_domestic');
      set(7, 3, 't_window_domestic');
      set(14, 3, 't_window');
      set(16, 9, 't_curtains');
      set(6, 13, 't_window');
      set(6, 5, 't_stairs_up');
      for (let x = 12; x <= 15; x++) furn(x, 4, x === 13 ? 'f_oven' : x === 15 ? 'f_fridge' : 'f_counter');
      furn(14, 9, 'f_table');
      furn(13, 9, 'f_chair');
      furn(8, 10, 'f_sofa');
      furn(5, 12, 'f_bookcase');
      furn(9, 7, 'f_armchair');
      for (let y = 14; y < ROAD_Y0; y++) set(10, y, 't_concrete');
    }

    if (c.cx === -1 && c.cy === 0) {
      for (let y = 0; y < ROAD_Y0 - 1; y++)
        for (let x = 0; x < CHUNK; x++) {
          const r = rng.next();
          if (r < 0.16) set(x, y, 't_tree');
          else if (r < 0.26) set(x, y, 't_tree_pine');
          else if (r < 0.31) set(x, y, 't_tree_young');
          else if (r < 0.42) set(x, y, 't_underbrush');
          else if (r < 0.6) set(x, y, 't_grass_long');
        }
    }

    if (c.cx === 0 && c.cy === 1) {
      for (let i = 2; i <= 20; i++) {
        set(i, 2, 't_fence'); set(i, 20, 't_fence'); set(2, i, 't_fence'); set(20, i, 't_fence');
      }
      set(9, 2, 't_dirt'); // gate gap facing the road
      for (let y = 7; y <= 17; y++)
        for (let x = 9; x <= 19; x++) {
          const d = Math.hypot(x - 14, y - 12);
          if (d < 2.2) set(x, y, 't_water_dp');
          else if (d < 4.3) set(x, y, 't_water_sh');
          else if (d < 5) set(x, y, 't_sand');
        }
      const fire = (x: number, y: number, intensity: number) => c.fields.set(y * CHUNK + x, [{ type: 'fd_fire', intensity, age: 0 }]);
      fire(5, 6, 2);
      furn(5, 14, 'f_brazier');
      fire(5, 14, 1);
      furn(7, 6, 'f_chair');
      furn(4, 16, 'f_crate_c');
      furn(6, 17, 'f_trashcan');
      const item = (x: number, y: number, id: string) => c.items.set(y * CHUNK + x, [{ typeId: id }]);
      item(6, 7, 'hammer');
      item(4, 7, 'rock');
      item(6, 5, '2x4');
      item(8, 9, 'backpack');
      item(10, 5, 'flashlight');
      item(12, 4, 'can_beans');
      set(22, 22, 't_chainfence'); set(23, 22, 't_chainfence'); set(21, 22, 't_chainfence');
    }
  }
}
