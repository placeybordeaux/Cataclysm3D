import { c, colorize, confirm, getUiRoot, hoverMoved } from './framework';
import { sfx } from '../audio/sfx';
import { openOptions } from './options';
import { openHelp } from './help';
import { applyBuild, openCharGen } from './chargen';
import type { Hud } from './hud';
import type { UiContext } from './context';
import { openMemorialFor } from '../save/install';
import { maybeShowStartHints, randomTip } from './tips';
import { progressionOf } from '../progression/registry';
import { runNewGame, runQuickStart } from '../progression/newgame';
import { openJournal } from '../progression/journal';

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
    ctx.renderer.hideViewmodel = true;
    const root = getUiRoot();
    const el = document.createElement('div');
    el.className = 'screen dim main-menu';
    root.appendChild(el);
    let sel = 0;
    let busy = false;
    // CDDA main_menu.cpp shows a random "tip of the day" under the menu.
    const tip = randomTip(ctx);
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
      ctx.renderer.hideViewmodel = false;
      hud.setVisible(true);
      resolve();
    };

    // v2 on-ramp (src/progression): Start = quick start as a named Evacuee, New Game = the
    // start picker (unlocked professions/scenarios; the full creator once unlocked).
    const prog = progressionOf(game);
    const banner = prog?.takeTitleBanner() ?? [];
    const startGame = () => {
      close();
      void maybeShowStartHints(ctx);
    };
    const entries: MainEntry[] = [
      ...(prog
        ? [
            { label: 'Start', key: 's', enabled: () => true, run: async () => void ((await runQuickStart(ctx, prog, ctx.worldgen)) && startGame()) },
            { label: 'New Game', key: 'n', enabled: () => true, run: async () => void ((await runNewGame(ctx, prog, ctx.worldgen)) && startGame()) },
          ]
        : [{
            label: 'New Game', key: 'n', enabled: () => true,
            run: async () => {
              el.style.display = 'none';
              const build = await openCharGen(ctx);
              el.style.display = '';
              if (!build) return;
              applyBuild(ctx, build);
              close();
              game.message(`${build.name}, you wake up in the evac shelter.  Press <keybind:help> for help.`, 'c_light_gray');
              void maybeShowStartHints(ctx);
            },
          }]),
      {
        label: 'Load', key: 'l', enabled: () => !!game.load && (game.hasSave?.() ?? true),
        run: async () => {
          if (await game.load!()) close();
        },
      },
      ...(prog ? [{ label: 'Journal', key: 'j', enabled: () => true, run: () => void openJournal(game, prog, false) }] : []),
      { label: 'Memorial', key: 'm', enabled: () => true, run: () => openMemorialFor(game) },
      { label: 'Options', key: 'o', enabled: () => true, run: () => void openOptions(ctx) },
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
          <div class="pre" style="color:var(--c-light_gray);text-shadow:1px 1px 0 #000">${c('c_dark_gray', 'a real-time 3D port of')} ${c('c_white', 'Cataclysm: Bright Nights')}</div>
          ${banner.length ? `<div class="pre title-unlocks" style="text-align:center;text-shadow:1px 1px 0 #000">${banner.map((u) => `${c('c_light_green', u.kind === 'scenario' ? 'New scenario unlocked:' : u.kind === 'cosmetic' ? 'New title unlocked:' : u.kind === 'creator' ? 'Unlocked:' : 'New start unlocked:')} ${c('c_white', u.name)}`).join('\n')}</div>` : ''}
          <div class="pre cdda-box" style="padding:.3em 1em">${bar}</div>
          <div class="pre" style="color:var(--c-dark_gray)">${c('c_light_green', '←→')} select  ${c('c_light_green', 'Enter')} confirm  or press the highlighted letter</div>
          ${tip ? `<div style="max-width:70ch;text-align:center;color:var(--c-light_gray);text-shadow:1px 1px 0 #000">${c('c_light_cyan', 'Tip of the day:')} ${c('c_light_gray', tip)}</div>` : ''}
        </div>`;
      el.querySelectorAll<HTMLElement>('.mm-item').forEach((it) => {
        const i = Number(it.dataset.i);
        it.onmousemove = (ev) => hoverMoved(ev) && sel !== i && ((sel = i), render());
        it.onclick = () => void activate(i);
      });
    }
    render();
  });
}


// The in-game Esc menu and the message log live in escmenu.ts (ui2); re-exported here for callers.
export { openEscMenu, openMessageLog } from './escmenu';
