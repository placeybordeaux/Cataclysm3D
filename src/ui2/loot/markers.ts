// Pile markers: what's lying around, legible from across the room. Playtest: "It's unclear
// what's even in the item piles from the images" — the world draws up to three small item
// billboards (or one voxel slab) per pile, and storage furniture hides its contents entirely.
//
// Each pile / storage container in sight within MARK_RADIUS tiles gets a small pixel badge
// above it: its most notable item's icon (larger for a gun or something valuable) and how many
// things are there. Containers show what the survivor remembers (src/game/loot.ts LootMemory):
// unsearched ones a "?" that shimmers within reach, searched ones their contents, emptied
// ones a dim "empty" when close. DOM on the ui2 world layer (below the HUD and windows), so
// it stays crisp at every UI scale and costs the renderer nothing; line of sight is a tile
// walk (walls hide what's behind them), refreshed a few times a second, positions every frame.

import * as THREE from 'three';
import type { Game } from '../../game/game';
import type { Renderer } from '../../render/renderer';
import type { Item } from '../../game/item';
import { LEVEL_HEIGHT } from '../../world/coords';
import { lootValue, notableItem, type LootMemory } from '../../game/loot';
import { h, ui2Layers } from '../dom';
import { iconEl } from '../icons';
import { isLootContainer } from './sources';

export const MARK_RADIUS = 9;
/** At most this many badges (nearest first): a looted supermarket must not bury the view. */
const MAX_MARKS = 28;
/** Above this value (cents, scavenger-weighted) a pile's icon is drawn large. */
const BIG_VALUE = 4000;
const TALL = /locker|wardrobe|fridge|freezer|bookcase|shelf|rack|armoire|display|gunsafe|safe|vending/;

interface Mark {
  key: string;
  x: number;
  y: number;
  z: number;
  lift: number;
  el: HTMLElement;
  sig: string;
}

export interface MarkerOpts {
  enabled(): boolean;
  /** The source the quick-loot panel already shows (its badge would sit under the panel). */
  hiddenKey(): string | null;
}

export function installMarkers(game: Game, renderer: Renderer, memory: () => LootMemory, o: MarkerOpts): { refresh(): void; state(): { key: string; text: string }[] } {
  const layer = ui2Layers().world;
  const box = h('div', { class: 'lm-root' });
  layer.appendChild(box);
  const marks = new Map<string, Mark>();
  const v = new THREE.Vector3();

  const scan = () => {
    const p = game.player;
    const seen = new Set<string>();
    if (o.enabled() && !p.dead && !(game.vehicles?.driving)) {
      const found: { key: string; x: number; y: number; d: number }[] = [];
      const map = game.map;
      for (let dy = -MARK_RADIUS; dy <= MARK_RADIUS; dy++)
        for (let dx = -MARK_RADIUS; dx <= MARK_RADIUS; dx++) {
          const x = p.tileX + dx, y = p.tileY + dy;
          const d = Math.hypot(dx, dy);
          if (d > MARK_RADIUS + 0.5) continue;
          if (!map.itemsAt(x, y, p.z).length && !isLootContainer(map.furnAt(x, y, p.z))) continue;
          if (!lineOfSight(game, p.tileX, p.tileY, x, y, p.z)) continue;
          found.push({ key: `${x},${y},${p.z}`, x, y, d });
        }
      found.sort((a, b) => a.d - b.d);
      for (const f of found.slice(0, MAX_MARKS)) {
        const spec = describe(game, memory(), f.x, f.y, p.z, f.d);
        if (!spec) continue;
        seen.add(f.key);
        let m = marks.get(f.key);
        if (!m) {
          m = { key: f.key, x: f.x, y: f.y, z: p.z, lift: spec.lift, el: h('div', { class: 'lm' }), sig: '' };
          m.el.dataset.tile = f.key;
          marks.set(f.key, m);
          box.appendChild(m.el);
        }
        m.lift = spec.lift;
        if (m.sig !== spec.sig) {
          m.sig = spec.sig;
          m.el.className = `lm ${spec.cls}`;
          m.el.replaceChildren(...spec.children());
          m.el.title = spec.text;
          m.el.dataset.text = spec.text;
        }
      }
    }
    for (const [k, m] of marks)
      if (!seen.has(k)) {
        m.el.remove();
        marks.delete(k);
      }
  };

  const place = () => {
    const cam = renderer.camera;
    const canvas = renderer.three.domElement as HTMLCanvasElement;
    const r = canvas.getBoundingClientRect();
    const hide = o.hiddenKey();
    cam.updateMatrixWorld();
    for (const m of marks.values()) {
      v.set(m.x + 0.5, m.z * LEVEL_HEIGHT + m.lift, m.y + 0.5).project(cam);
      const on = v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05 && m.key !== hide;
      m.el.style.display = on ? '' : 'none';
      if (!on) continue;
      m.el.style.left = `${Math.round(r.left + ((v.x + 1) / 2) * r.width)}px`;
      m.el.style.top = `${Math.round(r.top + ((1 - v.y) / 2) * r.height)}px`;
    }
  };

  let t = 0;
  const loop = (now: number) => {
    requestAnimationFrame(loop);
    if (now - t > 200) {
      t = now;
      scan();
    }
    if (marks.size) place();
  };
  requestAnimationFrame(loop);
  return {
    refresh: () => {
      scan();
      place();
    },
    state: () => [...marks.values()].filter((m) => m.el.style.display !== 'none').map((m) => ({ key: m.key, text: m.el.dataset.text ?? '' })),
  };
}

interface Spec {
  cls: string;
  sig: string;
  text: string;
  lift: number;
  children(): (HTMLElement | string)[];
}

function describe(game: Game, memory: LootMemory, x: number, y: number, z: number, d: number): Spec | null {
  const map = game.map;
  const f = map.furnAt(x, y, z);
  const items = map.itemsAt(x, y, z) as unknown as Item[];
  const container = isLootContainer(f);
  const reach = d < 1.5;
  // Just above the thing: tall storage (lockers, fridges, shelves) vs counters and floor piles.
  const lift = container ? (TALL.test(f.id) ? 2.0 : 1.2) : f.id !== 'f_null' ? 0.95 : 0.4;
  if (container) {
    const st = memory.state(x, y, z);
    if (st === 'unsearched') {
      // Contents unknown until looked into (CDDA hides them too): a "?" that invites a look.
      return { cls: `unsearched${reach ? ' reach' : ''}`, sig: `u${reach}`, text: `${f.name}: not searched`, lift, children: () => ['?'] };
    }
    if (!items.length) {
      if (d > 4) return null;
      return { cls: 'empty', sig: 'e', text: `${f.name}: empty`, lift, children: () => ['empty'] };
    }
  }
  if (!items.length) return null;
  const top = notableItem(items)!;
  // Close piles and valuable ones (a gun across the room) get the full-size sprite.
  const big = d <= 4 || lootValue(top) >= BIG_VALUE || top.isGun();
  const n = items.length;
  const text = `${container ? `${f.name}: ` : ''}${top.name()}${n > 1 ? ` +${n - 1}` : ''}`;
  return {
    cls: `${big ? 'big' : ''}${reach ? ' reach' : ''}`,
    sig: `${top.typeId}:${n}:${big}:${reach}`,
    text,
    lift,
    children: () => [iconEl({ typeId: top.typeId, looksLike: top.def.looks_like, symbol: top.def.symbol, color: top.def.color }, 'row'), ...(n > 1 ? [h('span', { class: 'lm-n', text: `${n}` })] : [])],
  };
}

/** Tile walk from the player to (x, y): false if an opaque tile (a wall, a closed door) is between. */
export function lineOfSight(game: Game, x0: number, y0: number, x1: number, y1: number, z: number): boolean {
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy, x = x0, y = y0;
  while (x !== x1 || y !== y1) {
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
    if ((x !== x1 || y !== y1) && game.map.opaque(x, y, z)) return false;
  }
  return true;
}
