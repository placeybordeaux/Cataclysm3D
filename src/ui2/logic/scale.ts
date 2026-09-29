// UI scale: one integer "UI pixel" size for everything drawn as pixel art (panel borders,
// bevels, icons), plus a text ladder. Pure so it's unit-tested (tests/ui2.test.ts).
//
// Why a ladder for text instead of text × scale: Terminus is a vector outline of a bitmap
// font and renders crisply at every even size, so text doesn't need to snap to the UI pixel
// grid — and 16px × 2 = 32px text at 1080p would waste half the screen. Icons and 9-slice
// panels *do* snap: they are UltiCa/procedural pixel art scaled with nearest filtering, and a
// non-integer factor would make some art pixels wider than others.

export type UiScale = 1 | 2 | 3;
export type UiScalePref = 'auto' | UiScale;

/**
 * Scale for a viewport in CSS px. Height decides (UI is laid out in rows); width only pulls it
 * down for narrow windows, never up (a 3440×1304 ultrawide is a 2× screen, not a 3× one).
 *   960×540 → 1, 1280×720 → 1, 1920×1080 → 2, 3440×1304 → 2, 2560×1440 → 2, 3840×2160 → 3
 */
export function autoScale(w: number, h: number): UiScale {
  const byH: UiScale = h < 820 ? 1 : h < 1560 ? 2 : 3;
  const byW: UiScale = w < 1200 ? 1 : w < 2400 ? 2 : 3;
  return Math.min(byH, byW) as UiScale;
}

export function resolveScale(pref: UiScalePref, w: number, h: number): UiScale {
  return pref === 'auto' ? autoScale(w, h) : pref;
}

export interface UiMetrics {
  scale: UiScale;
  /** CSS px per UI pixel (borders, bevels, the 9-slice art). */
  u: number;
  /** Body text size, px. */
  font: number;
  /** Counts, badges, secondary text, px. */
  fontSmall: number;
  /** Titles, px. */
  fontLarge: number;
  /** Grid-cell icon edge, px: 32px UltiCa sprites × an integer. */
  icon: number;
  /** List-row icon edge, px (also an integer multiple of the 32px sprite). */
  rowIcon: number;
}

export function uiMetrics(scale: UiScale): UiMetrics {
  switch (scale) {
    case 1:
      return { scale, u: 1, font: 16, fontSmall: 12, fontLarge: 16, icon: 32, rowIcon: 32 };
    case 2:
      return { scale, u: 2, font: 22, fontSmall: 16, fontLarge: 24, icon: 64, rowIcon: 32 };
    case 3:
      return { scale, u: 3, font: 32, fontSmall: 24, fontLarge: 36, icon: 96, rowIcon: 64 };
  }
}
