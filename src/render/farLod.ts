import type * as THREE from 'three';
import { CHUNK, LEVEL_HEIGHT } from '../world/coords';
import { clearFade, setFade } from './dissolve';
import type { FarProxyLayer } from './farProxy';
import type { PlaceholderLayer } from './placeholders';
import type { ChunkGroupView } from './chunkManager';
import { storeVisualPreference, visualPreference } from './visualPreference';

// How the world beyond and at the draw-distance edge hands over to the real chunks
// (docs/FAR_LOD.md). Buildings used to rise out of the bare far ground ring at the edge, where
// the default haze leaves them ~75 % visible: first as an overmap stand-in box, then as the
// real mesh, upper storeys a beat later.
//   current        — that (for comparison)
//   dissolve       — stand-ins fade in; a column's stand-in holds until every level the chunk
//                    manager wants is shown, then the chunks dissolve in over it
//   proxy          — low-poly proxies from the real map out to 1.75x the draw distance
//                    (farProxy.ts); a column's proxy holds until its chunks are all shown,
//                    then they swap in one frame
//   proxy-dissolve — proxies, and the swap is a dissolve (default)
// ?farlod=, Options > World detail > Far detail, cdda.setFarLod; persisted.

export const FAR_LOD_MODES = ['proxy-dissolve', 'proxy', 'dissolve', 'current'] as const;
export type FarLodMode = (typeof FAR_LOD_MODES)[number];
export const farLod = { mode: visualPreference<FarLodMode>('farlod', FAR_LOD_MODES, 'proxy-dissolve') };

export function setFarLodMode(m: FarLodMode, persist: boolean): void {
  if (!(FAR_LOD_MODES as readonly string[]).includes(m)) throw new Error(`unknown far LOD mode ${m} (expected ${FAR_LOD_MODES.join('|')})`);
  farLod.mode = m;
  if (persist) storeVisualPreference('farlod', m);
}

export const usesProxies = (m: FarLodMode) => m === 'proxy' || m === 'proxy-dissolve';
export const dissolves = (m: FarLodMode) => m === 'dissolve' || m === 'proxy-dissolve';

/**
 * Real car models are drawn out to this far (m, a column's centre from the player); past it,
 * in a handed-over column, its cap carries the cars as boxes (one draw for the column instead
 * of several per car: ~200 draw calls in a city). vehicleMesh.ts asks farCarColumn.
 */
export const FAR_CAR_RANGE = 130;
/** Is column (cx, cy) past the real cars' range from (px, py)? (both sides use this one rule) */
export function farCarColumn(cx: number, cy: number, px: number, py: number): boolean {
  return Math.hypot((cx + 0.5) * CHUNK - px, (cy + 0.5) * CHUNK - py) > FAR_CAR_RANGE;
}

/** Seconds a dissolve takes. */
export const DISSOLVE_S = 0.6;
/** Proxies the hand-off may build in one frame for covers the ring hasn't reached (0.2-1 ms each). */
const ENSURE_PER_FRAME = 4;
/** Columns this close (chunks) never hold: around the player a chunk shows as soon as it's built. */
const NO_HOLD = 1.5;

const colKey = (cx: number, cy: number) => (cx + 32768) * 65536 + (cy + 32768);

/**
 * Per column: 'hold' = not every wanted level is shown, its cover (proxy or stand-in) is drawn
 * and its chunks are kept at dissolve 0; 'fade' = chunks dissolving in over the cover
 * dissolving out; 'done' = chunks only. A column with no cover never holds.
 */
interface ColState {
  cx: number;
  cy: number;
  state: 'hold' | 'fade' | 'done';
  t0: number;
  cover: THREE.Object3D | null;
  /** groups we put a fade on (to clear them; a rebuild makes a new group) */
  groups: Set<THREE.Object3D>;
  /** groups first seen after 'done' (a storey arriving late): their own fade-in start */
  late: Map<THREE.Object3D, number>;
  seen: number;
  /** within NO_HOLD of the player when first seen: never held, nothing fades */
  near: boolean;
  /** levels that have had a group: a new group there is a rebuild (shown at once), not a late storey */
  levels: Set<number>;
  /** the ground-level entry this state is about (one dropped and made again is a new column) */
  e0: ChunkGroupView;
}

export interface HandoffChunks {
  radius: number;
  columnComplete(cx: number, cy: number): boolean;
  entryAt(cx: number, cy: number, z: number): ChunkGroupView | undefined;
}

/**
 * Runs right after the chunk manager's update (its afterUpdate hook), so a chunk built this
 * frame is faded before it is ever drawn.
 */
export class Handoff {
  private cols = new Map<number, ColState>();
  private frame = 0;
  readonly stats = { holding: 0, fading: 0, done: 0, late: 0 };
  /** columns per frame (the ring inside the draw radius) */
  private ring: [number, number][] = [];
  private ringR = -1;

  constructor(
    private chunks: HandoffChunks,
    private placeholders: PlaceholderLayer | null,
    private proxies: FarProxyLayer | null,
    private topLevel: (cx: number, cy: number) => number,
  ) {}

  /** Is column (cx, cy) handed over to its chunks (stand-ins and proxies stay off it)? */
  done(cx: number, cy: number): boolean {
    const s = this.cols.get(colKey(cx, cy));
    return s?.state === 'done' && s.e0.shown === true;
  }

  /** Is column (cx, cy) still held (its chunks not dissolving in yet) under a cover? */
  holding(cx: number, cy: number): boolean {
    const s = this.cols.get(colKey(cx, cy));
    return !!s && s.state === 'hold' && !!s.cover;
  }

  /** Is column (cx, cy) held or fading under its cover (the cover is the hand-off's)? */
  covering(cx: number, cy: number): boolean {
    const s = this.cols.get(colKey(cx, cy));
    return !!s && s.state !== 'done' && !!s.cover;
  }

  private px = 0;
  private py = 0;

  update(px: number, py: number, pz: number): void {
    this.px = px;
    this.py = py;
    const mode = farLod.mode;
    const now = performance.now();
    this.frame++;
    this.ensured = 0;
    if (mode === 'current' || pz < 0) {
      if (this.cols.size) this.reset();
      return;
    }
    const R = this.chunks.radius;
    if (this.ringR !== R) {
      this.ring = [];
      const r = R + 1;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= (R + 1.5) ** 2) this.ring.push([dx, dy]);
      this.ringR = R;
    }
    const pcx = Math.floor(px / CHUNK), pcy = Math.floor(py / CHUNK);
    const fade = dissolves(mode);
    const proxies = usesProxies(mode) ? this.proxies : null;
    let holding = 0, fading = 0, done = 0, late = 0;
    for (const [dx, dy] of this.ring) {
      const cx = pcx + dx, cy = pcy + dy;
      const k = colKey(cx, cy);
      const e0 = this.chunks.entryAt(cx, cy, 0);
      let s = this.cols.get(k);
      if (!e0) {
        // not wanted (any more): the cover is back in charge
        if (s) this.forget(k, s);
        continue;
      }
      // its entries were dropped and made again between two looks (a teleport back, a debug
      // restream): start over, or a 'done' column would keep its proxy hidden over nothing
      if (s && s.e0 !== e0) {
        this.forget(k, s);
        s = undefined;
      }
      const top = this.topLevel(cx, cy);
      // (only asked while it matters: ~280 columns a frame)
      const complete = !s || s.state === 'hold' ? this.chunks.columnComplete(cx, cy) : true;
      if (!s) {
        const near = dx * dx + dy * dy <= NO_HOLD * NO_HOLD;
        s = { cx, cy, state: 'hold', t0: 0, cover: null, groups: new Set(), late: new Map(), seen: 0, near, levels: new Set(), e0 };
        this.cols.set(k, s);
        // around the player, or already up when we first look (a mode switch, a load): as is
        if (near || complete) {
          s.state = 'done';
          this.eachGroup(cx, cy, top, (g, z) => {
            s!.groups.add(g);
            s!.levels.add(z);
          });
          if (proxies) proxies.setHidden(cx, cy, true);
        }
      }
      s.seen = this.frame;
      // a stand-in is made a few frames after the column is wanted: keep asking while holding
      if (s.state === 'hold' && !s.cover) s.cover = this.coverOf(cx, cy, proxies);
      if (s.state === 'hold' && complete) {
        if (fade) {
          s.state = 'fade';
          s.t0 = now;
        } else this.finish(s, proxies);
      }
      if (s.state === 'hold' || s.state === 'fade') {
        const f = s.state === 'hold' ? 0 : Math.min(1, (now - s.t0) / (DISSOLVE_S * 1000));
        // holding without a cover would leave a hole: the chunks show as they come
        if (s.cover || s.state === 'fade')
          this.eachGroup(cx, cy, top, (g, z) => {
            s!.groups.add(g);
            s!.levels.add(z);
            setFade(g, f);
          });
        if (s.cover) setFade(s.cover, f, true);
        if (proxies && s.state === 'fade') this.cap(s, top, proxies);
        if (f >= 1) this.finish(s, proxies);
        else if (s.state === 'hold') holding++;
        else fading++;
      }
      if (s.state === 'done') {
        done++;
        // a level that shows up after the hand-off (a tower top once you slow down) fades in
        // on its own; rebuilt groups of shown levels (LOD flips, edits) just appear
        this.eachGroup(cx, cy, top, (g, z) => {
          if (s!.groups.has(g)) return;
          s!.groups.add(g);
          const rebuilt = s!.levels.has(z);
          s!.levels.add(z);
          if (fade && !s!.near && !rebuilt) {
            s!.late.set(g, now);
            setFade(g, 0);
          }
        });
        if (proxies && !s.near) this.cap(s, top, proxies);
        // replaced groups (rebuilds) are gone from the scene: nothing left to clear on them
        if (s.groups.size > 8) for (const g of s.groups) if (!g.parent && !s.late.has(g)) s.groups.delete(g);
        for (const [g, t] of s.late) {
          const f = (now - t) / (DISSOLVE_S * 1000);
          if (f >= 1 || !g.parent) {
            clearFade(g);
            s.late.delete(g);
          } else {
            setFade(g, f);
            late++;
          }
        }
      }
    }
    // columns not visited this frame (out of the ring)
    for (const [k, s] of this.cols) if (s.seen !== this.frame) this.forget(k, s);
    Object.assign(this.stats, { holding, fading, done, late });
  }

  /**
   * Keep the proxy of what column `s`'s chunks don't draw: storeys above the window are only
   * built within R - 2 and not at all while driving (levels.ts, chunkManager), so a tower handed
   * over at the edge kept its lower floors and lost the rest until much nearer. The cap starts
   * at the top of the highest level drawn from the ground up; a level still fading in doesn't
   * count yet (the cap leaves it once it is solid).
   */
  private cap(s: ColState, top: number, proxies: FarProxyLayer): void {
    let drawn = -1;
    for (let z = 0; z <= top; z++) {
      const e = this.chunks.entryAt(s.cx, s.cy, z);
      if (!e || !e.shown || !e.visible || (e.group && s.late.has(e.group))) break;
      drawn = z;
    }
    proxies.setCap(s.cx, s.cy, drawn < 0 ? null : (drawn + 1) * LEVEL_HEIGHT - 0.05, farCarColumn(s.cx, s.cy, this.px, this.py));
  }

  /** The cover to hold column (cx, cy) under: its proxy (proxy modes) or its stand-in. */
  private coverOf(cx: number, cy: number, proxies: FarProxyLayer | null): THREE.Object3D | null {
    // Proxy modes: the column's proxy, built now if the ring hasn't got there yet (a few a
    // frame). Never the overmap stand-in: its boxes are guesses (proxyQa: higher than the real
    // building by over a metre on a fifth of tiles), seen as "the proxies are too high".
    if (proxies) {
      if (!proxies.has(cx, cy) && this.ensured++ < ENSURE_PER_FRAME) proxies.ensure(cx, cy);
      return proxies.solo(cx, cy);
    }
    return this.placeholders?.meshAt(cx, cy) ?? null;
  }
  private ensured = 0;

  private eachGroup(cx: number, cy: number, top: number, fn: (g: THREE.Object3D, z: number) => void): void {
    for (let z = 0; z <= top; z++) {
      const e = this.chunks.entryAt(cx, cy, z);
      if (e?.group) fn(e.group, z);
    }
  }

  private finish(s: ColState, proxies: FarProxyLayer | null): void {
    for (const g of s.groups) clearFade(g);
    if (s.cover) {
      clearFade(s.cover);
      // a stand-in is removed on the placeholder layer's next pass (every 4th frame): not
      // drawn solid again until then
      if (this.placeholders && this.placeholders.meshAt(s.cx, s.cy) === s.cover) s.cover.visible = false;
    }
    s.cover = null;
    s.state = 'done';
    if (proxies) {
      proxies.unsolo(s.cx, s.cy);
      proxies.setHidden(s.cx, s.cy, true);
    }
  }

  private forget(k: number, s: ColState): void {
    for (const g of s.groups) clearFade(g);
    for (const g of s.late.keys()) clearFade(g);
    if (s.cover) clearFade(s.cover);
    if (this.proxies) {
      this.proxies.unsolo(s.cx, s.cy);
      this.proxies.setHidden(s.cx, s.cy, false);
    }
    this.cols.delete(k);
  }

  /** Back to no hand-off at all (mode 'current', underground, a teleport). */
  reset(): void {
    for (const [k, s] of [...this.cols]) this.forget(k, s);
  }
}
