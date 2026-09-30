// Held items for the first-person view (fpView.ts): low-poly meshes by class, coloured from
// the item's sprite. Pure (no three.js), for tests.
//
// Item space: the grip is the origin, in the fist. Guns point forward (-z) with the sights up
// (+y); melee weapons and tools rise out of the fist along +y (the view tilts them forward and
// across). `support` is where the off hand goes on two-handed items (null = one hand), `muzzle`
// where the flash appears.

import type { Palette, RGB } from './paint';
import type { PartDef } from './rig';

export type HeldClass =
  | 'pistol' | 'rifle' | 'shotgun' | 'smg' | 'launcher' | 'crossbow'
  | 'knife' | 'machete' | 'sword' | 'axe' | 'bat' | 'pipe' | 'spear' | 'hammer'
  | 'flashlight' | 'generic';

export interface HeldItemLike {
  typeId: string;
  isGun?(): boolean;
  def?: { skill?: string; volume?: number; name?: string | { str?: string } };
}

const GUN_BY_SKILL: Record<string, HeldClass> = { pistol: 'pistol', rifle: 'rifle', shotgun: 'shotgun', smg: 'smg', launcher: 'launcher' };

/** Which mesh to build for an item: guns by skill, the rest by id/name keywords. */
export function heldClass(item: HeldItemLike): HeldClass {
  const id = item.typeId.toLowerCase();
  const nm = typeof item.def?.name === 'string' ? item.def.name.toLowerCase() : (item.def?.name?.str ?? '').toLowerCase();
  const t = `${id} ${nm}`;
  if (item.isGun?.()) {
    if (/crossbow/.test(t)) return 'crossbow';
    return GUN_BY_SKILL[item.def?.skill ?? ''] ?? ((item.def?.volume ?? 0) > 1500 ? 'rifle' : 'pistol');
  }
  const rules: [RegExp, HeldClass][] = [
    [/flashlight|torch|lantern|glowstick/, 'flashlight'],
    [/spear|pike|lance|pitchfork|glaive|halberd|naginata|javelin|qiang/, 'spear'],
    [/machete|kukri|cleaver|bolo/, 'machete'],
    [/sword|katana|sabre|saber|rapier|scimitar|cutlass|zweihander|wakizashi|blade/, 'sword'],
    [/knife|dagger|shiv|scalpel|bayonet|tanto|kris|switchblade/, 'knife'],
    [/axe|_ax\b|\bax\b|hatchet|tomahawk|halligan/, 'axe'],
    [/sledge|hammer|mallet|maul/, 'hammer'],
    [/pipe|crowbar|rebar|wrench|tire_iron|\bbar\b|golf|shovel|broom|rake/, 'pipe'],
    [/bat\b|_bat|baseball|club|cudgel|baton|nightstick|mace|morningstar|stick|cane|2x4|plank/, 'bat'],
  ];
  for (const [re, c] of rules) if (re.test(t)) return c;
  return 'generic';
}

export interface HeldBuild {
  parts: PartDef[];
  /** extra rotation of the whole item in the fist (euler x, y, z), before the view pose */
  hold: [number, number, number];
  support: [number, number, number] | null;
  muzzle: [number, number, number] | null;
  gun: boolean;
}

const STEEL: RGB = [168, 174, 182];
const EDGE: RGB = [214, 220, 226];
const GUNMETAL: RGB = [46, 48, 54];
const WOOD: RGB = [118, 80, 48];
const GRIP: RGB = [40, 36, 34];

/**
 * Parts for a held item, parents relative to this list (-1 = the fist). Colours come from the
 * sprite palette where the item has its own look (a red bat, a wooden stock), fixed materials
 * for steel. `volume` (ml) sizes generic objects.
 */
export function buildHeld(cls: HeldClass, pal: Palette, volume = 500): HeldBuild {
  const P: PartDef[] = [];
  const add = (name: string, parent: number, joint: [number, number, number], size: [number, number, number], center: [number, number, number], color: RGB, o: Partial<PartDef> = {}): number => {
    P.push({ name, parent, joint, size, center, src: { color: color.map((v) => Math.round(v)) as RGB }, kind: 'thin', ...o });
    return P.length - 1;
  };
  const main = pal.main, dark = pal.dark, light = pal.light;
  // a stock / furniture colour: the sprite's main colour when it looks like wood, else polymer
  const brownish = main[0] > main[2] * 1.25 && main[0] > 70;
  const furniture = brownish ? main : GRIP;
  switch (cls) {
    case 'pistol': {
      add('grip', -1, [0, 0, 0], [0.032, 0.11, 0.05], [0, -0.025, 0.01], GRIP, { rest: [-0.25, 0, 0] });
      const slide = add('slide', -1, [0, 0.068, -0.05], [0.034, 0.04, 0.2], [0, 0, 0], main[0] + main[1] + main[2] > 360 ? main : GUNMETAL, { taper: [0.9, 0.9, 1, 1], taperAxis: 'z' });
      add('frame', -1, [0, 0.042, -0.07], [0.03, 0.022, 0.16], [0, 0, 0], GRIP);
      add('guard', -1, [0, -0.005, -0.045], [0.012, 0.025, 0.045], [0, 0, 0], GRIP);
      add('front', slide, [0, 0.024, -0.09], [0.007, 0.01, 0.012], [0, 0, 0], [20, 20, 20]);
      add('rear', slide, [0, 0.024, 0.085], [0.024, 0.01, 0.01], [0, 0, 0], [20, 20, 20]);
      return { parts: P, hold: [0, 0, 0], support: [-0.035, -0.045, 0.02], muzzle: [0, 0.068, -0.16], gun: true };
    }
    case 'rifle':
    case 'smg':
    case 'shotgun':
    case 'launcher':
    case 'crossbow': {
      if (cls === 'launcher') {
        add('tube', -1, [0, 0.07, -0.1], [0.1, 0.1, 0.85], [0, 0, 0], main, { kind: 'core' });
        add('grip', -1, [0, 0, 0], [0.03, 0.1, 0.045], [0, -0.02, 0], GRIP);
        add('sight', -1, [-0.06, 0.1, -0.05], [0.03, 0.05, 0.06], [0, 0, 0], GUNMETAL);
        return { parts: P, hold: [0, 0, 0], support: [0, -0.01, -0.28], muzzle: [0, 0.07, -0.55], gun: true };
      }
      const long = cls !== 'smg';
      const shotgun = cls === 'shotgun';
      const recv = add('receiver', -1, [0, 0.035, -0.06], [0.046, 0.075, long ? 0.26 : 0.24], [0, 0, 0], shotgun ? GUNMETAL : main[0] + main[1] + main[2] > 300 ? main : GUNMETAL, { kind: 'core' });
      add('grip', -1, [0, 0, 0.02], [0.032, 0.09, 0.045], [0, -0.03, 0], GRIP, { rest: [-0.3, 0, 0] });
      if (long) add('stock', recv, [0, -0.015, 0.13], [0.04, 0.085, 0.3], [0, -0.01, 0.15], shotgun || brownish ? WOOD : furniture, { taper: [1, 0.8, 1, 1.2], taperAxis: 'z' });
      const bl = cls === 'smg' ? 0.14 : shotgun ? 0.5 : 0.46;
      add('barrel', recv, [0, 0.012, -0.13], [shotgun ? 0.03 : 0.02, shotgun ? 0.03 : 0.02, bl], [0, 0, -bl / 2], GUNMETAL);
      if (shotgun) add('pump', recv, [0, -0.02, -0.3], [0.05, 0.045, 0.15], [0, 0, 0], WOOD);
      else if (cls !== 'crossbow') add('handguard', recv, [0, 0.0, -0.22], [0.05, 0.055, long ? 0.22 : 0.1], [0, 0, 0], furniture);
      if (cls === 'rifle' || cls === 'smg') add('mag', recv, [0, -0.05, cls === 'smg' ? -0.02 : -0.06], [0.03, 0.12, 0.06], [0, -0.04, 0], GUNMETAL, { rest: [0.2, 0, 0] });
      add('sight', recv, [0, 0.05, 0.02], [0.02, 0.025, 0.05], [0, 0, 0], [24, 24, 26]);
      add('post', recv, [0, 0.03, long ? -0.5 : -0.2], [0.008, 0.03, 0.01], [0, 0, 0], [24, 24, 26]);
      if (cls === 'crossbow') {
        add('prod', recv, [0, 0.02, -0.34], [0.55, 0.025, 0.035], [0, 0, 0], dark, { taper: [1, 1, 1, 1] });
        add('string', recv, [0, 0.02, -0.26], [0.5, 0.006, 0.006], [0, 0, 0], [220, 214, 196]);
      }
      const muzzleZ = -0.19 - bl;
      return { parts: P, hold: [0, 0, 0], support: [0, -0.035, shotgun ? -0.36 : long ? -0.3 : -0.1], muzzle: [0, 0.047, muzzleZ], gun: cls !== 'crossbow' };
    }
    case 'knife': {
      add('handle', -1, [0, -0.02, 0], [0.03, 0.11, 0.032], [0, 0, 0], dark);
      add('guard', -1, [0, 0.04, 0], [0.012, 0.012, 0.05], [0, 0, 0], STEEL);
      add('blade', -1, [0, 0.045, 0], [0.01, 0.17, 0.034], [0, 0.085, -0.004], STEEL, { taper: [1, 1, 0.3, 0.2] });
      add('edge', -1, [0, 0.045, -0.02], [0.006, 0.15, 0.006], [0, 0.07, 0], EDGE, { taper: [1, 1, 0.5, 0.5] });
      // broad side of the blade toward the eye, not its edge
      return { parts: P, hold: [-0.5, 1.1, 0.35], support: null, muzzle: null, gun: false };
    }
    case 'machete':
    case 'sword': {
      const len = cls === 'sword' ? 0.75 : 0.45;
      const w = cls === 'sword' ? 0.04 : 0.055;
      add('handle', -1, [0, -0.03, 0], [0.032, cls === 'sword' ? 0.18 : 0.13, 0.034], [0, 0, 0], dark);
      add('guard', -1, [0, 0.045, 0], [0.018, 0.016, cls === 'sword' ? 0.16 : 0.07], [0, 0, 0], cls === 'sword' ? [160, 130, 70] : GRIP);
      add('blade', -1, [0, 0.05, 0], [0.01, len, w], [0, len / 2, -0.004], STEEL, { taper: [1, 1, 0.5, cls === 'sword' ? 0.35 : 1.2] });
      add('edge', -1, [0, 0.05, -w / 2], [0.006, len * 0.95, 0.006], [0, len / 2, 0], EDGE);
      return { parts: P, hold: [-0.45, 1.1, 0.4], support: null, muzzle: null, gun: false };
    }
    case 'axe': {
      add('haft', -1, [0, -0.08, 0], [0.034, 0.62, 0.034], [0, 0.26, 0], brownish ? main : WOOD, { taper: [0.9, 0.9, 1.1, 1.1] });
      const head = add('head', -1, [0, 0.48, 0], [0.03, 0.08, 0.13], [0, 0, -0.03], GUNMETAL, { taper: [1, 0.7, 1, 1.3], taperAxis: 'z' });
      add('bit', head, [0, 0, -0.1], [0.012, 0.15, 0.03], [0, 0, 0], EDGE);
      return { parts: P, hold: [-0.4, 0, 0.45], support: [0, -0.2, 0], muzzle: null, gun: false };
    }
    case 'hammer': {
      add('haft', -1, [0, -0.06, 0], [0.032, 0.5, 0.032], [0, 0.2, 0], brownish ? main : WOOD);
      add('head', -1, [0, 0.42, 0], [0.05, 0.06, 0.14], [0, 0, 0], GUNMETAL);
      return { parts: P, hold: [-0.4, 0, 0.45], support: volume > 2500 ? [0, -0.2, 0] : null, muzzle: null, gun: false };
    }
    case 'bat': {
      // knob, handle, fat barrel: tapered so it reads as a bat, not a plank
      add('knob', -1, [0, -0.09, 0], [0.045, 0.02, 0.045], [0, 0, 0], main);
      add('bat', -1, [0, -0.08, 0], [0.05, 0.78, 0.05], [0, 0.39, 0], main, { taper: [0.55, 0.55, 1.25, 1.25] });
      add('tape', -1, [0, -0.02, 0], [0.034, 0.12, 0.034], [0, 0, 0], dark);
      return { parts: P, hold: [-0.4, 0, 0.45], support: volume > 1500 ? [0, -0.17, 0] : null, muzzle: null, gun: false };
    }
    case 'pipe': {
      add('bar', -1, [0, -0.1, 0], [0.032, 0.7, 0.032], [0, 0.33, 0], main[0] + main[1] + main[2] > 200 ? main : STEEL);
      add('end', -1, [0, 0.58, 0], [0.04, 0.04, 0.06], [0, 0, -0.02], dark, { rest: [0.5, 0, 0] });
      return { parts: P, hold: [-0.4, 0, 0.45], support: null, muzzle: null, gun: false };
    }
    case 'spear': {
      add('shaft', -1, [0, -0.5, 0], [0.03, 1.5, 0.03], [0, 0.6, 0], brownish ? main : WOOD);
      add('tip', -1, [0, 1.1, 0], [0.012, 0.2, 0.04], [0, 0.1, 0], STEEL, { taper: [1, 1, 0.2, 0.1] });
      // held low and pointing ahead, both hands on the shaft
      return { parts: P, hold: [-1.5, 0, 0.1], support: [0, -0.35, 0], muzzle: null, gun: false };
    }
    case 'flashlight': {
      add('body', -1, [0, 0, -0.04], [0.036, 0.036, 0.18], [0, 0, 0], main[0] + main[1] + main[2] > 150 ? main : GUNMETAL);
      add('head', -1, [0, 0, -0.15], [0.052, 0.052, 0.05], [0, 0, 0], dark, { taper: [1.1, 1.1, 0.8, 0.8], taperAxis: 'z' });
      add('lens', -1, [0, 0, -0.178], [0.044, 0.044, 0.006], [0, 0, 0], [250, 244, 200]);
      // turned a little across the body so you see its length, not just the tail cap
      return { parts: P, hold: [0.15, 0.45, 0], support: null, muzzle: null, gun: false };
    }
    default: {
      // a lump the size of the thing, in its colours, sitting in the palm
      const side = Math.max(0.05, Math.min(0.28, Math.cbrt(volume) / 100));
      const b = add('object', -1, [0, 0.02, -0.03], [side * 0.8, side, side * 0.6], [0, side * 0.3, 0], main, { kind: 'core' });
      add('band', b, [0, side * 0.15, 0], [side * 0.82, side * 0.2, side * 0.62], [0, 0, 0], light);
      return { parts: P, hold: [-0.2, 0, 0.2], support: null, muzzle: null, gun: false };
    }
  }
}
