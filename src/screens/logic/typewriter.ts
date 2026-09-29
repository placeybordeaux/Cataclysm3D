// Typewriter reveal for NPC lines (pure, unit-tested). A line appears a character at a time
// with short pauses after punctuation, so speech has a rhythm; any key or click completes it.
// The schedule is computed once per line; the DOM side only asks "how many characters by now?".

export type TextSpeed = 'instant' | 'fast' | 'normal' | 'slow';

/** Characters per second for each speed setting (instant = no reveal). */
export const TEXT_SPEED_CPS: Record<TextSpeed, number> = { instant: Infinity, fast: 110, normal: 55, slow: 30 };

/** Extra pause after a character, ms (sentence ends breathe longer than commas). */
function pauseAfter(ch: string, next: string | undefined): number {
  // "Mr. Smith" or "3.5" shouldn't stop: only pause when whitespace or the end follows.
  if (next !== undefined && !/\s/.test(next)) return 0;
  if (ch === '.' || ch === '!' || ch === '?' || ch === '…') return 220;
  if (ch === ',' || ch === ';' || ch === ':' || ch === '—') return 90;
  return 0;
}

/**
 * Cumulative time (ms) at which each character becomes visible: `at[i]` is when character i
 * shows. Throws on a non-positive speed rather than looping forever.
 */
export function revealSchedule(text: string, cps: number): number[] {
  if (!(cps > 0)) throw new Error(`revealSchedule: bad speed ${cps}`);
  const at: number[] = new Array(text.length);
  if (cps === Infinity) return at.fill(0);
  const step = 1000 / cps;
  let t = 0;
  for (let i = 0; i < text.length; i++) {
    at[i] = t;
    // Whitespace costs nothing: a run of spaces shouldn't read as a stall.
    if (!/\s/.test(text[i])) t += step;
    t += pauseAfter(text[i], text[i + 1]);
  }
  return at;
}

/** How many characters are visible `elapsed` ms into the reveal. */
export function visibleCount(schedule: readonly number[], elapsed: number): number {
  // Binary search: the first character whose time is still in the future.
  let lo = 0, hi = schedule.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (schedule[mid] <= elapsed) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Total reveal time, ms. */
export function revealDuration(schedule: readonly number[]): number {
  return schedule.length ? schedule[schedule.length - 1] : 0;
}
