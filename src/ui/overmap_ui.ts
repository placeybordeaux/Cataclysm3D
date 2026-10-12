import type { Game, GameSystem } from '../game/game';
import { CHUNK } from '../world/coords';
import { cddaColor } from '../render/colors';
import type { AtlasHit, FrameRef, Atlas } from '../render/atlas';
import { button, h, openContextMenu, textPrompt, attachTooltip, type MenuItem, type Panel } from '../ui2';
import { atlasOf, omtLabel, playerOmt, type UiContext } from './context';
import { openScreen } from './screen2';
import { mapMarks, noteAt, removeNote, setNote, type MapNote } from './mapmarks';
import { mapMarkers } from '../game/mapmarkers';
import { registerOption } from './options';
import { currentRoute } from './route';

// 'm' map (CDDA overmap_ui.cpp, rebuilt for the mouse): the world at one UltiCa overmap sprite
// per overmap tile (OMT) when zoomed in, one pixel of the sprite's average colour when zoomed
// out, so it keeps the tileset's pixel-art look at every zoom. Only OMTs the survivor has
// seen are drawn (game.overmapSeen, filled by the tracker below); the rest is fog.
//
// Mouse: drag to pan, wheel to zoom (around the cursor), hover for the place's name,
// right-click to add/edit a note or set the destination the HUD compass points to.
// Keys: arrows / WASD / hjkl pan (Shift: faster), + - zoom, < > level, . centre on you, m close.

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

/**
 * Road atlas (docs/ADAPTATION.md): a survivor who lived here knows the county's towns and the
 * roads between them, even without having walked them; CDDA's fog hides everything past 15
 * OMTs, so a newcomer had no idea another town existed (playtest: "drive to another town").
 * Options > Map: Road atlas (default) or Explored only (CDDA).
 */
export const ATLAS_RADIUS = 60;
const ATLAS_KEY = 'cdda3d.mapAtlas';
export function mapAtlasOn(): boolean {
  try {
    return localStorage.getItem(ATLAS_KEY) !== 'off';
  } catch {
    return true;
  }
}
let atlasOption = false;
export function registerMapAtlasOption(): void {
  if (atlasOption) return;
  atlasOption = true;
  registerOption({
    category: 'Interface',
    name: 'Map',
    value: () => (mapAtlasOn() ? 'Road atlas' : 'Explored only (CDDA)'),
    change: () => {
      try {
        localStorage.setItem(ATLAS_KEY, mapAtlasOn() ? 'off' : 'on');
      } catch {
        // not persisted
      }
    },
    desc: 'Road atlas: the map shows the names of nearby towns and the roads to them, like a road map you know by heart; buildings stay hidden until you see them. Explored only: only what you have seen, like Cataclysm.',
  });
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

/** CSS px per OMT at each zoom step. Sprites are drawn from 16 up; below that, colour pixels. */
const ZOOMS = [3, 6, 12, 16, 24, 32, 48, 64];
let lastZoom = 5;

const NOTE_KINDS: { kind: MapNote['kind']; label: string; color: string }[] = [
  { kind: 'note', label: 'Note', color: '#e0b050' },
  { kind: 'loot', label: 'Loot', color: '#7ea180' },
  { kind: 'danger', label: 'Danger', color: '#d04030' },
  { kind: 'home', label: 'Home / base', color: '#70a8e0' },
];

export function openOvermap(ctx: UiContext): Panel | null {
  const maybeWg = ctx.worldgen;
  if (!maybeWg) {
    ctx.game.message('There is no overmap in this test world.', 'c_light_gray');
    return null;
  }
  const wg = maybeWg;
  const game = ctx.game;
  revealAround(game);
  const start = playerOmt(ctx);
  // View centre in fractional OMT coordinates.
  let cx = start.x + 0.5, cy = start.y + 0.5, cz = start.z;
  let zi = lastZoom;
  const terrains = wg.wg.overmap.terrains;
  const atlas = atlasOf(ctx.renderer);

  const view = h('div', { class: 'om-view', attrs: { 'data-testid': 'map-view' } });
  const canvas = h('canvas');
  const labels = h('div', { class: 'om-labels' });
  view.append(canvas, labels);
  const hoverEl = h('div', { class: 'om-hover', attrs: { 'data-testid': 'map-hover' } });
  const levelEl = h('span', { class: 'ui2-small' });
  const notesEl = h('div', { class: 'om-notes' });
  // The letters on screen (places the tileset has no picture for: M, +, F, n…) and what they
  // are. Playtest: half the town was unexplained letters; only hovering told you.
  const glyphLegend = h('div', { class: 'om-legend' });
  let glyphKey = '';
  const side = h('div', { class: 'om-side' },
    h('div', { class: 'ui2-section', text: 'Here' }), hoverEl,
    h('div', { class: 'om-controls' },
      button('+', () => zoomBy(1), { small: true, title: 'Zoom in (+ or wheel)' }),
      button('−', () => zoomBy(-1), { small: true, title: 'Zoom out (- or wheel)' }),
      button('Centre', () => centre(), { small: true, title: 'Centre on you (.)' }),
      button('▲', () => level(1), { small: true, title: 'Level up (<)' }),
      button('▼', () => level(-1), { small: true, title: 'Level down (>)' }),
      levelEl,
    ),
    h('div', { class: 'ui2-section', text: 'Legend' }), legend(), glyphLegend,
    h('div', { class: 'ui2-section', text: 'Your notes' }), notesEl,
  );
  const panel = openScreen(game, {
    id: 'scr.map',
    title: 'Map',
    group: 'scr.map',
    action: 'map',
    pauses: true,
    width: '96vw',
    height: '92vh',
    legend: [['drag', 'pan'], ['wheel', 'zoom'], ['right-click', 'note / destination'], ['< >', 'level'], ['.', 'you']],
    onKey: (e) => {
      const k = e.key, code = e.code;
      const step = (e.shiftKey ? 8 : 2) * (16 / ZOOMS[zi]);
      if (k === 'ArrowUp' || code === 'KeyW' || k === 'k') cy -= step;
      else if (k === 'ArrowDown' || code === 'KeyS' || k === 'j') cy += step;
      else if (k === 'ArrowLeft' || code === 'KeyA' || k === 'h') cx -= step;
      else if (k === 'ArrowRight' || code === 'KeyD' || k === 'l') cx += step;
      else if (k === '+' || k === '=') return zoomBy(1), true;
      else if (k === '-' || k === '_') return zoomBy(-1), true;
      else if (k === '<') return level(1), true;
      else if (k === '>') return level(-1), true;
      else if (k === '.') return centre(), true;
      else return false;
      draw();
      return true;
    },
    onClose: () => {
      ro.disconnect();
      lastZoom = zi;
    },
  });
  panel.body.append(h('div', { class: 'om-wrap' }, view, side));
  panel.body.style.overflow = 'hidden';

  // ---------------------------------------------------------------- data per OMT
  const avgCache = new Map<string, string>();
  const hitCache = new Map<string, AtlasHit | null>();
  const sample = document.createElement('canvas');
  sample.width = sample.height = 1;
  const sctx = sample.getContext('2d', { willReadFrequently: true })!;

  /** Atlas sprite for an OMT (rotated buildings, connected roads/rivers), or null. */
  const spriteFor = (x: number, y: number, z: number): AtlasHit | null => {
    const o = wg.overmap.omtAt(x, y, z);
    const key = `${o.type}|${o.rot}|${o.line}`;
    if (hitCache.has(key)) return hitCache.get(key)!;
    let hit: AtlasHit | null = null;
    if (atlas) {
      hit = o.line >= 0 ? atlas.lookup(o.type, { connections: o.line }) : atlas.lookup(o.type, { rotation: o.rot });
      if (!hit && o.id !== o.type) hit = atlas.lookup(o.id);
      if (!hit) {
        const def = terrains[o.type];
        const sym = def?.sym?.[0];
        if (sym) hit = { id: o.type, fg: atlas.glyph(sym, def?.color ?? 'light_gray') };
      }
    }
    hitCache.set(key, hit);
    return hit;
  };
  /** One colour per OMT for the zoomed-out view: the sprite's average, else the CDDA colour. */
  const colourFor = (x: number, y: number, z: number): string => {
    const o = wg.overmap.omtAt(x, y, z);
    const key = `${o.type}|${o.rot}|${o.line}`;
    let c = avgCache.get(key);
    if (c) return c;
    const hit = spriteFor(x, y, z);
    if (hit && hit.fg && hit.fg.frame >= 0) {
      sctx.clearRect(0, 0, 1, 1);
      sctx.imageSmoothingEnabled = true;
      for (const r of [hit.bg, hit.fg]) if (r) sctx.drawImage(r.image, r.px.x, r.px.y, r.px.w, r.px.h, 0, 0, 1, 1);
      const d = sctx.getImageData(0, 0, 1, 1).data;
      c = `rgb(${d[0]},${d[1]},${d[2]})`;
    } else {
      const n = cddaColor(terrains[o.type]?.color ?? 'light_gray');
      c = `rgb(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255})`;
    }
    avgCache.set(key, c);
    return c;
  };

  let ground = '';
  const groundColour = () => {
    if (ground) return ground;
    const hit = atlas?.lookup('field');
    if (!hit?.fg) return (ground = '#3d4a2a');
    sctx.clearRect(0, 0, 1, 1);
    sctx.drawImage(hit.fg.image, hit.fg.px.x, hit.fg.px.y, hit.fg.px.w, hit.fg.px.h, 0, 0, 1, 1);
    const d = sctx.getImageData(0, 0, 1, 1).data;
    return (ground = `rgb(${d[0]},${d[1]},${d[2]})`);
  };
  const refugee = refugeeCenterOmt(wg, start);
  const seen = (x: number, y: number, z: number) => game.overmapSeen.has(seenKey(x, y, z));
  // Road atlas: town names and roads within ATLAS_RADIUS OMTs of you, fog or not.
  const atlasOn = mapAtlasOn();
  /** With the road atlas: the town an unexplored OMT belongs to ("Dana"), else null. */
  const atlasTown = (x: number, y: number, z: number): string | null => {
    if (!atlasOn || z !== 0 || !inAtlas(x, y)) return null;
    const c = wg.overmap.citiesNear(x, y, 1).find((k) => Math.max(Math.abs(k.x - x), Math.abs(k.y - y)) <= k.size + 1);
    return c?.name ?? null;
  };
  const inAtlas = (x: number, y: number) => {
    const p = game.player;
    return Math.max(Math.abs(x - Math.floor(p.x / CHUNK)), Math.abs(y - Math.floor(p.y / CHUNK))) <= ATLAS_RADIUS;
  };

  // ---------------------------------------------------------------- drawing
  let W = 0, H = 0, dpr = 1;
  let pending = false;
  function draw(): void {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      render();
    });
  }

  function render(): void {
    dpr = window.devicePixelRatio || 1;
    W = view.clientWidth;
    H = view.clientHeight;
    if (!W || !H) return;
    const cw = Math.round(W * dpr), ch = Math.round(H * dpr);
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
      canvas.style.width = `${cw / dpr}px`;
      canvas.style.height = `${ch / dpr}px`;
    }
    const g = canvas.getContext('2d')!;
    g.imageSmoothingEnabled = false;
    g.fillStyle = '#050608';
    g.fillRect(0, 0, cw, ch);
    // Whole device pixels per OMT so every sprite pixel is the same size.
    const cell = Math.max(1, Math.round(ZOOMS[zi] * dpr));
    const cols = Math.ceil(cw / cell) + 2, rows = Math.ceil(ch / cell) + 2;
    const x0 = Math.floor(cx - cw / cell / 2), y0 = Math.floor(cy - ch / cell / 2);
    const offX = Math.round((x0 - (cx - cw / cell / 2)) * cell), offY = Math.round((y0 - (cy - ch / cell / 2)) * cell);
    const sprites = ZOOMS[zi] >= 16 && !!atlas;
    const glyphs = new Map<string, { sym: string; rgb: string; names: Set<string> }>();
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const x = x0 + c, y = y0 + r;
        const px = offX + c * cell, py = offY + r * cell;
        if (!seen(x, y, cz)) {
          // Fog of discovery: a faint dither so the edge of the known world reads as an edge.
          if (cell >= 6 && ((x + y) & 1) === 0) {
            g.fillStyle = '#0b0c10';
            g.fillRect(px, py, cell, cell);
          }
          // Road atlas (docs/ADAPTATION.md): the roads you'd know from a road map, faint.
          if (atlasOn && cz === 0 && inAtlas(x, y) && /^(road|bridge)/.test(wg.overmap.omtAt(x, y, 0).type)) {
            g.fillStyle = '#3a3d44';
            const m = cell < 6 ? 0 : Math.max(1, Math.round(cell * 0.3));
            g.fillRect(px + m, py + m, cell - 2 * m, cell - 2 * m);
          }
          continue;
        }
        if (sprites) {
          const hit = spriteFor(x, y, cz);
          if (hit && hit.fg?.frame === -1) {
            // No sprite in the tileset: CDDA's glyph over plain ground, a bit smaller, so it
            // reads as a map symbol instead of a black hole.
            g.fillStyle = groundColour();
            g.fillRect(px, py, cell, cell);
            const o = wg.overmap.omtAt(x, y, cz);
            const def = terrains[o.type];
            const n = cddaColor(def?.color ?? 'light_gray');
            g.fillStyle = `rgb(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255})`;
            const sym = def?.sym?.[0] ?? '?';
            if (px >= 0 && py >= 0 && px < cw && py < ch) {
              const k = `${sym}|${g.fillStyle}`;
              const e = glyphs.get(k) ?? { sym, rgb: g.fillStyle as string, names: new Set<string>() };
              e.names.add(def?.name ?? o.type);
              glyphs.set(k, e);
            }
            g.font = `${Math.round(cell * 0.8)}px Terminus, monospace`;
            g.textAlign = 'center';
            g.textBaseline = 'middle';
            g.fillText(def?.sym?.[0] ?? '?', px + cell / 2, py + cell / 2 + cell * 0.04);
          } else if (hit) drawHit(g, atlas!, hit, px, py, cell);
          else {
            g.fillStyle = colourFor(x, y, cz);
            g.fillRect(px, py, cell, cell);
          }
        } else {
          g.fillStyle = colourFor(x, y, cz);
          g.fillRect(px, py, cell, cell);
        }
      }
    const gk = [...glyphs.entries()].map(([k, e]) => `${k}:${[...e.names].join(',')}`).sort().join('|');
    if (gk !== glyphKey) {
      glyphKey = gk;
      // One row per name (fences come in five glyphs); scenery that reads fine is left out.
      const shown = new Set<string>(['fence', 'field', 'open air']);
      const rows = [...glyphs.values()].filter((e) => {
        const fresh = [...e.names].filter((n) => !shown.has(n));
        fresh.forEach((n) => shown.add(n));
        e.names = new Set(fresh);
        return fresh.length > 0;
      });
      glyphLegend.replaceChildren(...rows.slice(0, 14).flatMap((e) => {
        const names = [...e.names];
        return [h('span', { class: 'om-swatch', html: `<span style="color:${e.rgb}">${e.sym.replace(/[<&>]/g, (c) => `&#${c.charCodeAt(0)};`)}</span>` }), h('span', { text: names.slice(0, 2).join(', ') + (names.length > 2 ? ', …' : '') })];
      }));
    }
    const toScreen = (x: number, y: number) => ({ sx: (offX + (x - x0) * cell) / dpr, sy: (offY + (y - y0) * cell) / dpr });
    const cellCss = cell / dpr;

    // Hover outline.
    if (hover && hover.z === cz) {
      const { sx, sy } = toScreen(hover.x, hover.y);
      g.strokeStyle = '#e0b050';
      g.lineWidth = Math.max(1, Math.round(dpr));
      g.strokeRect(sx * dpr + 0.5, sy * dpr + 0.5, cell - 1, cell - 1);
    }
    // Player: an arrow in the facing direction.
    const pl = playerOmt(ctx);
    if (pl.z === cz) {
      const p = game.player;
      const fx = p.x / CHUNK, fy = p.y / CHUNK;
      const sx = (offX + (fx - x0) * cell), sy = (offY + (fy - y0) * cell);
      const s = Math.max(6 * dpr, cell * 0.45);
      g.save();
      g.translate(sx, sy);
      g.rotate(p.yaw);
      g.beginPath();
      g.moveTo(0, -s);
      g.lineTo(s * 0.7, s * 0.7);
      g.lineTo(0, s * 0.3);
      g.lineTo(-s * 0.7, s * 0.7);
      g.closePath();
      g.fillStyle = '#ffffff';
      g.strokeStyle = '#000';
      g.lineWidth = Math.max(1, dpr * 1.5);
      g.fill();
      g.stroke();
      g.restore();
    }

    // Labels: cities, the refugee centre, labs you've found, your notes and destination.
    const L: HTMLElement[] = [];
    const inView = (sx: number, sy: number) => sx > -200 && sy > -40 && sx < W + 200 && sy < H + 40;
    const label = (x: number, y: number, text: string, cls: string) => {
      const { sx, sy } = toScreen(x + 0.5, y + 0.5);
      if (!inView(sx, sy)) return;
      L.push(h('div', { class: `om-label ${cls}`, text, style: { left: `${sx}px`, top: `${sy}px` } }));
    };
    if (cz === 0 && ZOOMS[zi] >= 3)
      for (const city of wg.overmap.citiesNear(cx, cy, 1)) if (seen(city.x, city.y, 0) || (atlasOn && inAtlas(city.x, city.y))) label(city.x, city.y, city.name, seen(city.x, city.y, 0) ? 'city' : 'city atlas');
    if (refugee && cz === 0 && seen(refugee.x, refugee.y, 0)) label(refugee.x, refugee.y, 'Refugee Center', 'ref');
    if (ZOOMS[zi] >= 6) {
      // Labs: only ones whose entrance you've actually seen.
      const reach = Math.ceil(Math.max(W, H) / cellCss / 2) + 1;
      if (reach < 90)
        for (let y = Math.floor(cy) - reach; y <= cy + reach; y++)
          for (let x = Math.floor(cx) - reach; x <= cx + reach; x++) {
            if (!seen(x, y, cz)) continue;
            const t = wg.overmap.omtAt(x, y, cz).type;
            if (t === 'lab_stairs' || t === 'microlab_generic_surface' || t === 'tower_lab_stairs') label(x, y, 'Lab', 'note');
          }
    }
    const marks = mapMarks(game);
    for (const n of marks.notes) if (n.z === cz) {
      const col = NOTE_KINDS.find((k) => k.kind === n.kind)?.color ?? '#e0b050';
      const { sx, sy } = toScreen(n.x + 0.5, n.y + 0.5);
      g.fillStyle = col;
      g.strokeStyle = '#000';
      const r = Math.max(3 * dpr, cell * 0.22);
      g.beginPath();
      g.moveTo(sx * dpr, sy * dpr - r);
      g.lineTo(sx * dpr + r, sy * dpr);
      g.lineTo(sx * dpr, sy * dpr + r);
      g.lineTo(sx * dpr - r, sy * dpr);
      g.closePath();
      g.fill();
      g.stroke();
      const isDest = marks.destination && marks.destination.x === n.x && marks.destination.y === n.y && marks.destination.z === n.z;
      if (ZOOMS[zi] >= 12 && !isDest) label(n.x, n.y, n.text, 'note');
    }
    // Markers other systems contribute (mission targets…): a magenta ring, the tracked one bold.
    for (const mk of mapMarkers()) {
      if (mk.z !== cz) continue;
      const fx = mk.x !== undefined ? mk.x / CHUNK : mk.omx + 0.5, fy = mk.y !== undefined ? mk.y / CHUNK : mk.omy + 0.5;
      const { sx, sy } = toScreen(fx, fy);
      g.strokeStyle = '#c080e0';
      g.lineWidth = Math.max(1, (mk.tracked ? 3 : 1.5) * dpr);
      g.beginPath();
      g.arc(sx * dpr, sy * dpr, Math.max(5 * dpr, cell * 0.35), 0, Math.PI * 2);
      g.stroke();
      label(fx - 0.5, fy - 1.3, `${mk.tracked ? '★ ' : ''}${mk.label}`, 'mission');
    }
    const d = marks.destination;
    // The walking route to it (src/ui/route.ts): a dashed line from you, roads first.
    const route = d && d.z === cz ? currentRoute(game, wg.overmap) : null;
    if (route && route.omts.length > 1) {
      const p = game.player;
      g.save();
      g.strokeStyle = 'rgba(232, 192, 112, 0.85)';
      g.lineWidth = Math.max(2, 2 * dpr);
      g.setLineDash([4 * dpr, 4 * dpr]);
      g.beginPath();
      const start = toScreen(p.x / CHUNK, p.y / CHUNK);
      g.moveTo(start.sx * dpr, start.sy * dpr);
      for (const o of route.omts.slice(1)) {
        const s = toScreen(o.x + 0.5, o.y + 0.5);
        g.lineTo(s.sx * dpr, s.sy * dpr);
      }
      g.stroke();
      g.restore();
    }
    if (d && d.z === cz) {
      const { sx, sy } = toScreen(d.x + 0.5, d.y + 0.5);
      g.strokeStyle = '#e0b050';
      g.lineWidth = Math.max(2, 2 * dpr);
      g.beginPath();
      g.arc(sx * dpr, sy * dpr, Math.max(6 * dpr, cell * 0.45), 0, Math.PI * 2);
      g.stroke();
      label(d.x, d.y - 0.9, `◆ ${d.label}${route ? ` · ${Math.round(route.metres)} m walk` : ''}`, 'dest');
    }
    labels.replaceChildren(...L);
    // For tests (tools/realinput.ts): where the view is and how far it's zoomed.
    panel.el.dataset.view = `${cx.toFixed(2)},${cy.toFixed(2)},${cz},${ZOOMS[zi]}`;
    levelEl.textContent = cz === 0 ? 'surface' : cz > 0 ? `+${cz}` : `${cz}`;
    renderHover();
    renderNotes();
  }

  // ---------------------------------------------------------------- hover + side panel
  let hover: { x: number; y: number; z: number } | null = null;
  function omtAtPointer(e: { clientX: number; clientY: number }): { x: number; y: number; z: number } {
    const r = view.getBoundingClientRect();
    const cellCss = Math.max(1, Math.round(ZOOMS[zi] * dpr)) / dpr;
    return { x: Math.floor(cx + (e.clientX - r.left - W / 2) / cellCss), y: Math.floor(cy + (e.clientY - r.top - H / 2) / cellCss), z: cz };
  }
  function renderHover(): void {
    const t = hover ?? { ...playerOmt(ctx) };
    const known = seen(t.x, t.y, t.z);
    const lbl = known ? omtLabel(ctx, t.x, t.y, t.z) : null;
    const pl = playerOmt(ctx);
    const dist = Math.round(Math.hypot(t.x - pl.x, t.y - pl.y) * CHUNK);
    const note = noteAt(game, t.x, t.y, t.z);
    hoverEl.replaceChildren(
      h('div', { class: 'tone-accent', text: lbl ? lbl.name.replace(/^./, (c) => c.toUpperCase()) : 'Unexplored' }),
      lbl?.city ? h('div', { text: lbl.city }) : '',
      note ? h('div', { class: 'tone-warn', text: `Note: ${note.text}` }) : '',
      h('div', { class: 'ui2-dim', text: `${dist >= 1000 ? `${(dist / 1000).toFixed(1)} km` : `${dist} m`} from you · ${t.x}, ${t.y}${t.z ? `, z${t.z}` : ''}` }),
    );
  }
  function renderNotes(): void {
    const marks = mapMarks(game);
    const rows: HTMLElement[] = [];
    if (marks.destination) {
      const d = marks.destination;
      const row = h('div', { class: 'om-note', text: `◆ ${d.label} (destination)` });
      row.addEventListener('click', () => ((cx = d.x + 0.5), (cy = d.y + 0.5), (cz = d.z), draw()));
      rows.push(row);
    }
    for (const n of marks.notes) {
      const row = h('div', { class: 'om-note', text: n.text });
      row.style.borderLeftColor = NOTE_KINDS.find((k) => k.kind === n.kind)?.color ?? '';
      row.addEventListener('click', () => ((cx = n.x + 0.5), (cy = n.y + 0.5), (cz = n.z), draw()));
      attachTooltip(row, () => 'Click to show it on the map');
      rows.push(row);
    }
    if (!rows.length) rows.push(h('div', { class: 'ui2-dim', text: 'Right-click the map to write a note or set a destination for the compass.' }));
    notesEl.replaceChildren(...rows);
  }

  function legend(): HTMLElement {
    const el = h('div', { class: 'om-legend' });
    const entry = (id: string, text: string, opts: { rotation?: number; connections?: number } = {}) => {
      const hit = atlas?.lookup(id, opts);
      const icon = hit ? spriteImg(atlas!, hit) : h('span', { class: 'om-swatch' });
      el.append(icon, h('span', { text }));
    };
    const sw = (html: string, text: string) => el.append(h('span', { class: 'om-swatch', html }), h('span', { text }));
    sw('<span style="color:#fff">▲</span>', 'You (facing)');
    sw('<span style="color:#e0b050">◯</span>', 'Destination');
    sw('<span style="color:#e0b050">◆</span>', 'Your note');
    sw('<span style="color:#c080e0">◯</span>', 'Mission target (★ tracked)');
    entry('house_01', 'House');
    entry('road', 'Road', { connections: 5 });
    entry('forest', 'Forest');
    entry('field', 'Field');
    entry('river_center', 'River');
    entry('s_gas', 'Gas station');
    return el;
  }

  // ---------------------------------------------------------------- mouse
  let drag: { x: number; y: number; cx: number; cy: number; moved: boolean } | null = null;
  view.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, cx, cy, moved: false };
    view.setPointerCapture(e.pointerId);
    view.classList.add('panning');
  });
  view.addEventListener('pointermove', (e) => {
    if (drag) {
      const cellCss = Math.max(1, Math.round(ZOOMS[zi] * dpr)) / dpr;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      cx = drag.cx - dx / cellCss;
      cy = drag.cy - dy / cellCss;
      draw();
      return;
    }
    const t = omtAtPointer(e);
    if (!hover || t.x !== hover.x || t.y !== hover.y || t.z !== hover.z) {
      hover = t;
      draw();
    }
  });
  const endDrag = () => {
    drag = null;
    view.classList.remove('panning');
  };
  view.addEventListener('pointerup', endDrag);
  view.addEventListener('pointercancel', endDrag);
  view.addEventListener('pointerleave', () => {
    if (!drag && hover) (hover = null), draw();
  });
  view.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = view.getBoundingClientRect();
    zoomBy(e.deltaY < 0 ? 1 : -1, { x: e.clientX - r.left, y: e.clientY - r.top });
  }, { passive: false });
  view.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const t = omtAtPointer(e);
    openContextMenu({ x: e.clientX, y: e.clientY }, markMenu(t), { title: seen(t.x, t.y, t.z) ? omtLabel(ctx, t.x, t.y, t.z)?.name ?? 'Here' : atlasTown(t.x, t.y, t.z) ? `${atlasTown(t.x, t.y, t.z)} (unexplored)` : 'Unexplored' });
  });

  /** Display names for specials whose id reads badly ("evac_center"). */
  const SPECIAL_NAMES: Record<string, string> = { evac_center: 'Refugee Center', 'Evac Shelter': 'Evac shelter' };
  function markMenu(t: { x: number; y: number; z: number }): MenuItem[] {
    const note = noteAt(game, t.x, t.y, t.z);
    const marks = mapMarks(game);
    const isDest = marks.destination && marks.destination.x === t.x && marks.destination.y === t.y && marks.destination.z === t.z;
    const lbl = seen(t.x, t.y, t.z) ? omtLabel(ctx, t.x, t.y, t.z)?.name : atlasTown(t.x, t.y, t.z);
    const write = async (kind: MapNote['kind']) => {
      const text = await textPrompt({ title: note ? 'Edit note' : `New ${NOTE_KINDS.find((k) => k.kind === kind)!.label.toLowerCase()} note`, initial: note?.text ?? '', placeholder: 'e.g. pharmacy, zombies inside', ok: 'Save' });
      if (text === null) return;
      setNote(game, { x: t.x, y: t.y, z: t.z, text, kind });
      draw();
    };
    const items: MenuItem[] = [
      { label: note ? 'Edit note…' : 'Add note…', key: 'N', primary: true, action: () => void write(note?.kind ?? 'note') },
      { label: 'Note type', submenu: NOTE_KINDS.map((k) => ({ label: k.label, action: () => void write(k.kind) })) },
    ];
    if (note) items.push({ label: 'Remove note', danger: true, action: () => (removeNote(game, t.x, t.y, t.z), draw()) });
    items.push({ separator: true });
    if (isDest) items.push({ label: 'Clear destination', action: () => ((marks.destination = null), draw()) });
    else {
      const label = note?.text ?? (lbl ? lbl.replace(/^./, (c) => c.toUpperCase()) : 'Destination');
      // A big special (refugee center, farm, lab entrance): go to its way in, not this tile.
      const sp = t.z === 0 ? wg.overmap.omtAt(t.x, t.y, 0).special : undefined;
      const gate = sp && !note ? wg.overmap.specialEntrance(sp) : null;
      // Name the place, not the tile clicked ("field" inside the refugee center's fence).
      const place = sp ? (SPECIAL_NAMES[sp.def] ?? sp.def.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())) : label;
      if (gate && (gate.x !== t.x || gate.y !== t.y)) items.push({ label: `Set as destination: ${place} entrance`, key: 'D', action: () => ((marks.destination = { x: gate.x, y: gate.y, z: 0, label: `${place} entrance` }), draw()) });
      else items.push({ label: 'Set as destination', key: 'D', action: () => ((marks.destination = { x: t.x, y: t.y, z: t.z, label }), draw()) });
    }
    return items;
  }

  function zoomBy(d: number, at?: { x: number; y: number }): void {
    const nz = Math.max(0, Math.min(ZOOMS.length - 1, zi + d));
    if (nz === zi) return;
    // Keep the OMT under the cursor still.
    if (at && W) {
      const before = ZOOMS[zi], after = ZOOMS[nz];
      const wx = cx + (at.x - W / 2) / before, wy = cy + (at.y - H / 2) / before;
      cx = wx - (at.x - W / 2) / after;
      cy = wy - (at.y - H / 2) / after;
    }
    zi = nz;
    draw();
  }
  function level(d: number): void {
    cz = Math.max(-7, Math.min(5, cz + d));
    draw();
  }
  function centre(): void {
    const p = playerOmt(ctx);
    (cx = game.player.x / CHUNK), (cy = game.player.y / CHUNK), (cz = p.z);
    draw();
  }

  const ro = new ResizeObserver(() => draw());
  ro.observe(view);
  draw();
  return panel;
}

/** Draw an atlas hit (bg then fg, rotated) into a `size`-pixel cell at (x, y). */
function drawHit(g: CanvasRenderingContext2D, atlas: Atlas, hit: AtlasHit, x: number, y: number, size: number): void {
  const k = size / atlas.tileSize;
  for (const r of [hit.bg, hit.fg]) {
    if (!r) continue;
    drawFrame(g, r, x, y, k);
  }
}
function drawFrame(g: CanvasRenderingContext2D, r: FrameRef, x: number, y: number, k: number): void {
  const w = r.w * k, hgt = r.h * k;
  if (!r.rotate) {
    g.drawImage(r.image, r.px.x, r.px.y, r.px.w, r.px.h, x + r.ox * k, y + r.oy * k, w, hgt);
    return;
  }
  g.save();
  g.translate(x + r.ox * k + w / 2, y + r.oy * k + hgt / 2);
  g.rotate((r.rotate * Math.PI) / 2);
  g.drawImage(r.image, r.px.x, r.px.y, r.px.w, r.px.h, -w / 2, -hgt / 2, w, hgt);
  g.restore();
}

function spriteImg(atlas: Atlas, hit: AtlasHit): HTMLElement {
  const img = h('img', { attrs: { src: atlas.spriteCanvas(hit, 1).toDataURL(), alt: '' } });
  return img;
}

/** Centre OMT of the evac_center special (the refugee center), or null if none is near. */
export function refugeeCenterOmt(wg: NonNullable<UiContext['worldgen']>, from: { x: number; y: number }): { x: number; y: number } | null {
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
