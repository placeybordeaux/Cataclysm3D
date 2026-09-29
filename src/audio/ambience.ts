import type { Season } from './soundsetTypes';
import type { SoundContext } from './soundset';

// Which ambient loops should be playing, following CDDA's sfx::do_ambient (sounds.cpp).
// Pure: the engine diffs the result against what's playing and crossfades.

export type WeatherCategory =
  | 'silent' | 'clear' | 'sunny' | 'cloudy' | 'drizzle' | 'rainy' | 'rainstorm' | 'thunder'
  | 'flurries' | 'snow' | 'snowstorm' | 'portal_storm';

export interface WeatherInfo {
  category: WeatherCategory;
  /** CDDA weather_type.rains */
  rains: boolean;
  /** CDDA precip class */
  precip: 'none' | 'very_light' | 'light' | 'heavy';
}

/** CDDA data/json/weather_type.json, reduced to what audio needs. */
export const WEATHER_TYPES: Record<string, WeatherInfo> = {
  clear: { category: 'clear', rains: false, precip: 'none' },
  sunny: { category: 'sunny', rains: false, precip: 'none' },
  cloudy: { category: 'cloudy', rains: false, precip: 'none' },
  light_drizzle: { category: 'drizzle', rains: true, precip: 'very_light' },
  drizzle: { category: 'drizzle', rains: true, precip: 'light' },
  rain: { category: 'rainy', rains: true, precip: 'heavy' },
  rainstorm: { category: 'rainstorm', rains: true, precip: 'heavy' },
  thunder: { category: 'thunder', rains: true, precip: 'heavy' },
  lightning: { category: 'thunder', rains: true, precip: 'heavy' },
  flurries: { category: 'flurries', rains: false, precip: 'light' },
  snowing: { category: 'snow', rains: false, precip: 'heavy' },
  snowstorm: { category: 'snowstorm', rains: false, precip: 'heavy' },
  mist: { category: 'silent', rains: false, precip: 'none' },
  fog: { category: 'silent', rains: false, precip: 'none' },
  portal_storm: { category: 'portal_storm', rains: false, precip: 'none' },
};

export interface AmbientState {
  /** player z < 0 */
  underground: boolean;
  /** roof overhead (CDDA is_sheltered) */
  sheltered: boolean;
  night: boolean;
  season: Season;
  weather: WeatherInfo;
}

export type AmbientChannel = 'time_of_day' | 'shelter' | 'indoor_rain' | 'weather';

export interface AmbientLayer {
  channel: AmbientChannel;
  id: 'environment';
  variant: string;
  ctx: SoundContext;
}

export function ambientLayers(s: AmbientState): AmbientLayer[] {
  const ctx: SoundContext = { season: s.season, indoors: s.sheltered || s.underground, night: s.night };
  const L = (channel: AmbientChannel, variant: string): AmbientLayer => ({ channel, id: 'environment', variant, ctx });
  // Underground replaces everything else (CDDA fades the weather and time-of-day groups).
  if (s.underground) return [L('shelter', 'underground')];
  const out: AmbientLayer[] = [];
  if (s.sheltered) {
    out.push(L('shelter', 'indoors'));
    if (s.weather.rains && s.weather.precip !== 'very_light') out.push(L('indoor_rain', 'indoors_rain'));
    return out;
  }
  out.push(L('time_of_day', s.night ? 'nighttime' : 'daytime'));
  if (s.weather.category !== 'silent') out.push(L('weather', `WEATHER_${s.weather.category.toUpperCase()}`));
  return out;
}

/**
 * Approximate CDDA is_night: dark between sunset and sunrise. CDDA derives these from the
 * season and latitude; for New England this is close enough (sunrise ~5-7, sunset ~17-20).
 */
export function isNight(hourOfDay: number, season: Season): boolean {
  const [rise, set] = { spring: [6, 19.5], summer: [5.25, 20.25], autumn: [6.5, 18], winter: [7.25, 16.5] }[season];
  return hourOfDay < rise || hourOfDay >= set;
}
