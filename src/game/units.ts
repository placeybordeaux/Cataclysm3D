// Tolerant readers for CDDA quantities. The extractor normalizes most fields to numbers
// (ml, g, seconds), but a few nested structures (effect_type durations, pocket_data) may
// still arrive as CDDA strings like "30 m" or "1250 ml", so game code reads them through
// these helpers instead of assuming either form.

const DURATION_UNITS: Record<string, number> = {
  turns: 1, turn: 1, t: 1,
  seconds: 1, second: 1, s: 1,
  minutes: 60, minute: 60, m: 60,
  hours: 3600, hour: 3600, h: 3600,
  days: 86400, day: 86400, d: 86400,
};

/** Seconds from a number (already seconds/turns) or a CDDA duration string ("1 h 30 m"). */
export function toSeconds(v: unknown, fallback = 0): number {
  if (v === undefined || v === null) return fallback;
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') throw new Error(`Bad CDDA duration: ${JSON.stringify(v)}`);
  let total = 0;
  const re = /(-?\d+(?:\.\d+)?)\s*([a-z]+)?/gi;
  let m: RegExpExecArray | null;
  let matched = false;
  while ((m = re.exec(v))) {
    const unit = (m[2] ?? 'turns').toLowerCase();
    const mul = DURATION_UNITS[unit];
    if (mul === undefined) throw new Error(`Unknown duration unit "${unit}" in "${v}"`);
    total += parseFloat(m[1]) * mul;
    matched = true;
  }
  if (!matched) throw new Error(`Bad CDDA duration: "${v}"`);
  return total;
}

const VOLUME_UNITS: Record<string, number> = { ml: 1, l: 1000, L: 1000 };
const MASS_UNITS: Record<string, number> = { mg: 0.001, g: 1, kg: 1000 };

function parseUnit(v: unknown, units: Record<string, number>, what: string): number {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') throw new Error(`Bad CDDA ${what}: ${JSON.stringify(v)}`);
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*([a-zA-Z]+)\s*$/.exec(v);
  if (!m || units[m[2]] === undefined) throw new Error(`Bad CDDA ${what}: "${v}"`);
  return parseFloat(m[1]) * units[m[2]];
}

/** ml from number or "250 ml" / "2 L". */
export function toMl(v: unknown, fallback = 0): number {
  return v === undefined || v === null ? fallback : parseUnit(v, VOLUME_UNITS, 'volume');
}

/** grams from number or "600 g" / "30 kg". */
export function toGrams(v: unknown, fallback = 0): number {
  return v === undefined || v === null ? fallback : parseUnit(v, MASS_UNITS, 'mass');
}

/** CDDA translation objects ({str, str_pl, str_sp}) or plain strings -> display string. */
export function cddaText(v: unknown, plural = false): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    const o = v as { str?: string; str_sp?: string; str_pl?: string };
    if (o.str_sp !== undefined) return o.str_sp;
    if (plural) return o.str_pl ?? (o.str !== undefined ? o.str + 's' : '');
    return o.str ?? '';
  }
  return String(v);
}
