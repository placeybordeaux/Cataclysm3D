// In-world progress bars for timed actions ("Reading… 12 s", "Prying the door"): a pixel bar
// that sits over the thing being worked on (anchor → screen point each frame, e.g. from
// worldAnchor() in src/ui2/world.ts) or under the crosshair when there's no anchor.
//
//   const p = startProgress({ label: 'Butchering', seconds: 8, onDone })   // animates itself
//   const p = startProgress({ label: 'Reading' }); p.set(0.4, '12 s left') // driven by you

import { h, ui2Layers } from './dom';
import { fmtDuration } from './logic/items';

export interface ProgressOpts {
  label: string;
  /** Real seconds; given → the bar fills itself and calls onDone. */
  seconds?: number;
  /** Screen position per frame, or null to hide (off-screen / behind the camera). */
  anchor?: () => { x: number; y: number } | null;
  /** Small line under the bar: "move to stop". */
  hint?: string;
  onDone?: () => void;
}

export interface ProgressHandle {
  el: HTMLElement;
  set(frac: number, right?: string): void;
  finish(): void;
  cancel(): void;
}

export function startProgress(o: ProgressOpts): ProgressHandle {
  const fill = h('div', { class: 'ui2-prog-fill' });
  const right = h('span', { class: 'ui2-prog-right' });
  const el = h(
    'div',
    { class: 'ui2-prog' },
    h('div', { class: 'ui2-prog-top' }, h('span', { text: o.label }), right),
    h('div', { class: 'ui2-bar ui2-prog-track' }, fill),
    o.hint ? h('div', { class: 'ui2-prog-hint', text: o.hint }) : null,
  );
  ui2Layers().world.appendChild(el);
  let frac = 0;
  let ended = false;
  const t0 = performance.now();
  const frame = () => {
    if (ended) return;
    const a = o.anchor ? o.anchor() : null;
    if (o.anchor && !a) el.style.display = 'none';
    else {
      el.style.display = '';
      if (a) {
        el.style.left = `${Math.round(a.x)}px`;
        el.style.top = `${Math.round(a.y)}px`;
        el.classList.add('anchored');
      }
    }
    if (o.seconds !== undefined) {
      const t = (performance.now() - t0) / 1000;
      handle.set(t / o.seconds, `${fmtDuration(Math.max(0, o.seconds - t))}`);
      if (t >= o.seconds) return handle.finish();
    }
    requestAnimationFrame(frame);
  };
  const handle: ProgressHandle = {
    el,
    set(f, r) {
      frac = Math.max(0, Math.min(1, f));
      fill.style.width = `${frac * 100}%`;
      if (r !== undefined) right.textContent = r;
    },
    finish() {
      if (ended) return;
      ended = true;
      handle.set(1);
      el.classList.add('done');
      setTimeout(() => el.remove(), 350);
      o.onDone?.();
    },
    cancel() {
      if (ended) return;
      ended = true;
      el.classList.add('cancelled');
      setTimeout(() => el.remove(), 350);
    },
  };
  requestAnimationFrame(frame);
  return handle;
}
