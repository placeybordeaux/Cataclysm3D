// Probe: per-part world boxes of a crawling rig in a few poses (tuning rig.ts crawlPose).
// Usage: npx tsx tools/dev/probe_crawl.ts [monster id] [-v]
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { bodyShapeOf } from '../../src/render/chars/archetype';
import { makeRig, type PoseIn } from '../../src/render/chars/rig';
import { CharLayer, type Skin } from '../../src/render/chars/charLayer';

const id = process.argv[2] ?? 'mon_zombie_crawler';
const mons = JSON.parse(readFileSync('public/data/monsters.json', 'utf8'));
const shape = bodyShapeOf(mons[id]);
const rig = makeRig(shape);
console.log(id, shape.crawl, 'height', rig.height.toFixed(2));
const base: PoseIn = { t: 0, phase: 0, gait: 0, windup: null, windKind: 'melee', strike: 0, down: 0, flinch: 0, dead: false, seed: 0.3 };
const poses: [string, Partial<PoseIn>][] = [['idle', {}], ['crawl0', { gait: 1, phase: 0 }], ['crawl.25', { gait: 1, phase: 0.25 }], ['crawl.5', { gait: 1, phase: 0.5 }], ['windup', { windup: 1 }], ['dead', { dead: true }]];
for (const [name, pose] of poses) {
  const layer = new CharLayer(false);
  const inst = layer.add(rig, { page: 0, rects: new Int32Array(rig.parts.length * 5), refs: 0 } as Skin);
  inst.setPose({ ...base, ...pose });
  inst.build(null);
  const all = new THREE.Box3();
  const m = new THREE.Matrix4();
  const unit = new THREE.Box3(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5));
  const rows: string[] = [];
  for (let i = 0; i < rig.parts.length; i++) {
    m.fromArray(inst.mats, i * 16);
    const b = unit.clone().applyMatrix4(m);
    if (b.max.x - b.min.x < 1e-4) continue;
    all.union(b);
    rows.push(`${rig.parts[i].name}: y ${b.min.y.toFixed(2)}..${b.max.y.toFixed(2)} z ${b.min.z.toFixed(2)}..${b.max.z.toFixed(2)}`);
  }
  console.log(`-- ${name}: y ${all.min.y.toFixed(2)}..${all.max.y.toFixed(2)} z ${all.min.z.toFixed(2)}..${all.max.z.toFixed(2)} x ${all.min.x.toFixed(2)}..${all.max.x.toFixed(2)}`);
  if (process.argv.includes('-v')) console.log('   ' + rows.join('\n   '));
}
