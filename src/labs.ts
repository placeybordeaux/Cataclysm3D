import type { Game } from './game/game';
import type { DebugApi } from './debug';
import type { WorldGenerator } from './world/worldgen';
import type { Item } from './game/item';
import { examineHandlers, interactionProviders, type Interaction } from './game/interact';
import {
  autoUi, cardreaderOf, climbOver, computerAt, elevatorFloors, gateAt, isConsole, labHooks, operateGate, rideElevator,
  useCardreader, useComputer, type LabUi,
} from './game/labs';
import { oterRotation } from './world/overmap/oter';
import { LAB_SPECIAL, MICROLAB_SPECIAL } from './world/overmap/overmap';
import { CHUNK } from './world/coords';
import { hasFlag } from './world/registry';
import { c, colorize, confirm, openMenu, openWindow } from './ui/framework';

// Wiring for underground labs (src/game/labs.ts): `e` on card readers, consoles, elevator
// controls, gate controls and climbable obstacles, the world-generator hooks those need, and
// window.cdda helpers (teleportLab, labMap, labs, useComputer, swipeCard). main.ts calls
// installLabs() once after the world interaction systems.

/** The curses UI for terminals and readers (framework windows). */
export function labUi(): LabUi {
  return {
    ask: (q) => confirm(q),
    choose: (title, options) =>
      new Promise((resolve) => {
        let chosen = -1;
        openMenu<number>({
          title,
          entries: options.map((o, i) => ({ label: o.disabled ? c('c_dark_gray', o.label) : c('c_white', o.label), value: i, disabled: o.disabled })),
          onSelect: (i) => {
            chosen = i;
          },
          onClose: () => resolve(chosen),
        });
      }),
    show: (title, text) =>
      new Promise((resolve) => {
        const w = openWindow({
          title,
          width: '64ch',
          footer: c('c_light_gray', 'Press any key…'),
          onKey: () => (w.close(), true),
          onClose: () => resolve(),
        });
        w.body.innerHTML = `<div class="pre" style="color:var(--c-light_green);white-space:pre-wrap">${colorize(text)}</div>`;
      }),
  };
}

export function installLabs(game: Game, worldgen: WorldGenerator | null, api?: DebugApi): void {
  const ui = (): LabUi => (typeof document === 'undefined' ? autoUi(game) : labUi());
  if (worldgen) {
    const defs = worldgen.wg.overmap.terrains;
    labHooks.mapgenUpdate = (id, omx, omy, z) => worldgen.applyUpdate(game.map, id, omx, omy, z);
    labHooks.omtRotation = (omx, omy, z) => oterRotation(worldgen.overmap.omtAt(omx, omy, z), defs);
    labHooks.omtName = (omx, omy, z) => defs[worldgen.overmap.omtAt(omx, omy, z).type]?.name ?? '';
  }

  examineHandlers.set('cardreader', (g, x, y, z, def) => {
    const cr = cardreaderOf(def as never);
    if (!cr) return [];
    return [{ id: 'cardreader', label: `Use the ${def.name}`, run: () => void useCardreader(g, x, y, z, cr, ui()) }];
  });
  examineHandlers.set('elevator', (g, x, y, z, def) => [{
    id: 'elevator',
    label: `Use the ${def.name}`,
    run: () => {
      const floors = elevatorFloors(g, x, y, z);
      const u = ui();
      void u.choose('Select destination floor', floors.map((f) => ({ label: `${f.z} ${f.name}${f.z === z ? ' (this floor)' : ''}`, disabled: f.z === z }))).then((i) => {
        if (i < 0) return;
        const msg = rideElevator(g, x, y, z, floors[i].z);
        if (msg) g.message(msg);
      });
    },
  }]);
  examineHandlers.set('controls_gate', (g, x, y, z, def) => (gateAt(g, x, y, z) ? [{ id: 'gate', label: `Use the ${def.name}`, run: () => void operateGate(g, x, y, z) }] : []));
  examineHandlers.set('chainfence', (g, x, y, z, def) => {
    const p = g.player;
    if (p.tileX === x && p.tileY === y) return [];
    return [{
      id: 'climb',
      label: `Climb over the ${def.name}`,
      run: () => {
        const msg = climbOver(g, x, y, z);
        if (msg) g.message(msg);
      },
    }];
  });
  interactionProviders.push((g, x, y, z): Interaction[] => {
    if (!isConsole(g, x, y, z)) return [];
    const comp = computerAt(g, x, y, z)!;
    return [{ id: 'computer', label: `Use the ${comp.name ?? 'computer'}`, run: () => void useComputer(g, x, y, z, ui()) }];
  });

  if (api && worldgen) installLabDebug(api, game, worldgen);
}

function installLabDebug(api: DebugApi, game: Game, wg: WorldGenerator): void {
  const p = () => game.player;
  const labs = (def = LAB_SPECIAL) => {
    const sp = wg.overmap.findSpecial(def, { x: Math.floor(p().x / CHUNK), y: Math.floor(p().y / CHUNK) }, 4);
    return sp ?? null;
  };
  /** Lab OMTs of the nearest lab special, per z: [{x, y, z, id}] (absolute OMT coords). */
  const cells = (def = LAB_SPECIAL) => {
    const sp = labs(def);
    if (!sp) return [];
    const out: { x: number; y: number; z: number; id: string }[] = [];
    for (let z = 2; z >= -7; z--)
      for (let dy = -6; dy <= 6; dy++)
        for (let dx = -6; dx <= 6; dx++) {
          const o = wg.overmap.omtAt(sp.x + dx, sp.y + dy, z);
          if (o.special?.uid === sp.uid) out.push({ x: sp.x + dx, y: sp.y + dy, z, id: o.id });
        }
    return out;
  };
  api.labs = () => [LAB_SPECIAL, MICROLAB_SPECIAL].map((d) => {
    const sp = labs(d);
    return sp ? { special: d, omx: sp.x, omy: sp.y, dist: Math.round(Math.hypot(sp.x * CHUNK - p().x, sp.y * CHUNK - p().y) / CHUNK) } : { special: d, missing: true };
  });
  /** ASCII overmap of the nearest lab: one block per z-level, OMT ids abbreviated. */
  api.labMap = (special = LAB_SPECIAL) => {
    const list = cells(special);
    const byZ = new Map<number, typeof list>();
    for (const e of list) (byZ.get(e.z) ?? byZ.set(e.z, []).get(e.z)!).push(e);
    const lines: string[] = [];
    for (const [z, l] of byZ) {
      lines.push(`z ${z}:`);
      const xs = l.map((e) => e.x), ys = l.map((e) => e.y);
      for (let y = Math.min(...ys); y <= Math.max(...ys); y++) {
        let row = '  ';
        for (let x = Math.min(...xs); x <= Math.max(...xs); x++) row += (l.find((e) => e.x === x && e.y === y)?.id ?? '.').slice(0, 22).padEnd(23);
        lines.push(row);
      }
    }
    return lines.join('\n');
  };
  /**
   * Teleport into the nearest lab at z `level` (0 = surface buildings, -1..-6 below), onto a
   * walkable indoor tile next to the level's stairs (or elevator controls). Returns the
   * position or null. `special` picks the microlab: cdda.teleportLab(-2, '4x4_microlab_surface').
   */
  api.teleportLab = (level = -2, special = LAB_SPECIAL) => {
    const list = cells(special).filter((e) => e.z === level);
    if (!list.length) return null;
    let best: [number, number] | null = null, bd = Infinity;
    const sp = labs(special)!;
    for (const e of list) {
      game.map.chunk(e.x, e.y, e.z);
      for (let ly = 1; ly < CHUNK - 1; ly++)
        for (let lx = 1; lx < CHUNK - 1; lx++) {
          const x = e.x * CHUNK + lx, y = e.y * CHUNK + ly;
          const t = game.map.terAt(x, y, level);
          const stairs = hasFlag(t, 'GOES_UP') || hasFlag(t, 'GOES_DOWN') || t.examine_action === 'elevator';
          if (!stairs) continue;
          // prefer stairs near the lab's centre
          const d = Math.hypot(x - sp.x * CHUNK, y - sp.y * CHUNK);
          if (d < bd) (bd = d), (best = [x, y]);
        }
    }
    if (!best) {
      const e = list[0];
      for (let ly = 0; ly < CHUNK && !best; ly++) for (let lx = 0; lx < CHUNK && !best; lx++) if (game.map.passable(e.x * CHUNK + lx, e.y * CHUNK + ly, level)) best = [e.x * CHUNK + lx, e.y * CHUNK + ly];
    }
    if (!best) return null;
    // step off the stairs onto a free neighbour
    let [x, y] = best;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      const t = game.map.terAt(x + dx, y + dy, level);
      if (game.map.passable(x + dx, y + dy, level) && !hasFlag(t, 'GOES_UP') && !hasFlag(t, 'GOES_DOWN') && game.map.furnAt(x + dx, y + dy, level).id === 'f_null') {
        x += dx;
        y += dy;
        break;
      }
    }
    p().x = x + 0.5;
    p().y = y + 0.5;
    p().z = level;
    return { x, y, z: level };
  };
  /** Use the console under the crosshair / adjacent: picks = root-menu indices to choose in order. */
  api.useComputer = (picks?: number[]) => {
    const pl = p();
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++)
        if (isConsole(game, pl.tileX + dx, pl.tileY + dy, pl.z)) return useComputer(game, pl.tileX + dx, pl.tileY + dy, pl.z, autoUi(game, picks)).then(() => true);
    return false;
  };
  /**
   * Ride the elevator: finds the nearest powered control within 12 tiles, steps into its cab
   * if needed, and goes to floor `toZ` (default: the lowest other floor). Returns the result.
   */
  api.rideElevator = (toZ?: number) => {
    const pl = p();
    let ctl: [number, number] | null = null, bd = Infinity;
    for (let dy = -12; dy <= 12; dy++)
      for (let dx = -12; dx <= 12; dx++)
        if (game.map.terAt(pl.tileX + dx, pl.tileY + dy, pl.z).examine_action === 'elevator' && Math.hypot(dx, dy) < bd) (bd = Math.hypot(dx, dy)), (ctl = [pl.tileX + dx, pl.tileY + dy]);
    if (!ctl) return 'no elevator control';
    const floors = elevatorFloors(game, ctl[0], ctl[1], pl.z);
    const dest = toZ ?? floors.filter((f) => f.z !== pl.z).map((f) => f.z).sort((a, b) => a - b)[0];
    if (dest === undefined) return 'no other floor';
    if (!hasFlag(game.map.terAt(pl.tileX, pl.tileY, pl.z), 'ELEVATOR'))
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++)
          if (hasFlag(game.map.terAt(ctl[0] + dx, ctl[1] + dy, pl.z), 'ELEVATOR') && !hasFlag(game.map.terAt(pl.tileX, pl.tileY, pl.z), 'ELEVATOR')) {
            pl.x = ctl[0] + dx + 0.5;
            pl.y = ctl[1] + dy + 0.5;
          }
    return rideElevator(game, ctl[0], ctl[1], pl.z, dest) ?? { z: pl.z, x: pl.tileX, y: pl.tileY, floors: floors.map((f) => f.z) };
  };
  /** Swipe (or hack) the nearest card reader within 2 tiles. */
  api.swipeCard = () => {
    const pl = p();
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const x = pl.tileX + dx, y = pl.tileY + dy;
        const cr = cardreaderOf(game.map.terAt(x, y, pl.z));
        if (cr) return useCardreader(game, x, y, pl.z, cr, autoUi(game));
      }
    return 'no card reader';
  };
  /**
   * Screenshot helper: teleport into the lab at `level` and stand two tiles from the most
   * interesting loose loot pile (CBMs/mutagen/ID cards score high), facing it.
   */
  api.faceLabLoot = (level = -5, special = LAB_SPECIAL) => {
    if (!api.teleportLab(level, special)) return null;
    const pl = p(), m = game.map;
    let best: { x: number; y: number; sx: number; sy: number } | null = null, bs = -1;
    for (let dy = -40; dy <= 40; dy++)
      for (let dx = -40; dx <= 40; dx++) {
        const x = pl.tileX + dx, y = pl.tileY + dy;
        const items = m.itemsAt(x, y, pl.z) as Item[];
        if (!items.length || hasFlag(m.furnAt(x, y, pl.z), 'CONTAINER')) continue;
        let s = items.length;
        for (const it of items) if (it.def.flags?.includes('CBM') || /mutagen|serum|^id_/.test(it.typeId)) s += 10;
        if (s <= bs) continue;
        for (const [ox, oy] of [[0, 2], [2, 0], [0, -2], [-2, 0]]) {
          if (m.passable(x + ox, y + oy, pl.z) && m.passable(x + ox / 2, y + oy / 2, pl.z) && m.furnAt(x + ox, y + oy, pl.z).id === 'f_null') {
            best = { x, y, sx: x + ox, sy: y + oy };
            bs = s;
            break;
          }
        }
      }
    if (!best) return null;
    pl.x = best.sx + 0.5;
    pl.y = best.sy + 0.5;
    pl.yaw = Math.atan2(best.x - best.sx, -(best.y - best.sy));
    pl.pitch = -0.35;
    return { x: best.x, y: best.y, z: pl.z, items: (m.itemsAt(best.x, best.y, pl.z) as Item[]).map((i) => i.typeId) };
  };
  /** Items of interest (CBMs, mutagens, ID cards) on the current level within `r` tiles. */
  api.labLoot = (r = 48) => {
    const out: Record<string, number> = {};
    const pl = p();
    for (let y = pl.tileY - r; y <= pl.tileY + r; y++)
      for (let x = pl.tileX - r; x <= pl.tileX + r; x++)
        for (const top of game.map.itemsAt(x, y, pl.z) as Item[])
          for (const it of [top, ...(top.allContents?.() ?? [])])
            if (it.def.flags?.includes('CBM') || /mutagen|serum|^id_/.test(it.typeId)) out[it.typeId] = (out[it.typeId] ?? 0) + 1;
    return out;
  };
}
