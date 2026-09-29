// CDDA quantity strings ("250 ml", "1 h 30 m", "2 USD 50 cent") -> numbers in our base units.
//
// Grammar mirrors units::read_from_json_string_common (src/units.h): one or more
// `<signed int><optional spaces><unit>` pairs, summed. We additionally accept decimals
// because it costs nothing and some docs examples use them.
//
// Base units (see src/data/types.ts): ml, g, cm, game seconds, kJ, W, cents, KB, °C.

export type Dimension = 'volume' | 'mass' | 'length' | 'time' | 'energy' | 'power' | 'money' | 'memory' | 'temperature' | 'angle';

// Every unit token is unique across dimensions, which is what makes dimension inference
// from the string alone safe (e.g. "m" is minutes; CDDA spells metres "meter").
export const UNITS: Record<string, [Dimension, number]> = {
  ml: ['volume', 1],
  L: ['volume', 1000],
  mg: ['mass', 0.001],
  g: ['mass', 1],
  kg: ['mass', 1000],
  mm: ['length', 0.1],
  cm: ['length', 1],
  meter: ['length', 100],
  km: ['length', 100000],
  turns: ['time', 1],
  turn: ['time', 1],
  t: ['time', 1],
  seconds: ['time', 1],
  second: ['time', 1],
  s: ['time', 1],
  minutes: ['time', 60],
  minute: ['time', 60],
  m: ['time', 60],
  hours: ['time', 3600],
  hour: ['time', 3600],
  h: ['time', 3600],
  days: ['time', 86400],
  day: ['time', 86400],
  d: ['time', 86400],
  mJ: ['energy', 1e-6],
  J: ['energy', 0.001],
  kJ: ['energy', 1],
  mW: ['power', 0.001],
  W: ['power', 1],
  kW: ['power', 1000],
  cents: ['money', 1],
  cent: ['money', 1],
  dollars: ['money', 100],
  dollar: ['money', 100],
  USD: ['money', 100],
  kUSD: ['money', 100000],
  KB: ['memory', 1],
  MB: ['memory', 1024],
  GB: ['memory', 1024 * 1024],
  TB: ['memory', 1024 * 1024 * 1024],
  // temperature deltas; absolute kelvin is handled specially in parseQuantity
  C: ['temperature', 1],
  mC: ['temperature', 0.001],
  K: ['temperature', 1],
  arcmin: ['angle', 1 / 60],
  '°': ['angle', 1],
  rad: ['angle', 180 / Math.PI],
};

const PAIR = /([+-]?)(\d+(?:\.\d+)?)\s*([A-Za-z°]+)/y;

export interface Quantity {
  dim: Dimension;
  value: number;
  /** true if any pair had whitespace between number and unit ("250 ml" vs "9mm") */
  spaced: boolean;
}

/** Parse a CDDA quantity string. Returns null if it is not one (e.g. "9mm" parses; "2d6" does not). */
export function parseQuantity(s: string): Quantity | null {
  let i = 0;
  const skip = () => {
    while (i < s.length && s[i] === ' ') i++;
  };
  skip();
  if (i >= s.length) return null;
  let dim: Dimension | null = null;
  let value = 0;
  let spaced = false;
  let pairs = 0;
  while (i < s.length) {
    PAIR.lastIndex = i;
    const m = PAIR.exec(s);
    if (!m) return null;
    const unit = UNITS[m[3]];
    if (!unit) return null;
    if (dim && unit[0] !== dim) return null;
    dim = unit[0];
    const n = Number(m[2]) * (m[1] === '-' ? -1 : 1);
    value += n * unit[1];
    if (/\d\s+[A-Za-z°]/.test(m[0])) spaced = true;
    i = PAIR.lastIndex;
    pairs++;
    skip();
  }
  if (!dim || pairs === 0) return null;
  // Kelvin is the only absolute temperature unit CDDA accepts; convert to °C.
  if (dim === 'temperature' && /K\s*$/.test(s) && !/mC|C/.test(s)) value -= 273.15;
  return { dim, value: round(value), spaced };
}

/** Round away float noise (e.g. 0.1*3) without losing mg precision. */
export function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function expect(dim: Dimension, v: unknown, what: string): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const q = parseQuantity(v);
    if (q && q.dim === dim) return q.value;
  }
  throw new Error(`expected ${dim} quantity for ${what}, got ${JSON.stringify(v)}`);
}

export const volumeMl = (v: unknown, what = 'volume') => expect('volume', v, what);
export const massG = (v: unknown, what = 'mass') => expect('mass', v, what);
export const lengthCm = (v: unknown, what = 'length') => expect('length', v, what);
export const moneyCents = (v: unknown, what = 'money') => expect('money', v, what);
export const energyKJ = (v: unknown, what = 'energy') => expect('energy', v, what);
/** Durations: ints are CDDA turns, and 1 turn == 1 game second. */
export const durationS = (v: unknown, what = 'duration') => expect('time', v, what);
