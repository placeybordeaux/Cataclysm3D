// Pure formatting helpers shared by the HUD and screens (unit-tested, no DOM). Colors and
// wording follow CDDA's display.cpp / output.cpp so the sidebar reads like the original.

export interface Colored {
  text: string;
  color: string;
}

const HP_COLORS = ['c_green', 'c_light_green', 'c_yellow', 'c_light_red', 'c_red'];
const STAMINA_COLORS = ['c_cyan', 'c_light_cyan', 'c_yellow', 'c_light_red', 'c_red'];

/** output.cpp get_bar: '|' per 1/width, '\' for an extra half, ':' when nearly empty. */
export function bar(cur: number, max: number, width = 5, extraResolution = true, colors = HP_COLORS): Colored {
  const status = Math.max(0, Math.min(1, cur / max));
  const sw = status * width;
  let color = 'c_red';
  if (Number.isFinite(status)) {
    const ind = Math.max(0, Math.min(colors.length - 1, Math.floor((1 - status) * (colors.length - 1) + 0.5)));
    color = colors[ind];
  }
  let text = '';
  if (Number.isFinite(sw) && sw > 0) {
    const pipes = Math.floor(sw);
    text = '|'.repeat(pipes);
    if (extraResolution && sw - pipes >= 0.5) text += '\\';
    else if (pipes === 0) text = ':';
  }
  return { text, color };
}

/** output.cpp get_hp_bar: 0 HP (a broken limb) shows "-----". */
export function hpBar(cur: number, max: number): Colored {
  if (cur <= 0) return { text: '-----', color: 'c_light_gray' };
  return bar(cur, max, 5, true, HP_COLORS);
}

export function staminaBar(cur: number, max: number): Colored {
  if (cur <= 0) return { text: '-----', color: 'c_light_gray' };
  return bar(cur, max, 5, true, STAMINA_COLORS);
}

/** Character::get_hunger_description colours (BN). */
export function hungerColor(state: string): string {
  return (
    ({
      Engorged: 'c_pink', Sated: 'c_green', Hungry: 'c_yellow', 'Very Hungry': 'c_yellow', Famished: 'c_light_red', Starving: 'c_red',
    } as Record<string, string>)[state] ?? 'c_white'
  );
}

/** Character::get_thirst_description colours (BN). */
export function thirstColor(desc: string): string {
  if (desc === 'Parched' || desc === 'Dehydrated') return 'c_light_red';
  if (desc === 'Very Thirsty' || desc === 'Thirsty') return 'c_yellow';
  if (desc === 'Turgid' || desc === 'Hydrated') return 'c_green';
  return 'c_white';
}

/** display::sleepiness_text_color */
export function sleepinessColor(desc: string): string {
  return desc === 'Exhausted' ? 'c_red' : desc === 'Dead Tired' ? 'c_light_red' : desc === 'Tired' ? 'c_yellow' : 'c_white';
}

/** display::temp_text_color */
export function tempColor(desc: string): string {
  return (
    ({
      'Scorching!': 'c_red', 'Very hot!': 'c_light_red', Warm: 'c_yellow', Comfortable: 'c_green',
      Chilly: 'c_light_blue', 'Very cold!': 'c_cyan', 'Freezing!': 'c_blue',
    } as Record<string, string>)[desc] ?? 'c_yellow'
  );
}

/** display::pain_text_color (Character version: >=60 red, >=40 light red, else yellow). */
export function painColor(perceived: number): string {
  if (perceived <= 0) return 'c_white';
  if (perceived >= 60) return 'c_red';
  if (perceived >= 40) return 'c_light_red';
  return 'c_yellow';
}

export interface MoodFace {
  value: number;
  face: string;
}
/** CDDA's DEFAULT mood_face table (data/json/mood_faces.json), used if ui.json lacks it. */
export const DEFAULT_MOOD_FACES: MoodFace[] = [
  { value: 100, face: '<color_green>8D</color>' },
  { value: 50, face: '<color_green>:D</color>' },
  { value: 10, face: '<color_green>:)</color>' },
  { value: -10, face: '<color_white>:|</color>' },
  { value: -50, face: '<color_red>):</color>' },
  { value: -100, face: '<color_red>D:</color>' },
  { value: -200, face: '<color_red>D8</color>' },
];

/** display::morale_emotion: first face whose value <= morale, else the last one. CDDA-tagged. */
export function moraleFace(morale: number, faces: MoodFace[] = DEFAULT_MOOD_FACES): string {
  for (const f of faces) if (f.value <= morale) return f.face;
  return faces[faces.length - 1]?.face ?? ':|';
}

/** CDDA shows weight in kg with 2 decimals ("1.25"). */
export function kg(grams: number): string {
  return (grams / 1000).toFixed(2);
}
/** CDDA shows volume in L with 2 decimals ("0.75"). */
export function liters(ml: number): string {
  return (ml / 1000).toFixed(2);
}

/** "3 hours and 12 minutes" style duration (CDDA to_string for time_duration, simplified). */
export function durationText(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return h > 0 ? `${plural(d, 'day')} and ${plural(h, 'hour')}` : plural(d, 'day');
  if (h > 0) return m > 0 ? `${plural(h, 'hour')} and ${plural(m, 'minute')}` : plural(h, 'hour');
  if (m > 0) return plural(m, 'minute');
  return plural(s, 'second');
}

// ------------------------------------------------------------------ message log

export interface LogEntry {
  text: string;
  color?: string;
  count: number;
  /** real-time ms of the latest occurrence (for fading) */
  time: number;
  /** game clock seconds of first occurrence (for the full log's timestamps) */
  gameTime: number;
}

/** CDDA Messages: identical consecutive messages collapse into one with a "x2" counter. */
export class MessageLog {
  readonly entries: LogEntry[] = [];
  constructor(readonly capacity = 256) {}
  add(text: string, color: string | undefined, now: number, gameTime = 0): LogEntry {
    const last = this.entries[this.entries.length - 1];
    if (last && last.text === text && last.color === color) {
      last.count++;
      last.time = now;
      return last;
    }
    const e: LogEntry = { text, color, count: 1, time: now, gameTime };
    this.entries.push(e);
    if (this.entries.length > this.capacity) this.entries.shift();
    return e;
  }
  recent(n: number): LogEntry[] {
    return this.entries.slice(-n);
  }
}

export function logLine(e: LogEntry): string {
  return e.count > 1 ? `${e.text} x${e.count}` : e.text;
}

// ------------------------------------------------------------------ names

export interface NameLists {
  male: string[];
  female: string[];
  unisex?: string[];
  family: string[];
  nick?: string[];
}

/** CDDA pick_name: "<given> <family>" with a gendered given name. rand() in [0,1). */
export function randomName(names: NameLists, male: boolean, rand: () => number = Math.random): string {
  const pick = (l: string[]) => l[Math.floor(rand() * l.length)];
  const given = male ? names.male : names.female;
  if (!given.length || !names.family.length) throw new Error('randomName: empty name lists');
  return `${pick(given)} ${pick(names.family)}`;
}

/** Pad/truncate plain text to exactly n columns (for curses-style columns). */
export function fit(s: string, n: number, align: 'left' | 'right' = 'left'): string {
  if (s.length > n) return n > 1 ? s.slice(0, n - 1) + '…' : s.slice(0, n);
  return align === 'left' ? s.padEnd(n) : s.padStart(n);
}
