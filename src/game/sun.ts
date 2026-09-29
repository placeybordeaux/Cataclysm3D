import { DAYS_PER_SEASON, SECONDS_PER_DAY } from '../core/time';

// The sun's position and the length of the day, after CDDA calendar.cpp
// (sun_ra_declination / sun_azimuth_altitude / sunrise / sunset), shared by the renderer
// (sky, sun light direction), vision (natural light level) and anything that asks "is it
// daytime". One implementation so the sky and the game never disagree about sunset.
//
// CDDA's calendar puts the vernal equinox on spring day 1 and uses local solar time (noon
// is 12:00 every day), with a year of 4 × season length days. Location: Boston.

export type Season = 'spring' | 'summer' | 'autumn' | 'winter';
export const SEASONS: readonly Season[] = ['spring', 'summer', 'autumn', 'winter'];

/** CDDA's default location (location_boston). */
export const LATITUDE = 42.36;
export const YEAR_DAYS = DAYS_PER_SEASON * 4;
/** calendar.cpp sunrise_angle: the sun counts as up above -1°. */
export const SUNRISE_ANGLE = -1;
export const CIVIL_DAWN = -6;

const R = Math.PI / 180;

/** Season at game time `seconds` (CDDA season_of_year). */
export function seasonAt(seconds: number): Season {
  const day = Math.floor(seconds / SECONDS_PER_DAY);
  return SEASONS[(((Math.floor(day / DAYS_PER_SEASON) % 4) + 4) % 4)];
}

/** Solar declination in degrees `days` (fractional) after spring day 1 (sun_ra_declination). */
export function solarDeclination(days: number): number {
  const perDay = 360 / YEAR_DAYS;
  const meanLong = perDay * days;
  const meanAnomaly = 77 + meanLong;
  const ecl = meanLong + 1.915 * Math.sin(meanAnomaly * R) + 0.02 * Math.sin(2 * meanAnomaly * R);
  const obliquity = 23.439279;
  return Math.asin(Math.sin(ecl * R) * Math.sin(obliquity * R)) / R;
}

export interface SunPosition {
  /** degrees above the horizon (negative = below) */
  altitude: number;
  /** degrees, CDDA convention: from the south, positive toward the west */
  azimuth: number;
}

/** sun_azimuth_altitude at game time `seconds` (local solar time: noon = 12:00). */
export function sunPosition(seconds: number): SunPosition {
  const days = seconds / SECONDS_PER_DAY;
  const decl = solarDeclination(days) * R;
  const hour = (((seconds % SECONDS_PER_DAY) + SECONDS_PER_DAY) % SECONDS_PER_DAY) / 3600;
  const ha = (hour - 12) * 15 * R;
  const lat = LATITUDE * R;
  // equatorial -> horizontal (the same two-step rotation CDDA uses)
  const ix = Math.cos(ha) * Math.cos(decl), iy = Math.sin(ha) * Math.cos(decl), iz = Math.sin(decl);
  const hx = -ix * Math.sin(lat) + iz * Math.cos(lat);
  const hz = ix * Math.cos(lat) + iz * Math.sin(lat);
  const altitude = Math.asin(Math.max(-1, Math.min(1, hz))) / R;
  // CDDA: normalize(-atan2(h.xy) + 180°); with hx pointing north, iy west... we only need
  // "from the south, positive west", which is atan2(iy, -hx).
  const azimuth = Math.atan2(iy, -hx) / R;
  return { altitude, azimuth };
}

export function sunAltitudeAt(seconds: number): number {
  return sunPosition(seconds).altitude;
}

export interface SunTimes {
  /** Hours of the day (0..24, local solar time). */
  sunrise: number;
  sunset: number;
  /** civil dawn / dusk (sun at -6°): CDDA daylight_time / night_time */
  dawn: number;
  dusk: number;
  /** Hours of daylight (sunset - sunrise). */
  dayLength: number;
}

/** Hour angle (hours from noon) at which the sun crosses `altitude` on `day`. */
function hoursFromNoon(day: number, altitude: number): number {
  const decl = solarDeclination(day + 0.5) * R;
  const lat = LATITUDE * R;
  let c = (Math.sin(altitude * R) - Math.sin(lat) * Math.sin(decl)) / (Math.cos(lat) * Math.cos(decl));
  // like CDDA: if it never reaches that angle, pretend it does at its extreme
  c = Math.max(-1, Math.min(1, c));
  return Math.acos(c) / R / 15;
}

/**
 * Sunrise/sunset (sun at -1°) and civil dawn/dusk (-6°) for game day `day` (days since
 * spring day 1), after calendar.cpp sunrise()/sunset()/daylight_time()/night_time().
 * Boston: ~06:00–18:00 at the equinoxes, ~04:20–19:40 midsummer, ~07:25–16:35 midwinter.
 */
export function sunTimes(day: number): SunTimes {
  const h = hoursFromNoon(day, SUNRISE_ANGLE);
  const c = hoursFromNoon(day, CIVIL_DAWN);
  return { sunrise: 12 - h, sunset: 12 + h, dawn: 12 - c, dusk: 12 + c, dayLength: 2 * h };
}
