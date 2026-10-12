import { heldClass, type HeldItemLike, type HeldClass } from './held';
import type { ItemPresentation } from '../../game/inventory';

/** Cosmetic real-time gesture; menus retain the pending action until the world is visible. */
export class ItemGesture {
  action: ItemPresentation | null = null;
  elapsed = 0;
  readonly duration = 1.2;
  start(action: ItemPresentation): void { this.action = action; this.elapsed = 0; }
  clear(): void { this.action = null; this.elapsed = 0; }
  update(dt: number, paused: boolean): ItemPresentation | null {
    if (!paused && this.action) this.elapsed += Math.max(0, dt);
    if (this.elapsed >= this.duration) this.clear();
    return this.action;
  }
  get lift(): number { return Math.sin(Math.PI * Math.min(1, this.elapsed / this.duration)); }
}

/** Food names like 'chocolate bar' must never invoke the melee keyword classifier. */
export function gestureClass(item: HeldItemLike, kind?: ItemPresentation['kind']): HeldClass {
  return kind === 'eat' || kind === 'drink' ? 'generic' : heldClass(item);
}
