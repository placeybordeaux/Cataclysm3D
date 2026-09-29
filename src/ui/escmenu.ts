import { button, confirmModal, h, type Panel } from '../ui2';
import { colorize } from './framework';
import { openOptions } from './options';
import { openHelp } from './help';
import type { Hud } from './hud';
import type { UiContext } from './context';
import { logLine } from './format';
import { messageTone } from './hud_logic';
import { openScreen } from './screen2';

// The in-game Esc menu (a pause menu: time stops whatever the pause setting says) and the full
// message log ('P', or a click on the HUD's message feed), on ui2.

/** In-game Esc menu. Keys: arrows + Enter, or the letters shown (r o ? s S Q). */
export function openEscMenu(ctx: UiContext, onQuit: () => void): Panel {
  const { game } = ctx;
  const canSave = !!game.save;
  type Entry = { label: string; key: string; run: () => void | Promise<void>; disabled?: string; tone?: 'accent' | 'bad' };
  const entries: Entry[] = [
    { label: 'Resume', key: 'r', tone: 'accent', run: () => panel.close() },
    { label: 'Options', key: 'o', run: () => void openOptions(ctx) },
    { label: 'Help', key: '?', run: () => void openHelp(ctx) },
    {
      label: 'Save game', key: 's', disabled: canSave ? undefined : 'Saving is not available yet',
      run: async () => {
        await game.save!();
        game.message('Game saved.', 'c_light_green');
        panel.close();
      },
    },
    {
      label: 'Save and quit', key: 'S', disabled: canSave ? undefined : 'Saving is not available yet',
      run: async () => {
        try {
          await game.save!();
        } catch (e) {
          game.message(`Save failed: ${(e as Error).message}`, 'c_light_red');
          return;
        }
        onQuit();
      },
    },
    {
      label: 'Quit to main menu', key: 'Q', tone: 'bad',
      run: async () => {
        if (await confirmModal({ title: 'Quit to main menu?', body: 'Unsaved progress will be lost.', ok: 'Quit', danger: true })) onQuit();
      },
    },
  ];
  let sel = 0;
  const col = h('div', { class: 'esc-col', attrs: { 'data-testid': 'esc-menu' } });
  const buttons = entries.map((e, i) => {
    const b = button(e.label, () => void activate(i), { key: e.key, disabled: e.disabled, tone: e.tone });
    b.dataset.i = String(i);
    // Only a real mouse move takes the highlight: the cursor reappears mid-screen when the lock
    // ends, and must not steal Resume's highlight from Enter.
    b.addEventListener('mousemove', (ev) => (ev.movementX || ev.movementY) && select(i));
    return b;
  });
  col.append(...buttons);
  const select = (i: number) => {
    sel = (i + entries.length) % entries.length;
    buttons.forEach((b, j) => b.classList.toggle('sel', j === sel));
  };
  const activate = async (i: number) => {
    const e = entries[i];
    if (e.disabled) return;
    select(i);
    await e.run();
  };
  const panel = openScreen(game, {
    id: 'scr.esc',
    title: 'Paused',
    group: 'scr.esc',
    pauses: 'always',
    action: 'menu',
    closeLabel: 'resume',
    legend: [['↑↓ Enter', 'choose']],
    onKey: (e) => {
      if (e.repeat) return false;
      if (e.key === 'ArrowDown' || e.key === 'Tab') return select(sel + 1), true;
      if (e.key === 'ArrowUp') return select(sel - 1), true;
      if (e.key === 'Enter') return void activate(sel), true;
      const i = entries.findIndex((en) => en.key === e.key);
      if (i >= 0) return void activate(i), true;
      return false;
    },
  });
  const p = game.player;
  const day = Math.floor((game.clock.seconds - game.stats.startSeconds) / 86400) + 1;
  panel.body.append(col, h('div', { class: 'esc-info', text: `${p.name} · day ${day} · ${game.clock.format()}` }));
  // Centre it once its buttons are in (openScreen centred the empty window).
  const r = panel.el.getBoundingClientRect();
  panel.moveTo((innerWidth - r.width) / 2, (innerHeight - r.height) / 2.4);
  select(0);
  return panel;
}

type LogFilter = 'all' | 'alerts' | 'good';

/** 'P' full message log: newest at the bottom, colour-coded, filterable. */
export function openMessageLog(ctx: UiContext, hud: Hud): Panel {
  let filter: LogFilter = 'all';
  const list = h('div', { class: 'lg-list', attrs: { 'data-testid': 'log-list' } });
  const filters = h('div', { class: 'lg-filters' });
  const panel = openScreen(ctx.game, {
    id: 'scr.log',
    title: 'Messages',
    group: 'scr.log',
    action: 'messages',
    pauses: true,
    width: 'min(calc(var(--fs) * 44), 94vw)',
    height: 'min(calc(var(--fs) * 34), 88vh)',
    legend: [['↑↓ PgUp/PgDn', 'scroll']],
    onKey: (e) => {
      const step = { ArrowDown: 40, ArrowUp: -40, PageDown: list.clientHeight * 0.9, PageUp: -list.clientHeight * 0.9 }[e.key];
      if (step === undefined) return false;
      list.scrollTop += step;
      return true;
    },
  });
  const draw = () => {
    const rows = hud.log.entries
      .filter((e) => {
        const t = messageTone(e.color);
        return filter === 'all' || (filter === 'alerts' ? t === 'bad' || t === 'warn' : t === 'good');
      })
      .map((e) => {
        const t = e.gameTime;
        const hh = String(Math.floor((t % 86400) / 3600)).padStart(2, '0'), mm = String(Math.floor((t % 3600) / 60)).padStart(2, '0');
        return h('div', { class: `lg-row tone-${messageTone(e.color)}` }, h('span', { class: 'lg-time', text: `${hh}:${mm}` }), h('span', { html: colorize(`<color_${(e.color ?? 'c_light_gray').replace(/^c_/, '')}>${logLine(e)}</color>`) }));
      });
    list.replaceChildren(...(rows.length ? rows : [h('div', { class: 'ui2-empty', text: 'No messages.' })]));
    list.scrollTop = list.scrollHeight;
    filters.replaceChildren(
      h('span', { class: 'ui2-small ui2-dim', text: 'Show' }),
      ...([['all', 'All'], ['alerts', 'Danger & warnings'], ['good', 'Good news']] as [LogFilter, string][]).map(([id, label]) => {
        const b = button(label, () => ((filter = id), draw()), { small: true });
        b.classList.toggle('on', filter === id);
        return b;
      }),
    );
  };
  panel.body.append(filters, list);
  panel.body.style.overflow = 'hidden';
  draw();
  return panel;
}
