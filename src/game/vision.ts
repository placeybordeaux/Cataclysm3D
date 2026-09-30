import type { Game } from './game';
import type { Chunk, GameMap } from '../world/map';
import { CHUNK, chunkOf } from '../world/coords';
import { hasFlag } from '../world/registry';
import type { GameClock } from '../core/time';
import { SECONDS_PER_DAY } from '../core/time';
import type { Item } from './item';
import { sunPosition as sunPositionAt } from './sun';

// Tile vision and light, after CDDA lightmap.cpp / calendar.cpp, kept cheap:
//  - lineOfSight: Bresenham over map.opaque (endpoints excluded)
//  - lightAt: natural light (sun/moon by time of day and weather; indoors = CDDA's
//    inside_light_level plus light leaking in through nearby windows/doors) + point
//    sources (terrain/furniture light_emitted, fire fields, lit items on the ground, the
//    player's active light item) falling off with distance².
// Light values are CDDA units: LIGHT_AMBIENT_LOW 3.5 (can't see), LIT 10, noon sun 125.

export const LIGHT_AMBIENT_LOW = 3.5;
export const LIGHT_AMBIENT_MINIMAL = 3.7;
export const LIGHT_AMBIENT_DIM = 5.0;
export const LIGHT_AMBIENT_LIT = 10.0;
export const LIGHT_SOURCE_BRIGHT = 10.0;
/** calendar.cpp default_daylight_level(): full-day light for monster vision. */
export const DEFAULT_DAYLIGHT = 100;
/** CDDA default map view distance for the player. */
export const MAX_VIEW_DISTANCE = 60;

/** Tiles on the line from (x0,y0) to (x1,y1) inclusive. */
export function bresenham(x0: number, y0: number, x1: number, y1: number): [number, number][] {
  const out: [number, number][] = [];
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy, x = x0, y = y0;
  for (;;) {
    out.push([x, y]);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) (err += dy), (x += sx);
    if (e2 <= dx) (err += dx), (y += sy);
  }
  return out;
}

/** True if nothing opaque lies strictly between the two tiles (same z-level). */
export function lineOfSight(map: GameMap, x0: number, y0: number, x1: number, y1: number, z: number): boolean {
  const pts = bresenham(x0, y0, x1, y1);
  for (let i = 1; i < pts.length - 1; i++) if (map.opaque(pts[i][0], pts[i][1], z)) return false;
  return true;
}

// ------------------------------------------------------------------ sun & moon

/** Solar altitude in degrees at game time `seconds` (shared with the renderer: src/game/sun.ts). */
export function sunAltitudeAt(seconds: number): number {
  return sunPositionAt(seconds).altitude;
}
export function sunAltitude(clock: GameClock): number {
  return sunAltitudeAt(clock.seconds);
}

/** calendar.cpp sun_light_at(): 0 below astronomical dawn … 125 above 60°. */
export function sunLight(alt: number): number {
  if (alt < -18) return 0;
  if (alt <= -12) return 3.7 * (2 ** ((alt + 18) / 6) - 1);
  if (alt <= -6) return (5 - 3.7) * (2 ** ((alt + 12) / 6) - 1) + 3.7;
  if (alt <= -1) return (60 - 5) * (2 ** ((alt + 6) / 5) - 1) + 5;
  if (alt <= 60) return (65 / 61) * alt + 65 / 61 + 60;
  return 125;
}

/** calendar.cpp moon_light_at(): 1 + 1.5 per quarter of phase toward full. */
export function moonLight(clock: GameClock): number {
  const synodic = 29.53;
  const days = clock.seconds / SECONDS_PER_DAY;
  let phase = Math.floor(((days % synodic) / synodic) * 8); // 0 new … 4 full … 7
  if (phase > 4) phase = 8 - phase;
  return 1 + 1.5 * phase;
}

export function isDay(clock: GameClock): boolean {
  return sunAltitude(clock) >= -1;
}
export function isNight(clock: GameClock): boolean {
  return sunAltitude(clock) <= -6;
}

/** Outdoor ambient light: incident sunlight + moonlight, each reduced by the weather. */
export function naturalLight(game: Game): number {
  const mod = game.weather?.lightModifier ?? 0;
  const sun = Math.max(0, sunLight(sunAltitude(game.clock)) + mod);
  const moon = Math.max(0, moonLight(game.clock) + mod);
  return sun + moon;
}

/** Under the open sky (no roof/floor above, not an INDOORS tile, not underground). */
export function isOutside(map: GameMap, x: number, y: number, z: number): boolean {
  if (z < 0) return false;
  const t = map.terAt(x, y, z);
  if (hasFlag(t, 'INDOORS')) return false;
  return !map.hasFloor(x, y, z + 1);
}

// ------------------------------------------------------------------ light sources

export interface LightSource {
  x: number;
  y: number;
  z: number;
  /** CDDA luminance */
  lum: number;
}

/** field_type light_emitted per intensity (fd_fire: 20 / 60 / 160). */
export function fieldLight(game: Game, type: string, intensity: number): number {
  const ft = game.data.misc.field_type?.[type];
  const levels = ft?.intensity_levels as { light_emitted?: number }[] | undefined;
  if (!levels) return 0;
  let v = 0;
  for (let i = 0; i < Math.min(intensity, levels.length); i++) if (levels[i].light_emitted !== undefined) v = levels[i].light_emitted!;
  return v;
}

/**
 * The luminance an item type gives off. BN keeps it in `light_emission` (LIGHT_<n> flags are
 * folded in by the extractor); the DDA-era `light` field no longer exists in the data, which
 * left every flashlight dark on Bright Nights (found in the wave-3 first-night playtest).
 */
export function defLight(def: { light_emission?: number; light?: unknown } | undefined): number {
  return Number(def?.light_emission ?? def?.light ?? 0);
}

/**
 * item::getlight_emit: the type's light_emission (an "on" item is its own type, e.g.
 * flashlight_on, so no active check), dimmed by CHARGEDIM below a fifth of the charge.
 */
export function itemLight(it: Item): number {
  let l = defLight(it.def);
  if (l <= 0) return 0;
  if (it.hasFlag('CHARGEDIM') && !it.hasFlag('USE_UPS')) {
    const cap = it.ammoCapacity(), rem = it.ammoRemaining();
    if (cap && rem < cap / 5) l *= (rem * 5) / cap;
  }
  return l;
}

const chunkLights = new WeakMap<Chunk, { version: number; list: LightSource[] }>();

/** A personal light that isn't an item (bionic flashlight): luminance and beam vs glow. */
export interface BodyLight {
  lum: number;
  directional: boolean;
  name: string;
}

/**
 * Per-game hooks for body modifications (src/game/mutations.ts, bionics.ts): personal light
 * sources, and night vision as extra sight range (Character::get_vision_threshold).
 */
export interface VisionHooks {
  lights: ((game: Game) => BodyLight | null)[];
  nightVision: ((game: Game) => number)[];
}
const visionHookMap = new WeakMap<Game, VisionHooks>();
export function visionHooks(game: Game): VisionHooks {
  let h = visionHookMap.get(game);
  if (!h) visionHookMap.set(game, (h = { lights: [], nightVision: [] }));
  return h;
}

/** Brightest body light (bionic flashlight…), or null. */
export function bodyLight(game: Game): BodyLight | null {
  let best: BodyLight | null = null;
  for (const f of visionHooks(game).lights) {
    const l = f(game);
    if (l && l.lum > (best?.lum ?? 0)) best = l;
  }
  return best;
}

/** Extra night-vision sight range from mutations/bionics (NIGHTVISION +2 … NIGHT_VISION +10). */
export function nightVisionRange(game: Game): number {
  let r = 0;
  for (const f of visionHooks(game).nightVision) r = Math.max(r, f(game));
  return r;
}

/**
 * Character::get_vision_threshold: the light level below which you can't see. Base range is
 * per/3; night vision adds to it. Clamped to LIGHT_AMBIENT_LOW like CDDA.
 */
export function visionThreshold(game: Game, light: number): number {
  const nv = nightVisionRange(game);
  if (nv <= 0) return LIGHT_AMBIENT_LOW;
  const dimming = 1 + (light - LIGHT_AMBIENT_MINIMAL) / (LIGHT_AMBIENT_LIT - LIGHT_AMBIENT_MINIMAL);
  const range = Math.max(1, game.player.per / 3 + nv);
  const LIGHT_TRANSPARENCY_OPEN_AIR = 0.038376418216;
  return Math.min(LIGHT_AMBIENT_LOW, (LIGHT_AMBIENT_MINIMAL / Math.exp(range * LIGHT_TRANSPARENCY_OPEN_AIR) - 0.01) * Math.max(1, dimming));
}

/** Static + field + item light sources in a chunk, cached until the chunk changes. */
export function chunkLightSources(game: Game, c: Chunk): LightSource[] {
  const hit = chunkLights.get(c);
  if (hit && hit.version === c.version) return hit.list;
  const list: LightSource[] = [];
  const map = game.map;
  const x0 = c.cx * CHUNK, y0 = c.cy * CHUNK;
  for (let i = 0; i < CHUNK * CHUNK; i++) {
    const t = c.ter[i], f = c.furn[i];
    let lum = 0;
    if (t) lum += map.terrain.defs[t].light_emitted ?? 0;
    if (f) lum += map.furniture.defs[f].light_emitted ?? 0;
    if (lum > 0) list.push({ x: x0 + (i % CHUNK), y: y0 + Math.floor(i / CHUNK), z: c.z, lum });
  }
  for (const [i, fields] of c.fields) {
    let lum = 0;
    for (const fd of fields) lum += fieldLight(game, fd.type, fd.intensity);
    if (lum > 0) list.push({ x: x0 + (i % CHUNK), y: y0 + Math.floor(i / CHUNK), z: c.z, lum });
  }
  for (const [i, items] of c.items) {
    let lum = 0;
    for (const it of items) lum += itemLight(it as unknown as Item);
    if (lum > 0) list.push({ x: x0 + (i % CHUNK), y: y0 + Math.floor(i / CHUNK), z: c.z, lum });
  }
  chunkLights.set(c, { version: c.version, list });
  return list;
}

/** Brightest shining item the player carries (flashlight_on, lit lantern…); 0 if none. */
export function playerLight(game: Game): number {
  let best = 0;
  for (const it of game.player.inv.allItems()) best = Math.max(best, itemLight(it));
  return Math.max(best, bodyLight(game)?.lum ?? 0);
}

/** Point-light contribution: lum / d², cut off once it falls under LIGHT_AMBIENT_LOW/4. */
function sourceLight(game: Game, s: LightSource, x: number, y: number, z: number): number {
  if (s.z !== z) return 0;
  const d2 = (s.x - x) ** 2 + (s.y - y) ** 2;
  const l = s.lum / Math.max(1, d2);
  if (l < 0.5) return 0;
  if (d2 > 2 && !lineOfSight(game.map, s.x, s.y, x, y, z)) return 0;
  return l;
}

// ------------------------------------------------------------------ light at a tile

const naturalCache = new WeakMap<Game, Map<string, { v: number; t: number }>>();
/** Forget cached daylight: a window was covered or uncovered (curtains, a door, a smashed wall). */
export function invalidateNaturalLight(game: Game): void {
  naturalCache.delete(game);
}
const NATURAL_TTL = 30; // game seconds

/** Natural (sun/moon) light reaching a tile, including light through windows indoors. */
export function naturalLightAt(game: Game, x: number, y: number, z: number): number {
  let cache = naturalCache.get(game);
  if (!cache) naturalCache.set(game, (cache = new Map()));
  const key = `${x},${y},${z}`;
  const now = game.clock.seconds;
  const hit = cache.get(key);
  if (hit && Math.abs(now - hit.t) < NATURAL_TTL) return hit.v;
  const v = computeNatural(game, x, y, z);
  if (cache.size > 20000) cache.clear();
  cache.set(key, { v, t: now });
  return v;
}

function computeNatural(game: Game, x: number, y: number, z: number): number {
  const outside = naturalLight(game);
  const map = game.map;
  if (isOutside(map, x, y, z)) return outside;
  // lightmap.cpp inside_light_level: a little light indoors during the day.
  const inside = z >= 0 && outside > LIGHT_SOURCE_BRIGHT ? LIGHT_AMBIENT_DIM * 0.8 : LIGHT_AMBIENT_LOW;
  if (z < 0 || outside <= inside) return inside;
  // Daylight through the nearest window/doorway/outdoor tile in view (CDDA propagates the
  // sunlight cache through transparent tiles; this is the cheap version).
  const R = 6;
  const cands: [number, number, number][] = [];
  for (let dy = -R; dy <= R; dy++)
    for (let dx = -R; dx <= R; dx++) {
      const d2 = dx * dx + dy * dy;
      if (d2 === 0 || d2 > R * R) continue;
      const tx = x + dx, ty = y + dy;
      if (map.opaque(tx, ty, z)) continue;
      if (!isOutside(map, tx, ty, z)) continue;
      cands.push([d2, tx, ty]);
    }
  cands.sort((a, b) => a[0] - b[0]);
  for (const [d2, tx, ty] of cands.slice(0, 12)) {
    if (!lineOfSight(map, tx, ty, x, y, z)) continue;
    return Math.max(inside, (outside * 0.6) / (1 + d2 / 8));
  }
  return inside;
}

/**
 * Flashlights and headlamps throw a beam (the renderer's spotlight); lamps, lanterns,
 * candles and torches glow all round (a light handle, so they are in the light map).
 */
export function isDirectionalLight(it: Item): boolean {
  return !it.hasFlag('FIRE') && !/lamp|lantern|candle|torch/.test(it.typeId);
}

/**
 * Total light at a tile (CDDA ambient_light_at), cheap enough for per-tick monster checks.
 * Uses `game.lightProvider` (the renderer's shadowcast light map) where it is exact; the
 * survivor's own beam light isn't in that map, so it is added here like any point source.
 */
export function lightAt(game: Game, x: number, y: number, z: number): number {
  const exact = game.lightProvider?.(x, y, z) ?? null;
  if (exact !== null) {
    let best: Item | null = null, lum = 0;
    for (const it of game.player.inv.allItems()) {
      const l = itemLight(it);
      if (l > lum) (lum = l), (best = it);
    }
    if (!best || !isDirectionalLight(best)) return exact;
    const p = game.player;
    return exact + sourceLight(game, { x: p.tileX, y: p.tileY, z: p.z, lum }, x, y, z);
  }
  return estimatedLightAt(game, x, y, z);
}

/** vision.ts's own light estimate (no renderer): natural light + point sources over LOS. */
export function estimatedLightAt(game: Game, x: number, y: number, z: number): number {
  let l = naturalLightAt(game, x, y, z);
  const cx = chunkOf(x), cy = chunkOf(y);
  for (let oy = -1; oy <= 1; oy++)
    for (let ox = -1; ox <= 1; ox++) {
      if (!game.map.hasChunk(cx + ox, cy + oy, z)) continue;
      const c = game.map.chunk(cx + ox, cy + oy, z)!;
      for (const s of chunkLightSources(game, c)) l += sourceLight(game, s, x, y, z);
    }
  const p = game.player;
  const pl = playerLight(game);
  if (pl > 0) l += sourceLight(game, { x: p.tileX, y: p.tileY, z: p.z, lum: pl }, x, y, z);
  return l;
}

// ------------------------------------------------------------------ who sees what

/** Can the player see tile (x,y,z)? Same level, in range, line of sight, and lit (or adjacent). */
export function playerCanSee(game: Game, x: number, y: number, z: number): boolean {
  const p = game.player;
  if (p.isAsleep() || p.dead) return false;
  if (z !== p.z) return false;
  const d = Math.max(Math.abs(x - p.tileX), Math.abs(y - p.tileY));
  if (d <= 1) return true;
  if (d > MAX_VIEW_DISTANCE) return false;
  if (!lineOfSight(game.map, p.tileX, p.tileY, x, y, z)) return false;
  const l = lightAt(game, x, y, z);
  return l > visionThreshold(game, l);
}

/** Alias kept short for other systems: can the player see this tile? */
export const canSee = playerCanSee;

/** monster::sight_range(light): lerp between vision_night and vision_day by light/100. */
export function monsterSightRange(visionDay: number, visionNight: number, light: number): number {
  if (light <= 0) return visionNight;
  if (light >= DEFAULT_DAYLIGHT) return visionDay;
  return Math.floor((light * visionDay + (DEFAULT_DAYLIGHT - light) * visionNight) / DEFAULT_DAYLIGHT);
}

/**
 * Can a creature at `from` with the given vision see tile `to`? Uses the light at the target,
 * so a player carrying a lit flashlight is visible from much further at night (as in CDDA).
 */
export function creatureCanSee(
  game: Game, from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number },
  visionDay: number, visionNight: number,
): boolean {
  const fx = Math.floor(from.x), fy = Math.floor(from.y), tx = Math.floor(to.x), ty = Math.floor(to.y);
  if (Math.floor(from.z) !== Math.floor(to.z)) return false;
  const d = Math.max(Math.abs(fx - tx), Math.abs(fy - ty));
  if (d > Math.max(visionDay, visionNight)) return false;
  const range = monsterSightRange(visionDay, visionNight, lightAt(game, tx, ty, to.z));
  if (d > Math.max(1, range)) return false;
  return lineOfSight(game.map, fx, fy, tx, ty, Math.floor(to.z));
}

/**
 * Character::fine_detail_vision_mod(): ≤ 4 means enough light to read or craft. Your own
 * light source counts extra since you can point it at the work.
 */
export function fineDetailVisionMod(game: Game): number {
  const p = game.player;
  if (p.hasEffect('blind') || p.hasEffect('boomered') || p.hasEffect('darkness')) return 11;
  const own = Math.max(1, LIGHT_AMBIENT_LIT - playerLight(game) - 2);
  const amb = Math.max(1, LIGHT_AMBIENT_LIT - lightAt(game, p.tileX, p.tileY, p.z) + 1);
  return Math.min(own, amb);
}

/** Crafting/reading light check: null when fine, else the CDDA refusal message. */
export function tooDarkReason(game: Game, action: 'read' | 'craft' = 'craft'): string | null {
  if (fineDetailVisionMod(game) <= 4) return null;
  return action === 'read' ? "It's too dark to read!" : "You can't see to craft!";
}
