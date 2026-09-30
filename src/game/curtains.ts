import type { Game } from './game';
import type { TerrainDef } from '../data/types';
import type { Interaction } from './interact';
import { createItem } from './item';
import { spawnOnGround } from './moves';
import { emitSound } from './sound';
import { sfx } from '../audio/sfx';
import { hasFlag } from '../world/registry';
import { invalidateNaturalLight } from './vision';
import { pryInfo, pryAttempt } from './pry';
import { clockScale } from '../core/time';

// Curtained windows, after BN iexamine::curtains and the terrain chains in
// data/json/furniture_and_terrain/terrain-windows.json. BN encodes curtains purely as terrain:
//
//   t_curtains  --open-->  t_window_domestic  --open-->  t_window_open
//   (curtains drawn,        (curtains open,               (window open)
//    not TRANSPARENT)        window shut)
//              <--close--                     <--close--
//
// so the same `o`pen/`c`lose keys step through curtains and window, and "open" on
// t_window_domestic opens the *window* while "close" draws the *curtains*. In BN you learn that
// from the tile's name; in first person the prompt said "Open the window with curtains" for both,
// and `e` just ran the first entry, so the curtains could never be worked (user report). Here
// each transition is named for what it does, decided from the data: a step that changes
// TRANSPARENT is the curtains, one that keeps it is the window.
//
// Inside only, like BN (OPENCLOSE_INSIDE / BARRICADABLE_WINDOW_CURTAINS): from outside a curtained
// window is locked_object (pry it with a crowbar or smash it). Inside, BN's examine menu adds
// "Peek through the closed curtains" and "Tear down the curtains" (sheets, stick, string, nails).

export interface CurtainMove {
  kind: 'curtains' | 'window';
  action: 'open' | 'close';
  to: string;
}

/** examine_action "curtains": a window with curtains of some kind. */
export function hasCurtains(t: TerrainDef): boolean {
  return t.examine_action === 'curtains';
}

/** Curtains drawn: the window lets no light or sight through (BN deletes TRANSPARENT). */
export function curtainsClosed(t: TerrainDef): boolean {
  // A taped pane (t_window_domestic_taped) is opaque for the tape, its curtains aren't drawn.
  return hasCurtains(t) && !hasFlag(t, 'TRANSPARENT') && !t.id.includes('taped');
}

/** The open/close steps of a curtained window, each named for what it moves. */
export function curtainMoves(game: Game, t: TerrainDef): CurtainMove[] {
  const reg = game.map.terrain;
  const out: CurtainMove[] = [];
  const see = hasFlag(t, 'TRANSPARENT');
  for (const action of ['open', 'close'] as const) {
    const to = action === 'open' ? t.open : t.close;
    if (typeof to !== 'string' || !reg.has(to)) continue;
    const toSee = hasFlag(reg.get(reg.index(to)), 'TRANSPARENT');
    out.push({ kind: see !== toSee ? 'curtains' : 'window', action, to });
  }
  // curtains first: they're what `e` on a curtained window is usually for
  return out.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'curtains' ? -1 : 1));
}

function changed(game: Game, x: number, y: number, z: number): void {
  // Daylight indoors is cached for 30 game seconds; a drawn curtain should darken the room now.
  invalidateNaturalLight(game);
  game.events.emit('mapChanged', { x, y, z });
}

/** Draw or open the curtains / open or shut the window (the player is inside). */
export function applyCurtainMove(game: Game, x: number, y: number, z: number, m: CurtainMove): string | null {
  const map = game.map;
  const t = map.terAt(x, y, z);
  const pos = { x: x + 0.5, y: y + 0.5, z };
  if (m.kind === 'window' && m.action === 'close') {
    const p = game.player;
    if (p.tileX === x && p.tileY === y && p.z === z) return "There's you in the way!";
    if (map.itemsAt(x, y, z).length) return `There's something in the way of the window!`;
  }
  map.setTer(x, y, z, m.to);
  if (m.kind === 'curtains') {
    sfx.curtains(m.action, pos);
    emitSound(game, { x, y, z }, 2, 'swish', { category: 'movement', source: game.player, sfxId: '', ambient: true });
  } else {
    sfx.door(m.action, pos, t.id);
    emitSound(game, { x, y, z }, m.action === 'open' ? 6 : 10, 'swish', { category: 'movement', source: game.player, sfxId: '' });
  }
  changed(game, x, y, z);
  return null;
}

/** Real seconds a peek holds the curtains apart (BN's look-around mode, here a short activity). */
export const PEEK_SECONDS = 6;

/**
 * BN "Peek through the closed curtains": part them for a few seconds, then let them fall back.
 * Moving (or anything that interrupts an activity) ends the peek early.
 */
export function peekThroughCurtains(game: Game, x: number, y: number, z: number): void {
  const map = game.map;
  const from = map.terAt(x, y, z);
  const open = curtainMoves(game, from).find((m) => m.kind === 'curtains' && m.action === 'open');
  if (!open) throw new Error(`peekThroughCurtains: ${from.id} has no curtains to part`);
  const pos = { x: x + 0.5, y: y + 0.5, z };
  const letFall = () => {
    // Only if nobody changed the window meanwhile (smashed, or opened for real).
    if (map.terAt(x, y, z).id !== open.to) return;
    map.setTer(x, y, z, from.id);
    sfx.curtains('close', pos);
    changed(game, x, y, z);
  };
  map.setTer(x, y, z, open.to);
  sfx.curtains('open', pos, 0.5);
  changed(game, x, y, z);
  game.message('You carefully peek through the curtains.', 'c_light_gray');
  const started = game.activities.start({
    name: 'peeking through the curtains',
    // game time runs clockScale()× real time; a peek is for looking, so it lasts in real seconds
    duration: PEEK_SECONDS * clockScale(),
    warp: 1,
    onComplete: letFall,
    onCancel: letFall,
  });
  if (!started) letFall();
}

/** BN tears down: 2 sheets, a stick, a string and 4 nails, 10 seconds of work. */
export function tearDownCurtains(game: Game, x: number, y: number, z: number): void {
  const map = game.map;
  const t = map.terAt(x, y, z);
  const to = typeof t.curtain_transform === 'string' ? t.curtain_transform : null;
  if (!to || !map.terrain.has(to)) throw new Error(`tearDownCurtains: ${t.id} has no curtain_transform`);
  const p = game.player;
  game.activities.start({
    name: 'tearing down the curtains',
    duration: 10,
    onComplete: () => {
      if (map.terAt(x, y, z).id !== t.id) return;
      map.setTer(x, y, z, to);
      const drop = (id: string, opts?: { charges: number }) => {
        if (game.data.items[id]) spawnOnGround(map, p.tileX, p.tileY, p.z, createItem(game.data, id, opts));
      };
      drop('nail', { charges: 4 });
      drop('sheet');
      drop('sheet');
      drop('stick');
      drop('string_36');
      game.message('You tear the curtains and curtain rod off the window frame.', 'c_light_gray');
      sfx.smash({ x: x + 0.5, y: y + 0.5, z }, { success: true, material: 'soft' });
      emitSound(game, { x, y, z }, 8, 'rrrip!', { category: 'destructive_activity', source: p, sfxId: '' });
      changed(game, x, y, z);
    },
  });
}

/** Interactions for a curtained window, from inside or out. */
export function curtainInteractions(game: Game, x: number, y: number, z: number, inside: boolean, smashKey: string): Interaction[] {
  const t = game.map.terAt(x, y, z);
  const out: Interaction[] = [];
  if (!inside) {
    // BN: from outside a curtained window is a locked_object: pry it or smash it.
    const pry = pryInfo(t);
    if (pry && pry.canPry(game)) out.push({ id: 'pry', label: `Pry open the ${t.name}`, run: () => pryAttempt(game, x, y, z, t) });
    else
      out.push({
        id: 'examine',
        label: `Examine the ${t.name}`,
        run: () => game.message(curtainsClosed(t)
          ? `The curtains are drawn on the inside: you can't see in, and the latch is out of reach.  Pry it open with a crowbar, or smash it (or [${smashKey}]).`
          : `The ${t.name} latches on the inside.  Pry it open with a crowbar, or smash it (or [${smashKey}]).`, 'c_light_gray'),
      });
    return out;
  }
  for (const m of curtainMoves(game, t)) {
    const label = m.kind === 'curtains' ? `${m.action === 'open' ? 'Open' : 'Close'} the curtains` : `${m.action === 'open' ? 'Open' : 'Close'} the window`;
    out.push({ id: `${m.kind}_${m.action}`, label, run: () => { const r = applyCurtainMove(game, x, y, z, m); if (r) game.message(r); } });
  }
  // BN offers the peek only on drawn curtains (it's pointless through open ones).
  if (curtainsClosed(t) && curtainMoves(game, t).some((m) => m.kind === 'curtains' && m.action === 'open'))
    out.push({ id: 'peek', label: 'Peek through the curtains', run: () => peekThroughCurtains(game, x, y, z) });
  if (typeof t.curtain_transform === 'string' && game.map.terrain.has(t.curtain_transform))
    out.push({ id: 'tear_curtains', label: 'Tear down the curtains', run: () => tearDownCurtains(game, x, y, z) });
  return out;
}
