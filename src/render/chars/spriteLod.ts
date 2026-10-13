// Distance LOD between a creature's 2D tileset sprite and its 3D body (docs/SPRITE3D.md).
// Pure (no three.js), for tests; monsterView.ts / lodView.ts apply the result.
//
// Far away a creature is a handful of pixels, and at that size the UltiCa sprite *is* the best
// picture of it: hand-placed pixels beat a downsampled model. Close up the 3D body wins (it
// turns, it has depth). In between, one has to become the other:
//
//   off     no sprite: the 3D body at every distance (the default)
//   dither  a cross-fade over a band of distances, done with the same 4x4 ordered dither on
//           both sides (complementary: every pixel is exactly one of the two)
//   pop     a hard switch at one distance, with hysteresis so it doesn't flicker at the edge
//   flip    the switch plays as a quick card flip: the outgoing picture narrows to nothing,
//           the incoming one widens from nothing (~0.2 s)
//
// Independently, inside `near` metres sprite3d bodies use their close-range (subdivided) mesh.

export type ZLod = 'off' | 'dither' | 'pop' | 'flip';
export const ZLODS: readonly ZLod[] = ['off', 'dither', 'pop', 'flip'];

export const SPRITE_LOD = {
  /** metres: the switch distance (dither: the middle of the band) */
  far: 30,
  /** dither: width of the cross-fade band (m) */
  band: 12,
  /** pop / flip: hysteresis either side of `far` (m) */
  hysteresis: 2,
  /** flip: seconds for the whole flip (half out, half in) */
  flipTime: 0.22,
  /** close-range detail mesh inside this distance (m); 0 = never */
  near: 7,
};

export interface LodState {
  /** pop / flip: currently showing the sprite */
  sprite: boolean;
  /** flip: seconds left in a running flip (0 = none) */
  flipT: number;
}

export interface LodMix {
  /** dithered fade of the 3D body: 0 solid .. 1 gone */
  modelFade: number;
  /** screen-door opacity of the sprite: 0 gone .. 1 solid */
  spriteOpacity: number;
  /** width multipliers (flip): 1 normal .. 0 edge-on */
  modelWidth: number;
  spriteWidth: number;
  /** close-range mesh */
  detail: boolean;
}

export function newLodState(dist: number, mode: ZLod, cfg = SPRITE_LOD): LodState {
  return { sprite: mode !== 'off' && mode !== 'dither' && dist > cfg.far, flipT: 0 };
}

const smooth = (a: number, b: number, x: number) => {
  const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
};

/**
 * What to draw for a creature `dist` metres from the camera. Advances `st` (pop / flip switch
 * state, flip timer) by `dt` seconds.
 */
export function lodMix(mode: ZLod, dist: number, st: LodState, dt: number, cfg = SPRITE_LOD): LodMix {
  const detail = cfg.near > 0 && dist < cfg.near;
  if (mode === 'off') return { modelFade: 0, spriteOpacity: 0, modelWidth: 1, spriteWidth: 1, detail };
  if (mode === 'dither') {
    const t = smooth(cfg.far - cfg.band / 2, cfg.far + cfg.band / 2, dist);
    return { modelFade: t, spriteOpacity: t, modelWidth: 1, spriteWidth: 1, detail };
  }
  const want = st.sprite ? dist > cfg.far - cfg.hysteresis : dist > cfg.far + cfg.hysteresis;
  if (want !== st.sprite) {
    st.sprite = want;
    if (mode === 'flip') st.flipT = cfg.flipTime;
  }
  if (mode === 'pop' || st.flipT <= 0) {
    st.flipT = 0;
    return { modelFade: st.sprite ? 1 : 0, spriteOpacity: st.sprite ? 1 : 0, modelWidth: 1, spriteWidth: 1, detail };
  }
  st.flipT = Math.max(0, st.flipT - dt);
  // u: 0 = flip just started .. 1 = done; first half the old picture closes, then the new opens
  const u = 1 - st.flipT / cfg.flipTime;
  const out = u < 0.5;
  const w = out ? 1 - u * 2 : (u - 0.5) * 2;
  const showSprite = out ? !st.sprite : st.sprite;
  return {
    modelFade: showSprite ? 1 : 0, spriteOpacity: showSprite ? 1 : 0,
    modelWidth: showSprite ? 1 : Math.max(0.02, w), spriteWidth: showSprite ? Math.max(0.02, w) : 1, detail,
  };
}

/**
 * Billboard height (m) that makes the sprite's drawn figure as tall as the 3D body: UltiCa
 * draws a zombie ~29 px tall in a 48 px frame, so the frame is scaled by the figure, not by a
 * fixed px/m. `boxTop`/`boxBottom` = the opaque rows (px), `frameH` the frame height (px).
 * Also how far (m) to sink the billboard so the figure's feet, not the frame's empty bottom
 * rows, stand on the floor.
 */
export function spriteFit(bodyHeight: number, frameH: number, boxTop: number, boxBottom: number): { height: number; sink: number } {
  const figure = Math.max(1, boxBottom - boxTop);
  const mPerPx = bodyHeight / figure;
  return { height: frameH * mPerPx, sink: (frameH - boxBottom) * mPerPx };
}
