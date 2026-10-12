import { getAudioEngine } from '../audio/sfx';
import { AA_MODES, type AAMode, type GradeMode } from '../render/post';
import { CAMERA_MODES } from '../render/camera';
import { c } from './framework';
import { h, isCloseKey, scrollList, tabs, type Panel } from '../ui2';
import { legendEl, openScreen } from './screen2';
import type { UiContext } from './context';
import type { MenuCursor } from '../core/input';
import { isFullscreen, toggleFullscreen } from './fullscreen';
import { openKeybindings } from './keybind_ui';

// Options screen (CDDA's options menu, reduced to what this port has; a ui2 window): mouse
// sensitivity, render resolution (low-res target height), colour grading, camera, HUD and audio.
// ←/→ or the ‹ › buttons change the highlighted value; Enter / double-click steps it. Game options persist in localStorage; audio settings
// persist themselves (src/audio/audio.ts).
//
// Every option belongs to a category (OptCategory). With ~70 entries one flat list stopped being
// browsable, so there are three ways to lay them out (Options layout, ?optlayout=):
//   tabs     : one category at a time, Tab / Shift+Tab (or [ ]) or a click switches.
//   drill    : a list of categories; Enter / → / click opens one, Bksp / Esc goes back.
//   sections : everything in one list under category headings (the old flat list, grouped).
// In every layout typing filters across all categories (name and description).

const STORAGE_KEY = 'cdda3d.options';

export interface GameOptions {
  mouseSensitivity: number;
  px: number;
  pixelRatio: number;
  grade: GradeMode;
  aa: AAMode;
  layout: OptionsLayout;
  camera: (typeof CAMERA_MODES)[number];
  /** Legacy (pre-wave-3) draw radius; Options > Draw distance now lives in render/lookInstall.ts,
   *  which migrates this value once. */
  radius: number;
  menuCursor: MenuCursor;
}

function loadStored(): Partial<GameOptions> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
  } catch {
    return {};
  }
}
/** Persist game options (merged into what's stored); the style gallery's "copy as my defaults" uses it for Colour grading. */
export function storeGameOptions(o: Partial<GameOptions>): void {
  store(o);
}
function store(o: Partial<GameOptions>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...loadStored(), ...o }));
  } catch {
    // private mode / blocked storage: options just don't persist
  }
}

/** Apply stored options at boot. URL params (px=, grade=) win over stored values. */
export function applyStoredOptions(ctx: UiContext): void {
  const o = loadStored();
  const params = new URLSearchParams(location.search);
  if (o.mouseSensitivity) ctx.game.mouseSensitivity = o.mouseSensitivity;
  if (o.menuCursor === 'free' || o.menuCursor === 'captured') ctx.game.input.menuCursor = o.menuCursor;
  const pipe = ctx.renderer.pipeline;
  if (o.pixelRatio !== undefined && !params.has('pixelRatio') &&
    (o.pixelRatio === 0 || (Number.isFinite(o.pixelRatio) && o.pixelRatio >= 0.5 && o.pixelRatio <= 2))) {
    ctx.renderer.pixelRatio = o.pixelRatio;
    ctx.renderer.resize();
  }
  if (o.px !== undefined && !params.get('px')) {
    pipe.options.targetHeight = o.px;
    ctx.renderer.resize();
  }
  if (o.grade && !params.get('grade')) pipe.options.grade = o.grade;
  // an unknown stored value (renamed mode) is ignored rather than thrown: it's our own storage
  if (o.aa && AA_MODES.includes(o.aa) && !params.get('aa')) pipe.setAA(o.aa);
  // The camera is not restored at boot: a stored 'third' kept loading the player into the
  // over-the-shoulder view (user report). First person is the game; V / this row switch per session.
}

/** Display order of the categories; each Opt must name one of these. */
export const OPT_CATEGORIES = ['Display', 'World', 'Controls', 'Interface', 'Gameplay', 'Audio'] as const;
export type OptCategory = (typeof OPT_CATEGORIES)[number];
const CATEGORY_LABEL: Record<OptCategory, string> = {
  Display: 'Display', World: 'World detail', Controls: 'Controls', Interface: 'Interface', Gameplay: 'Gameplay', Audio: 'Audio',
};
const CATEGORY_DESC: Record<OptCategory, string> = {
  Display: 'Resolution, antialiasing, colour grading, camera, performance overlay.',
  World: 'How the world is drawn: visual style, draw distance, lighting, trees, furniture, creatures, vehicles.',
  Controls: 'Key bindings, mouse, aiming, driving, fast-forward.',
  Interface: 'Menus, HUD, inventory and crafting screens, hints and messages.',
  Gameplay: 'Difficulty, zombie density, climate, autosave and rule switches.',
  Audio: 'Volumes, music, 3D audio.',
};

export const OPTIONS_LAYOUTS = ['tabs', 'drill', 'sections'] as const;
export type OptionsLayout = (typeof OPTIONS_LAYOUTS)[number];

function optionsLayout(): OptionsLayout {
  const p = new URLSearchParams(location.search).get('optlayout');
  if (p) {
    if (!(OPTIONS_LAYOUTS as readonly string[]).includes(p)) throw new Error(`?optlayout= must be one of ${OPTIONS_LAYOUTS.join('|')}, got ${p}`);
    return p as OptionsLayout;
  }
  const o = loadStored().layout;
  return o && OPTIONS_LAYOUTS.includes(o) ? o : 'tabs';
}

export interface Opt {
  category: OptCategory;
  name: string;
  value: () => string;
  change: (dir: -1 | 1) => void;
  desc: string;
}

/** Options owned by other systems (e.g. autosave interval from src/save), shown after the game options. */
const extraOptions: Opt[] = [];
export function registerOption(o: Opt): void {
  extraOptions.push(o);
}
/** The registered entries (the style gallery persists "my defaults" through them, exactly as Options would). */
export function registeredOptions(): readonly Opt[] {
  return extraOptions;
}

export function openOptions(ctx: UiContext): Panel {
  const { game, renderer } = ctx;
  const pipe = renderer.pipeline;
  const opts: Opt[] = [];
  opts.push({
    category: 'Controls',
    name: 'Key bindings…',
    value: () => (game.keys.unreachable().length ? c('c_light_red', `${game.keys.unreachable().length} unbound`) : ''),
    change: () => void openKeybindings(game),
    desc: 'Rebind any action (Enter to open). Movement is WASD at those physical positions on any layout, plus Shift and Space.',
  });
  opts.push({
    category: 'Display',
    name: 'Fullscreen',
    value: () => (isFullscreen() ? 'on' : 'off'),
    change: () => void toggleFullscreen(game).then(() => refresh(sel, true)),
    desc: `Also ${game.keys.label('fullscreen')} in game. In fullscreen Esc no longer frees the mouse (hold Esc to leave fullscreen). Either way, ${game.keys.label('close_menu')} closes menus and keeps it.`,
  });
  opts.push({
    category: 'Controls',
    name: 'Menu cursor',
    value: () => game.input.menuCursor,
    change: () => {
      game.input.menuCursor = game.input.menuCursor === 'captured' ? 'free' : 'captured';
      store({ menuCursor: game.input.menuCursor });
    },
    desc: 'captured: menus are keyboard-only and closing one drops you straight back into mouse-look. free: menus show the mouse cursor so you can point and click; closing one captures the mouse again.',
  });
  const cycle = <T,>(list: T[], cur: T, dir: number) => list[(list.indexOf(cur) + dir + list.length) % list.length];
  opts.push({
    category: 'Controls',
    name: 'Mouse sensitivity',
    value: () => (game.mouseSensitivity * 1000).toFixed(2),
    change: (d) => {
      game.mouseSensitivity = Math.max(0.0005, Math.min(0.01, game.mouseSensitivity * (d > 0 ? 1.15 : 1 / 1.15)));
      store({ mouseSensitivity: game.mouseSensitivity });
    },
    desc: 'How far the view turns per pixel of mouse movement.',
  });
  // 0 = auto: the integer upscale giving a 540-720 px image (grading.ts lowResSize)
  const PX = [0, 240, 270, 300, 360, 432, 480, 540, 720];
  opts.push({
    category: 'Display',
    name: 'Display pixel ratio',
    value: () => renderer.pixelRatio ? `${renderer.pixelRatio}×` : 'Native',
    change: (d) => {
      renderer.pixelRatio = cycle([0, 0.5, 1, 1.5, 2], renderer.pixelRatio, d);
      renderer.resize();
      store({ pixelRatio: renderer.pixelRatio });
    },
    desc: 'Native uses the display resolution. Lower values reduce graphics work on high-density displays; the game image may be softer or chunkier. Interface text stays sharp.',
  });
  opts.push({
    category: 'Display',
    name: 'Render resolution',
    value: () => (pipe.options.targetHeight > 0 ? `${pipe.options.targetHeight} px` : `auto (${pipe.lowH - 2})`),
    change: (d) => {
      const cur = pipe.options.targetHeight;
      const i = PX.findIndex((v) => v >= cur);
      pipe.options.targetHeight = PX[Math.max(0, Math.min(PX.length - 1, (i < 0 ? PX.length - 1 : i) + d))];
      renderer.resize();
      store({ px: pipe.options.targetHeight });
    },
    desc: 'Height of the low-resolution pixel-art image. Lower is chunkier (and faster).',
  });
  // Draw distance is registered by render/lookInstall.ts (one entry; this screen used to have a
  // second, older one with different steps, labels and storage that overrode it at boot).
  const GRADES: GradeMode[] = ['palette', 'smooth', 'off'];
  opts.push({
    category: 'Display',
    name: 'Colour grading',
    value: () => pipe.options.grade,
    change: (d) => {
      pipe.options.grade = cycle(GRADES, pipe.options.grade, d);
      store({ grade: pipe.options.grade });
    },
    desc: 'palette: limited-palette pixel look; smooth: graded without banding; off: raw colours.',
  });
  opts.push({
    category: 'Display',
    name: 'Antialiasing',
    value: () => pipe.options.aa,
    change: (d) => {
      pipe.setAA(cycle([...AA_MODES], pipe.options.aa, d));
      store({ aa: pipe.options.aa });
    },
    desc: 'Smooths jagged edges in the low-res image before the palette (also ?aa=). msaa: geometry edges, cheap. msaa+a2c: also grass/leaf card edges. ssaa2: renders 4x the pixels and averages them; smoothest, costliest.',
  });
  opts.push({
    category: 'Display',
    name: 'Camera',
    value: () => renderer.cameraMode,
    change: (d) => {
      renderer.setCameraMode(cycle(CAMERA_MODES, renderer.cameraMode, d));
    },
    desc: 'First person, over the shoulder, or CDDA-style top-down (also V in game). Every game starts in first person.',
  });
  opts.push(...extraOptions);
  const audio = getAudioEngine();
  if (audio) {
    const s = audio.settings;
    const vol = (key: 'master' | 'sfx' | 'music' | 'ambient' | 'ui', name: string, desc: string) =>
      opts.push({
        category: 'Audio',
        name,
        value: () => `${Math.round(s[key] * 100)}%`,
        change: (d) => (s[key] = Math.max(0, Math.min(1, Math.round((s[key] + d * 0.1) * 10) / 10))),
        desc,
      });
    vol('master', 'Master volume', 'Overall volume.');
    vol('sfx', 'Sound effects', 'Combat, footsteps, doors, monsters.');
    vol('music', 'Music volume', 'Background music.');
    vol('ambient', 'Ambient volume', 'Wind, rain, crickets.');
    vol('ui', 'Interface sounds', 'Menu clicks.');
    const toggle = (key: 'muted' | 'musicEnabled' | 'hrtf' | 'occlusion', name: string, desc: string) =>
      opts.push({ category: 'Audio', name, value: () => (s[key] ? 'on' : 'off'), change: () => (s[key] = !s[key]), desc });
    toggle('musicEnabled', 'Music', 'Play background music.');
    toggle('muted', 'Mute all', 'Silence everything.');
    toggle('hrtf', '3D audio (HRTF)', 'Binaural positioning; turn off for plain stereo.');
    toggle('occlusion', 'Sound occlusion', 'Muffle sounds behind walls.');
  } else {
    opts.push({
      category: 'Audio',
      name: 'Audio', value: () => c('c_dark_gray', 'unavailable'), change: () => {}, desc: 'The audio engine is not running.' });
  }

  let layout = optionsLayout();
  opts.push({
    category: 'Interface',
    name: 'Options layout',
    value: () => layout,
    change: (d) => {
      layout = cycle([...OPTIONS_LAYOUTS], layout, d);
      store({ layout });
      // rebuilt on the next refresh (change() below), keeping this row selected
    },
    desc: 'How this screen is organised. tabs: one category at a time (Tab switches). drill: pick a category, then its settings (Bksp goes back). sections: everything in one list under headings. Typing searches in all of them.',
  });
  for (const o of opts) {
    if (!OPT_CATEGORIES.includes(o.category)) throw new Error(`option ${o.name}: unknown category ${o.category}`);
  }

  // A list row is an option, a category entry (drill's top level) or a heading (sections and
  // search results; never selectable).
  type Row = { kind: 'opt'; o: Opt } | { kind: 'cat'; cat: OptCategory } | { kind: 'head'; cat: OptCategory };
  const inCat = (cat: OptCategory) => opts.filter((o) => o.category === cat);
  const cats = OPT_CATEGORIES.filter((c) => inCat(c).length > 0);
  let tab: OptCategory = cats[0];
  /** drill: the open category, null at the top level. */
  let open: OptCategory | null = null;
  let query = '';
  let sel = 0;

  const grouped = (list: Opt[]): Row[] =>
    cats.flatMap((cat) => {
      const os = list.filter((o) => o.category === cat);
      return os.length ? [{ kind: 'head' as const, cat }, ...os.map((o) => ({ kind: 'opt' as const, o }))] : [];
    });
  const rows = (): Row[] => {
    if (query) {
      const q = query.toLowerCase();
      return grouped(opts.filter((o) => o.name.toLowerCase().includes(q) || o.desc.toLowerCase().includes(q)));
    }
    if (layout === 'tabs') return inCat(tab).map((o) => ({ kind: 'opt', o }));
    if (layout === 'drill') return open ? inCat(open).map((o) => ({ kind: 'opt', o })) : cats.map((cat) => ({ kind: 'cat', cat }));
    return grouped(opts);
  };
  let items = rows();

  const desc = h('div', { class: 'op-desc', attrs: { 'data-testid': 'options-desc' } });
  const top = h('div', { class: 'op-top' });
  const search = h('div', { class: 'op-search', attrs: { 'data-testid': 'options-search' } });
  const describe = (r: Row | undefined) => {
    if (!r) desc.textContent = query ? 'No option matches.' : '';
    else if (r.kind === 'opt') desc.textContent = r.o.desc;
    else if (r.kind === 'cat') desc.textContent = CATEGORY_DESC[r.cat];
  };
  const selectable = (i: number) => items[i] && items[i].kind !== 'head';
  const select = (i: number, dir: 1 | -1 = 1) => {
    let j = Math.max(0, Math.min(items.length - 1, i));
    while (items[j] && !selectable(j)) j += dir;
    if (!selectable(j)) {
      j = Math.max(0, Math.min(items.length - 1, i));
      while (items[j] && !selectable(j)) j -= dir;
    }
    if (selectable(j)) list.select(j);
    else describe(undefined);
  };
  const enter = (cat: OptCategory) => {
    open = cat;
    refresh(0);
  };
  const back = () => {
    const was = open;
    open = null;
    refresh(was ? cats.indexOf(was) : 0);
  };
  const change = (o: Opt, d: -1 | 1) => {
    const before = layout;
    o.change(d);
    if (layout !== before) {
      open = null;
      tab = o.category;
    }
    refresh(Math.max(0, items.findIndex((r) => r.kind === 'opt' && r.o === o)), true);
  };
  const activate = (r: Row, d: -1 | 1 = 1) => {
    if (r.kind === 'opt') change(r.o, d);
    else if (r.kind === 'cat') enter(r.cat);
  };

  const list = scrollList<Row>({
    items,
    render: (r) => {
      if (r.kind === 'head') return h('div', { class: 'op-section', text: CATEGORY_LABEL[r.cat] });
      if (r.kind === 'cat') {
        return h('div', { class: 'op-row op-cat', data: { cat: r.cat } },
          h('span', { text: CATEGORY_LABEL[r.cat] }),
          h('span', { class: 'op-count', text: `${inCat(r.cat).length} ›` }));
      }
      const o = r.o;
      const val = h('span', { html: o.value() || '›' });
      const left = h('button', { class: 'op-arrow', text: '‹', title: 'Previous' });
      const right = h('button', { class: 'op-arrow', text: '›', title: 'Next' });
      left.addEventListener('click', (e) => (e.stopPropagation(), list.select(items.indexOf(r)), change(o, -1)));
      right.addEventListener('click', (e) => (e.stopPropagation(), list.select(items.indexOf(r)), change(o, 1)));
      return h('div', { class: 'op-row', data: { name: o.name } }, h('span', { text: o.name }), h('span', { class: 'op-val' }, left, val, right));
    },
    onSelect: (r) => {
      sel = items.indexOf(r);
      describe(r);
    },
    onActivate: (r) => activate(r),
  });
  list.el.classList.add('op-list');
  // a single click opens a category (a double click is what steps an option)
  list.el.addEventListener('click', (e) => {
    const cat = (e.target as HTMLElement).closest<HTMLElement>('.op-cat')?.dataset.cat as OptCategory | undefined;
    if (cat) enter(cat);
  });

  const drawTop = () => {
    search.textContent = query ? `Search: ${query}_` : '';
    search.style.display = query ? '' : 'none';
    if (query) return top.replaceChildren(search);
    if (layout === 'tabs') {
      const t = tabs(cats.map((c) => ({ id: c, label: CATEGORY_LABEL[c] })), tab, (id) => {
        if (id === tab) return;
        tab = id as OptCategory;
        refresh(0);
      });
      return top.replaceChildren(t.el);
    }
    if (layout === 'drill' && open) {
      const crumb = h('button', { class: 'op-crumb', text: `‹ ${CATEGORY_LABEL[open]}`, title: 'Back to categories', on: { click: back } });
      return top.replaceChildren(crumb);
    }
    top.replaceChildren();
  };
  const LEGEND: Record<OptionsLayout, [string, string][]> = {
    tabs: [['↑↓', 'choose'], ['←→ / Enter', 'change'], ['Tab', 'category'], ['type', 'search']],
    drill: [['↑↓', 'choose'], ['←→ / Enter', 'change / open'], ['Bksp', 'back'], ['type', 'search']],
    sections: [['↑↓', 'choose'], ['←→ / Enter', 'change'], ['Tab', 'next section'], ['type', 'search']],
  };
  let shownLegend: OptionsLayout | null = null;
  /** Rebuild rows for the current layout/tab/query; `keepScroll` for in-place value changes. */
  const refresh = (at: number, keepScroll = false) => {
    items = rows();
    const scroll = list.el.scrollTop;
    list.setItems(items);
    drawTop();
    if (shownLegend !== layout) {
      shownLegend = layout;
      win?.setFooter(legendEl(game, LEGEND[layout], undefined, 'done'));
    }
    select(at);
    if (keepScroll) list.el.scrollTop = scroll;
  };

  const win: Panel = openScreen(game, {
    id: 'scr.options',
    title: 'Options',
    group: 'scr.options',
    pauses: 'always',
    width: 'min(calc(var(--fs) * 34), 94vw)',
    height: 'min(calc(var(--fs) * 32), 90vh)',
    closeLabel: 'done',
    legend: LEGEND[layout],
    onKey: (e) => {
      const r = items[sel];
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const d = e.key === 'ArrowDown' ? 1 : -1;
        return select(sel + d, d), true;
      }
      // Search: printable characters filter; Bksp edits the query before it means "back/close".
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && (query || !isCloseKey(e)) && !/[[\]]/.test(e.key)) {
        query += e.key;
        return refresh(0), true;
      }
      if (query && (e.key === 'Backspace' || e.key === 'Escape')) {
        query = e.key === 'Escape' ? '' : query.slice(0, -1);
        return refresh(0), true;
      }
      if (layout === 'drill' && open && (e.key === 'Escape' || e.key === 'Backspace' || isCloseKey(e))) return back(), true;
      if (e.key === 'Tab' || e.key === '[' || e.key === ']') {
        const d = e.shiftKey || e.key === '[' ? -1 : 1;
        if (layout === 'tabs') {
          tab = cats[(cats.indexOf(tab) + d + cats.length) % cats.length];
          refresh(0);
        } else if (layout === 'sections' && !query) {
          // jump to the first option of the next/previous section
          const heads = items.map((x, i) => (x.kind === 'head' ? i : -1)).filter((i) => i >= 0);
          const cur = heads.filter((i) => i < sel).length - 1;
          const next = heads[(cur + d + heads.length) % heads.length];
          list.select(next + 1);
        }
        return true;
      }
      if (!r) return false;
      if (layout === 'drill' && !open && r.kind === 'cat' && (e.key === 'ArrowRight' || e.key === 'Enter')) return enter(r.cat), true;
      if (r.kind !== 'opt') return false;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') return change(r.o, e.key === 'ArrowLeft' ? -1 : 1), true;
      if (e.key === 'Enter') return change(r.o, 1), true;
      return false;
    },
  });
  win.body.append(top, list.el, desc);
  win.body.style.overflow = 'hidden';
  shownLegend = layout;
  refresh(0);
  return win;
}
