import { getAudioEngine } from '../audio/sfx';
import type { GradeMode } from '../render/post';
import { CAMERA_MODES } from '../render/camera';
import { c } from './framework';
import { h, scrollList, type Panel } from '../ui2';
import { openScreen } from './screen2';
import type { UiContext } from './context';
import type { MenuCursor } from '../core/input';
import { isFullscreen, toggleFullscreen } from './fullscreen';
import { openKeybindings } from './keybind_ui';

// Options screen (CDDA's options menu, reduced to what this port has; a ui2 window): mouse
// sensitivity, render resolution (low-res target height), colour grading, camera, HUD and audio.
// ←/→ or the ‹ › buttons change the highlighted value; Enter / double-click steps it. Game options persist in localStorage; audio settings
// persist themselves (src/audio/audio.ts).

const STORAGE_KEY = 'cdda3d.options';

export interface GameOptions {
  mouseSensitivity: number;
  px: number;
  grade: GradeMode;
  camera: (typeof CAMERA_MODES)[number];
  /** Chunks drawn around the player (fog of war sits just inside this). */
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
  if (o.px && !params.get('px')) {
    pipe.options.targetHeight = o.px;
    ctx.renderer.resize();
  }
  if (o.grade && !params.get('grade')) pipe.options.grade = o.grade;
  if (o.radius && !params.get('radius')) setDrawDistance(ctx, o.radius);
  if (o.camera && CAMERA_MODES.includes(o.camera) && !params.get('cam')) ctx.renderer.setCameraMode(o.camera);
}

/** Draw radius in chunks; the fog follows it and world prefetch stays one ring ahead. */
function setDrawDistance(ctx: UiContext, radius: number): void {
  ctx.renderer.chunks.radius = radius;
  const prefetch = (window as unknown as { cdda?: { prefetch?: { opts: { radius: number } } } }).cdda?.prefetch;
  if (prefetch) prefetch.opts.radius = radius + 1;
}

export interface Opt {
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

export function openOptions(ctx: UiContext): Panel {
  const { game, renderer } = ctx;
  const pipe = renderer.pipeline;
  const opts: Opt[] = [];
  opts.push({
    name: 'Key bindings…',
    value: () => (game.keys.unreachable().length ? c('c_light_red', `${game.keys.unreachable().length} unbound`) : ''),
    change: () => void openKeybindings(game),
    desc: 'Rebind any action (Enter to open). Movement is WASD at those physical positions on any layout, plus Shift and Space.',
  });
  opts.push({
    name: 'Fullscreen',
    value: () => (isFullscreen() ? 'on' : 'off'),
    change: () => void toggleFullscreen(game).then(() => list.setItems(opts)),
    desc: `Also ${game.keys.label('fullscreen')} in game. In fullscreen Esc opens and closes menus without freeing the mouse (hold Esc to leave fullscreen).`,
  });
  opts.push({
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
    name: 'Mouse sensitivity',
    value: () => (game.mouseSensitivity * 1000).toFixed(2),
    change: (d) => {
      game.mouseSensitivity = Math.max(0.0005, Math.min(0.01, game.mouseSensitivity * (d > 0 ? 1.15 : 1 / 1.15)));
      store({ mouseSensitivity: game.mouseSensitivity });
    },
    desc: 'How far the view turns per pixel of mouse movement.',
  });
  const PX = [240, 270, 300, 360, 432, 480, 540, 720];
  opts.push({
    name: 'Render resolution',
    value: () => `${pipe.options.targetHeight} px`,
    change: (d) => {
      const cur = pipe.options.targetHeight;
      const i = PX.findIndex((v) => v >= cur);
      pipe.options.targetHeight = PX[Math.max(0, Math.min(PX.length - 1, (i < 0 ? PX.length - 1 : i) + d))];
      renderer.resize();
      store({ px: pipe.options.targetHeight });
    },
    desc: 'Height of the low-resolution pixel-art image. Lower is chunkier (and faster).',
  });
  const RADII = [4, 5, 6, 7, 8, 10];
  opts.push({
    name: 'Draw distance',
    value: () => `${renderer.chunks.radius * 24} m`,
    change: (d) => {
      const i = RADII.indexOf(renderer.chunks.radius);
      setDrawDistance(ctx, RADII[Math.max(0, Math.min(RADII.length - 1, (i < 0 ? 2 : i) + d))]);
      store({ radius: renderer.chunks.radius });
    },
    desc: 'How far the world is drawn before it fades into fog. Farther costs more GPU and generation time.',
  });
  const GRADES: GradeMode[] = ['palette', 'smooth', 'off'];
  opts.push({
    name: 'Colour grading',
    value: () => pipe.options.grade,
    change: (d) => {
      pipe.options.grade = cycle(GRADES, pipe.options.grade, d);
      store({ grade: pipe.options.grade });
    },
    desc: 'palette: limited-palette pixel look; smooth: graded without banding; off: raw colours.',
  });
  opts.push({
    name: 'Camera',
    value: () => renderer.cameraMode,
    change: (d) => {
      renderer.setCameraMode(cycle(CAMERA_MODES, renderer.cameraMode, d));
      store({ camera: renderer.cameraMode });
    },
    desc: 'First person, over the shoulder, or CDDA-style top-down (also V in game).',
  });
  opts.push(...extraOptions);
  const audio = getAudioEngine();
  if (audio) {
    const s = audio.settings;
    const vol = (key: 'master' | 'sfx' | 'music' | 'ambient' | 'ui', name: string, desc: string) =>
      opts.push({
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
      opts.push({ name, value: () => (s[key] ? 'on' : 'off'), change: () => (s[key] = !s[key]), desc });
    toggle('musicEnabled', 'Music', 'Play background music.');
    toggle('muted', 'Mute all', 'Silence everything.');
    toggle('hrtf', '3D audio (HRTF)', 'Binaural positioning; turn off for plain stereo.');
    toggle('occlusion', 'Sound occlusion', 'Muffle sounds behind walls.');
  } else {
    opts.push({ name: 'Audio', value: () => c('c_dark_gray', 'unavailable'), change: () => {}, desc: 'The audio engine is not running.' });
  }

  // Values may carry CDDA colour tags (c('c_light_red', '2 unbound')): shown as HTML.
  let sel = 0;
  const desc = h('div', { class: 'op-desc', attrs: { 'data-testid': 'options-desc' } });
  const change = (o: Opt, d: -1 | 1) => {
    o.change(d);
    list.setItems(opts);
    describe(o);
  };
  const describe = (o: Opt | undefined) => {
    if (o) desc.textContent = o.desc;
  };
  const list = scrollList<Opt>({
    items: opts,
    render: (o) => {
      const val = h('span', { html: o.value() || '›' });
      const left = h('button', { class: 'op-arrow', text: '‹', title: 'Previous' });
      const right = h('button', { class: 'op-arrow', text: '›', title: 'Next' });
      left.addEventListener('click', (e) => (e.stopPropagation(), list.select(opts.indexOf(o)), change(o, -1)));
      right.addEventListener('click', (e) => (e.stopPropagation(), list.select(opts.indexOf(o)), change(o, 1)));
      return h('div', { class: 'op-row', data: { name: o.name } }, h('span', { text: o.name }), h('span', { class: 'op-val' }, left, val, right));
    },
    onSelect: (o) => {
      sel = opts.indexOf(o);
      describe(o);
    },
    onActivate: (o) => change(o, 1),
  });
  list.el.classList.add('op-list');
  const win = openScreen(game, {
    id: 'scr.options',
    title: 'Options',
    group: 'scr.options',
    pauses: 'always',
    width: 'min(calc(var(--fs) * 34), 94vw)',
    height: 'min(calc(var(--fs) * 32), 90vh)',
    closeLabel: 'done',
    legend: [['↑↓', 'choose'], ['← → / Enter / click', 'change']],
    onKey: (e) => {
      const o = opts[sel];
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') return list.select(sel + (e.key === 'ArrowDown' ? 1 : -1)), true;
      if (!o) return false;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') return change(o, e.key === 'ArrowLeft' ? -1 : 1), true;
      if (e.key === 'Enter') return change(o, 1), true;
      return false;
    },
  });
  win.body.append(list.el, desc);
  win.body.style.overflow = 'hidden';
  list.select(0);
  return win;
}
