// Toast rate limiting (pure, unit-tested). The v2 brief says discovery must be "rate-limited,
// never naggy": at most a few toasts on screen, repeats fold into one ("×3"), each category
// has a minimum gap between toasts, and when the queue overflows the least important goes.

import type { IconRef } from './items';

export type ToastCategory = 'discovery' | 'achievement' | 'warning' | 'info';

export interface ToastSpec {
  category: ToastCategory;
  title: string;
  body?: string;
  icon?: IconRef;
  /** Toasts with the same key fold together (default: category + title). */
  key?: string;
}

export interface ToastState extends ToastSpec {
  uid: number;
  key: string;
  count: number;
  shownAt: number;
  expiresAt: number;
}

export interface CategoryRule {
  /** ms on screen. */
  duration: number;
  /** ms after showing one before the next of this category may show. */
  minGap: number;
  /** Higher survives queue overflow and shows first. */
  priority: number;
}

export const TOAST_RULES: Record<ToastCategory, CategoryRule> = {
  warning: { duration: 5000, minGap: 1500, priority: 3 },
  achievement: { duration: 6000, minGap: 800, priority: 2 },
  discovery: { duration: 6000, minGap: 4000, priority: 1 },
  info: { duration: 3500, minGap: 600, priority: 0 },
};

export type PushResult = 'shown' | 'queued' | 'merged' | 'dropped';

export class ToastQueue {
  visible: ToastState[] = [];
  queue: ToastState[] = [];
  private uid = 0;
  private lastShown: Partial<Record<ToastCategory, number>> = {};

  constructor(readonly opts = { maxVisible: 3, maxQueue: 6, rules: TOAST_RULES }) {}

  push(spec: ToastSpec, now: number): PushResult {
    const key = spec.key ?? `${spec.category}:${spec.title}`;
    const rule = this.opts.rules[spec.category];
    const same = this.visible.find((t) => t.key === key) ?? this.queue.find((t) => t.key === key);
    if (same) {
      same.count++;
      if (spec.body) same.body = spec.body;
      // A repeat keeps a visible toast up for another full duration, so "×4" can be read.
      if (this.visible.includes(same)) same.expiresAt = now + rule.duration;
      return 'merged';
    }
    const t: ToastState = { ...spec, key, uid: ++this.uid, count: 1, shownAt: 0, expiresAt: 0 };
    if (this.canShow(spec.category, now)) {
      this.show(t, now);
      return 'shown';
    }
    this.queue.push(t);
    this.sortQueue();
    if (this.queue.length > this.opts.maxQueue) {
      const dropped = this.queue.pop()!;
      return dropped === t ? 'dropped' : 'queued';
    }
    return 'queued';
  }

  /** Expire old toasts and promote queued ones. Returns true if anything changed. */
  tick(now: number): boolean {
    const before = this.visible.length + this.queue.length;
    const keep = this.visible.filter((t) => t.expiresAt > now);
    let changed = keep.length !== this.visible.length;
    this.visible = keep;
    for (let i = 0; i < this.queue.length; ) {
      const t = this.queue[i];
      if (this.canShow(t.category, now)) {
        this.queue.splice(i, 1);
        this.show(t, now);
        changed = true;
      } else i++;
    }
    return changed || before !== this.visible.length + this.queue.length;
  }

  /** Close one early (clicked). */
  dismiss(uid: number): void {
    this.visible = this.visible.filter((t) => t.uid !== uid);
  }

  private canShow(cat: ToastCategory, now: number): boolean {
    if (this.visible.length >= this.opts.maxVisible) return false;
    const last = this.lastShown[cat];
    return last === undefined || now - last >= this.opts.rules[cat].minGap;
  }

  private show(t: ToastState, now: number): void {
    t.shownAt = now;
    t.expiresAt = now + this.opts.rules[t.category].duration;
    this.lastShown[t.category] = now;
    this.visible.push(t);
  }

  private sortQueue(): void {
    // Stable: most important first, then oldest first.
    this.queue.sort((a, b) => this.opts.rules[b.category].priority - this.opts.rules[a.category].priority || a.uid - b.uid);
  }
}
