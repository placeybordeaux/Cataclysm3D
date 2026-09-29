// Mission log (replaces the curses window; key M). Tabs Active / Completed / Failed, the list
// on the left, the selected job on the right: who gave it, what it asks (with progress), where
// it points (arrow + distance; "Track" marks it for the map through src/game/mapmarkers.ts),
// time left, what it's worth, and the giver's description.

import type { Game } from '../game/game';
import type { NpcSystem } from '../game/npcai';
import type { Renderer } from '../render/renderer';
import type { MissionInstance } from '../game/missions';
import { button, h, openPanel, tabs, type Panel } from '../ui2';
import { centreFirstTime, chip, hours, markup, portrait, section } from './common';
import { missionEntry, valueText, type MissionEntry } from './logic/missions';

export interface MissionsCtx {
  game: Game;
  renderer: Renderer | null;
  sys: NpcSystem;
}

type Tab = 'active' | 'succeeded' | 'failed';

/** The mission the player follows on the map (uid), shared with the marker provider. */
export const missionTracking = { uid: null as number | null };

let lastTab: Tab = 'active';

export function openMissionsPanel(ctx: MissionsCtx, focusUid?: number): Panel {
  const { game, sys } = ctx;
  const ms = sys.missions;
  const byStatus = (st: Tab) => [...ms.all.values()].filter((m) => m.status === st).reverse();
  if (focusUid !== undefined) lastTab = (ms.get(focusUid)?.status as Tab | undefined) ?? lastTab;
  let selUid: number | null = focusUid ?? null;

  const panel = openPanel({
    id: 'missions',
    title: 'Missions',
    pauses: true,
    width: 'min(calc(var(--fs) * 56), 95vw)',
    height: 'min(82vh, calc(var(--fs) * 32))',
    footer: `←→ tabs · ↑↓ choose · T track on the map · ${game.keys.keyFor('missions')} / Esc close`,
    onKey: (e) => {
      if (e.key === game.keys.keyFor('missions') && !e.repeat) return panel.close(), true;
      const order: Tab[] = ['active', 'succeeded', 'failed'];
      const i = order.indexOf(t.active as Tab);
      if (e.key === 'ArrowRight' || e.key === 'Tab') return t.set(order[(i + 1) % 3]), true;
      if (e.key === 'ArrowLeft') return t.set(order[(i + 2) % 3]), true;
      const list = byStatus(t.active as Tab);
      const j = list.findIndex((m) => m.uid === selUid);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const next = list[Math.max(0, Math.min(list.length - 1, j + (e.key === 'ArrowDown' ? 1 : -1)))];
        if (next) (selUid = next.uid), draw();
        return true;
      }
      if ((e.key === 't' || e.key === 'T') && selUid !== null) return toggleTrack(selUid), true;
      return false;
    },
  });
  panel.el.classList.add('ix-missions-win');
  centreFirstTime(panel);

  const t = tabs(
    [
      { id: 'active', label: 'Active', badge: String(byStatus('active').length) },
      { id: 'succeeded', label: 'Completed', badge: String(byStatus('succeeded').length) },
      { id: 'failed', label: 'Failed', badge: String(byStatus('failed').length) },
    ],
    lastTab,
    (id) => {
      lastTab = id as Tab;
      selUid = null;
      draw();
    },
  );
  const list = h('div', { class: 'ix-mlist', attrs: { 'data-testid': 'mission-list' } });
  const detail = h('div', { class: 'ix-mdetail', attrs: { 'data-testid': 'mission-detail' } });
  panel.body.append(t.el, h('div', { class: 'ix-mbody' }, list, detail));
  panel.body.classList.add('ix-missions-body');

  const entryOf = (m: MissionInstance): MissionEntry =>
    missionEntry(ms, m, game.player, game.clock.seconds, (uid) => sys.npcByUid(uid)?.displayName() ?? null, (s) => {
      const giver = m.npcUid >= 0 ? sys.npcByUid(m.npcUid) : undefined;
      return sys.dialogueFor(giver)?.parseTags(s) ?? s;
    });

  function toggleTrack(uid: number): void {
    missionTracking.uid = missionTracking.uid === uid ? null : uid;
    draw();
  }

  function draw(): void {
    const tab = t.active as Tab;
    const missions = byStatus(tab);
    if (selUid === null || !missions.some((m) => m.uid === selUid)) selUid = missions[0]?.uid ?? null;
    list.replaceChildren(
      ...(missions.length
        ? missions.map((m) => {
            const e = entryOf(m);
            const row = h(
              'div',
              { class: `ix-mrow${m.uid === selUid ? ' selected' : ''}`, data: { uid: String(m.uid) } },
              h('div', { class: 'ix-mrow-top' }, h('span', { class: 'ix-mrow-name', text: e.name }), missionTracking.uid === m.uid ? chip('Tracked', 'accent') : null),
              h('div', { class: 'ix-mrow-sub' },
                e.target && tab === 'active' ? h('span', { class: 'ix-arrow', text: `${e.target.arrow} ${e.target.omts ? `${e.target.omts} OMT` : 'here'}` }) : null,
                e.hoursLeft !== null && tab === 'active' ? h('span', { class: `tone-${e.deadlineTone}`, text: `${hours(e.hoursLeft)} left` }) : null,
                e.giver ? h('span', { class: 'ui2-dim', text: e.giver }) : null),
            );
            row.addEventListener('click', () => {
              selUid = m.uid;
              draw();
            });
            return row;
          })
        : [h('div', { class: 'ui2-empty', text: tab === 'active' ? 'No jobs yet. Survivors you talk to may have work for you.' : 'Nothing here yet.' })]),
    );
    const m = selUid !== null ? ms.get(selUid) : undefined;
    if (!m) {
      detail.replaceChildren(h('div', { class: 'ui2-empty', text: 'Select a mission.' }));
      return;
    }
    const e = entryOf(m);
    const giver = m.npcUid >= 0 ? sys.npcByUid(m.npcUid) : undefined;
    const status = m.status === 'active' ? chip('In progress', 'info') : m.status === 'succeeded' ? chip('Completed', 'good') : chip('Failed', 'bad');
    const parts: (HTMLElement | null)[] = [
      h('div', { class: 'ix-mhead' },
        giver ? portrait(game, ctx.renderer, giver, 1) : null,
        h('div', { class: 'ix-mhead-text' },
          h('div', { class: 'ix-dlg-name', text: e.name }),
          h('div', { class: 'ix-dlg-tags' }, status, e.giver ? chip(`from ${e.giver}`, 'dim') : null, e.value ? chip(`Worth ${valueText(e.value)}`, 'accent') : null))),
      section('Objective'),
      h('div', { class: 'ix-mgoal' }, markup(e.goal)),
      m.status === 'active' && e.target
        ? h('div', { class: 'ix-mtarget' },
            h('span', { class: 'ix-big-arrow', text: e.target.arrow }),
            h('div', {}, h('div', { text: e.target.text }), h('div', { class: 'ui2-dim ui2-small', text: e.target.omts ? (missionTracking.uid === m.uid ? 'Tracked: shown on your map.' : 'Track it to follow it on your map.') : 'The target is around you.' })),
            button(missionTracking.uid === m.uid ? 'Stop tracking' : 'Track', () => toggleTrack(m.uid), { small: true, key: 'T' }))
        : null,
      m.status === 'active' && e.hoursLeft !== null ? h('div', { class: `ix-mdeadline tone-${e.deadlineTone}`, text: `Deadline: ${hours(e.hoursLeft)} left` }) : null,
      // CONDITION goals read their description as the objective: don't say it twice.
      e.description && e.description !== e.goal ? section('Briefing') : null,
      e.description && e.description !== e.goal ? h('div', { class: 'ix-mdesc' }, markup(e.description)) : null,
      m.status === 'active' && giver ? h('div', { class: 'ui2-dim ui2-small', text: `Report back to ${giver.displayName()} when it's done.` }) : null,
    ];
    detail.replaceChildren(...parts.filter((x): x is HTMLElement => !!x));
  }
  draw();
  return panel;
}
