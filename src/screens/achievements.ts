import type { Game } from '../game/game';
import type { AchievementDef } from '../game/achievements';
import type { AchievementsHandle } from '../achievements';
import { h, iconEl, openPanel, tabs, toast, type Panel } from '../ui2';
import { progressRow } from '../progression/newgame';
import { durationText } from '../ui/format';

// BN scores_ui (`)`), in the look of the Survival Journal (src/progression/journal.ts): tabs
// Achievements / Conducts / Scores / Kills, each achievement an entry card (green edge when
// done, grey while locked, red when failed) with its requirements as progress bars; unlocks
// arrive as ui2 achievement toasts. Colours follow achievement.cpp color_from_completion in
// spirit: completed good, failed bad, conducts kept good.

type Tab = 'achievements' | 'conducts' | 'scores' | 'kills';
let lastTab: Tab = 'achievements';

/** "3/10 zombies killed" → 0.3 for the progress bar (requirement lines carry no numbers). */
function fractionOf(text: string): { fraction?: number; count?: string } {
  const m = /^(\d+)\/(\d+)\b/.exec(text);
  if (!m) return {};
  const v = Number(m[1]), t = Number(m[2]);
  return { fraction: t > 0 ? Math.min(1, v / t) : 1, count: `${v}/${t}` };
}

/** One achievement as a journal entry card (achievement_tracker::ui_text). */
export function achievementCard(game: Game, ah: AchievementsHandle, a: AchievementDef): HTMLElement {
  const t = ah.tracker;
  const comp = t.completion(a.id);
  const cls = comp === 'completed' ? 'got' : comp === 'failed' ? 'failed' : a.conduct ? 'kept' : 'locked';
  const box = h('div', { class: `pg-entry ix-ach ${cls}`, data: { ach: a.id } },
    h('div', { class: 'pg-entry-title', text: `${a.name}${comp === 'completed' ? '  ✓' : comp === 'failed' ? '  ✗' : ''}` }),
    a.description ? h('div', { class: 'pg-entry-body', text: a.description }) : null);
  const meta = (s: string) => box.append(h('div', { class: 'pg-entry-meta', text: s }));
  const st = t.status.get(a.id);
  if (comp === 'completed' && st) meta(`Completed ${durationText(Math.max(0, st.time - t.startSeconds()))} into the game.`);
  else if (comp === 'failed') meta(st ? `Failed ${durationText(Math.max(0, st.time - t.startSeconds()))} into the game.` : 'Failed (time ran out).');
  else {
    const past = ah.global.get(a.id);
    if (past) meta(`Previously completed by ${past.avatars[0]}${past.avatars.length > 1 ? ` and ${past.avatars.length - 1} other${past.avatars.length > 2 ? 's' : ''}` : ''}.`);
    const tc = a.time_constraint;
    if (tc) {
      const tcomp = t.timeCompletion(a);
      const from = tc.since === 'game_start' ? 'start of game' : 'time of cataclysm';
      meta(tcomp === 'pending' ? `At least ${tc.target} from ${from}.` : tc.is === '<=' ? `Within ${tc.target} of ${from}.` : `At least ${tc.target} from ${from} (passed).`);
    }
  }
  for (const r of t.requirementLines(a)) {
    if (!r || !r.text) continue;
    const f = fractionOf(r.text);
    box.append(progressRow(r.text.replace(/^\d+\/\d+\s*/, ''), r.done, f.fraction, f.count));
  }
  if (!t.achievementSupported(a)) meta('Not tracked by this port yet.');
  return box;
}

export function openAchievements(game: Game, ah: AchievementsHandle): Panel {
  const t = ah.tracker;
  const all = (conducts: boolean) => Object.values(ah.data.achievements).filter((a) => !!a.conduct === conducts && !a.manually_given);
  const done = (conducts: boolean) => all(conducts).filter((a) => t.completion(a.id) === (conducts ? 'pending' : 'completed')).length;
  const panel = openPanel({
    id: 'achievements',
    title: 'Achievements',
    width: 'min(calc(var(--fs) * 46), 94vw)',
    height: 'min(84vh, calc(var(--fs) * 36))',
    pauses: true,
    footer: `←→ tabs · ↑↓ scroll · ${game.keys.keyFor('achievements')} / Esc close`,
    onKey: (e) => {
      if (e.key === game.keys.keyFor('achievements') && !e.repeat) return panel.close(), true;
      const order: Tab[] = ['achievements', 'conducts', 'scores', 'kills'];
      const i = order.indexOf(tb.active as Tab);
      if (e.key === 'ArrowRight' || e.key === 'Tab') return tb.set(order[(i + 1) % order.length]), true;
      if (e.key === 'ArrowLeft') return tb.set(order[(i + order.length - 1) % order.length]), true;
      if (e.key === 'ArrowDown' || e.key === 'PageDown') return (list.scrollTop += e.key === 'PageDown' ? list.clientHeight : 40), true;
      if (e.key === 'ArrowUp' || e.key === 'PageUp') return (list.scrollTop -= e.key === 'PageUp' ? list.clientHeight : 40), true;
      return false;
    },
  });
  const kills = Object.values(game.stats.kills).reduce((n, k) => n + k, 0);
  const tb = tabs(
    [
      { id: 'achievements', label: 'Achievements', badge: `${done(false)}/${all(false).length}` },
      { id: 'conducts', label: 'Conducts', badge: `${done(true)}/${all(true).length}` },
      { id: 'scores', label: 'Scores' },
      { id: 'kills', label: 'Kills', badge: kills ? String(kills) : undefined },
    ],
    lastTab,
    (id) => {
      lastTab = id as Tab;
      draw();
    },
  );
  const head = h('div', { class: 'pg-entry-meta' });
  const list = h('div', { class: 'pg-jlist', attrs: { 'data-testid': 'achievements-list' } });
  panel.body.append(h('div', { class: 'pg-journal' }, head, tb.el, list));

  function draw(): void {
    const tab = tb.active as Tab;
    const out: HTMLElement[] = [];
    if (tab === 'achievements' || tab === 'conducts') {
      const conducts = tab === 'conducts';
      const visible = all(conducts).filter((a) => !t.isHidden(a));
      const order = { completed: 0, pending: 1, failed: 2 } as const;
      const tracked = visible.filter((a) => t.achievementSupported(a)).sort((a, b) => order[t.completion(a.id)] - order[t.completion(b.id)] || a.name.localeCompare(b.name));
      const untracked = visible.filter((a) => !t.achievementSupported(a));
      head.textContent = conducts
        ? `${done(true)} of ${all(true).length} conducts still kept. A conduct is a promise you keep all game.`
        : `${done(false)} of ${all(false).length} completed · ${all(false).length - visible.length} hidden until you get close. Completed ones count toward unlocks in the Journal.`;
      const groups: [string, AchievementDef[]][] = conducts
        ? [['Kept', tracked.filter((a) => t.completion(a.id) !== 'failed')], ['Broken', tracked.filter((a) => t.completion(a.id) === 'failed')]]
        : [['Completed', tracked.filter((a) => t.completion(a.id) === 'completed')], ['In progress', tracked.filter((a) => t.completion(a.id) === 'pending')], ['Failed', tracked.filter((a) => t.completion(a.id) === 'failed')]];
      for (const [name, list] of groups) {
        if (!list.length) continue;
        out.push(h('div', { class: 'ui2-section', text: `${name} (${list.length})` }));
        for (const a of list) out.push(achievementCard(game, ah, a));
      }
      if (untracked.length) {
        out.push(h('div', { class: 'ui2-section', text: `Not tracked by this port yet (${untracked.length})` }));
        out.push(h('div', { class: 'pg-entry-meta', text: untracked.map((a) => a.name).join(' · ') }));
      }
    } else if (tab === 'scores') {
      head.textContent = 'This character\'s record.';
      const rows: HTMLElement[] = [];
      for (const s of Object.values(ah.data.scores)) {
        if (!t.statSupported(s.statistic)) continue;
        const v = t.value(s.statistic);
        const d = ah.data.statistics[s.statistic]?.description;
        const desc = s.description ?? (v === 1 ? d?.one : d?.many ?? d?.one) ?? s.statistic;
        rows.push(h('span', { text: desc }), h('span', { text: String(v) }));
      }
      out.push(rows.length ? h('div', { class: 'pg-stat-grid' }, ...rows) : h('div', { class: 'ui2-empty', text: 'No scores yet.' }));
    } else {
      const rows = Object.entries(game.stats.kills).sort((a, b) => b[1] - a[1]);
      head.textContent = rows.length ? `Total kills: ${kills}` : '';
      if (!rows.length) out.push(h('div', { class: 'ui2-empty', text: "You haven't killed any monsters yet!" }));
      else
        out.push(h('div', { class: 'ix-kills' }, ...rows.map(([id, n]) => {
          const m = game.data.monsters[id];
          return h('div', { class: 'ix-kill' }, iconEl({ typeId: id, symbol: m?.symbol ?? '?', color: (m?.color ?? 'white').replace(/^c_/, '') }, 'row'), h('span', { text: m?.name ?? id }), h('span', { class: 'tone-accent', text: String(n) }));
        })));
    }
    list.replaceChildren(...out);
    list.scrollTop = 0;
  }
  draw();
  return panel;
}

/**
 * BN shows a popup on completion; ours is a ui2 achievement toast so real-time play continues
 * (ui2 rate-limits and folds bursts, e.g. several skill levels at once).
 */
export function showAchievementToast(a: AchievementDef): void {
  if (typeof document === 'undefined') return;
  toast({ category: 'achievement', title: a.name, body: a.description || 'Achievement completed', key: `ach:${a.id}` });
}
