// Held items for the first-person view (fpView.ts): low-poly meshes by class, coloured from
// the item's sprite. Pure (no three.js), for tests.
//
// Item space: the grip is the origin, in the fist. Guns point forward (-z) with the sights up
// (+y); melee weapons and tools rise out of the fist along +y (the view tilts them forward and
// across). `support` is where the off hand goes on two-handed items (null = one hand), `muzzle`
// where the flash appears.

import type { Palette, RGB } from './paint';
import type { Detail, PartDef } from './rig';

export type HeldClass =
  | 'pistol' | 'rifle' | 'shotgun' | 'smg' | 'launcher' | 'crossbow'
  | 'knife' | 'machete' | 'sword' | 'axe' | 'bat' | 'pipe' | 'spear' | 'hammer'
  | 'flashlight' | 'generic';

export interface HeldItemLike {
  typeId: string;
  isGun?(): boolean;
  def?: { skill?: string; volume?: number; name?: string | { str?: string }; weapon_category?: string[]; looks_like?: string };
}

/**
 * A finer look within a class for the common weapons (BN weapon_category first, then the id
 * or its looks_like): a revolver isn't a Glock, a double-barrel isn't a pump.
 */
export function heldVariant(item: HeldItemLike, cls: HeldClass): string {
  const id = `${item.typeId} ${item.def?.looks_like ?? ''}`.toLowerCase();
  const cat = item.def?.weapon_category ?? [];
  switch (cls) {
    case 'pistol':
      if (cat.includes('REVOLVERS') || /revolver|python|redhawk|sw_?6|sw629|colt_navy|lcr/.test(id)) return 'revolver';
      if (/1911/.test(id)) return '1911';
      return 'auto';
    case 'shotgun':
      if (/1887|lever/.test(id)) return 'lever';
      if (/shotgun_d|double|coach/.test(id)) return 'double';
      if (/shotgun_s|single|shotgun_410|pipe_shotgun/.test(id)) return 'single';
      return 'pump';
    case 'rifle':
      if (/ak47|akm|ak74|rpk/.test(id)) return 'ak';
      // lever actions by id (BN files them under MANUAL_ACTION with the bolt guns, looks_like ar15);
      // the improvised "lever-action" pipe carbines keep the hunting look
      if (/henry|colt_ring/.test(id)) return 'lever_brass';
      if (/1895sbl/.test(id)) return 'lever_stainless';
      if (/browning_blr/.test(id)) return 'lever_box';
      if (/marlin|lever|win(chester)?_?(94|1873|1892|1886)|rossi_92/.test(id)) return 'lever';
      if (cat.includes('MANUAL_ACTION') || /win70|remington_700|mosin|garand|m1a|sks|hunting|flintlock/.test(id)) return 'hunting';
      return 'ar';
    case 'pipe':
      return /crowbar|halligan|prybar/.test(id) ? 'crowbar' : 'pipe';
    case 'knife':
      return /kitchen|chef|butcher|carving|bread|steak|paring|cleaver/.test(id) ? 'kitchen' : 'combat';
    case 'hammer':
      return /sledge|maul/.test(id) ? 'sledge' : 'hammer';
    case 'axe':
      return /hatchet|hand_axe|throwing|tomahawk/.test(id) ? 'hatchet' : /fire_ax|crash_axe/.test(id) ? 'fire' : 'axe';
  }
  return '';
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
    [/spear|pike|lance|pitchfork|glaive|halberd|naginata|javelin|qiang|\bji\b|scythe_war|lajatang/, 'spear'],
    [/machete|kukri|cleaver|bolo/, 'machete'],
    [/switchblade/, 'knife'],
    [/sword|katana|sabre|saber|rapier|scimitar|cutlass|zweihander|wakizashi|blade|jian|estoc|nodachi|khopesh|\bdao\b|fencing_(foil|epee)|shock_(foil|epee)|bokken/, 'sword'],
    [/knife|dagger|shiv|scalpel|bayonet|tanto|kris|kirpan|katar|jamadhar/, 'knife'],
    [/axe|_ax\b|\bax\b|hatchet|tomahawk|halligan/, 'axe'],
    [/sledge|hammer|mallet|maul|mjolnir|homewrecker/, 'hammer'],
    [/pipe|crowbar|rebar|wrench|tire_iron|\bbar\b|golf|shovel|broom|rake/, 'pipe'],
    [/bat\b|_bat|baseball|club|cudgel|baton|nightstick|mace|morningstar|stick|cane|2x4|plank|staff|tonfa|shillelagh|pool_cue|blackjack|_sap\b|nailboard|bowling_pin/, 'bat'],
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
const GUNMETAL: RGB = [58, 61, 68];
const WOOD: RGB = [124, 84, 50];
const GRIP: RGB = [44, 40, 38];

/**
 * Parts for a held item, parents relative to this list (-1 = the grip in the fist). Colours
 * come from the sprite palette where the item has its own look (a red bat, a wooden stock),
 * fixed materials for steel; surface detail (grain, serrations, ports, tape, bevels) is painted
 * by paint.ts at the first-person texel density. `volume` (ml) sizes generic objects.
 */
export function buildHeld(cls: HeldClass, pal: Palette, volume = 500, variant = ''): HeldBuild {
  const P: PartDef[] = [];
  const add = (name: string, parent: number, joint: [number, number, number], size: [number, number, number], center: [number, number, number], color: RGB, o: Partial<PartDef> & { detail?: Detail } = {}): number => {
    const { detail, ...rest } = o;
    P.push({ name, parent, joint, size, center, src: { color: color.map((v) => Math.round(v)) as RGB, detail }, kind: 'thin', ...rest });
    return P.length - 1;
  };
  /**
   * A round bar (bat, barrel, shaft, flashlight): a square prism plus a twin turned 45° about
   * its long axis — an 8-sided silhouette from any angle, still two boxes. The centre must lie
   * on the long axis.
   */
  const round = (name: string, parent: number, joint: [number, number, number], size: [number, number, number], center: [number, number, number], color: RGB, o: Partial<PartDef> & { detail?: Detail } = {}): number => {
    const i = add(name, parent, joint, size, center, color, o);
    const long = size[1] >= size[2] ? 'y' : 'z';
    add(`${name}~`, i, center, size, [0, 0, 0], color, { taper: o.taper, taperAxis: o.taperAxis, detail: o.detail, rest: long === 'y' ? [0, Math.PI / 4, 0] : [0, 0, Math.PI / 4] });
    return i;
  };
  const main = pal.main, dark = pal.dark, light = pal.light;
  // furniture: the sprite's main colour when it looks like wood, else black polymer
  const brownish = main[0] > main[2] * 1.25 && main[0] > 70;
  const furniture = brownish ? main : GRIP;
  const bright = (c: RGB) => c[0] + c[1] + c[2];
  switch (cls) {
    case 'pistol': {
      if (variant === 'revolver') {
        // wooden grip, a frame, the fluted cylinder and a round barrel with a front blade
        add('grip', -1, [0, 0, 0], [0.03, 0.1, 0.045], [0, -0.02, 0.01], brownish ? main : WOOD, { rest: [-0.35, 0, 0], detail: 'grain' });
        const fr = add('frame', -1, [0, 0.055, -0.03], [0.028, 0.045, 0.09], [0, 0, 0], STEEL, { detail: 'metal' });
        round('cylinder', fr, [0, 0.0, -0.01], [0.042, 0.042, 0.045], [0, 0, 0], [120, 124, 130], { detail: 'metal' });
        round('barrel', fr, [0, 0.012, -0.045], [0.018, 0.018, 0.14], [0, 0, -0.07], STEEL, { detail: 'metal' });
        add('front', fr, [0, 0.026, -0.11], [0.004, 0.012, 0.012], [0, 0, 0], [30, 30, 30]);
        add('hammer', fr, [0, 0.03, 0.045], [0.01, 0.018, 0.012], [0, 0, 0], [60, 60, 64], { rest: [-0.5, 0, 0] });
        add('guard', -1, [0, 0.016, -0.04], [0.01, 0.024, 0.04], [0, 0, 0], STEEL);
        return { parts: P, hold: [0, 0, 0], support: null, muzzle: [0, 0.067, -0.22], gun: true };
      }
      if (variant === '1911') {
        // a slim steel slide and frame, checkered wooden grips, an exposed hammer
        add('grip', -1, [0, 0, 0], [0.03, 0.1, 0.05], [0, -0.02, 0.008], WOOD, { rest: [-0.22, 0, 0], detail: 'knurl' });
        const sl = add('slide', -1, [0, 0.068, -0.055], [0.028, 0.032, 0.2], [0, 0, 0], [110, 114, 120], { detail: 'serration' });
        add('frame', -1, [0, 0.042, -0.068], [0.026, 0.022, 0.16], [0, 0, 0], [96, 100, 106], { detail: 'metal' });
        add('guard', -1, [0, 0.016, -0.05], [0.01, 0.026, 0.048], [0, 0, 0], [96, 100, 106]);
        add('hammer', sl, [0, 0.0, 0.102], [0.01, 0.02, 0.012], [0, 0.006, 0], [40, 40, 44], { rest: [-0.4, 0, 0] });
        add('front', sl, [0, 0.02, -0.09], [0.005, 0.008, 0.01], [0, 0, 0], [20, 20, 20]);
        return { parts: P, hold: [0, 0, 0], support: null, muzzle: [0, 0.066, -0.16], gun: true };
      }
      // grip raked back under the fist, slide with serrations, frame, trigger guard, sights
      add('grip', -1, [0, 0, 0], [0.032, 0.105, 0.052], [0, -0.02, 0.008], GRIP, { rest: [-0.28, 0, 0], detail: 'knurl' });
      const slide = add('slide', -1, [0, 0.07, -0.055], [0.032, 0.036, 0.19], [0, 0, 0], bright(main) > 360 ? main : GUNMETAL, { detail: 'serration' });
      add('frame', -1, [0, 0.043, -0.068], [0.029, 0.022, 0.155], [0, 0, 0], GRIP, { detail: 'metal' });
      add('guard', -1, [0, 0.016, -0.05], [0.01, 0.026, 0.048], [0, 0, 0], GRIP);
      add('trigger', -1, [0, 0.02, -0.035], [0.006, 0.02, 0.008], [0, 0, 0], [30, 30, 32]);
      round('muzzle', slide, [0, -0.004, -0.096], [0.012, 0.012, 0.006], [0, 0, 0], [16, 16, 18]);
      add('front', slide, [0, 0.022, -0.086], [0.006, 0.009, 0.01], [0, 0, 0], [20, 20, 20]);
      add('rear', slide, [0, 0.022, 0.085], [0.026, 0.009, 0.01], [0, 0, 0], [20, 20, 20]);
      // one-handed at the hip: a cupping off hand read as a second fist glued underneath
      return { parts: P, hold: [0, 0, 0], support: null, muzzle: [0, 0.066, -0.16], gun: true };
    }
    case 'rifle':
    case 'smg':
    case 'shotgun':
    case 'launcher':
    case 'crossbow': {
      if (cls === 'launcher') {
        round('tube', -1, [0, 0.07, -0.1], [0.1, 0.1, 0.85], [0, 0, 0], main, { kind: 'core', detail: 'metal' });
        add('grip', -1, [0, 0, 0], [0.03, 0.1, 0.045], [0, -0.02, 0], GRIP, { detail: 'knurl' });
        add('sight', -1, [-0.06, 0.1, -0.05], [0.03, 0.05, 0.06], [0, 0, 0], GUNMETAL);
        return { parts: P, hold: [0, 0, 0], support: [0, -0.01, -0.28], muzzle: [0, 0.07, -0.55], gun: true };
      }
      if (cls === 'shotgun' && (variant === 'double' || variant === 'single')) {
        // break-action: a wooden stock and fore-end, one or two barrels side by side, no pump
        const two = variant === 'double';
        const act = add('action', -1, [0, 0.036, -0.05], [0.05, 0.05, 0.1], [0, 0, 0], [110, 112, 118], { kind: 'core', detail: 'metal' });
        add('grip', -1, [0, 0, 0.02], [0.034, 0.09, 0.05], [0, -0.025, 0], WOOD, { rest: [-0.45, 0, 0], detail: 'grain' });
        add('stock', act, [0, -0.02, 0.07], [0.044, 0.08, 0.3], [0, -0.02, 0.15], WOOD, { taper: [1, 0.85, 1.05, 1.4], taperAxis: 'z', detail: 'grain' });
        for (const bx of two ? [-0.0135, 0.0135] : [0]) round(`barrel${bx}`, act, [bx, 0.01, -0.05], [0.026, 0.026, 0.56], [0, 0, -0.28], GUNMETAL, { detail: 'metal' });
        add('rib', act, [0, 0.026, -0.3], [0.006, 0.006, 0.5], [0, 0, 0], [40, 40, 44]);
        add('fore', act, [0, -0.02, -0.16], [two ? 0.05 : 0.036, 0.03, 0.16], [0, 0, 0], WOOD, { detail: 'grain' });
        add('bead', act, [0, 0.03, -0.6], [0.006, 0.006, 0.006], [0, 0, 0], [220, 210, 160]);
        return { parts: P, hold: [0, 0, 0], support: [0, -0.03, -0.24], muzzle: [0, 0.046, -0.65], gun: true };
      }
      if ((cls === 'rifle' || cls === 'shotgun') && variant.startsWith('lever')) return leverGun(P, add, round, cls === 'shotgun', variant);
      if (cls === 'rifle' && variant === 'hunting') {
        // a wooden stock the full length, a bolt handle, a scope on rings, no pistol grip or mag
        const recv = add('receiver', -1, [0, 0.035, -0.07], [0.036, 0.042, 0.2], [0, 0, 0], [70, 72, 78], { kind: 'core', detail: 'metal' });
        add('stock', recv, [0, -0.03, 0.02], [0.046, 0.06, 0.62], [0, -0.01, 0.04], WOOD, { taper: [0.9, 0.8, 1.05, 1.6], taperAxis: 'z', detail: 'grain' });
        add('grip', -1, [0, 0, 0.03], [0.034, 0.07, 0.05], [0, -0.02, 0], WOOD, { rest: [-0.6, 0, 0], detail: 'grain' });
        round('barrel', recv, [0, 0.008, -0.1], [0.018, 0.018, 0.5], [0, 0, -0.25], GUNMETAL, { detail: 'metal' });
        add('bolt', recv, [0.03, 0.01, 0.06], [0.03, 0.008, 0.008], [0.012, 0, 0], [140, 144, 150], { rest: [0, 0, -0.5] });
        round('scope', recv, [0, 0.038, -0.02], [0.03, 0.03, 0.26], [0, 0, 0], [30, 32, 36], { detail: 'metal' });
        round('bell', recv, [0, 0.038, -0.15], [0.04, 0.04, 0.04], [0, 0, 0], [30, 32, 36]);
        add('guard', recv, [0, -0.04, 0.05], [0.01, 0.022, 0.05], [0, 0, 0], GUNMETAL);
        return { parts: P, hold: [0, 0, 0], support: [0, -0.03, -0.26], muzzle: [0, 0.043, -0.67], gun: true };
      }
      const long = cls !== 'smg';
      const shotgun = cls === 'shotgun';
      const ak = cls === 'rifle' && variant === 'ak';
      const woodStock = shotgun || brownish || ak;
      const recvCol = bright(main) > 300 && !brownish ? main : GUNMETAL;
      const recv = add('receiver', -1, [0, 0.038, -0.06], [0.046, 0.07, long ? 0.26 : 0.22], [0, 0, 0], recvCol, { kind: 'core', detail: 'port' });
      add('grip', -1, [0, 0, 0.02], [0.032, 0.095, 0.048], [0, -0.03, 0], GRIP, { rest: [-0.3, 0, 0], detail: 'knurl' });
      add('guard', recv, [0, -0.045, 0.06], [0.01, 0.022, 0.06], [0, 0, 0], GRIP);
      if (long) {
        // stock: comb, then wrist down to a butt pad
        add('stock', recv, [0, -0.012, 0.13], [0.042, 0.075, 0.28], [0, -0.012, 0.14], woodStock ? WOOD : furniture, { taper: [1, 0.85, 1.05, 1.35], taperAxis: 'z', detail: woodStock ? 'grain' : 'metal' });
        add('butt', recv, [0, -0.02, 0.41], [0.044, 0.115, 0.02], [0, 0, 0], [30, 28, 26]);
      }
      const bl = cls === 'smg' ? 0.14 : shotgun ? 0.5 : 0.44;
      const bw = shotgun ? 0.028 : 0.018;
      round('barrel', recv, [0, 0.014, -0.13], [bw, bw, bl], [0, 0, -bl / 2], GUNMETAL, { detail: 'metal' });
      if (shotgun) {
        round('tube', recv, [0, -0.012, -0.13], [0.024, 0.024, bl * 0.8], [0, 0, -bl * 0.4], GUNMETAL);
        add('pump', recv, [0, -0.016, -0.27], [0.052, 0.046, 0.15], [0, 0, 0], WOOD, { detail: 'grain' });
      } else if (cls !== 'crossbow') {
        add('handguard', recv, [0, 0.004, -0.21], [0.052, 0.058, long ? 0.2 : 0.1], [0, 0, 0], furniture, { detail: woodStock ? 'grain' : 'vent' });
      }
      if (ak) {
        // the banana magazine: two segments curving forward
        const m1 = add('mag', recv, [0, -0.04, -0.05], [0.028, 0.08, 0.06], [0, -0.04, 0], [150, 70, 40], { rest: [0.15, 0, 0], detail: 'metal' });
        add('mag2', m1, [0, -0.075, 0], [0.028, 0.08, 0.058], [0, -0.035, 0], [150, 70, 40], { rest: [0.45, 0, 0], detail: 'metal' });
      } else if (cls === 'rifle' || cls === 'smg') add('mag', recv, [0, -0.05, cls === 'smg' ? -0.02 : -0.05], [0.028, 0.13, 0.06], [0, -0.05, 0], GUNMETAL, { rest: [0.22, 0, 0], detail: 'metal' });
      if (cls === 'rifle' && !ak) add('carry', recv, [0, 0.055, 0.02], [0.014, 0.02, 0.1], [0, 0, 0], GUNMETAL);
      // sights: a rear aperture on the receiver, a front post on a block near the muzzle
      add('rear', recv, [0, 0.045, 0.07], [0.028, 0.02, 0.02], [0, 0, 0], [26, 26, 28]);
      const fz = -0.13 - bl + 0.04;
      add('fblock', recv, [0, 0.022, fz], [0.024, 0.016, 0.03], [0, 0, 0], [26, 26, 28]);
      add('post', recv, [0, 0.036, fz], [0.006, 0.02, 0.008], [0, 0, 0], [20, 20, 22]);
      if (cls === 'crossbow') {
        add('prod', recv, [0, 0.02, -0.34], [0.55, 0.025, 0.035], [0, 0, 0], dark, { detail: 'metal' });
        add('string', recv, [0, 0.02, -0.26], [0.5, 0.006, 0.006], [0, 0, 0], [220, 214, 196]);
      }
      const muzzleZ = -0.19 - bl;
      return { parts: P, hold: [0, 0, 0], support: [0, -0.035, shotgun ? -0.34 : long ? -0.28 : -0.1], muzzle: [0, 0.052, muzzleZ], gun: cls !== 'crossbow' };
    }
    case 'knife': {
      if (variant === 'kitchen') {
        // a plain black handle with rivets, a thin wide blade, no guard
        add('handle', -1, [0, -0.02, 0], [0.024, 0.11, 0.03], [0, 0, 0], [34, 30, 28], { detail: 'knurl' });
        add('blade', -1, [0, 0.038, 0], [0.006, 0.2, 0.045], [0, 0.1, -0.006], STEEL, { taper: [1, 1, 0.4, 0.2], detail: 'bevel' });
        return { parts: P, hold: [-0.5, 1.1, 0.35], support: null, muzzle: null, gun: false };
      }
      add('handle', -1, [0, -0.02, 0], [0.028, 0.11, 0.034], [0, 0, 0], dark, { taper: [0.9, 0.9, 1, 1], detail: 'knurl' });
      add('guard', -1, [0, 0.038, 0], [0.014, 0.012, 0.056], [0, 0, 0], STEEL, { detail: 'metal' });
      add('blade', -1, [0, 0.044, 0], [0.008, 0.17, 0.036], [0, 0.085, -0.004], STEEL, { taper: [1, 1, 0.35, 0.25], detail: 'bevel' });
      add('pommel', -1, [0, -0.08, 0], [0.03, 0.014, 0.036], [0, 0, 0], STEEL, { detail: 'metal' });
      // broad side of the blade toward the eye, not its edge
      return { parts: P, hold: [-0.5, 1.1, 0.35], support: null, muzzle: null, gun: false };
    }
    case 'machete':
    case 'sword': {
      const len = cls === 'sword' ? 0.75 : 0.45;
      const w = cls === 'sword' ? 0.04 : 0.055;
      add('handle', -1, [0, -0.03, 0], [0.03, cls === 'sword' ? 0.18 : 0.13, 0.034], [0, 0, 0], dark, { detail: cls === 'sword' ? 'tape' : 'knurl' });
      add('guard', -1, [0, 0.045, 0], [0.018, 0.016, cls === 'sword' ? 0.16 : 0.07], [0, 0, 0], cls === 'sword' ? [170, 138, 74] : GRIP, { detail: 'metal' });
      add('blade', -1, [0, 0.05, 0], [0.008, len, w], [0, len / 2, -0.004], STEEL, { taper: [1, 1, 0.5, cls === 'sword' ? 0.35 : 1.2], detail: 'bevel' });
      return { parts: P, hold: [-0.45, 1.1, 0.4], support: null, muzzle: null, gun: false };
    }
    case 'axe': {
      if (variant === 'hatchet') {
        round('haft', -1, [0, -0.05, 0], [0.03, 0.34, 0.03], [0, 0.13, 0], brownish ? main : WOOD, { detail: 'grain' });
        const hd = add('head', -1, [0, 0.27, 0], [0.026, 0.06, 0.09], [0, 0, -0.02], GUNMETAL, { taper: [1, 0.7, 1, 1.3], taperAxis: 'z', detail: 'metal' });
        add('bit', hd, [0, 0, -0.065], [0.012, 0.11, 0.026], [0, 0, 0], STEEL, { detail: 'bevel' });
        return { parts: P, hold: [-0.4, 1.1, 0.45], support: null, muzzle: null, gun: false };
      }
      if (variant === 'fire') {
        // red fire axe: a pick on the back of the head
        round('haft', -1, [0, -0.08, 0], [0.036, 0.66, 0.036], [0, 0.28, 0], [150, 40, 30], { detail: 'metal' });
        const hd = add('head', -1, [0, 0.52, 0], [0.032, 0.085, 0.14], [0, 0, -0.03], [190, 36, 30], { taper: [1, 0.7, 1, 1.3], taperAxis: 'z', detail: 'metal' });
        add('bit', hd, [0, 0, -0.1], [0.014, 0.17, 0.034], [0, 0, 0], STEEL, { detail: 'bevel' });
        add('pick', hd, [0, 0, 0.09], [0.02, 0.03, 0.12], [0, 0, 0.04], [190, 36, 30], { taper: [1, 1, 0.2, 0.3], taperAxis: 'z' });
        return { parts: P, hold: [-0.4, 1.1, 0.45], support: null, muzzle: null, gun: false };
      }
      round('haft', -1, [0, -0.08, 0], [0.034, 0.62, 0.034], [0, 0.26, 0], brownish ? main : WOOD, { taper: [0.9, 0.9, 1.1, 1.1], detail: 'grain' });
      const head = add('head', -1, [0, 0.48, 0], [0.03, 0.08, 0.13], [0, 0, -0.03], GUNMETAL, { taper: [1, 0.7, 1, 1.3], taperAxis: 'z', detail: 'metal' });
      add('bit', head, [0, 0, -0.095], [0.014, 0.16, 0.034], [0, 0, 0], STEEL, { detail: 'bevel' });
      add('poll', head, [0, 0, 0.045], [0.034, 0.06, 0.03], [0, 0, 0], GUNMETAL);
      return { parts: P, hold: [-0.4, 1.1, 0.45], support: null, muzzle: null, gun: false };
    }
    case 'hammer': {
      if (variant === 'sledge') {
        round('haft', -1, [0, -0.1, 0], [0.036, 0.8, 0.036], [0, 0.34, 0], brownish ? main : WOOD, { detail: 'grain' });
        add('head', -1, [0, 0.74, 0], [0.08, 0.08, 0.2], [0, 0, 0], GUNMETAL, { detail: 'metal' });
        return { parts: P, hold: [-0.4, 0, 0.45], support: [0, -0.3, 0], muzzle: null, gun: false };
      }
      round('haft', -1, [0, -0.06, 0], [0.032, 0.5, 0.032], [0, 0.2, 0], brownish ? main : WOOD, { detail: 'grain' });
      add('head', -1, [0, 0.42, 0], [0.05, 0.06, 0.14], [0, 0, 0], GUNMETAL, { detail: 'metal' });
      return { parts: P, hold: [-0.4, 0, 0.45], support: volume > 2500 ? [0, -0.2, 0] : null, muzzle: null, gun: false };
    }
    case 'bat': {
      // knob, taped handle, a round barrel swelling toward the end
      const col = brownish || bright(main) < 90 ? (brownish ? main : WOOD) : main;
      round('knob', -1, [0, -0.1, 0], [0.05, 0.022, 0.05], [0, 0, 0], col);
      round('bat', -1, [0, -0.09, 0], [0.066, 0.8, 0.066], [0, 0.4, 0], col, { taper: [0.5, 0.5, 1.05, 1.05], detail: 'grain' });
      round('tape', -1, [0, -0.02, 0], [0.038, 0.14, 0.038], [0, 0, 0], [34, 34, 38], { detail: 'tape' });
      round('end', -1, [0, 0.71, 0], [0.07, 0.012, 0.07], [0, 0, 0], col.map((v) => v * 0.8) as RGB);
      return { parts: P, hold: [-0.4, 0, 0.45], support: volume > 1500 ? [0, -0.17, 0] : null, muzzle: null, gun: false };
    }
    case 'pipe': {
      if (variant === 'crowbar') {
        // hex bar, a curved claw at the top, a flat chisel at the bottom
        round('bar', -1, [0, -0.1, 0], [0.024, 0.62, 0.024], [0, 0.3, 0], [30, 30, 34], { detail: 'metal' });
        const hook = add('hook', -1, [0, 0.51, 0], [0.024, 0.07, 0.024], [0, 0.03, 0], [30, 30, 34], { rest: [0.9, 0, 0] });
        add('claw', hook, [0, 0.06, 0], [0.03, 0.06, 0.024], [0, 0.03, 0], [30, 30, 34], { rest: [1.2, 0, 0], taper: [1, 1, 0.5, 0.4] });
        add('chisel', -1, [0, -0.12, 0], [0.03, 0.04, 0.012], [0, 0, 0], [150, 152, 158], { detail: 'bevel' });
        return { parts: P, hold: [-0.4, 0, 0.45], support: null, muzzle: null, gun: false };
      }
      round('bar', -1, [0, -0.1, 0], [0.032, 0.7, 0.032], [0, 0.33, 0], bright(main) > 200 ? main : STEEL, { detail: 'metal' });
      add('end', -1, [0, 0.58, 0], [0.04, 0.04, 0.06], [0, 0, -0.02], dark, { rest: [0.5, 0, 0] });
      return { parts: P, hold: [-0.4, 0, 0.45], support: null, muzzle: null, gun: false };
    }
    case 'spear': {
      round('shaft', -1, [0, -0.5, 0], [0.03, 1.5, 0.03], [0, 0.6, 0], brownish ? main : WOOD, { detail: 'grain' });
      add('tip', -1, [0, 1.1, 0], [0.01, 0.2, 0.042], [0, 0.1, 0], STEEL, { taper: [1, 1, 0.2, 0.1], detail: 'bevel' });
      round('wrap', -1, [0, 1.07, 0], [0.036, 0.06, 0.036], [0, 0, 0], [70, 56, 40], { detail: 'tape' });
      // held low and pointing ahead, both hands on the shaft
      return { parts: P, hold: [-1.5, 0, 0.1], support: [0, -0.35, 0], muzzle: null, gun: false };
    }
    case 'flashlight': {
      round('body', -1, [0, 0, -0.04], [0.036, 0.036, 0.18], [0, 0, 0], bright(main) > 150 ? main : GUNMETAL, { detail: 'knurl' });
      round('head', -1, [0, 0, -0.15], [0.052, 0.052, 0.05], [0, 0, 0], dark, { taper: [1.1, 1.1, 0.8, 0.8], taperAxis: 'z', detail: 'metal' });
      add('lens', -1, [0, 0, -0.178], [0.044, 0.044, 0.006], [0, 0, 0], [250, 244, 200]);
      // turned a little across the body so you see its length, not just the tail cap
      return { parts: P, hold: [0.15, 0.45, 0], support: null, muzzle: null, gun: false };
    }
    default: {
      // a lump the size of the thing, in its colours, sitting in the palm
      const side = Math.max(0.05, Math.min(0.28, Math.cbrt(volume) / 100));
      const b = add('object', -1, [0, 0.02, -0.03], [side * 0.8, side, side * 0.6], [0, side * 0.3, 0], main, { kind: 'core', detail: 'metal' });
      add('band', b, [0, side * 0.3, 0], [side * 0.82, side * 0.2, side * 0.62], [0, 0, 0], light);
      return { parts: P, hold: [-0.2, 0, 0.2], support: null, muzzle: null, gun: false };
    }
  }
}

type AddPart = (name: string, parent: number, joint: [number, number, number], size: [number, number, number], center: [number, number, number], color: RGB, o?: Partial<PartDef> & { detail?: Detail }) => number;

const WALNUT: RGB = [116, 72, 42];
const BLUED: RGB = [56, 60, 72];
const BRASS: RGB = [186, 150, 72];
const LAMINATE: RGB = [92, 90, 88];

/**
 * Lever actions (Marlin 1894 / 336 / 39A / 1895, Henry, Browning BLR, Winchester 1887): what
 * tells one from a bolt gun at a glance is the tube magazine under the barrel, the lever loop
 * hanging under the wrist and the exposed hammer, so those are oversized a touch; there's no
 * bolt handle, scope or box magazine (except the BLR's). Straight-grip walnut stock, a short
 * forend with a cap, a barrel band near the muzzle.
 *
 * The lever and its loop all hang off the 'lever' part (pivot at the front of the receiver),
 * so rotating that one part about x swings the whole loop down to cycle (fpView does on fire).
 * The buttstock is named 'stock' and its pad 'butt' so first person hides them like the others.
 *
 * `variant`: 'lever' (blued + walnut), 'lever_brass' (Henry: brass receiver), 'lever_stainless'
 * (1895 SBL: stainless + grey laminate), 'lever_box' (BLR: box magazine, no tube).
 */
function leverGun(P: PartDef[], add: AddPart, round: AddPart, shotgun: boolean, variant: string): HeldBuild {
  const brass = variant === 'lever_brass', stainless = variant === 'lever_stainless', box = variant === 'lever_box';
  const recvCol: RGB = brass ? BRASS : stainless ? [150, 154, 160] : BLUED;
  const steel: RGB = stainless ? [160, 164, 170] : GUNMETAL;
  const wood: RGB = stainless ? LAMINATE : WALNUT;
  const bore = shotgun ? 0.024 : 0.018;
  const tubeD = shotgun ? 0.02 : 0.015;
  const bl = shotgun ? 0.5 : 0.47;
  // receiver: flat-sided, flat-topped, its rear end just ahead of the fist
  const rz = -0.1, rl = 0.17, rh = shotgun ? 0.066 : 0.058;
  const recv = add('receiver', -1, [0, 0.03, rz], [0.03, rh, rl], [0, 0, 0], recvCol, { kind: 'core', detail: 'metal' });
  const front = -rl / 2; // receiver-local z of its front face
  // straight-grip wrist through the fist, dropping toward the butt; the stock carries the drop on
  const grip = add('grip', recv, [0, -0.006, rl / 2 - 0.004], [0.03, 0.042, 0.14], [0, 0, 0.068], wood, { rest: [0.2, 0, 0], detail: 'grain' });
  const stock = add('stock', grip, [0, 0, 0.13], [0.034, 0.05, 0.27], [0, -0.014, 0.135], wood, { rest: [-0.12, 0, 0], taper: [0.95, 0.9, 1.15, 2.4], taperAxis: 'z', detail: 'grain' });
  add('butt', stock, [0, -0.014, 0.272], [0.04, 0.122, 0.012], [0, 0, 0], [34, 30, 28]);
  // barrel on top, magazine tube touching it underneath (the BLR has neither tube nor band)
  const by = rh / 2 - 0.013;
  round('barrel', recv, [0, by, front], [bore, bore, bl], [0, 0, -bl / 2], steel, { detail: 'metal' });
  const ty = by - bore / 2 - tubeD / 2 + 0.001;
  if (!box) {
    round('tube', recv, [0, ty, front], [tubeD, tubeD, bl - 0.03], [0, 0, -(bl - 0.03) / 2], steel, { detail: 'metal' });
    round('tubecap', recv, [0, ty, front - bl + 0.024], [tubeD + 0.003, tubeD + 0.003, 0.012], [0, 0, 0], [96, 100, 108]);
    add('band', recv, [0, (by + ty) / 2, front - bl + 0.05], [bore + 0.006, bore + tubeD + 0.006, 0.012], [0, 0, 0], [40, 42, 48]);
  } else {
    add('mag', recv, [0, -rh / 2 - 0.012, -0.01], [0.026, 0.03, 0.07], [0, 0, 0], [40, 42, 48], { detail: 'metal' });
  }
  // short forend wrapping the tube and the lower barrel, a steel cap at its front
  const fl = shotgun ? 0.2 : 0.22;
  const fy = (by + bore / 2 - 0.003 + ty - tubeD / 2 - 0.006) / 2;
  const fh = by + bore / 2 - 0.003 - (ty - tubeD / 2 - 0.006);
  add('forend', recv, [0, fy, front - fl / 2], [0.034, fh, fl], [0, 0, 0], wood, { taper: [0.85, 0.85, 1, 1], taperAxis: 'z', detail: 'grain' });
  add('fcap', recv, [0, fy, front - fl - 0.006], [0.03, fh * 0.9, 0.012], [0, 0, 0], [40, 42, 48]);
  // sights: a buckhorn rear on the barrel, a ramp and brass bead at the muzzle (shotguns: just the bead)
  const top = by + bore / 2;
  if (!shotgun) {
    add('rear', recv, [0, top + 0.005, front - 0.13], [0.022, 0.012, 0.01], [0, 0, 0], [26, 26, 28]);
    add('ramp', recv, [0, top + 0.004, front - bl + 0.025], [0.006, 0.008, 0.024], [0, 0, 0], [26, 26, 28], { taper: [1, 0.4, 1, 1], taperAxis: 'z' });
  }
  add('bead', recv, [0, top + (shotgun ? 0.004 : 0.011), front - bl + 0.022], [0.006, 0.007, 0.006], [0, 0, 0], [222, 190, 110]);
  // exposed hammer at the rear of the flat top, cocked back, with a spur
  // (kept under the sight line: fpView puts the eye 3 cm over the muzzle axis down the sights)
  const ham = add('hammer', recv, [0, rh / 2 - 0.008, rl / 2 - 0.014], [0.01, 0.022, 0.011], [0, 0.01, 0], [44, 44, 48], { rest: [0.6, 0, 0] });
  add('spur', ham, [0, 0.02, 0], [0.012, 0.006, 0.016], [0, 0, 0.005], [44, 44, 48]);
  // right side: the loading gate (a brighter plate) and the bolt sliding in the upper rear
  add('gate', recv, [0.0155, -0.008, -0.01], [0.004, 0.016, 0.042], [0, 0, 0], [118, 122, 130]);
  add('bolt', recv, [0.0155, rh / 2 - 0.013, 0.035], [0.004, 0.012, 0.07], [0, 0, 0], [136, 140, 148], { detail: 'metal' });
  add('trigger', recv, [0, -rh / 2 - 0.002, rl / 2 - 0.035], [0.005, 0.016, 0.006], [0, -0.006, 0], [30, 30, 32], { rest: [0.25, 0, 0] });
  // the lever: a bar under the receiver from the pivot back to the trigger, then the finger loop
  // (front leg, bottom, rear leg) wrapping under the wrist; all one subtree off the pivot
  const lv = add('lever', recv, [0, -rh / 2 + 0.002, front + 0.012], [0.009, 0.01, 0.13], [0, -0.005, 0.065], steel, { detail: 'metal' });
  const lz = 0.128, drop = 0.08, loopL = 0.1;
  add('loopF', lv, [0, -0.005, lz], [0.009, drop, 0.01], [0, -drop / 2, 0], steel);
  add('loopB', lv, [0, -drop, lz], [0.009, 0.01, loopL], [0, 0, loopL / 2], steel);
  add('loopR', lv, [0, -drop, lz + loopL], [0.009, 0.07, 0.01], [0, 0.035, 0], steel, { rest: [0.6, 0, 0] });
  return { parts: P, hold: [0, 0, 0], support: [0, fy - 0.04, front + rz - fl * 0.55], muzzle: [0, 0.03 + by, rz + front - bl - 0.005], gun: true };
}
