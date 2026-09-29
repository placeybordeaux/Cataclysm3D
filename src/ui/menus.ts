import { c, colorize, confirm, getUiRoot, openMenu, type UiWindow } from './framework';
import { sfx } from '../audio/sfx';
import { openOptions } from './options';
import { openHelp } from './help';
import { applyBuild, openCharGen } from './chargen';
import type { Hud } from './hud';
import type { UiContext } from './context';
import { logLine } from './format';

// Title screen (CDDA main_menu.cpp look: the ASCII logo from data/title/en.title over a
// slowly turning, darkened view of the world, and a horizontal menu bar with highlighted
// shortcut letters) and the in-game Esc menu.

interface MainEntry {
  label: string;
  key: string;
  enabled: () => boolean;
  run: () => void | Promise<void>;
}

/**
 * Show the title screen; resolves once a game is running (new character created or a save
 * loaded). The simulation stays paused underneath.
 */
export function showMainMenu(ctx: UiContext, hud: Hud): Promise<void> {
  const { game } = ctx;
  return new Promise((resolve) => {
    hud.setVisible(false);
    game.paused = true;
    const root = getUiRoot();
    const el = document.createElement('div');
    el.className = 'screen dim main-menu';
    root.appendChild(el);
    let sel = 0;
    let busy = false;
    let raf = 0;
    let last = performance.now();
    const p = game.player;
    const saved = { yaw: p.yaw, pitch: p.pitch };
    p.pitch = 0.08;
    // Slow pan so the world behind the logo is alive.
    const spin = (now: number) => {
      raf = requestAnimationFrame(spin);
      p.yaw += ((now - last) / 1000) * 0.06;
      last = now;
    };
    raf = requestAnimationFrame(spin);

    const close = () => {
      cancelAnimationFrame(raf);
      release();
      el.remove();
      p.yaw = saved.yaw;
      p.pitch = saved.pitch;
      game.paused = false;
      hud.setVisible(true);
      resolve();
    };

    const entries: MainEntry[] = [
      {
        label: 'New Game', key: 'n', enabled: () => true,
        run: async () => {
          el.style.display = 'none';
          const build = await openCharGen(ctx);
          el.style.display = '';
          if (!build) return;
          applyBuild(ctx, build);
          close();
          game.message(`${build.name}, you wake up in the evac shelter.  Press ? for help.`, 'c_light_gray');
        },
      },
      {
        label: 'Load', key: 'l', enabled: () => !!game.load && (game.hasSave?.() ?? true),
        run: async () => {
          if (await game.load!()) close();
        },
      },
      { label: 'Settings', key: 's', enabled: () => true, run: () => void openOptions(ctx) },
      { label: 'Help', key: 'h', enabled: () => true, run: () => void openHelp(ctx) },
      {
        label: 'Quit', key: 'q', enabled: () => true,
        run: async () => {
          if (!(await confirm('Really quit?'))) return;
          window.close();
          el.innerHTML = `<div class="pre" style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%)">${c('c_light_gray', 'Thanks for playing.  Close this tab, or reload to play again.')}</div>`;
        },
      },
    ];

    const activate = async (i: number) => {
      const e = entries[i];
      if (busy) return;
      if (!e.enabled()) return void sfx.ui('menu_error');
      sfx.ui('menu_select');
      sel = i;
      render();
      busy = true;
      try {
        await e.run();
      } finally {
        busy = false;
      }
    };

    const release = game.input.capture((e) => {
      if (busy) return true;
      const k = e.key;
      if (k === 'ArrowRight' || k === 'ArrowDown' || k === 'Tab') (sel = (sel + 1) % entries.length), sfx.ui('menu_move');
      else if (k === 'ArrowLeft' || k === 'ArrowUp') (sel = (sel + entries.length - 1) % entries.length), sfx.ui('menu_move');
      else if (k === 'Enter') void activate(sel);
      else {
        const i = entries.findIndex((en) => en.key === k.toLowerCase());
        if (i >= 0) void activate(i);
        else return true;
      }
      render();
      return true;
    });

    function render() {
      const bar = entries.map((e, i) => {
        const first = e.label[0], rest = e.label.slice(1);
        const inner = `${c(e.enabled() ? 'c_light_green' : 'c_dark_gray', first)}${c(e.enabled() ? (i === sel ? 'c_white' : 'c_light_gray') : 'c_dark_gray', rest)}`;
        return `<span class="mm-item" data-i="${i}" style="cursor:pointer;padding:0 .6em;${i === sel ? 'background:var(--c-blue)' : ''}">[${inner}]</span>`;
      }).join('');
      el.innerHTML = `<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2.5vh">
          <div class="pre title-art" style="text-shadow:0 0 6px #000,1px 1px 0 #000;line-height:1.05">${colorize(ctx.data.title.join('\n'))}</div>
          <div class="pre" style="color:var(--c-light_gray);text-shadow:1px 1px 0 #000">${c('c_dark_gray', 'a real-time 3D port of')} ${c('c_white', 'Cataclysm: Dark Days Ahead')}</div>
          <div class="pre cdda-box" style="padding:.3em 1em">${bar}</div>
          <div class="pre" style="color:var(--c-dark_gray)">${c('c_light_green', '←→')} select  ${c('c_light_green', 'Enter')} confirm  or press the highlighted letter</div>
        </div>`;
      el.querySelectorAll<HTMLElement>('.mm-item').forEach((it) => {
        const i = Number(it.dataset.i);
        it.onmouseenter = () => sel !== i && ((sel = i), render());
        it.onclick = () => void activate(i);
      });
    }
    render();
  });
}

/** In-game Esc menu. */
export function openEscMenu(ctx: UiContext, onQuit: () => void): UiWindow {
  const { game } = ctx;
  type Act = 'resume' | 'options' | 'help' | 'save' | 'quit';
  const canSave = !!game.save;
  return openMenu<Act>({
    title: 'Cataclysm: Dark Days Ahead',
    width: '40ch',
    entries: [
      { label: 'Resume', value: 'resume', hotkey: 'r' },
      { label: 'Options', value: 'options', hotkey: 'o' },
      { label: 'Help', value: 'help', hotkey: '?' },
      { label: canSave ? 'Save game' : c('c_dark_gray', 'Save game (not available yet)'), value: 'save', hotkey: 's', disabled: !canSave },
      { label: 'Quit to main menu', value: 'quit', hotkey: 'Q' },
    ],
    onSelect: (a) => {
      setTimeout(async () => {
        if (a === 'options') openOptions(ctx);
        else if (a === 'help') openHelp(ctx);
        else if (a === 'save') {
          await game.save!();
          game.message('Game saved.', 'c_light_green');
        } else if (a === 'quit') {
          if (await confirm('Quit to main menu?  <color_light_red>Unsaved progress will be lost.</color>')) onQuit();
        }
      }, 0);
    },
  });
}

/** 'P' full message log (CDDA Messages screen). */
export function openMessageLog(ctx: UiContext, hud: Hud): UiWindow {
  const w = openMenu<number>({
    title: 'Messages',
    width: 'min(110ch, 94vw)',
    height: '86vh',
    entries: hud.log.entries.map((e, i) => {
      const t = e.gameTime;
      const hh = String(Math.floor((t % 86400) / 3600)).padStart(2, '0'), mm = String(Math.floor((t % 3600) / 60)).padStart(2, '0');
      return { label: `${c('c_dark_gray', `${hh}:${mm}`)} ${colorize(`<color_${(e.color ?? 'c_light_gray').replace(/^c_/, '')}>${logLine(e)}</color>`)}`, value: i, hotkey: '' };
    }),
    onSelect: () => false,
  });
  w.refresh();
  // Newest at the bottom, scrolled into view, like CDDA.
  w.body.scrollTop = w.body.scrollHeight;
  return w;
}
