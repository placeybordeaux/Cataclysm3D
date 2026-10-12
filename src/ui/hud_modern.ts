// The modern HUD (v2, docs/DESIGN_V2.md "Modern game UI"): the always-on overlay drawn in the
// ui2 visual language on the ui2 HUD layer. Minimal by default — every element stays quiet
// until it matters:
//
//   top centre   compass strip (cardinals, hostiles in sight, your destination, the refugee
//                centre) with the danger light at its left, and the status banner slot under it
//   top right    clock / weather / temperature / light, and where you are
//   bottom left  message feed (fading, colour-coded, click for the full log) above the vitals:
//                body silhouette (HP per part, bleeding / bandaged / broken) + need icons + effects
//   bottom right wielded weapon and ammo (+ the sidebar providers: style, fire mode, power)
//   bottom centre stamina (only while not full) and the activity bar; the hotbar owns the rest
//
// "Detailed HUD" (Options) swaps the vitals/clock/weapon clusters for the CDDA sidebar,
// restyled, for veterans. Everything is sized in ui2 metrics (--u, --fs), so it follows the UI
// scale; anchors are the corners of a "HUD area" that can be narrowed to 16:9 on ultrawide.
//
// Tooltips (need icons, body parts, effects, compass markers) show whenever the cursor is free
// (any ui2 window, the context menu, look mode `x`).

import type { Game } from '../game/game';
import { activeWeapon, bionicGunHud } from '../game/bionicguns';
import { MAIN_PARTS, BODY_PARTS, type MainPartId } from '../game/bodyparts';
import type { MonsterSystem } from '../game/monai';
import { isDay, lightAt } from '../game/vision';
import { recentHeard } from '../game/sound';
import { attackCooldownSeconds, attackSpeedMoves, swingSpeedRating } from '../game/combat';
import { ammoRequired, currentMode, upsDrain, upsShots } from '../game/gunmods';
import { h, ui2Layers, attachTooltip, palette, iconEl } from '../ui2';
import { colorize } from './framework';
import { logLine, type MessageLog } from './format';
import { omtLabel, playerOmt, type UiContext } from './context';
import { activityBarEnabled } from './activity_ring';
import {
  EFFECTS_SHOWN_AS_NEEDS, runDay, bearing, CARDINALS, dangerLevel, feedAlpha, lightLabel, messageTone, needStates, partTone, relativeAngle, stripPos,
  type NeedState, type PartTone,
} from './hud_logic';
import { BODY_H, BODY_W, PART_BOX, paintBody, pixelIcon, type BodyKey } from './pixelart';
import { mapMarks } from './mapmarks';
import { mapMarkers } from '../game/mapmarkers';
import { refugeeCenterOmt, seenKey } from './overmap_ui';
import { CHUNK } from '../world/coords';
import './hud_modern.css';
import { meleeControl } from '../game/combatfeel';

export interface BannerSpec {
  text: string;
  /** Second line, smaller ("Space to resume"). */
  sub?: string;
  tone?: 'warn' | 'bad' | 'info' | 'good' | 'accent';
  /** A quiet one-line note instead of a big banner (a menu's own pause). */
  small?: boolean;
}

export interface HudPrefs {
  /** CDDA-style sidebar instead of the modern clusters. */
  detailed: boolean;
  /**
   * HUD area: 'full' uses the screen corners, '16:9' keeps it in a centred 16:9 area, 'auto'
   * does that only on ultrawide screens (wider than 2.1:1), where corners are out of sight.
   */
  width: 'auto' | 'full' | '16:9';
}

const PREFS_KEY = 'cdda3d.hud';

export function loadHudPrefs(): HudPrefs {
  try {
    const j = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<HudPrefs>;
    const width = j.width === 'full' || j.width === '16:9' ? j.width : 'auto';
    return { detailed: !!j.detailed, width };
  } catch {
    return { detailed: false, width: 'auto' };
  }
}
export function saveHudPrefs(p: HudPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    // not persisted
  }
}

const NEED_ICON: Record<string, string> = {
  hunger: 'hunger', thirst: 'thirst', fatigue: 'fatigue', temperature: 'temperature', pain: 'pain', morale: 'morale', weight: 'weight',
};

const TONE_HEX = (t: PartTone): string =>
  ({ good: palette.good, ok: '#a9b86a', warn: palette.warn, bad: palette.danger, broken: '#3a2a2a' })[t];

/** Effects the HUD shows elsewhere (temperature need, body silhouette) or that are noise. */
/** How long a heard noise stays marked on the compass strip (real seconds). */
const NOISE_MARK_SECONDS = 2.5;

const EFFECT_SKIP = new Set(['hungry', 'thirsty', 'tired', 'cold', 'hot', 'bandaged', 'disinfected', 'frostbite', 'wet', 'lying_down', 'sleep']);

export class ModernHud {
  readonly el: HTMLElement;
  private compass: HTMLElement;
  private strip: HTMLElement;
  private danger: HTMLElement;
  private dangerText: HTMLElement;
  private banners: HTMLElement;
  private clock: HTMLElement;
  private feed: HTMLElement;
  private vitals: HTMLElement;
  private bodyCanvas: HTMLCanvasElement;
  private needsEl: HTMLElement;
  private effectsEl: HTMLElement;
  private weapon: HTMLElement;
  private stamina: HTMLElement;
  private staminaFill: HTMLElement;
  private staminaText: HTMLElement;
  private activity: HTMLElement;
  private readonly bannerMap = new Map<string, BannerSpec>();
  private needCells = new Map<string, { el: HTMLElement; img: HTMLImageElement; label: HTMLElement; key: string }>();
  private needState = new Map<string, NeedState>();
  private stripPool: HTMLElement[] = [];
  private lastSlow = 0;
  private lastFeed = 0;
  private bodyKey = '';
  private weaponKey = '';
  private staminaSeen = 0;
  private dangerNames: string[] = [];
  private refugee: { x: number; y: number } | null | undefined;
  private phase = 0;
  visible = true;
  prefs: HudPrefs = loadHudPrefs();

  constructor(private ctx: UiContext, private log: MessageLog, private sidebar: HTMLElement, private openLog: () => void) {
    const L = ui2Layers();
    this.el = h('div', { class: 'hud2 ui2-cdda', attrs: { 'data-testid': 'hud2' } });
    L.hud.prepend(this.el);

    // --- top: compass + danger + banners
    this.dangerText = h('span', { class: 'hud2-danger-text' });
    this.danger = h('div', { class: 'hud2-danger', attrs: { 'data-testid': 'hud-danger' } }, pixelIcon('danger', palette.textDim, 'var(--hud-k)'), this.dangerText);
    this.strip = h('div', { class: 'hud2-strip' });
    this.compass = h('div', { class: 'hud2-compass', attrs: { 'data-testid': 'hud-compass' } }, this.danger, h('div', { class: 'hud2-strip-wrap' }, this.strip, h('div', { class: 'hud2-strip-mid' })));
    this.banners = h('div', { class: 'hud2-banners', attrs: { 'data-testid': 'hud-banners' } });
    this.el.append(h('div', { class: 'hud2-top' }, this.compass, this.banners));
    attachTooltip(this.danger, () => this.dangerTip());

    // --- top right: clock
    this.clock = h('div', { class: 'hud2-clock hud2-plate', attrs: { 'data-testid': 'hud-clock' } });
    this.el.append(this.clock);

    // --- bottom left: feed + vitals
    this.feed = h('div', { class: 'hud2-feed', attrs: { 'data-testid': 'hud-feed', title: '' } });
    this.feed.addEventListener('click', () => this.openLog());
    attachTooltip(this.feed, () => `Click for the full message log (${ctx.game.keys.label('messages')})`);
    this.bodyCanvas = h('canvas', { class: 'hud2-body' });
    // One transparent hit box per body part over the silhouette, each with its own tooltip.
    const bodyWrap = h('div', { class: 'hud2-body-wrap hud2-plate' }, this.bodyCanvas);
    const hits = h('div', { class: 'hud2-body-hits' });
    for (const [part, b] of Object.entries(PART_BOX) as [BodyKey, (typeof PART_BOX)[BodyKey]][]) {
      const hit = h('div', { class: 'hud2-body-hit', data: { part } });
      Object.assign(hit.style, {
        left: `${((b.x0 + 1) / BODY_W) * 100}%`, top: `${((b.y0 + 1) / BODY_H) * 100}%`,
        width: `${((b.x1 - b.x0 + 1) / BODY_W) * 100}%`, height: `${((b.y1 - b.y0 + 1) / BODY_H) * 100}%`,
      });
      attachTooltip(hit, () => this.bodyTip(part));
      hits.append(hit);
    }
    bodyWrap.append(hits);
    this.needsEl = h('div', { class: 'hud2-needs', attrs: { 'data-testid': 'hud-needs' } });
    this.effectsEl = h('div', { class: 'hud2-effects', attrs: { 'data-testid': 'hud-effects' } });
    this.vitals = h('div', { class: 'hud2-vitals', attrs: { 'data-testid': 'hud-vitals' } }, bodyWrap, h('div', { class: 'hud2-vcol' }, this.effectsEl, this.needsEl));
    this.el.append(h('div', { class: 'hud2-bl' }, this.feed, this.vitals));

    // --- bottom right: weapon
    this.weapon = h('div', { class: 'hud2-weapon hud2-plate', attrs: { 'data-testid': 'hud-weapon' } });
    this.el.append(this.weapon);

    // --- bottom centre: stamina + activity
    this.staminaFill = h('div', { class: 'hud2-stam-fill' });
    this.staminaText = h('span', { class: 'hud2-stam-text' });
    this.stamina = h('div', { class: 'hud2-stamina', attrs: { 'data-testid': 'hud-stamina' } }, this.staminaText, h('div', { class: 'hud2-stam-track' }, this.staminaFill));
    this.activity = h('div', { class: 'hud2-activity hud2-plate', attrs: { 'data-testid': 'hud-activity' } });
    this.el.append(this.stamina, this.activity);

    // --- detailed sidebar (the legacy element, moved into the ui2 layer and restyled)
    sidebar.classList.add('hud2-side', 'hud2-plate');
    this.el.append(sidebar);

    for (const id of Object.keys(NEED_ICON)) {
      const img = pixelIcon(NEED_ICON[id], palette.textDim, 'var(--hud-k)');
      const label = h('span', { class: 'hud2-need-label' });
      const el = h('div', { class: 'hud2-need', data: { need: id } }, img, label);
      attachTooltip(el, () => this.needTip(id));
      this.needsEl.append(el);
      this.needCells.set(id, { el, img, label, key: '' });
    }
    this.applyPrefs();
    window.addEventListener('resize', () => this.layout());
    this.layout();
  }

  setPrefs(p: Partial<HudPrefs>): void {
    this.prefs = { ...this.prefs, ...p };
    saveHudPrefs(this.prefs);
    this.applyPrefs();
  }

  private applyPrefs(): void {
    this.el.classList.toggle('detailed', this.prefs.detailed);
    this.layout();
  }

  /** HUD area insets: full width, or a centred 16:9 area on screens wider than that. */
  private layout(): void {
    const w = window.innerWidth, hgt = window.innerHeight;
    const narrow = this.prefs.width === '16:9' || (this.prefs.width === 'auto' && w / hgt > 2.1);
    const inset = narrow ? Math.max(0, Math.floor((w - (hgt * 16) / 9) / 2)) : 0;
    // On the ui2 root so toasts (and anything else anchored to a side) can follow it.
    ui2Layers().root.style.setProperty('--hud-x', `${inset}px`);
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.el.style.display = v ? '' : 'none';
  }

  setBanner(id: string, spec: BannerSpec | null): void {
    if (spec) this.bannerMap.set(id, spec);
    else this.bannerMap.delete(id);
    this.banners.replaceChildren(
      ...[...this.bannerMap].map(([id, b]) =>
        h('div', { class: `hud2-banner tone-${b.tone ?? 'warn'}${b.small ? ' small' : ''}`, data: { banner: id } }, h('div', { class: 'hud2-banner-text', text: b.text }), b.sub ? h('div', { class: 'hud2-banner-sub', text: b.sub }) : null),
      ),
    );
  }

  /** Per animation frame. Cheap parts every frame (compass, stamina), the rest ~5 Hz. */
  frame(now: number): void {
    if (!this.visible) return;
    this.renderCompass();
    this.renderStamina(now);
    this.renderActivity();
    if (now - this.lastFeed > 250) {
      this.lastFeed = now;
      this.renderFeed(now);
    }
    if (now - this.lastSlow > 200) {
      this.lastSlow = now;
      this.phase = Math.floor(now / 450) % 2;
      if (!this.prefs.detailed) {
        this.renderVitals();
        this.renderClock();
        this.renderWeapon();
      }
    }
  }

  /** Called when a message arrives: redraw the feed at once. */
  onMessage(): void {
    this.renderFeed(performance.now());
  }

  // ------------------------------------------------------------------ compass

  private monsters(): MonsterSystem | undefined {
    return (this.ctx.game as unknown as { monsters?: MonsterSystem }).monsters;
  }

  private renderCompass(): void {
    const g = this.ctx.game;
    const p = g.player;
    const W = this.strip.clientWidth || 1;
    const FOV = Math.PI; // 180° across the strip
    let n = 0;
    const put = (cls: string, x: number, text: string, extra?: (el: HTMLElement) => void) => {
      let el = this.stripPool[n];
      if (!el) {
        el = h('span');
        this.stripPool.push(el);
        this.strip.append(el);
      }
      n++;
      if (el.className !== cls) el.className = cls;
      if (el.textContent !== text) el.textContent = text;
      el.style.transform = `translateX(${Math.round(x * W)}px)`;
      el.style.display = '';
      // Pooled elements change kind between frames: only noise marks fade.
      if (el.style.opacity) el.style.opacity = '';
      extra?.(el);
    };
    // Ticks every 15°, labels at the 8 compass points.
    for (let deg = 0; deg < 360; deg += 15) {
      const rel = relativeAngle((deg * Math.PI) / 180, p.yaw);
      const s = stripPos(rel, FOV);
      if (s.clamped) continue;
      const card = CARDINALS.find((c) => c[1] === deg);
      if (card) put(`hud2-card${card[0].length === 1 ? ' main' : ''}`, s.x, card[0]);
      else put('hud2-tick', s.x, '');
    }
    // Hostiles you can see: red pips, brighter and bigger when close. Off-strip ones sit at the
    // edge they're nearer to, so a zombie behind you still says which way to turn.
    const sys = this.monsters();
    const list = sys?.visibleHostiles(40) ?? [];
    const dists: number[] = [];
    for (const m of list.slice(0, 12)) {
      const d = Math.hypot(m.x - p.x, m.y - p.y);
      dists.push(d);
      const s = stripPos(relativeAngle(bearing(p.x, p.y, m.x, m.y), p.yaw), FOV);
      put(`hud2-pip hostile${d <= 6 ? ' near' : ''}${s.clamped ? ' edge' : ''}`, s.x, s.clamped ? (s.x < 0.5 ? '◂' : '▸') : '');
    }
    // Noises you just heard (the "You hear a thump to the north" lines): a brief amber mark
    // on the strip, taller for loud ones, fading out. One per direction and description.
    const seenNoise = new Set<string>();
    for (const nz of recentHeard(g, NOISE_MARK_SECONDS).reverse()) {
      if (nz.z !== p.z && Math.abs(nz.z - p.z) > 1) continue;
      const raw = stripPos(relativeAngle(bearing(p.x, p.y, nz.x + 0.5, nz.y + 0.5), p.yaw), FOV);
      // The strip's ends fade out: a noise out there shows as an arrow at the edge instead.
      const s = raw.x < 0.1 || raw.x > 0.9 ? { x: raw.x < 0.5 ? 0.04 : 0.95, clamped: true } : raw;
      const k = `${nz.description}@${Math.round(s.x * 40)}`;
      if (seenNoise.has(k) || seenNoise.size >= 6) continue;
      seenNoise.add(k);
      put(`hud2-pip sound${nz.volume >= 20 ? ' loud' : ''}${s.clamped ? ' edge' : ''}`, s.x, s.clamped ? (s.x < 0.5 ? '◂' : '▸') : '', (el) => {
        el.style.opacity = String(Math.max(0.15, 1 - nz.age / NOISE_MARK_SECONDS));
        el.title = `${nz.description.replace(/[.!\s]+$/, '')} (${Math.round(Math.hypot(nz.x + 0.5 - p.x, nz.y + 0.5 - p.y))} m)`;
      });
    }
    this.dangerNames = list.slice(0, 6).map((m) => `${m.displayName()} (${Math.round(Math.hypot(m.x - p.x, m.y - p.y))} m)`);
    // Destination and the refugee centre: diamonds with the distance under them.
    const marks = mapMarks(g);
    const poi = (ox: number, oy: number, cls: string, label: string, exact?: { x?: number; y?: number }) => {
      const tx = exact?.x ?? ox * CHUNK + CHUNK / 2, ty = exact?.y ?? oy * CHUNK + CHUNK / 2;
      const d = Math.hypot(tx - p.x, ty - p.y);
      if (d < CHUNK / 2) return;
      const s = stripPos(relativeAngle(bearing(p.x, p.y, tx, ty), p.yaw), FOV);
      // A diamond on the strip; the name and distance only when it's roughly ahead, so labels
      // never pile up on the cardinals.
      const ahead = !s.clamped && Math.abs(s.x - 0.5) < 0.18;
      put(`hud2-poi ${cls}${s.clamped ? ' edge' : ''}${ahead ? ' ahead' : ''}`, s.x, ahead ? `◆ ${label} · ${d >= 1000 ? `${(d / 1000).toFixed(1)} km` : `${Math.round(d / 10) * 10} m`}` : '◆');
    };
    if (marks.destination && marks.destination.z === p.z) poi(marks.destination.x, marks.destination.y, 'dest', marks.destination.label);
    // Mission targets (src/game/mapmarkers.ts): the tracked one with its name, others as marks.
    for (const mk of mapMarkers()) {
      if (mk.kind !== 'mission' || mk.z !== p.z) continue;
      if (mk.tracked) poi(mk.omx, mk.omy, 'mission tracked', mk.label, mk);
      else {
        const tx = mk.x ?? mk.omx * CHUNK + CHUNK / 2, ty = mk.y ?? mk.omy * CHUNK + CHUNK / 2;
        const s = stripPos(relativeAngle(bearing(p.x, p.y, tx, ty), p.yaw), FOV);
        if (!s.clamped) put('hud2-poi mission', s.x, '◇');
      }
    }
    if (this.refugee === undefined && this.ctx.worldgen) this.refugee = refugeeCenterOmt(this.ctx.worldgen, playerOmt(this.ctx));
    if (this.refugee && p.z === 0 && g.overmapSeen.has(seenKey(this.refugee.x, this.refugee.y, 0)) && !(marks.destination && marks.destination.x === this.refugee.x && marks.destination.y === this.refugee.y))
      poi(this.refugee.x, this.refugee.y, 'ref', 'Refugee Center');
    for (let i = n; i < this.stripPool.length; i++) this.stripPool[i].style.display = 'none';

    const lvl = dangerLevel(dists, !!sys?.grabbedBy);
    this.danger.dataset.level = lvl;
    const txt = lvl === 'grabbed' ? 'GRABBED' : lvl === 'near' ? 'DANGER' : lvl === 'aware' ? `${list.length} in sight` : '';
    if (this.dangerText.textContent !== txt) this.dangerText.textContent = txt;
    const icon = this.danger.firstElementChild as HTMLImageElement;
    const col = lvl === 'safe' ? palette.textDim : lvl === 'aware' ? palette.warn : palette.danger;
    if (icon.dataset.col !== col) {
      icon.dataset.col = col;
      icon.src = pixelIconURL('danger', col);
    }
  }

  private dangerTip(): HTMLElement | string {
    if (!this.dangerNames.length) return 'Safe: no hostiles in sight. (Hostiles you can see show as red marks on the compass.)';
    return h('div', null, h('div', { class: 'tone-bad', text: 'Hostiles in sight' }), ...this.dangerNames.map((n) => h('div', { class: 'ui2-small', text: n })));
  }

  // ------------------------------------------------------------------ vitals

  private renderVitals(): void {
    const g = this.ctx.game;
    const p = g.player;
    // Body silhouette: repaint only when something visible changed.
    const fill = {} as Record<BodyKey, string>;
    const bleeding: Partial<Record<BodyKey, boolean>> = {}, bandaged: Partial<Record<BodyKey, boolean>> = {};
    const broken: Partial<Record<BodyKey, boolean>> = {}, infected: Partial<Record<BodyKey, boolean>> = {};
    let key = '';
    for (const bp of MAIN_PARTS) {
      const hp = p.hp[bp];
      const t = partTone(hp.cur, hp.max, p.isLimbBroken(bp));
      fill[bp] = TONE_HEX(t);
      broken[bp] = t === 'broken';
      bleeding[bp] = p.effects.has('bleed', bp);
      bandaged[bp] = p.effects.has('bandaged', bp);
      infected[bp] = p.effects.has('infected', bp) || p.effects.has('bite', bp);
      key += `${t}${+!!bleeding[bp]}${+!!bandaged[bp]}${+!!infected[bp]}|`;
    }
    const anyBleed = Object.values(bleeding).some(Boolean);
    key += anyBleed ? this.phase : '';
    if (key !== this.bodyKey) {
      this.bodyKey = key;
      paintBody(this.bodyCanvas, { fill, bleeding, bandaged, broken, infected, phase: this.phase, outline: '#07080c', blood: '#d0301e', bandage: '#ece6d4' });
    }
    this.vitals.classList.toggle('bleeding', anyBleed);

    // Need icons: dim when fine, coloured with a label when not, pulsing when urgent.
    for (const st of needStates(p, (id) => g.keys.label(id))) {
      this.needState.set(st.id, st);
      const cell = this.needCells.get(st.id)!;
      const col = st.level === 0 ? (st.good ? palette.good : palette.textDim) : st.level === 1 ? palette.warn : palette.danger;
      const icon = st.id === 'morale' && st.level > 0 ? 'morale_bad' : NEED_ICON[st.id];
      const k = `${icon}|${col}|${st.level}|${st.label}`;
      if (k === cell.key) continue;
      cell.key = k;
      cell.img.src = pixelIconURL(icon, col);
      cell.el.dataset.level = String(st.level);
      cell.el.classList.toggle('good', !!st.good && st.level === 0);
      cell.label.textContent = st.label;
      // Weight only appears when it matters; the rest keep their place so the row doesn't jump.
      cell.el.style.display = st.id === 'weight' && st.level === 0 ? 'none' : '';
    }

    // Effects: chips named like the game names them, coloured by rating.
    const seen = new Set<string>();
    const chips: HTMLElement[] = [];
    for (const e of p.effects.all()) {
      const name = e.name();
      if (!name || EFFECT_SKIP.has(e.id) || EFFECTS_SHOWN_AS_NEEDS.has(e.id) || seen.has(name + (e.bp ?? ''))) continue;
      seen.add(name + (e.bp ?? ''));
      const r = e.type.def.rating;
      const tone = r === 'good' ? 'good' : r === 'bad' ? 'bad' : r === 'mixed' ? 'warn' : 'dim';
      const label = e.bp ? `${name} (${BODY_PARTS[e.bp].name})` : name;
      chips.push(this.effectChip(label, tone, e.type.desc(e.intensity).replace('%s', e.bp ? BODY_PARTS[e.bp].name : 'body')));
    }
    const sig = chips.map((c) => c.textContent + c.className).join('|');
    if (this.effectsEl.dataset.sig !== sig) {
      this.effectsEl.dataset.sig = sig;
      this.effectsEl.replaceChildren(...chips.slice(0, 8), ...(chips.length > 8 ? [h('span', { class: 'hud2-chip tone-dim', text: `+${chips.length - 8}` })] : []));
    }
  }

  private effectChip(label: string, tone: string, desc: string): HTMLElement {
    const el = h('span', { class: `hud2-chip tone-${tone}`, text: label });
    attachTooltip(el, () => h('div', null, h('div', { class: `tone-${tone}`, text: label }), desc ? h('div', { class: 'ui2-small', text: desc }) : null));
    return el;
  }

  private needTip(id: string): HTMLElement | null {
    const st = this.needState.get(id);
    if (!st) return null;
    return h(
      'div',
      { class: 'hud2-tip' },
      h('div', { class: `hud2-tip-title tone-${st.level >= 2 ? 'bad' : st.level === 1 ? 'warn' : st.good ? 'good' : 'dim'}`, text: st.title }),
      h('div', { class: 'ui2-small', text: st.tip }),
      st.advice ? h('div', { class: 'ui2-small tone-accent', text: st.advice }) : null,
    );
  }

  private bodyTip(part: BodyKey | null): HTMLElement | string {
    const p = this.ctx.game.player;
    if (!part) {
      return h('div', null, h('div', { class: 'tone-accent', text: 'Body' }), ...MAIN_PARTS.map((bp) => partLine(p, bp)), h('div', { class: 'ui2-small ui2-dim', text: `Details: character sheet (${this.ctx.game.keys.label('character')})` }));
    }
    return h('div', null, partLine(p, part), ...partNotes(p, part).map((t) => h('div', { class: 'ui2-small', text: t })));
  }

  // ------------------------------------------------------------------ clock

  private renderClock(): void {
    const g = this.ctx.game;
    const p = g.player;
    const clk = g.clock;
    const hour = clk.hourOfDay;
    // The real sun, not 06–20: "Wait until dusk" ended at 18:43 under a sun icon (docs/ADAPTATION.md).
    const day = isDay(clk);
    const hh = String(Math.floor(hour)).padStart(2, '0'), mm = String(Math.floor((hour % 1) * 60)).padStart(2, '0');
    const dayN = runDay(clk.seconds, g.stats.startSeconds);
    const w = g.weather;
    const wk = this.ctx.renderer.weather?.kind ?? 'clear';
    const wIcon = wk === 'snow' ? 'snow' : wk === 'rain' || wk === 'storm' ? 'rain' : w && /cloud|overcast|fog|mist/.test(w.id) ? 'cloud' : day ? 'sun' : 'moon';
    const temp = w ? `${Math.round(w.temperature)}°C` : '';
    const light = lightLabel(lightAt(g, p.tileX, p.tileY, p.z));
    const om = playerOmt(this.ctx);
    const omt = omtLabel(this.ctx, om.x, om.y, om.z);
    const place = omt ? omt.name.replace(/^./, (c) => c.toUpperCase()) : '';
    const key = `${hh}${mm}|${dayN}|${wIcon}|${w?.name}|${temp}|${light.label}|${place}|${omt?.city}|${p.z}`;
    if (this.clock.dataset.key === key) return;
    this.clock.dataset.key = key;
    const bars = h('span', { class: 'hud2-light' }, ...[0, 1, 2, 3].map((i) => h('i', { class: i < light.bars ? 'on' : '' })));
    const lightEl = h('span', { class: 'hud2-light-wrap' }, bars, h('span', { class: 'ui2-small', text: light.label }));
    attachTooltip(lightEl, () => `Light here: ${light.label}. ${light.tip}`);
    const wEl = h('span', { class: 'hud2-weather' }, pixelIcon(wIcon, wIcon === 'sun' ? palette.accent : palette.info, 'var(--hud-k)'), h('span', { text: `${w?.name ?? 'Clear'} ${temp}` }));
    attachTooltip(wEl, () => (w ? `${w.name}, ${Math.round(w.temperature)}°C, wind ${Math.round(w.windpower)} mph` : 'Weather unknown'));
    this.clock.replaceChildren(
      h('div', { class: 'hud2-clock-row' }, pixelIcon(day ? 'sun' : 'moon', day ? palette.accent : palette.info, 'var(--hud-k)'), h('span', { class: 'hud2-time', text: `${hh}:${mm}` }), h('span', { class: 'ui2-small ui2-dim', text: `Day ${dayN} · ${clk.season[0].toUpperCase()}${clk.season.slice(1)}` })),
      h('div', { class: 'hud2-clock-row' }, wEl, lightEl),
      place ? h('div', { class: 'hud2-place', attrs: { 'data-testid': 'hud-place' } }, h('span', { text: place }), omt?.city ? h('span', { class: 'ui2-dim', text: ` · ${omt.city}` }) : null, p.z !== 0 ? h('span', { class: 'tone-info', text: ` · ${p.z > 0 ? 'upstairs' : 'underground'} ${p.z > 0 ? '+' : ''}${p.z}` }) : null) : '',
    );
  }

  // ------------------------------------------------------------------ weapon

  private renderWeapon(): void {
    const g = this.ctx.game;
    // While driving, the driving HUD (src/screens/vehicle.ts) takes the bottom-right corner.
    const driving = !!(g as unknown as { vehicles?: { driving?: unknown } }).vehicles?.driving;
    this.el.classList.toggle('driving', driving);
    const p = g.player;
    // An aimed bionic gun (src/game/bionicguns.ts) stands in for the wielded item while it lasts.
    const bionic = bionicGunHud(g);
    const w = activeWeapon(g);
    const extras = this.extraLines();
    let line2 = '', tone = 'dim';
    if (bionic && w) {
      line2 = `${bionic.detail} · ${currentMode(w).name} · Esc stops`;
      tone = bionic.shots <= 1 ? 'warn' : 'text';
    } else if (w?.isGun() && ammoRequired(w) === 0 && upsDrain(w) > 0) {
      // Rounds don't apply to a UPS-only gun (laser rifle): show the shots carried UPS can pay.
      const shots = upsShots(p, w);
      line2 = `UPS ${upsDrain(w)}/shot · ${shots} shot${shots === 1 ? '' : 's'} · ${currentMode(w).name}`;
      tone = shots === 0 ? 'bad' : shots <= 2 ? 'warn' : 'text';
    } else if (w?.isGun()) {
      const cap = w.ammoCapacity();
      const n = w.ammoRemaining();
      const mode = currentMode(w).name;
      line2 = `${n}${cap ? ` / ${cap}` : ''} · ${mode}`;
      tone = n === 0 ? 'bad' : cap && n <= cap / 4 ? 'warn' : 'text';
    } else {
      const sec = attackCooldownSeconds(p, w);
      const rating = swingSpeedRating(attackSpeedMoves(p, w));
      line2 = `${sec.toFixed(1)} s per swing`;
      tone = messageTone(rating.color);
    }
    const key = `${w?.typeId ?? 'fists'}|${w?.name() ?? ''}|${line2}|${tone}|${extras.join('')}`;
    if (key === this.weaponKey) return;
    this.weaponKey = key;
    const icon = w ? iconEl({ typeId: w.typeId, symbol: w.def.symbol, color: w.def.color, looksLike: w.def.looks_like }, 'row') : null;
    this.weapon.replaceChildren(
      h('div', { class: 'hud2-weapon-main' }, icon, h('div', { class: 'hud2-weapon-text' }, h('div', { class: 'hud2-weapon-name', text: bionic ? bionic.name : w ? w.name() : 'Bare hands' }), h('div', { class: `ui2-small tone-${tone}`, text: line2 }))),
      ...extras.map((html) => h('div', { class: 'ui2-small hud2-extra', html })),
    );
    attachTooltip(this.weapon, () => (w ? `${w.name()} — ${w.isGun() ? `reload [${g.keys.label('reload')}], fire mode [${g.keys.label('fire_mode')}]` : `${meleeControl() === 'ready' ? 'hold the right mouse button to ready it, then left click to swing' : 'swing with the left mouse button'}; wield something else with [${g.keys.label('wield')}]`}` : `Unarmed. Wield a weapon with [${g.keys.label('wield')}].`));
  }

  /** Lines other systems add to the sidebar (bionic power, martial arts style, fire mode). */
  private extraLines(): string[] {
    return (this.extraProviders?.() ?? []).slice(0, 4);
  }
  extraProviders: (() => string[]) | null = null;

  // ------------------------------------------------------------------ stamina / activity

  private renderStamina(now: number): void {
    const p = this.ctx.game.player;
    const f = Math.max(0, Math.min(1, p.stamina / Math.max(1, p.staminaMax())));
    // Shown while not full (and a moment after it fills), so it's there when running or fighting.
    if (f < 0.985) this.staminaSeen = now;
    const show = now - this.staminaSeen < 1500;
    this.stamina.classList.toggle('on', show);
    if (!show) return;
    this.staminaFill.style.width = `${(f * 100).toFixed(1)}%`;
    const winded = p.effects.has('winded');
    this.stamina.dataset.level = winded || f < 0.1 ? 'bad' : f < 0.35 ? 'warn' : 'ok';
    const txt = winded ? 'Winded' : `Stamina ${Math.round(f * 100)}%`;
    if (this.staminaText.textContent !== txt) this.staminaText.textContent = txt;
  }

  private renderActivity(): void {
    const a = this.ctx.game.activities.current;
    // Activities with their own progress UI (crafting, construction, reading: src/ui/craft2).
    if (!a || a.spec.customUi || !activityBarEnabled()) {
      if (this.activity.style.display !== 'none') this.activity.style.display = 'none';
      return;
    }
    this.activity.style.display = '';
    const left = Math.max(0, a.spec.duration - a.elapsed);
    const leftTxt = left >= 3600 ? `${Math.floor(left / 3600)} h ${Math.floor((left % 3600) / 60)} min left` : left >= 60 ? `${Math.ceil(left / 60)} min left` : `${Math.ceil(left)} s left`;
    const key = `${a.spec.name}|${Math.floor(a.fraction * 100)}|${leftTxt}`;
    if (this.activity.dataset.key === key) return;
    this.activity.dataset.key = key;
    this.activity.replaceChildren(
      h('div', { class: 'hud2-act-top' }, h('span', { text: a.spec.name }), h('span', { class: 'ui2-dim', text: leftTxt })),
      h('div', { class: 'ui2-bar hud2-act-bar' }, h('div', { class: 'ui2-bar-fill tone-accent', style: { width: `${(a.fraction * 100).toFixed(1)}%` } })),
      h('div', { class: 'ui2-small ui2-dim hud2-act-hint', text: 'Move to stop' }),
    );
  }

  // ------------------------------------------------------------------ feed

  private renderFeed(now: number): void {
    const recent = this.log.recent(6);
    const rows: HTMLElement[] = [];
    let any = false;
    for (const e of recent) {
      const a = feedAlpha((now - e.time) / 1000);
      if (a <= 0) continue;
      any = true;
      const row = h('div', { class: `hud2-msg tone-${messageTone(e.color)}`, html: colorize(logLine(e)) });
      row.style.opacity = a.toFixed(2);
      rows.push(row);
    }
    const sig = rows.map((r) => r.innerHTML + r.style.opacity).join('|');
    if (this.feed.dataset.sig === sig) return;
    this.feed.dataset.sig = sig;
    this.feed.replaceChildren(...rows);
    this.feed.classList.toggle('empty', !any);
  }
}

// ------------------------------------------------------------------ helpers

function pixelIconURL(name: string, col: string): string {
  // Reuse pixelart's cache through a throwaway <img>.
  return pixelIcon(name, col, '1px').src;
}

function partLine(p: Game['player'], bp: MainPartId): HTMLElement {
  const hp = p.hp[bp];
  const t = partTone(hp.cur, hp.max, p.isLimbBroken(bp));
  const tone = t === 'good' || t === 'ok' ? 'good' : t === 'warn' ? 'warn' : 'bad';
  const name = BODY_PARTS[bp].name.replace(/^./, (c) => c.toUpperCase());
  return h('div', { class: 'hud2-partline' }, h('span', { text: name }), h('span', { class: `tone-${tone}`, text: t === 'broken' ? 'BROKEN' : `${hp.cur} / ${hp.max}` }));
}

/** Plain-language notes about one body part: wounds and what to do about them. */
export function partNotes(p: Game['player'], bp: MainPartId): string[] {
  const out: string[] = [];
  if (p.isLimbBroken(bp)) out.push(bp.startsWith('leg') ? 'Broken: you limp and cannot run. A splint and time heal it.' : bp.startsWith('arm') ? 'Broken: this arm is useless. A splint and time heal it.' : 'Broken.');
  if (p.effects.has('bleed', bp)) out.push('Bleeding: you lose HP until it stops. Apply a bandage or rags.');
  if (p.effects.has('bite', bp)) out.push('Bitten: the wound can get infected. Disinfect it.');
  if (p.effects.has('infected', bp)) out.push('Infected: needs antibiotics.');
  if (p.effects.has('bandaged', bp)) out.push('Bandaged: heals faster.');
  if (p.effects.has('disinfected', bp)) out.push('Disinfected.');
  const hp = p.hp[bp];
  if (!out.length && hp.cur < hp.max) out.push('Hurt: rest and bandages heal it over time.');
  return out;
}
