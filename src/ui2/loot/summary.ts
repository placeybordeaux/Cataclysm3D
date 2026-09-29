import type { TakeAllResult } from '../bn/model';

/** "Took 3 pipes, a rock and 2 more. 1 left behind:" — the first line of a take's report. */
export function summaryTitle(r: TakeAllResult): string {
  const n = r.taken.reduce((a, t) => a + t.count, 0);
  if (!n) return r.left.length ? 'Nothing fit.' : 'Nothing to take.';
  const names = r.taken.map((t) => (t.count > 1 ? `${t.count} ${t.name}` : t.name));
  const list = names.length <= 4 ? names.join(', ') : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
  return `Took ${list}.${r.left.length ? ` ${r.left.length} left behind:` : ''}`;
}

/** One line for the crosshair panel: "Took 5 things · left: stepladder (too heavy)". */
export function shortSummary(r: TakeAllResult): string {
  const n = r.taken.reduce((a, t) => a + t.count, 0);
  const took = n ? (r.taken.length === 1 ? `Took ${r.taken[0].count > 1 ? `${r.taken[0].count} ` : ''}${r.taken[0].name}` : `Took ${r.taken.length} kinds of things`) : r.left.length ? 'Nothing fit' : 'Nothing to take';
  if (!r.left.length) return `${took}.`;
  const l = r.left[0];
  return `${took} · left ${l.name}${r.left.length > 1 ? ` +${r.left.length - 1}` : ''}: ${l.reason}`;
}
