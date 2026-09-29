// The contract between inventory-like screens and the game. A screen (inventory, trade,
// vehicle cargo, crafting inputs…) implements InventoryModel over whatever the game stores;
// containerView / paperDollView / the drop targets only ever talk to this. The mock
// (src/ui2/mock/model.ts) is a complete reference implementation.
//
// Locations are opaque strings the model understands: 'ground', 'worn:torso', 'in:<id>'…

import type { DropVerdict } from './logic/dnd';
import type { ItemView } from './logic/items';
import type { MenuItem } from './menu';

export interface Capacity {
  /** [used, max] ml / g. */
  volume: [number, number];
  weight: [number, number];
}

export type MoveOutcome = { ok: true } | { ok: false; reason: string };

export interface InventoryModel {
  contents(loc: string): ItemView[];
  /** Display name: "Backpack", "Ground". */
  name(loc: string): string;
  /** null = unlimited (the ground). */
  capacity(loc: string): Capacity | null;
  /** Where the inside of a container item lives, or null if it isn't one. */
  insideOf(item: ItemView): string | null;
  /** Called on every hover while dragging: must be cheap and side-effect free. */
  check(itemId: string, to: string, count: number): DropVerdict;
  move(itemId: string, to: string, count: number): MoveOutcome;
  /** Split `count` off into a new stack next to it. */
  split(itemId: string, count: number): void;
  /** Right-click menu. First entry with `primary` is what double-click does. */
  actions(item: ItemView, loc: string): MenuItem[];
  /** Double-click / Enter: the obvious thing (eat, wear, wield, open). */
  use(item: ItemView, loc: string): void;
  /** Shift-click: where the item goes (ground → backpack → ground…), or null. */
  quickMoveTarget(item: ItemView, loc: string): string | null;
  /** The item this one would replace, for tooltip ▲▼ (same slot / wielded weapon). */
  compareWith(item: ItemView, loc: string): ItemView | null;
  /** "In your backpack", "On the ground": tooltip location line. */
  where(loc: string): string;
  /** Drop on the 3D world at a screen point; omit if the screen has no world. */
  dropToWorld?(itemId: string, count: number, at: { x: number; y: number }): MoveOutcome;
  onChange(fn: () => void): () => void;
}
