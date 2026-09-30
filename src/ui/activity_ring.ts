// Timed-activity feedback at the crosshair (docs/ADAPTATION.md). CDDA's long actions are
// minutes of game time; here they're a few real seconds during which walking cancels them.
// Playtests kept hitting "I pressed e on the fireplace and nothing happened": the only
// progress was a bar at the bottom of the screen, far from where the player looks, and the
// "You stop lighting the fire." line scrolled by in the log. So every timed action now draws
// a progress ring around the crosshair with "stand still", and an interruption flashes there
// too, with the reason.
//
// Options > Activity progress: Crosshair ring (default) · Bottom bar (the old HUD bar only) ·
// Both. ?actui=ring|bar|both overrides for a session.

import type { Game } from '../game/game';
import type { Activity } from '../game/activity';
import { registerOption } from './options';
import { surfacesOpen } from '../ui2/host';
import './activity_ring.css';

export type ActivityUiMode = 'ring' | 'bar' | 'both';
const MODES: ActivityUiMode[] = ['ring', 'bar', 'both'];
const KEY = 'cdda3d.activityUi';

export function activityUiMode(): ActivityUiMode {
  const q = new URLSearchParams(location.search).get('actui');
  if (q !== null) {
    if (!(MODES as string[]).includes(q)) throw new Error(`?actui=${q}: expected one of ${MODES.join(', ')}`);
    return q as ActivityUiMode;
  }
  try {
    const s = localStorage.getItem(KEY);
    if (s && (MODES as string[]).includes(s)) return s as ActivityUiMode;
  } catch {
    // storage blocked: default
  }
  return 'ring';
}

/** Whether the HUD's bottom-centre activity bar should draw (hud_modern.ts asks). */
export function activityBarEnabled(): boolean {
  return activityUiMode() !== 'ring';
}

/** First letter up: activity names are written for "You stop <name>." */
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * What the ring says for an activity. Sleeping/waiting aren't "stand still" jobs (moving wakes
 * or stops you, but you're not working at something); everything else is.
 */
export function ringText(a: { spec: { name: string; kind?: string; interruptible?: boolean } }): { title: string; hint: string } {
  const n = a.spec.name;
  if (/^(sleeping|waiting|resting)/.test(n) || a.spec.kind === 'sleep' || a.spec.kind === 'wait') return { title: cap(n), hint: 'move to stop' };
  return { title: cap(n), hint: 'stand still · moving stops it' };
}

const R = 20; // ring radius, in the SVG's own units (scaled by --u through CSS)
const CIRC = 2 * Math.PI * R;

let registered = false;

export function installActivityRing(game: Game, lastMessage: () => string | null): void {
  if (!registered) {
    registered = true;
    registerOption({
      name: 'Activity progress',
      value: () => ({ ring: 'Crosshair ring', bar: 'Bottom bar', both: 'Both' })[activityUiMode()],
      change: (d) => {
        const i = MODES.indexOf(activityUiMode());
        try {
          localStorage.setItem(KEY, MODES[(i + (d ?? 1) + MODES.length) % MODES.length]);
        } catch {
          // not persisted
        }
      },
      desc: 'Where timed actions (lighting a fire, crafting, butchering…) show their progress: a ring around the crosshair with "stand still", the bar above the hotbar, or both.',
    });
  }

  const el = document.createElement('div');
  el.className = 'act-ring';
  el.setAttribute('data-testid', 'activity-ring');
  el.innerHTML = `<svg viewBox="-26 -26 52 52" aria-hidden="true">
      <circle class="act-track" r="${R}" />
      <circle class="act-fill" r="${R}" stroke-dasharray="${CIRC.toFixed(2)}" stroke-dashoffset="${CIRC.toFixed(2)}" transform="rotate(-90)" />
    </svg>
    <div class="act-text"><div class="act-title"></div><div class="act-hint"></div></div>`;
  document.body.appendChild(el);
  const fill = el.querySelector<SVGCircleElement>('.act-fill')!;
  const title = el.querySelector<HTMLElement>('.act-title')!;
  const hint = el.querySelector<HTMLElement>('.act-hint')!;

  let prev: Activity | null = null;
  let flashUntil = 0;
  let lastKey = '';

  const visible = () => {
    const p = game.player;
    return !game.input.captured && surfacesOpen() === 0 && !p.dead && !p.isAsleep() && !game.paused;
  };

  const frame = (now: number) => {
    requestAnimationFrame(frame);
    const mode = activityUiMode();
    const a = game.activities.current;
    // An activity that vanished before its time ran out was interrupted: say so where the
    // player is looking, with the reason the manager just logged ("You stop lighting the fire.").
    if (prev && a !== prev && prev.elapsed < prev.spec.duration) {
      flashUntil = now + 1800;
      el.dataset.state = 'stopped';
      title.textContent = lastMessage() ?? `Stopped ${prev.spec.name}`;
      hint.textContent = ringText(prev).hint === 'move to stop' ? '' : 'press the key again and stand still to retry';
      fill.style.strokeDashoffset = `${(CIRC * (1 - prev.fraction)).toFixed(2)}`;
      lastKey = '';
    }
    prev = a;
    // The interaction prompt ("[e] Go down the stairs") sits just under the crosshair where the
    // ring is; while you're standing still at a job it's noise, so the ring hides it.
    document.body.classList.toggle('act-ring-on', el.classList.contains('on'));
    if (mode === 'bar' || !visible()) {
      el.classList.remove('on');
      return;
    }
    if (a) {
      el.dataset.state = 'running';
      flashUntil = 0;
      // Crafting/construction/reading draw their own labelled bar under the crosshair (craft2
      // overlay): the ring alone then, no second caption.
      const t = ringText(a);
      const key = `${t.title}|${a.spec.customUi ? 1 : 0}`;
      if (key !== lastKey) {
        lastKey = key;
        title.textContent = a.spec.customUi ? '' : t.title;
        hint.textContent = a.spec.customUi ? '' : t.hint;
      }
      fill.style.strokeDashoffset = `${(CIRC * (1 - a.fraction)).toFixed(2)}`;
      el.classList.add('on');
      return;
    }
    el.classList.toggle('on', now < flashUntil);
  };
  requestAnimationFrame(frame);
}
