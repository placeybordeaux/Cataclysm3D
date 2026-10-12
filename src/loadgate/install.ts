import type { DebugApi } from '../debug';
import type { Game } from '../game/game';
import { tacticalPauseOf } from '../game/pause';
import type { Renderer } from '../render/renderer';
import { hud } from '../ui/hud';
import { registerOption } from '../ui/options';
import { GATE_MODES, GATE_MODE_DESC, isGateMode, LoadGate, type GateMode, type GateState } from './gate';
import './loadgate.css';

// Wires the load gate (gate.ts) into the game: while it is closed the game is held with a
// tactical-pause hold named 'loading' (Game.frame runs no ticks: no turns, no monster moves, no
// clock, vehicles stop where they are), the chunk manager gets a bigger meshing budget, and the
// player sees either the loading screen ('block') or a small note over the frozen live view
// ('soft'). Options > Load gate, `?loadgate=auto|block|soft|off` (wins over the stored choice),
// `cdda.loadGate(mode?)`.
//
// Armed by main.ts when gameplay starts (after the title screen / a load is applied): before
// that the title owns the screen and the load curtain (render/nearChunks.ts) covers the first
// near chunks.

const STORAGE_KEY = 'cdda3d.loadgate';
const HOLD = 'loading';
/** keys that keep working under the loading screen: Esc (the menu), F-keys (F3 overlay, F11) */
const PASS_KEYS = /^(Escape|F\d+)$/;

export interface LoadGateHandle {
  gate: LoadGate;
  /** start gating (gameplay began) */
  arm(): void;
  setMode(m: GateMode, persist?: boolean): GateMode;
}

function storedMode(): GateMode | null {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    return s && isGateMode(s) ? s : null;
  } catch {
    return null;
  }
}

export function installLoadGate(game: Game, renderer: Renderer, api: DebugApi, opts: { tip?: () => string } = {}): LoadGateHandle {
  const params = new URLSearchParams(location.search);
  const q = params.get('loadgate');
  if (q !== null && !isGateMode(q)) throw new Error(`?loadgate=${q}: expected ${GATE_MODES.join('|')}`);
  const gate = new LoadGate((q as GateMode | null) ?? storedMode() ?? 'auto');
  const chunks = renderer.chunks;
  const tp = tacticalPauseOf(game);
  let armed = false;
  let last: GateState | null = null;
  let closedTotal = 0;

  // ---- the loading screen (block) — plain DOM over everything but open menus
  const el = document.createElement('div');
  el.className = 'loadgate';
  el.innerHTML = `<div class="loadgate-box"><div class="loadgate-title">Loading surroundings</div>
    <div class="loadgate-bar"><div class="loadgate-fill"></div></div>
    <div class="loadgate-sub"></div><div class="loadgate-tip"></div></div>`;
  document.body.appendChild(el);
  const fill = el.querySelector('.loadgate-fill') as HTMLElement;
  const sub = el.querySelector('.loadgate-sub') as HTMLElement;
  const tipEl = el.querySelector('.loadgate-tip') as HTMLElement;
  let shownStyle: 'block' | 'soft' | null = null;

  const show = (s: GateState | null) => {
    // a menu (Esc, inventory) opened under the gate shows on its own: the game is held anyway
    const style = s?.closed && !game.player.dead ? s.style : null;
    const block = style === 'block' && !game.input.captured;
    if (block !== el.classList.contains('on')) {
      el.classList.toggle('on', block);
      if (block) tipEl.textContent = opts.tip?.() ?? '';
    }
    if (block && s) {
      fill.style.width = `${Math.round(s.progress * 100)}%`;
      sub.textContent = s.reason === 'core' ? 'Building the area around you…' : 'Catching up with the world ahead…';
    }
    if (style === 'soft' && s) hud.setBanner('loadgate', { text: 'Loading surroundings', sub: `${Math.round(s.progress * 100)}% · the world waits`, tone: 'info', small: true });
    else if (shownStyle === 'soft') hud.setBanner('loadgate', null);
    shownStyle = style;
  };

  // Under the loading screen gameplay keys do nothing (the game is held; a held W still walks
  // once it lifts, which is what you meant). Menus keep their keys.
  game.input.onPriorityPress?.((e) => {
    if (!last?.closed || last.style !== 'block' || game.input.captured || PASS_KEYS.test(e.key)) return false;
    return true;
  });

  renderer.beforeRender.push((dt) => {
    const p = game.player;
    const active = armed && !p.dead && gate.mode !== 'off';
    // (off: skip the scan entirely; it is ~20 chunk lookups x 3 levels, but nothing needs it)
    const inp = active ? chunks.missingAround(p.x, p.y, p.z, gate.tune.nearM, gate.tune.farM) : { core: 0, near: 0, far: 0, wanted: 0 };
    const s = gate.update(dt, inp, active);
    last = s;
    if (s.closed) closedTotal += dt;
    if (s.closedNow || s.openedNow) {
      tp.hold(HOLD, s.closed);
      chunks.gateBoost = s.closed;
      // clicks made while held must not all fire the moment it lifts
      if (s.openedNow) game.input.consumeClicks();
    }
    if (s.timedOut) console.warn(`[loadgate] gave up after ${gate.tune.maxHold} s with ${inp.far} chunks still unbuilt within ${gate.tune.farM} m (core ${inp.core}) at ${p.x.toFixed(0)},${p.y.toFixed(0)},${p.z}; not gating for ${gate.tune.suppress} s`);
    show(s);
  });

  registerOption({
    category: 'Display',
    name: 'Load gate',
    value: () => gate.mode,
    change: (d) => {
      const i = GATE_MODES.indexOf(gate.mode);
      setMode(GATE_MODES[(i + d + GATE_MODES.length) % GATE_MODES.length], true);
    },
    desc: 'Wait for the world around you to be built before the game goes on (after a load, a teleport, a new level, driving faster than the world streams in).\n' + GATE_MODES.map((m) => `${m}: ${GATE_MODE_DESC[m]}`).join('\n'),
  });

  const setMode = (m: GateMode, persist = false): GateMode => {
    if (!isGateMode(m)) throw new Error(`loadGate: expected ${GATE_MODES.join('|')}, not ${String(m)}`);
    gate.mode = m;
    if (persist)
      try {
        localStorage.setItem(STORAGE_KEY, m);
      } catch {
        // storage blocked: not persisted
      }
    return m;
  };

  const a = api as DebugApi & Record<string, unknown>;
  a.loadGate = (mode?: GateMode) => {
    if (mode !== undefined) setMode(mode);
    const p = game.player;
    return { mode: gate.mode, armed, ...last, closedSeconds: +closedTotal.toFixed(2), counts: { ...gate.counts }, missing: chunks.missingAround(p.x, p.y, p.z, gate.tune.nearM, gate.tune.farM), tune: gate.tune };
  };
  // (debug: the entity rule of src/render/surroundings.ts, for before/after comparisons)
  a.entityRule = (on?: boolean) => {
    if (on !== undefined) chunks.entityRule = on;
    return chunks.entityRule;
  };
  return { gate, arm: () => void (armed = true), setMode };
}
