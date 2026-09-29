// InventoryModel over the mock store: the reference implementation a real screen follows.
// Actions carry mock time costs; "use" does the obvious thing per item; drop reasons come
// from the store's validation. Side effects that need the UI (open a panel, say something,
// bind to the hotbar) go through the hooks, so this file has no DOM.

import { isAccepted } from '../logic/dnd';
import { totalVolume, totalWeight, type ItemView } from '../logic/items';
import type { MenuItem } from '../menu';
import type { Capacity, InventoryModel, MoveOutcome } from '../model';
import { DOLL_SLOTS, type MockKit } from './data';
import { insideOf } from './store';

export interface MockHooks {
  openContainer(loc: string, item: ItemView): void;
  notify(text: string, tone?: 'good' | 'bad' | 'warn' | 'info'): void;
  /** Hotbar binding, if the screen has one. */
  bindHotbar?(slot: number, item: ItemView): void;
  /** Destructive confirm (modal). */
  confirm(title: string, body: string, ok: string): Promise<boolean>;
  /** Count prompt for "Drop some…". */
  split(item: ItemView): void;
}

const COMESTIBLE = new Set(['food', 'drugs']);
/** Carry limit for the mock survivor (grams): shows the weight bar and its overflow state. */
export const MOCK_CARRY_LIMIT = 18000;

export class MockInventoryModel implements InventoryModel {
  constructor(readonly kit: MockKit, private hooks: MockHooks) {}

  get store() {
    return this.kit.store;
  }

  contents(loc: string): ItemView[] {
    return this.store.contents(loc);
  }
  name(loc: string): string {
    return this.store.name(loc);
  }
  capacity(loc: string): Capacity | null {
    const r = this.store.rules(loc);
    if (r.maxVolume === undefined) return null;
    const items = this.contents(loc);
    return {
      volume: [items.reduce((a, c) => a + totalVolume(c), 0), r.maxVolume],
      weight: [items.reduce((a, c) => a + totalWeight(c), 0), r.maxWeight ?? Infinity],
    };
  }
  insideOf(item: ItemView): string | null {
    return item.capacity ? insideOf(item.id) : null;
  }
  check(itemId: string, to: string, count: number) {
    return this.store.check(itemId, to, count);
  }
  move(itemId: string, to: string, count: number): MoveOutcome {
    const r = this.store.move(itemId, to, count);
    return r.ok ? { ok: true } : r;
  }
  split(itemId: string, count: number): void {
    this.store.split(itemId, count);
  }
  onChange(fn: () => void): () => void {
    return this.store.onChange(fn);
  }
  where(loc: string): string {
    if (loc === 'ground') return 'On the ground';
    if (loc.startsWith('worn:')) return loc === 'worn:wield' ? 'Wielded' : `Worn: ${this.name(loc)}`;
    return `In ${this.name(loc)}`;
  }
  dropToWorld(itemId: string, count: number): MoveOutcome {
    return this.move(itemId, 'ground', count);
  }

  /** Worn containers (backpack, jeans pockets…) in doll order: where picked-up things go. */
  carriedContainers(): ItemView[] {
    // The bag on your back first: it's where a quick move should go before your pockets.
    const order = ['back', ...DOLL_SLOTS.map((s) => s.id).filter((id) => id !== 'back')];
    return order.flatMap((id) => this.contents(this.kit.slot(id))).filter((it) => it.capacity);
  }

  /** Total carried weight (worn + wielded + everything inside). */
  carried(): number {
    return DOLL_SLOTS.flatMap((s) => this.contents(this.kit.slot(s.id))).reduce((a, it) => a + totalWeight(it), 0);
  }

  /** The doll slot an item would be worn in (first that accepts it), or null. */
  wearSlot(item: ItemView): string | null {
    if (!item.covers) return null;
    for (const s of DOLL_SLOTS) {
      if (s.id === 'wield') continue;
      const loc = this.kit.slot(s.id);
      const v = this.store.find(item.id) ? this.check(item.id, loc, 1) : null;
      if (v && (isAccepted(v) || v.kind === 'noop')) return loc;
    }
    // Fall back to the first slot whose parts match (it may be occupied: swap is decided later).
    const s = DOLL_SLOTS.find((d) => d.id !== 'wield' && item.covers!.some((p) => d.parts.includes(p)));
    return s ? this.kit.slot(s.id) : null;
  }

  quickMoveTarget(item: ItemView, loc: string): string | null {
    if (loc !== 'ground') return 'ground';
    for (const c of this.carriedContainers()) {
      const to = insideOf(c.id);
      if (isAccepted(this.check(item.id, to, item.count))) return to;
    }
    // Partial fits are still a quick move (as many as fit).
    return this.carriedContainers()[0] ? insideOf(this.carriedContainers()[0].id) : null;
  }

  compareWith(item: ItemView, loc: string): ItemView | null {
    // Only like with like: food isn't compared with your machete.
    if (loc.startsWith('worn:') || COMESTIBLE.has(item.category ?? '') || (!item.covers && !item.stats?.length)) return null;
    const slot = item.covers ? this.wearSlot(item) : this.kit.slot('wield');
    return slot ? this.contents(slot)[0] ?? null : null;
  }

  use(item: ItemView, loc: string): void {
    const primary = this.actions(item, loc).find((a) => 'label' in a && a.primary && !a.disabled && a.action);
    if (primary && 'action' in primary) primary.action!();
  }

  private say(r: MoveOutcome, ok: string): void {
    if (r.ok) this.hooks.notify(ok);
    else this.hooks.notify(r.reason, 'bad');
  }

  actions(item: ItemView, loc: string): MenuItem[] {
    const out: MenuItem[] = [];
    const food = COMESTIBLE.has(item.category ?? '');
    const worn = loc.startsWith('worn:') && loc !== 'worn:wield';
    const wielded = loc === 'worn:wield';
    const reason = (to: string, n = item.count): string | false => {
      const v = this.check(item.id, to, n);
      return v.kind === 'reject' ? v.reason : v.kind === 'noop' ? 'Already there' : false;
    };
    if (item.capacity) {
      out.push({ label: 'Open', key: 'O', time: 0.5, primary: true, action: () => this.hooks.openContainer(insideOf(item.id), item) });
    }
    if (food) {
      const drink = item.icon?.symbol === '~';
      out.push({
        label: drink ? 'Drink' : 'Eat', key: 'E', time: drink ? 5 : 30, primary: !item.capacity,
        action: () => {
          this.store.consume(item.id, 1);
          this.hooks.notify(`You ${drink ? 'drink' : 'eat'} the ${item.name}.`, 'good');
        },
      });
    }
    if (worn) {
      const to = this.quickMoveTarget(item, loc);
      out.push({ label: 'Take off', key: 'T', time: 3, primary: !item.capacity, action: () => to && this.say(this.move(item.id, to, 1), `You take off the ${item.name}.`) });
    } else if (item.covers) {
      const slot = this.wearSlot(item);
      out.push({ label: 'Wear', key: 'W', time: 4, primary: !item.capacity && !food, disabled: slot ? reason(slot, 1) : 'Nowhere to wear it', action: () => slot && this.say(this.move(item.id, slot, 1), `You put on the ${item.name}.`) });
    }
    if (!wielded) {
      out.push({ label: 'Wield', key: 'Z', time: 1, primary: !item.covers && !food && !item.capacity, disabled: reason('worn:wield', item.count), action: () => this.say(this.move(item.id, 'worn:wield', item.count), `You wield the ${item.name}.`) });
    } else out.push({ label: 'Put away', key: 'Z', time: 1, primary: true, action: () => this.say(this.move(item.id, this.quickMoveTarget(item, loc) ?? 'ground', item.count), `You put away the ${item.name}.`) });
    // Put in ▸ every carried container except the one it's in (and itself).
    const boxes = this.carriedContainers().filter((c) => c.id !== item.id && insideOf(c.id) !== loc);
    if (boxes.length)
      out.push({
        label: 'Put in', key: 'P',
        submenu: () =>
          boxes.map((c) => {
            const to = insideOf(c.id);
            const v = this.check(item.id, to, item.count);
            return {
              label: c.name, icon: c.icon, time: 1.5,
              disabled: v.kind === 'reject' ? v.reason : false,
              action: () => this.say(this.move(item.id, to, item.count), v.kind === 'partial' ? v.reason : `You put the ${item.name} in the ${c.name}.`),
            };
          }),
      });
    if (loc === 'ground') {
      const to = this.quickMoveTarget(item, loc);
      out.push({ label: 'Pick up', key: 'G', time: 1, disabled: to ? reason(to) : 'Nothing to carry it in', action: () => to && this.say(this.move(item.id, to, item.count), `You pick up the ${item.name}.`) });
    } else out.push({ label: 'Drop', key: 'D', time: 1, action: () => this.say(this.move(item.id, 'ground', item.count), `You drop the ${item.name}.`) });
    if (item.count > 1) out.push({ label: 'Split stack…', key: 'S', action: () => this.hooks.split(item) });
    if (this.hooks.bindHotbar)
      out.push({
        label: 'Bind to hotbar', key: 'B',
        submenu: Array.from({ length: 10 }, (_, i) => ({ label: `Slot ${(i + 1) % 10}`, key: String((i + 1) % 10), action: () => this.hooks.bindHotbar!(i, item) })),
      });
    out.push({ separator: true });
    out.push({ label: 'Disassemble', time: 600, disabled: 'Need: a screwdriver (screw driving 1)' });
    out.push({
      label: 'Burn it', danger: true, time: 20,
      action: async () => {
        if (await this.hooks.confirm(`Burn the ${item.name}?`, 'It will be gone for good.', 'Burn it')) {
          this.store.consume(item.id, item.count);
          this.hooks.notify(`The ${item.name} goes up in flames.`, 'warn');
        }
      },
    });
    return out;
  }
}
