// Form lighting presets (Shadowglass-style): how the key (sun/moon), ambient and fill light
// divide the work, so a house or a tree 40-100 m away still shows a lit and a shadow side.
//
// v2 lit everything with a strong hemisphere ambient, a sun quantised into 5 bands and a
// fill from the side *opposite* the sun. Looking into the sun, every face you see is its
// shadow side and that fill hit them all equally: flat. With the sun behind you, the fill
// lit the faces you couldn't see. Presets:
//
//   soft    (v2) as described, kept for comparison
//   toon    (default) fewer, clearer bands; less ambient against the key (floor kept: a
//           shadow side is still ~1/4 of a sunlit one, never black); the fill comes from 90
//           degrees to the sun (always the same world side, so shading never changes as you
//           turn), giving three tones: sunlit / fill-lit / ambient-only. Billboard sprites
//           (distant trees, props, creatures) curve their normals across the quad so their
//           two sides take the light differently.
//   bold    stronger version of toon: 3 bands, more key, harder fill
//
// Switch: Options > Form lighting (persisted), `?form=<name>`, `cdda.setForm(name)`.

import { shared } from './materials';

export type FormName = 'soft' | 'toon' | 'bold';
export const FORM_NAMES: FormName[] = ['soft', 'toon', 'bold'];

export interface FormSettings {
  label: string;
  desc: string;
  /** Diffuse bands per light (sqrt space, materials.ts bandLight). */
  bands: number;
  /** Multipliers on the sky state's sun/moon and hemisphere intensities. */
  key: number;
  ambient: number;
  /** 'opposite': fill from the anti-sun azimuth (v2); 'side': from 90 degrees to the sun. */
  fillMode: 'opposite' | 'side';
  /** Minimum fill share (the look's `fill` wins when larger); elevation of the fill (deg). */
  fillMin: number;
  fillElev: number;
  /** Billboard sprites: horizontal/vertical normal curvature across the quad (0 = flat). */
  spriteCurve: number;
  /** Ordered dither across lamp / light-map band edges, in bands (0 = hard rings). */
  pointDither: number;
}

export const FORMS: Record<FormName, FormSettings> = {
  soft: {
    label: 'Soft (v2)', desc: 'The old lighting: strong ambient, fill from opposite the sun, flat billboards.',
    bands: 5, key: 1, ambient: 1, fillMode: 'opposite', fillMin: 0, fillElev: 56, spriteCurve: 0, pointDither: 0,
  },
  toon: {
    label: 'Toon', desc: 'Clear lit and shadow sides at any distance: stepped sun, a side fill light, rounded billboards.',
    bands: 4, key: 1.1, ambient: 0.7, fillMode: 'side', fillMin: 0.5, fillElev: 30, spriteCurve: 0.9, pointDither: 0.9,
  },
  bold: {
    label: 'Bold', desc: 'Stronger toon: three light steps, more contrast between sun and shade.',
    bands: 3, key: 1.2, ambient: 0.56, fillMode: 'side', fillMin: 0.62, fillElev: 25, spriteCurve: 1.2, pointDither: 0.7,
  },
};

export const DEFAULT_FORM: FormName = 'toon';
const STORAGE_KEY = 'cdda3d.form';

export const form: { name: FormName; s: FormSettings } = { name: DEFAULT_FORM, s: { ...FORMS[DEFAULT_FORM] } };

export function isFormName(s: string | null | undefined): s is FormName {
  return !!s && (FORM_NAMES as string[]).includes(s);
}

/** URL `form=` wins, then the stored choice, then the default. Unknown names fail loudly. */
export function initialForm(): FormName {
  const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
  const p = params.get('form');
  if (p !== null) {
    if (!isFormName(p)) throw new Error(`unknown form lighting "${p}" (expected ${FORM_NAMES.join('|')})`);
    return p;
  }
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    if (isFormName(s)) return s;
  } catch {
    // storage blocked: default
  }
  return DEFAULT_FORM;
}

export function setForm(name: FormName, persist = false): void {
  if (!isFormName(name)) throw new Error(`unknown form lighting "${name}" (expected ${FORM_NAMES.join('|')})`);
  form.name = name;
  form.s = { ...FORMS[name] };
  if (persist) {
    try {
      localStorage.setItem(STORAGE_KEY, name);
    } catch {
      // private mode: not persisted
    }
  }
}

setForm(initialForm());

/** Per frame, before LightManager.update: the shader-side parts of the preset. */
export function applyForm(): void {
  shared.uBands.value = form.s.bands;
  shared.uSpriteCurve.value = form.s.spriteCurve;
  shared.uPointDither.value = form.s.pointDither;
}
