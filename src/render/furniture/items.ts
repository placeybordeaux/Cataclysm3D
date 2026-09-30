import type { ItemDef } from '../../data/types';
import type { RGB } from '../colors';
import type { ModelBuilder } from './mesh';
import type { SpritePalette } from './palette';
import { inset, slats } from './paint';
import { F, hsv, lumOf, shade } from './kit';

// Ground items as small modelled objects (docs/FURNITURE.md): a handful of generic shapes
// (box, bottle, can, jar, bag, clothing heap, book, paper, stick, blade, gun, rock, round
// food, mug) picked from the item's category / id / material, sized from its volume and
// coloured from its UltiCa sprite. The icon itself stays in the UI; in the world a can should
// read as a can from three metres, not as a lump of voxels.

export type ItemShape =
  | 'box' | 'bottle' | 'can' | 'jar' | 'bag' | 'clothes' | 'book' | 'paper' | 'stick' | 'blade'
  | 'gun' | 'rock' | 'round' | 'mug' | 'device' | 'blanket';

/** Shape for an item definition. Pure; unit tested. */
export function itemShape(d: Pick<ItemDef, 'id' | 'category' | 'material' | 'phase' | 'volume'> & { type?: string; subtypes?: string[] }): ItemShape {
  const id = d.id;
  const cat = d.category ?? '';
  const mat = d.material?.[0] ?? '';
  const k = (re: RegExp) => re.test(id);
  if (k(/bottle|flask|jug|canteen|thermos|waterskin|wine|whiskey|vodka|beer|_gin$|rum$|ketchup|mustard|syrup/)) return 'bottle';
  if (k(/(^|_)jar(_|$)/)) return 'jar';
  if (k(/(^|_)can(_|$)|canned|tin_|soup|beans|soda|cola|spam|sardine|tuna/)) return 'can';
  if (k(/mug|(^|_)cup(_|$)|glass_|bowl|pot$|kettle/)) return 'mug';
  if (k(/blanket|sheet$|quilt|sleeping_bag|towel|rug|tarp/)) return 'blanket';
  if (k(/bag|sack|backpack|purse|pouch|duffel|rucksack|wrapper/)) return 'bag';
  if (cat === 'clothing' || cat === 'armor' || k(/pillow|shirt|pants|jacket|sock|hat|glove|boot|shoe|dress|coat/)) return 'clothes';
  if (cat === 'books' || k(/book|manual|magazine|novel|mag_|comic/)) return k(/newspaper|flyer|pamphlet|paper|file|note|photo|letter|map/) ? 'paper' : 'book';
  if (k(/paper|newspaper|flyer|pamphlet|file|note|photo|letter|(^|_)map(_|$)|card/)) return 'paper';
  if (cat === 'guns' || cat === 'magazines' && k(/rifle|gun/)) return 'gun';
  if (k(/knife|sword|machete|blade|katana|cleaver|dagger|razor|scissors|bayonet/)) return 'blade';
  if (k(/stick|pole|pipe|rod|plank|2x4|bat$|_bat|spear|cue|staff|broom|branch|bough|log$|rebar|crowbar|shovel|rake|hoe|axe|hammer|sledge/)) return 'stick';
  if (k(/rock|stone|brick|chunk|scrap|rubble|lump|ore|coal/) || cat === 'rocks') return 'rock';
  if (k(/apple|orange|lemon|potato|onion|tomato|egg|ball|fruit|berry|acorn|pinecone|melon|pumpkin|cabbage|seed/)) return 'round';
  if (cat === 'electronics' || cat === 'scrap_electronics' || k(/phone|radio|flashlight|battery|laptop|tablet|camera|television|hair_dryer|lighter/)) return 'device';
  if (cat === 'container' && d.phase !== 'solid') return 'bottle';
  return 'box';
}

/** Characteristic size (m) from BN volume (ml), enlarged for readability at small sizes. */
export function itemSize(volumeMl: number): number {
  const L = Math.cbrt(Math.max(1, volumeMl)) / 100;
  // real sizes make a can 2 texels wide and loot unreadable past arm's length: scale small
  // things up (a TV adaptation, not a sim); big things stay about their size
  return Math.min(0.45, Math.max(0.1, L * 1.9 + 0.04));
}

/** Colours: body, accent, label/light. Quantised so similar items share atlas frames. */
function colours(pal: SpritePalette): [RGB, RGB, RGB] {
  const q = (c: RGB): RGB => c.map((v) => Math.round(v / 12) * 12) as RGB;
  const body = pal.clusters.find((c) => lumOf(c.c) > 35)?.c ?? pal.main;
  const acc = pal.clusters.find((c) => Math.hypot(c.c[0] - body[0], c.c[1] - body[1], c.c[2] - body[2]) > 50 && lumOf(c.c) > 35)?.c ?? shade(body, 0.7);
  return [q(body), q(acc), q(pal.light)];
}

/** Build item `shape` of size `s` in local space (origin = centre of its footprint on the surface). */
export function buildItem(b: ModelBuilder, shape: ItemShape, s: number, pal: SpritePalette, seed: number): void {
  const [body, acc, light] = colours(pal);
  b.aoHeight = 0.02;
  switch (shape) {
    case 'box': {
      const w = s * 0.55, d = s * 0.4, h = s * 0.6;
      b.box(-w, 0, -d, w, h, d, (f) => (f === 'pz' || f === 'nz' ? F('cardboard', body, inset(0.2, 0.3, 0.8, 0.6, acc, false, false)) : F('cardboard', shade(body, 0.92))), 'ny');
      break;
    }
    case 'device': {
      const w = s * 0.5, d = s * 0.35, h = s * 0.3;
      b.box(-w, 0, -d, w, h, d, (f) => (f === 'py' ? F('plastic', body, inset(0.15, 0.2, 0.85, 0.7, [36, 40, 46], true, true)) : F('plastic', shade(body, 0.85))), 'ny');
      break;
    }
    case 'bottle': {
      const r = s * 0.2, h = s * 1.2;
      const glassy = hsv(body)[1] < 0.2 && lumOf(body) > 120;
      const bc = glassy ? ([120, 150, 140] as RGB) : body;
      b.prism(0, 0, 0, h * 0.62, r, 8, F('plastic', bc, slats(1, 0)), null);
      b.frustum(-r * 0.92, -r * 0.92, r * 0.92, r * 0.92, h * 0.62, h * 0.8, -r * 0.35, -r * 0.35, r * 0.35, r * 0.35, F('plastic', shade(bc, 1.05)), 'ny');
      b.box(-r * 0.35, h * 0.8, -r * 0.35, r * 0.35, h, r * 0.35, F('plastic', acc), 'ny');
      // label band
      b.prism(0, 0, h * 0.22, h * 0.45, r * 1.02, 8, F('paper', light), null);
      break;
    }
    case 'can': {
      const r = s * 0.28, h = s * 0.62;
      b.prism(0, 0, 0, h, r, 8, F('paint', body, slats(2, 1)), F('chrome', [176, 178, 180]));
      break;
    }
    case 'jar': {
      const r = s * 0.3, h = s * 0.7;
      b.prism(0, 0, 0, h * 0.85, r, 8, F('plastic', shade(body, 0.9)), null);
      b.prism(0, 0, h * 0.85, h, r * 0.85, 8, F('metal', acc));
      break;
    }
    case 'mug': {
      const r = s * 0.3, h = s * 0.5;
      b.prism(0, 0, 0, h, r, 8, F('enamel', body), F('dark', shade(body, 0.4)));
      b.box(r * 0.9, h * 0.25, -0.006, r * 1.35, h * 0.75, 0.006, F('enamel', body));
      break;
    }
    case 'bag': {
      const w = s * 0.5, d = s * 0.32, h = s * 0.55;
      b.frustum(-w, -d, w, d, 0, h * 0.7, -w * 1.02, -d * 1.05, w * 1.02, d * 1.05, F('fabric', body), 'ny');
      b.frustum(-w * 1.02, -d * 1.05, w * 1.02, d * 1.05, h * 0.7, h, -w * 0.7, -d * 0.4, w * 0.7, d * 0.4, F('fabric', shade(body, 1.08)), 'ny');
      break;
    }
    case 'clothes': case 'blanket': {
      // a folded heap: stacked slightly offset slabs
      const w = s * (shape === 'blanket' ? 0.8 : 0.6), d = s * (shape === 'blanket' ? 0.55 : 0.45);
      const layers = shape === 'blanket' ? 3 : 2;
      for (let i = 0; i < layers; i++) {
        const o = ((seed >> (i * 2)) & 3) * 0.008 - 0.012;
        const y0 = i * s * 0.07;
        b.box(-w + o, y0, -d - o, w + o, y0 + s * 0.07, d - o, F('fabric', i % 2 ? shade(body, 0.92) : body), 'ny');
      }
      if (shape === 'clothes') b.box(-w * 0.3, layers * s * 0.07, -d * 0.9, w * 0.3, layers * s * 0.07 + s * 0.02, -d * 0.4, F('fabric', acc), 'ny');
      break;
    }
    case 'book': {
      const w = s * 0.42, d = s * 0.3, h = s * 0.12;
      b.box(-w, 0, -d, w, h, d, (f) => (f === 'py' || f === 'ny' ? F('leather', body, inset(0.2, 0.2, 0.8, 0.45, light, false, false)) : f === 'nx' ? F('leather', shade(body, 0.8)) : F('paper', [226, 220, 200])), 'ny');
      break;
    }
    case 'paper': {
      const w = s * 0.4, d = s * 0.3;
      b.box(-w, 0, -d, w, 0.006, d, F('paper', lumOf(body) > 120 ? body : [220, 216, 204]), 'ny');
      break;
    }
    case 'stick': {
      const L = Math.max(0.35, s * 2.4), t = Math.max(0.025, s * 0.12);
      b.box(-L / 2, 0, -t / 2, L / 2, t, t / 2, (f) => F(hsv(body)[1] < 0.2 ? 'metal' : 'wood', f === 'py' ? body : shade(body, 0.85)), 'ny');
      if ((seed & 3) === 0) b.box(L / 2 - t * 3, 0, -t * 1.6, L / 2, t * 1.4, t * 1.6, F('metal', acc), 'ny');
      break;
    }
    case 'blade': {
      const L = Math.max(0.22, s * 2), t = 0.012;
      b.box(-L / 2, 0, -0.018, -L / 2 + L * 0.35, 0.025, 0.018, F('wood', acc), 'ny');
      b.frustum(-L / 2 + L * 0.35, -0.022, L / 2, 0.022, 0, t, -L / 2 + L * 0.35, -0.02, L / 2, 0.0, F('chrome', [190, 194, 198]), 'ny');
      break;
    }
    case 'gun': {
      const L = Math.max(0.3, s * 2);
      const c: RGB = lumOf(body) > 90 ? [60, 60, 64] : body;
      b.box(-L / 2, 0, -0.025, L / 2, 0.06, 0.025, F('metal', c), 'ny');
      b.box(-L / 2, 0, -0.022, -L / 2 + L * 0.25, 0.09, 0.022, F('wood', acc), 'ny');
      b.box(-L * 0.05, 0, 0.025, L * 0.05, 0.05, 0.1, F('metal', shade(c, 0.8)), 'ny');
      break;
    }
    case 'rock': {
      const r = s * 0.45;
      b.frustum(-r, -r * 0.8, r, r * 0.8, 0, r * 0.7, -r * 0.5, -r * 0.4, r * 0.6, r * 0.5, F('stone', body), 'ny');
      break;
    }
    case 'round': {
      const r = s * 0.35;
      b.frustum(-r * 0.7, -r * 0.7, r * 0.7, r * 0.7, 0, r * 0.6, -r, -r, r, r, F('plastic', body), 'nypy');
      b.frustum(-r, -r, r, r, r * 0.6, r * 1.4, -r * 0.6, -r * 0.6, r * 0.6, r * 0.6, F('plastic', shade(body, 1.08)), 'ny');
      break;
    }
  }
}

/** Height (m) of the item model's top, for stacking the next item on a pile. */
export function itemHeight(shape: ItemShape, s: number): number {
  switch (shape) {
    case 'bottle': return s * 1.2;
    case 'box': return s * 0.6;
    case 'device': return s * 0.3;
    case 'can': return s * 0.62;
    case 'jar': return s * 0.7;
    case 'mug': return s * 0.5;
    case 'bag': return s * 0.55;
    case 'clothes': return s * 0.16;
    case 'blanket': return s * 0.21;
    case 'book': return s * 0.12;
    case 'paper': return 0.006;
    case 'stick': return Math.max(0.025, s * 0.12);
    case 'blade': return 0.025;
    case 'gun': return 0.09;
    case 'rock': return s * 0.32;
    case 'round': return s * 0.5;
  }
}
