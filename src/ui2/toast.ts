// Toast notifications (top-left, under nothing else in the HUD): discovery, achievement,
// warning, info. Rate limiting and folding live in logic/toasts.ts; this draws the state.
//   toast({ category: 'discovery', title: 'New recipe: splint', body: 'You have everything.' })

import { h, ui2Layers } from './dom';
import { iconEl } from './icons';
import { ToastQueue, type PushResult, type ToastSpec } from './logic/toasts';

const queue = new ToastQueue();
let listEl: HTMLElement | null = null;
let timer: ReturnType<typeof setInterval> | 0 = 0;
const rendered = new Map<number, HTMLElement>();

const LABEL: Record<ToastSpec['category'], string> = {
  discovery: 'Discovery',
  achievement: 'Achievement',
  warning: 'Warning',
  info: '',
};

export function toast(spec: ToastSpec): PushResult {
  const r = queue.push(spec, performance.now());
  sync();
  if (!timer) timer = setInterval(() => queue.tick(performance.now()) && sync(), 200);
  return r;
}

/** For tests/automation: what's on screen and waiting. */
export function toastState(): { visible: string[]; queued: string[] } {
  return { visible: queue.visible.map((t) => (t.count > 1 ? `${t.title} ×${t.count}` : t.title)), queued: queue.queue.map((t) => t.title) };
}

function sync(): void {
  listEl ??= ui2Layers().toasts.appendChild(h('div', { class: 'ui2-toasts' }));
  const live = new Set(queue.visible.map((t) => t.uid));
  for (const [uid, el] of rendered)
    if (!live.has(uid)) {
      rendered.delete(uid);
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 220);
    }
  for (const t of queue.visible) {
    let el = rendered.get(t.uid);
    if (!el) {
      el = h(
        'div',
        { class: `ui2-toast cat-${t.category}`, on: { click: () => (queue.dismiss(t.uid), sync()) }, title: 'Click to dismiss' },
        t.icon ? iconEl(t.icon, 'row') : h('span', { class: 'ui2-toast-mark' }),
        h('div', { class: 'ui2-toast-text' }, h('div', { class: 'ui2-toast-kind' }), h('div', { class: 'ui2-toast-title' }), h('div', { class: 'ui2-toast-body' })),
      );
      rendered.set(t.uid, el);
      listEl.appendChild(el);
    }
    (el.querySelector('.ui2-toast-kind') as HTMLElement).textContent = LABEL[t.category];
    (el.querySelector('.ui2-toast-title') as HTMLElement).textContent = t.count > 1 ? `${t.title}  ×${t.count}` : t.title;
    const body = el.querySelector('.ui2-toast-body') as HTMLElement;
    body.textContent = t.body ?? '';
    body.style.display = t.body ? '' : 'none';
  }
  if (!queue.visible.length && !queue.queue.length && timer) (clearInterval(timer), (timer = 0));
}
