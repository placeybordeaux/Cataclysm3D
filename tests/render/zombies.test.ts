import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { bodyShapeOf, type MonsterLike } from '../../src/render/chars/archetype';
import { HUM, makeRig, type PoseIn, type Rig } from '../../src/render/chars/rig';
import { CharLayer, type Skin } from '../../src/render/chars/charLayer';
import { zombieLookOf, ZOMBIE_FAMILIES } from '../../src/render/chars/zombieFamily';
import { ZVARIANTS, poseBounds } from '../../src/render/chars/zombie';
import { SHAPES, shapeGeometry } from '../../src/render/chars/shapes';
import { paintZombiePart } from '../../src/render/chars/zombieSkin';
import { personPalette } from '../../src/render/chars/styled';
import { analyseSprite, netSize, texelDims, type Img } from '../../src/render/chars/paint';
import { pickModel } from '../../src/render/aimPick';
import { CreatureModel, type CreatureState } from '../../src/render/chars/creature';
import monsters from '../../public/data/monsters.json';

type Mon = { id: string; bodytype?: string; species?: string[]; flags?: string[]; symbol?: string; volume?: number; special_attacks?: { id?: string; type?: string }[]; emit_fields?: { emit_id?: string }[] };
const MON = monsters as unknown as Record<string, Mon>;
/** The MonsterLike monsterView builds from a MonsterDef. */
const like = (m: Mon): MonsterLike => ({
  id: m.id, bodytype: m.bodytype, species: m.species, flags: m.flags, symbol: m.symbol, volume: m.volume,
  attacks: (m.special_attacks ?? []).map((a) => a.id ?? a.type ?? '').filter(Boolean),
  emits: (m.emit_fields ?? []).map((e) => e.emit_id ?? ''),
});
const look = (id: string) => {
  const l = zombieLookOf(like(MON[id]));
  if (!l) throw new Error(`${id}: no zombie look`);
  return l;
};

const idle: PoseIn = { t: 0, phase: 0, gait: 0, windup: null, windKind: 'melee', strike: 0, down: 0, flinch: 0, dead: false, seed: 0.5 };

function built(rig: Rig, pose: Partial<PoseIn> = {}, setup?: (i: ReturnType<CharLayer['add']>) => void) {
  const layer = new CharLayer(false);
  const skin: Skin = { page: 0, rects: new Int32Array(rig.parts.length * 5), refs: 0 };
  const inst = layer.add(rig, skin);
  setup?.(inst);
  inst.setPose({ ...idle, ...pose });
  inst.build(null);
  return inst;
}
/** World bounds of the named parts (all when omitted). */
function bounds(rig: Rig, pose: Partial<PoseIn> = {}, only?: (name: string) => boolean, setup?: (i: ReturnType<CharLayer['add']>) => void) {
  const inst = built(rig, pose, setup);
  const box = new THREE.Box3();
  const m = new THREE.Matrix4();
  const unit = new THREE.Box3(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5));
  for (let i = 0; i < rig.parts.length; i++) {
    if (only ? !only(rig.parts[i].name) : rig.parts[i].name.startsWith('fx')) continue;
    m.fromArray(inst.mats, i * 16);
    box.union(unit.clone().applyMatrix4(m));
  }
  return box;
}

describe('zombie families from BN data (zombieFamily.ts)', () => {
  it('maps the common and special zombies the sprites draw to their families', () => {
    const want: Record<string, string> = {
      mon_zombie: 'walker', mon_zombie_fat: 'fat', mon_zombie_tough: 'brute', mon_zombie_brute: 'brute', mon_zombie_hulk: 'hulk',
      mon_boomer: 'boomer', mon_boomer_huge: 'boomer', mon_zombie_gasbag: 'boomer', mon_zombie_shrieker: 'shrieker', mon_zombie_screecher: 'shrieker',
      mon_zombie_spitter: 'acid', mon_zombie_acidic: 'acid', mon_zombie_corrosive: 'acid', mon_zombie_electric: 'electric', mon_zombie_static: 'electric',
      mon_zombie_brute_shocker: 'electric', mon_zombie_smoker: 'smoker', mon_zombie_necro: 'necro', mon_zombie_master: 'necro', mon_skeleton: 'skeleton',
      mon_skeleton_brute: 'brute', mon_skeleton_hulk: 'hulk', mon_zombie_thorny: 'thorny', mon_zombie_child: 'child', mon_zombie_runner: 'runner',
      mon_zombie_predator: 'runner', mon_zombie_grabber: 'grabber', mon_zombie_scorched: 'scorched', mon_feral_human_pipe: 'feral',
      // a survivor SHRIEKs but doesn't stumble: still a survivor in gear, not a shrieker
      mon_zombie_survivor: 'walker',
    };
    for (const [id, fam] of Object.entries(want)) expect(look(id).family, id).toBe(fam);
  });
  it('reads degree, bone, fx and gear', () => {
    expect(look('mon_boomer_huge').degree).toBeGreaterThan(look('mon_boomer').degree);
    expect(look('mon_zombie_corrosive').degree).toBeGreaterThan(look('mon_zombie_acidic').degree);
    expect(look('mon_zombie_tough').degree).toBeLessThan(look('mon_zombie_brute').degree);
    expect(look('mon_skeleton_brute')).toMatchObject({ build: 'brute', bone: true });
    expect(look('mon_zombie_brute_shocker')).toMatchObject({ build: 'brute', fx: ['arcs'] });
    expect(look('mon_zombie_necro').fx).toEqual(['tendrils', 'redEyes']);
    expect(look('mon_zombie_shrieker').fx).toContain('maw');
    expect(look('mon_feral_human_pipe').undead).toBe(false);
    const gear: Record<string, string> = {
      mon_zombie_cop: 'cop', mon_zombie_swat: 'swat', mon_zombie_soldier: 'soldier', mon_zombie_hazmat: 'hazmat', mon_zombie_fireman: 'fireman',
      mon_zombie_bio_op: 'bioop', mon_zombie_survivor: 'survivor', mon_zombie_armored: 'armored', mon_zombie_miner: 'miner', mon_beekeeper: 'beekeeper',
      mon_zombie_scientist: 'scientist', mon_zombie_nurse: 'medic', mon_zombie: 'none',
    };
    for (const [id, g] of Object.entries(gear)) expect(look(id).gear, id).toBe(g);
  });
  it('puts variants nobody listed into a sensible family from their data', () => {
    // read from flags / attacks / volume / emit_fields, not the id
    expect(look('mon_zombie_acid_mortar').family).toBe('acid');
    expect(look('mon_zombie_stormbringer').family).toBe('electric');
    expect(look('mon_zombie_kevlar_2')).toMatchObject({ family: 'hulk', gear: 'soldier' });
    expect(look('mon_zombie_ichor_brute').fx).toContain('acid');
    expect(look('mon_zombie_fiend').family).toBe('brute');
    expect(zombieLookOf({ id: 'mon_mod_thing', species: ['ZOMBIE'], flags: ['ELECTRIC'] })!.family).toBe('electric');
    expect(zombieLookOf({ id: 'mon_mod_thing', species: ['ZOMBIE'], emits: ['emit_smoke_stream'] })!.family).toBe('smoker');
    expect(zombieLookOf({ id: 'mon_mod_thing', species: ['ZOMBIE'], volume: 900000 })!.family).toBe('hulk');
    expect(zombieLookOf({ id: 'mon_mod_thing', species: ['ZOMBIE'], attacks: ['RESURRECT'] })!.family).toBe('necro');
    // people who aren't zombies keep the person rig
    expect(zombieLookOf({ id: 'mon_mi_go', species: ['MIGO'] })).toBeNull();
    expect(zombieLookOf({ id: 'mon_task_force_shade', species: ['NETHER', 'HUMAN'] })).toBeNull();
  });
  it('gives every humanoid BN zombie a look, and the table names a reason for every family', () => {
    let n = 0;
    for (const m of Object.values(MON)) {
      const sh = bodyShapeOf(like(m));
      if (sh.arch !== 'humanoid' || !(m.species ?? []).includes('ZOMBIE')) continue;
      n++;
      expect(sh.zlook, m.id).toBeTruthy();
    }
    expect(n).toBeGreaterThan(100);
    for (const r of ZOMBIE_FAMILIES) expect(r.why.length, r.family).toBeGreaterThan(5);
  });
});

describe('zombie bodies (zombie.ts)', () => {
  const zombies = Object.values(MON).filter((m) => bodyShapeOf(like(m)).zlook);
  it('builds every BN zombie in both styles and every variant: person parts first, parents ordered, finite in every pose', () => {
    const poses: Partial<PoseIn>[] = [{}, { gait: 1, phase: 0.35, t: 1.3 }, { gait: 2, phase: 0.6 }, { windup: 0.7 }, { windup: 0.8, windKind: 'heavy' }, { windup: 1, windKind: 'leap' }, { strike: 1, windKind: 'leap' }, { strike: 1 }, { flinch: 1 }, { down: 1 }, { dead: true }];
    for (const m of zombies) for (const zstyle of ['shamble', 'caricature'] as const) for (let v = 0; v < ZVARIANTS; v++) {
      const rig = makeRig(bodyShapeOf(like(m)), { zstyle, variant: v });
      const key = `${m.id} ${zstyle} ${v}`;
      expect(rig.zlook, key).toBeTruthy();
      for (const [name, i] of Object.entries(HUM)) expect(rig.parts[i].name, key).toBe(name);
      for (let i = 0; i < rig.parts.length; i++) expect(rig.parts[i].parent, `${key} ${rig.parts[i].name}`).toBeLessThan(i);
      for (const pose of poses) {
        const b = bounds(rig, pose);
        for (const x of [...b.min.toArray(), ...b.max.toArray()]) expect(Number.isFinite(x), `${key} ${JSON.stringify(pose)}`).toBe(true);
      }
    }
  });
  it('stands on the floor and is as tall as it says', () => {
    for (const m of zombies) {
      const sh = bodyShapeOf(like(m));
      if (sh.crawl || sh.flies) continue;
      for (let v = 0; v < ZVARIANTS; v++) {
        const rig = makeRig(sh, { variant: v });
        const b = bounds(rig);
        expect(Math.abs(b.min.y), `${m.id} ${v} floor`).toBeLessThan(0.03);
        expect(Math.abs(b.max.y - rig.height), `${m.id} ${v} height`).toBeLessThan(0.03);
      }
    }
  });
  it('is hunched with the head thrust forward and the arms reaching out', () => {
    const rig = makeRig(bodyShapeOf(like(MON.mon_zombie)));
    const hips = bounds(rig, {}, (n) => n === 'hips');
    const head = bounds(rig, {}, (n) => n === 'head');
    const hands = bounds(rig, { seed: 0.9 }, (n) => n === 'handR');
    // the model faces -z: the head is well in front of the hips, the hands further still
    expect(head.getCenter(new THREE.Vector3()).z).toBeLessThan(hips.getCenter(new THREE.Vector3()).z - 0.15);
    expect(hands.min.z).toBeLessThan(head.min.z);
    // hands at about chest height
    expect(hands.getCenter(new THREE.Vector3()).y).toBeGreaterThan(0.9);
    // an adult zombie hunches below the 1.75 m person but stays head-height dangerous
    expect(rig.height).toBeGreaterThan(1.45);
    expect(rig.height).toBeLessThan(1.8);
  });
  it('gives the specials their own silhouettes', () => {
    const size = (id: string) => bounds(makeRig(bodyShapeOf(like(MON[id])))).getSize(new THREE.Vector3());
    const walker = size('mon_zombie');
    // a huge boomer is nearly a ball: wide relative to its height
    const ball = size('mon_boomer_huge');
    expect(ball.x / ball.y).toBeGreaterThan(walker.x / walker.y * 1.3);
    // a hulk towers; a shrieker crouches; a child is small
    expect(size('mon_zombie_hulk').y).toBeGreaterThan(walker.y * 1.3);
    expect(size('mon_zombie_shrieker').y).toBeLessThan(walker.y * 0.92);
    expect(size('mon_zombie_child').y).toBeLessThan(walker.y * 0.85);
    // a brute's fists are much bigger than a walker's hands
    const fist = (id: string) => bounds(makeRig(bodyShapeOf(like(MON[id]))), {}, (n) => n === 'handR').getSize(new THREE.Vector3());
    expect(fist('mon_zombie_brute').x).toBeGreaterThan(fist('mon_zombie').x * 1.5);
    expect(fist('mon_zombie_hulk').x).toBeGreaterThan(fist('mon_zombie_brute').x);
    // family features exist and the cosmetic ones are named fx (aim picking skips those)
    const names = (id: string) => makeRig(bodyShapeOf(like(MON[id]))).parts.map((p) => p.name);
    expect(names('mon_zombie_spitter').some((n) => /[sS]ac/.test(n))).toBe(true);
    expect(names('mon_zombie_electric').some((n) => n.startsWith('fxArc'))).toBe(true);
    expect(names('mon_zombie_smoker').some((n) => n.startsWith('fxSmoke'))).toBe(true);
    expect(names('mon_zombie_necro').some((n) => n.startsWith('fxTendril'))).toBe(true);
    expect(names('mon_zombie_necro')).toContain('headEyeR');
    expect(names('mon_zombie_thorny').some((n) => n.startsWith('fxThorn'))).toBe(true);
    expect(names('mon_skeleton').some((n) => n.startsWith('torsoRib'))).toBe(true);
    expect(names('mon_zombie_hazmat')).toContain('headHood');
    expect(names('mon_zombie_swat')).toContain('headVisor');
    expect(names('mon_boomer')).toContain('torsoBelly');
  });
  it('differs per individual: variants are torn differently', () => {
    const sh = bodyShapeOf(like(MON.mon_zombie));
    const sig = (v: number) => makeRig(sh, { variant: v }).parts.map((p) => `${p.name}:${p.size.map((x) => x.toFixed(3)).join(',')}`).join('|');
    expect(new Set([0, 1, 2].map(sig)).size).toBe(3);
    // the second individual lost a forearm
    const stump = makeRig(sh, { variant: 1 }).parts[HUM.handL];
    expect(stump.src.zr).toBe('flesh');
  });
  it('keeps the round-6 boxy body as a switch value, and NPC-like people unchanged', () => {
    const boxy = makeRig(bodyShapeOf(like(MON.mon_zombie)), { zstyle: 'boxy' });
    expect(boxy.zlook).toBeUndefined();
    expect(boxy.parts.some((p) => p.shape && p.shape !== 'box')).toBe(false);
    expect(boxy.parts.some((p) => p.name === 'headJaw')).toBe(false);
    const person = makeRig({ ...bodyShapeOf({ id: 'npc' }), arch: 'humanoid' });
    expect(person.zlook).toBeUndefined();
  });
});

describe('zombie telegraphs', () => {
  const rig = makeRig(bodyShapeOf(like(MON.mon_zombie)));
  const brute = makeRig(bodyShapeOf(like(MON.mon_zombie_brute)));
  const hands = (r: Rig, p: Partial<PoseIn>) => bounds(r, p, (n) => n === 'handR' || n === 'handL');
  it('throws the arms up over the head in a wind-up', () => {
    const top = bounds(rig).max.y;
    for (const r of [rig, brute]) for (const windKind of ['melee', 'heavy'] as const) expect(hands(r, { windup: 1, windKind }).max.y, windKind).toBeGreaterThan(top + 0.1);
  });
  it('coils into a deep crouch before a leap, then lunges forward with both arms out', () => {
    const crouch = bounds(rig, { windup: 1, windKind: 'leap' });
    expect(crouch.max.y).toBeLessThan(rig.height * 0.78);
    expect(crouch.min.y).toBeGreaterThan(-0.05);
    const rest = hands(rig, {});
    const lunge = hands(rig, { strike: 1, windKind: 'leap' });
    expect(lunge.min.z).toBeLessThan(rest.min.z - 0.3);
    // the crouch is a different shape from the rear-back: hands low, not overhead
    expect(hands(rig, { windup: 1, windKind: 'leap' }).max.y).toBeLessThan(crouch.max.y);
  });
  it('lies flat when dead and toppled', () => {
    const b = bounds(rig, { dead: true }, undefined, (i) => {
      i.fall = rig.lie.angle;
      i.fallDx = 0;
      i.fallDy = 1;
      i.lift = rig.lie.lift;
    });
    expect(b.max.y).toBeLessThan(0.7);
    expect(b.min.y).toBeGreaterThan(-0.15);
  });
  it('poseBounds (pure FK) agrees with the renderer', () => {
    for (const id of ['mon_zombie', 'mon_boomer_huge', 'mon_zombie_hulk', 'mon_zombie_shrieker']) {
      const r = makeRig(bodyShapeOf(like(MON[id])));
      const [lo, hi] = poseBounds(r, idle);
      const b = bounds(r);
      expect(Math.abs(lo - b.min.y), id).toBeLessThan(1e-4);
      expect(Math.abs(hi - b.max.y), id).toBeLessThan(1e-4);
    }
  });
});

describe('unit shapes (shapes.ts)', () => {
  it('fit the unit cube, keep the six-face texturing and outward normals', () => {
    for (const s of SHAPES) {
      const g = shapeGeometry(s);
      const P = g.getAttribute('position'), N = g.getAttribute('normal'), F = g.getAttribute('cFace');
      const idx = g.getIndex()!;
      for (let i = 0; i < P.count; i++) {
        for (const v of [P.getX(i), P.getY(i), P.getZ(i)]) expect(Math.abs(v), s).toBeLessThanOrEqual(0.5 + 1e-6);
        expect(F.getX(i), s).toBeGreaterThanOrEqual(0);
        expect(F.getX(i), s).toBeLessThanOrEqual(5);
        for (const u of [F.getY(i), F.getZ(i)]) (expect(u, s).toBeGreaterThanOrEqual(-1e-6), expect(u, s).toBeLessThanOrEqual(1 + 1e-6));
        expect(Math.hypot(N.getX(i), N.getY(i), N.getZ(i)), s).toBeCloseTo(1, 5);
      }
      // every triangle is wound outward and belongs to one face
      for (let t = 0; t < idx.count; t += 3) {
        const [a, b, c] = [idx.getX(t), idx.getX(t + 1), idx.getX(t + 2)];
        const va = new THREE.Vector3().fromBufferAttribute(P, a), vb = new THREE.Vector3().fromBufferAttribute(P, b), vc = new THREE.Vector3().fromBufferAttribute(P, c);
        const n = vb.clone().sub(va).cross(vc.clone().sub(va));
        expect(n.dot(va.clone().add(vb).add(vc)), s).toBeGreaterThan(0);
        expect(F.getX(a) === F.getX(b) && F.getX(b) === F.getX(c), s).toBe(true);
      }
    }
    expect(shapeGeometry('box').getIndex()!.count / 3).toBe(12);
  });
});

describe('zombie skins (zombieSkin.ts)', () => {
  // a 4x6 sprite: hair, grey-green face, a shirt, jeans, shoes
  const rows = ['hhhh', 'ffff', 'ssss', 'ssss', 'pppp', 'oooo'];
  const col: Record<string, [number, number, number]> = { h: [60, 40, 30], f: [120, 150, 110], s: [150, 40, 40], p: [50, 60, 120], o: [40, 30, 30] };
  const sprite: Img = { w: 4, h: 6, data: new Uint8Array(4 * 6 * 4) };
  rows.forEach((r, y) => [...r].forEach((ch, x) => sprite.data.set([...col[ch], 255], (y * 4 + x) * 4)));
  const info = analyseSprite(sprite);
  const paint = (id: string, name: string, size: [number, number, number]) => {
    const rig = makeRig(bodyShapeOf(like(MON[id])));
    const part = rig.parts.find((p) => p.name === name)!;
    expect(part, name).toBeTruthy();
    const d = texelDims(size ?? part.size);
    const [w, h] = netSize(...d);
    const img: Img = { w, h, data: new Uint8Array(w * h * 4) };
    paintZombiePart(img, 0, 0, d, part.src, part.name, personPalette(info, true), rig.zlook!, 0.42, 0);
    // alpha of the texels on the six face rects only (the net's corners are never painted)
    const [W, H, D] = d;
    const rects = [[0, D, D, H], [D, D, W, H], [D + W, D, D, H], [2 * D + W, D, W, H], [D, 0, W, D], [D + W, 0, W, D]];
    const alphas: number[] = [];
    for (const [x0, y0, fw, fh] of rects) for (let y = y0; y < y0 + fh; y++) for (let x = x0; x < x0 + fw; x++) alphas.push(img.data[(y * w + x) * 4 + 3]);
    return alphas;
  };
  it('makes acid sacs and arcs glow, cuts rags ragged, leaves skin opaque', () => {
    const sac = paint('mon_zombie_spitter', 'sac0', [0.12, 0.12, 0.12]);
    expect(sac.every((a) => a > 0 && a < 255)).toBe(true);
    const rag = paint('mon_zombie', 'ragFront', [0.15, 0.24, 0.03]);
    expect(rag.some((a) => a === 0)).toBe(true);
    expect(rag.some((a) => a === 255)).toBe(true);
    const torso = paint('mon_zombie', 'torso', [0.37, 0.46, 0.22]);
    expect(torso.every((a) => a === 255)).toBe(true);
  });
  it('burns red eyes into a necromancer', () => {
    const head = paint('mon_zombie_necro', 'head', [0.21, 0.19, 0.23]);
    expect(head.some((a) => a < 255)).toBe(true);
  });
});

describe('aim picking skips cosmetic fx parts', () => {
  it('a flickering arc (scaled to nothing) never makes the model unpickable', () => {
    const rig = makeRig(bodyShapeOf(like(MON.mon_zombie_electric)));
    const inst = built(rig);
    // collapse every fx part's matrix, as a hidden arc would be
    rig.parts.forEach((p, i) => {
      if (p.name.startsWith('fx')) inst.mats.fill(0, i * 16, i * 16 + 16);
    });
    const hit = pickModel({ rig, mats: inst.mats, visible: true }, { x: 0, y: -5, h: 1.2 }, { x: 0, y: 1, h: 0 });
    expect(hit).toBeTruthy();
    expect(hit!.part.startsWith('fx')).toBe(false);
  });
});

describe('idle life (creature.ts IDLE_LIFE)', () => {
  // Zombies standing about, and dormant far figures the simulation never moves, used to hold a
  // near-still pose that read as statues past a few metres.
  const state: CreatureState = { x: 5, y: 5, z: 0, facing: 0, target: null, moving: false, walkPhase: 0, windup: null, flinch: 0, down: 0, visible: true, emph: 1, camDist: 40, sy: 1, sxz: 1 };
  const run = (id: string, s: Partial<CreatureState> = {}) => {
    const rig = makeRig(bodyShapeOf(like(MON[id])));
    const skin: Skin = { page: 0, rects: new Int32Array(rig.parts.length * 5), refs: 0 };
    const cm = new CreatureModel(new CharLayer(false), rig, skin, 0.37, 5, 5, 0);
    const roll: number[] = [], yaw: number[] = [];
    let stepped = false;
    for (let i = 0; i < 30 * 15; i++) {
      cm.update(1 / 30, { ...state, ...s });
      roll.push(cm.inst.pose.lean[2]);
      yaw.push(cm.inst.yaw);
      if (Math.abs(cm.inst.pose.rot[HUM.thighR * 3]) > 0.05) stepped = true;
    }
    const span = (a: number[]) => Math.max(...a) - Math.min(...a);
    return { roll: span(roll.slice(60)), yaw: span(yaw), stepped };
  };

  it('an idle zombie rocks visibly, shuffles its feet and turns now and then', () => {
    const r = run('mon_zombie');
    expect(r.roll).toBeGreaterThan(0.08);
    expect(r.stepped).toBe(true);
    expect(r.yaw).toBeGreaterThan(0.1);
  });

  it('stays out of the way while it fights or walks', () => {
    const r = run('mon_zombie', { target: { x: 5, y: 3 } });
    expect(r.roll).toBeLessThan(0.02);
    expect(r.yaw).toBeLessThan(0.01);
  });

  it('leaves animals alone', () => {
    expect(run('mon_dog').roll).toBeLessThan(0.02);
  });
});
