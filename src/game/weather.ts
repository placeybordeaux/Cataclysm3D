import type { Game } from './game';
import type { GameData } from '../data/types';
import { DAYS_PER_SEASON, SECONDS_PER_DAY } from '../core/time';
import { hashSeed, Rng } from '../core/rng';
import { isDay, isOutside } from './vision';
import { emitSound } from './sound';

// CDDA weather, after weather_gen.cpp: temperature / humidity / pressure / wind come from
// smooth noise over time plus the seasonal and daily cycles (region "default" generator:
// base 11.1 °C, 70 % humidity, 1015 hPa, 3.4 mph wind), then the weather *type* (sunny,
// cloudy, drizzle, rain, thunder, snowing …) is picked by walking CDDA's weather_type list in
// priority order, each type requiring one of its `required_weathers` to have matched first
// and its JSON `condition` (humidity/pressure/temperature/windpower thresholds) to hold.
// Because it's a pure function of (seed, time), weather persists and is reproducible.
//
// Deviation: CDDA uses 4D simplex noise over (x, y, days, seed); the player never travels
// far enough for x/y to matter, so we use seeded 1D value noise over days.

export interface WeatherGenParams {
  base_temperature: number;
  base_humidity: number;
  base_pressure: number;
  base_wind: number;
  base_wind_distrib_peaks: number;
  base_wind_season_variation: number;
}

/** data/json/region_settings/regional_map_settings.json weather_generator "default". */
export const DEFAULT_WEATHER_GEN: WeatherGenParams = {
  base_temperature: 11.1, base_humidity: 70, base_pressure: 1015, base_wind: 3.4,
  base_wind_distrib_peaks: 80, base_wind_season_variation: 0,
};

export interface WeatherPoint {
  /** °C */
  temperature: number;
  /** relative humidity % */
  humidity: number;
  /** hPa */
  pressure: number;
  /** mph, like CDDA */
  windpower: number;
  /** degrees, 0 = north */
  winddirection: number;
}

export interface WeatherState extends WeatherPoint {
  /** CDDA weather_type id: sunny, cloudy, light_drizzle, drizzle, rain, rainstorm, thunder, lightning, flurries, snowing, snowstorm, mist, fog, clear */
  id: string;
  name: string;
  color: string;
  precip: 'none' | 'very_light' | 'light' | 'heavy';
  rains: boolean;
  /** added to sun/moon light (negative when overcast) */
  lightModifier: number;
  /** subtracted from every sound's volume */
  soundAttn: number;
  sightPenalty: number;
  /** set by cdda.setWeather / forceWeather; null = generated */
  forced: string | null;
}

// ------------------------------------------------------------------ noise

function knot(seed: number, i: number): number {
  return (hashSeed(seed, i) / 4294967296) * 2 - 1;
}
/** Smooth value noise in [-1, 1] with one feature per unit of t. */
export function valueNoise(t: number, seed: number): number {
  const i = Math.floor(t), f = t - i;
  const u = f * f * (3 - 2 * f);
  return knot(seed, i) * (1 - u) + knot(seed, i + 1) * u;
}
/** Two octaves, roughly matching simplex noise's spread. */
function noise(t: number, seed: number): number {
  return Math.max(-1, Math.min(1, (valueNoise(t, seed) * 0.75 + valueNoise(t * 2.3 + 17.1, seed + 7) * 0.4) / 1.0));
}

// ------------------------------------------------------------------ generator

const YEAR_DAYS = DAYS_PER_SEASON * 4;
/** Midwinter = middle of winter (days since spring day 1). */
const MIDWINTER = DAYS_PER_SEASON * 3 + DAYS_PER_SEASON / 2;

/** season index 0 spring … 3 winter */
function seasonOf(days: number): number {
  return Math.floor((((days % YEAR_DAYS) + YEAR_DAYS) % YEAR_DAYS) / DAYS_PER_SEASON);
}

/** weather_generator::get_weather at game time `seconds` for world `seed`. */
export function weatherPoint(seed: number, seconds: number, gen: WeatherGenParams = DEFAULT_WEATHER_GEN): WeatherPoint {
  const days = seconds / SECONDS_PER_DAY;
  const modSeed = seed % 32768;
  const cyf = Math.cos((2 * Math.PI * (days - MIDWINTER)) / YEAR_DAYS); // 1 midwinter, -1 midsummer
  const seasonality = -cyf;
  const dayFraction = (((seconds % SECONDS_PER_DAY) + SECONDS_PER_DAY) % SECONDS_PER_DAY) / SECONDS_PER_DAY;
  const dayv = Math.cos(2 * Math.PI * (dayFraction + 0.5 - 5 / 24)); // -1 at 05:00
  const baseline = gen.base_temperature + dayv * (5 + (2.0 * (-seasonality + 1)) / 2) + seasonality * 12;
  const T = baseline + noise(days, modSeed) * (1 + ((1 - seasonality) * 0.5) / 2) * 6;
  const H = Math.min(100, Math.max(0, gen.base_humidity + 100 * (0.15 * seasonality + noise(days, modSeed + 101) * 0.2 * (-seasonality + 2))));
  const P = gen.base_pressure + noise(days, modSeed + 211) * 15 * (-seasonality + 2);
  // Wind is re-rolled per 5-minute weather update, deterministically.
  const slot = Math.floor(seconds / 300);
  const rng = new Rng(hashSeed(seed, slot, 0x3a1d));
  const W0 = valueNoise(days / 200, modSeed + 5) * 10;
  const variation = gen.base_wind_season_variation === 0 ? 0 : cyf * gen.base_wind_season_variation * rng.next() * 2;
  const W = Math.max(0, Math.floor((gen.base_wind * rng.int(1, 2)) / Math.pow((P + W0) / 1014.78, rng.int(9, gen.base_wind_distrib_peaks)) + variation));
  const dirWeights = [
    [3, 3, 5, 8, 11, 10, 5, 2, 5, 6, 6, 5, 8, 10, 8, 6],
    [3, 4, 4, 8, 8, 9, 8, 3, 7, 8, 10, 7, 7, 7, 5, 3],
    [4, 6, 6, 7, 6, 5, 4, 3, 5, 6, 8, 8, 10, 10, 8, 5],
    [5, 3, 2, 3, 2, 2, 2, 2, 4, 6, 10, 8, 12, 19, 13, 9],
  ][seasonOf(days)];
  // Direction changes rarely (hourly slots) so smoke/fires don't flip around.
  const dirRng = new Rng(hashSeed(seed, Math.floor(seconds / 3600), 0x817d));
  const dir = dirRng.weighted(dirWeights.map((w, i) => [i, w] as const)) * 22.5;
  return { temperature: T, humidity: H, pressure: P, windpower: W, winddirection: dir };
}

// ------------------------------------------------------------------ weather types

const fahrenheitToC = (f: number) => ((f - 32) * 5) / 9;

/** Magnus-formula dew point spread used by CDDA's dew_point_factor (°C above dew point). */
function dewPointFactor(tempC: number, humidity: number): number {
  const a = 17.27, b = 237.7;
  const g = (a * tempC) / (b + tempC) + Math.log(Math.max(1, humidity) / 100);
  const dew = (b * g) / (a - g);
  return tempC - dew;
}

type Cond = unknown;

/** Evaluate the subset of CDDA dialogue conditions weather_type JSON uses. Unknown → false. */
export function evalWeatherCondition(c: Cond, w: WeatherPoint, day: boolean): boolean {
  if (c === undefined || c === null) return true;
  if (c === 'is_day') return day;
  if (typeof c === 'string') return false;
  if (typeof c !== 'object') return false;
  const o = c as Record<string, unknown>;
  if (Array.isArray(o.and)) return o.and.every((x) => evalWeatherCondition(x, w, day));
  if (Array.isArray(o.or)) return o.or.some((x) => evalWeatherCondition(x, w, day));
  if ('not' in o) return !evalWeatherCondition(o.not, w, day);
  if (Array.isArray(o.math)) return evalMath(o.math.join(' '), w);
  return false;
}

function evalMath(expr: string, w: WeatherPoint): boolean {
  // e.g. "weather('humidity') >= 98", "weather('temperature') < from_fahrenheit( 33 )",
  //      "dew_point_factor(celsius(weather('temperature'))) <= 2.5"
  const m = /^(.*?)\s*(>=|<=|==|!=|<|>)\s*(.*)$/.exec(expr.trim());
  if (!m) return false;
  const lhs = evalTerm(m[1], w), rhs = evalTerm(m[3], w);
  if (lhs === null || rhs === null) return false;
  switch (m[2]) {
    case '>=': return lhs >= rhs;
    case '<=': return lhs <= rhs;
    case '<': return lhs < rhs;
    case '>': return lhs > rhs;
    case '==': return lhs === rhs;
    default: return lhs !== rhs;
  }
}

function evalTerm(t: string, w: WeatherPoint): number | null {
  t = t.trim();
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  let m = /^weather\('(\w+)'\)$/.exec(t);
  if (m) {
    switch (m[1]) {
      case 'humidity': return w.humidity;
      case 'pressure': return w.pressure;
      case 'temperature': return w.temperature;
      case 'windpower': return w.windpower;
      default: return null;
    }
  }
  m = /^from_fahrenheit\(\s*(-?[\d.]+)\s*\)$/.exec(t);
  if (m) return fahrenheitToC(Number(m[1]));
  if (/^dew_point_factor\(/.test(t)) return dewPointFactor(w.temperature, w.humidity);
  return null;
}

interface WeatherTypeDef {
  id: string;
  name?: string;
  color?: string;
  priority?: number;
  required_weathers?: string[];
  condition?: unknown;
  precip?: string;
  rains?: boolean;
  light_modifier?: number;
  sound_attn?: number;
  sight_penalty?: number;
}

const sortedCache = new WeakMap<GameData, WeatherTypeDef[]>();
function sortedTypes(data: GameData): WeatherTypeDef[] {
  let s = sortedCache.get(data);
  if (!s) {
    s = Object.values((data.misc.weather_type ?? {}) as Record<string, WeatherTypeDef>).sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
    sortedCache.set(data, s);
  }
  return s;
}

/** weather_generator::get_weather_conditions: last matching type in priority order. */
export function weatherConditions(data: GameData, w: WeatherPoint, day: boolean): string {
  let current = 'clear';
  for (const t of sortedTypes(data)) {
    const req = t.required_weathers ?? [];
    if (req.length && !req.includes(current)) continue;
    if (evalWeatherCondition(t.condition, w, day)) current = t.id;
  }
  return current;
}

export function makeWeatherState(data: GameData, id: string, w: WeatherPoint, forced: string | null = null): WeatherState {
  const t = (data.misc.weather_type?.[id] ?? {}) as WeatherTypeDef;
  return {
    ...w, id, forced,
    name: t.name ?? (id === 'clear' ? 'Clear' : id),
    color: t.color ?? 'light_cyan',
    precip: (t.precip as WeatherState['precip']) ?? 'none',
    rains: !!t.rains,
    lightModifier: t.light_modifier ?? 0,
    soundAttn: t.sound_attn ?? 0,
    sightPenalty: t.sight_penalty ?? 1,
  };
}

/** Renderer precipitation for a CDDA weather id. */
export function renderWeatherKind(id: string): 'clear' | 'rain' | 'storm' | 'snow' {
  if (/snow|flurries/.test(id)) return 'snow';
  if (/thunder|lightning|rainstorm/.test(id)) return 'storm';
  if (/rain|drizzle/.test(id)) return 'rain';
  return 'clear';
}

/** Short aliases accepted by cdda.setWeather (renderer names) → CDDA ids. */
const ALIASES: Record<string, string> = { storm: 'thunder', snow: 'snowing' };

// ------------------------------------------------------------------ system

export interface WeatherHooks {
  /** Renderer: rain/snow particles and sky cloudiness. */
  setRenderWeather?: (kind: 'clear' | 'rain' | 'storm' | 'snow') => void;
}

interface WState {
  forced: string | null;
  lastSlot: number;
  thunderAcc: number;
  rng: Rng;
  hooks: WeatherHooks;
}
const wstates = new WeakMap<Game, WState>();

/** Recompute game.weather for the current time (every 5 game minutes, or when forced). */
export function refreshWeather(game: Game): WeatherState {
  const st = wstates.get(game);
  const forced = st?.forced ?? null;
  const w = weatherPoint(game.seed, game.clock.seconds);
  const id = forced ?? weatherConditions(game.data, w, isDay(game.clock));
  const prev = game.weather?.id;
  game.weather = makeWeatherState(game.data, id, w, forced);
  if (prev !== id) onWeatherChanged(game, prev);
  return game.weather;
}

function onWeatherChanged(game: Game, prev: string | undefined): void {
  const w = game.weather!;
  wstates.get(game)?.hooks.setRenderWeather?.(renderWeatherKind(w.id));
  (globalThis as any).cdda?.audio?.setWeather?.(w.id);
  // CDDA announces the change ("The weather changed to Rain!") when you're outside.
  if (prev !== undefined) {
    const p = game.player;
    if (isOutside(game.map, p.tileX, p.tileY, p.z)) game.message(`The weather changed to ${w.name}!`, 'c_light_cyan');
  }
}

/** Force a weather id (CDDA weather_type or clear/rain/storm/snow); null returns to generated. */
export function forceWeather(game: Game, id: string | null): WeatherState {
  const st = wstates.get(game);
  if (!st) throw new Error('installWeather() not called');
  const real = id === null ? null : (ALIASES[id] ?? id);
  if (real !== null && real !== 'clear' && !game.data.misc.weather_type?.[real]) throw new Error(`unknown weather type ${id}`);
  st.forced = real;
  return refreshWeather(game);
}

/** Air temperature at the player (°C): outdoors = weather; indoors a bit warmer; underground stable. */
export function temperatureAt(game: Game, x: number, y: number, z: number): number {
  const w = game.weather;
  const T = w?.temperature ?? 15;
  if (z < 0) return DEFAULT_WEATHER_GEN.base_temperature;
  if (!isOutside(game.map, x, y, z)) return T + 3;
  return T;
}

export function installWeather(game: Game, hooks: WeatherHooks = {}): void {
  const st: WState = { forced: null, lastSlot: -1, thunderAcc: 0, rng: new Rng(game.seed ^ 0x7ea7), hooks };
  wstates.set(game, st);
  refreshWeather(game);
  hooks.setRenderWeather?.(renderWeatherKind(game.weather!.id));
  game.systems.push({
    name: 'weather',
    update(g, _realDt, gameDt) {
      const slot = Math.floor(g.clock.seconds / 300);
      if (slot !== st.lastSlot) {
        st.lastSlot = slot;
        refreshWeather(g);
      }
      const w = g.weather!;
      const p = g.player;
      const outside = isOutside(g.map, p.tileX, p.tileY, p.z);
      p.env.temperature = temperatureAt(g, p.tileX, p.tileY, p.z);
      p.env.wind = outside ? w.windpower * 1.609 : 0;
      p.env.precipitation = outside && w.rains && w.precip !== 'none';
      // Thunder: a rumble roughly every few game minutes in thunderstorms.
      if (w.id === 'thunder' || w.id === 'lightning') {
        st.thunderAcc += gameDt;
        while (st.thunderAcc >= 60) {
          st.thunderAcc -= 60;
          if (!st.rng.oneIn(w.id === 'lightning' ? 3 : 6)) continue;
          const loud = w.id === 'lightning' && st.rng.oneIn(3);
          if (!p.isAsleep()) {
            if (loud) g.message('A flash of lightning illuminates your surroundings!', 'c_yellow');
            else g.message('You hear a distant rumble of thunder.', 'c_light_gray');
          }
          const a = st.rng.next() * Math.PI * 2, d = loud ? 8 : 40;
          emitSound(g, { x: p.x + Math.cos(a) * d, y: p.y + Math.sin(a) * d, z: Math.max(0, p.z) }, loud ? 100 : 50,
            loud ? 'a crash of thunder!' : 'a rumble of thunder', { category: 'weather', ambient: true });
        }
      } else st.thunderAcc = 0;
    },
  });
}
