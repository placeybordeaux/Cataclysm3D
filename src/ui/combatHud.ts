import type { Game } from '../game/game';
import type { Monster } from '../game/monster';
import type { MonsterSystem } from '../game/monai';
import { arcFor, defenseOf, FEEL } from '../game/combatfeel';
import { swingStyleOf, type PlayerCombat } from '../game/playercombat';
import { cssColor } from './framework';

// The combat feel HUD around the crosshair (src/game/combatfeel.ts), drawn as one small SVG
// overlay so it never touches the main HUD's layout:
//  - reach brackets: four corner ticks close in on the crosshair when a swing would connect
//  - swing ring: a thin arc that fills while the swing recovers, so the cooldown is visible
//    without a number; it blinks once when you can swing again, then hides
//  - guard: a shield arc under the crosshair, bright during the parry window
//  - threat wedges on a ring: red toward whoever just hurt you (fades), yellow pulsing toward
//    a monster winding up a blow outside your view (the telegraph you can't see)
//  - a GRABBED banner with the struggle key and a bar that fills as struggling builds up
//  - why a blow didn't connect ("miss: dodged", "out of reach", "no damage"), briefly, above it
// Everything is pointer-events: none and hidden in top-down view and menus.

const NS = 'http://www.w3.org/2000/svg';
const RING_R = 15;
const THREAT_R = 58;
const SIZE = 150;

interface Threat {
  angle: number;
  t: number;
  dur: number;
  kind: 'hurt' | 'windup';
  monster?: Monster;
}

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent?: Element): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.appendChild(e);
  return e;
}

/** SVG arc path on a circle of radius r centred at 0,0 from angle a0 to a1 (radians, 0 = up, clockwise). */
export function arcPath(r: number, a0: number, a1: number): string {
  const p = (a: number) => `${(Math.sin(a) * r).toFixed(2)} ${(-Math.cos(a) * r).toFixed(2)}`;
  const large = Math.abs(a1 - a0) > Math.PI ? 1 : 0;
  return `M ${p(a0)} A ${r} ${r} 0 ${large} 1 ${p(a1)}`;
}

export class CombatHud {
  readonly root: HTMLDivElement;
  private svg: SVGSVGElement;
  private brackets: SVGPathElement;
  private ring: SVGPathElement;
  private ringBg: SVGCircleElement;
  private guard: SVGPathElement;
  private threatG: SVGGElement;
  private grabEl: HTMLDivElement;
  private whyEl: HTMLDivElement;
  private whyT = 0;
  private threats: Threat[] = [];
  private readyBlink = 0;
  private wasCooling = false;
  private reachT = 0;
  private inReach = false;
  private last = performance.now();
  private raf = 0;

  constructor(private game: Game, private combat: PlayerCombat, private sys: MonsterSystem, parent: HTMLElement, private visible: () => boolean) {
    this.root = document.createElement('div');
    this.root.className = 'combat-hud';
    Object.assign(this.root.style, { position: 'absolute', left: '50%', top: '50%', width: '0', height: '0', pointerEvents: 'none', zIndex: '4' });
    this.svg = el('svg', { width: SIZE, height: SIZE, viewBox: `${-SIZE / 2} ${-SIZE / 2} ${SIZE} ${SIZE}` });
    Object.assign(this.svg.style, { position: 'absolute', left: `${-SIZE / 2}px`, top: `${-SIZE / 2}px`, overflow: 'visible' });
    this.root.appendChild(this.svg);
    const shadow = 'drop-shadow(0 0 1px rgba(0,0,0,.9))';
    this.svg.style.filter = shadow;
    this.threatG = el('g', {}, this.svg);
    this.ringBg = el('circle', { r: RING_R, fill: 'none', stroke: 'rgba(255,255,255,.12)', 'stroke-width': 1.5 }, this.svg);
    this.ring = el('path', { fill: 'none', stroke: 'rgba(255,255,255,.7)', 'stroke-width': 1.5 }, this.svg);
    // Corner brackets 9..13 px out from the centre.
    const b = (sx: number, sy: number) => `M ${sx * 13} ${sy * 9} L ${sx * 13} ${sy * 13} L ${sx * 9} ${sy * 13}`;
    this.brackets = el('path', { d: [b(-1, -1), b(1, -1), b(-1, 1), b(1, 1)].join(' '), fill: 'none', stroke: cssColor('c_light_red'), 'stroke-width': 1.5 }, this.svg);
    this.guard = el('path', { d: arcPath(RING_R + 5, Math.PI - 0.9, Math.PI + 0.9), fill: 'none', 'stroke-width': 3, 'stroke-linecap': 'square' }, this.svg);
    this.grabEl = document.createElement('div');
    Object.assign(this.grabEl.style, {
      position: 'absolute', left: '0', top: '-64px', transform: 'translateX(-50%)', whiteSpace: 'nowrap', textAlign: 'center',
      background: 'rgba(0,0,0,.65)', padding: '1px 6px', color: cssColor('c_light_red'), textShadow: '1px 1px 0 #000', display: 'none',
    });
    this.root.appendChild(this.grabEl);
    this.whyEl = document.createElement('div');
    this.whyEl.className = 'combat-why';
    Object.assign(this.whyEl.style, {
      position: 'absolute', left: '0', top: '-40px', transform: 'translateX(-50%)', whiteSpace: 'nowrap',
      color: cssColor('c_light_gray'), textShadow: '1px 1px 0 #000, -1px -1px 0 #000', display: 'none',
    });
    this.root.appendChild(this.whyEl);
    parent.appendChild(this.root);

    game.events.on('playerAttack', (e) => {
      if (e.kind !== 'melee' || !e.reason) return;
      this.whyEl.textContent = e.outcome === 'miss' ? `miss: ${e.reason}` : e.reason;
      this.whyEl.style.color = cssColor(e.reason === 'dodged' || e.reason === 'no damage' ? 'c_yellow' : 'c_light_gray');
      this.whyT = 1.0;
    });

    game.events.on('playerHurt', (e) => {
      const m = e.source as { x?: number; y?: number } | undefined;
      if (typeof m?.x !== 'number' || typeof m.y !== 'number') return;
      const p = game.player;
      this.threats.push({ angle: Math.atan2(m.x - p.x, -(m.y - p.y)), t: 0, dur: e.amount > 0 ? 1.1 : 0.6, kind: 'hurt' });
    });
    game.events.on('monsterAttack', (e) => {
      const m = e.monster as Monster;
      if (e.phase === 'windup') this.threats.push({ angle: 0, t: 0, dur: (e.seconds ?? 0.5) + 0.05, kind: 'windup', monster: m });
      else this.threats = this.threats.filter((t) => t.monster !== m);
    });
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.frame();
    };
    this.raf = requestAnimationFrame(loop);
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.root.remove();
  }

  private frame(): void {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const show = this.visible() && !this.game.input.captured && !this.game.player.dead;
    this.root.style.display = show ? '' : 'none';
    if (!show) return;
    const game = this.game;
    const p = game.player;
    const c = this.combat;
    const w = p.inv.wielded;
    const melee = !w?.isGun();

    // --- reach (throttled: a camera raycast plus a scan of nearby monsters)
    if ((this.reachT -= dt) <= 0) {
      this.reachT = 0.05;
      const reach = w?.hasFlag('REACH_ATTACK') ? FEEL.reachLong : FEEL.reach;
      this.inReach = melee && !!c.meleeTarget(reach, arcFor(swingStyleOf(w)));
    }
    this.brackets.style.display = this.inReach ? '' : 'none';

    // --- swing ring: fills over the recovery; a blink when ready again
    const s = c.swing;
    const total = s?.timing.total ?? 0;
    const cooling = melee && c.cooldown > 0.02 && total > 0;
    if (cooling) {
      const f = Math.max(0, Math.min(1, 1 - c.cooldown / total));
      this.ring.setAttribute('d', arcPath(RING_R, 0, Math.max(0.01, f * Math.PI * 2 - 0.001)));
      this.ring.setAttribute('stroke', s && !s.resolved ? 'rgba(255,220,150,.8)' : 'rgba(255,255,255,.55)');
    } else if (this.wasCooling) this.readyBlink = 0.12;
    this.wasCooling = cooling;
    this.readyBlink = Math.max(0, this.readyBlink - dt);
    if (!cooling && this.readyBlink > 0) {
      this.ring.setAttribute('d', arcPath(RING_R, 0, Math.PI * 2 - 0.001));
      this.ring.setAttribute('stroke', 'rgba(255,255,255,.9)');
    }
    const ringOn = cooling || this.readyBlink > 0;
    this.ring.style.display = ringOn ? '' : 'none';
    this.ringBg.style.display = cooling ? '' : 'none';

    // --- guard / parry window
    const def = defenseOf(p);
    this.guard.style.display = def.guarding ? '' : 'none';
    if (def.guarding) {
      const parry = def.guardAge <= FEEL.parryWindow;
      this.guard.setAttribute('stroke', parry ? cssColor('c_yellow') : 'rgba(200,200,200,.7)');
    }

    // --- threat wedges
    for (const t of this.threats) t.t += dt;
    this.threats = this.threats.filter((t) => t.t < t.dur && !(t.monster && (t.monster.dead || !t.monster.windup)));
    while (this.threatG.firstChild) this.threatG.firstChild.remove();
    for (const t of this.threats) {
      let angle = t.angle;
      if (t.kind === 'windup') {
        const m = t.monster!;
        angle = Math.atan2(m.x - p.x, -(m.y - p.y));
        // In plain view the sprite's own telegraph says it; the wedge is for blows from the side.
        const off = Math.abs(Math.atan2(Math.sin(angle - p.yaw), Math.cos(angle - p.yaw)));
        if (off < 0.6) continue;
      }
      const rel = angle - p.yaw;
      const a = t.kind === 'hurt' ? 1 - t.t / t.dur : 0.55 + 0.45 * Math.sin(t.t * 22);
      el('path', {
        d: arcPath(THREAT_R, rel - 0.32, rel + 0.32), fill: 'none', 'stroke-width': t.kind === 'hurt' ? 5 : 4,
        stroke: t.kind === 'hurt' ? `rgba(230,40,30,${a.toFixed(2)})` : `rgba(255,210,60,${a.toFixed(2)})`,
      }, this.threatG);
    }

    // --- why the last blow didn't connect (fades out over its last 0.3 s)
    this.whyT = Math.max(0, this.whyT - dt);
    this.whyEl.style.display = this.whyT > 0 ? '' : 'none';
    if (this.whyT > 0) this.whyEl.style.opacity = String(Math.min(1, this.whyT / 0.3));

    // --- grabbed
    const g = this.sys.grabbedBy;
    if (g) {
      const key = game.keys.label('interact');
      const n = Math.min(1, def.struggle / 12);
      // Accessible: a hard enough hit also makes it let go (FEEL.staggerBreaksGrab).
      const alt = FEEL.staggerBreaksGrab ? ' (or hit it hard)' : '';
      this.grabEl.innerHTML = `GRABBED by ${g.theName()} — mash <span style="color:${cssColor('c_yellow')}">[${key}]</span> to break free${alt}`
        + `<div style="height:3px;margin-top:2px;background:#333"><div style="height:3px;width:${(n * 100).toFixed(0)}%;background:${cssColor('c_yellow')}"></div></div>`;
      this.grabEl.style.display = '';
    } else this.grabEl.style.display = 'none';
  }
}
