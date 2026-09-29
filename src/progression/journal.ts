// The Survival Journal (key J, also on the title screen): what you've discovered (tips from
// discovery.ts, in the words of the toast plus more), recipes you were told about, places
// you've been, and every unlock with progress ("Police Officer: kill 10 zombies — 4/10").
// The Record tab has lifetime statistics, the progression options and export/import.

import { button, confirmModal, h, openPanel, tabs, toast, type Panel } from '../ui2';
import type { Game } from '../game/game';
import { GameClock } from '../core/time';
import { NUDGES, type NudgeDef } from './discovery';
import { progressLines } from './unlocks';
import { STAT_IDS, type StatId } from './profile';
import { statValueText } from './unlocks';
import { DIFFICULTIES } from './difficulty';
import type { ProgressionHandle } from './install';
import { progressRow } from './newgame';
import { withKeys } from './ui';

type Tab = 'tips' | 'recipes' | 'places' | 'unlocks' | 'record';

const STAT_LABEL: Record<StatId, string> = {
  runs: 'Games started', deaths: 'Deaths', kills: 'Kills', zombie_kills: 'Zombies killed', best_days: 'Longest life (days)',
  items_crafted: 'Items crafted', hp_healed: 'HP healed', corpses_butchered: 'Corpses butchered', foods_eaten: 'Things eaten or drunk',
  distance_m: 'Distance walked', towns_visited: 'Towns visited', books_read: 'Books read', labs_reached: 'Labs found', vehicles_driven: 'Vehicles driven',
};

let lastTab: Tab = 'tips';

/** Open (or focus) the journal. `inRun` = a character is alive (the title screen has none). */
export function openJournal(game: Game, prog: ProgressionHandle, inRun: boolean): Panel {
  const panel = openPanel({
    id: 'pg.journal',
    title: 'Survival Journal',
    width: 'min(calc(var(--fs) * 46), 94vw)',
    height: 'min(84vh, calc(var(--fs) * 36))',
    pauses: true,
    onKey: (e) => {
      // J closes it again, like every screen's opening key.
      if (e.key === game.keys.keyFor('journal') && !e.repeat) return panel.close(), true;
      const order: Tab[] = ['tips', 'recipes', 'places', 'unlocks', 'record'];
      const i = order.indexOf(t.active as Tab);
      if (e.key === 'ArrowRight' || e.key === 'Tab') return t.set(order[(i + 1) % order.length]), true;
      if (e.key === 'ArrowLeft') return t.set(order[(i + order.length - 1) % order.length]), true;
      if (e.key === 'ArrowDown' || e.key === 'PageDown') return (list.scrollTop += e.key === 'PageDown' ? list.clientHeight : 40), true;
      if (e.key === 'ArrowUp' || e.key === 'PageUp') return (list.scrollTop -= e.key === 'PageUp' ? list.clientHeight : 40), true;
      return false;
    },
  });
  const discovered = prog.profile.data.discovered.filter((id) => NUDGES[id]);
  const earned = prog.catalogue.unlocks.filter((u) => u.requirement.length && prog.profile.isUnlocked(u.id)).length;
  const lockable = prog.catalogue.unlocks.filter((u) => u.requirement.length).length;
  const t = tabs(
    [
      { id: 'tips', label: 'Tips', badge: `${discovered.length}/${Object.keys(NUDGES).length}` },
      { id: 'recipes', label: 'Recipes', badge: inRun && prog.run.recipes.length ? String(prog.run.recipes.length) : undefined },
      { id: 'places', label: 'Places' },
      { id: 'unlocks', label: 'Unlocks', badge: `${earned}/${lockable}` },
      { id: 'record', label: 'Record' },
    ],
    lastTab,
    (id) => {
      lastTab = id as Tab;
      draw();
    },
  );
  const head = h('div', { class: 'pg-entry-meta' });
  const list = h('div', { class: 'pg-jlist', attrs: { 'data-testid': 'journal-list' } });
  panel.body.append(h('div', { class: 'pg-journal' }, head, t.el, list));
  const p = game.player;
  if (inRun) {
    const diff = DIFFICULTIES.find((d) => d.id === prog.run.difficulty)?.name ?? prog.run.difficulty;
    head.textContent = `${p.name}${prog.run.title ? `, ${prog.run.title}` : ''}  ·  ${diff}  ·  day ${Math.floor((game.clock.seconds - game.stats.startSeconds) / 86400) + 1}`;
  } else head.textContent = 'No survivor yet: start a game.';

  const entry = (title: string, body: string, meta?: string, cls = '') =>
    h('div', { class: `pg-entry ${cls}` }, h('div', { class: 'pg-entry-title', text: title }), body ? h('div', { class: 'pg-entry-body', text: body }) : null, meta ? h('div', { class: 'pg-entry-meta', text: meta }) : null);
  const when = (s: number) => {
    const c = Object.assign(new GameClock(), { seconds: s });
    return `Day ${Math.floor((s - game.stats.startSeconds) / 86400) + 1}, ${c.format().replace(/^.*?(\d\d?:\d\d).*$/, '$1')}`;
  };

  function draw(): void {
    const out: (HTMLElement | null)[] = [];
    const tab = t.active as Tab;
    if (tab === 'tips') {
      const byTopic = new Map<string, NudgeDef[]>();
      for (const id of discovered) {
        const d = NUDGES[id];
        byTopic.set(d.topic, [...(byTopic.get(d.topic) ?? []), d]);
      }
      if (!discovered.length) out.push(h('div', { class: 'ui2-empty', text: 'Nothing yet. Tips appear here as you meet new things.' }));
      for (const topic of ['Basics', 'Combat', 'Needs', 'World', 'Items']) {
        const l = byTopic.get(topic);
        if (!l) continue;
        out.push(h('div', { class: 'ui2-section', text: topic }));
        for (const d of l) out.push(entry(withKeys(game, d.title), withKeys(game, d.journal), undefined, d.category === 'warning' ? 'warn' : ''));
      }
      const left = Object.keys(NUDGES).length - discovered.length;
      if (left) out.push(h('div', { class: 'pg-undiscovered', text: `${left} more to discover.` }));
      out.push(h('div', { class: 'pg-entry-meta', text: prog.profile.data.options.hints ? 'Tips pop up once, the first time. Turn them off in Options (Discovery hints) or on the Record tab.' : 'Discovery hints are off: new tips are only written here.' }));
    } else if (tab === 'recipes') {
      if (!inRun || !prog.run.recipes.length) out.push(h('div', { class: 'ui2-empty', text: 'When what you carry or stand next to lets you make something new, it is noted here.' }));
      else {
        out.push(h('div', { class: 'ui2-section', text: 'Recipes you discovered this life' }));
        for (const r of [...prog.run.recipes].reverse()) out.push(entry(r, ''));
        out.push(h('div', { class: 'pg-entry-meta', text: withKeys(game, 'Craft them from the crafting menu (<keybind:craft>).') }));
      }
      out.push(h('div', { class: 'pg-entry-meta', text: `Different recipes crafted, all lives: ${prog.profile.data.recipesCrafted.length}.` }));
    } else if (tab === 'places') {
      if (!inRun || !prog.run.places.length) out.push(h('div', { class: 'ui2-empty', text: 'Towns and landmarks you reach are noted here.' }));
      else {
        out.push(h('div', { class: 'ui2-section', text: 'This life' }));
        for (const pl of prog.run.places) out.push(entry(pl.name.replace(/^./, (c) => c.toUpperCase()), '', when(pl.at)));
      }
      out.push(h('div', { class: 'ui2-section', text: 'All lives' }));
      out.push(h('div', { class: 'pg-stat-grid' }, ...(['towns_visited', 'labs_reached', 'vehicles_driven'] as StatId[]).flatMap((s) => [h('span', { text: STAT_LABEL[s] }), h('span', { text: statValueText(s, prog.profile.stat(s)) })])));
    } else if (tab === 'unlocks') {
      if (prog.profile.data.options.classic) out.push(h('div', { class: 'pg-new', text: 'Classic mode: everything is available in New Game. Progress below still counts.' }));
      const sorted = [...prog.catalogue.unlocks].filter((u) => u.requirement.length).sort((a, b) => Number(prog.profile.isUnlocked(b.id)) - Number(prog.profile.isUnlocked(a.id)) || (a.tier ?? 9) - (b.tier ?? 9));
      for (const u of sorted) {
        const rec = prog.profile.data.unlocked[u.id];
        const box = h('div', { class: `pg-entry ${rec ? 'got' : 'locked'}`, data: { unlock: u.id } },
          h('div', { class: 'pg-entry-title', text: `${u.name}${rec ? '  ✓' : ''}` }),
          u.pitch ? h('div', { class: 'pg-entry-body', text: u.pitch }) : null,
        );
        if (rec) box.append(h('div', { class: 'pg-entry-meta', text: `Unlocked${rec.by ? ` by ${rec.by}` : ''}, ${new Date(rec.at).toLocaleDateString()}.` }));
        else for (const l of progressLines(u, prog.env, prog.achName)) box.append(progressRow(l.text, l.done, l.fraction, l.count));
        out.push(box);
      }
    } else {
      out.push(h('div', { class: 'ui2-section', text: 'All lives' }));
      out.push(h('div', { class: 'pg-stat-grid' }, ...STAT_IDS.flatMap((s) => [h('span', { text: STAT_LABEL[s] }), h('span', { text: statValueText(s, prog.profile.stat(s)) })])));
      out.push(h('div', { class: 'ui2-section', text: 'Options' }));
      const o = prog.profile.data.options;
      out.push(h('div', { class: 'pg-row' },
        button(`Discovery hints: ${o.hints ? 'on' : 'off'}`, () => (prog.profile.setOption('hints', !o.hints), draw()), { small: true }),
        button(`Classic mode: ${o.classic ? 'on' : 'off'}`, () => (prog.profile.setOption('classic', !o.classic), draw()), { small: true, title: 'Unlock every start, scenario and the full creator' }),
        button('Show tips again', () => (prog.profile.resetHints(), toast({ category: 'info', title: 'Tips will show again when you meet them.' })), { small: true }),
      ));
      out.push(h('div', { class: 'ui2-section', text: 'Your progress file' }));
      out.push(h('div', { class: 'pg-row' },
        button('Export…', () => exportProfile(prog), { small: true }),
        button('Import…', () => importProfile(prog, draw), { small: true }),
      ));
      out.push(h('div', { class: 'pg-entry-meta', text: 'Unlocks and statistics live in this browser. Export them to keep a copy or move them to another browser.' }));
    }
    list.replaceChildren(...out.filter((x): x is HTMLElement => !!x));
    list.scrollTop = 0;
  }
  draw();
  return panel;
}

function exportProfile(prog: ProgressionHandle): void {
  prog.profile.flush();
  const blob = new Blob([prog.profile.export()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'cdda3d-progression.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function importProfile(prog: ProgressionHandle, redraw: () => void): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.onchange = async () => {
    const f = input.files?.[0];
    if (!f) return;
    const text = await f.text();
    if (!(await confirmModal({ title: 'Replace your progress?', body: 'Your unlocks, statistics and tips will be replaced by the file\'s.', ok: 'Replace', danger: true }))) return;
    try {
      prog.profile.import(text);
      prog.evaluate();
      toast({ category: 'info', title: 'Progress imported.' });
      redraw();
    } catch (e) {
      toast({ category: 'warning', title: 'Import failed', body: (e as Error).message.slice(0, 200) });
    }
  };
  input.click();
}
