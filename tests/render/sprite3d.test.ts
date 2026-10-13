import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as THREE from 'three';
import { bodyShapeOf, type MonsterLike } from '../../src/render/chars/archetype';
import { HUM, makeRig, type PoseIn } from '../../src/render/chars/rig';
import { CharLayer, type Skin } from '../../src/render/chars/charLayer';
import { SPRITE_CORE_PARTS, SPRITE_MODELS, SPRITE_MODEL_GEAR, poseBounds, spriteModelOf } from '../../src/render/chars/zombie';
import { lodMix, newLodState, spriteFit, SPRITE_LOD } from '../../src/render/chars/spriteLod';
import { loadSpriteModels, materialCode, meshShape, registerTestMeshes, resetSpriteModelsForTests, spriteModelStats, type Fetcher } from '../../src/render/chars/spriteModels';
import monsters from '../../public/data/monsters.json';

type Mon = { id: string; bodytype?: string; species?: string[]; flags?: string[]; symbol?: string; volume?: number; special_attacks?: { id?: string; type?: string }[]; emit_fields?: { emit_id?: string }[] };
const MON = monsters as unknown as Record<string, Mon>;
const like = (m: Mon): MonsterLike => ({
  id: m.id, bodytype: m.bodytype, species: m.species, flags: m.flags, symbol: m.symbol, volume: m.volume,
  attacks: (m.special_attacks ?? []).map((a) => a.id ?? a.type ?? '').filter(Boolean),
  emits: (m.emit_fields ?? []).map((e) => e.emit_id ?? ''),
});
const idle: PoseIn = { t: 0, phase: 0, gait: 0, windup: null, windKind: 'melee', strike: 0, down: 0, flinch: 0, dead: false, seed: 0.5 };

const MODELS_DIR = path.resolve(import.meta.dirname, '../../public/models/zombies');
const fsFetch: Fetcher = async (url) => {
  const f = path.join(MODELS_DIR, url.replace(/^.*\//, ''));
  if (!fs.existsSync(f)) throw new Error(`no such file ${f}`);
  const b = fs.readFileSync(f);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

afterEach(() => resetSpriteModelsForTests());

describe('sprite <-> 3D distance LOD (spriteLod.ts)', () => {
  const cfg = { ...SPRITE_LOD, far: 30, band: 10, hysteresis: 2, flipTime: 0.2, near: 7 };
  it('off: the body at every distance, the close mesh inside `near`', () => {
    const st = newLodState(100, 'off', cfg);
    for (const d of [1, 10, 60, 200]) {
      const m = lodMix('off', d, st, 1 / 30, cfg);
      expect(m).toMatchObject({ modelFade: 0, spriteOpacity: 0, modelWidth: 1, spriteWidth: 1 });
      expect(m.detail).toBe(d < 7);
    }
  });
  it('dither: body below the band, sprite above, complementary in between', () => {
    const st = newLodState(0, 'dither', cfg);
    expect(lodMix('dither', 20, st, 0, cfg)).toMatchObject({ modelFade: 0, spriteOpacity: 0 });
    expect(lodMix('dither', 40, st, 0, cfg)).toMatchObject({ modelFade: 1, spriteOpacity: 1 });
    let last = -1;
    for (let d = 25; d <= 35; d += 0.5) {
      const m = lodMix('dither', d, st, 0, cfg);
      // the same ordered-dither threshold on both sides: every pixel is exactly one of them
      expect(m.modelFade).toBeCloseTo(m.spriteOpacity, 9);
      expect(m.spriteOpacity).toBeGreaterThanOrEqual(last);
      last = m.spriteOpacity;
    }
  });
  it('pop: one switch each way, no flicker inside the hysteresis', () => {
    const st = newLodState(10, 'pop', cfg);
    let switches = 0, prev = lodMix('pop', 10, st, 0, cfg).spriteOpacity;
    // walk away to 40 m, jitter around the switch distance, come back
    const path_ = [...Array.from({ length: 31 }, (_, i) => 10 + i), 31, 29.5, 31.5, 28.5, 31, ...Array.from({ length: 31 }, (_, i) => 40 - i)];
    for (const d of path_) {
      const m = lodMix('pop', d, st, 1 / 30, cfg);
      expect(m.modelFade === 1).toBe(m.spriteOpacity === 1);
      if (m.spriteOpacity !== prev) switches++;
      prev = m.spriteOpacity;
    }
    expect(switches).toBe(2);
  });
  it('flip: the old picture narrows to an edge, the new one widens back, then it settles', () => {
    const st = newLodState(20, 'flip', cfg);
    const widths: number[] = [];
    let m = lodMix('flip', 40, st, 1 / 60, cfg);
    for (let t = 0; t < 0.3; t += 1 / 60) {
      widths.push(m.spriteOpacity ? m.spriteWidth : m.modelWidth);
      m = lodMix('flip', 40, st, 1 / 60, cfg);
    }
    // starts on the body narrowing, ends on the sprite at full width
    expect(Math.min(...widths)).toBeLessThan(0.15);
    expect(m).toMatchObject({ spriteOpacity: 1, modelFade: 1, spriteWidth: 1, modelWidth: 1 });
    expect(st.flipT).toBe(0);
  });
  it('sizes the billboard by the sprite figure, feet on the floor', () => {
    // a 32x48 frame whose figure fills rows 13..42 (UltiCa's plain zombie), body 1.6 m tall
    const f = spriteFit(1.6, 48, 13, 42);
    expect((f.height * (42 - 13)) / 48).toBeCloseTo(1.6, 6);
    expect(f.sink).toBeCloseTo((6 * 1.6) / 29, 6);
  });
});

describe('sprite3d rigs (zombie.ts)', () => {
  it('maps the modelled kinds to their own model and the rest to one that exists', () => {
    const want: Record<string, string> = {
      mon_zombie: 'walker', mon_zombie_fat: 'fat', mon_zombie_brute: 'brute', mon_zombie_runner: 'runner', mon_zombie_cop: 'cop',
      mon_zombie_soldier: 'soldier', mon_boomer: 'boomer', mon_zombie_spitter: 'spitter', mon_zombie_corrosive: 'spitter',
      mon_zombie_child: 'child', mon_skeleton: 'skeleton', mon_zombie_hulk: 'walker', mon_zombie_necro: 'walker',
    };
    for (const [id, model] of Object.entries(want)) expect(spriteModelOf(bodyShapeOf(like(MON[id])).zlook!), id).toBe(model);
  });
  it('puts a mesh on every core part, keeps the person parts and floor contact', () => {
    for (const m of Object.values(MON)) {
      const sh = bodyShapeOf(like(m));
      if (!sh.zlook || sh.weapon) continue;
      const rig = makeRig(sh, { zstyle: 'sprite3d', variant: 1 });
      const model = rig.meshModel!;
      expect(SPRITE_MODELS, m.id).toContain(model);
      for (const [name, i] of Object.entries(HUM)) expect(rig.parts[i].name, m.id).toBe(name);
      const allowed = new Set([...SPRITE_CORE_PARTS, ...SPRITE_MODEL_GEAR[model as keyof typeof SPRITE_MODEL_GEAR]]);
      for (const p of rig.parts) {
        if (p.mesh) {
          expect(p.mesh, m.id).toBe(`${model}/${p.name}`);
          expect(allowed.has(p.name), `${m.id} ${p.name}`).toBe(true);
          expect(p.taper, `${m.id} ${p.name}: the mesh is modelled tapered`).toBeUndefined();
        } else if (SPRITE_CORE_PARTS.includes(p.name)) {
          // only the bloody stump of a torn-off forearm keeps its painted shape
          expect(p.src.zr, `${m.id} ${p.name}`).toBe('flesh');
        }
      }
      if (!sh.crawl && !sh.flies) expect(Math.abs(poseBounds(rig, idle)[0]), `${m.id} floor`).toBeLessThan(0.03);
    }
  });
});

describe('sprite3d models (spriteModels.ts)', () => {
  it('loads every model in public/models/zombies with every part the rigs may ask for', async () => {
    await loadSpriteModels('/models/zombies/', fsFetch);
    for (const model of SPRITE_MODELS) {
      for (const part of [...SPRITE_CORE_PARTS, ...SPRITE_MODEL_GEAR[model]]) {
        const s = meshShape(`${model}/${part}`);
        for (const g of [s.lo, s.hi]) {
          const n = g.getAttribute('position').count;
          expect(n % 3, `${model}/${part}`).toBe(0);
          expect(g.getAttribute('cCol').count).toBe(n);
          g.computeBoundingBox();
          // authored in the part's unit box: may poke out a little (hair, a hem, claws), no more
          const b = g.boundingBox!;
          for (const v of [...b.min.toArray(), ...b.max.toArray()]) expect(Math.abs(v), `${model}/${part}`).toBeLessThan(1.6);
        }
      }
      // low poly: a few hundred to ~1.5k triangles a body; the close variant ~4x
      const t = spriteModelStats()[model];
      expect(t.lo, model).toBeGreaterThan(300);
      expect(t.lo, model).toBeLessThan(1700);
      expect(t.hi, model).toBeGreaterThan(t.lo * 2);
    }
  });
  it('fails loudly: a missing GLB rejects the load, and nothing is half-registered', async () => {
    const broken: Fetcher = (url) => (url.endsWith('/cop_hi.glb') ? Promise.reject(new Error('HTTP 404')) : fsFetch(url));
    await expect(loadSpriteModels('/models/zombies/', broken)).rejects.toThrow(/404/);
    expect(() => meshShape('walker/torso')).toThrow(/before loadSpriteModels/);
    // fixed assets load fine afterwards (the failure isn't cached)
    await loadSpriteModels('/models/zombies/', fsFetch);
    expect(meshShape('walker/torso').lo.getAttribute('position').count).toBeGreaterThan(0);
  });
  it('fails loudly: a model missing from the manifest, or a part missing from a GLB', async () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(MODELS_DIR, 'manifest.json'), 'utf8'));
    delete manifest.models.boomer;
    const noBoomer: Fetcher = (url) => (url.endsWith('manifest.json') ? Promise.resolve(new TextEncoder().encode(JSON.stringify(manifest)).buffer as ArrayBuffer) : fsFetch(url));
    await expect(loadSpriteModels('/models/zombies/', noBoomer)).rejects.toThrow(/boomer missing/);
    // a GLB that lacks the soldier's vest: serve the walker's in its place
    const swapped: Fetcher = (url) => fsFetch(url.endsWith('/soldier.glb') ? url.replace('soldier.glb', 'walker.glb') : url);
    await expect(loadSpriteModels('/models/zombies/', swapped)).rejects.toThrow(/soldier has no lo mesh for part headHelmet/);
    // an unknown mesh key once loaded
    await loadSpriteModels('/models/zombies/', fsFetch);
    expect(() => meshShape('walker/headHelmet')).toThrow(/no mesh walker\/headHelmet/);
  });
  it('parses material names into colour codes, and rejects anything else', () => {
    const c = new THREE.Color(0.5, 0.25, 0.125);
    expect(materialCode('fix:7a1214', c)).toEqual([0.5, 0.25, 0.125, 0]);
    expect(materialCode('glow:ff0000:0.50', c)).toEqual([0.5, 0.25, 0.125, -1.5]);
    expect(materialCode('pal:pants:0.85', c)).toEqual([0.85, 0.85, 0.85, 7]);
    expect(() => materialCode('pal:cape:1.00', c)).toThrow(/bad palette/);
    expect(() => materialCode('Material.001', c)).toThrow(/unknown material/);
  });
});

describe('sprite3d in the character layer (charLayer.ts)', () => {
  const rig = () => makeRig(bodyShapeOf(like(MON.mon_zombie)), { zstyle: 'sprite3d', variant: 0 });
  it('draws meshed parts in their own batches, reading the palette row', () => {
    const r = rig();
    registerTestMeshes(r.parts.filter((p) => p.mesh).map((p) => p.mesh!));
    const layer = new CharLayer(false);
    const skin: Skin = { page: 0, rects: new Int32Array(r.parts.length * 5), refs: 0, pal: [10, 20] };
    const store = { upload() {}, texture: () => new THREE.DataTexture(new Uint8Array(4), 1, 1) } as never;
    const inst = layer.add(r, skin);
    inst.setPose(idle);
    layer.flush(0, store);
    const meshes: THREE.InstancedMesh[] = [];
    layer.group.traverse((o) => { if ((o as THREE.InstancedMesh).isInstancedMesh) meshes.push(o as THREE.InstancedMesh); });
    const meshed = meshes.filter((m) => m.geometry.getAttribute('cCol'));
    expect(meshed.reduce((a, m) => a + m.count, 0)).toBe(r.parts.filter((p) => p.mesh).length);
    // cTex.xy of a meshed instance is the palette row origin
    const tex = meshed[0].geometry.getAttribute('cTex') as THREE.InstancedBufferAttribute;
    expect([tex.getX(0), tex.getY(0)]).toEqual([10, 20]);
    // the close-range variant moves the same parts into other batches
    inst.detail = true;
    layer.touch(true);
    layer.flush(0, store);
    const after: THREE.InstancedMesh[] = [];
    layer.group.traverse((o) => { if ((o as THREE.InstancedMesh).isInstancedMesh && (o as THREE.InstancedMesh).count) after.push(o as THREE.InstancedMesh); });
    expect(after.filter((m) => m.geometry.getAttribute('cCol')).length).toBe(meshed.length);
  });
  it('refuses a meshed rig on a skin without a palette, and meshes that were never loaded', () => {
    const r = rig();
    const store = { upload() {}, texture: () => new THREE.DataTexture(new Uint8Array(4), 1, 1) } as never;
    const layer = new CharLayer(false);
    layer.add(r, { page: 0, rects: new Int32Array(r.parts.length * 5), refs: 0, pal: [0, 0] }).setPose(idle);
    expect(() => layer.flush(0, store)).toThrow(/before loadSpriteModels/);
    registerTestMeshes(r.parts.filter((p) => p.mesh).map((p) => p.mesh!));
    const layer2 = new CharLayer(false);
    layer2.add(r, { page: 0, rects: new Int32Array(r.parts.length * 5), refs: 0 }).setPose(idle);
    expect(() => layer2.flush(0, store)).toThrow(/without a palette row/);
  });
});
