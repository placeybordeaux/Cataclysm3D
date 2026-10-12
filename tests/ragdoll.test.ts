// The run-over rag doll (src/render/chars/ragdoll.ts): it stays on the floor while it tumbles,
// and it ends exactly as the lying body that replaces it (FallingBody for a corpse, the downed
// CreatureModel for a survivor), on the corpse's / monster's spot from the simulation.
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { bodyShapeOf } from '../src/render/chars/archetype';
import { makeRig, type Rig } from '../src/render/chars/rig';
import { CharLayer, type CharInstance, type Skin } from '../src/render/chars/charLayer';
import { CreatureModel, FallingBody } from '../src/render/chars/creature';
import { RAGDOLL, RagdollBody, lieQuat, nearestLie } from '../src/render/chars/ragdoll';
import { flingEnd, launchFromImpact, planFling, type FlingPlan } from '../src/game/runoverFling';
import type { ZStyle } from '../src/render/chars/zombie';
import monsters from '../public/data/monsters.json';

type Mon = { id: string; bodytype?: string; species?: string[]; flags?: string[]; symbol?: string; volume?: number; name?: string };
const MON = monsters as unknown as Record<string, Mon>;
const rigOf = (id: string, zstyle: ZStyle = 'shamble') => makeRig(bodyShapeOf(MON[id]), { zstyle, variant: 1 });
const skinFor = (rig: Rig): Skin => ({ page: 0, rects: new Int32Array(rig.parts.length * 5), refs: 0 });

function plan(kmh: number, offset = 0.3): FlingPlan {
  const l = launchFromImpact({ x: 10.5, y: 10.5, vx: kmh / 3.6, vy: kmh / 36, offset, mass: 80, seed: 0.37 });
  return planFling(10.5, 10.5, l, { blocked: () => false })!;
}

const CUBE = [...Array(8)].map((_, k) => new THREE.Vector3(k & 1 ? 0.5 : -0.5, k & 2 ? 0.5 : -0.5, k & 4 ? 0.5 : -0.5));
/** Lowest point of the drawn boxes (m above the floor; z 0, no ground relief). */
function lowest(inst: CharInstance): number {
  const m = new THREE.Matrix4(), v = new THREE.Vector3();
  let lo = Infinity;
  for (let i = 0; i < inst.rig.parts.length; i++) {
    m.fromArray(inst.mats, i * 16);
    if (Math.abs(m.determinant()) < 1e-12) continue; // hidden parts (scale 0)
    for (const c of CUBE) lo = Math.min(lo, v.copy(c).applyMatrix4(m).y);
  }
  return lo;
}

function maxDiff(a: Float32Array, b: Float32Array): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i] - b[i]));
  return d;
}

/** Fly a rag doll to rest; returns it plus the lowest any box went. */
function fly(rig: Rig, p: FlingPlan, live: boolean, feel = RAGDOLL.stiff, seed = 0.62) {
  const layer = new CharLayer(false);
  const rag = new RagdollBody(layer, rig, skinFor(rig), seed, p, 0, 1.0, { feel, live });
  let low = Infinity, steps = 0, spun = 0;
  const q0 = rag.inst.tumble!.clone();
  while (!rag.done && steps < 400) {
    rag.update(1 / 30);
    rag.inst.build(null);
    low = Math.min(low, lowest(rag.inst));
    spun = Math.max(spun, 2 * Math.acos(Math.min(1, Math.abs(rag.inst.tumble!.dot(q0)))));
    for (const x of rag.inst.mats) if (!Number.isFinite(x)) throw new Error('non-finite matrix');
    steps++;
  }
  return { rag, layer, low, spun };
}

describe('run-over rag doll', () => {
  const cases: [string, ZStyle][] = [['mon_zombie', 'shamble'], ['mon_zombie', 'caricature'], ['mon_zombie', 'boxy'], ['mon_zombie_child', 'shamble'], ['mon_zombie_hulk', 'shamble'], ['mon_zombie_crawler', 'shamble'], ['mon_dog', 'shamble'], ['mon_zombie_dog', 'shamble'], ['mon_ant', 'shamble'], ['mon_spider_wolf_giant', 'shamble'], ['mon_blob', 'shamble']];
  for (const [id, zs] of cases)
    it(`${id} (${zs}): tumbles, stays on the floor, and lies exactly as its corpse at the corpse's spot`, () => {
      const rig = rigOf(id, zs);
      const p = plan(70);
      const { rag, layer, low, spun } = fly(rig, p, false);
      expect(rag.done).toBe(true);
      expect(spun).toBeGreaterThan(1.2);
      const [ex, ey] = flingEnd(p);
      const body = new FallingBody(layer, rig, skinFor(rig), 0.62, ex, ey, 0, rag.facing!, 0, 0, true);
      body.inst.build(null);
      // never deeper into the floor than the corpse's own lying pose already is (plus a few cm
      // of a flailing limb: the floor contact uses the trunk's pose, not the springs)
      expect(low).toBeGreaterThan(Math.min(0, lowest(body.inst)) - 0.12);
      rag.inst.build(null);
      expect(maxDiff(rag.inst.mats, body.inst.mats)).toBeLessThan(2e-3);
    });

  it('a survivor ends in the downed pose of its live body, at the monster', () => {
    const rig = rigOf('mon_zombie');
    const p = plan(20);
    const { rag, layer } = fly(rig, p, true);
    const [ex, ey] = flingEnd(p);
    const model = new CreatureModel(layer, rig, skinFor(rig), 0.62, ex, ey, rag.facing!);
    model.setYaw(rag.facing!);
    model.update(0, { x: ex, y: ey, z: 0, facing: rag.facing!, target: null, moving: false, walkPhase: 0, windup: null, flinch: 0, down: 1, visible: true, emph: 0, camDist: 5, sy: 1, sxz: 1 });
    model.inst.build(null);
    rag.inst.build(null);
    // the trunk lands where the live body lies (limbs may differ by the idle clock)
    for (const i of [0, 1]) for (const k of [12, 13, 14]) expect(Math.abs(rag.inst.mats[i * 16 + k] - model.inst.mats[i * 16 + k])).toBeLessThan(0.02);
  });

  it('stiff limbs stray less than loose ones', () => {
    const rig = rigOf('mon_zombie');
    const stray = (feel: typeof RAGDOLL.stiff) => {
      const layer = new CharLayer(false);
      const rag = new RagdollBody(layer, rig, skinFor(rig), 0.62, plan(40), 0, 0, { feel, live: false });
      let m = 0;
      for (let i = 0; i < 20; i++) {
        rag.update(1 / 30);
        m = Math.max(m, ...(rag as unknown as { off: Float32Array }).off.map(Math.abs));
      }
      return m;
    };
    expect(stray(RAGDOLL.stiff)).toBeLessThan(stray(RAGDOLL.loose));
    expect(stray(RAGDOLL.stiff)).toBeLessThanOrEqual(RAGDOLL.stiff.max + 1e-6);
  });

  it('settles the short way round: the nearest lying heading is the one it is closest to', () => {
    const rig = rigOf('mon_zombie');
    for (const f of [0, 1, 2.5, 4]) {
      const q = lieQuat(rig, f, 1);
      const g = nearestLie(rig, q, 1);
      expect(Math.abs(q.dot(lieQuat(rig, g, 1)))).toBeGreaterThan(0.97);
    }
  });
});
