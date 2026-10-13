import { storeVisualPreference, visualPreference } from './visualPreference';

/**
 * How a vehicle headlight's beam reaches the tile light map (lights.ts, lightmap.ts). The
 * shadowed headlight spot (headlightShadow.ts) draws the beam itself; the light map also gets
 * stand-in round lights stepped along it (vehicleMesh.ts BEAM), so the beam counts for
 * light-map gating and gameplay light (lightAt):
 *   smooth — the stand-ins cast from their sub-tile position (bilinear over four tiles) and
 *            stay out of the point-light pool (default)
 *   tile   — before 2026-10-13: each stand-in casts from its whole tile and competes for the
 *            pool, so lit walls popped as you drove past and street lamps lost their pools
 *   spot   — no stand-ins at all: only the spot lights the beam; gameplay light ignores
 *            headlights (a monster sees you no better in your own beam)
 * ?beam=, Options > Display, persisted like the other visual preferences.
 */
export const BEAM_MODES = ['smooth', 'tile', 'spot'] as const;
export type BeamMode = (typeof BEAM_MODES)[number];

export const beamSettings = { mode: visualPreference<BeamMode>('beam', BEAM_MODES, 'smooth') };

export function setBeamMode(m: BeamMode): void {
  beamSettings.mode = m;
  storeVisualPreference('beam', m);
}
