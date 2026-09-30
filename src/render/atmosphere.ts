// Distance readability ("atmosphere"): how far things fade, and into what.
//
// The v2 looks hid the draw-distance edge with a fog that started at 35% of the draw
// distance and a strong pale aerial perspective on top: beyond ~30 m the world dissolved
// into grey haze and the far end of a street was unreadable. The presets here keep a depth
// cue but put the contrast back:
//
//   clear   (default) light, sky-coloured aerial perspective; the draw-distance edge fades
//           into the exact sky colour behind it over the last ~20% of the range, so
//           silhouettes stay crisp until the very end and there is no fog wall
//   light   more haze (planes of depth separate more), still sky-coloured and no wall
//   legacy  the v2 behaviour (grey fog from 35% of the range + heavy haze), for comparison
//
// Switch with Options > Distance haze (persisted), `?haze=<name>` or `cdda.setHaze(name)`.
// The look's own `atmosphere` feature still scales the aerial-perspective part (classic
// has none), so the looks keep their character; only the edge fade is common to all.

import * as THREE from 'three';
import type { SkyState } from './lights';

export type HazeName = 'clear' | 'light' | 'legacy';
export const HAZE_NAMES: HazeName[] = ['clear', 'light', 'legacy'];

export interface HazeSettings {
  label: string;
  desc: string;
  /** 0 = legacy grey fog + haze, 1 = sky-matched fade */
  mode: 0 | 1;
  /** Aerial perspective: e-folding distance (m) and the share of haze at infinity. */
  hazeDist: number;
  hazeMax: number;
  /** How much of the haze share also desaturates (0..1). */
  hazeDesat: number;
  /** Draw-distance fade starts at this fraction of the fade end (legacy: 0.35). */
  edgeStart: number;
  /** Haze on the skyline impostors beyond the draw distance (0..1). */
  skylineFog: number;
  /** Outlines/SSAO fade out from this fraction of the fade end (legacy: 0.28). */
  detailFade: number;
  /** Share of sky colour reached at the draw distance (legacy: 1 = gone). Beyond it the far
   *  ground ring and skyline carry on fading to fully sky `farSpan` metres further. */
  edgeLevel: number;
  farSpan: number;
  /** Cap of that far fade at the horizon (1 = the ground dissolves fully into the sky). */
  farMax: number;
}

export const HAZES: Record<HazeName, HazeSettings> = {
  clear: {
    label: 'Clear', desc: 'Far things stay sharp: a light sky-coloured haze, the edge of the world fades into the sky only at the very end.',
    mode: 1, hazeDist: 90, hazeMax: 0.42, hazeDesat: 0.35, edgeStart: 0.6, skylineFog: 0.3, detailFade: 0.7, edgeLevel: 0.25, farSpan: 300, farMax: 0.72,
  },
  light: {
    label: 'Light haze', desc: 'More atmosphere: distant planes separate more, still no fog wall.',
    mode: 1, hazeDist: 60, hazeMax: 0.6, hazeDesat: 0.5, edgeStart: 0.5, skylineFog: 0.45, detailFade: 0.55, edgeLevel: 0.4, farSpan: 220, farMax: 0.85,
  },
  legacy: {
    label: 'Heavy (v2)', desc: 'The old look: grey fog from a third of the draw distance and a strong haze.',
    mode: 0, hazeDist: 60, hazeMax: 1, hazeDesat: 0.4, edgeStart: 0.35, skylineFog: 0.7, detailFade: 0.28, edgeLevel: 1, farSpan: 0, farMax: 1,
  },
};

export const DEFAULT_HAZE: HazeName = 'clear';
const STORAGE_KEY = 'cdda3d.haze';

/** The active preset (a copy, so cdda.hazeTweak can edit single values). */
export const haze: { name: HazeName; s: HazeSettings } = { name: DEFAULT_HAZE, s: { ...HAZES[DEFAULT_HAZE] } };

export function isHazeName(s: string | null | undefined): s is HazeName {
  return !!s && (HAZE_NAMES as string[]).includes(s);
}

/** URL `haze=` wins, then the stored choice, then the default. Unknown names fail loudly. */
export function initialHaze(): HazeName {
  const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
  const p = params.get('haze');
  if (p !== null) {
    if (!isHazeName(p)) throw new Error(`unknown haze "${p}" (expected ${HAZE_NAMES.join('|')})`);
    return p;
  }
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    if (isHazeName(s)) return s;
  } catch {
    // storage blocked: default
  }
  return DEFAULT_HAZE;
}

export function setHaze(name: HazeName, persist = false): void {
  if (!isHazeName(name)) throw new Error(`unknown haze "${name}" (expected ${HAZE_NAMES.join('|')})`);
  haze.name = name;
  haze.s = { ...HAZES[name] };
  if (persist) {
    try {
      localStorage.setItem(STORAGE_KEY, name);
    } catch {
      // private mode: the choice just doesn't persist
    }
  }
}

setHaze(initialHaze());

/** The subset of PipelineOptions the presets drive (post.ts). */
export interface HazeTarget {
  fogNear: number;
  fogFar: number;
  fogMax: number;
  skylineFog: number;
  atmosMode: number;
  hazeDist: number;
  hazeMax: number;
  hazeDesat: number;
  detailFade: number;
  edgeLevel: number;
  farEnd: number;
  farMax: number;
}

/** Push the active preset into the pipeline options; `fogFar` must already be set. */
export function applyHaze(po: HazeTarget): void {
  const s = haze.s;
  const thick = weatherNow.thick;
  po.fogNear = po.fogFar * s.edgeStart;
  po.fogMax = 1;
  po.skylineFog = Math.min(1, s.skylineFog + 0.4 * thick);
  po.atmosMode = s.mode;
  // rain/snow/fog: the haze comes closer and gets denser (BN sight_penalty), still capped
  // well below opaque so a shape on the road stays a shape
  po.hazeDist = s.hazeDist / (1 + 2.5 * thick);
  po.hazeMax = Math.min(0.85, s.hazeMax + 0.3 * thick);
  po.hazeDesat = s.hazeDesat;
  po.detailFade = s.detailFade;
  po.edgeLevel = Math.min(1, s.edgeLevel + 0.3 * thick);
  po.farEnd = po.fogFar + Math.max(1, s.farSpan / (1 + 2 * thick));
  po.farMax = Math.min(1, s.farMax + 0.25 * thick);
}

// --- weather ---------------------------------------------------------------------------
// The renderer used to show rain falling out of a clear blue sky with the sun disc blazing
// and hard sun shadows. Overcast now comes from the game weather (BN light_modifier:
// cloudy -20, rain -30, thunder -40): the sun dims and its disc hides, the sky and fog go
// grey, and ambient takes over, so forms are lit softly from above (still readable: the
// hemisphere light keeps the tops of things brighter than their sides).

/** What the renderer needs from game.weather (src/game/weather.ts WeatherState). */
export interface WeatherLike {
  id: string;
  lightModifier: number;
  sightPenalty: number;
  /** set when a script/debug forced the weather: then the look switches at once */
  forced: string | null;
}

/** Smoothed current weather effect: overcast 0..1, thick (visibility loss) 0..1. */
export const weatherNow = { overcast: 0, thick: 0 };

export function weatherTargets(w: WeatherLike | null | undefined): { overcast: number; thick: number } {
  if (!w) return { overcast: 0, thick: 0 };
  return {
    overcast: Math.min(1, Math.max(0, -w.lightModifier / 40)),
    thick: Math.min(1, Math.max(0, (w.sightPenalty - 1) / 0.3)),
  };
}

let lastForced: string | null = null;
const _grey = new THREE.Color();
function toGrey(c: THREE.Color, k: number, dim: number): void {
  const l = c.r * 0.3 + c.g * 0.59 + c.b * 0.11;
  _grey.setRGB(l, l, l * 1.04);
  c.lerp(_grey, k).multiplyScalar(dim);
}

/**
 * Ease weatherNow toward the game weather and apply overcast to the sky state (after
 * SkyState.update, before lights/sky read it). `dt` in seconds; returns the overcast
 * factor for the sky's cloud cover.
 */
export function applyWeatherSky(sky: SkyState, w: WeatherLike | null | undefined, dt: number, snap = false): number {
  const t = weatherTargets(w);
  const forcedNow = w?.forced ? w.id : null;
  if (forcedNow !== lastForced) snap = true;
  lastForced = forcedNow;
  const k = snap ? 1 : Math.min(1, dt * 0.5);
  weatherNow.overcast += (t.overcast - weatherNow.overcast) * k;
  weatherNow.thick += (t.thick - weatherNow.thick) * k;
  const o = weatherNow.overcast;
  if (o < 1e-3) return 0;
  sky.sunIntensity *= 1 - 0.72 * o;
  sky.sunVisible = 1 - Math.min(1, o * 1.6);
  toGrey(sky.sunColor, 0.6 * o, 1);
  toGrey(sky.zenith, 0.75 * o, 1 - 0.2 * o);
  toGrey(sky.horizon, 0.6 * o, 1 - 0.12 * o);
  toGrey(sky.fog, 0.6 * o, 1 - 0.1 * o);
  toGrey(sky.hemiSky, 0.5 * o, 1);
  // diffuse skylight carries an overcast day: a little less of it, but it now dominates
  sky.hemiIntensity *= 1 - 0.12 * o;
  return o;
}
