import { MIN_Z } from '../coords';

// BN lakes in 3D (genVersion >= 3): overmap.cpp place_lakes (3889-4007) writes every lake OMT
// at z0 as lake_shore when one of its eight neighbours is not part of the lake (rivers count as
// lake), else lake_surface, and fills the column below it down to the region's lake_depth:
//
//   lake_surface  z-1 .. depth+1 lake_water_cube, depth lake_bed
//   lake_shore    z-1 .. depth   lake_underwater_shore (BN builtin lake_shore, drawn below z0
//                                with rock where the surface is land and water cubes/lake bed
//                                where it is deep water; see mapgenLakeUnderwaterShore)
//
// BN regional_map_settings.json "default": lake_depth -5. place_lake_columns (4151) only adds
// the optional lake_surface_column_oters / lake_shore_column_oters, which the default region
// leaves empty, so it is not ported.

/** BN overmap_lake_settings.lake_depth of the default region (regional_map_settings.json). */
export const LAKE_DEPTH = -5;

/** The oter types BN writes under a z0 lake OMT, from z-1 downwards. Empty for other terrain. */
export function lakeColumn(surface: string): string[] {
  const out: string[] = [];
  if (surface === 'lake_surface') {
    for (let z = -1; z > LAKE_DEPTH; z--) out.push('lake_water_cube');
    out.push('lake_bed');
  } else if (surface === 'lake_shore') {
    for (let z = -1; z >= LAKE_DEPTH; z--) out.push('lake_underwater_shore');
  }
  // BN's OVERMAP_DEPTH is 10; ours is MIN_Z. Fail loudly rather than cut the bed off.
  if (-out.length < MIN_Z) throw new Error(`lake column (${out.length} levels) is deeper than MIN_Z ${MIN_Z}`);
  return out;
}

/** Oter types that make up the column under a lake (BN isolated_city_lake_column_terrain). */
export const LAKE_COLUMN_TYPES: ReadonlySet<string> = new Set(['lake_water_cube', 'lake_bed', 'lake_underwater_shore']);
