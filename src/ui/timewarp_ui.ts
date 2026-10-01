// Fast-forward controls (src/game/timewarp.ts): the key (+ by default, rebindable), the speed
// line under the crosshair activity ring ("Reading · ×4 · 20 min left (~3 s)  » [+]"), and
// cheaper drawing while time runs fast.
//
// Options:
//   Fast-forward key: Cycle (default: each press ×1 → ×2 → ×4 → ×8 → ×16 → ×1) ·
//                     Hold (top speed while held, ×1 when released)
//   Fast-forward drawing: Lighter (default: the 3D view redraws at most 30 times a second
//                     while fast-forwarding, leaving the frame to the simulation) · Full
// ?ffkey=cycle|hold and ?ffdraw=lite|full override for a session.

import type { Game } from '../game/game';
import type { Renderer } from '../render/renderer';
import type { DebugApi } from '../debug';
import { SPEED_STEPS, timeWarp, type TimeWarp, type WarpKeyMode } from '../game/timewarp';
import { clockScale } from '../core/time';
import { createItem } from '../game/item';
import { startReading, type ReadMode } from '../game/reading';
import { fmtDuration } from '../ui2/logic/items';
import { surfacesOpen } from '../ui2/host';
import { registerOption } from './options';
import './timewarp_ui.css';

type DrawMode = 'lite' | 'full';
const KEY_MODE = 'cdda3d.ffKey';
const DRAW_MODE = 'cdda3d.ffDraw';

function stored<T extends string>(param: string, key: string, allowed: readonly T[], def: T): T {
  const q = new URLSearchParams(location.search).get(param);
  if (q !== null) {
    if (!(allowed as readonly string[]).includes(q)) throw new Error(`?${param}=${q}: expected one of ${allowed.join(', ')}`);
    return q as T;
  }
  try {
    const s = localStorage.getItem(key);
    if (s && (allowed as readonly string[]).includes(s)) return s as T;
  } catch {
    // storage blocked: default
  }
  return def;
}
function store(key: string, v: string): void {
  try {
    localStorage.setItem(key, v);
  } catch {
    // not persisted
  }
}

export const ffKeyMode = (): WarpKeyMode => stored('ffkey', KEY_MODE, ['cycle', 'hold'] as const, 'cycle');
export const ffDrawMode = (): DrawMode => stored('ffdraw', DRAW_MODE, ['lite', 'full'] as const, 'lite');

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "×8" or "×8 (capped ×5)" when the machine can't keep up. */
export function speedLabel(wanted: number, effective: number): string {
  return wanted > effective ? `×${wanted} (capped ×${effective})` : `×${effective}`;
}

/**
 * The speed line: "Reading · ×4 · 20 min left (~3 s)". `realLeft` is real seconds left at the
 * current speed; sleeping has no fixed end, so it shows the clock instead.
 */
export function speedLine(o: { name: string; wanted: number; effective: number; gameLeft: number; realLeft: number; sleeping: boolean; clock: string }): string {
  const verb = cap(o.name.split(' ')[0]);
  const sp = speedLabel(o.wanted, o.effective);
  if (o.sleeping) return `${verb} · ${sp} · ${o.clock}`;
  const real = o.realLeft >= 1 ? ` (~${fmtDuration(Math.round(o.realLeft))})` : '';
  return `${verb} · ${sp} · ${fmtDuration(Math.max(0, o.gameLeft))} left${real}`;
}

let optionsRegistered = false;

export function installTimeWarpUi(game: Game, renderer: Renderer, api: DebugApi): TimeWarp {
  const w = timeWarp(game);
  w.keyMode = ffKeyMode();
  if (!optionsRegistered) {
    optionsRegistered = true;
    registerOption({
      name: 'Fast-forward key',
      value: () => (ffKeyMode() === 'hold' ? 'Hold for top speed' : 'Press to step ×1-×16'),
      change: () => {
        store(KEY_MODE, ffKeyMode() === 'hold' ? 'cycle' : 'hold');
        timeWarp(game).keyMode = ffKeyMode();
      },
      desc: 'While reading, crafting, waiting or sleeping, the fast-forward key (+ by default) runs time faster: each press steps ×1, ×2, ×4, ×8, ×16 (Press), or it runs at top speed while you hold it (Hold). Anything dangerous drops it back to ×1.',
    });
    registerOption({
      name: 'Fast-forward drawing',
      value: () => (ffDrawMode() === 'lite' ? 'Lighter (30 fps)' : 'Full'),
      change: () => store(DRAW_MODE, ffDrawMode() === 'lite' ? 'full' : 'lite'),
      desc: 'While time runs fast, the view can redraw less often (Lighter) so more of each frame goes to the simulation and the speed cap is higher on slower machines.',
    });
  }

  // ------------------------------------------------------------------ key
  const notAvailable = () => game.message('Fast-forward works during timed actions: reading, crafting, waiting, sleeping.', 'c_light_gray');
  game.keys.register('fast_forward', 'Fast-forward the current action (reading, crafting, waiting, sleeping)', () => {
    if (!w.available()) return notAvailable();
    if (w.keyMode === 'hold') {
      w.holding = true;
      w.dropped = null;
      w.apply();
    } else w.cycle();
  });
  // Hold mode needs the release, which Keys doesn't report: remember which physical key it was.
  const heldCodes = new Set<string>();
  addEventListener('keydown', (e) => {
    if (game.keys.keysFor('fast_forward').includes(e.key)) heldCodes.add(e.code);
  }, true);
  const release = (e: KeyboardEvent) => {
    if (!heldCodes.delete(e.code) || heldCodes.size) return;
    if (w.holding) {
      w.holding = false;
      w.apply();
    }
  };
  addEventListener('keyup', release, true);
  addEventListener('blur', () => {
    heldCodes.clear();
    w.holding = false;
    w.apply();
  });

  // ------------------------------------------------------------------ cheaper frames + the cap
  // Wraps the renderer's frame (not a hot-file edit): times the draw for the governor, and in
  // Lighter mode skips draws while fast-forwarding so the frame goes to the simulation. A
  // skipped draw leaves the previous image on the canvas; the HUD (DOM) keeps updating.
  const draw = renderer.render.bind(renderer);
  let lastDraw = 0;
  let lastFrame = 0;
  let drawsSkipped = 0;
  renderer.render = () => {
    const now = performance.now();
    const frameS = lastFrame ? (now - lastFrame) / 1000 : 1 / 60;
    lastFrame = now;
    const fast = game.simSpeed > 1;
    const skip = fast && ffDrawMode() === 'lite' && now - lastDraw < 1000 / 30 - 2;
    let other: number | null = null;
    if (skip) drawsSkipped++;
    else {
      lastDraw = now;
      draw();
      other = performance.now() - now;
    }
    // Only learn while an activity runs: walking around town says nothing about a tick spent
    // reading in a quiet room, and the cap must be ready the moment the key is pressed.
    if (game.activities.current && frameS > 0) w.governor.observe(game.simCost.ms, game.simCost.ticks, other, frameS);
    w.apply();
  };

  // ------------------------------------------------------------------ the speed line
  const el = document.createElement('div');
  el.className = 'ff-line';
  el.setAttribute('data-testid', 'fast-forward');
  const text = document.createElement('span');
  text.className = 'ff-text';
  const btn = document.createElement('button');
  btn.className = 'ff-btn';
  btn.type = 'button';
  btn.title = 'Fast-forward';
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    if (w.available()) w.cycle();
  });
  const note = document.createElement('div');
  note.className = 'ff-note';
  el.append(text, btn, note);
  document.body.appendChild(el);
  let noteUntil = 0;
  let lastDropped: string | null = null;
  let lastKey = '';

  const frame = (now: number) => {
    requestAnimationFrame(frame);
    const a = game.activities.current;
    const p = game.player;
    if (w.dropped !== lastDropped) {
      lastDropped = w.dropped;
      if (w.dropped) noteUntil = now + 3000;
    }
    const show = !!a && w.available() && !game.input.captured && surfacesOpen() === 0 && !p.dead;
    if (!show) {
      el.classList.remove('on');
      return;
    }
    const wanted = w.wanted(), eff = w.effective();
    const sleeping = a!.spec.kind === 'sleep' || /^sleeping/.test(a!.spec.name);
    const gameLeft = a!.spec.duration - a!.elapsed;
    const realLeft = gameLeft / (clockScale() * game.clock.warp * eff);
    const line = speedLine({ name: a!.spec.name, wanted, effective: eff, gameLeft, realLeft, sleeping, clock: game.clock.format().replace(/^.*day \d+ /, '') });
    const keyL = game.keys.label('fast_forward');
    const top = wanted >= SPEED_STEPS[SPEED_STEPS.length - 1];
    const hint = w.keyMode === 'hold' ? `» hold [${keyL}]` : top ? `» [${keyL}] ×1` : `» [${keyL}] faster`;
    const noteText = now < noteUntil && w.dropped ? `Back to ×1: ${w.dropped}` : '';
    const key = `${line}|${hint}|${noteText}|${eff > 1 ? 1 : 0}`;
    if (key !== lastKey) {
      lastKey = key;
      text.textContent = line;
      btn.textContent = hint;
      note.textContent = noteText;
      el.dataset.fast = eff > 1 ? '1' : '0';
      el.dataset.capped = wanted > eff ? '1' : '0';
    }
    el.classList.add('on');
  };
  requestAnimationFrame(frame);

  api.timewarp = {
    state: () => ({
      available: w.available(), requested: w.requested, wanted: w.wanted(), effective: w.effective(), simSpeed: game.simSpeed,
      cap: w.governor.cap, affordable: w.governor.affordable(), tickMs: +w.governor.tickMs.toFixed(3), otherMs: +w.governor.otherMs.toFixed(2),
      frameMs: +(w.governor.frameS * 1000).toFixed(1), dropped: w.dropped, keyMode: w.keyMode, drawMode: ffDrawMode(), drawsSkipped,
      line: el.classList.contains('on') ? `${text.textContent} ${btn.textContent}` : null,
    }),
    set: (s: number) => w.set(s),
    /** Setup for measurements: give a book and start reading it (default: until done). */
    read: (id: string, mode: ReadMode = 'until_done') => {
      const it = createItem(game.data, id);
      if (!game.player.inv.giveNew(it)) throw new Error(`cdda.timewarp.read: no room for ${id}`);
      return startReading(game, it, mode);
    },
  };
  return w;
}
