import type { Game, GameSystem } from '../game/game';
import { CHUNK } from '../world/coords';
import { c, cssColor, openWindow, type UiWindow } from './framework';
import { omtLabel, playerOmt, type UiContext } from './context';

// 'm' overmap (CDDA overmap_ui.cpp): the world at one character per overmap tile (OMT),
// using each overmap_terrain's sym/color, roads drawn with line glyphs, rotatable symbols
// turned like CDDA does. Only OMTs the player has seen are drawn (game.overmapSeen, filled
// by the tracker system below). Arrows/WASD/hjkl scroll, +/- zoom, < > change z-level.

/** "x,y,z" key used in game.overmapSeen. */
export const seenKey = (x: number, y: number, z: number) => `${x},${y},${z}`;

/**
 * Reveal OMTs around the player as they move: 3 OMTs in daylight outdoors, 1 at night or
 * underground/indoors. Cheap: runs ~2x per real second.
 */
export function overmapSeenTracker(): GameSystem {
  let acc = 0;
  return {
    name: 'overmap-seen',
    update(game: Game, realDt: number) {
      acc += realDt;
      if (acc < 0.5) return;
      acc = 0;
      revealAround(game);
    },
  };
}

/** CDDA scenario distance_initial_visibility (default 15 OMTs): you know your home area. */
export const INITIAL_VISIBILITY = 15;

/** Mark OMTs within `radius` (default: daylight sight) of the player as seen on level `z`. */
export function revealAround(game: Game, radius?: number, z = game.player.z): void {
  const p = game.player;
  const ox = Math.floor(p.x / CHUNK), oy = Math.floor(p.y / CHUNK);
  const h = game.clock.hourOfDay;
  const day = h >= 6 && h < 20;
  const r = radius ?? (p.z < 0 ? 0 : day ? 3 : 1);
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    if (dx * dx + dy * dy > r * r + 1) continue;
    game.overmapSeen.add(seenKey(ox + dx, oy + dy, z));
  }
}

/** [symbol, CDDA color, road connection bits (LINE_N|E|S|W) for linear terrain]. */
type Cell = [string, string, number?];

/**
 * Roads as CSS strokes from the cell centre toward each connected side: box-drawing glyphs
 * leave gaps in square cells.
 */
function roadStyle(line: number, color: string): string {
  const col = cssColor(color);
  const g = `linear-gradient(${col},${col})`;
  const parts: string[] = [];
  if (line & 1) parts.push(`${g} center top / 2px 50% no-repeat`);
  if (line & 2) parts.push(`${g} right center / 50% 2px no-repeat`);
  if (line & 4) parts.push(`${g} center bottom / 2px 50% no-repeat`);
  if (line & 8) parts.push(`${g} left center / 50% 2px no-repeat`);
  return parts.length ? `background:${parts.join(',')}` : '';
}
const NATURAL = /^(field|forest|forest_thick|forest_water|river|lake|open_air|solid_earth|empty_rock|road)/;

export function openOvermap(ctx: UiContext): UiWindow | null {
  const wg = ctx.worldgen;
  if (!wg) {
    ctx.game.message('There is no overmap in this test world.', 'c_light_gray');
    return null;
  }
  const game = ctx.game;
  revealAround(game);
  const rot = new Map<string, string[]>();
  for (const v of Object.values((game.data.misc?.rotatable_symbol ?? {}) as Record<string, { tuple: string[] }>))
    for (const ch of v.tuple) rot.set(ch, v.tuple);
  const start = playerOmt(ctx);
  let cx = start.x, cy = start.y, cz = start.z;
  let zoom = 1;
  const terrains = wg.wg.overmap.terrains;

  const glyphAt = (x: number, y: number, z: number): Cell | null => {
    if (!game.overmapSeen.has(seenKey(x, y, z))) return null;
    const o = wg.overmap.omtAt(x, y, z);
    const def = terrains[o.type];
    const color = def?.color ?? 'light_gray';
    if (o.line >= 0) return [o.line === 0 ? '·' : '', color, o.line];
    let sym = def?.sym?.[0] ?? '?';
    const t = rot.get(sym);
    if (t && o.rot) sym = t[(t.indexOf(sym) + o.rot) % t.length];
    return [sym, color];
  };

  /** Representative OMT of a zoomed-out block: prefer buildings, then roads, then land. */
  const blockGlyph = (bx: number, by: number, z: number): Cell | null => {
    if (zoom === 1) return glyphAt(bx, by, z);
    let best: Cell | null = null, bestScore = -1;
    for (let dy = 0; dy < zoom; dy++) for (let dx = 0; dx < zoom; dx++) {
      const x = bx + dx, y = by + dy;
      const g = glyphAt(x, y, z);
      if (!g) continue;
      const type = wg.overmap.omtAt(x, y, z).type;
      const score = !NATURAL.test(type) ? 3 : type === 'road' ? 2 : 1;
      if (score > bestScore) (best = g), (bestScore = score);
    }
    return best;
  };

  const w = openWindow({
    title: 'Overmap',
    width: '96vw',
    height: '92vh',
    footer: `${c('c_light_green', `arrows/${ctx.game.keys.movementKeys()}/hjkl`)} scroll  ${c('c_light_green', '+ -')} zoom  ${c('c_light_green', '< >')} level  ${c('c_light_green', '.')} center on you`,
    onKey: (e) => {
      const k = e.key;
      // WASD by physical key (ZQSD on AZERTY), like walking; hjkl by letter, like CDDA.
      const code = e.code;
      const step = zoom * (e.shiftKey ? 8 : 1);
      if (k === 'ArrowUp' || code === 'KeyW' || k === 'k') cy -= step;
      else if (k === 'ArrowDown' || code === 'KeyS' || k === 'j') cy += step;
      else if (k === 'ArrowLeft' || code === 'KeyA' || k === 'h') cx -= step;
      else if (k === 'ArrowRight' || code === 'KeyD' || k === 'l') cx += step;
      else if (k === 'K') cy -= step * 8;
      else if (k === 'J') cy += step * 8;
      else if (k === 'H') cx -= step * 8;
      else if (k === 'L') cx += step * 8;
      else if (k === '+' || k === '=') zoom = Math.max(1, zoom / 2);
      else if (k === '-' || k === '_') zoom = Math.min(8, zoom * 2);
      else if (k === '<') cz = Math.min(5, cz + 1);
      else if (k === '>') cz = Math.max(-3, cz - 1);
      else if (k === '.' || k === 'Enter') ({ x: cx, y: cy, z: cz } = playerOmt(ctx));
      else return false; // the opening key (m), Esc, Bksp close via the framework
      render();
      return true;
    },
  });
  w.body.style.whiteSpace = 'pre';
  w.body.style.overflow = 'hidden';
  w.body.innerHTML = `<div style="display:flex;height:100%;gap:1ch"><div class="om-map" style="flex:1;overflow:hidden;line-height:1;position:relative"></div><div class="om-side" style="width:30ch;white-space:pre-wrap"></div></div>`;
  const mapEl = w.body.querySelector('.om-map') as HTMLElement;
  const sideEl = w.body.querySelector('.om-side') as HTMLElement;

  // Square cells (unlike curses' tall ones) so distances on the map look right; measure one
  // so the grid fills the window at any resolution.
  const probe = document.createElement('span');
  probe.className = 'om-cell';
  probe.textContent = 'M';
  mapEl.appendChild(probe);
  const cellW = probe.getBoundingClientRect().width || 16;
  const cellH = probe.getBoundingClientRect().height || 16;
  probe.remove();

  const refugee = refugeeCenterOmt(wg, playerOmt(ctx));

  function render(): void {
    const cols = Math.max(20, Math.floor(mapEl.clientWidth / cellW));
    const rows = Math.max(10, Math.floor(mapEl.clientHeight / cellH));
    // Align blocks to multiples of zoom so zooming doesn't jitter.
    const ox = Math.floor((cx - Math.floor(cols / 2) * zoom) / zoom) * zoom;
    const oy = Math.floor((cy - Math.floor(rows / 2) * zoom) / zoom) * zoom;
    const pl = playerOmt(ctx);
    const grid: Cell[][] = [];
    for (let r = 0; r < rows; r++) {
      const row: Cell[] = [];
      for (let col = 0; col < cols; col++) {
        const x = ox + col * zoom, y = oy + r * zoom;
        const g = blockGlyph(x, y, cz);
        row.push(g ?? [' ', 'dark_gray']);
      }
      grid.push(row);
    }
    // City names over their centres (only if the centre is known), CDDA-style; drawn as
    // overlay labels because the grid cells are square.
    let labels = '';
    for (const city of wg!.overmap.citiesNear(cx, cy, 1)) {
      if (cz !== 0 || !game.overmapSeen.has(seenKey(city.x, city.y, 0))) continue;
      const r = Math.floor((city.y - oy) / zoom), col = Math.floor((city.x - ox) / zoom);
      if (r < 0 || r >= rows || col < 0 || col >= cols) continue;
      labels += `<div class="pre" style="position:absolute;left:${(col + 0.5) * cellW}px;top:${r * cellH}px;transform:translateX(-50%);color:var(--c-white);background:#000;padding:0 .2em">${city.name.replace(/</g, '&lt;')}</div>`;
    }
    // The refugee center is marked from the start (src/npcs.ts); name it so the evacuee
    // knows what the walled compound is.
    if (refugee && cz === 0 && game.overmapSeen.has(seenKey(refugee.x, refugee.y, 0))) {
      const r = Math.floor((refugee.y - oy) / zoom), col = Math.floor((refugee.x - ox) / zoom);
      if (r >= 0 && r < rows && col >= 0 && col < cols)
        labels += `<div class="pre" style="position:absolute;left:${(col + 0.5) * cellW}px;top:${r * cellH}px;transform:translateX(-50%);color:var(--c-light_cyan);background:#000;padding:0 .2em">Refugee Center</div>`;
    }
    const pr = Math.floor((pl.y - oy) / zoom), pc = Math.floor((pl.x - ox) / zoom);
    const cr = Math.floor((cy - oy) / zoom), cc = Math.floor((cx - ox) / zoom);
    let html = '';
    for (let r = 0; r < rows; r++) {
      let line = '';
      for (let col = 0; col < cols; col++) {
        let [ch, color, road] = grid[r][col];
        let style = `color:${cssColor(color)}`;
        if (road) style += ';' + roadStyle(road, color);
        if (r === pr && col === pc && pl.z === cz) (ch = '@'), (style = 'color:var(--c-white);background:var(--c-red)');
        if (r === cr && col === cc) style += ';outline:1px solid var(--c-yellow)';
        const esc = ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '&' ? '&amp;' : ch;
        line += `<span class="om-cell" style="${style}">${esc}</span>`;
      }
      html += `<div class="om-row">${line}</div>`;
    }
    mapEl.innerHTML = html + labels;
    const here = game.overmapSeen.has(seenKey(cx, cy, cz)) ? omtLabel(ctx, cx, cy, cz) : null;
    const city = wg!.overmap.closestCity(cx, cy);
    sideEl.innerHTML = [
      c('c_light_gray', 'Location:'),
      here ? `${c(here.color, here.sym)} ${c('c_white', here.name)}` : c('c_dark_gray', 'unexplored'),
      here?.city ? c('c_light_gray', here.city) : '',
      '',
      `${c('c_light_gray', 'Coords:')} ${cx}, ${cy}, z${cz}`,
      `${c('c_light_gray', 'Zoom:')} ${zoom === 1 ? '1:1' : `1:${zoom}`}`,
      city ? `${c('c_light_gray', 'Nearest town:')} ${c('c_white', city.name)} (${Math.round(Math.hypot(city.x - cx, city.y - cy))} OMT)` : '',
      '',
      `${c('c_white', '@')} ${c('c_light_gray', 'you are here')}`,
      `${c('c_light_green', '^')} ${c('c_light_gray', 'house (door facing)')}`,
      `${c('c_dark_gray', '│─┼')} ${c('c_light_gray', 'road')}`,
      `${c('c_green', 'F')} ${c('c_light_gray', 'forest')}   ${c('c_brown', '.')} ${c('c_light_gray', 'field')}`,
      `${c('c_blue', 'R')} ${c('c_light_gray', 'river')}`,
    ].join('\n');
  }
  // Layout needs a frame before clientWidth is known.
  requestAnimationFrame(render);
  render();
  return w;
}

/** Centre OMT of the evac_center special (the refugee center), or null if none is near. */
function refugeeCenterOmt(wg: NonNullable<UiContext['worldgen']>, from: { x: number; y: number }): { x: number; y: number } | null {
  const sp = wg.overmap.findSpecial('evac_center', from, 3);
  if (!sp) return null;
  let n = 0, sx = 0, sy = 0;
  for (let dy = -18; dy <= 18; dy++)
    for (let dx = -18; dx <= 18; dx++) {
      if (!/^(refctr|evac_center)/.test(wg.overmap.omtAt(sp.x + dx, sp.y + dy, 0).id)) continue;
      (n++, (sx += sp.x + dx), (sy += sp.y + dy));
    }
  return n ? { x: Math.round(sx / n), y: Math.round(sy / n) } : null;
}
