// Route to the map destination (docs/ADAPTATION.md). The map lets you set a destination and the
// compass points at it, straight as the crow flies: the playtester walked into a forest (slow,
// trees to snag on) when a road ran right past. This plans a walking route over the overmap
// (roads cheap, forest dear, water out), draws it on the map, and shows it in the world:
//
//   Trail  (default) a faint line of pixel diamonds on the ground for the next ~30 m,
//          like footprints in dust, following walkable tiles toward the next leg of the route.
//   Beacon a single marker hovering over the next leg of the route ("Road · 180 m to House"),
//          like a flare you're walking toward.
//   Off    compass pip only (the old behaviour).
//
// Options > Route guide, or ?route=trail|beacon|off. The compass pip and its distance stay in
// every mode.

import * as THREE from 'three';
import type { Game } from '../game/game';
import type { Renderer } from '../render/renderer';
import { findPath } from '../game/pathfind';
import { Grid } from '../game/los';
import { CHUNK, LEVEL_HEIGHT } from '../world/coords';
import { h, ui2Layers } from '../ui2/dom';
import { lineOfSight } from '../ui2/loot/markers';
import { mapMarks } from './mapmarks';
import { registerOption } from './options';
import './route.css';

export type RouteMode = 'trail' | 'beacon' | 'off';
const MODES: RouteMode[] = ['trail', 'beacon', 'off'];
const KEY = 'cdda3d.routeGuide';

export function routeMode(): RouteMode {
  const q = new URLSearchParams(location.search).get('route');
  if (q !== null) {
    if (!(MODES as string[]).includes(q)) throw new Error(`?route=${q}: expected one of ${MODES.join(', ')}`);
    return q as RouteMode;
  }
  try {
    const s = localStorage.getItem(KEY);
    if (s && (MODES as string[]).includes(s)) return s as RouteMode;
  } catch {
    // storage blocked: default
  }
  return 'trail';
}

// ------------------------------------------------------------------ overmap route (pure)

/**
 * Walking cost of crossing one OMT, by overmap terrain type (1 = a road). Infinity = don't
 * route through (open water). Buildings are allowed: you can walk through a yard or a house.
 */
export function omtCost(type: string): number {
  if (type === 'road' || type === 'bridge' || type.startsWith('road_')) return 1;
  if (/^(river|lake)/.test(type) || type === 'open_air') return Infinity;
  if (type === 'field' || /parking|lot/.test(type)) return 1.6;
  if (type === 'forest') return 3;
  if (type === 'forest_thick') return 4.5;
  if (/swamp|forest_water/.test(type)) return 6;
  return 2.2;
}

/**
 * A* over OMTs from `from` to `to` (inclusive), 4-connected. `cost(x, y)` is the price of
 * entering (x, y). Gives up after `maxNodes` expansions (null): a route is a convenience, and
 * an unreachable or very far destination keeps the compass.
 */
export function planOmtRoute(cost: (x: number, y: number) => number, from: { x: number; y: number }, to: { x: number; y: number }, maxNodes = 6000): { x: number; y: number }[] | null {
  if (from.x === to.x && from.y === to.y) return [{ ...from }];
  const key = (x: number, y: number) => `${x},${y}`;
  const g = new Map<string, number>([[key(from.x, from.y), 0]]);
  const prev = new Map<string, string>();
  const open: { x: number; y: number; f: number }[] = [{ ...from, f: 0 }];
  const hEst = (x: number, y: number) => Math.abs(x - to.x) + Math.abs(y - to.y);
  let n = 0;
  while (open.length && n++ < maxNodes) {
    // Small open sets: a linear min-pick is fine and keeps this dependency-free.
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
    const cur = open.splice(bi, 1)[0];
    const ck = key(cur.x, cur.y);
    if (cur.x === to.x && cur.y === to.y) {
      const out = [{ x: cur.x, y: cur.y }];
      let k = ck;
      while (prev.has(k)) {
        k = prev.get(k)!;
        const [x, y] = k.split(',').map(Number);
        out.push({ x, y });
      }
      return out.reverse();
    }
    const gc = g.get(ck)!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cur.x + dx, ny = cur.y + dy;
      // The destination itself is always enterable (a house on a lake shore).
      const c = nx === to.x && ny === to.y ? 1 : cost(nx, ny);
      if (!Number.isFinite(c)) continue;
      const ng = gc + c, nk = key(nx, ny);
      if (ng < (g.get(nk) ?? Infinity)) {
        g.set(nk, ng);
        prev.set(nk, ck);
        const existing = open.find((o) => o.x === nx && o.y === ny);
        if (existing) existing.f = ng + hEst(nx, ny);
        else open.push({ x: nx, y: ny, f: ng + hEst(nx, ny) });
      }
    }
  }
  return null;
}

// ------------------------------------------------------------------ live route

interface Overmapish {
  omtAt(x: number, y: number, z: number): { type: string; special?: unknown };
}

/**
 * Parts of big specials (the refugee center's fenced compound, labs, farms) are walled or
 * fenced: route round them, only entering the destination tile (use the entrance: see
 * Overmap.specialEntrance). Playtest: the route to the
 * refugee center's gate ran straight through its fence and main building.
 */
const SPECIAL_EXTRA = 4;

export interface LiveRoute {
  /** OMTs from the player's to the destination's. */
  omts: { x: number; y: number }[];
  dest: { x: number; y: number; z: number; label: string };
  /** Walking distance along the route, metres (OMT centres, 24 m each). */
  metres: number;
}

const routes = new WeakMap<Game, { sig: string; route: LiveRoute | null }>();

/** The route to the destination, re-planned when you change OMT or the destination changes. */
export function currentRoute(game: Game, overmap: Overmapish | null): LiveRoute | null {
  const d = mapMarks(game).destination;
  const p = game.player;
  if (!d || !overmap || d.z !== p.z || p.z !== 0) return null;
  const px = Math.floor(p.x / CHUNK), py = Math.floor(p.y / CHUNK);
  const sig = `${px},${py}>${d.x},${d.y},${d.z}`;
  const cached = routes.get(game);
  if (cached && cached.sig === sig) return cached.route;
  const omts = planOmtRoute((x, y) => {
    const o = overmap.omtAt(x, y, 0);
    // Destination tile itself is exempt (a destination is usually a special's entrance).
    const walled = !!o.special && !(x === d.x && y === d.y);
    return omtCost(o.type) + (walled ? SPECIAL_EXTRA : 0);
  }, { x: px, y: py }, d);
  const route = omts ? { omts, dest: d, metres: Math.max(0, omts.length - 1) * CHUNK } : null;
  routes.set(game, { sig, route });
  return route;
}

/** The tile to head for now: the centre of the route's OMT `ahead` steps on (the destination's last). */
export function nextTarget(route: LiveRoute, ahead = 2): { x: number; y: number } {
  const o = route.omts[Math.min(route.omts.length - 1, ahead)];
  return { x: o.x * CHUNK + CHUNK / 2, y: o.y * CHUNK + CHUNK / 2 };
}

// ------------------------------------------------------------------ in-world display

const TRAIL_TILES = 30;
const DOT_EVERY = 2;

export function installRouteGuide(game: Game, renderer: Renderer, overmap: () => Overmapish | null): void {
  registerOption({
    name: 'Route guide',
    value: () => ({ trail: 'Trail on the ground', beacon: 'Beacon ahead', off: 'Off (compass only)' })[routeMode()],
    change: (dir) => {
      const i = MODES.indexOf(routeMode());
      try {
        localStorage.setItem(KEY, MODES[(i + (dir ?? 1) + MODES.length) % MODES.length]);
      } catch {
        // not persisted
      }
    },
    desc: 'With a destination set on the map (right-click → Set as destination): a faint trail of marks on the ground along the way (roads first), a single beacon over the next stretch, or just the compass.',
  });

  const layer = ui2Layers().world;
  const root = h('div', { class: 'rt-root', attrs: { 'data-testid': 'route-guide' } });
  layer.appendChild(root);
  const beacon = h('div', { class: 'rt-beacon' }, h('div', { class: 'rt-pin' }), h('div', { class: 'rt-label' }));
  root.appendChild(beacon);
  const dots: HTMLElement[] = [];
  let pts: { x: number; y: number }[] = [];
  let beaconAt: { x: number; y: number } | null = null;
  const grid = new Grid(game.map);
  const v = new THREE.Vector3();

  const replan = () => {
    const driving = !!game.vehicles?.driving;
    // Driving: ground marks a few metres ahead are useless at 40 mph, so the trail becomes a
    // beacon further along the route (playtest: nothing showed the way while driving).
    const mode = driving && routeMode() === 'trail' ? 'beacon' : routeMode();
    const p = game.player;
    const route = mode === 'off' || p.dead ? null : currentRoute(game, overmap());
    pts = [];
    beaconAt = null;
    root.dataset.metres = route ? String(route.metres) : '';
    if (!route) return;
    const ahead = driving ? 4 : 2;
    const target = nextTarget(route, ahead);
    if (mode === 'beacon') {
      beaconAt = target;
      // Walking distance: along the route from the next leg, plus the straight bit to it.
      const rest = Math.max(0, route.omts.length - 1 - ahead) * CHUNK;
      const walk = Math.hypot(target.x - p.x, target.y - p.y) + rest;
      // Say it is the route length: the compass above shows the straight-line distance, and
      // "Dana · 970 m" next to "Dana · 1463 m" read as a contradiction (playtest).
      (beacon.lastChild as HTMLElement).textContent = `${route.dest.label} · ${Math.round(walk)} m ${driving ? "along the route" : "on foot"}`;
      return;
    }
    // Trail: walkable tiles toward the next leg, the first TRAIL_TILES of them, every other one.
    grid.reset();
    const res = findPath(grid, p.tileX, p.tileY, Math.round(target.x), Math.round(target.y), p.z, { doors: true, maxNodes: 2500, margin: 10 });
    for (let i = DOT_EVERY; i < Math.min(res.tiles.length, TRAIL_TILES); i += DOT_EVERY) {
      const [x, y] = res.tiles[i];
      if (lineOfSight(game, p.tileX, p.tileY, x, y, p.z)) pts.push({ x, y });
    }
    // For tests and debugging (tools/realinput.ts): the tile path's first steps.
    root.dataset.path = `${res.complete ? 'ok' : 'partial'}:${res.tiles.slice(0, 6).map(([x, y]) => `${x},${y}`).join(' ')}`;
  };

  const place = () => {
    const cam = renderer.camera;
    const r = (renderer.three.domElement as HTMLCanvasElement).getBoundingClientRect();
    cam.updateMatrixWorld();
    const z = game.player.z;
    const project = (x: number, y: number, lift: number) => {
      v.set(x, z * LEVEL_HEIGHT + lift, y).project(cam);
      return { sx: Math.round(r.left + ((v.x + 1) / 2) * r.width), sy: Math.round(r.top + ((1 - v.y) / 2) * r.height), on: v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05 };
    };
    while (dots.length < pts.length) dots.push(root.appendChild(h('div', { class: 'rt-dot' })));
    dots.forEach((d, i) => {
      const pt = pts[i];
      if (!pt) return void (d.style.display = 'none');
      const s = project(pt.x + 0.5, pt.y + 0.5, 0.06);
      d.style.display = s.on ? '' : 'none';
      if (!s.on) return;
      d.style.left = `${s.sx}px`;
      d.style.top = `${s.sy}px`;
      // Fade out along the trail: it's a hint, not a road marking.
      d.style.opacity = (0.75 - (i / Math.max(1, pts.length)) * 0.55).toFixed(2);
    });
    if (beaconAt) {
      const s = project(beaconAt.x, beaconAt.y, 3.2);
      beacon.style.display = s.on ? '' : 'none';
      beacon.style.left = `${s.sx}px`;
      beacon.style.top = `${s.sy}px`;
    } else beacon.style.display = 'none';
  };

  let t = 0;
  const loop = (now: number) => {
    requestAnimationFrame(loop);
    if (now - t > 400) {
      t = now;
      replan();
    }
    place();
  };
  requestAnimationFrame(loop);
}
