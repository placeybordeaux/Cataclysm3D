// ui2 visual language: palette + metrics as CSS custom properties on #ui2, and procedurally
// drawn 9-slice pixel skins (panels, wells, buttons, drop feedback) regenerated per UI scale.
//
// Skins are tiny pixel patterns (8×8 UI pixels: outline ring, bevel ring, inner ring, fill)
// drawn at the current integer scale and used as CSS `border-image` with a slice equal to the
// border width, so the art is never resampled: edges stretch only along their length, where
// every pixel is the same colour. That's what keeps the borders crisp at 1×/2×/3×.

import './ui2.css';
import { resolveScale, uiMetrics, type UiMetrics, type UiScale, type UiScalePref } from './logic/scale';
import { uiPalette, type UiPalette } from './logic/palette';

const SCALE_KEY = 'cdda3d.ui2.scale';

export const palette: UiPalette = uiPalette();

let pref: UiScalePref = loadPref();
let metrics: UiMetrics = uiMetrics(1);
const listeners: ((m: UiMetrics) => void)[] = [];
let rootEl: HTMLElement | null = null;

function loadPref(): UiScalePref {
  try {
    const v = localStorage.getItem(SCALE_KEY);
    if (v === '1' || v === '2' || v === '3') return Number(v) as UiScale;
  } catch {
    // storage blocked: auto
  }
  return 'auto';
}

export function scalePref(): UiScalePref {
  return pref;
}
export function currentMetrics(): UiMetrics {
  return metrics;
}

/** 'auto' or a fixed 1/2/3; persisted, applied immediately. */
export function setScalePref(p: UiScalePref): void {
  pref = p;
  try {
    if (p === 'auto') localStorage.removeItem(SCALE_KEY);
    else localStorage.setItem(SCALE_KEY, String(p));
  } catch {
    // not persisted
  }
  applyScale();
}

export function onScaleChange(fn: (m: UiMetrics) => void): () => void {
  listeners.push(fn);
  return () => listeners.splice(listeners.indexOf(fn), 1);
}

/** Put palette + metrics + skins on the root element and keep them current on resize. */
export function installTheme(root: HTMLElement): void {
  rootEl = root;
  const p = palette as unknown as Record<string, string>;
  for (const k of Object.keys(p)) root.style.setProperty(`--p-${kebab(k)}`, p[k]);
  applyScale();
  window.addEventListener('resize', () => applyScale());
}

function applyScale(): void {
  if (!rootEl) return;
  const s = resolveScale(pref, window.innerWidth, window.innerHeight);
  const changed = s !== metrics.scale || !rootEl.dataset.scale;
  metrics = uiMetrics(s);
  if (!changed) return;
  const r = rootEl.style;
  r.setProperty('--u', `${metrics.u}px`);
  r.setProperty('--fs', `${metrics.font}px`);
  r.setProperty('--fs-s', `${metrics.fontSmall}px`);
  r.setProperty('--fs-l', `${metrics.fontLarge}px`);
  r.setProperty('--icon', `${metrics.icon}px`);
  r.setProperty('--row-icon', `${metrics.rowIcon}px`);
  r.setProperty('--icon-k', String(metrics.icon / 32));
  r.setProperty('--row-icon-k', String(metrics.rowIcon / 32));
  for (const [name, spec] of Object.entries(SKINS)) r.setProperty(`--skin-${name}`, skinCss(spec, metrics.u));
  rootEl.dataset.scale = String(s);
  for (const f of listeners) f(metrics);
}

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());

// --- 9-slice skins -------------------------------------------------------------------------

/** Ring colours from the outside in: [top/left, bottom/right]; null = transparent. */
interface SkinSpec {
  rings: [string | null, string | null][];
  fill: string;
  /** Knock out the outer ring's corner pixels (the pixel-art "rounded" corner). */
  cut?: boolean;
}

const P = palette;
const rgba = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
};

export const SKINS: Record<string, SkinSpec> = {
  // Windows: dark outline, warm bevel frame, a dark inner line, translucent fill.
  panel: { rings: [[P.outline, P.outline], [P.bevelHi, P.bgRaised], [P.outline, P.outline]], fill: rgba(P.bg, 0.96), cut: true },
  // Slot wells: inverted bevel (lit from the bottom right) so they read as recessed.
  inset: { rings: [[P.bevelLo, P.bevelHi], [P.bgDeep, P.bgRaised], [P.bgDeep, P.bgDeep]], fill: P.bgDeep },
  'inset-hover': { rings: [[P.bevelLo, P.bevelHi], [P.accentDim, P.accentDim], [P.bgDeep, P.bgDeep]], fill: P.bgHover },
  'inset-sel': { rings: [[P.accent, P.accent], [P.accentDim, P.accentDim], [P.bgDeep, P.bgDeep]], fill: P.bgHover },
  'inset-ok': { rings: [[P.good, P.good], [P.good, P.good], [P.bgDeep, P.bgDeep]], fill: rgba(P.good, 0.18) },
  'inset-partial': { rings: [[P.warn, P.warn], [P.accentDim, P.accentDim], [P.bgDeep, P.bgDeep]], fill: rgba(P.warn, 0.12) },
  'inset-bad': { rings: [[P.danger, P.danger], [P.danger, P.danger], [P.bgDeep, P.bgDeep]], fill: rgba(P.danger, 0.15) },
  btn: { rings: [[P.outline, P.outline], [P.bevelHi, P.bevelLo], [P.bgRaised, P.bgRaised]], fill: P.bgRaised, cut: true },
  'btn-hover': { rings: [[P.outline, P.outline], [P.accent, P.accentDim], [P.bgHover, P.bgHover]], fill: P.bgHover, cut: true },
  'btn-down': { rings: [[P.outline, P.outline], [P.bevelLo, P.bevelHi], [P.bgDeep, P.bgDeep]], fill: P.bgDeep, cut: true },
  'btn-off': { rings: [[P.outline, P.outline], [P.bgRaised, P.bgRaised], [P.bg, P.bg]], fill: P.bg, cut: true },
  tip: { rings: [[P.outline, P.outline], [P.accentDim, P.accentDim], [P.bgDeep, P.bgDeep]], fill: rgba(P.bgDeep, 0.97), cut: true },
  menu: { rings: [[P.outline, P.outline], [P.bevelHi, P.bgRaised], [P.bgDeep, P.bgDeep]], fill: rgba(P.bgDeep, 0.98), cut: true },
  bar: { rings: [[P.outline, P.outline], [P.bgDeep, P.bgDeep], [P.bgDeep, P.bgDeep]], fill: P.bgDeep },
};

const RING = 3;

/** Draw a skin at integer scale `u`; returns a CSS border-image value. */
function skinCss(spec: SkinSpec, u: number): string {
  if (typeof document === 'undefined') return 'none';
  const n = RING * 2 + 2;
  const c = document.createElement('canvas');
  c.width = c.height = n * u;
  const g = c.getContext('2d')!;
  const px = (x: number, y: number, col: string | null) => {
    if (!col) return;
    g.fillStyle = col;
    g.fillRect(x * u, y * u, u, u);
  };
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      // Distance to the nearest edge picks the ring; which edge picks the lit/shaded colour.
      const d = Math.min(x, y, n - 1 - x, n - 1 - y);
      if (d >= spec.rings.length) {
        g.clearRect(x * u, y * u, u, u);
        px(x, y, spec.fill);
        continue;
      }
      if (spec.cut && d === 0 && (x === 0 || x === n - 1) && (y === 0 || y === n - 1)) continue;
      const [lit, shade] = spec.rings[d];
      // Top and left edges are lit; the anti-diagonal corners split between the two.
      const litSide = y === d ? x < n - 1 - d : x === d ? y < n - 1 - d : false;
      px(x, y, litSide ? lit : shade);
    }
  return `url(${c.toDataURL()}) ${RING * u} fill / ${RING * u}px stretch`;
}
