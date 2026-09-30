import { cssColor } from './framework';

// The free-aim overlay (src/game/aimmodel.ts; wired and driven by src/aim.ts every render frame,
// so it moves in step with the reticle). Around the view centre:
//  - a faint dot where the mouse looks (the reticle itself wanders away from it)
//  - while aiming, a dashed circle: how far the reticle currently weaves, coloured by whether
//    that fits inside the body you're looking at (green), about does (yellow) or not (red)
// Around the reticle (timing model only):
//  - held breath: an arc that empties as the breath runs out; the reticle ring flashes on the
//    steady (perfect) moment
//  - a bow at full draw: a ring closing in on the reticle, bright while loosing would be perfect
//  - melee: a pulse telling you the next swing is ready to be chained on the beat
//  - active reload: a bar with a bright band; press reload again while the marker is in it
// Optional (`trail`, Options > Aim trail / cdda.aimHud.trail): a fading trail of where the
// reticle has been over the last second, which makes the rhythm of the weave easy to read.
// Everything is pointer-events: none.

const NS = 'http://www.w3.org/2000/svg';
const SIZE = 200;

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent?: Element): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.appendChild(e);
  return e;
}

function arc(r: number, a0: number, a1: number): string {
  const p = (a: number) => `${(Math.sin(a) * r).toFixed(2)} ${(-Math.cos(a) * r).toFixed(2)}`;
  const large = Math.abs(a1 - a0) > Math.PI ? 1 : 0;
  return `M ${p(a0)} A ${r} ${r} 0 ${large} 1 ${p(a1)}`;
}

export interface AimHudFrame {
  /** Free aim is on with a weapon that sways (else only the reload bar can show). */
  active: boolean;
  /** Reticle offset from the view centre, CSS px. */
  rx: number;
  ry: number;
  /** Weave amplitude in px and the fit colour (null: nothing under the crosshair / not aiming). */
  envelope: { r: number; fit: 'good' | 'fair' | 'poor' | 'none' } | null;
  breath: { state: 'none' | 'settling' | 'perfect' | 'steady' | 'straining' | 'recovering'; left: number } | null;
  /** Bow ring: radius px of the closing ring, and whether a loose now would be perfect. */
  bow: { r: number; perfect: boolean } | null;
  /** Melee beat: 0..1 pulse strength (1 = right now). */
  beat: number;
  /** Active reload: progress 0..1 and the band, or null. `result` flashes after a press. */
  reload: { t: number; band: { start: number; end: number }; judged: boolean } | null;
}

export class AimHud {
  readonly root: HTMLDivElement;
  private svg: SVGSVGElement;
  private dot: SVGCircleElement;
  private envelope: SVGCircleElement;
  private reticle: SVGGElement;
  private breathArc: SVGPathElement;
  private flash: SVGCircleElement;
  private bowRing: SVGCircleElement;
  private bowTarget: SVGCircleElement;
  private beat: SVGCircleElement;
  private bar: HTMLDivElement;
  private band: HTMLDivElement;
  private marker: HTMLDivElement;
  /** Draw the reticle's recent path (seconds of history; 0 = off). */
  trail = 0;
  private trailG: SVGGElement;
  private trailPts: { x: number; y: number; t: number }[] = [];

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'aim-hud';
    Object.assign(this.root.style, { position: 'absolute', left: '50%', top: '50%', width: '0', height: '0', pointerEvents: 'none', zIndex: '4' });
    this.svg = el('svg', { width: SIZE, height: SIZE, viewBox: `${-SIZE / 2} ${-SIZE / 2} ${SIZE} ${SIZE}` });
    Object.assign(this.svg.style, { position: 'absolute', left: `${-SIZE / 2}px`, top: `${-SIZE / 2}px`, overflow: 'visible', filter: 'drop-shadow(0 0 1px rgba(0,0,0,.9))' });
    this.root.appendChild(this.svg);
    this.dot = el('circle', { r: 1.5, fill: 'rgba(255,255,255,.45)' }, this.svg);
    this.envelope = el('circle', { r: 20, fill: 'none', 'stroke-width': 1, 'stroke-dasharray': '2 4' }, this.svg);
    this.trailG = el('g', {}, this.svg);
    this.reticle = el('g', {}, this.svg);
    this.breathArc = el('path', { fill: 'none', 'stroke-width': 2, stroke: 'rgba(160,210,255,.85)' }, this.reticle);
    this.flash = el('circle', { r: 11, fill: 'none', 'stroke-width': 2 }, this.reticle);
    this.bowTarget = el('circle', { r: 10, fill: 'none', 'stroke-width': 1, stroke: 'rgba(255,255,255,.35)' }, this.reticle);
    this.bowRing = el('circle', { r: 30, fill: 'none', 'stroke-width': 1.5 }, this.reticle);
    this.beat = el('circle', { r: 19, fill: 'none', 'stroke-width': 2, stroke: cssColor('c_yellow') }, this.reticle);
    this.bar = document.createElement('div');
    Object.assign(this.bar.style, { position: 'absolute', left: '-50px', top: '44px', width: '100px', height: '6px', background: 'rgba(0,0,0,.6)', border: '1px solid rgba(255,255,255,.4)', display: 'none' });
    this.band = document.createElement('div');
    Object.assign(this.band.style, { position: 'absolute', top: '0', height: '100%', background: 'rgba(255,230,120,.85)' });
    this.marker = document.createElement('div');
    Object.assign(this.marker.style, { position: 'absolute', top: '-3px', width: '2px', height: '12px', background: '#fff' });
    this.bar.append(this.band, this.marker);
    this.root.appendChild(this.bar);
    parent.appendChild(this.root);
  }

  destroy(): void {
    this.root.remove();
  }

  frame(f: AimHudFrame | null, now: number): void {
    this.root.style.display = f ? '' : 'none';
    if (!f) return;
    const show = (e: Element, on: boolean) => ((e as HTMLElement | SVGElement).style.display = on ? '' : 'none');
    show(this.dot, f.active);
    // Trail: dots along the reticle's recent path, fading with age.
    if (this.trail > 0 && f.active) {
      this.trailPts.push({ x: f.rx, y: f.ry, t: now });
      while (this.trailPts.length && now - this.trailPts[0].t > this.trail * 1000) this.trailPts.shift();
    } else this.trailPts.length = 0;
    while (this.trailG.childNodes.length > this.trailPts.length) this.trailG.lastChild!.remove();
    while (this.trailG.childNodes.length < this.trailPts.length) el('circle', { r: 1.2, fill: '#fff' }, this.trailG);
    this.trailPts.forEach((q, i) => {
      const c = this.trailG.childNodes[i] as SVGCircleElement;
      c.setAttribute('cx', q.x.toFixed(1));
      c.setAttribute('cy', q.y.toFixed(1));
      c.setAttribute('opacity', (0.6 * (1 - (now - q.t) / (this.trail * 1000))).toFixed(2));
    });
    this.reticle.setAttribute('transform', `translate(${f.rx.toFixed(1)} ${f.ry.toFixed(1)})`);
    const env = f.active ? f.envelope : null;
    show(this.envelope, !!env);
    if (env) {
      this.envelope.setAttribute('r', Math.max(3, env.r).toFixed(1));
      this.envelope.setAttribute('stroke', { good: 'rgba(120,230,120,.55)', fair: 'rgba(255,220,90,.6)', poor: 'rgba(255,90,70,.65)', none: 'rgba(255,255,255,.3)' }[env.fit]);
    }
    const b = f.active ? f.breath : null;
    const breathing = !!b && b.state !== 'none';
    show(this.breathArc, breathing);
    if (b && breathing) {
      const left = Math.max(0.001, Math.min(1, b.left));
      this.breathArc.setAttribute('d', arc(24, Math.PI - left * 1.2, Math.PI + left * 1.2));
      this.breathArc.setAttribute('stroke', b.state === 'straining' ? 'rgba(255,110,90,.9)' : b.state === 'recovering' ? 'rgba(160,160,160,.6)' : 'rgba(160,210,255,.85)');
    }
    const perfect = (!!b && b.state === 'perfect') || !!f.bow?.perfect;
    show(this.flash, perfect);
    if (perfect) this.flash.setAttribute('stroke', Math.floor(now / 70) % 2 ? cssColor('c_white') : cssColor('c_yellow'));
    show(this.bowRing, !!f.bow);
    show(this.bowTarget, !!f.bow);
    if (f.bow) {
      this.bowRing.setAttribute('r', Math.max(1, f.bow.r).toFixed(1));
      this.bowRing.setAttribute('stroke', f.bow.perfect ? cssColor('c_yellow') : 'rgba(255,255,255,.7)');
    }
    show(this.beat, f.beat > 0.02);
    if (f.beat > 0.02) {
      this.beat.setAttribute('opacity', f.beat.toFixed(2));
      this.beat.setAttribute('r', (19 + (1 - f.beat) * 6).toFixed(1));
    }
    const r = f.reload;
    this.bar.style.display = r ? '' : 'none';
    if (r) {
      this.bar.style.transform = `translate(${f.rx.toFixed(1)}px, ${f.ry.toFixed(1)}px)`;
      this.band.style.left = `${(r.band.start * 100).toFixed(1)}%`;
      this.band.style.width = `${((r.band.end - r.band.start) * 100).toFixed(1)}%`;
      this.band.style.opacity = r.judged ? '0.3' : '1';
      this.marker.style.left = `${(Math.min(1, r.t) * 100).toFixed(1)}%`;
    }
  }
}
