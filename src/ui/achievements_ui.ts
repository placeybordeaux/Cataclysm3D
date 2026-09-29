import type { Game } from '../game/game';
import type { AchievementDef } from '../game/achievements';
import type { AchievementsHandle } from '../achievements';
import { c, colorize, getUiRoot, openWindow } from './framework';
import { durationText } from './format';

// CDDA scores_ui (`)`): tabs ACHIEVEMENTS / CONDUCTS / SCORES / KILLS, plus the small
// "achievement completed" toast. Colors follow achievement.cpp color_from_completion:
// pending white/light cyan, completed light green, failed red; conducts pending light green.

const TABS = ['ACHIEVEMENTS', 'CONDUCTS', 'SCORES', 'KILLS'] as const;

export function installAchievementsUi(game: Game, handle: () => AchievementsHandle) {
  const open = () => openAchievements(game, handle());
  game.keys.register('achievements', 'View achievements, scores, and kills', open);
  return { open, toast: (a: AchievementDef) => showToast(a) };
}

function statusColor(a: AchievementDef, comp: string, title: boolean): string {
  if (comp === 'completed') return 'c_light_green';
  if (comp === 'failed') return 'c_red';
  return a.conduct ? 'c_light_green' : title ? 'c_white' : 'c_light_cyan';
}

/** One achievement's block (achievement_tracker::ui_text). */
export function achievementText(game: Game, h: AchievementsHandle, a: AchievementDef): string {
  const t = h.tracker;
  const comp = t.completion(a.id);
  const col = statusColor(a, comp, false);
  const lines = [c(statusColor(a, comp, true), a.name)];
  if (a.description) lines.push('  ' + c(col, a.description));
  const st = t.status.get(a.id);
  if (comp === 'completed' && st) lines.push('  ' + c(col, `Completed ${durationText(Math.max(0, st.time - t.startSeconds()))} into the game`));
  else if (comp === 'failed') lines.push('  ' + c(col, st ? `Failed ${durationText(Math.max(0, st.time - t.startSeconds()))} into the game` : 'Failed (time ran out)'));
  else {
    const past = h.global.get(a.id);
    if (past) lines.push('  ' + c('c_blue', `Previously completed by ${past.avatars[0]}${past.avatars.length > 1 ? ` and ${past.avatars.length - 1} other${past.avatars.length > 2 ? 's' : ''}` : ''}`));
    const tc = a.time_constraint;
    if (tc) {
      const tcomp = t.timeCompletion(a);
      const from = tc.since === 'game_start' ? 'start of game' : 'time of cataclysm';
      const txt = tcomp === 'pending' ? `At least ${tc.target} from ${from}` : tc.is === '<=' ? `Within ${tc.target} of ${from}` : `At least ${tc.target} from ${from} (passed)`;
      lines.push('  ' + c(tcomp === 'pending' ? col : 'c_light_green', txt));
    }
  }
  for (const r of t.requirementLines(a)) if (r && r.text) lines.push('  ' + c(r.done ? 'c_green' : 'c_yellow', r.text));
  if (!t.achievementSupported(a)) lines.push('  ' + c('c_dark_gray', '(not tracked by this port yet)'));
  return lines.join('\n');
}

function listFor(game: Game, h: AchievementsHandle, conducts: boolean): string {
  const t = h.tracker;
  const all = Object.values(h.data.achievements).filter((a) => !!a.conduct === conducts && !a.manually_given);
  const visible = all.filter((a) => !t.isHidden(a));
  const order = { completed: 0, pending: 1, failed: 2 } as const;
  const tracked = visible.filter((a) => t.achievementSupported(a)).sort((a, b) => order[t.completion(a.id)] - order[t.completion(b.id)] || a.name.localeCompare(b.name));
  const untracked = visible.filter((a) => !t.achievementSupported(a));
  const done = all.filter((a) => t.completion(a.id) === (conducts ? 'pending' : 'completed')).length;
  const head = conducts
    ? c('c_light_gray', `${done} of ${all.length} conducts still kept`)
    : c('c_light_gray', `${done} of ${all.length} achievements completed`) + c('c_dark_gray', `  (${all.length - visible.length} hidden)`);
  const blocks = tracked.map((a) => achievementText(game, h, a));
  if (untracked.length) blocks.push(c('c_light_blue', '-- not tracked by this port yet --'), ...untracked.map((a) => c('c_dark_gray', a.name)));
  return [head, '', ...blocks].join('\n\n').replace(/\n\n\n\n/g, '\n\n');
}

function scoresText(h: AchievementsHandle): string {
  const t = h.tracker;
  const lines: string[] = [];
  for (const s of Object.values(h.data.scores)) {
    if (!t.statSupported(s.statistic)) continue;
    const v = t.value(s.statistic);
    const d = h.data.statistics[s.statistic]?.description;
    const desc = s.description ?? (v === 1 ? d?.one : d?.many ?? d?.one) ?? s.statistic;
    lines.push(`${c('c_white', String(v))} ${c('c_light_gray', desc)}`);
  }
  return lines.length ? lines.join('\n') : c('c_dark_gray', 'No scores yet.');
}

function killsText(game: Game): string {
  const rows = Object.entries(game.stats.kills).sort((a, b) => b[1] - a[1]);
  if (!rows.length) return c('c_dark_gray', "You haven't killed any monsters yet!");
  const total = rows.reduce((n, [, k]) => n + k, 0);
  return [
    c('c_light_gray', `Total kills: ${total}`),
    '',
    ...rows.map(([id, n]) => {
      const m = game.data.monsters[id];
      return `${colorize(`<color_${(m?.color ?? 'white').replace(/^c_/, '')}>${m?.symbol ?? '?'}</color>`)} ${c('c_white', String(n).padStart(4))} ${c('c_light_gray', m?.name ?? id)}`;
    }),
  ].join('\n');
}

export function openAchievements(game: Game, h: AchievementsHandle): void {
  let tab = 0;
  const win = openWindow({
    title: 'Scores',
    width: 'min(90ch, 94vw)',
    height: '80vh',
    footer: `${c('c_light_green', '<Tab>')} next tab  ${c('c_light_green', 'Up/Down')} scroll  ${c('c_light_green', 'Esc')} close`,
    onKey: (e) => {
      if (e.key === 'Tab' || e.key === 'ArrowRight' || e.key === 'l') tab = (tab + 1) % TABS.length;
      else if (e.key === 'ArrowLeft' || e.key === 'h') tab = (tab + TABS.length - 1) % TABS.length;
      else if (e.key === 'ArrowDown' || e.key === 'j') return void (win.body.scrollTop += 24), true;
      else if (e.key === 'ArrowUp' || e.key === 'k') return void (win.body.scrollTop -= 24), true;
      else if (e.key === 'PageDown') return void (win.body.scrollTop += win.body.clientHeight - 24), true;
      else if (e.key === 'PageUp') return void (win.body.scrollTop -= win.body.clientHeight - 24), true;
      else return false;
      render();
      return true;
    },
  });
  win.el.classList.add('achievements-window');
  const render = () => {
    const tabs = TABS.map((t, i) => (i === tab ? c('c_white', `[${t}]`) : c('c_dark_gray', ` ${t} `))).join(' ');
    const body = tab === 0 ? listFor(game, h, false) : tab === 1 ? listFor(game, h, true) : tab === 2 ? scoresText(h) : killsText(game);
    win.body.innerHTML = `${tabs}\n\n${body}`;
    win.body.scrollTop = 0;
  };
  render();
}

/**
 * CDDA shows a popup on completion; ours is a non-blocking toast so real-time play continues.
 * Toasts queue and show one at a time (with a "+N more" hint), so a burst of completions
 * (a debug kill-all, several skill levels at once) doesn't pile up over open windows.
 */
const toastQueue: AchievementDef[] = [];
let toastBusy = false;
function showToast(a: AchievementDef): void {
  if (typeof document === 'undefined') return;
  toastQueue.push(a);
  if (!toastBusy) nextToast();
}

function nextToast(): void {
  const a = toastQueue.shift();
  if (!a) {
    toastBusy = false;
    return;
  }
  toastBusy = true;
  const root = getUiRoot();
  let host = root.querySelector('.achievement-toasts') as HTMLElement | null;
  if (!host) {
    host = document.createElement('div');
    host.className = 'achievement-toasts';
    Object.assign(host.style, { position: 'absolute', top: '2vh', left: '50%', transform: 'translateX(-50%)', display: 'flex', flexDirection: 'column', gap: '6px', pointerEvents: 'none', zIndex: '50' });
    root.appendChild(host);
  }
  const el = document.createElement('div');
  Object.assign(el.style, { background: '#000', border: '1px solid var(--c-light_green)', padding: '4px 12px', whiteSpace: 'pre', textAlign: 'center', opacity: '0', transition: 'opacity 0.4s' });
  const more = toastQueue.length ? `\n${c('c_dark_gray', `(+${toastQueue.length} more)`)}` : '';
  el.innerHTML = `${c('c_yellow', 'Achievement completed!')}\n${c('c_light_green', a.name)}${a.description ? `\n${c('c_light_gray', a.description)}` : ''}${more}`;
  host.appendChild(el);
  requestAnimationFrame(() => (el.style.opacity = '1'));
  const hold = toastQueue.length ? 2500 : 5000;
  setTimeout(() => (el.style.opacity = '0'), hold);
  setTimeout(() => {
    el.remove();
    nextToast();
  }, hold + 400);
}
