import type { FurnitureDef, TerrainDef } from '../data/types';
import { hasFlag } from '../world/registry';

// How a terrain/furniture id turns into 3D geometry. CDDA has ~1200 terrains with no
// notion of shape, so we infer shape from flags + move cost (+ id keywords as a last
// resort). Pure functions, unit tested; the mesher only switches on the result.

export type TerrainShape =
  | 'none' // t_null / open air: nothing to draw
  | 'floor' // walkable ground or floor slab
  | 'liquid' // sunken water surface with banks
  | 'wall' // full-height solid block, only exposed faces emitted
  | 'halfwall' // waist-height solid block (pony walls, SHORT walls)
  | 'window' // wall with a hole: sill + lintel + glass/curtain pane
  | 'door' // closed door: frame lintel + slab filling the opening
  | 'door_open' // open door: slab swung flat against the frame side
  | 'fence' // thin see-through panel along the connecting axis
  | 'tree' // tall crossed billboard
  | 'shrub' // short crossed billboard
  | 'stairs_up'
  | 'stairs_down';

export function terrainShape(t: TerrainDef): TerrainShape {
  if (t.id === 't_null') return 'none';
  // CDDA puts tree canopies on the level above (t_treetop*); the tree billboard already
  // draws the canopy, and a floor slab up there would roof the forest over.
  if (t.id.startsWith('t_treetop')) return 'none';
  const f = (flag: string) => hasFlag(t, flag);
  if (f('TREE')) return 'tree';
  if (f('SHRUB') || f('YOUNG')) return 'shrub';
  // BN deep water permits diving with GOES_DOWN; that is a traversal flag, not
  // staircase geometry. Keep its water surface/banks ahead of vertical connectors.
  if (f('LIQUID')) return 'liquid';
  if (f('GOES_UP')) return 'stairs_up';
  if (f('GOES_DOWN')) return 'stairs_down';
  if (f('DOOR')) return 'door';
  // Open doors are passable and lose the DOOR flag; they have a `close` transform (or, while
  // the extractor doesn't carry it yet, CDDA's `_o` id suffix).
  if ((t.close || /_o$/.test(t.id)) && /door|gate/.test(t.id) && t.move_cost > 0) return 'door_open';
  // Boarded-up windows are opaque: as a window their sparse board sprite became a see-through
  // pane of floating grey squares, so draw them as a wall of boards.
  if (f('WINDOW') && !f('TRANSPARENT') && /boarded|barricade|reinforced|shutter/.test(t.id)) return 'wall';
  if (f('WINDOW')) return 'window';
  // Roof gutters are THIN_OBSTACLE but only ankle-high; as fence panels they floated along
  // every roof edge like barbed wire.
  if (/^t_gutter/.test(t.id)) return 'floor';
  if (f('THIN_OBSTACLE') || /fence|railing|_bars/.test(t.id)) return 'fence';
  if (f('NO_FLOOR') && !f('WALL')) return 'none';
  const solid = (t.move_cost <= 0 && !f('TRANSPARENT')) || f('WALL') || f('CONNECT_WITH_WALL');
  if (solid) return f('SHORT') || /half|pony/.test(t.id) ? 'halfwall' : 'wall';
  // Remaining impassable-but-transparent terrain (railings, bars, glass walls...) reads
  // best as a see-through panel.
  if (t.move_cost <= 0) return 'fence';
  return 'floor';
}

/** Terrain shapes that fully occlude the neighbor face (so it needn't be drawn). */
export const isSolidBlock = (s: TerrainShape) => s === 'wall';

/** Shapes that should visually connect to walls (windows/doors pick their axis from this). */
export const isWallLike = (s: TerrainShape) =>
  s === 'wall' || s === 'halfwall' || s === 'window' || s === 'door' || s === 'door_open';

/** Shapes that have a walkable floor under/at them (used for picking threshold floors). */
export const hasOwnFloor = (s: TerrainShape) => s === 'floor' || s === 'stairs_up';

export type FurnitureShape = 'none' | 'billboard' | 'table' | 'counter' | 'cabinet';

export function furnitureShape(fd: FurnitureDef): FurnitureShape {
  if (fd.id === 'f_null') return 'none';
  const f = (flag: string) => hasFlag(fd, flag);
  // Box-shaped furniture reads better as geometry than as a billboard that turns with you.
  if (f('FLAT_SURF')) return /table|desk/.test(fd.id) ? 'table' : 'counter';
  if (/counter|workbench|cupboard|kitchen_unit|oven|stove|sink|washer|dryer/.test(fd.id)) return 'counter';
  if (fd.move_cost_mod < 0 && !f('TRANSPARENT') && /fridge|freezer|locker|bookcase|cabinet|shelf|wardrobe|vending|safe/.test(fd.id)) return 'cabinet';
  return 'billboard';
}

/** Light a terrain/furniture emits, in CDDA luminance units (0 = none). */
export function lightEmitted(def: TerrainDef | FurnitureDef): number {
  return def.light_emitted ?? 0;
}

/**
 * How a CDDA field type is drawn: 'decal' = flat splat on the floor (liquids, gore,
 * debris), 'cloud' = translucent dithered billboard (smoke, gases), 'fire' = animated
 * billboard + light, 'none' = not drawn (invisible fields like fd_hot_air). `color` is the
 * procedural stand-in colour.
 */
export function fieldStyle(type: string): { kind: 'decal' | 'cloud' | 'fire' | 'none'; color: number } {
  if (type === 'fd_fire' || /incendiary|flame/.test(type)) return { kind: 'fire', color: 0xff8030 };
  if (/blood|gibs|bile|acid|sludge|slime|sap|oil|mechanical_fluid|gore|puke|vomit|rubble|glass|shards|splinters|ash|web|mud|dust/.test(type)) {
    const color = /bile|acid|slime/.test(type) ? 0x6a8a20 : /blood|gibs|gore/.test(type) ? 0x6a0a0a : /oil|mechanical|sludge/.test(type) ? 0x1e1a14 : 0x7a7064;
    return { kind: 'decal', color };
  }
  if (/smoke|gas|haze|fog|mist|steam|spores|toxic|nuke|tear|cloud/.test(type)) {
    return { kind: 'cloud', color: /toxic|nuke|fungal|spores/.test(type) ? 0x7a8a50 : /tear/.test(type) ? 0xb0b0a0 : 0x7a7a7e };
  }
  // Live electricity (electrified fences, shocker zombies, lab traps) was not drawn at all; a pale
  // blue dithered cloud keeps it readable as a hazard until it gets its own arc effect.
  if (/electric/.test(type)) return { kind: 'cloud', color: 0xbcd8ff };
  return { kind: 'none', color: 0 };
}
