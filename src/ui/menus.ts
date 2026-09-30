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
import { registerOption } from './options';
import { asciiFontPx, drawPixelLogo, setTitleLogoStyle, titleLogoStyle } from './titlelogo';
import { registerTitleLayoutOption, renderTitleButtons, titleLayout, type TitleEntryView } from './title_screen';

let logoOption = false;
/** Options > Title logo (pixel / the CDDA ASCII art), registered once. */
function registerLogoOption(): void {
  if (logoOption) return;
  logoOption = true;
  registerOption({
    name: 'Title logo',
    value: () => (titleLogoStyle() === 'ascii' ? 'ASCII art (CDDA)' : 'Pixel'),
    change: () => setTitleLogoStyle(titleLogoStyle() === 'ascii' ? 'pixel' : 'ascii'),
    desc: 'The logo on the title screen: big pixel letters (easy to read at any size) or the ASCII art from Cataclysm.',
  });
}

// Title screen (CDDA main_menu.cpp look: the ASCII logo from data/title/en.title over a
// slowly turning, darkened view of the world, and a horizontal menu bar with highlighted
// shortcut letters) and the in-game Esc menu.

interface MainEntry {
  label: string;
  key: string;
  enabled: () => boolean;
  run: () => void | Promise<void>;
  /** Button layouts (title_screen.ts): one sentence on what it does, and how big it is. */
  desc?: string;
  weight?: TitleEntryView['weight'];
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
    document.body.classList.add('title-open');
    registerLogoOption();
    registerTitleLayoutOption(() => el.isConnected && render());
    // Drawn once per size; render() re-creates the markup around it.
    const logo = document.createElement('canvas');
    logo.className = 'title-logo';
    logo.setAttribute('aria-label', 'Cataclysm: Bright Nights');
    let logoFor = '';
    const onResize = () => render();
    window.addEventListener('resize', onResize);
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
      window.removeEventListener('resize', onResize);
      release();
      el.remove();
      document.body.classList.remove('title-open');
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
            { label: 'Start', key: 's', weight: 'primary' as const, desc: 'Wake up in an evacuation shelter and learn as you go.', enabled: () => true, run: async () => void ((await runQuickStart(ctx, prog, ctx.worldgen)) && startGame()) },
            { label: 'New Game', key: 'n', weight: 'major' as const, desc: 'Choose who you are and where you start.', enabled: () => true, run: async () => void ((await runNewGame(ctx, prog, ctx.worldgen)) && startGame()) },
          ]
        : [{
            label: 'New Game', key: 'n', enabled: () => true, weight: 'primary' as const, desc: 'Create a survivor and wake up in the evac shelter.',
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
        desc: 'Pick up where you left off.',
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

    // Button layouts: a save makes Load the big "Continue" button at the top; everything
    // else keeps the classic order. Entries are sorted by size so ↑↓ walks them in the order
    // they appear on screen (the classic row keeps its left-to-right order).
    const layout = titleLayout();
    if (layout !== 'classic') {
      const load = entries.find((e) => e.key === 'l');
      if (load && load.enabled()) {
        load.label = 'Continue';
        for (const e of entries) if (e.weight === 'primary') e.weight = 'major';
        load.weight = 'primary';
      }
      const rank = { primary: 0, major: 1, minor: 2 } as const;
      entries.sort((a, b) => rank[a.weight ?? 'minor'] - rank[b.weight ?? 'minor']);
    }

    const activate = async (i: number) => {
      const e = entries[i];
      if (busy) return;
      if (!e.enabled()) return void sfx.ui('menu_error');
      sfx.ui('menu_select');
      sel = i;
      busy = true;
      render();
      try {
        await e.run();
      } finally {
        busy = false;
        if (el.isConnected) render();
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

    /** The pixel logo (a canvas slotted in after the markup) or the ASCII art at an integer font size. */
    function logoMarkup(): string {
      const W = window.innerWidth, H = window.innerHeight;
      if (titleLogoStyle() === 'ascii') {
        const art = ctx.data.title.slice();
        while (art.length && !art[art.length - 1].replace(/<[^>]+>/g, '').trim()) art.pop();
        return `<div class="pre title-art" style="font-size:${asciiFontPx(W, H, 80, art.length)}px;line-height:1;text-shadow:0 0 6px #000,1px 1px 0 #000;background:rgba(0,0,0,.45);padding:.4em .8em">${colorize(art.join('\n'))}</div>`;
      }
      // Smaller while a window is up, so both lines stay clear above it.
      const key = `${W}x${H}${busy ? 'c' : ''}`;
      if (logoFor !== key) {
        logoFor = key;
        drawPixelLogo(logo, busy ? Math.min(W, H * 0.9) : Math.min(W, H * 2.2));
      }
      return '<div class="title-logo-slot"></div>';
    }

    function render() {
      const lay = titleLayout();
      if (!busy && lay !== 'classic') return renderButtons(lay);
      el.classList.remove('tt-center', 'tt-side');
      const bar = entries.map((e, i) => {
        const first = e.label[0], rest = e.label.slice(1);
        const inner = `${c(e.enabled() ? 'c_light_green' : 'c_dark_gray', first)}${c(e.enabled() ? (i === sel ? 'c_white' : 'c_light_gray') : 'c_dark_gray', rest)}`;
        return `<span class="mm-item" data-i="${i}" style="cursor:pointer;padding:0 .6em;${i === sel ? 'background:var(--c-blue)' : ''}">[${inner}]</span>`;
      }).join('');
      // While a window opened from here is up (Start, New Game), only the logo stays, at the top,
      // clear of the window (QA: the Start window covered it with the menu row peeking out).
      if (busy) {
        el.innerHTML = `<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;padding-top:3vh">${logoMarkup()}</div>`;
        el.querySelector('.title-logo-slot')?.replaceWith(logo);
        return;
      }
      el.innerHTML = `<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2.5vh">
          ${logoMarkup()}
          <div class="pre" style="color:var(--c-light_gray);text-shadow:1px 1px 0 #000">${c('c_dark_gray', 'a real-time 3D port of')} ${c('c_white', 'Cataclysm: Bright Nights')}</div>
          ${banner.length ? `<div class="pre title-unlocks" style="text-align:center;text-shadow:1px 1px 0 #000">${banner.map((u) => `${c('c_light_green', u.kind === 'scenario' ? 'New scenario unlocked:' : u.kind === 'cosmetic' ? 'New title unlocked:' : u.kind === 'creator' ? 'Unlocked:' : 'New start unlocked:')} ${c('c_white', u.name)}`).join('\n')}</div>` : ''}
          <div class="pre cdda-box" style="padding:.3em 1em">${bar}</div>
          <div class="pre" style="color:var(--c-dark_gray)">${c('c_light_green', '←→')} select  ${c('c_light_green', 'Enter')} confirm  or press the highlighted letter</div>
          ${tip ? `<div style="max-width:70ch;text-align:center;color:var(--c-light_gray);text-shadow:1px 1px 0 #000">${c('c_light_cyan', 'Tip of the day:')} ${c('c_light_gray', tip)}</div>` : ''}
        </div>`;
      el.querySelector('.title-logo-slot')?.replaceWith(logo);
      el.querySelectorAll<HTMLElement>('.mm-item').forEach((it) => {
        const i = Number(it.dataset.i);
        it.onmousemove = (ev) => hoverMoved(ev) && sel !== i && ((sel = i), render());
        it.onclick = () => void activate(i);
      });
    }
    function renderButtons(lay: 'center' | 'side') {
      const W = window.innerWidth, H = window.innerHeight;
      let logoEl: HTMLElement = logo;
      if (titleLogoStyle() === 'ascii') {
        const holder = document.createElement('div');
        holder.innerHTML = logoMarkup();
        logoEl = holder.firstElementChild as HTMLElement;
      } else {
        // Side column: the logo fits the column; centre: as wide as the classic screen, but
        // leaving room below for the buttons on short windows.
        const key = `${lay}${W}x${H}`;
        if (logoFor !== key) {
          logoFor = key;
          drawPixelLogo(logo, lay === 'side' ? Math.min(W * 0.4, H * 0.9) : Math.min(W, H * 1.5));
        }
      }
      const tipHtml = tip ? c('c_light_gray', tip) : '';
      const bannerHtml = banner.map((u) => `${c('c_light_green', u.kind === 'scenario' ? 'New scenario unlocked:' : u.kind === 'cosmetic' ? 'New title unlocked:' : u.kind === 'creator' ? 'Unlocked:' : 'New start unlocked:')} ${c('c_white', u.name)}`).join('\n');
      const btns = renderTitleButtons(el, lay, {
        entries: entries.map((e, i) => ({ label: e.label, key: e.key, desc: e.desc, enabled: e.enabled(), weight: e.weight ?? 'minor', selected: i === sel })),
        logo: logoEl,
        subtitle: `a real-time, first-person adaptation of <b>Cataclysm: Bright Nights</b>`,
        bannerHtml,
        tipHtml,
      });
      for (const b of btns) {
        const i = Number(b.dataset.i);
        b.onmousemove = (ev) => hoverMoved(ev) && sel !== i && ((sel = i), render());
        b.onclick = () => void activate(i);
      }
    }
    // Start with the focus on the big button (Continue when there's a save).
    sel = Math.max(0, entries.findIndex((e) => e.weight === 'primary'));
    render();
  });
}


// The in-game Esc menu and the message log live in escmenu.ts (ui2); re-exported here for callers.
export { openEscMenu, openMessageLog } from './escmenu';
