import type { OterDef } from '../worldgen_data';

// Overmap terrain instances. CDDA stores an oter *type* ("house_01", "road") and derives
// concrete ids from it: rotatable types get a direction suffix ("house_01_east"), LINEAR
// types (roads) get a connection suffix ("road_nes") and pick one of five mapgen shapes
// (road_straight/curved/end/tee/four_way) plus a rotation, per overmap.h om_lines::all.

export const DIR_SUFFIX = ['_north', '_east', '_south', '_west'] as const;
export const DIR_NAMES = ['north', 'east', 'south', 'west'] as const;

/** Linear connection bits: north=1, east=2, south=4, west=8 (om_direction order). */
export const LINE_N = 1, LINE_E = 2, LINE_S = 4, LINE_W = 8;
const MAPGEN_SUFFIX = ['_straight', '_curved', '_end', '_tee', '_four_way'];
/** [mapgen index, rotation, suffix] for each 4-bit connection mask (CDDA om_lines::all). */
export const LINES: readonly [number, number, string][] = [
  [4, 0, '_isolated'], [2, 2, '_end_south'], [2, 1, '_end_west'], [1, 1, '_ne'],
  [2, 0, '_end_north'], [0, 0, '_ns'], [1, 0, '_es'], [3, 1, '_nes'],
  [2, 3, '_end_east'], [1, 2, '_wn'], [0, 1, '_ew'], [3, 2, '_new'],
  [1, 3, '_sw'], [3, 3, '_nsw'], [3, 0, '_esw'], [4, 0, '_nesw'],
];

export interface OmtRef {
  /** oter type id (key of OvermapData.terrains) */
  type: string;
  /** 0..3 = north/east/south/west for rotatable types, else 0 */
  rot: number;
  /** connection mask for LINEAR types, -1 otherwise */
  line: number;
}

export const isLinear = (d: OterDef | undefined) => !!d?.flags.includes('LINEAR');
export const isRotatable = (d: OterDef | undefined) => !!d && !d.flags.includes('NO_ROTATE') && !isLinear(d);

export function oterId(r: OmtRef, defs: Record<string, OterDef>): string {
  const d = defs[r.type];
  if (r.line >= 0 && isLinear(d)) return r.type + LINES[r.line][2];
  if (isRotatable(d)) return r.type + DIR_SUFFIX[r.rot & 3];
  return r.type;
}

/** Key used to look up JSON mapgen (CDDA oter_t::get_mapgen_id). */
export function mapgenIdOf(r: OmtRef, defs: Record<string, OterDef>): string {
  const d = defs[r.type];
  if (r.line >= 0 && isLinear(d)) return r.type + MAPGEN_SUFFIX[LINES[r.line][0]];
  return r.type;
}

/** Rotation applied to the generated map (CDDA oter_t::get_rotation). */
export function oterRotation(r: OmtRef, defs: Record<string, OterDef>): number {
  const d = defs[r.type];
  if (r.line >= 0 && isLinear(d)) return LINES[r.line][1];
  return isRotatable(d) ? r.rot & 3 : 0;
}

/** "house_01_east" -> {type: "house_01", rot: 1}. Unknown ids keep the whole string as type. */
export function parseOterId(id: string, defs: Record<string, OterDef>): OmtRef {
  for (let i = 0; i < 4; i++) {
    const s = DIR_SUFFIX[i];
    if (id.endsWith(s)) {
      const t = id.slice(0, -s.length);
      if (defs[t]) return { type: t, rot: isRotatable(defs[t]) ? i : 0, line: -1 };
    }
  }
  for (let l = 0; l < LINES.length; l++) {
    const s = LINES[l][2];
    if (id.endsWith(s)) {
      const t = id.slice(0, -s.length);
      if (isLinear(defs[t])) return { type: t, rot: 0, line: l };
    }
  }
  return { type: id, rot: 0, line: isLinear(defs[id]) ? 15 : -1 };
}

/** CDDA point::rotate(turns) without dimensions: turns=1 maps (x, y) -> (-y, x). */
export function rotateOffset(x: number, y: number, turns: number): [number, number] {
  turns = ((turns % 4) + 4) % 4;
  for (let t = 0; t < turns; t++) [x, y] = [-y, x];
  return [x + 0, y + 0];
}

/** Rotate a linear connection mask clockwise by `turns`. */
export function rotateLine(line: number, turns: number): number {
  turns = ((turns % 4) + 4) % 4;
  return ((line << turns) | (line >> (4 - turns))) & 15;
}

export type MatchType = 'EXACT' | 'TYPE' | 'SUBTYPE' | 'PREFIX' | 'CONTAINS';

/** CDDA is_ot_match. */
export function otMatch(name: string, r: OmtRef, defs: Record<string, OterDef>, how: MatchType = 'CONTAINS'): boolean {
  const id = oterId(r, defs);
  switch (how) {
    case 'EXACT':
      return id === name;
    case 'TYPE':
      return r.type === name;
    case 'SUBTYPE':
      return mapgenIdOf(r, defs) === name;
    case 'PREFIX':
      return id === name || (id.startsWith(name) && id[name.length] === '_');
    default:
      return id.includes(name);
  }
}
