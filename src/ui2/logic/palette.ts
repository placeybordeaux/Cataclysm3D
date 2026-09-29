// UI colours taken from the renderer's grading palette (src/render/grading.ts), so panels,
// text and highlights sit in the same ~100 colours the 3D world is snapped to. Pure.

import { buildPalette, RAMP_STEPS, type RGBf } from '../../render/grading';

// Ramp order in grading.ts RAMPS. If that list is reordered this must follow; the unit test
// checks the picked colours still look like what their names say (dark bg, light text…).
const RAMP = { neutral: 0, stone: 1, wood: 2, rust: 3, olive: 4, moss: 5, teal: 6, steel: 7, dusk: 8, sky: 9, ochre: 10 } as const;
type RampName = keyof typeof RAMP;

const toHex = (c: RGBf) => '#' + c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');

export interface UiPalette {
  /** Window fill, inset wells (slots), raised hover fill. */
  bg: string;
  bgDeep: string;
  bgRaised: string;
  bgHover: string;
  /** 1-UI-pixel outline around every panel; bevel light and dark edges. */
  outline: string;
  bevelHi: string;
  bevelLo: string;
  text: string;
  textDim: string;
  textBright: string;
  /** Title bars, focus, selection: lamplight ochre. */
  accent: string;
  accentDim: string;
  good: string;
  /** Text-safe red (≥4.5:1 on bg). */
  bad: string;
  /** Saturated red for bars, invalid-drop outlines, overflow (not for body text). */
  danger: string;
  warn: string;
  info: string;
  /** Discovery toasts / rare highlights. */
  magic: string;
}

export function uiPalette(): UiPalette {
  const pal = buildPalette();
  const ramp = (name: RampName, step: number) => toHex(pal[RAMP[name] * RAMP_STEPS + step]);
  const accent = (i: number) => toHex(pal[Object.keys(RAMP).length * RAMP_STEPS + i]);
  return {
    bg: ramp('neutral', 1),
    bgDeep: ramp('neutral', 0),
    bgRaised: ramp('stone', 2),
    bgHover: ramp('steel', 3),
    outline: ramp('neutral', 0),
    bevelHi: ramp('stone', 4),
    bevelLo: ramp('neutral', 0),
    text: ramp('neutral', 7),
    textDim: ramp('stone', 6),
    textBright: ramp('neutral', 8),
    accent: ramp('ochre', 7),
    accentDim: ramp('ochre', 4),
    good: ramp('moss', 7),
    bad: ramp('rust', 7),
    danger: accent(3),
    warn: accent(1),
    info: ramp('sky', 6),
    magic: ramp('dusk', 7),
  };
}

/** WCAG relative-luminance contrast ratio of two #rrggbb colours (for the palette test). */
export function contrast(a: string, b: string): number {
  const lum = (h: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
