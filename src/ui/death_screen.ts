import { sfx } from '../audio/sfx';
import { reloadPage } from '../core/unload';
import { colorize } from './framework';
import { acquireSurface, h, pushKeys, ui2Layers, closeGroup, closeMenu } from '../ui2';
import { messageTone } from './hud_logic';
import { durationText, logLine } from './format';
import type { Hud } from './hud';
import type { UiContext } from './context';
import { achievementsOf } from '../achievements';
import { GameClock } from '../core/time';
import { saveHandle } from '../save/install';
import { deathLines, titledName } from '../progression/memorial';
import { permadeath } from '../game/difficulty';
import { stampTombstone } from './death';
import './screens2.css';

// The death screen (ui2): the tombstone from death.ts beside the memorial summary, last words, Enter to the title.

export function showDeathScreen(ctx: UiContext, hud: Hud, cause: string, diedAt = ctx.game.clock.seconds): void {
  const { game } = ctx;
  const p = game.player;
  sfx.playerDeath(!p.male);
  const survived = durationText(diedAt - game.stats.startSeconds);
  const deathClock = Object.assign(new GameClock(), { seconds: diedAt });
  const kills = game.stats.totalKills();
  const vars = { u_name: p.name, time_survived: survived, total_kills: String(kills) };
  const art = stampTombstone(ctx.data.tombstone.picture, ctx.data.tombstone.added_info, vars);

  closeMenu();
  closeGroup();
  const release = acquireSurface({ pauses: 'always' });
  const words = h('input', { class: 'last-words', attrs: { maxlength: '60', placeholder: 'optional', 'data-testid': 'last-words' } });
  const grid = (rows: [string, string][]) => h('div', { class: 'dt-grid' }, ...rows.flatMap(([k, v]) => [h('span', { text: k }), h('span', { text: v })]));
  const killRows = Object.entries(game.stats.kills).sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([id, n]) => [String(n), ctx.game.data.monsters[id]?.name ?? id] as [string, string]);
  const done = achievementsOf(ctx.game)?.completedThisRun() ?? [];
  const extra = deathLines(game);
  const panel = h('div', { class: 'dt-panel' },
    h('div', { class: 'dt-title', text: 'You died' }),
    h('div', { class: 'dt-name', text: `In memory of ${titledName(game)}` }),
    grid([
      ['Cause of death', cause],
      ['Survived', `${survived} (${deathClock.format()})`],
      ...(ctx.build ? [['Start', `${ctx.build.profession}, ${ctx.build.scenario}`] as [string, string]] : []),
      ['Kills', String(kills)],
      ['Distance walked', `${(game.stats.distanceWalked / 1000).toFixed(2)} km`],
      ['Items crafted', String(game.stats.itemsCrafted)],
    ]),
    killRows.length ? h('div', { class: 'ui2-section', text: 'Killed' }) : '',
    killRows.length ? grid(killRows) : h('div', { class: 'ui2-small ui2-dim', text: 'You were a pacifist.' }),
    done.length ? h('div', { class: 'ui2-section', text: 'Achievements this life' }) : '',
    ...done.slice(0, 8).map((a) => h('div', { class: 'ui2-small tone-good', text: a.name })),
    extra.length ? h('div', { class: 'ui2-small', html: extra.map((l) => l || '&nbsp;').join('<br>') }) : '',
    h('div', { class: 'ui2-section', text: 'Last messages' }),
    h('div', { class: 'dt-msgs' }, ...hud.log.recent(8).map((e) => h('div', { class: `tone-${messageTone(e.color)}`, html: colorize(logLine(e)) }))),
    permadeath(game) ? '' : h('div', { class: 'tone-good', text: 'Permadeath is off: your last save is kept. Load it from the main menu to try again.' }),
    h('div', { class: 'dt-words' }, h('span', { class: 'ui2-dim', text: ctx.data.tombstone.last_words_label ?? 'Last Words:' }), words),
    h('div', { class: 'tone-accent ui2-small', text: 'Type your last words if you like, then press Enter to return to the main menu.' }),
  );
  const el = h('div', { class: 'dt-screen death-screen ui2-cdda' },
    h('div', { class: 'dt-inner' }, h('div', { class: 'dt-stone', html: colorize(art.join('\n')) }), panel));
  ui2Layers().modal.appendChild(el);
  requestAnimationFrame(() => (el.style.opacity = '1'));
  hud.setVisible(false);
  // Typing goes straight into the last words.
  setTimeout(() => words.focus(), 1600);
  let left = false;
  const leave = () => {
    if (left) return;
    left = true;
    removeKeys();
    release();
    const w = words.value.trim();
    const saved = w ? saveHandle(game)?.manager.setLastWords(w) : undefined;
    // Reload once the memorial entry has them (or right away if saving isn't available).
    void Promise.resolve(saved).catch(() => {}).finally(() => reloadPage());
  };
  // Keys that don't reach the field (it isn't focused yet): Enter still leaves.
  const removeKeys = pushKeys((e) => {
    if (e.key === 'Enter') leave();
    return true;
  }, { overlay: true });
  words.onkeydown = (e) => {
    e.stopPropagation();
    // A movement key still held from the fight would auto-repeat into the field.
    if (e.repeat) return e.preventDefault();
    if (e.key === 'Enter') leave();
  };
  (window as unknown as { cdda?: { deathScreen?: HTMLElement } }).cdda && ((window as unknown as { cdda: { deathScreen?: HTMLElement } }).cdda.deathScreen = el);
}

