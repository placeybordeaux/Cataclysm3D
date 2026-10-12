// A NaN view pitch hung the tab with a V8 OOM (real-input QA set cdda.game.player.pitch from the
// debug API): the loot hover's targetTile marched the view ray as NaN tile coordinates, the map
// generated a chunk "at NaN", and its overmap region's road A* never finished. The view angles
// now refuse non-finite values and hold pitch to the mouse-look limit, and the map refuses
// non-finite coordinates instead of generating them.
import { describe, expect, it } from 'vitest';
import { Game } from '../src/game/game';
import type { Input } from '../src/core/input';
import { PITCH_LIMIT } from '../src/game/player';
import { targetTile, playerViewRay } from '../src/game/targeting';
import { raycastTiles } from '../src/game/raycast';
import { WorldGenerator } from '../src/world/worldgen';
import { Overmap } from '../src/world/overmap/overmap';
import { loadNodeData } from '../tools/lib/node_data';

const { game: data, wg } = loadNodeData();

function world(seed = 3) {
  const input = { held: new Set<string>(), captured: false, mouseButtons: 0, onPress() {}, consumeMouse: () => [0, 0], consumeClicks: () => [] } as unknown as Input;
  const game = new Game(data, seed, input);
  const gen = new WorldGenerator(seed, wg, data);
  gen.stats.quiet = true;
  game.map.generator = gen;
  return game;
}

describe('view angles', () => {
  it('refuses a non-finite pitch or yaw and keeps the old value', () => {
    const p = world().player;
    p.pitch = -0.3;
    p.yaw = 1;
    for (const bad of [NaN, Infinity, -Infinity, undefined as unknown as number]) {
      expect(() => (p.pitch = bad)).toThrow(/pitch must be finite/);
      expect(() => (p.yaw = bad)).toThrow(/yaw must be finite/);
    }
    expect(p.pitch).toBe(-0.3);
    expect(p.yaw).toBe(1);
  });

  it('holds pitch to the mouse-look limit (a debug write past straight up/down)', () => {
    const p = world().player;
    for (const [v, want] of [[3, PITCH_LIMIT], [-60, -PITCH_LIMIT], [Math.PI / 2, PITCH_LIMIT], [-1.2, -1.2]] as const) {
      p.pitch = v;
      expect(p.pitch).toBe(want);
    }
  });

  it('looking straight up or down at the limit still finds a target (or nothing) quickly', () => {
    const game = world();
    const p = game.player;
    for (const pitch of [PITCH_LIMIT, -PITCH_LIMIT, 0]) {
      p.pitch = pitch;
      const t0 = performance.now();
      targetTile(game);
      const ray = playerViewRay(game);
      raycastTiles(game.map, ray.o, ray.d);
      expect(performance.now() - t0).toBeLessThan(2000);
    }
  });
});

describe('map coordinates', () => {
  it('refuses to generate a chunk at non-finite coordinates (it used to OOM in the road A*)', () => {
    const game = world();
    expect(() => game.map.terAt(NaN, NaN, 0)).toThrow(/non-finite/);
    expect(() => game.map.chunk(0, Infinity, 0)).toThrow(/non-finite/);
    expect(() => game.map.chunk(0, 0, NaN)).toThrow(/non-finite/);
    expect(game.map.terAt(5, 5, 0).id).not.toBe('t_null');
  });

  it('the overmap refuses a NaN region', () => {
    const om = new Overmap(3, wg.overmap);
    expect(() => om.omtAt(NaN, 0, 0)).toThrow(/bad region/);
  });
});
