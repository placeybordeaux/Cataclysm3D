// World context menus: right-click a thing in the 3D world (while the cursor is free) for what
// you can do with it. Systems contribute entries without knowing about each other:
//
//   worldContextProviders.push((t) => t.furniture === 'f_locker' ? [{ label: 'Open', time: 2, action }] : []);
//
// Providers get a WorldTarget (what's under the cursor); their entries are joined with
// separators in registration order. The first `primary` entry is also what a left-click on
// the object does. In the game, `t.hit` is the tile raycast (src/game/raycast.ts RayHit).

import type { MenuItem } from './menu';

export interface WorldTarget {
  kind: 'creature' | 'furniture' | 'terrain' | 'floor' | 'ceiling' | 'vehicle' | 'items' | 'mock';
  /** What the player would call it: "zombie", "locker", "wooden door". */
  name: string;
  x: number;
  y: number;
  z: number;
  /** Ids when relevant (terrain / furniture / monster type). */
  terrain?: string;
  furniture?: string;
  creature?: unknown;
  /** Distance from the eye, metres. */
  dist?: number;
  /** The raw hit from the host (game: RayHit), for providers that need more. */
  hit?: unknown;
}

export type WorldContextProvider = (t: WorldTarget) => MenuItem[];

export const worldContextProviders: WorldContextProvider[] = [];

/** All providers' entries for a target, separated per provider; [] if nobody has anything. */
export function worldMenu(t: WorldTarget): MenuItem[] {
  const groups = worldContextProviders.map((p) => p(t)).filter((g) => g.length);
  return groups.flatMap((g, i) => (i ? [{ separator: true } as MenuItem, ...g] : g));
}
