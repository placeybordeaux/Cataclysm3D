import type { DebugApi } from '../debug';
import type { Renderer } from '../render/renderer';
import { LOOK_NAMES, LOOKS, look, type LookName } from '../render/look';
import { HAZE_NAMES, HAZES, haze, setHaze, type HazeName } from '../render/atmosphere';
import { FORM_NAMES, FORMS, form, setForm, type FormName } from '../render/formLight';
import { FLORA_NAMES, flora } from '../render/flora';
import { furnitureState } from '../render/furniture/index';
import { surfaceState } from '../render/surfaces';
import { cardSettings } from '../render/cards';
import { charSettings, charsApi, setCharMode, setViewmodelMode } from '../render/chars/index';
import { setCutoutMips } from '../render/cutoutMips';
import { AIM_MODELS, aimModel, isAimModel, setAimModel } from '../game/aimmodel';
import type { GradeMode } from '../render/post';

// Every wave-3 visual/feel variant as one gallery switch (docs/GALLERY.md). `set` applies it
// live and never persists: the owning modules' own setters sometimes write their localStorage
// key (Creatures, First-person hands, Vehicle look/width), so each set runs inside a storage
// sandbox that puts back any cdda3d.* key it touched. "Copy as my defaults" persists through
// the Options entry named by `option` instead, so the stored value is exactly what Options
// would have written.

export interface SwitchValue {
  v: string;
  label: string;
}

export interface GallerySwitch {
  id: string;
  label: string;
  group: string;
  values: SwitchValue[];
  /** The value the game ships with (Factory defaults). */
  def: string;
  get(): string;
  /** Live, not persisted. Throws on a value outside `values`. */
  set(v: string): void;
  /** The Options row that persists this (null: URL / console only). */
  option: string | null;
  /** The URL parameter equivalent, for the hint line. */
  url?: string;
  /** Caveat shown under the control. */
  note?: string;
  /** Scenes where a change should visibly alter the image (the per-switch pixel-diff check). */
  proof: string;
}

/** Run `fn` and put back every cdda3d.* localStorage key it changed (gallery switches are live-only). */
export function sandboxStorage<T>(fn: () => T): T {
  let before: Map<string, string> | null = null;
  try {
    before = new Map();
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!;
      if (k.startsWith('cdda3d.')) before.set(k, localStorage.getItem(k)!);
    }
  } catch {
    before = null; // storage blocked: nothing can be written either
  }
  try {
    return fn();
  } finally {
    if (before) {
      try {
        const now: string[] = [];
        for (let i = 0; i < localStorage.length; i++) now.push(localStorage.key(i)!);
        for (const k of now) if (k.startsWith('cdda3d.') && !before.has(k)) localStorage.removeItem(k);
        for (const [k, v] of before) if (localStorage.getItem(k) !== v) localStorage.setItem(k, v);
      } catch {
        // storage went away mid-call: nothing to restore
      }
    }
  }
}

const vals = (names: readonly string[], label: (n: string) => string = (n) => n): SwitchValue[] => names.map((v) => ({ v, label: label(v) }));

export function buildSwitches(renderer: Renderer, api: DebugApi): GallerySwitch[] {
  const need = <T>(name: string): T => {
    const f = api[name];
    if (typeof f !== 'function') throw new Error(`gallery: cdda.${name} is missing (subsystem not installed?)`);
    return f as T;
  };
  const check = (sw: GallerySwitch, v: string) => {
    if (!sw.values.some((x) => x.v === v)) throw new Error(`gallery: ${sw.id} has no value "${v}" (expected ${sw.values.map((x) => x.v).join('|')})`);
  };
  let cutout = true;
  const radii = [5, 6, 8];
  const list: GallerySwitch[] = [
    {
      id: 'look', label: 'Visual style', group: 'Image', option: 'Visual style', url: 'look',
      values: vals(LOOK_NAMES, (n) => LOOKS[n as LookName].label), def: 'full',
      get: () => look.name, set: (v) => renderer.setLook(v as LookName), proof: 'street',
    },
    {
      id: 'haze', label: 'Distance haze', group: 'Image', option: 'Distance haze', url: 'haze',
      values: vals(HAZE_NAMES, (n) => HAZES[n as HazeName].label), def: 'clear',
      get: () => haze.name, set: (v) => setHaze(v as HazeName), proof: 'far',
    },
    {
      id: 'radius', label: 'Draw distance', group: 'Image', option: 'Draw distance', url: 'radius',
      values: radii.map((r) => ({ v: String(r), label: `${(r - 1) * 24} m` })), def: '6',
      get: () => String(renderer.chunks.radius),
      set: (v) => {
        renderer.chunks.radius = Number(v);
        const prefetch = api.prefetch as { opts: { radius: number } } | undefined;
        if (prefetch) prefetch.opts.radius = Number(v) + 1;
      },
      proof: 'far',
    },
    {
      id: 'form', label: 'Form lighting', group: 'Image', option: 'Form lighting', url: 'form',
      values: vals(FORM_NAMES, (n) => FORMS[n as FormName].label), def: 'toon',
      get: () => form.name, set: (v) => setForm(v as FormName), proof: 'street',
    },
    {
      id: 'grade', label: 'Colour grading', group: 'Image', option: 'Colour grading', url: 'grade',
      values: vals(['palette', 'smooth', 'off']), def: 'smooth',
      note: 'Each visual style sets its own grading; this overrides it until the style changes.',
      get: () => renderer.pipeline.options.grade, set: (v) => void (renderer.pipeline.options.grade = v as GradeMode), proof: 'street',
    },
    {
      id: 'cutout', label: 'Cutout mips', group: 'Image', option: null,
      values: [{ v: 'on', label: 'stable' }, { v: 'off', label: 'off (v2)' }], def: 'on',
      note: 'Grass and leaf cards at distance; mostly visible in motion (shimmer). Console: cdda.cutoutMips(false).',
      get: () => (cutout ? 'on' : 'off'),
      set: (v) => {
        cutout = v === 'on';
        setCutoutMips(cutout);
      },
      proof: 'forest',
    },
    {
      id: 'chars', label: 'Creatures', group: 'Characters', option: 'Creatures', url: 'chars',
      values: [{ v: 'model', label: '3D models' }, { v: 'billboard', label: 'sprites' }], def: 'model',
      get: () => charSettings.mode, set: (v) => setCharMode(v as 'model' | 'billboard'), proof: 'horde',
    },
    {
      id: 'charpaint', label: 'Creature paint', group: 'Characters', option: null, url: 'charpaint',
      values: [{ v: 'styled', label: 'styled skins' }, { v: 'sprite', label: 'projected sprite' }], def: 'styled',
      note: '3D creatures only.',
      get: () => charSettings.paint, set: (v) => void charsApi({ paint: v as 'styled' | 'sprite' }), proof: 'npcs',
    },
    {
      id: 'viewmodel', label: 'First-person hands', group: 'Characters', option: 'First-person hands', url: 'viewmodel',
      values: [{ v: 'model', label: '3D' }, { v: 'sprite', label: 'sprites' }], def: 'model',
      get: () => charSettings.viewmodel, set: (v) => setViewmodelMode(v as 'model' | 'sprite'), proof: 'fp_pistol',
    },
    {
      id: 'fpbow', label: 'First-person bow', group: 'Characters', option: null,
      values: [{ v: 'sprite', label: '2D art' }, { v: 'model', label: '3D bow' }], def: 'sprite',
      note: 'Bows and slingshots with 3D hands. Console: cdda.chars({ fpBow: true }).',
      get: () => (charSettings.fpBow ? 'model' : 'sprite'), set: (v) => void (charSettings.fpBow = v === 'model'), proof: 'fp_bow',
    },
    {
      id: 'props', label: 'Props', group: 'Characters', option: null, url: 'props',
      values: [{ v: 'cards', label: 'world-fixed cards' }, { v: 'billboard', label: 'billboards (v2)' }], def: 'cards',
      note: 'Fire, far furniture, loot, mannequins. Projectile effects keep the mode they started with until reload.',
      get: () => cardSettings.mode,
      set: (v) => {
        cardSettings.mode = v as 'cards' | 'billboard';
        renderer.chunks.invalidateAll();
      },
      proof: 'props',
    },
    {
      id: 'furniture', label: 'Furniture', group: 'World', option: 'Furniture', url: 'furniture',
      values: [{ v: 'model', label: 'Modelled' }, { v: 'voxel', label: 'Voxel' }], def: 'model',
      note: 'Needs the Full or Voxel style.',
      get: () => furnitureState.style, set: (v) => void need<(s: string) => void>('setFurnitureStyle')(v), proof: 'kitchen',
    },
    {
      id: 'surfaces', label: 'Surfaces', group: 'World', option: 'Surfaces', url: 'surfaces',
      values: [{ v: 'painted', label: 'Painted' }, { v: 'sprite', label: 'Tileset' }], def: 'painted',
      note: 'Needs the Full or Voxel style.',
      get: () => surfaceState.style, set: (v) => void need<(s: string) => void>('setSurfaceStyle')(v), proof: 'living',
    },
    {
      id: 'dressing', label: 'Set dressing', group: 'World', option: null, url: 'dressing',
      values: [{ v: 'on', label: 'on' }, { v: 'off', label: 'bare rooms' }], def: 'on',
      note: 'Pictures, grime, rugs, lamps, house numbers (painted surfaces only).',
      get: () => (need<() => boolean>('dressing')() ? 'on' : 'off'), set: (v) => void need<(on: boolean) => void>('setDressing')(v === 'on'), proof: 'living',
    },
    {
      id: 'flora', label: 'Trees', group: 'World', option: 'Trees', url: 'flora',
      values: vals(FLORA_NAMES), def: 'models',
      note: 'Needs the Full or Voxel style.',
      get: () => flora.name, set: (v) => void need<(s: string) => void>('setFlora')(v), proof: 'lineup',
    },
    {
      id: 'vehicles', label: 'Vehicle look', group: 'Vehicles', option: 'Vehicle look', url: 'vehicles',
      values: [{ v: 'model', label: 'modelled bodies' }, { v: 'parts', label: 'part blocks' }], def: 'model',
      get: () => need<() => string>('vehicleLook')(), set: (v) => void need<(l: string) => void>('vehicleLook')(v), proof: 'cars',
    },
    {
      id: 'vwidth', label: 'Vehicle width', group: 'Vehicles', option: 'Vehicle width', url: 'vehiclewidth',
      values: [{ v: 'real', label: 'true to life' }, { v: 'fill', label: 'fill the tiles' }], def: 'real',
      note: 'Modelled bodies only.',
      get: () => need<() => string>('vehicleWidth')(), set: (v) => void need<(w: string) => void>('vehicleWidth')(v), proof: 'cars',
    },
    {
      id: 'aim', label: 'Aim model', group: 'Feel', option: 'Aim model', url: 'aim',
      values: AIM_MODELS.map((m) => ({ v: m.id, label: m.id === 'sway' ? 'sway' : m.id === 'timing' ? 'sway + timing' : 'dice (BN)' })), def: 'sway',
      note: 'Shown in the gun scenes as the crosshair path over the next 2 s (the dice model has none).',
      get: () => aimModel(),
      set: (v) => {
        if (!isAimModel(v)) throw new Error(`aim model ${v}`);
        setAimModel(v);
      },
      proof: 'fp_pistol',
    },
  ];
  // Every set: validated, storage-sandboxed.
  return list.map((raw) => {
    const sw = raw;
    const inner = raw.set;
    sw.set = (v: string) => {
      check(sw, v);
      sandboxStorage(() => inner(v));
    };
    return sw;
  });
}
