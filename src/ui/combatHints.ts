import type { Game } from '../game/game';
import { activeWeapon } from '../game/bionicguns';
import type { Monster } from '../game/monster';
import type { PlayerCombat } from '../game/playercombat';
import { defenseOf } from '../game/combatfeel';
import { freeAim } from '../game/aimmodel';
import { progressionOf } from '../progression/registry';
import { cssColor } from './framework';

// First-fight onboarding (combat round 3): a new player's first zombies teach the three things
// the default aim model adds — the crosshair sways, headshots count, guard the blow — with one
// short line by the crosshair at the moment it matters, never a text wall:
//
//   aim_sway      raising a gun at a hostile the first times: "Your aim sways — fire as it crosses"
//   aim_headshot  after a body hit: "Aim for the head — ×2 damage"            (learned: a headshot)
//   melee_guard   a zombie winding up a blow at arm's length: "Hold right mouse: guard · Space: side-step"
//                 (shown until the blow lands or the guard goes up; learned: guarded twice)
//
// Each hint shows at most MAX_SHOWS times per profile (localStorage), stops once the player has
// done the thing, never twice within GAP seconds, one at a time, and not at all with the
// profile's Discovery hints off. The first showing also files the longer text in the Survival
// Journal (progression/discovery.ts: aim_sway, aim_headshot, melee_guard).

export type CombatHintId = 'aim_sway' | 'aim_headshot' | 'melee_guard';

export const HINT_TEXT: Record<CombatHintId, string> = {
  aim_sway: 'Your aim sways — fire as it crosses',
  aim_headshot: 'Aim for the head — ×2 damage',
  melee_guard: 'Hold right mouse: guard · Space: side-step',
};

const STORE = 'cdda3d.combatHints';
export const MAX_SHOWS = 3;
const GAP = 20;
const SHOW = 3;

export interface HintState {
  shown: Partial<Record<CombatHintId, number>>;
  learned: Partial<Record<CombatHintId, boolean>>;
  guards?: number;
}

/** The rules without the DOM (tests): whether a hint may show now, and the bookkeeping. */
export class HintRules {
  state: HintState;
  private lastAt: Partial<Record<CombatHintId, number>> = {};
  current: { id: CombatHintId; until: number } | null = null;

  constructor(state?: HintState, private save: (s: HintState) => void = () => {}) {
    this.state = state ?? { shown: {}, learned: {} };
  }

  canShow(id: CombatHintId, now: number): boolean {
    if (this.current && this.current.until > now) return false;
    if (this.state.learned[id]) return false;
    if ((this.state.shown[id] ?? 0) >= MAX_SHOWS) return false;
    return now - (this.lastAt[id] ?? -Infinity) >= GAP;
  }

  /** Show `id` (if allowed) until `now + seconds`; returns whether it went up. */
  show(id: CombatHintId, now: number, seconds = SHOW): boolean {
    if (!this.canShow(id, now)) return false;
    this.current = { id, until: now + seconds };
    this.lastAt[id] = now;
    this.state.shown[id] = (this.state.shown[id] ?? 0) + 1;
    this.save(this.state);
    return true;
  }

  /** The player did it: this hint never shows again (and goes away if it's up). */
  learn(id: CombatHintId): void {
    if (this.state.learned[id]) return;
    this.state.learned[id] = true;
    if (this.current?.id === id) this.current = null;
    this.save(this.state);
  }

  dismiss(id: CombatHintId): void {
    if (this.current?.id === id) this.current = null;
  }

  text(now: number): { id: CombatHintId; text: string; fade: number } | null {
    const c = this.current;
    if (!c || c.until <= now) return null;
    return { id: c.id, text: HINT_TEXT[c.id], fade: Math.min(1, (c.until - now) / 0.4) };
  }
}

function load(): HintState | undefined {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) ?? 'null');
    return v && typeof v === 'object' && v.shown && v.learned ? v : undefined;
  } catch {
    return undefined;
  }
}

function store(s: HintState): void {
  try {
    localStorage.setItem(STORE, JSON.stringify(s));
  } catch {
    // not persisted: the hints may show again next session
  }
}

export class CombatHints {
  readonly el: HTMLDivElement;
  readonly rules = new HintRules(load(), store);
  private time = 0;
  private aimingFor = 0;
  private swayedThisAim = false;
  private windup: Monster | null = null;

  constructor(private game: Game, private combat: PlayerCombat, root: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'combat-hint';
    Object.assign(this.el.style, {
      position: 'absolute', left: '50%', top: 'calc(50% + 44px)', transform: 'translateX(-50%)', whiteSpace: 'nowrap', pointerEvents: 'none',
      color: cssColor('c_light_cyan'), textShadow: '1px 1px 0 #000, -1px -1px 0 #000', background: 'rgba(0,0,0,.45)', padding: '0 6px',
      display: 'none', zIndex: '5',
    });
    root.appendChild(this.el);
    game.events.on('playerAttack', (e) => {
      if (!freeAim() || e.kind !== 'gun' || !(e.outcome === 'hit' || e.outcome === 'crit' || e.outcome === 'kill')) return;
      if (/HEADSHOT/.test(e.reason ?? '')) return;
      // Only after the sway lesson has been seen, so the two don't pile up in one fight.
      if ((this.rules.state.shown.aim_sway ?? 0) > 0 || this.rules.state.learned.aim_sway) this.show('aim_headshot');
    });
    game.events.on('playerHeadshot', () => this.rules.learn('aim_headshot'));
    game.events.on('monsterAttack', (e) => {
      const m = e.monster as Monster;
      const p = game.player;
      if (e.phase === 'windup') {
        if (p.inv.wielded?.isGun() || m.z !== p.z || Math.hypot(m.x - p.x, m.y - p.y) > 3) return;
        // (readied but mid-swing counts: the guard comes back with the stance)
        if (defenseOf(p).guarding || this.combat.stance?.ready) return;
        if (this.show('melee_guard', Math.max(0.6, (e.seconds ?? 0.5) + 0.3))) this.windup = m;
      } else if (m === this.windup) {
        // The blow landed or whiffed: guarded (or side-stepped) through it counts as practice.
        const def = defenseOf(p);
        if (def.guarding || def.dodgeWindow > 0) this.rules.state.guards = (this.rules.state.guards ?? 0) + 1;
        if ((this.rules.state.guards ?? 0) >= 2) this.rules.learn('melee_guard');
        this.rules.dismiss('melee_guard');
        this.windup = null;
      }
    });
  }

  private show(id: CombatHintId, seconds?: number): boolean {
    const prog = progressionOf(this.game);
    if (prog && !prog.profile.data.options.hints) return false;
    const first = !(this.rules.state.shown[id] ?? 0);
    if (!this.rules.show(id, this.time, seconds)) return false;
    // The journal keeps the longer text (no toast: the crosshair line is the lesson).
    if (first) prog?.profile.mark('discovered', id);
    return true;
  }

  /** Per render frame (src/aim.ts): watch for the sway moment, draw the line under the reticle. */
  frame(dt: number, reticle: { x: number; y: number }, visible: boolean): void {
    this.time += dt;
    const p = this.game.player;
    const c = this.combat;
    const aiming = visible && freeAim() && !!activeWeapon(this.game)?.isGun() && (this.game.input.mouseButtons & 4) !== 0;
    this.aimingFor = aiming ? this.aimingFor + dt : 0;
    if (!aiming) this.swayedThisAim = false;
    if (aiming && !this.swayedThisAim && this.aimingFor > 0.4 && c.aim.amp > (0.25 * Math.PI) / 180 && c.rangedTarget(35)) {
      this.swayedThisAim = true;
      this.show('aim_sway');
    }
    // Guarding while the tell plays: the hint has done its job.
    if (this.rules.current?.id === 'melee_guard' && defenseOf(p).guarding) this.rules.dismiss('melee_guard');
    const t = visible ? this.rules.text(this.time) : null;
    this.el.style.display = t ? '' : 'none';
    if (t) {
      if (this.el.textContent !== t.text) this.el.textContent = t.text;
      this.el.style.opacity = String(t.fade);
      this.el.style.transform = `translate(calc(-50% + ${reticle.x.toFixed(1)}px), ${Math.max(0, reticle.y).toFixed(1)}px)`;
    }
  }
}
