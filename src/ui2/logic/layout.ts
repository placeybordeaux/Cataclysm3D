// Layout math for ui2 (pure, unit-tested): keeping windows on screen, placing popups next to
// the thing that opened them, default window arrangements and the paper-doll grid.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Size {
  w: number;
  h: number;
}

/**
 * Keep a window reachable: its title bar must stay on screen (you can always grab it again),
 * and as much of the body as fits. A window larger than the viewport pins to the top-left.
 */
export function clampRect(r: Rect, view: Size, margin = 0): Rect {
  const w = Math.min(r.w, view.w - margin * 2);
  const h = Math.min(r.h, view.h - margin * 2);
  const x = Math.round(Math.max(margin, Math.min(r.x, view.w - margin - w)));
  const y = Math.round(Math.max(margin, Math.min(r.y, view.h - margin - h)));
  return { x, y, w: r.w, h: r.h };
}

/**
 * Where a popup of `size` goes when opened at `anchor` (a point: w = h = 0, or a rect such as
 * a menu row for a submenu). Prefers right-of/below; flips to the other side when it would
 * leave the viewport; finally clamps. Context menus, submenus and tooltips all use this.
 *   side 'right': submenu next to its row (flips left), aligned with the row's top.
 *   side 'below': context menu / tooltip under the point (flips above), left-aligned.
 */
export function placePopup(anchor: Rect, size: Size, view: Size, side: 'right' | 'below' = 'below', gap = 0): { x: number; y: number } {
  let x: number, y: number;
  if (side === 'right') {
    x = anchor.x + anchor.w + gap;
    if (x + size.w > view.w) x = anchor.x - size.w - gap;
    y = anchor.y;
    if (y + size.h > view.h) y = anchor.y + anchor.h - size.h;
  } else {
    x = anchor.x;
    if (x + size.w > view.w) x = anchor.x + anchor.w - size.w;
    y = anchor.y + anchor.h + gap;
    if (y + size.h > view.h) y = anchor.y - size.h - gap;
  }
  x = Math.max(0, Math.min(x, view.w - size.w));
  y = Math.max(0, Math.min(y, view.h - size.h));
  return { x: Math.round(x), y: Math.round(y) };
}

/**
 * Default positions for a screen made of several windows (inventory: equipment, backpack,
 * pockets, ground): left to right in the order given, vertically centred, wrapping to a new
 * row when a column would run off the right edge. Returns one position per size.
 */
export function arrangeRow(sizes: Size[], view: Size, gap: number, margin: number): { x: number; y: number }[] {
  const rows: { items: number[]; w: number; h: number }[] = [{ items: [], w: 0, h: 0 }];
  sizes.forEach((s, i) => {
    let row = rows[rows.length - 1];
    const need = (row.items.length ? gap : 0) + s.w;
    if (row.items.length && row.w + need > view.w - margin * 2) {
      row = { items: [], w: 0, h: 0 };
      rows.push(row);
    }
    row.w += (row.items.length ? gap : 0) + s.w;
    row.h = Math.max(row.h, s.h);
    row.items.push(i);
  });
  const totalH = rows.reduce((a, r) => a + r.h, 0) + gap * (rows.length - 1);
  let y = Math.max(margin, Math.round((view.h - totalH) / 2));
  const out: { x: number; y: number }[] = new Array(sizes.length);
  for (const row of rows) {
    let x = Math.max(margin, Math.round((view.w - row.w) / 2));
    for (const i of row.items) {
      out[i] = { x, y };
      x += sizes[i].w + gap;
    }
    y += row.h + gap;
  }
  return out;
}

/** Next position for a window opened on top of others: step down-right, wrap before the edge. */
export function cascade(index: number, step: number, origin: { x: number; y: number }, view: Size, size: Size): { x: number; y: number } {
  const maxSteps = Math.max(1, Math.floor(Math.min(view.w - origin.x - size.w, view.h - origin.y - size.h) / step));
  const k = index % maxSteps;
  return { x: origin.x + k * step, y: origin.y + k * step };
}

/** Columns for an item grid of `count` cells in `width` px (at least 1). */
export function gridColumns(width: number, cell: number, gap: number): number {
  return Math.max(1, Math.floor((width + gap) / (cell + gap)));
}

/** A paper-doll slot on a coarse grid around the figure: col/row in cell units (fractions ok). */
export interface DollSlotPos {
  id: string;
  col: number;
  row: number;
}

/** Pixel positions of doll slots, and the doll's overall size, for a cell size and gap. */
export function paperDollLayout(slots: DollSlotPos[], cell: number, gap: number): { size: Size; pos: Record<string, { x: number; y: number }> } {
  const pos: Record<string, { x: number; y: number }> = {};
  let w = 0, h = 0;
  for (const s of slots) {
    const x = Math.round(s.col * (cell + gap));
    const y = Math.round(s.row * (cell + gap));
    if (pos[s.id]) throw new Error(`paperDollLayout: duplicate slot id ${s.id}`);
    pos[s.id] = { x, y };
    w = Math.max(w, x + cell);
    h = Math.max(h, y + cell);
  }
  return { size: { w, h }, pos };
}
