// Export the sprite3d zombie rigs for the Blender pipeline (tools/blender/zombies.py).
//
// The Blender models are drawn inside the game's own rig boxes (docs/SPRITE3D.md), so Blender
// needs those boxes: for each model, the representative monster's sprite3d rig in its idle pose
// (every part's size and box matrix), the palette the game will read off its UltiCa sprite, and
// the sprite itself (cropped from public/atlas) for the side-by-side comparison sheets.
//
//   npx tsx tools/blender/export-rigs.ts                 writes tools/blender/rigs.json + ref/*.png
//   npx tsx tools/blender/export-rigs.ts --dry-run       prints what it would write
//
// Re-run after changing zombie.ts proportions (BUILDS / buildOf), then re-run zombies.py.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { PNG } from 'pngjs';
import { bodyShapeOf, type MonsterLike } from '../../src/render/chars/archetype';
import { makeRig, type PoseIn } from '../../src/render/chars/rig';
import { CharLayer, type Skin } from '../../src/render/chars/charLayer';
import { SPRITE_CORE_PARTS, SPRITE_MODELS, SPRITE_MODEL_GEAR, spriteModelOf, type SpriteModelId } from '../../src/render/chars/zombie';
import { analyseSprite, type Img } from '../../src/render/chars/paint';
import { personPalette } from '../../src/render/chars/styled';
import { sprite3dPalette, zombiePalette } from '../../src/render/chars/zombieSkin';

const ROOT = path.resolve(import.meta.dirname, '../..');

/** The monster each model is built after (its sprite is the reference art). */
export const REPRESENTATIVE: Record<SpriteModelId, string> = {
  walker: 'mon_zombie', fat: 'mon_zombie_fat', brute: 'mon_zombie_brute', runner: 'mon_zombie_runner',
  cop: 'mon_zombie_cop', soldier: 'mon_zombie_soldier', boomer: 'mon_boomer', spitter: 'mon_zombie_spitter',
  child: 'mon_zombie_child', skeleton: 'mon_skeleton',
};

type Mon = { id: string; bodytype?: string; species?: string[]; flags?: string[]; symbol?: string; volume?: number; special_attacks?: { id?: string; type?: string }[]; emit_fields?: { emit_id?: string }[] };

function usage(): never {
  console.log(`usage: npx tsx tools/blender/export-rigs.ts [--dry-run] [--out tools/blender]

Writes rigs.json (sprite3d rig boxes in the idle pose + sprite palettes) and ref/<model>.png
(the UltiCa sprite each model is built after) for tools/blender/zombies.py.`);
  process.exit(0);
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) usage();
  const dry = args.includes('--dry-run');
  const oi = args.indexOf('--out');
  const out = path.resolve(oi >= 0 ? args[oi + 1] : path.join(ROOT, 'tools/blender'));
  const known = new Set(['--dry-run', '--out', '--help', '-h']);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out') { i++; continue; }
    if (!known.has(args[i])) throw new Error(`unknown argument ${args[i]} (--help)`);
  }

  const monsters = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/monsters.json'), 'utf8')) as Record<string, Mon>;
  const atlas = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/atlas/atlas.json'), 'utf8')) as {
    pages: { file: string }[]; frames: { page: number; x: number; y: number; w: number; h: number }[];
    tiles: Record<string, { fg?: unknown }>;
  };
  const pages = atlas.pages.map((p) => PNG.sync.read(fs.readFileSync(path.join(ROOT, 'public/atlas', p.file))));

  const idle: PoseIn = { t: 0, phase: 0, gait: 0, windup: null, windKind: 'melee', strike: 0, down: 0, flinch: 0, dead: false, seed: 0.5 };
  const models: unknown[] = [];
  const refs: [string, PNG][] = [];
  for (const model of SPRITE_MODELS) {
    const id = REPRESENTATIVE[model];
    const m = monsters[id];
    if (!m) throw new Error(`${id}: not in public/data/monsters.json`);
    const like: MonsterLike = {
      id: m.id, bodytype: m.bodytype, species: m.species, flags: m.flags, symbol: m.symbol, volume: m.volume,
      attacks: (m.special_attacks ?? []).map((a) => a.id ?? a.type ?? '').filter(Boolean),
      emits: (m.emit_fields ?? []).map((e) => e.emit_id ?? ''),
    };
    const shape = bodyShapeOf(like);
    if (!shape.zlook) throw new Error(`${id}: not a zombie body`);
    const got = spriteModelOf(shape.zlook);
    if (got !== model) throw new Error(`${id} maps to model ${got}, not ${model}: fix REPRESENTATIVE`);
    const rig = makeRig(shape, { zstyle: 'sprite3d', variant: 0 });
    const layer = new CharLayer(false);
    const skin: Skin = { page: 0, rects: new Int32Array(rig.parts.length * 5), refs: 0 };
    const inst = layer.add(rig, skin);
    inst.setPose(idle);
    inst.build(null);

    // the sprite (first variant): crop from the atlas page
    const fg = atlas.tiles[id]?.fg;
    const first = Array.isArray(fg) ? fg[0] : fg;
    const sprites = (first as { sprites?: number | number[] })?.sprites ?? first;
    const idx = Array.isArray(sprites) ? sprites[0] : sprites;
    if (typeof idx !== 'number') throw new Error(`${id}: no sprite in atlas.json`);
    const f = atlas.frames[idx];
    const page = pages[f.page];
    const crop = new PNG({ width: f.w, height: f.h });
    for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) {
      const si = ((f.y + y) * page.width + f.x + x) * 4, di = (y * f.w + x) * 4;
      for (let k = 0; k < 4; k++) crop.data[di + k] = page.data[si + k];
    }
    const img: Img = { w: f.w, h: f.h, data: new Uint8Array(crop.data) };
    const pp = sprite3dPalette(zombiePalette(personPalette(analyseSprite(img), shape.zlook.undead), shape.zlook));
    const rgb = (c: readonly number[] | null) => (c ? c.map((v) => Math.round(v)) : null);
    refs.push([model, crop]);

    models.push({
      model, monster: id, look: shape.zlook, height: rig.height,
      // every part the game may ask this model for (some only exist on other monsters of the
      // family: a corrosive zombie's extra sacs); zombies.py builds them all
      contract: [...SPRITE_CORE_PARTS, ...SPRITE_MODEL_GEAR[model]],
      sprite: { file: `ref/${model}.png`, w: f.w, h: f.h },
      palette: { skin: rgb(pp.skin), hair: rgb(pp.hair), bald: pp.bald, shirt: rgb(pp.shirt), inner: rgb(pp.inner), upperArm: rgb(pp.upperArm), foreArm: rgb(pp.foreArm), pants: rgb(pp.pants), shoes: rgb(pp.shoes), blood: pp.blood },
      parts: rig.parts.map((p, i) => ({
        name: p.name, mesh: !!p.mesh, size: p.size, kind: p.kind ?? null, shape: p.shape ?? 'box',
        region: p.src.region ?? null, zr: p.src.zr ?? null, color: p.src.color ?? null, glow: p.src.glow ?? 0,
        // three.js column-major box matrix: unit cube -> idle-pose world (y up, facing -z)
        box: Array.from(inst.mats.subarray(i * 16, i * 16 + 16)).map((v) => +v.toFixed(5)),
      })),
    });
    console.log(`${model.padEnd(9)} ${id.padEnd(20)} ${rig.parts.length} parts, ${rig.parts.filter((p) => p.mesh).length} meshed, height ${rig.height.toFixed(2)} m`);
  }
  const json = JSON.stringify({ generated: 'tools/blender/export-rigs.ts', models }, null, 1);
  if (dry) {
    console.log(`[dry-run] would write ${path.join(out, 'rigs.json')} (${json.length} bytes) and ${refs.length} sprites to ${path.join(out, 'ref')}`);
    return;
  }
  fs.mkdirSync(path.join(out, 'ref'), { recursive: true });
  fs.writeFileSync(path.join(out, 'rigs.json'), json);
  for (const [model, png] of refs) fs.writeFileSync(path.join(out, 'ref', `${model}.png`), PNG.sync.write(png));
  console.log(`wrote ${path.join(out, 'rigs.json')} and ref/*.png`);
}

main();
