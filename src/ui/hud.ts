import type { Game } from '../game/game';
import { BODY_PARTS, MAIN_PARTS } from '../game/bodyparts';
import { colorize, c, cssColor } from './framework';
import {
  hpBar, hungerColor, logLine, MessageLog, moraleFace, painColor, sleepinessColor, staminaBar, tempColor, thirstColor,
} from './format';
import { omtLabel, playerOmt, type UiContext } from './context';
import { attackCooldownSeconds, attackSpeedMoves, swingSpeedRating } from '../game/combat';
import { ModernHud, type BannerSpec, type HudPrefs } from './hud_modern';

// The always-on HUD: the crosshair with a context prompt under it and the hit marker (here),
// plus the modern HUD (src/ui/hud_modern.ts: vitals, needs, compass, clock, weapon, message
// feed, activity bar) — or, with Options > HUD style = Detailed, CDDA's sidebar (rendered here,
// shown by the modern HUD in its restyled frame). Pure overlay, rebuilt a few times a second.
//
// Other systems talk to it through `hud` (exported below), no instance needed:
//   hud.setPrompt('[e] Open door')            // sticky until setPrompt(null)
//   const off = hud.addPromptProvider((g) => doorUnderCrosshair(g) ? '[e] Open door' : null)
//   hud.safeMode = { text: 'DANGER', color: 'c_red' }
//   hud.setBanner('pause', { text: 'PAUSED', sub: 'Space to resume', tone: 'warn' })  // top centre, under the compass

export type PromptProvider = (game: Game) => string | null | undefined;

const providers: PromptProvider[] = [];
/** Extra sidebar lines (e.g. bionic power) inserted under the stats; CDDA-tagged HTML. */
const sidebarProviders: ((game: Game) => string[] | null)[] = [];
let explicitPrompt: string | null = null;

export const hud = {
  /** Show a fixed prompt under the crosshair (CDDA-tagged text allowed); null clears it. */
  setPrompt(text: string | null): void {
    explicitPrompt = text;
  },
  /**
   * Register a per-frame prompt source. The first provider returning text wins (after an
   * explicit setPrompt). Returns an unregister function.
   */
  addPromptProvider(fn: PromptProvider): () => void {
    providers.push(fn);
    return () => {
      const i = providers.indexOf(fn);
      if (i >= 0) providers.splice(i, 1);
    };
  },
  /** Add lines to the sidebar (under the stats block). Returns an unregister function. */
  addSidebarProvider(fn: (game: Game) => string[] | null): () => void {
    sidebarProviders.push(fn);
    return () => {
      const i = sidebarProviders.indexOf(fn);
      if (i >= 0) sidebarProviders.splice(i, 1);
    };
  },
  /** Sidebar safe-mode indicator (placeholder until the monster system drives it). */
  safeMode: { text: 'SAFE', color: 'c_green' } as { text: string; color: string },
  /** The prompt currently shown (for tests). */
  currentPrompt: null as string | null,
  /**
   * Status banner slot, top centre under the compass (PAUSED, SLEEPING, …): one banner per id,
   * null removes it. Works before the HUD exists (kept and shown once it does).
   */
  setBanner(id: string, spec: BannerSpec | null): void {
    if (spec) pendingBanners.set(id, spec);
    else pendingBanners.delete(id);
    modern?.setBanner(id, spec);
  },
  /** Modern HUD preferences (Options > HUD style / HUD width). */
  prefs(): HudPrefs | null {
    return modern?.prefs ?? null;
  },
  setPrefs(p: Partial<HudPrefs>): void {
    modern?.setPrefs(p);
  },
};

const pendingBanners = new Map<string, BannerSpec>();
let modern: ModernHud | null = null;

export const promptProviders: readonly PromptProvider[] = providers;

const WEATHER: Record<string, [string, string]> = {
  clear: ['Sunny', 'c_light_cyan'],
  rain: ['Rain', 'c_blue'],
  storm: ['Thunder Storm', 'c_dark_gray'],
  snow: ['Snowing', 'c_white'],
};

/** movement_mode panel_char / panel_color from CDDA's move_modes.json. */
const MOVE_MODE: Record<string, [string, string]> = {
  walk: ['W', 'c_white'],
  run: ['R', 'c_red'],
  crouch: ['C', 'c_light_blue'],
};

export class Hud {
  readonly el: HTMLElement;
  readonly log = new MessageLog();
  private side: HTMLElement;
  private logEl: HTMLElement;
  private cross: HTMLElement;
  private promptEl: HTMLElement;
  private hitEl: HTMLElement;
  private hitUntil = 0;
  private visible = true;
  private lastSide = 0;
  private raf = 0;
  readonly modern: ModernHud;

  constructor(private ctx: UiContext, root: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'hud';
    this.el.innerHTML = `<div class="hud-side"></div><div class="hud-log"></div>
      <div class="hud-cross"><i></i><b></b><s class="hud-hit"><u></u><u></u><u></u><u></u></s></div><div class="hud-prompt"></div><div class="hud-activity"></div>`;
    root.appendChild(this.el);
    this.side = this.el.querySelector('.hud-side')!;
    this.logEl = this.el.querySelector('.hud-log')!;
    this.cross = this.el.querySelector('.hud-cross')!;
    this.promptEl = this.el.querySelector('.hud-prompt')!;
    this.hitEl = this.el.querySelector('.hud-hit')!;
    this.modern = modern = new ModernHud(ctx, this.log, this.side, () => ctx.game.keys.handler('messages')?.());
    for (const [id, b] of pendingBanners) this.modern.setBanner(id, b);
    // Sidebar extras (bionic power, martial arts style, fire mode) go under the weapon.
    this.modern.extraProviders = () => sidebarProviders.flatMap((f) => f(ctx.game) ?? []);
    // Hit marker: four diagonal ticks around the crosshair, coloured by how the blow landed.
    ctx.game.events.on('playerAttack', (e) => {
      if (e.outcome === 'whiff' || e.outcome === 'miss') return;
      this.hitEl.className = `hud-hit on ${e.outcome}`;
      this.hitUntil = performance.now() + (e.outcome === 'hit' || e.outcome === 'block' ? 140 : 260);
    });
    ctx.game.events.on('message', (m) => {
      this.log.add(m.text, m.color, performance.now(), ctx.game.clock.seconds);
      this.modern.onMessage();
    });
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.frame();
    };
    this.raf = requestAnimationFrame(loop);
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.el.style.display = v ? '' : 'none';
    this.modern.setVisible(v);
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.el.remove();
    this.modern.el.remove();
    this.side.remove();
    if (modern === this.modern) modern = null;
  }

  /** Called every animation frame; the heavy sidebar rebuild is throttled. */
  frame(): void {
    if (!this.visible) return;
    const now = performance.now();
    const g = this.ctx.game;
    // Crosshair only makes sense in first/third person; top-down aims with the mouse later.
    this.cross.style.display = this.ctx.renderer.cameraMode === 'top' ? 'none' : '';
    if (this.hitUntil && now > this.hitUntil) {
      this.hitUntil = 0;
      this.hitEl.className = 'hud-hit';
    }
    this.renderPrompt();
    this.modern.frame(now);
    // The CDDA sidebar only renders while the Detailed HUD shows it.
    if (now - this.lastSide > 200 && this.modern.prefs.detailed) {
      this.lastSide = now;
      this.renderSidebar();
    }
    void g;
  }

  private renderPrompt(): void {
    let text = explicitPrompt;
    if (text === null && !this.ctx.game.input.captured) {
      for (const p of providers) {
        const t = p(this.ctx.game);
        if (t) {
          text = t;
          break;
        }
      }
    }
    if (text !== hud.currentPrompt) {
      hud.currentPrompt = text;
      this.promptEl.innerHTML = text ? colorize(text) : '';
      this.promptEl.style.display = text ? '' : 'none';
    }
  }

  /** Legacy log strip (hidden by the modern HUD's CSS; its feed replaces it). */
  renderLog(): void {
    const now = performance.now();
    const recent = this.log.recent(8);
    let html = '';
    for (const e of recent) {
      const age = (now - e.time) / 1000;
      // Messages stay fully readable for 8 s, then fade out over the next 12 s like a toast.
      const alpha = age < 8 ? 1 : Math.max(0, 1 - (age - 8) / 12);
      if (alpha <= 0) continue;
      const col = e.color ?? 'c_light_gray';
      html += `<div style="opacity:${alpha.toFixed(2)};color:${cssColor(col)}">${colorize(logLine(e))}</div>`;
    }
    this.logEl.innerHTML = html;
  }

  renderSidebar(): void {
    const { game } = this.ctx;
    const p = game.player;
    const L: string[] = [];
    const lbl = (s: string) => c('c_light_gray', s);

    // --- place / time / weather
    const om = playerOmt(this.ctx);
    const omt = omtLabel(this.ctx, om.x, om.y, om.z);
    const place = omt ? omt.name : 'unknown';
    L.push(`${lbl('Place:')} ${c('c_white', place)}${p.z !== 0 ? c('c_light_gray', ` (z${p.z > 0 ? '+' : ''}${p.z})`) : ''}`);
    const h = game.clock.hourOfDay;
    const day = h >= 6 && h < 20;
    const sun = day ? c('c_yellow', '☼') : c('c_light_blue', '☾');
    L.push(`${lbl('Time :')} ${c('c_white', game.clock.format())} ${sun}`);
    const wk = this.ctx.renderer.weather?.kind ?? 'clear';
    const [wname, wcol] = wk === 'clear' && !day ? ['Clear', 'c_cyan'] : WEATHER[wk] ?? [wk, 'c_white'];
    L.push(`${lbl('Sky  :')} ${c(wcol, wname)}   ${lbl('Safe:')} ${c(hud.safeMode.color, hud.safeMode.text)}`);
    L.push(sep());

    // --- body part HP, two columns like CDDA's "compact" layout
    const parts = MAIN_PARTS.map((bp) => {
      const hp = p.hp[bp];
      const b = hpBar(hp.cur, hp.max);
      const broken = p.isLimbBroken(bp);
      const name = BODY_PARTS[bp].heading.padEnd(6);
      return `${c(broken ? 'c_red' : 'c_light_gray', name)}${c(b.color, b.text.padEnd(5))}`;
    });
    for (let i = 0; i < parts.length; i += 2) L.push(`${parts[i]}  ${parts[i + 1]}`);
    const st = staminaBar(p.stamina, p.staminaMax());
    L.push(`${c('c_light_gray', 'STAM'.padEnd(6))}${c(st.color, st.text.padEnd(5))}  ${lbl('Speed ')}${c(p.speed < 100 ? 'c_red' : p.speed > 100 ? 'c_green' : 'c_white', String(p.speed))}`);
    L.push(sep());

    // --- stats
    const stat = (n: string, v: number, base: number) => `${lbl(n)} ${c(v < base ? 'c_red' : v > base ? 'c_green' : 'c_white', String(v).padStart(2))}`;
    L.push(`${stat('Str', p.str, p.str_base)}  ${stat('Dex', p.dex, p.dex_base)}  ${stat('Int', p.int, p.int_base)}  ${stat('Per', p.per, p.per_base)}`);
    const morale = p.morale.level();
    L.push(`${lbl('Mood:')} ${colorize(moraleFace(morale, this.ctx.data.moodFaces))}  ${lbl('Focus:')} ${c('c_white', String(Math.round(p.focus)))}  ${lbl('Move:')} ${c(MOVE_MODE[p.moveMode][1], MOVE_MODE[p.moveMode][0])}`);
    for (const f of sidebarProviders) L.push(...(f(game) ?? []));

    // --- needs (CDDA only shows a label when not normal)
    const needs: string[] = [];
    const hs = p.hungerState();
    if (hs) needs.push(c(hungerColor(hs), hs));
    const th = p.thirstDescription();
    if (th) needs.push(c(thirstColor(th), th));
    const sl = p.sleepinessDescription();
    if (sl) needs.push(c(sleepinessColor(sl), sl));
    const tp = p.bodyTempDescription();
    needs.push(c(tempColor(tp), tp));
    const pain = p.perceivedPain();
    if (pain > 0) needs.push(c(painColor(pain), p.painDescription()));
    L.push(needs.join('  '));
    L.push(sep());

    // --- weapon
    const w = p.inv.wielded;
    // Real-time swing interval next to the weapon, coloured by how sluggish it is.
    const swing = w?.isGun() ? '' : ` ${c(swingSpeedRating(attackSpeedMoves(p, w)).color, `${attackCooldownSeconds(p, w).toFixed(1)}s`)}`;
    L.push(`${lbl('Wield:')} ${c(w ? 'c_white' : 'c_light_gray', w ? w.name() : 'fists')}${swing}`);
    const wt = p.inv.weightCarried(), cap = p.inv.weightCapacity();
    L.push(`${lbl('Weight:')} ${c(wt > cap ? 'c_red' : 'c_white', (wt / 1000).toFixed(1))}${c('c_light_gray', '/' + (cap / 1000).toFixed(1) + ' kg')}`);

    // --- effects (one line per distinct visible effect name)
    const seen = new Set<string>();
    const eff: string[] = [];
    for (const e of p.effects.all()) {
      const n = e.name();
      if (!n || seen.has(n)) continue;
      seen.add(n);
      const r = e.type.def.rating;
      eff.push(c(r === 'good' ? 'c_green' : r === 'bad' ? 'c_red' : r === 'mixed' ? 'c_yellow' : 'c_light_gray', n));
    }
    if (eff.length) {
      L.push(sep());
      for (let i = 0; i < eff.length && i < 8; i++) L.push(eff[i]);
      if (eff.length > 8) L.push(c('c_dark_gray', `… ${eff.length - 8} more`));
    }
    this.side.innerHTML = L.map((l) => `<div>${l || '&nbsp;'}</div>`).join('');
  }
}

const sep = () => `<span style="color:var(--c-dark_gray)">${'─'.repeat(28)}</span>`;
