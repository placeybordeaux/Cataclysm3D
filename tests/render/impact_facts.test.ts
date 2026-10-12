import { expect, it, vi } from 'vitest';
import { HitFx } from '../../src/render/hitFx';

it('onAttack marks only target-free explicitly landed hard rounds', () => {
  // Exercise the actual event dispatch branch without constructing a WebGL canvas.
  const fx = Object.create(HitFx.prototype) as any;
  fx.game = { player: {} };
  fx.burst = vi.fn(); fx.mark = vi.fn(); fx.impactHeight = () => 1.6;
  const base = { kind: 'gun', outcome: 'whiff', x: 3, y: 4, z: 0, damage: 0, heavy: false };
  for (const facts of [base, {...base,landed:false}, {...base,landed:true,target:{}}, {...base,outcome:'miss',landed:true,target:{}}, {...base,landed:true,ranged:'bow'}]) fx.onAttack(facts);
  expect(fx.mark).not.toHaveBeenCalled();
  fx.onAttack({...base,landed:true,ranged:'pistol'});
  expect(fx.mark).toHaveBeenCalledExactlyOnceWith(3,4,0);
});

it('bounds persistent mark storage and sends stable world normals until expiry', () => {
  const fx = Object.create(HitFx.prototype) as any;
  const floor = { id: 't_floor', move_cost: 2, flags: ['TRANSPARENT'] };
  const wall = { id: 't_wall', move_cost: 0, flags: ['WALL'] };
  fx.game = { player: { pitch: 0 }, map: {
    hasChunk: () => true, hasFloor: () => true,
    terAt: (x: number) => x === 3 ? wall : floor,
    furnAt: () => ({ id: 'f_null', move_cost_mod: 0, flags: [] }),
  } };
  fx.renderer = { rig: { camera: { position: { x: .5, z: .5, y: 1.6 } } } };
  fx.markMeshes = { begin: vi.fn(), place: vi.fn(), end: vi.fn() };
  fx.marks = []; fx.tracerDots = []; fx.particles = []; fx.rng = () => 0; fx.pixelSize = () => .05;
  for (let i=0; i<70; i++) fx.mark(3,.5,0);
  expect(fx.marks).toHaveLength(60);
  fx.update(.1);
  expect(fx.markMeshes.place).toHaveBeenCalledTimes(60);
  expect(fx.markMeshes.place).toHaveBeenLastCalledWith('mark',2.992,.5,0,1.6,[-1,0,0],[20,18,16],1);
  fx.markMeshes.place.mockClear();
  fx.update(30);
  expect(fx.marks).toHaveLength(0);
  expect(fx.markMeshes.place).not.toHaveBeenCalled();
  expect(fx.markMeshes.end).toHaveBeenCalledTimes(2);
});
